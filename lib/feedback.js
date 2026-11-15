/**
 * feedback.js —— 闭环：它说的话，你到底认不认
 *
 * 主动开口最容易变成"自说自话"：它说一句，你回一句，然后没人记住这次到底有没有用。
 * 这一层的活很小但关键——把每次开口记下来，再从你下一条回复里判一个"认了/否了"，
 * 然后把各类信号的权重按结果微调。判断错也没关系：权重每次只动 0.05，会被后面的样本纠正。
 */
import { now } from './db.js';

const GOOD = /(对|是的|没错|确实|正合我意|说到点|有道理|哈哈|嗯嗯|好的|记下了|谢谢|贴心)/;
const BAD = /(不对|不是|别|搞错|瞎猜|胡说|不用|没必要|烦|打扰|什么乱七八糟|说错|弄错|少来)/;
const KEY = 'think_weights';
const CLAMP = [0.55, 1.35];

/** 记一次开口 */
export function recordSent(db, item) {
  try {
    db.prepare('INSERT OR REPLACE INTO feedback (id, kind, text, refs, ts, verdict) VALUES (?,?,?,?,?,?)')
      .run(String(item.id), String(item.kind || ''), String(item.text || '').slice(0, 400),
        JSON.stringify(item.refs || []), now(), 'pending');
  } catch { /* 记不上不影响发送 */ }
}

export function loadWeights(db) {
  try {
    const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(KEY);
    const o = row ? JSON.parse(row.v) : {};
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

function saveWeights(db, w) {
  try {
    db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
      .run(KEY, JSON.stringify(w));
  } catch { /* 存不上就下次再说 */ }
}

/** 某一类信号现在的权重倍数 */
export function weightOf(db, kind) {
  const w = loadWeights(db);
  const v = Number(w[kind]);
  return Number.isFinite(v) ? v : 1;
}

/**
 * 用你新说的一句话去裁决最近一次开口。
 * 只判"最近 24 小时内、还没判过"的那条——隔太久就说不清了。
 */
export function judgeLast(db, userText) {
  const t = String(userText || '').trim();
  if (t.length < 2) return null;
  let row = null;
  try {
    row = db.prepare(
      "SELECT * FROM feedback WHERE verdict='pending' AND ts > ? ORDER BY ts DESC LIMIT 1"
    ).get(now() - 86400);
  } catch { return null; }
  if (!row) return null;

  // 先看否定：「不对」里也含「对」，先判肯定就会把否认认成夸奖。
  // 一句话里既有肯定又有否定时，按否定算——宁可少赏，不可错赏。
  const bad = BAD.test(t);
  const good = !bad && GOOD.test(t);
  if (good === bad) {
    db.prepare("UPDATE feedback SET judge_ts=? WHERE id=?").run(now(), row.id);
    return null;
  }

  const verdict = bad ? 'bad' : 'good';
  db.prepare('UPDATE feedback SET verdict=?, judge_ts=? WHERE id=?').run(verdict, now(), row.id);

  const w = loadWeights(db);
  const k = row.kind || 'unknown';
  const cur = Number.isFinite(Number(w[k])) ? Number(w[k]) : 1;
  const delta = verdict === 'bad' ? -0.12 : 0.06;   // 否了罚得重，认了只轻赏
  const next = Math.min(CLAMP[1], Math.max(CLAMP[0], cur + delta));
  w[k] = Number(next.toFixed(3));
  saveWeights(db, w);
  return { id: row.id, kind: k, verdict, weight: w[k], why: t.slice(0, 30) };
}

/** 概览：各类信号的历史成绩 */
export function feedbackStats(db) {
  const out = { counts: {}, weights: loadWeights(db) };
  try {
    for (const r of db.prepare('SELECT kind, verdict, COUNT(*) c FROM feedback GROUP BY kind, verdict').all()) {
      const k = r.kind || 'unknown';
      if (!out.counts[k]) out.counts[k] = { good: 0, bad: 0, pending: 0 };
      out.counts[k][r.verdict] = r.c;
    }
  } catch { /* 空表也正常 */ }
  return out;
}
