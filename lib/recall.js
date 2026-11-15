/**
 * recall.js —— 唤起：是激活，不是查询
 *
 * 和检索系统的根本区别：不是「按相似度取前 N 条」，
 * 而是「点燃几个，沿关系走一跳，够强的才带出来」。
 * 带出来 3 条和 0 条都是正常结果，不许硬凑。
 *
 * 强度 = 点火 × 关系权重 × 新鲜度 × 确信度 × 项目匹配
 */
import { now } from './db.js';
import { tokens, coverage, sim } from './text.js';import { expand } from './syn.js';
import { cosine, fromBlob } from './embed.js';

export const PICK_THRESHOLD = 0.35;   // 占位值，用自测题从 0.5 往下试出来

/** 同义扩展词的命中折扣：扩展只是「多给几次机会」，不该和原词等价 */
const SYN_DISCOUNT = 0.35;
/* 半衰期 7 天。
 * 2026-11-14 试过放到 30 天（理由是「真名」这种老事实被衰减压过今天随口一句话），
 * 结果 bench 从 @3 100% 掉到 85% —— 老记忆一上来就把正确答案挤掉。
 * 这个值是有测试撑着的，不是随手定的，改之前先跑 bench。
 */
const HALF_LIFE_DAYS = 7;
const MAX_CANDIDATES = 3000;

/** 进程内缓存：印象的 token 集合，写入时整体失效 */
let tokenCache = new Map();
let cacheStamp = 0;
export function invalidateCache() { tokenCache = new Map(); cacheStamp += 1; }

function tokenSetOf(body) {
  let s = tokenCache.get(body);
  if (!s) { s = tokens(body); tokenCache.set(body, s); }
  return s;
}

function freshness(m) {
  // 主时钟只能是 created。之前用 last_use 是个自反馈活锁：
  // 每轮被唤起 → touchPicks 刷新 last_use → 这条变得更「新鲜」→ 下一轮更靠前，
  // 于是固定那几条占住前几名，别的记忆永远排不上队。
  // 实测有印象被注入 98 次，连续 5 轮 picks 一字不差。
  // 「复习效应」已经由 uses 延长半衰期表达，不需要再看时间戳。
  const created = m.created || 0;
  const days = Math.max(0, (now() - created) / 86400);
  const hl = m.uses > 0 ? HALF_LIFE_DAYS * 1.5 : HALF_LIFE_DAYS;
  return Math.pow(0.5, days / hl);
}

function projectFactor(m, project) {
  if (!project || !m.project) return 1.0;
  return m.project === project ? 1.0 : 0.6;   // 不串味，但不是完全屏蔽
}

/**
 * 「复习效应」：被想起来过很多次的记忆，下次更容易再被想起来。
 *
 * 之前 uses 只在库里躺着（写进去、从来不读），所以「这条以前救过场」
 * 这件事对排序毫无影响——同一个问题问三遍，三次都从同一批新记忆里翻。
 * 现在按对数加，封顶 1.45：次数多能加分，但压不住一条今天刚记下、
 * 正好对得上话的新记忆。
 */
function demandFactor(m) {
  const u = Number(m.uses) || 0;
  if (u <= 0) return 1.0;
  /* 1.45 / 0.18 → 1.20 / 0.08：和 weight 因子同一个毛病，只是更隐蔽。
   * uses=100 的老条目能拿到 1.45，uses=0 的新答案只有 1.0 —— 差 45%，
   * 足够把一条字面完全对得上的答案压到第 4 名开外。
   * 「用得多」是热度，不是相关性，只能微调。
   */
  return Math.min(1.30, 1 + 0.12 * Math.log1p(u));
}

/**
 * 意图加成：短查询换着说法时，靠意图把对应类别拉上来。
 * 「怎么说话」字面对不上「以后回答短一点」，但意图很明确是问偏好。
 */
