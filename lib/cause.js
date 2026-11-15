/**
 * cause.js —— 因果：谁导致了谁
 *
 * 之前 causes 表是死的（530 条记忆只有 7 条边，还全是"这句话覆盖那句话"）。
 * 原因是没人登记：写入时的正则认不出因果，也不该由它猜。
 * 现在规矩改成和记忆一样：**由模型自己判、自己写**，插件只负责校验和存好。
 *
 * 三条硬规矩，破一条就不收：
 *   ① 因果两端必须都是存在且活跃的记忆（不允许连空气）
 *   ② 必须带证据（evidence 里至少一条事件或记忆 id），无源的因果不写
 *   ③ 果不能早于因；时间倒过来了，只能记成 suspect，certainty 压到 0.15
 * 另外禁止成环（A→B→C→A），它是树不是网。
 */
import { now } from './db.js';

/** 因果时间比较的容差（秒）：一秒以内算同时发生，不判倒挂 */
const TIME_EPS = 1;

/**
 * 同一自然日。
 * 全库拆解（2026-11-14）把所有新条目的 created/happened 刷成了同一天，
 * 真实的先后就此丢失 —— 那时按秒判倒挂，会把「国内的网 → 用镜像」这种
 * 明明成立的因果判成"果早于因"，压到 0.15 直接作废。
 * 时间粒度只剩天的时候，就别拿它当先后证据：同一天一律视为同时。
 */
const sameDay = (a, b) => {
  if (!a || !b) return false;
  const d1 = new Date(Number(a) * 1000).toDateString();
  const d2 = new Date(Number(b) * 1000).toDateString();
  return d1 === d2;
};

function idOf(db, x) {
  if (!x) return null;
  const s = String(x).trim();
  const hit = db.prepare("SELECT id FROM impressions WHERE id = ? AND status = 'active'").get(s);
  return hit ? hit.id : null;
}

/** 有环吗：从 from 顺着 cause→effect 能不能走回 to */
function reaches(db, from, to, seen = new Set()) {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const rows = db.prepare("SELECT effect FROM causes WHERE cause = ? AND status <> 'gone'").all(from);
  for (const r of rows) {
    if (r.effect === to) return true;
    if (reaches(db, r.effect, to, seen)) return true;
  }
  return false;
}

export function addCause(db, { cause, effect, kind = 'direct', why = '', evidence = [], by = 'assistant', certainty = 0.8, status = '' } = {}) {
  const c = idOf(db, cause);
  const e = idOf(db, effect);
  if (!c || !e) return { ok: false, error: '因或果那条记忆不存在（或者已经降级了）' };
  if (c === e) return { ok: false, error: '自己导致自己，不算因果' };

  // 证据必须是真实存在的记忆 id。
  // 老版本只 `.filter(Boolean).map(String)`，什么都能塞进来 ——
  // 于是 events 表的整数主键（49、50）被当成"证据"写进库，60 条 auto 边
  // 有一半 evidence 根本指不到任何印象，verifyCause 却照样判真。
  // 证据有两种合法形态：
  //   ① imp-xxx —— 另一条真实存在的记忆（人肉连线时用它）
  //   ② 纯数字 —— events 表的行号（自动抽取时用它：哪一轮对话催出了这条因果）
  // 只认 ① 会把自动路径逼死：调用方拿不到第三方印象 id，只好把两端 id 塞进去，
  // 两端又必然被剔掉，于是老代码干脆绕开 addCause 裸 INSERT —— 这就是 18 条数字 evidence 的来历。
  const rawEv = (Array.isArray(evidence) ? evidence : [evidence]).map(String).filter(Boolean);
  const inImp = db.prepare('SELECT 1 FROM impressions WHERE id = ?');
  const inEvt = db.prepare('SELECT 1 FROM events WHERE rowid = ?');
  const ev = [];
  for (const x of rawEv) {
    if (x === c || x === e) continue;          // 两端自己不能给自己作证
    const real = /^\d+$/.test(x) ? !!inEvt.get(Number(x)) : !!inImp.get(x);
    if (!real) continue;
    if (!ev.includes(x)) ev.push(x);
  }
  if (!ev.length) return { ok: false, error: '缺证据：evidence 里没有一条能指向真实存在的记忆或事件' };
  if (reaches(db, e, c)) return { ok: false, error: '这会成环，环不是因果' };

  const dup = db.prepare(
    "SELECT id, evidence, why, certainty, status FROM causes WHERE cause = ? AND effect = ? AND status <> 'gone'"
  ).get(c, e);
  if (dup) {
    // 老版本只加强度，把新证据和新理由直接丢掉了 ——
    // 同一条边被反复发现十次，库里还是只有第一次那条理由。
    let oldEv = [];
    try { oldEv = JSON.parse(dup.evidence || '[]'); } catch { oldEv = []; }
    if (!Array.isArray(oldEv)) oldEv = [];
    for (const x of ev) if (!oldEv.includes(x)) oldEv.push(x);
    let oldWhy = {};
    try { oldWhy = JSON.parse(dup.why || '{}'); } catch { oldWhy = {}; }
    if (!oldWhy || typeof oldWhy !== 'object') oldWhy = {};
    // why 允许直接传对象：调用方手里本来就有一把结构化信息（来源、相关度、句式），
    // 逼它先 JSON.stringify 再被塞进 note 字段，等于让每一个调用方各自发明一种转义。
    const whyObj = why && typeof why === 'object' ? why : { note: String(why || '') };
    const merged = {
      ...oldWhy,
      ...whyObj,
      t: 'cause', kind, by,
      note: String(whyObj.note || oldWhy.note || '').slice(0, 300),
      merged_at: now(),
    };
    db.prepare(
      `UPDATE causes SET last_seen = ?, certainty = MAX(certainty, ?),
         evidence = ?, why = ?, status = CASE WHEN status = 'suspect' AND ? = 'active' THEN 'active' ELSE status END
       WHERE id = ?`
    ).run(now(), certainty, JSON.stringify(oldEv), JSON.stringify(merged),
      'active', dup.id);
    return { ok: true, id: dup.id, action: '已存在，合并了证据并强化' };
  }

  const rc = db.prepare('SELECT created, happened, body FROM impressions WHERE id = ?').get(c);
  const re = db.prepare('SELECT created, happened, body FROM impressions WHERE id = ?').get(e);
  const tc = Number(rc.happened || rc.created || 0);
  const te = Number(re.happened || re.created || 0);
  // 时间差不设门槛会把「同一时刻」误判成「果早于因」：
  // happened 不只是事件真实时间，ingestTurn 里还会往里写排序用的 ±0.002 秒偏移，
  // 而同一轮写进来的两条记忆 created 也可能只差几毫秒。
  // 一秒以内一律当作同时发生——同时发生谈不上谁导致谁，但更谈不上倒挂。
  const backwards = tc - te > TIME_EPS && !sameDay(tc, te);
  // 倒挂不能被 MIN_CERT 抬回来，但也别一棍子打死：
  // 2026-11-14 全库拆解时，所有新条目的 created/happened 都被刷成了同一天，
  // 真实的先后关系就此丢失。此时判出来的"倒挂"多半是假象，压到 0.15 等于直接作废。
  // 所以压到 0.4（仍在 recall 一跳门槛之下，不参与扩散），状态留 suspect 等人工看。
  const cert = backwards ? Math.min(0.4, certainty) : Math.min(1, certainty);
  // 调用方可以请求 suspect（自动抽取的边一律这么写），但不能靠传 'active' 绕过倒挂判定：
  // 时间倒过来就是倒过来，谁说的都改不了。
  const finalStatus = backwards || status === 'suspect' ? 'suspect' : 'active';

  const id = 'cs-' + Math.random().toString(36).slice(2, 11);
  db.prepare(
    `INSERT INTO causes (id, cause, effect, kind, certainty, evidence, verified, last_seen, status, why)
     VALUES (?,?,?,?,?,?,0,?,?,?)`
  ).run(id, c, e, kind, cert, JSON.stringify(ev), now(), finalStatus,
    // why 存人话，不再存 JSON。
    // 原来存的是 {"note":"…","t":"cause","kind":"direct","backwards":true,"ts":…}，
    // 念给用户听的时候是一串花括号，等于白存；而且 t/kind/ts 本来就有对应的列。
    // 只把真正读不出来的信息（谁建的、时间是否可信）压成短后缀。
    `${String(why && typeof why === 'object' ? (why.note || '') : (why || '')).trim()}${by ? `｜${by}` : ''}`);

  return {
    ok: true, id, action: '新增', status: finalStatus, certainty: cert,
    note: backwards ? '因果时间倒过来了，先记成 suspect' : '',
    cause: String(rc.body).slice(0, 40), effect: String(re.body).slice(0, 40),
  };
}

