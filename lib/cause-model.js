/**
 * cause-model.js —— 让模型从「有关系的两条记忆」里挖真因果
 *
 * 为什么需要：自动抽取只在对话里出现「因为/所以」时才连边，可真实对话很少这么说。
 * 结果库里有 1032 条记忆、2105 条关系，因果却只有 7 条 —— 图是张网，几乎没有方向。
 *
 * 做法：取一对已经连着的记忆（大概率同话题），问模型「这两条里，是不是一条导致了另一条」。
 * 判断过的对写进 bonds.why 的尾巴（"已判因果/已判无因果"），下次跳过，不会重复烧钱。
 */

const PROVIDER = process.env.BRAIN_LLM_PROVIDER || 'deepseek-account';
const MODEL = process.env.BRAIN_LLM_MODEL || 'deepseek-flash';

const SYSTEM = `下面几组中文记忆，判断每组两条之间是否存在因果关系。

只认真因果：A 真的发生了，才导致 B 发生、才这么定规矩、才有这个结果。

**不算因果的情况（特别注意）：**
- 两条在同一轮对话里一前一后说的（比如 A 是他提要求，B 是他抱怨我没做到）
- 话题相同、或同一件事的两种说法
- 只是都提到同一个词

**自检**：假如 A 从来没发生过，B 还会是现在这样吗？会 → 不是因果。

输出 JSON，不要解释：
{"pairs":[{"n":1,"yes":true,"from":"A","why":"不超过18字"}]}

from 填 "A" 表示第一条导致第二条，填 "B" 表示第二条导致第一条。没有因果的写 {"n":1,"yes":false}。`;

function parseJson(s) {
  const t = String(s || '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

async function askModel(llm, pairs, logger) {
  let route = {};
  if (typeof llm.resolveCallConfig === 'function') {
    route = (await llm.resolveCallConfig({ provider: PROVIDER, model: MODEL })) || {};
  }
  const text = pairs.map((p, i) => `${i + 1}. A：${p.aBody}\n   B：${p.bBody}`).join('\n\n');
  const chunks = [];
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch {} }, 40000);
  try {
    const stream = llm.stream({
      ...route,
      provider: route.provider || PROVIDER,
      model: route.model || MODEL,
      system: SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      maxTokens: 2000,
      reasoningEffort: 'low',
      signal: ac.signal,
    });
    for await (const c of stream) {
      const t = c && c.type ? String(c.type) : '';
      if (t === 'text-delta' || t === 'text') {
        const v = c.text ?? (c.delta && c.delta.text) ?? '';
        if (typeof v === 'string') chunks.push(v);
      }
    }
  } finally { clearTimeout(timer); }
  const raw = chunks.join('');
  const obj = parseJson(raw);
  if (!obj) logger?.warn?.(`[brain] 因果判断返回非 JSON（${raw.length} 字）：${raw.slice(0, 200)}`);
  return obj;
}