function intentBoost(query, kind) {
  const q = String(query || '');
  if (/说话|语气|风格|调子|口吻|怎么跟我|怎么说/.test(q)) return kind === 'pref' ? 2.0 : 1.0;
  if (/为什么|原因|怎么回事|怎么修|怎么解决|坑|踩/.test(q)) {
    return kind === 'lesson' ? 1.8 : (kind === 'method' ? 1.4 : 1.0);
  }
  /* 「怎么配 / 怎么装 / 步骤」问的是做法，该把 method 类拉上来。
   * 2026-11-14 实测：问「微信通道怎么配的」，真正写配置步骤的那条进不了前六，
   * 因为这条规则只认「怎么修」「怎么解决」，method 一点加成都没有，
   * 于是它和一句随口话平起平坐，输给了被反复召回的老条目。
   */
  if (/怎么配|怎么装|怎么用|怎么弄|步骤|流程|如何|配置|安装/.test(q)) {
    return kind === 'method' ? 1.6 : 1.0;
  }
  if (/在哪|哪里|路径|目录|版本|端口|账号/.test(q)) return kind === 'fact' ? 1.6 : 1.0;
  /* 只有真的在问「什么时候提醒我」，才该推承诺类。
   * 原来这里写的是 /什么时候|提醒|待办|到期|记得/ —— 「记忆之间的关系什么时候建立」
   * 是个机制问题，却被当成问承诺，1.8 的加成直接把这题的答案推歪。
   */
  if (/待办|提醒|到期|答应我|承诺/.test(q)) return kind === 'promise' ? 1.8 : 1.0;
  /* 泛疑问句：问「什么 / 怎样 / 怎么 / 如何 / 多少 / 能不能」时，答案通常在
   * 事实、方法、教训里，而不是承诺或闲聊记录。原来只覆盖「怎么配 / 怎么装」
   * 几种子串，于是「抽取效果主要看什么」「关系网的点多了会怎样」这类问句
   * 一点加成都没有，召回来的全是「聊过这个话题」的条目。
   */
  if (/什么|怎样|怎么|如何|多少|能不能|会不会|是否/.test(q)) {
    if (kind === 'method') return 1.5;
    if (kind === 'lesson') return 1.4;
    if (kind === 'fact') return 1.3;
    if (kind === 'promise') return 0.9;
  }
  return 1.0;
}

/** 进程内缓存：印象向量（懒加载，写入时失效） */
let vecCache = new Map();
let vecStamp = -1;

