/**
 * tidy-model.js —— 用模型把旧记忆「捋顺」
 *
 * 旧库里的记忆是正则抽的：一条能塞进一整个回合（平均 200 字），
 * 或者几条在说同一件事。模型现在能按「一件事一条」写，那存量也该照这个标准重整。
 *
 * 做法（分批、可中断）：
 *   1. 取一批还没整合过的长记忆（>80 字），带编号喂给模型
 *   2. 模型输出：拆分/合并后的条目，每条标着来源编号 src
 *   3. 原条目标 superseded（原文保留，可回滚），新条目走正常写入（自带去重）
 *   4. 进度存 meta，下次接着往下跑
 *
 * 任何时候出问题都不影响原库：原条目只是改状态，不删。
 */

const PROVIDER = process.env.BRAIN_LLM_PROVIDER || 'deepseek-account';
const MODEL = process.env.BRAIN_LLM_MODEL || 'deepseek-flash';
const KEY = 'tidy_progress';

const SYSTEM = `你是记忆库整理器。收到若干条旧记忆（带编号），把它们重写成一件事一条。

规则：
1. 拆分：一条里讲了多件事，就拆成多条
2. 合并：几条其实在说同一件事，合并成一条
3. 精简：去掉"我查了/我改了/然后"这类过程词，只留结论
4. 每条不超过 45 字，第三人称陈述
5. 类型只能是 pref（他要我怎么做）/ fact（事实）/ lesson（教训）/ method（做法）/ promise（他答应的事）
6. 保留原意，不要编造原文没有的信息
7. 一条旧记忆原样保留也可以（不拆不并就照抄）
8. **每条拆出来必须能独立看懂**：主语、对象要写全。原文说「已换成流动式」，
   拆出来要写成「3D 神经元的粒子效果已换成流动式」——不能留下「调了两轮才看」这种
   没头没尾的碎片。补不出主语的，就并回上一条一起。
9. 长度少于 15 字又没主语的，不要输出

输出 JSON，src 填这条内容来自哪个编号（拆出来的多条填同一个编号）：
{"items":[{"src":"A1","kind":"fact","text":"..."}]}`;

function parseJson(s) {
  const t = String(s || '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

async function callModel(llm, batch, logger) {
  let route = {};
  if (typeof llm.resolveCallConfig === 'function') {
    route = (await llm.resolveCallConfig({ provider: PROVIDER, model: MODEL })) || {};
    // 看清解析出来的到底是什么字段：reasoningEffort 传 'low' 没生效，
    // 说明字段名或取值不对，得照它真实的来。
    let s = '';
    try { s = JSON.stringify(route); } catch { s = String(route); }
    logger?.warn?.(`[brain] 捋顺调用配置：${String(s).slice(0, 400)}`);
  }
  const listing = batch.map((r) => `${r.tag}｜${String(r.body).replace(/\s+/g, ' ').slice(0, 120)}`).join('\n');
  const chunks = [];
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch {} }, 40000);
  try {
    const stream = llm.stream({
      ...route,
      provider: route.provider || PROVIDER,
      model: route.model || MODEL,
      system: SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: listing }] }],
      maxTokens: 3000,
      reasoningEffort: 'low',   // profile 默认是 max，思考会把配额吃光、正文一个字都出不来
      signal: ac.signal,
    });
    let n = 0;
    const types = [];
    for await (const c of stream) {
      n += 1;
      const type = c && c.type ? String(c.type) : '(无type)';
      if (types.length < 8) types.push(type);
      if (type === 'text-delta' || type === 'text') {
        const t = c.text ?? (c.delta && c.delta.text) ?? '';
        if (typeof t === 'string') chunks.push(t);
      }
    }
    logger?.warn?.(`[brain] 捋顺流：${n} 块，类型 ${types.join('/') || '（空流）'}`);
  } finally { clearTimeout(timer); }

  const raw = chunks.join('');
  const obj = parseJson(raw);
  if (!obj) {
    // 解析不出来必须看到原样：是截断、是格式跑偏、还是压根没吐 JSON
    logger?.warn?.(`[brain] 捋顺 JSON 解析失败（${raw.length} 字）：${raw.replace(/\s+/g, ' ').slice(0, 320)}`);
  }
  return obj;
}

/**
 * 跑一次：**一次只处理一条**。
 *
 * 为什么不用批量：批量喂 6–10 条时，模型的 reasoning 会把输出配额吃光
 * （实测 3000 token 全变 reasoning-delta，正文一个字都不出）。
 * 单条输入的规模跟单轮抽取一致，那条路已经验证能拿到 text-delta。
 * 慢一点没关系，由调用方定时重复调，进度存 meta，随时能停。
 */
export async function tidyBatch(db, llm, { writeImpression, logger } = {}) {
  if (!llm || typeof llm.stream !== 'function') return { done: true, ok: false, reason: 'no-llm' };

  /* 不要 OFFSET。
   * 踩过的坑：处理完一条，它就从 active 集合里消失、集合整体前移一位；
   * 同时又让 offset 加一，等于「每处理一条就跳过一条」——跑了一夜，
   * 处理 154 条却还剩下 153 条，一半被悄悄跳过。
   * 现在直接取当前最长的未处理条；处理失败的打上标记排除掉，避免原地死循环。
   */
  const row = db.prepare(`SELECT id, kind, body, created FROM impressions
    WHERE status='active' AND length(body) > 80
      AND (gist IS NULL OR gist NOT LIKE '%捋顺跳过%')
    ORDER BY length(body) DESC LIMIT 1`).get();
  if (!row) return { done: true, ok: true, inCount: 0, outCount: 0 };

  const markSkip = () => {
    try { db.prepare("UPDATE impressions SET gist=? WHERE id=?").run('捋顺跳过（模型没给可用结果）', row.id); } catch {}
  };

  let obj = null;
  try {
    // 外面再套一层超时：实测 AbortController 的 signal 对这个 adapter 不起作用，
    // 流挂住时会一直等下去（日志停在「调用配置」就没下文了，整条流水线卡死）。
    obj = await Promise.race([
      callModel(llm, [{ ...row, tag: 'M1' }], logger),
      new Promise((_, rej) => setTimeout(() => rej(new Error('模型 60 秒没回音')), 60000)),
    ]);
  } catch (e) {
    markSkip();
    return { done: false, ok: false, reason: e && e.message, inCount: 1, outCount: 0 };
  }
  if (!obj || !Array.isArray(obj.items) || !obj.items.length) {
    markSkip();
    return { done: false, ok: false, reason: 'bad-json', inCount: 1, outCount: 0 };
  }

  const KINDS = new Set(['pref', 'fact', 'lesson', 'method', 'promise']);
  let outN = 0;
  for (const it of obj.items) {
    if (!it || typeof it.text !== 'string') continue;
    const text = it.text.trim();
    if (text.length < 6 || text.length > 200) continue;
    try {
      writeImpression(db, { body: text, kind: KINDS.has(it.kind) ? it.kind : 'fact', role: 'user' });
      outN += 1;
    } catch { /* 单条失败继续 */ }
  }

  try {
    db.prepare("UPDATE impressions SET status='superseded', weight=0.6, gist=? WHERE id=?")
      .run(`已由模型拆成一件事一条（${new Date().toISOString().slice(0, 10)}）`, row.id);
  } catch {}

  logger?.info?.(`[brain] 捋顺一条：${outN} 件事 ← ${String(row.body).slice(0, 30)}`);
  return { done: false, ok: true, inCount: 1, outCount: outN };
}
