/**
 * cause-extract.js —— 从话里自己挖因果，不用等他说「记一条：因为 A 所以 B」
 *
 * 人说话不会按格式来，但「因为/所以/导致/结果」这些词每天都在出现，
 * 那才是真的因果线索。这里只多干一件事——把话说出来那两截，对到库里已有的记忆上。
 * 对不上就丢掉，宁可漏，不许瞎连。
 *
 * 这一版修的三件事：
 *   ① 覆盖门槛形同虚设。原来 MIN_COVER = 0.34、MIN_HITS = 2，而 tokens() 切的是
 *      二元组：「禁用广告」切出 禁用/用广/广告 三个，只要其中两个在库里出现，
 *      一条完全不相干的记忆就能被"对"上。现在改成：
 *        - 命中词的 idf 平均值要高于全库 idf 中位数（不是靠常用词蒙）
 *        - 覆盖率仍按 idf 加权，但门槛提到 0.5
 *        - 两端对到的印象之间还要互验一次：sim(ca, cb) < 0.2 说明它俩压根不是一件事
 *   ② 每个正则只取第一个匹配（`src.match(re)`）。一句话里有两组因果，只抽得到前一组。
 *      改成 matchAll 全取，去重交给 addCause。
 *   ③ 自动抽出来的边写 `kind: 'direct'`、certainty 0.55 —— 冒充「已经确认的直接因果」。
 *      现在一律 kind 用抽取到的真类型、status 写成 suspect、certainty 0.45：
 *      它不是 direct，它只是「有人这么说过」。
 */
import { now } from './db.js';
import { tokens, sim } from './text.js';
import { addCause } from './cause.js';

// 只认「A 导致 B」这种明确连接词。含糊的（于是、然后）不算，那只是时间顺序。
const PATTERNS = [
  [/因为(.{3,60}?)(?:，|,|。|;|；)?\s*(?:所以|因此|才|就)(.{3,60})/g, 'direct'],
  [/由于(.{3,60}?)(?:，|,|。|;|；)\s*(.{3,60})/g, 'direct'],
  [/(.{3,60}?)(?:导致|使得|造成|引起|搞成|弄成)了?(.{3,60})/g, 'direct'],
  [/(.{3,60}?)(?:才|所以|因此)(?:会|能|要|得)?(.{3,60})/g, 'indirect'],
];

const MIN_COVER = 0.5;      // 这句话里按 idf 加权，至少一半的信息量能在某条记忆里找到
const MIN_HITS = 2;         // 至少命中两个词，防止一条记忆靠一个词撞上
const MIN_PAIR_SIM = 0.2;   // 两端对到的两条印象本身至少得沾点边

/** 把一段话对到库里的一条记忆上：按稀有度算覆盖率，并记录命中词的 idf 均值 */
function matchImpression(db, clause, idf, N, idfMedian) {
  const t = tokens(clause);
  if (!t.size) return null;
  let qw = 0;
  for (const x of t) qw += idf(x, N);
  if (qw <= 0) return null;

  let best = null;
  try {
    for (const r of db.prepare(
      "SELECT id, body, created FROM impressions WHERE status = 'active' ORDER BY created DESC LIMIT 2000"
    ).all()) {
      const bt = tokens(r.body);
      let hit = 0;
      let n = 0;
      for (const x of t) {
        if (bt.has(x)) { hit += idf(x, N); n += 1; }
      }
      if (n < MIN_HITS) continue;
      const cov = hit / qw;
      if (cov < MIN_COVER) continue;
      // 命中的词如果全是高频词（"这个""然后"），idf 均值会低于全库中位数——
      // 那不是"对上了"，那是"都用了中文"。
      const avgIdf = hit / n;
      if (avgIdf < idfMedian) continue;
      if (!best || cov > best.cov) best = { id: r.id, cov, hits: n, body: r.body, avgIdf };
    }
  } catch { return null; }
  return best;
}

/**
 * 从一段对话里抽因果，抽到就写库。
 * @param {object} db
 * @param {string} text 用户+助手那一段话
 * @param {{dry?: boolean, eventIds?: Array<string|number>}} opts
 *   eventIds：这一轮的事件 id，会作为「哪一轮对话催出了这条因果」的证据写进边里。
 *   addCause 现在允许纯数字（events.rowid）作为证据；没有证据的候选一律丢弃。
 * @returns {{found:number, added:Array, skipped:Array}}
 */
/**
 * 这条印象配不配当因果的一端。
 *
 * 库里有整整一类 body 是「轮次摘要」：里面裹着工具返回、代码块、整段提示词，
 * 甚至有 "Agent xxx sent a message"。它们不是「一件事」，是「一整个回合」。
 * 拿它们连因果，就会抽出这样的边：
 *     「你在审计一个自制的中文记忆系统插件…」→「数据损坏或功能完全失效」
 * 看着像推理，实际是把提示词当成了记忆。2026-11-14 实测 active 边里有相当一批是这种。
 */
