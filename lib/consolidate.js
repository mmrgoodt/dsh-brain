/**
 * consolidate.js —— 压缩：把一堆碎片压成一句「那阵子在干什么」
 *
 * 为什么要有这一层：库里 500 多条记忆，平均 200 字，全是零碎半句。
 * 人不是这么记事的。人记的是「上个月在弄记忆插件，卡在召回」，
 * 细节等被问到再展开。digest.js 已经能做「项目 × 一周」的小结，
 * 但它只覆盖最近 7 天、还要凑够 6 条，所以库里长期只有 5 条小结。
 *
 * 这里补另一种：不按周，按**像不像**。同一件事被记了十几遍的，
 * 合成一条；原文全部保留（status 不动），小结只是入口。
 * 压坏了也不要紧——原文还在，随时能翻。
 */
import { now } from './db.js';
import { tokens, sim, clip } from './text.js';

const DAY = 86400;
const WINDOW_DAYS = 120;      // 回溯多久的碎片参与压缩
const MIN_CLUSTER = 3;        // 一个簇至少几条才值得压
const MAX_CLUSTERS = 60;      // 一次最多产出多少条
const SIM = 0.52;             // 算「同一件事」的相似度门槛
const KIND_ORDER = { promise: 0, pref: 1, lesson: 2, method: 3, fact: 4 };

/** 一句人话：去掉格式符，砍到第一个句末 */
function phrase(body, max = 46) {
  let t = String(body || '')
    .replace(/[*`#>|[\]()]/g, '')
    .replace(/^待办[：:]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = t.search(/[。！？；\n]/);
  if (cut > 6) t = t.slice(0, cut);
  if (t.length > max) t = t.slice(0, max - 1) + '…';
  return t;
}

/** 过程话、应声话不算内容 */
function substantive(body) {
  const t = String(body || '').replace(/[*`#>|]/g, '').trim();
  if (t.length < 10) return false;
  if (/^(好|行|收到|明白|嗯|对|可以|记下|好的|刚刚|这版|已经)/.test(t)) return false;
  if (/^(改好了|修好了|弄好了|搞定了|完成了|搞定)/.test(t)) return false;
  return true;
}

function stampOf(ts) {
  const d = new Date(Number(ts) * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 按「共同的稀有词」聚簇。
 *
 * 试过按整句相似度（Dice）聚：库里 544 条两两相似度中位数是 0.0，
 * 最高才 0.61 —— 中文长句的二元组几乎不重合，这条路走不通。
 * 换成「谁和谁提到了同一个稀罕词」：像「召回」「回执」「岚图」这种
 * 只在三五条里出现的词，才是真的在说同一件事。
 */
function cluster(rows) {
  const list = rows
    .filter((r) => substantive(r.body))
    .map((r) => ({ ...r, t: tokens(r.body) }))
    .filter((r) => r.t && r.t.size >= 2);

  const N = list.length || 1;
  const df = new Map();
  for (const r of list) for (const t of r.t) df.set(t, (df.get(t) || 0) + 1);

  const STOP = new Set(['这个', '那个', '现在', '然后', '就是', '可以', '我们', '他们', '一个',
    '没有', '这么', '什么', '时候', '还是', '已经', '因为', '所以', '但是', '如果', '自己',
    '东西', '问题', '地方', '一样', '应该', '需要', '不是', '知道', '觉得', '看到']);

  // 候选主题词：出现 ≥3 次、且不超过全库 8%，本身够长、不是口水词
  const topics = [];
  for (const [t, c] of df) {
    if (c < MIN_CLUSTER) continue;
    if (c > Math.max(6, N * 0.08)) continue;
    if (t.length < 2) continue;
    if (STOP.has(t)) continue;
    if (!/[\u4e00-\u9fa5a-z]/i.test(t)) continue;
    if (t.length > 18) continue;                 // 太长的多半是整句或路径
    if (/[\\/]$/.test(t)) continue;
    topics.push([t, c]);
  }
  // 稀有优先（df 小的更能定义一件事），同频按长度
  topics.sort((a, b) => a[1] - b[1] || b[0].length - a[0].length);

  const used = new Set();
  const clusters = [];
  for (const [t, c] of topics) {
    if (clusters.length >= MAX_CLUSTERS) break;
    const members = list.filter((r) => r.t.has(t) && !used.has(r.id));
    if (members.length < MIN_CLUSTER) continue;
    const pick = members.sort((a, b) => (a.created || 0) - (b.created || 0)).slice(0, 12);
    for (const m of pick) used.add(m.id);
    clusters.push({ topic: t, head: pick[0], items: pick, df: c });
  }
  return clusters;
}

/**
 * 跑一次压缩。
 * @param {object} db
 * @param {{dry?: boolean, windowDays?: number}} opts
 * @returns {{made:number, clusters:Array}}
 */
export function consolidate(db, { dry = false, windowDays = WINDOW_DAYS } = {}) {
  const since = now() - windowDays * DAY;
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT id, body, kind, weight, created, COALESCE(NULLIF(project,''),'综合') AS project, uses
       FROM impressions
       WHERE status = 'active' AND created >= ?
       ORDER BY created DESC LIMIT 4000`
    ).all(since);
  } catch { return { made: 0, clusters: [] }; }

  const cs = cluster(rows).slice(0, MAX_CLUSTERS);

  const out = [];
  for (const c of cs) {
    const items = c.items.slice().sort((a, b) => (a.created || 0) - (b.created || 0));
    const first = items[0];
    const last = items[items.length - 1];
    const project = c.head.project || '综合';
    const theme = c.topic || phrase(c.head.body, 20);
    const lines = [];
    for (const it of items) {
      const p = phrase(it.body, 34);
      if (!p) continue;
      if (lines.some((x) => sim(tokens(x), tokens(p)) > 0.7)) continue;   // 同一意思只留一条
      lines.push(p);
      if (lines.length >= 3) break;
    }
    if (!lines.length) continue;
    const span = `${stampOf(first.created)}–${stampOf(last.created)}`;
    const text = clip(`${project} · ${span}（${items.length} 条）· ${theme}｜` + lines.join('；'), 230);
    out.push({
      id: 'cg:' + project + ':' + String(first.id).slice(0, 12),
      scope: 'topic',
      project,
      from_ts: first.created,
      to_ts: last.created,
      count: items.length,
      text,
      ids: items.map((x) => x.id),
    });
  }

  if (dry) return { made: 0, clusters: out };

  const up = db.prepare(
    `INSERT INTO digests (id, scope, project, from_ts, to_ts, count, text, ts)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET count=excluded.count, text=excluded.text,
       to_ts=excluded.to_ts, ts=excluded.ts`
  );
  let made = 0;
  for (const g of out) {
    try {
      up.run(g.id, g.scope, g.project, g.from_ts, g.to_ts, g.count, g.text, now());
      made += 1;
    } catch { /* 单条失败不影响别的 */ }
  }
  return { made, clusters: out };
}

export function consolidateStats(db) {
  try {
    const r = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(count),0) n FROM digests WHERE scope='topic'").get();
    return { digests: r.c || 0, covered: r.n || 0 };
  } catch { return { digests: 0, covered: 0 }; }
}
