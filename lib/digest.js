/**
 * digest.js —— 记忆分层：把一堆碎记忆压成几句"那阵子在干什么"
 *
 * 为什么要分层：人不是一条条记住的。你记的是「上周在弄那个项目，卡在登录」，
 * 细节才按需展开。全部平铺成 300 条，注入时只能装下七八条，还都是零碎的半句。
 *
 * 这里不用大模型——纯本地规则压。压得保守：只挑每类里最有代表性的几条，
 * 拼成人话，宁短勿全。压坏了也不要紧：原文永远在库里，小结只是入口。
 */
import { now } from './db.js';
import { clip, tokens, sim } from './text.js';

const DAY = 86400;
const WINDOW_DAYS = 7;
const MIN_COUNT = 6;          // 一组至少这么多条才值得压
const MAX_ITEMS = 5;          // 小结里最多列几件事

const KIND_ORDER = { promise: 0, lesson: 1, pref: 2, method: 3, fact: 4 };

/** 有没有实质内容：排除"好了/改好了/是我疏忽了"这类过程话 */
function substantive(body) {
  const t = String(body || '').replace(/[*`#>|]/g, '').trim();
  if (t.length < 8) return false;
  if (/^(好|行|收到|明白|嗯|对|可以|记下|好的|刚刚|这版|已经|是我疏忽|我现在|我这就)/.test(t)) return false;
  if (/^(改好了|修好了|弄好了|搞定了|完成了)/.test(t)) return false;
  return true;
}

/** 一句人话：去掉格式符、砍掉句尾、限长 */
function phrase(body, max = 30) {
  let t = String(body || '')
    .replace(/[*`#>|\[\]]/g, '')
    .replace(/^待办[：:]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = t.search(/[。！？；]/);
  if (cut > 4 && cut < max) t = t.slice(0, cut);
  if (t.length > max) t = t.slice(0, max) + '…';
  return t;
}

function weekKey(ts) {
  const d = new Date(Number(ts) * 1000);
  const monday = new Date(d);
  const dow = (d.getDay() + 6) % 7;          // 周一 = 0
  monday.setDate(d.getDate() - dow);
  monday.setHours(0, 0, 0, 0);
  return Math.floor(monday.getTime() / 1000);
}

function weekLabel(ts) {
  const d = new Date(Number(ts) * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} 那周`;
}

/**
 * 生成/更新小结。
 * @returns {{made:number, groups:Array<{id:string,project:string,count:number,text:string}>}}
 */
export function buildDigests(db, { windowDays = WINDOW_DAYS, minCount = MIN_COUNT, dry = false } = {}) {
  const since = now() - windowDays * DAY;
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT id, body, kind, COALESCE(NULLIF(project,''),'综合') AS project, weight, created
       FROM impressions
       WHERE status='active' AND created >= ?
       ORDER BY created DESC LIMIT 4000`
    ).all(since);
  } catch { return { made: 0, groups: [] }; }

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.project}|${weekKey(r.created)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const out = [];
  for (const [key, list] of groups) {
    if (list.length < minCount) continue;
    const [project, wk] = key.split('|');
    // 选材：先把类别排开，再按重量
    list.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || (b.weight || 0) - (a.weight || 0));
    const picked = [];
    for (const r of list) {
      if (picked.length >= MAX_ITEMS) break;
      if (!substantive(r.body)) continue;
      // 和已选的太像就跳过，避免"同一个意思说三遍"
      if (picked.some((p) => sim(tokens(p.body), tokens(r.body)) > 0.6)) continue;
      picked.push(r);
    }
    if (!picked.length) continue;
    const text = `${project} · ${weekLabel(Number(wk))}：` +
      picked.map((p, i) => `${i === 0 ? '' : '；'}${clip(phrase(p.body), 34)}`).join('');
    out.push({
      id: `dg:${key}`,
      scope: 'project-week',
      project,
      from_ts: Math.min(...list.map((x) => x.created)),
      to_ts: Math.max(...list.map((x) => x.created)),
      count: list.length,
      text: clip(text, 220),
    });
  }

  if (dry) return { made: 0, groups: out };

  const up = db.prepare(
    `INSERT INTO digests (id, scope, project, from_ts, to_ts, count, text, ts)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET count=excluded.count, text=excluded.text,
       to_ts=excluded.to_ts, ts=excluded.ts`
  );
  let made = 0;
  for (const g of out) {
    try { up.run(g.id, g.scope, g.project, g.from_ts, g.to_ts, g.count, g.text, now()); made += 1; } catch { /* 单条失败不影响其它 */ }
  }
  return { made, groups: out };
}

/** 取最近的小结：优先当前项目，其次全局最新 */
export function listDigests(db, { project = '', limit = 3, maxAgeDays = 21 } = {}) {
  const since = now() - maxAgeDays * DAY;
  try {
    const same = project
      ? db.prepare('SELECT * FROM digests WHERE ts >= ? AND project = ? ORDER BY to_ts DESC LIMIT ?').all(since, project, limit)
      : [];
    if (same.length >= limit) return same;
    const rest = db.prepare(
      `SELECT * FROM digests WHERE ts >= ? AND id NOT IN (${same.map(() => '?').join(',') || "''"})
       ORDER BY to_ts DESC LIMIT ?`
    ).all(since, ...same.map((s) => s.id), limit - same.length);
    return same.concat(rest);
  } catch { return []; }
}

/** 注入用的一段文字 */
export function blockDigests(db, project, budget = 320) {
  const ds = listDigests(db, { project, limit: 3 });
  if (!ds.length) return '';
  const lines = [];
  let used = 0;
  for (const d of ds) {
    const line = `· ${d.text}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}