const JUNK_BODY = /(\[tool\/result|```|sent a message|\[dsh-mnemon:|\[brain\]|^你是|^你在|^任务[：:]|^输出格式|^已知现象)/;
function junkImpression(body) {
  return JUNK_BODY.test(String(body || ''));
}

export function extractCauses(db, text, { dry = false, eventIds = [] } = {}) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (src.length < 12) return { found: 0, added: [], skipped: [] };

  // df 现算：只算一遍，所有候选共用
  let N = 1;
  const df = new Map();
  try {
    const rows = db.prepare("SELECT body FROM impressions WHERE status='active' LIMIT 2000").all();
    N = rows.length || 1;
    const seen = new Set();
    for (const r of rows) {
      seen.clear();
      for (const x of tokens(r.body)) seen.add(x);
      for (const x of seen) df.set(x, (df.get(x) || 0) + 1);
    }
  } catch { /* 空库就啥也抽不出来 */ }
  const idf = (x, n) => Math.log(1 + n / (1 + (df.get(x) || 0)));

  // 全库 idf 中位数：用来判断「命中的词是不是稀有」
  let idfMedian = 0;
  if (df.size) {
    const vals = [...df.keys()].map((x) => idf(x, N)).sort((a, b) => a - b);
    idfMedian = vals[Math.floor(vals.length / 2)];
  }

  const added = [];
  const skipped = [];
  const seenPair = new Set();

  for (const [re, kind] of PATTERNS) {
    // matchAll 全取：一句话里有两组因果，只抽第一组等于漏一半
    let ms = [];
    try { ms = [...src.matchAll(re)]; } catch { ms = []; }
    for (const m of ms) {
      const [, a, b] = m;
      if (!a || !b) continue;
      const ca = matchImpression(db, a, idf, N, idfMedian);
      const cb = matchImpression(db, b, idf, N, idfMedian);
      if (!ca || !cb || ca.id === cb.id) {
        skipped.push({
          why: ca ? (cb ? '两端对到同一条' : '果那头没对上') : '因那头没对上',
          a: a.slice(0, 20), b: b.slice(0, 20),
        });
        continue;
      }
      // 匹配到的两端里只要有一头是「轮次摘要」，这条边就不写。
      // 这是治本的一刀：输入端总会塞进工具输出和提示词，光靠清洗输入挡不干净。
      if (junkImpression(ca.body) || junkImpression(cb.body)) {
        skipped.push({ why: '端点不像一件事（提示词/工具输出）', a: a.slice(0, 20), b: b.slice(0, 20) });
        continue;
      }
      // 互验：两端是各自独立匹配上的，如果它俩彼此毫无关系，
      // 那多半是同一段话里两句不搭界的话被硬凑成了因果。
      if (sim(ca.body || '', cb.body || '') < MIN_PAIR_SIM) {
        skipped.push({ why: '两端互不相关', a: a.slice(0, 20), b: b.slice(0, 20) });
        continue;
      }
      const key = ca.id + '>' + cb.id;
      if (seenPair.has(key)) continue;
      seenPair.add(key);

      if (dry) {
        added.push({ dry: true, cause: ca.id, effect: cb.id, a: a.slice(0, 24), b: b.slice(0, 24) });
        continue;
      }

      // 没有独立证据就不要写。自动抽的边不该拿两端自己的 id 去当证据。
      if (!eventIds.length) {
        skipped.push({ why: '没有事件证据', a: a.slice(0, 20), b: b.slice(0, 20) });
        continue;
      }

      const r = addCause(db, {
        cause: ca.id,
        effect: cb.id,
        kind,                              // 抽到的是 direct 就用 direct，但状态永远是 suspect
        certainty: 0.45,                   // 低于二跳门槛 0.6，也低于 PICK_THRESHOLD
        status: 'suspect',                 // 自动抽的不是"已确认"，只是"有人这么说过"
        evidence: eventIds,
        by: 'auto-extract',
        why: {
          t: 'cause',
          mark: '句式抽取',
          note: `${a.slice(0, 18)} → ${b.slice(0, 18)}`,
          extracted: true,
        },
      });
      if (r.ok) added.push(r);
      else skipped.push({ why: r.error, a: a.slice(0, 20), b: b.slice(0, 20) });
    }
  }

  return { found: added.length, added, skipped };
}

/** 把库里所有事件文本重扫一遍（补课用，跑一次就行） */
export function backfillFromEvents(db, { limit = 400, dry = false } = {}) {
  let rows = [];
  try {
    rows = db.prepare('SELECT id, body AS text FROM events ORDER BY ts DESC LIMIT ?').all(limit);
  } catch { return { scanned: 0, found: 0 }; }
  let found = 0;
  for (const r of rows) {
    try {
      const x = extractCauses(db, r.text, { dry, eventIds: [r.id] });
      found += x.found;
    } catch { /* 单条失败不影响别的 */ }
  }
  try {
    db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
      .run('cause_backfill_at', String(now()));
  } catch { /* 记不上无所谓 */ }
  return { scanned: rows.length, found };
}