function loadVectors(db) {
  // 戳比对只和 cacheStamp 有关，不再要求 size>0 —— 空表本来就不需要重读
  if (vecStamp === cacheStamp) return vecCache;
  let rows = [];
  try {
    rows = db.prepare('SELECT id, vec FROM vectors').all();
  } catch {
    // 没有向量表：这是正常降级，不是错误
    vecCache = new Map();
    vecStamp = cacheStamp;
    return vecCache;
  }
  const next = new Map();
  let bad = 0;
  for (const r of rows) {
    // 一条坏向量（长度不是 4 的倍数、blob 截断）不该把整张表读空
    try {
      const v = fromBlob(r.vec);
      if (v) next.set(r.id, v);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  if (bad) console.warn('[brain] 向量表有', bad, '条读不出来，已跳过');
  vecCache = next;
  vecStamp = cacheStamp;
  return vecCache;
}

/**
 * 唤起。
 * @param {object} db
 * @param {{query?: string, queryVec?: Float32Array, project?: string, limit?: number, threshold?: number}} opts
 * @returns {{picks: Array, degraded: string}}
 */
export function activate(db, { query = '', queryVec = null, project = '', limit = 18, threshold = null, debug = false } = {}) {
  const degraded = [];
  /* 阈值按问法长短自适应。
   * 固定 0.35 对短问题等于不筛：实测问「测试一下」（4 个字），
   * 过了阈值的候选有 18 条，全是「以后重启之前先问一下我」这种毫不相干的，
   * 真正该带出来的反而被挤到预算外 —— 短句的噪声比长句大得多，
   * 因为它没有足够的词面证据去否掉无关条目。
   */
  const qLen = String(query || '').replace(/[\s\p{P}]/gu, '').length;
  const th = Number.isFinite(threshold) ? threshold
    : (qLen <= 6 ? 0.5 : qLen <= 12 ? 0.42 : PICK_THRESHOLD);
  // 过期的事实不再进候选池：状态类记忆（「尚未配置」之类）写库时带了 7 天保质期，
  // 到期后仍然留在库里能翻查，但不再参与注入 —— 旧状态不该再被当成此刻的事实。
  const rows = db.prepare(
    `SELECT id, body, kind, certainty, weight, uses, last_use, created, project, level, scene
     FROM impressions
     WHERE status = 'active' AND (expires IS NULL OR expires > ?)
     LIMIT ?`
  ).all(now(), MAX_CANDIDATES);

  if (!rows.length) return { picks: [], degraded: degraded.join(',') };

  // 分母只用「原始查询词」。扩展出来的同义词只是多给几次命中机会；
  // 把它们也算进分母的话，扩得越多门槛越高——一个 7 词的查询被扩成 19 词，
  // 记忆再准也只可能命中一两个，覆盖率被稀释成 1/10，永远过不了阈值。
  // 这是三道基准题长期漏召回的真正原因。
  const qtRaw = tokens(query);
  const qt = expand(new Set(qtRaw));
  const vecs = queryVec ? loadVectors(db) : null;

  // ① 点火：先算词频（df），按稀有度给每个词称重。
  // 老写法是"命中 4 个词就满分"，可长记忆天然命中更多词，于是长文永远压着短文，
  // 关键是「服务、自己、记得」这种到处都是的词被当成同等证据。改成按稀有度称重后，
  // 「控制台」「发布」「330」这类只在一两条里出现的词才真正决定归属。
  const sets = new Map();
  const df = new Map();
  for (const m of rows) {
    const s0 = tokenSetOf(m.body);
    const sx = expand(new Set(s0));
    sets.set(m.id, sx);
    for (const t of sx) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = rows.length || 1;
  const wOf = (t) => {
    const d = df.get(t) || 0;
    const idf = Math.log(1 + N / (1 + d));
    // 英文词/标识符/数字更值钱：命中 node、dsh、8080 比命中一个常见二元组有意义得多
    return (/[a-z0-9]/.test(t) ? 1.8 : 1) * idf;
  };
  let qWeight = 0;
  for (const t of qtRaw) qWeight += wOf(t);   // 原始词，不含同义扩展
  if (!(qWeight > 0)) qWeight = 1;

  const base = [];
  for (const m of rows) {
    const bodyX = sets.get(m.id) || new Set();
    const ib = intentBoost(query, m.kind);
    const routes = qt.size ? ['lex'] : ['focus'];
    let ignite = 0;
    if (qt.size) {
      let hit = 0;
      // 原始词全额，同义扩展词打 3.5 折。
      // 之前扩展词也按全额计入 hit，而分母只有原始词的权重和，
      // 结果随便哪条记忆都能把 hit 顶到 ≥ qWeight、ignite 全部封顶 1.0，
      // 分数彻底没有区分度 —— 真正该排第一的那条被一堆长文档挤到 18 名开外。
      for (const t of qtRaw) {
        if (bodyX.has(t)) hit += wOf(t);
      }
      for (const t of qt) {
        if (!qtRaw.has(t) && bodyX.has(t)) hit += wOf(t) * SYN_DISCOUNT;
      }
      // 覆盖率开方：稀有词全中才算 1，但只中一部分也不至于被打到阈值下面去
      // （纯粹按覆盖率算，词面对不上时会出现"一条都不返回"，那是更糟的退步）
      const cov = Math.sqrt(Math.min(1, hit / qWeight));
      /* 重要性 boost 必须受覆盖率约束。
       * 老公式是 ignite = cov * ib，ib 无条件乘上去 —— 于是"token 有三种携带方式，
       * 各端用法不同"这种泛词多的短句，靠只命中"的/方式/各端"就能吃到满额重要性，
       * 一路被召回 57 次、权重涨到顶（3.0），然后什么查询都排第一。
       * 这是典型的自我强化陷阱：命中 → 加分 → 更靠前 → 更常命中。
       * 现在改成 ignite = cov * (1 + (ib-1) * cov)：
       * 覆盖率 1.0 时拿满重要性；只覆盖三成时，重要性也只剩三成的效果。
       */
      ignite = cov * (1 + (ib - 1) * cov);

      // 向量这一路：词面对不上但意思近的，靠它救。
      // 融合方式用「概率或」，不是"谁大用谁"——两路证据都能加分，
      // 实测同一批问题上比取最大值多召回两条（见 scripts/recall-bench.mjs）。
      if (vecs) {
        const mv = vecs.get(m.id);
        if (mv) {
          const cos = cosine(queryVec, mv);
          // bge-small-zh 对短句普遍给高分，0.45 以下基本都是噪声，所以从这里起算
          const vs = Math.min(1, Math.max(0, (cos - 0.40) / 0.26));
          const lexRaw = Math.min(1, hit / qWeight);
          const fused = 1 - (1 - lexRaw) * (1 - vs);
          /* 约束跟词法那条路保持一致（2026-11-14）。
           * 这里原来写的是 fused * ib —— 重要性无条件乘上去，于是
           * 「我记得插件儿里有一个热重载的插件儿」这种随口话，靠一点词面 + 一点语义，
           * 乘上高权重就能拿 1.36，压过真正的架构说明（1.00）。
           * 覆盖率不够的时候，权重不该有这么大话语权。
           */
          const cand = fused * (1 + (ib - 1) * fused);
          if (cand > ignite) {
            ignite = cand;
            routes.push('vec');
          }
        }
      }

      if (ignite === 0 && ib > 1) ignite = 0.5 * (ib - 1);   // 意图命中给保底分
      if (ignite <= 0) continue;
      /* 等级折价。
       * level 原来是"只写不读"：遗忘机制把记忆降成 blur / sunk，
       * 检索这边压根不看这个字段，赢了也白降 —— 整套遗忘等于空转。
       * 沉底不是删除，强相关时还能捞出来，只是不再和完整记忆平起平坐。
       */
      const lv = String(m.level || 'clear');
      if (lv === 'sunk') ignite *= 0.55;
      else if (lv === 'blur') ignite *= 0.6;
    } else {
      ignite = 0.3;   // 空查询：让「新 + 重要」的能冒头
    }
    base.push({
      m,
      ignite,
      rel: 0,
      routes,
    });
  }

  if (!base.length) return { picks: [], degraded: degraded.join(',') };

  // ② 取火种：点火最强的 12 条
  base.sort((a, b) => b.ignite - a.ignite);
  const seeds = base.slice(0, 12);

  // ③ 一跳扩散：沿 bonds 和 causes 把邻居拉进来（只走一跳，走两跳必串味）
  const byId = new Map(base.map((x) => [x.m.id, x]));
  const seedIds = seeds.map((s) => s.m.id);
  const ph = seedIds.map(() => '?').join(',');

  let bondRows = [];
  let causeRows = [];
  try {
    bondRows = db.prepare(
      `SELECT a, b, kind, w FROM bonds WHERE a IN (${ph}) OR b IN (${ph})`
    ).all(...seedIds, ...seedIds);
    causeRows = db.prepare(
      `SELECT cause, effect, kind, certainty, status FROM causes
       WHERE (cause IN (${ph}) OR effect IN (${ph})) AND status IN ('active','suspect')`
    ).all(...seedIds, ...seedIds);
  } catch { degraded.push('graph'); }

  const boost = new Map();
  const addBoost = (id, w, route) => {
    const cur = boost.get(id) || { w: 0, routes: new Set() };
    cur.w = Math.max(cur.w, w);
    cur.routes.add(route);
    boost.set(id, cur);
  };

  for (const b of bondRows) {
    const other = seedIds.includes(b.a) ? b.b : b.a;
    const seed = byId.get(seedIds.includes(b.a) ? b.a : b.b);
    if (!seed) continue;
    const factor = b.kind === 'repeat' ? 1.0 : 0.5;          // 同在 ×0.5，重复 ×1
    addBoost(other, seed.ignite * factor * (b.w || 1), b.kind === 'repeat' ? 'repeat' : 'co');
  }
  for (const c of causeRows) {
    const from = seedIds.includes(c.cause) ? c.cause : c.effect;
    const to = from === c.cause ? c.effect : c.cause;
    const seed = byId.get(from);
    if (!seed) continue;
    // 缺省可信度不能再给 0.8 —— 那等于把「没标可信度」的边当成手写的高可信边。
    // suspect 边放行，但要对折：它还没被任何人验证过。
    const cert = c.certainty == null ? 0.3 : Number(c.certainty) || 0;
    const statusW = c.status === 'active' ? 1 : 0.5;
    const kindW = c.kind === 'pathological' ? 0.9 : 0.8;     // 病理因最重要
    addBoost(to, seed.ignite * kindW * cert * statusW, 'cause');
  }

  // ③b 因果第二跳：A→B→C 里的 C 也能被想起来，但按衰减算（因果不是等价）
  //     只走 certainty ≥ 0.6 且 status=active 的边，suspect 不往下传。
  try {
    const hop1 = [...boost.keys()];
    if (hop1.length) {
      const ph1 = hop1.map(() => '?').join(',');
      const hop2 = db.prepare(
        `SELECT cause, effect, kind, certainty FROM causes
         WHERE (cause IN (${ph1}) OR effect IN (${ph1}))
           AND status = 'active' AND certainty >= 0.6`
      ).all(...hop1, ...hop1);
      for (const c of hop2) {
        const from = hop1.includes(c.cause) ? c.cause : c.effect;
        const to = from === c.cause ? c.effect : c.cause;
        const cur = boost.get(from);
        if (!cur || !cur.w) continue;
        addBoost(to, cur.w * 0.45 * (c.certainty || 0.8), 'cause2');
      }
    }
  } catch { degraded.push('cause2'); }

  // ④ 算总分
  //
  // 这里原来只给「点火最强的 12 条 + 它们的邻居」打分，排名第 13 的记忆
  // 哪怕和第 1 名只差一点点，也永远不可能被想起——实测这是漏召回的主因。
  // 现在所有过了点火闸的候选一起打分，扩散只作为加分项，而不是入场券。
  const scored = [];
  const diag = [];
  const seenIds = new Set();

  // weight 之前压根没进公式：一条被反复确认的硬规矩，和一句顺口一提的感慨，
  // 在排序上完全等价（库里 202 条 weight=3.0 与 1.0 的排序毫无差别）。
  // 现在给一个温和的乘子（1.0→1.0，3.0→1.3）：只做微调，
  // 不能让「重要」压过「正好对得上这句话」。
  // level 之前只被 SELECT 查出来、从来没进过公式：一条被标成 blur/sunk 的旧记忆，
  // 和一条正常记忆的排位一模一样，「降级」等于没降。现在按档位压分。
  const levelFactor = (m) => {
    // 0.35 → 0.7：沉底的条目本来就该"只在强相关时捞出来"，但 0.35 等于永久出局。
    // 库里七成条目被沉底、其中还有 uses 上百次的老事实，压到 0.35 就再也召不回。
    if (m.level === 'sunk') return 0.7;
    if (m.level === 'blur') return 0.85;
    return 1.0;
  };

  const mods = (m) =>
    freshness(m)
    * (m.certainty == null ? 0.8 : Number(m.certainty) || 0)
    * projectFactor(m, project)
    * demandFactor(m)
    * levelFactor(m)
    /* weight 因子从 0.85+0.15w 收到 0.92+0.08w。
     * 原来的幅度（1.0→1.0，3.0→1.3）看着温和，实测是排序翻车的主因：
     * 问「回应是怎么走完一圈的」，字面最对的那条 ignite 0.76（全场最高），
     * 却因为 weight=1 输给一条 weight=3、ignite 只有 0.59 的老条目。
     * 被反复想起的记忆本来就容易再被想起，这个正反馈不该强到压过「字面对得上」。
     */
    * (0.92 + 0.08 * Math.min(3, Math.max(1, Number(m.weight) || 1)));

  const baseScoreOf = (m, ignite) => ignite * mods(m);

  for (const item of base) {
    const m = item.m;
    const own = baseScoreOf(m, item.ignite);
    const b = boost.get(m.id);
    const bonus = b ? b.w * 0.6 * mods(m) : 0;
    const score = own + bonus;
    seenIds.add(m.id);
    const routes = [...new Set([...item.routes, ...(b ? [...b.routes] : [])])];
    diag.push({ id: m.id, body: m.body, score, ignite: item.ignite, route: routes.join('+'), seed: item.ignite > 0 });
    if (score >= th) scored.push({ m, score, ignite: item.ignite, routes });
  }

  // 扩散拉进来的、不在点火候选里的邻居
  for (const [id, b] of boost) {
    if (seenIds.has(id)) continue;
    const m = db.prepare(
      `SELECT id, body, kind, certainty, weight, uses, last_use, created, project, level, scene
       FROM impressions WHERE id = ? AND status = 'active'`
    ).get(id);
    if (!m) continue;
    const score = b.w * 0.6 * mods(m);
    diag.push({ id, body: m.body, score, ignite: 0, route: [...b.routes].join('+') });
    if (score >= th) scored.push({ m, score, ignite: 0, routes: [...b.routes] });
  }

  // ④b 重排：候选先放大，再「回头看一眼字面」重排一次
  //
  // 为什么要第二层：激活分算的是「像不像」，四个因子乘下来，
  // 一条今天刚记、字面几乎完全对得上的话，会输给一条上周记的、
  // 因为扩散而虚高的老记忆。重排层只在已经过阈值的池子里换位置，
  // 不改变谁能进来，只改谁排前面 —— 所以调坏了最多是顺序变差，不会漏召。
  const poolSize = Math.max(limit * 3, 12);
  const pool = scored.slice(0, poolSize);
  const maxScore = pool.reduce((a, p) => Math.max(a, p.score), 1e-6);
  for (const p of pool) {
    const bodyX = sets.get(p.m.id) || new Set();
    let hit = 0;
    for (const t of qt) if (bodyX.has(t)) hit += wOf(t);
    const cov = qWeight > 0 ? Math.min(1, hit / qWeight) : 0;
    const routeBonus = p.routes.includes('cause') || p.routes.includes('cause2') ? 0.08
      : p.routes.includes('repeat') || p.routes.includes('co') ? 0.06 : 0;
    const brevity = 1 - Math.min(1, String(p.m.body || '').length / 400);
    p.cov = cov;
    /* 权重配比调过一次（2026-11-14）。
     * 原来是 score 0.72 / cov 0.22：问「hot_reload 怎么用」时，
     * 分数最高的那条（1.14，写的就是 hot_reload 用法）排第 5，
     * 被「连接该设备的唯一办法是使用一根数据线」这种 17 字短句压住 ——
     * 它字面覆盖率略高、又因为短吃到 brevity 加分，两头的便宜都占了。
     * 现在总分的份量加重，字面覆盖只当辅助。
     */
    /* 2026-11-15 再分一次：0.80/0.14 → 0.72/0.18。
     * @3 到 85% 之后剩下的毛病是 @1 只有 40% —— 对的条目常常就在前三，
     * 只是排第二。这一层就是干这个的：把字面覆盖的份量抬一点，
     * 让「字面更贴」的那条挤到第一。brevity 也从 0.04 提到 0.06。
     */
    p.rerank = (p.score / maxScore) * 0.76 + cov * 0.16 + routeBonus + brevity * 0.05;
  }
  pool.sort((a, b) => b.rerank - a.rerank);
  const ordered = pool.concat(scored.slice(pool.length));

  // ⑤ 相对阈值：绝对阈值管不住短问题
  //    「测试一下」这种 4 字查询，靠新鲜度和关系放大，过 0.35 的有 17 条，
  //    分数全在 0.8 以上，可它们彼此毫不相关 —— 绝对阈值在短句上等于不筛。
  //    这里再按「相对第一名」砍一刀：低于首名 60% 的不要。
  //    只在候选够多时生效，并且至少留 2 条，免得把本该多条的召回压成一条。
  let ordered2 = ordered;
  if (ordered.length >= 4) {
    const best = ordered.reduce((a, p) => Math.max(a, p.score || 0), 0);
    if (best > 0) {
      // 0.6 → 0.45：0.6 太狠，实测「继续优化吧我重启了」被砍到 0 条 ——
      // 一条都不注入和注入一堆噪声一样糟，只是更安静。留 45% 这个下限，
      // 让每条都至少在首名的四成以上。
      const strong = ordered.filter((p) => (p.score || 0) >= best * 0.45);
      if (strong.length >= 2) ordered2 = strong;
    }
  }

  // ⑥ 去重（按记忆 id，不按对象引用——上一版在这里栽过）
  const seen = new Set();
  const picks = [];
  for (const p of ordered2) {
    if (seen.has(p.m.id)) continue;
    seen.add(p.m.id);
    picks.push(p);
    if (picks.length >= limit) break;
  }

  if (debug) {
    diag.sort((a, b) => b.score - a.score);
    return { picks, degraded: degraded.join(','), diag };
  }
  return { picks, degraded: degraded.join(',') };
}

/* ---------------- 预算裁剪 ---------------- */

/**
 * 按字数预算裁，整条裁，不截半句。
 */
export function fitBudget(picks, budget = 1200) {
  const out = [];
  let used = 0;
  const kept = [];
  for (const p of picks) {
    const body = String((p.m && p.m.body) || '');
    if (!body) continue;
    /* 同一次注入里，说同一件事的只留一条。
     * 实测 2026-11-14：问"重启 DSH 用什么"，注入里连着出现三条几乎一样的
     * 「重启固定用桌面 bat，不要另写脚本」—— 用户看到的是同一句话念三遍，
     * 既占预算又显得笨。picks 已按分数排好序，所以留下的是最该留的那条。
     */
    let dup = false;
    for (const k of kept) {
      try { if (sim(k, body) >= 0.6) { dup = true; break; } } catch { /* 判不了就不过滤 */ }
    }
    if (dup) continue;
    const line = `· [${p.m.kind}] ${body}`;
    if (used + line.length > budget) break;
    used += line.length;
    kept.push(body);
    out.push(p);
  }
  return out;
}

/** 把「想起来的」记一笔：加分 + 留痕 */
export function touchPicks(db, picks) {
  if (!picks.length) return;
  const t = now();
  const stmt = db.prepare(
    'UPDATE impressions SET uses = uses + 1, last_use = ?, weight = MIN(3.0, weight + 0.05) WHERE id = ?'
  );
  for (const p of picks) {
    try { stmt.run(t, p.m.id); } catch { /* 单条失败不影响别的 */ }
  }
}