/** 跑一批：判断 N 对，返回统计 */
export async function judgeBatch(db, llm, { addCause, logger, batch = 2 } = {}) {
  if (!llm || typeof llm.stream !== 'function') return { done: true, ok: false, reason: 'no-llm' };

  // 只挑「至少一端是规矩类」的对：规矩最有可能是被某件事逼出来的
  const rows = db.prepare(`SELECT b.rowid AS rid, b.a, b.b, b.why,
      ia.body AS aBody, ia.kind AS aKind, ib.body AS bBody, ib.kind AS bKind
    FROM bonds b
    JOIN impressions ia ON ia.id = b.a
    JOIN impressions ib ON ib.id = b.b
    WHERE ia.status='active' AND ib.status='active'
      AND (ia.kind IN ('pref','lesson') OR ib.kind IN ('pref','lesson'))
      AND (b.why IS NULL OR b.why NOT LIKE '%已判%')
    LIMIT ?`).all(batch);
  if (!rows.length) return { done: true, ok: true, judged: 0, caused: 0 };

  const pairs = rows.map((r) => ({ ...r, aBody: String(r.aBody).slice(0, 90), bBody: String(r.bBody).slice(0, 90) }));
  let obj = null;
  try {
    obj = await Promise.race([
      askModel(llm, pairs, logger),
      new Promise((_, rej) => setTimeout(() => rej(new Error('60 秒没回音')), 60000)),
    ]);
  } catch (e) {
    return { done: false, ok: false, reason: e.message, judged: 0, caused: 0 };
  }
  if (!obj || !Array.isArray(obj.pairs)) {
    // 解析失败就跳过这批，不要卡在同一个地方
    const mark = db.prepare("UPDATE bonds SET why = COALESCE(why,'') || '｜判断失败' WHERE rowid=?");
    for (const r of rows) { try { mark.run(r.rid); } catch {} }
    return { done: false, ok: false, reason: 'bad-json', judged: rows.length, caused: 0 };
  }

  const mark = db.prepare("UPDATE bonds SET why = COALESCE(why,'') || ? WHERE rowid=?");
  /* 证据从哪来：
   * impressions.src 本来该存来源事件 id，实测里头存的是关键词数组（["主动开口","门槛"]），
   * 而且只有 18/1032 条有值 —— 拿它作证据就是假证据。
   * 所以每次判断直接写一条事件（"模型判断 A 导致 B"），用它的 rowid 当证据：
   * 真实存在、可追溯，也正好是这条因果真正的出处。
   */
  const insEvt = db.prepare('INSERT INTO events (ts, role, body, session, turn) VALUES (?,?,?,?,?)');
  let caused = 0, judged = 0;
  for (const p of obj.pairs) {
    const idx = Number(p && p.n) - 1;
    const row = pairs[idx];
    if (!row) continue;
    judged += 1;
    if (!p.yes) { try { mark.run('｜已判无因果', row.rid); } catch {} continue; }
    const causeId = String(p.from).toUpperCase() === 'B' ? row.b : row.a;
    const effectId = String(p.from).toUpperCase() === 'B' ? row.a : row.b;

    /* 只认「果是规矩/教训」的边。
     * 实测 8 条「果是 fact」的判断里 4 条是伪的（"自建任务"→"conhost计数为6"，
     * 只是同话题）；而「果是 pref」的 17 条抽检几乎全对。
     * 因果真正有用的形态是「因为出了这件事，所以定下这条规矩」。
     */
    let eKind = '';
    try {
      const r = db.prepare('SELECT kind FROM impressions WHERE id=?').get(effectId);
      eKind = String((r && r.kind) || '');
    } catch {}
    if (!['pref', 'lesson'].includes(eKind)) {
      try { mark.run('｜果不是规矩，不算', row.rid); } catch {}
      continue;
    }

    let evId = null;
    try {
      const info = insEvt.run(
        Math.floor(Date.now() / 1000), 'assistant',
        `因果判断：${String(row.aBody).slice(0, 40)} → ${String(row.bBody).slice(0, 40)}`,
        'cause-model', 0
      );
      evId = Number(info.lastInsertRowid);
    } catch { /* 写不进事件就不连这条 */ }
    if (!evId) { try { mark.run('｜无证据，未连', row.rid); } catch {} continue; }
    try {
      const r = addCause(db, {
        cause: causeId, effect: effectId,
        why: String(p.why || '').slice(0, 40),
        evidence: [String(evId)],
        certainty: 0.65, by: 'model-pair',
      });
      if (r && r.ok) caused += 1;
    } catch { /* 有环检测会拦，不追 */ }
    try { mark.run('｜已判因果', row.rid); } catch {}
  }

  logger?.info?.(`[brain] 因果判断：看 ${rows.length} 对，成立 ${caused} 条`);
  return { done: false, ok: true, judged, caused };
}
