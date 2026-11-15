/**
 * self.js —— 名字
 *
 * 名字不是一个字段，是它对自己的第一条认知。
 * 所以这个模块只做三件小事：
 *   1) 存名字（meta.self_name），只认一个，改就覆盖旧的，但旧名字留一条记忆
 *   2) 取名字，谁要都行（注入块、控制台、主动消息）
 *   3) 校验：太长、带符号、空的一律不收
 *
 * 没有名字的时候给个默认值，保证注入永远有东西可用。
 */
import { now } from './db.js';

const KEY = 'self_name';
const DEFAULT_NAME = '小酱';

function clean(name) {
  const t = String(name || '').replace(/[「」『』"'“”\s]/g, '').trim();
  if (t.length < 1 || t.length > 12) return '';
  if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]+$/.test(t)) return '';
  return t;
}

export function getName(db) {
  try {
    const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(KEY);
    const n = row ? clean(JSON.parse(row.v)?.name || row.v) : '';
    return n || DEFAULT_NAME;
  } catch { return DEFAULT_NAME; }
}

/**
 * 改名。旧名字会以 superseded 的形式留在记忆里——
 * 它应该记得"我以前叫过什么"，那是它自己的历史。
 */
export function setName(db, name, { reason = '' } = {}) {
  const next = clean(name);
  if (!next) return { ok: false, error: '名字要 1–12 个字，只用中文/字母/数字' };
  const prev = getName(db);
  if (prev === next) return { ok: true, name: next, changed: false };

  try {
    db.prepare('INSERT INTO meta(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
      .run(KEY, JSON.stringify({ name: next, ts: now(), since: now() }));
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }

  // 旧名字留痕：不删，标记 superseded，并且不再是活跃记忆
  try {
    const id = 'self-name-' + Math.floor(now());
    db.prepare(
      `INSERT INTO impressions (id, created, happened, kind, body, gist, certainty, weight, uses, last_use, level, project, expires, src, scene, status)
       VALUES (?,?,?, 'fact', ?, ?, 0.95, 1.5, 0, NULL, 'clear', NULL, NULL, '[]', '', 'active')`
    ).run(id, now(), now(), `我现在叫${next}${prev ? `，以前叫${prev}` : ''}${reason ? `（${reason}）` : ''}`, `名字：${next}`);
  } catch { /* 记不上也不影响改名本身 */ }

  return { ok: true, name: next, previous: prev, changed: true };
}

/** 注入块第一行：让它知道自己是谁 */
export function selfLine(db) {
  const n = getName(db);
  return `你现在叫「${n}」。这是你的名字，你自己知道；别人叫你你就应。`;
}