/** 往前推：谁导致了我 */
export function predecessors(db, id) {
  return db.prepare(
    `SELECT c.id, c.kind, c.certainty, c.verified, c.status, c.why, i.id AS other, i.body
     FROM causes c JOIN impressions i ON i.id = c.cause
     WHERE c.effect = ? AND c.status IN ('active','suspect')
     ORDER BY c.certainty DESC LIMIT 20`
  ).all(id);
}

/** 往后推：我导致了什么 */
export function successors(db, id) {
  return db.prepare(
    `SELECT c.id, c.kind, c.certainty, c.verified, c.status, c.why, i.id AS other, i.body
     FROM causes c JOIN impressions i ON i.id = c.effect
     WHERE c.cause = ? AND c.status IN ('active','suspect')
     ORDER BY c.certainty DESC LIMIT 20`
  ).all(id);
}

/**
 * 一条链：从某条记忆往上追（因为什么）或往下推（导致了什么），最多 depth 层。
 * 每一层按 certainty 衰减，越远越不确定——这是因果，不是等价。
 */
export function chain(db, id, { depth = 3, dir = 'up' } = {}) {
  const seen = new Set([id]);
  const out = [];
  let frontier = [id];
  // 衰减按**层数**算，同一层的所有节点用同一个系数。
  // 原来写成「循环外一个 decay 变量，每碰到一个节点就 *= 0.7」，
  // 结果是同层第 3 个节点已经衰减到 0.343、第 6 个到 0.118——
  // 排在前面的兄弟永远比排在后面的「可信」，纯粹是遍历顺序的副产物。
  const decayAt = (d) => Math.pow(0.7, d);
  for (let d = 1; d <= depth; d += 1) {
    const next = [];
    const decay = decayAt(d);
    for (const cur of frontier) {
      const rows = dir === 'up' ? predecessors(db, cur) : successors(db, cur);
      for (const r of rows) {
        if (seen.has(r.other)) continue;
        seen.add(r.other);
        out.push({
          depth: d, dir, kind: r.kind, certainty: Number((r.certainty * decay).toFixed(3)),
          verified: r.verified, status: r.status, id: r.other, text: String(r.body).slice(0, 120),
        });
        next.push(r.other);
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  return out;
}

/** 人工确认这条因果成立 */
export function verifyCause(db, id) {
  const r = db.prepare('SELECT id, status FROM causes WHERE id = ?').get(String(id));
  if (!r) return { ok: false, error: '没有这条因果' };
  db.prepare("UPDATE causes SET verified = 1, status = 'active', last_seen = ? WHERE id = ?").run(now(), r.id);
  return { ok: true, note: '已标为验证过' };
}
