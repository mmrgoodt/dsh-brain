/**
 * extract-model.js —— 让模型来决定「这一轮该记成什么」
 *
 * 为什么要有这个文件：
 *   原来写入靠正则猜——把整轮对话丢进去，按关键词判断"这句算不算偏好"。
 *   结果是一轮几百字塞成一条记忆，问什么都命中它；因果关系靠"因为/所以"抽，
 *   抽出来一大半是"沾词就连"。
 *
 * 现在改成：把这一轮交给模型，让它回答三个问题——
 *   ① 这一轮里有几件事？（不是几段话，是几件独立的事）
 *   ② 每件事是什么类型？（他要我怎么做 / 事实 / 教训 / 做法 / 他答应的事）
 *   ③ 有没有真的因果？（因为 A，所以 B）
 *
 * 成本：每轮一次小模型调用（maxTokens 400），失败一律退回原来的正则路线，
 * 所以模型不可用时系统照常工作，只是回到老样子。
 */

const SYSTEM = `你是中文记忆抽取器。把这一轮对话里值得长期记住的事，拆成「一件事一条」。

判断标准只有一句：**明天再遇到类似情况，这条还用得上吗？**

三个例子，照着这个尺度判断：

他说「帮我看看这个日志」       → 不记（派给我的活，做完就没了）
他说「以后别在开头列一堆小标题」 → {"kind":"pref","text":"他要求回答不要列小标题"}
他说「Node 装在 C 盘 Program Files，PATH 里没有」 → {"kind":"fact","text":"Node 装在 C:\\\\Program Files\\\\nodejs，不在 PATH 里"}
他说「好了吧现在可以了吗」     → 不记（问句，不是事实）

记这些：
- 他定的规矩（"以后别那么正式"、"重启前先问我"）
- 客观事实（环境、路径、配置、账号、结论性数字）
- 踩过的坑
- 可复用的做法（步骤、命令、流程）
- 他明确答应要办的事

不记这些：
- 我干活的过程（"我先查了X再改了Y"）
- 他派给我的具体活
- 他的提问、寒暄、确认、情绪话
- 工具输出、报错原文、没定论的猜测

每条要求：一句话、不超过 45 字、**第三人称**（"他要求…"、"本机…"，不要用"我"）。
一条只讲一件事，不要把两件事塞进一句。

另判因果：只有「因为 A 所以 B」、A 和 B 都是上面抽出的事、且 B 是一条规矩或教训，才写。

只输出 JSON，不要解释：
{"items":[{"kind":"pref|fact|lesson|method|promise","text":"..."}],"causes":[{"cause":"...","effect":"...","why":"不超过20字"}]}
没有可记的就输出 {"items":[],"causes":[]}`;

function parseJson(s) {
  const t = String(s || '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

/**
 * 解析一次调用配置。
 * 踩了两轮的坑：stream() 不带 provider+model 会得到 0 个字（不报错，就是空流），
 * 而 resolveCallConfig({}) 直接抛 "no adapter registered for provider undefined"。
 * 默认值取自 profile 的 cordis.patch.yml（agent-default-model 那段），可用环境变量覆盖。
 */
const PROVIDER = process.env.BRAIN_LLM_PROVIDER || 'deepseek-account';
const MODEL = process.env.BRAIN_LLM_MODEL || 'deepseek-flash';

/** 调模型抽一轮，返回 {items, causes} 或 null（失败） */
export async function extractByModel(llm, { user = '', assistant = '', logger } = {}) {
  if (!llm || typeof llm.stream !== 'function') return null;
  const u = String(user || '').trim();
  const a = String(assistant || '').trim();
  if (u.length + a.length < 24) return null;      // 太短的一轮不值得花一次调用

  let route = {};
  try {
    if (typeof llm.resolveCallConfig === 'function') {
      route = (await llm.resolveCallConfig({ provider: PROVIDER, model: MODEL })) || {};
    }
  } catch (e) {
    logger?.warn?.(`[brain] 解析调用配置失败（${PROVIDER}/${MODEL}）：${e && e.message}`);
    return null;
  }

  const chunks = [];
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch {} }, 20000);
  try {
    const stream = llm.stream({
      ...route,                       // 解析出来的整份配置都要带上，缺一个字段就是空流
      provider: route.provider || PROVIDER,
      model: route.model || MODEL,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: `他说：${u.slice(0, 1500)}\n\n我答：${a.slice(0, 2500)}`,
        }],
      }],
      maxTokens: 1600,
      reasoningEffort: 'low',
      signal: ac.signal,
    });
    let seen = 0;
    for await (const c of stream) {
      const type = c && c.type ? String(c.type) : '';
      // 只收正式输出。stream 里同时有 reasoning-delta（它的思考过程）和 text-delta（正式回答），
      // 混在一起收会得到「Let me extract memories. Items: ...」这种草稿，
      // 实测那 1517 字全是思考通道的内容，JSON 一个字都没有。
      if (type === 'text-delta' || type === 'text') {
        const t = c.text ?? (c.delta && c.delta.text) ?? '';
        if (typeof t === 'string') chunks.push(t);
      }
      if (seen < 3) {
        seen += 1;
        let shape = '';
        try { shape = JSON.stringify(c).slice(0, 220); } catch { shape = String(c); }
        logger?.warn?.(`[brain] 模型流 chunk#${seen}：${shape}`);
      }
    }
  } catch (e) {
    logger?.warn?.(`[brain] 模型抽取失败，退回正则：${e && e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }

  const raw = chunks.join('');
  const obj = parseJson(raw);
  if (!obj || !Array.isArray(obj.items)) {
    // 把原始输出打出来：不看到它，就只能猜是格式问题还是被截断
    logger?.warn?.(`[brain] 模型抽取返回的不是可用 JSON（原始 ${raw.length} 字）：${raw.replace(/\s+/g, ' ').slice(0, 300)}`);
    return null;
  }
  const KINDS = new Set(['pref', 'fact', 'lesson', 'method', 'promise']);
  const items = obj.items
    .filter((x) => x && typeof x.text === 'string' && x.text.trim().length >= 6 && x.text.length <= 160)
    .map((x) => ({ kind: KINDS.has(x.kind) ? x.kind : 'fact', text: x.text.trim() }))
    .slice(0, 8);
  const causes = (Array.isArray(obj.causes) ? obj.causes : [])
    .filter((x) => x && x.cause && x.effect && String(x.cause).length >= 4 && String(x.effect).length >= 4)
    .slice(0, 3)
    .map((x) => ({ cause: String(x.cause).trim(), effect: String(x.effect).trim(), why: String(x.why || '').trim() }));
  return { items, causes };
}

export const __debug = { parseJson, SYSTEM };
