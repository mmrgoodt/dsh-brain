/**
 * think.js —— 会思考的主动开口
 *
 * 跟 proactive.js 的根本区别：这里不是"到点了挑一条模板念"，而是先做推理。
 * 推理的东西必须是真的推出来的，不能是查表：
 *
 *   矛盾   你说过「别用小标题」，最近又说「用小标题分一下」→ 得问一句按哪个来
 *   复发   你说过「别再做 X」，后来的记忆里又出现 X → 我该提醒你
 *   收尾   你答应的事，后面真出现了"搞定了"→ 这不是催，是接一句
 *   停滞   某个项目之前聊得很密，突然断了 36 小时以上，且停在半句上
 *   复现   同一个词最近连着出现三次 → 这才是你现在真在意的东西
 *
 * 全部零成本、纯本地。没有值得说的事就返回 null —— 沉默也是结论。
 * 可选：拿到 llm 服务时把句子润一下（polish），决定权仍在本文件。
 */

const DAY = 86400;

import { weightOf } from './feedback.js';

/* ---------- 中文相似度：bigram 的 Jaccard ---------- */
const STOP = new Set([
  '这个', '那个', '我们', '你们', '什么', '可以', '现在', '已经', '就是', '还是',
  '因为', '所以', '但是', '如果', '然后', '你的', '我的', '自己', '这样', '那样',
  '一下', '一个', '不是', '没有', '有点', '感觉', '应该', '需要', '不要', '东西',
  '时候', '问题', '还差', '好的', '知道', '看看', '试试', '以后', '刚才',
  '这次', '那次', '一次', '一直', '其实', '可能', '不用', '这么', '那么',
  '起来', '出来', '过来', '回来', '到了', '两个', '三个', '不能', '会去',
  '一句', '两句', '这事儿', '事情', '每个', '所有', '直接', '立刻', '马上',
]);

function grams(s) {
  const t = String(s || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, ' ').trim();
  const out = new Set();
  for (const chunk of t.split(/\s+/)) {
    if (!chunk) continue;
    if (/^[a-zA-Z0-9]+$/.test(chunk)) { if (chunk.length > 1) out.add(chunk.toLowerCase()); continue; }
    for (let i = 0; i + 2 <= chunk.length; i++) {
      const g = chunk.slice(i, i + 2);
      if (!STOP.has(g)) out.add(g);
    }
  }
  return out;
}

function sim(a, b) {
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / (A.size + B.size - hit);
}

function overlap(a, b) {
  const A = grams(a), B = grams(b);
  const out = [];
  for (const g of A) if (B.has(g)) out.push(g);
  return out;
}

/* ---------- 语气工具 ---------- */
const NEG = /(别|不要|不用|不需要|避免|少用|删掉|去掉|禁止)/;
const POS = /(要|必须|一定|需要|多用|加上|保留)/;

function polarity(body) {
  const s = String(body || '');
  const n = NEG.test(s), p = POS.test(s);
  if (n && !p) return -1;
  if (p && !n) return 1;
  return 0;
}

function humanize(body, max = 40) {
  let t = String(body || '')
    .replace(/^待办[：:]\s*/, '')
    .replace(/[*`#>|\[\]]/g, '')
    .replace(/^[「『"']|[」』"']$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = t.search(/[。！？；]/);
  if (cut > 6 && cut < max) t = t.slice(0, cut);
  if (t.length > max) {
    // 截断要断在标点或空格上：直接 slice 会切出「…安装任何插件的时候都要用…」
    // 这种半句，读起来像系统出错，不像人在说话。
    const head = t.slice(0, max);
    const at = Math.max(head.lastIndexOf('，'), head.lastIndexOf('、'),
      head.lastIndexOf('；'), head.lastIndexOf(' '));
    t = (at >= max * 0.5 ? head.slice(0, at) : head) + '…';
  }
  return toSecondPerson(t);
}

/**
 * 把人称掰回"对你说"。
 * 库里的 body 九成是第三人称摘要（「他要求…」「还要他本人去点」），
 * 原样塞进引号里，读起来像我在跟别人汇报你——「Gitee 那个仓库还要他本人去网页上点一下发布，
 * 这件还悬着吗」，一句话就把人推远了。
 * 只动最稳的几种：他本人 / 开头的「他说他要」/ 逗号后的「他要求」。
 * 「我」一律不碰 —— 那可能真是我，也可能是你引用自己。
 */
function toSecondPerson(s) {
  return String(s || '')
    .replace(/他本人/g, '你本人')
    .replace(/^他(?=(说|要|想|问|觉得|希望|需要|让|叫|不太|不想|更))/, '你')
    .replace(/([，。；：、])他(?=(说|要|想|问|觉得|希望|需要|让|叫|不太|不想|更))/, '$1你');
}

const DONE = /(搞定|做完|完成|跑通|通了|好了|修好|发布|上线|装上|装好|合并|推上去)/;
const FUTURE = /(明天|下次|待办|回头|稍后|继续|接着|还没|没做|剩下|计划)/;

/**
 * 这条记忆配不配当"他说过的一句规矩"。
 * 踩过的坑：库里有一批 body 是被截断的技术长句（「、一大段…）永远不可能出现在
 * token 集合里 —— 实测 tokens('安…」），拿它当规矩去质问人，读起来像乱码。
 * 判据很简单：像一句人话（不以标点开头、括号闭合、句子不长、省略号不多）。
 */
function looksLikeRule(body) {
  const b = String(body || '').trim();
  if (b.length < 4) return false;
  if (/^[、，。；：,.;:）)】」』”’…—\-]/.test(b)) return false;   // 以标点开头 = 截断残渣
  if ((b.match(/…/g) || []).length >= 2) return false;           // 多处省略 = 拼不起来
  if ((b.match(/[，。；！？,.;!?]/g) || []).length >= 5) return false; // 一整段话，不是一句规矩
  if (/[（(][^）)]{0,14}$/.test(b)) return false;                 // 括号没闭合
  if ((b.match(/[「『“"]/g) || []).length !== (b.match(/[」』”"]/g) || []).length) return false; // 引号没配对
  return true;
}

const ageDays = (sec) => (Date.now() / 1000 - Number(sec || 0)) / DAY;
const hhmm = (sec) => {
  const d = new Date(Number(sec) * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 两句话共有的最长连续汉字片段：用来判断"是不是在说同一件事" */
function commonRun(a, b) {
  const A = String(a || '').replace(/[^一-龥]/g, '');
  const B = String(b || '').replace(/[^一-龥]/g, '');
  if (!A || !B) return 0;
  let best = 0;
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      let k = 0;
      while (i + k < A.length && j + k < B.length && A[i + k] === B[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

/* ---------- 五个推理器 ---------- */
function detectContradiction(imps) {
  // 「别 X」和「就用 X」是同一件事的两种说法。判据不是"像"，是**同一个宾语**：
  // 从否定句里抽出 X，再找另一条真的在说 X、而且没带否定的记忆。
  const out = [];
  const pool = imps.filter(i => (i.kind === 'pref' || i.kind === 'fact')).slice(0, 260);
  const famous = new Set();          // 满大街都是的词，比如 dsh / token，不能当主题
  {
    const freq = new Map();
    for (const i of pool) for (const r of rulesOf(i.body)) freq.set(r.obj, (freq.get(r.obj) || 0) + 1);
    const cap = Math.max(3, Math.round(pool.length * 0.08));
    for (const [obj, n] of freq) if (n > cap) famous.add(obj);
  }
  for (const L of pool) {
    if (polarity(L.body) >= 0) continue;
    const pats = rulesOf(L.body).filter(r => r.obj.length >= 3 && !famous.has(r.obj));
    if (!pats.length) continue;
    const other = pool.find(i => {
      if (i.id === L.id) return false;
      if (Math.abs(i.created - L.created) < 6 * 3600) return false;
      if (polarity(i.body) < 0) return false;
      return pats.some(r => hitRule(r, i.body));
    });
    if (!other) continue;
    const [oldOne, newOne] = L.created <= other.created ? [L, other] : [other, L];
    out.push({
      kind: 'contradict', score: 0.9, id: 'x:' + oldOne.id + ':' + newOne.id,
      why: `同一个东西前后两种说法（${hhmm(oldOne.created)} vs ${hhmm(newOne.created)}）`,
      text: `你之前说「${humanize(oldOne.body)}」，后来又成了「${humanize(newOne.body)}」——这两条我该按哪个来？`,
      refs: [oldOne.id, newOne.id],
    });
    if (out.length >= 2) break;
  }
  return out;
}

/** 从"别做 X"里抽出 动词 + 宾语；只有两者挨得近才算真的踩到 */
const VERBS = ['改', '动', '删', '去掉', '拆', '加', '写', '列', '上', '用', '堆', '贴', '插', '开', '装', '推', '跑', '建', '调'];
const NEG_RE = /(?:别|不要|不用|不需要|避免|少用|禁止)([^，,。；;！!？?]{2,18})/g;

function rulesOf(rule) {
  const out = [];
  let m;
  NEG_RE.lastIndex = 0;
  while ((m = NEG_RE.exec(String(rule)))) {
    const clause = m[1].replace(/^(再|去|动不动|老是|总是|继续|我的|我)/, '');
    const verb = VERBS.find(v => clause.includes(v)) || '';
    // 拉丁词当宾语必须够长：原来 2 个字符也收，"ba" 于是命中了 database/backup
    // 这种完全无关的词，抽出来的"规矩"就成了「…又碰到 ba 了」。
    const latin = (clause.match(/[a-zA-Z][a-zA-Z0-9_.-]{1,}/g) || [])
      .filter((w) => w.replace(/[._-]/g, '').length >= 3);
    let objs = latin;
    if (!objs.length) {
      const stripped = clause.replace(/[a-zA-Z0-9_.-]+/g, '');
      const tail = stripped.slice(-2);
      objs = (tail.length === 2 && !STOP.has(tail)) ? [tail] : [];
    }
    // 英文/标识符做宾语时，它自己就够独特了，不再强求动词相邻
    for (const obj of objs) out.push({ verb: latin.length ? '' : verb, obj });
  }
  return out;
}

/** 命中判定：宾语出现，且动词就在它附近；返回被踩到的东西，没踩到返回 null */
function hitRule(rule, body) {
  const b = String(body || '');
  const obj = String(rule.obj || '');
  if (!obj) return null;

  // 拉丁宾语要卡词边界：规则里是 "ds"，不能让 "dsd/words" 去命中它
  if (/^[a-zA-Z]/.test(obj)) {
    const esc = obj.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let re;
    try { re = new RegExp(`(^|[^a-zA-Z0-9_])(${esc})(?![a-zA-Z0-9_])`, 'i'); } catch { return null; }
    const m = b.match(re);
    if (!m) return null;
    const idx = m.index + (m[1] ? m[1].length : 0);
    if (!rule.verb) return obj;
    const near = b.slice(Math.max(0, idx - 10), idx + obj.length + 10);
    return near.includes(rule.verb) ? rule.verb + ' … ' + obj : null;
  }

  const idx = b.indexOf(obj);
  if (idx < 0) return null;
  if (!rule.verb) return obj;
  const near = b.slice(Math.max(0, idx - 10), idx + obj.length + 10);
  return near.includes(rule.verb) ? rule.verb + ' … ' + obj : null;
}

function detectRegress(imps) {
  const out = [];
  // 只拿 lesson 当规矩：pref 多是"说话方式"这类风格约定，套"违反"会误伤
  // 再加一道 looksLikeRule：被截断的技术长句不配当"你交代过的规矩"
  const rules = imps
    .filter(i => i.kind === 'lesson' && NEG.test(i.body) && looksLikeRule(i.body))
    .slice(0, 80);
  for (const L of rules) {
    const pats = rulesOf(L.body).filter(r => r.obj.length >= 2);
    if (!pats.length) continue;
    const later = imps.find(i => {
      if (i.id === L.id) return false;
      if (i.created < L.created + 6 * 3600) return false;
      if (ageDays(i.created) > 4) return false;
      if (sim(i.body, L.body) >= 0.45) return false;
      return pats.some(r => hitRule(r, i.body));
    });
    if (!later) continue;
    const hit = pats.map(r => hitRule(r, later.body)).find(Boolean);
    out.push({
      kind: 'regress', score: 0.9, id: 'r:' + L.id + ':' + later.id,
      why: `规矩「${humanize(L.body, 20)}」被踩到了（${hhmm(later.created)}）`,
      text: `你交代过「${humanize(L.body)}」，${hhmm(later.created)} 那条又碰到「${hit}」了——我记住了，下次绕开。`,
      refs: [L.id, later.id],
    });
    if (out.length >= 2) break;
  }
  return out;
}

function detectPromise(imps) {
  const out = [];
  for (const P of imps.filter(i => i.kind === 'promise').slice(0, 12)) {
    const age = ageDays(P.created);
    const after = imps.filter(i => i.created > P.created && i.created < P.created + 3 * DAY);
    const done = after.find(i => DONE.test(i.body) && sim(i.body, P.body) >= 0.12);
    if (done) {
      out.push({
        kind: 'done', score: 0.78, id: 'p:' + P.id, refs: [P.id, done.id],
        why: `答应的事之后出现了完成迹象`,
        text: `「${humanize(P.body)}」那件事，${hhmm(done.created)} 好像办完了？那我就不催了。`,
      });
    } else if (age >= 1 && age <= 14) {
      // 窗口原来是 1.5–6 天，太窄：库里 4 条承诺全天候卡在窗口外，这个检测器等于没装。
      // 现在 1 天起、14 天止，分数先升后降 —— 悬越久越该问，但超过一周开始衰减，
      // 两周还催就成了唠叨。
      const heat = age <= 7
        ? 0.62 + Math.min(0.2, age / 20)
        : Math.max(0.55, 0.82 - (age - 7) / 20);
      // 引文把关：body 是第三人称长摘要时宁可不引，别拿半句话去质问他
      const quotable = looksLikeRule(P.body) && String(P.body).length <= 60;
      out.push({
        kind: 'pend', score: heat, id: 'p:' + P.id, refs: [P.id],
        why: `答应了 ${Math.round(age * 24)} 小时还没动静`,
        text: quotable
          ? `「${humanize(P.body)}」这件，还悬着吗？`
          : '有件事你之前说过要办、后来一直没再提——还打算弄吗？',
      });
    }
  }
  return out;
}

/* 一整天没说话：唯一不依赖"新记忆"的信号。
   别的检测器都靠新料（新对话、新完成、新复发），你一整天没出现，它们就没话可说——
   昨天就是这样：程序在跑，但候选池里只有一条"七天前说过"的旧事，被去重规则挡了。
   规则很保守：当天一条记忆都没有、且现在处于 18–22 点，才轻问一句，每天最多一次。 */
function detectQuiet(imps, deps = {}) {
  const nowMs = deps.now ? deps.now() : Date.now();
  const d = new Date(nowMs);
  const hour = d.getHours();
  if (hour < 18 || hour >= 22) return [];
  const today0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
  const today = imps.filter((i) => Number(i.created || 0) >= today0);
  if (today.length) return [];
  const last = imps.slice().sort((a, b) => b.created - a.created)[0];
  const days = last ? Math.max(1, Math.round((nowMs / 1000 - last.created) / 86400)) : 1;
  return [{
    kind: 'quiet', score: 0.68, id: 'q:' + new Date(today0 * 1000).toISOString().slice(0, 10),
    refs: last ? [last.id] : [],
    why: `今天一句话都没聊，已经 ${days} 天没动静`,
    text: days >= 2
      ? `今天一整天没听见你说话，算上前面已经 ${days} 天了——是忙，还是那件事先搁下了？`
      : '今天一整天没听见你说话，我不吵你，就是想问一句：还顺利吗？',
  }];
}

/**
 * 隔夜回归 —— 这一条是「一定会开口」的那条。
 *
 * 前面几个检测器都在等「发生了什么」：被踩规矩、承诺到期、项目停摆。
 * 可绝大多数日子什么都没发生，于是它永远沉默 —— 沉默太多次，就不是"懂得闭嘴"，
 * 是这套东西根本没在工作。而人每天都会隔夜，这是唯一必然成立的信号。
 *
 * 刻意保守：
 *   · 只说「你昨天主要在弄 X」，这个事实由 project 字段直接支撑，不会说错
 *   · 不引正文 —— 库里绝大多数 body 是第三人称长摘要，引半句读起来就像串台
 *   · 隔夜 8 小时起、96 小时止；再久就该用 quiet 或 stall 了
 */
function detectResume(imps, deps = {}) {
  const nowMs = deps.now ? deps.now() : Date.now();
  if (!imps.length) return [];
  const newest = Math.max(...imps.map((i) => Number(i.created) || 0));
  const gapH = (nowMs / 1000 - newest) / 3600;
  // 上限原来卡 96 小时，实测第 5 天就彻底没话说了 —— 而"隔了五天"恰恰更该开口。
  // 放到 14 天；再往后就不该再翻这摊事，该由他自己决定还要不要它。
  if (gapH < 8 || gapH > 336) return [];

  // 只看「最后那一整段连续工作」：从最后一条往前 24 小时
  const band = imps.filter((i) => Number(i.created) >= newest - 86400
    && i.project && !NOT_A_PROJECT.test(String(i.project).trim()));
  if (band.length < 2) return [];

  const cnt = new Map();
  for (const i of band) cnt.set(i.project, (cnt.get(i.project) || 0) + 1);
  const top = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top) return [];
  const [proj, c] = top;
  const lastOne = band.filter((i) => i.project === proj)
    .sort((a, b) => b.created - a.created)[0] || {};

  const when = (() => {
    const d = new Date(newest * 1000);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  })();
  const days = gapH / 24;
  const lead = days < 1.5 ? '隔了一阵子没聊了。' : `有 ${Math.round(days)} 天没聊了。`;
  return [{
    kind: 'resume',
    // 隔得越久，这一句话的分量越重：总比沉默强，但也不至于盖过「规矩被踩」这种急事
    score: 0.66 + Math.min(0.12, c / 50) + Math.min(0.1, gapH / 200),
    id: 'rs:' + proj + ':' + new Date(newest * 1000).toISOString().slice(0, 10),
    refs: lastOne.id ? [lastOne.id] : [],
    why: `隔了 ${Math.round(gapH)} 小时没说话，${when} 主要在弄「${proj}」`,
    text: `${lead}${when} 你主要在弄「${proj}」${c >= 3 ? `，连着 ${c} 条都是那件事` : ''}——还接着弄吗，还是先放一放？`,
  }];
}

/**
 * 因果开口 —— 这条才是「因为…所以…」该有的样子。
 *
 * 前面几个检测器本质都是「有个信号 → 拼一句话」，中间没有推理。
 * 真正该走的流程是四步：
 *   ① 因：他当初说的那句话（causes.cause）
 *   ② 果：这句话当时定下的结论 / 规矩（causes.effect，pref 或 lesson）
 *   ③ 后来：这个结论又被提起过没有（次数越多，说明根子还活着）
 *   ④ 判断：有人还在提 = 前提没解决 → 才值得开口问一句
 *
 * 故意只认「果是 pref / lesson」的边：
 *   果是纯 fact 的多半是当时的事实陈述，拿它去问就变成复述历史，
 *   那正是他说"流程不对"的那种东西。
 * 没有"后来又被提起"这个证据就一律不说 —— 没变化就别打扰。
 */
function detectCause(db, imps) {
  const JUNK = /(你是|你在|资深|只读体检|严禁修改|输出格式|任务：|----)/;
  const okText = (s) => {
    const t = String(s || '').trim();
    return t.length >= 8 && t.length <= 80 && !JUNK.test(t) && looksLikeRule(t);
  };

  let rows = [];
  try {
    rows = db.prepare(`
      SELECT c.id, c.kind AS ck, c.certainty AS conf, c.last_seen AS seen,
             c.verified AS ver,
             a.id AS cid, a.body AS cbody, a.created AS cts,
             b.id AS eid, b.body AS ebody, b.kind AS ekind, b.created AS ets
      FROM causes c
      JOIN impressions a ON a.id = c.cause
      JOIN impressions b ON b.id = c.effect
      WHERE c.status = 'active' AND c.certainty >= 0.85
      ORDER BY c.last_seen DESC LIMIT 40`).all();
  } catch { return []; }

  const out = [];
  // 判"后来又提到"用共享实词，不用 Jaccard：
  // 中文长句的 Jaccard 0.3 等于要求一半词重叠，实测一条都过不了 —— 判据形同没装。
  // 现在只要有 2 个共同实词（除去停用词）就算在说同一件事。
  const keysOf = (s) => new Set([...grams(s)].filter((g) => g.length >= 2 && !STOP.has(g)));

  for (const r of rows) {
    if (!okText(r.cbody) || !okText(r.ebody)) continue;
    if (r.ekind !== 'pref' && r.ekind !== 'lesson') continue;

    // ③ 果定下之后，还有没有人在说同一件事
    const keys = new Set([...keysOf(r.cbody), ...keysOf(r.ebody)]);
    const hitsOf = (body) => {
      const gs = grams(body);
      let n = 0;
      for (const g of keys) if (gs.has(g)) n++;
      return n;
    };
    const later = imps.filter((i) => i.created > r.ets + 600
      && i.id !== r.eid && i.id !== r.cid
      && (hitsOf(i.body) >= 2 || sim(i.body, r.ebody) >= 0.3));
    if (!later.length) continue;   // ④ 没证据就别开口

    // ④' 判断：后来又提的，是在「重复同一条规矩」还是在「说相关但不同的事」？
    //     前者说明这条一直在被好好遵守 —— 拿去问"根子解决没"就是睁眼说瞎话
    //     （实测那句「因为我们用的是国内的网 → 装插件都要走镜像」就差点这么问出去）。
    //     只有后者的份量够：相关的事又冒出来了，才值得回头问一句前提。
    const sameWord = later.filter((i) => sim(i.body, r.ebody) >= 0.3).length;
    const related = later.length - sameWord;
    if (related < 2) continue;

    out.push({
      kind: 'cause',
      // verified=1 的边是核对过的，比自动抽的高一档
      score: 0.74 + Math.min(0.16, related * 0.06) + (r.ver ? 0.08 : 0),
      id: 'cz:' + r.id,
      refs: [r.cid, r.eid, ...later.slice(0, 2).map((i) => i.id)],
      why: `因果边（${r.ck}，确信 ${r.conf}${r.ver ? '，已核对' : ''}）之后，相关的事又冒出来 ${related} 次`,
      // 措辞要区分「我确认过」和「我推的」。
      // 核对过的就断言，没核对的必须承认是推断 —— 否则等于拿猜测当事实对他讲。
      // 再按「因能不能变」分两档问法：毛病问前提，环境只能问规矩还照不照。
      text: (() => {
        const fixable = /(太快|太慢|出错|报错|失败|退出|卡住|崩溃|不对|为什么|怎么|丢了|没了|不够)/.test(r.cbody);
        const a = humanize(r.cbody, 26);
        const b = humanize(r.ebody, 26);
        const tail = fixable ? '那个前提还成立吗' : '这条还按原来的来吗';
        return r.ver
          ? `因为「${a}」，才有「${b}」——这之后相关的事又冒出来 ${related} 次，${tail}？`
          : `因为「${a}」，所以「${b}」——这是我从你话里推的，你认吗？`;
      })(),
    });
    if (out.length >= 2) break;
  }
  return out;
}

/* 这些是「通道 / 载体」的名字，不是项目。拿它们算「断了多少小时」必然说错话：
   2026-11-14 实测它就说出过「微信 这边 194 小时没动静了」——那一刻人正在微信里打字。
   飞书那条通道更是早就按他的要求关掉了，拿关掉的通道去催人，是纯粹的胡说。
   宁可少说，也不能把「我们正在说话」说成「你很久没来了」。 */
const NOT_A_PROJECT = /^(微信|微信读书|飞书|飞书群|钉钉|qq|qq邮箱|邮箱|邮件|电报|telegram|terminal|终端|控制台|控制台服务|桌面|客户端|浏览器|手机|电脑|本机|局域网|dsh|dsh next|dsh-brain|brain|tan-brain)$/i;

function detectStall(imps) {
  const byProject = new Map();
  for (const i of imps) {
    if (!i.project) continue;
    const k = String(i.project).trim();
    if (!k || NOT_A_PROJECT.test(k)) continue;
    if (!byProject.has(k)) byProject.set(k, []);
    byProject.get(k).push(i);
  }
  const out = [];
  for (const [proj, list] of byProject) {
    if (list.length < 4) continue;
    list.sort((a, b) => b.created - a.created);
    const last = list[0];
    const gap = ageDays(last.created);
    if (gap < 1.5 || gap > 12) continue;
    const openEnded = list.slice(0, 3).find(i => FUTURE.test(i.body));
    // 引用哪一条：只认「开头就点名这个项目、而且整句很短」的那种。
    // 库里多数 body 是压缩后的第三人称摘要，顺带提一嘴项目名 ≠ 在说这个项目——
    // 之前只判 includes(proj)，飞书那条引到的是「重启后要给他发回执」的规矩，
    // 地名对、内容不对，读起来像串台。长句一律不引。
    // 一条都不符合就干脆不引正文，只说多久没动静。
    const brief = list.slice(0, 5).find((i) => {
      const b = String(i.body || '');
      return b.length <= 34 && b.includes(proj) && b.indexOf(proj) <= 6;
    });
    const tail = brief ? `，最后一次是「${humanize(brief.body, 30)}」` : '';
    out.push({
      kind: 'stall', score: (openEnded ? 0.72 : 0.6) + Math.min(0.1, gap / 40),
      id: 's:' + proj, refs: [last.id],
      why: `${proj} 断了 ${Math.round(gap * 24)} 小时${openEnded ? '，且停在半句' : ''}`,
      text: `${proj} 这边 ${Math.round(gap * 24)} 小时没动静了${openEnded ? '，最后一条还停在半句' : ''}${tail}——是搁下了，还是等你下次开机？`,
    });
  }
  return out;
}

/* 这些词天天出现，但不是「卡住的点」，拿它们当复发线索只会变成噪音 */
const RECUR_NOISE = new Set([
  // 原表
  '重启', '程序', '检查', '电脑', '帮我', '看看', '然后', '现在', '这个', '那个', '查一', '一下', '咱们', '我们', '一个', '就是',
  // 下面这批全是他亲手判过 bad 的：「重启是不是卡住的点」被打了 0.88 的坏分，
  // 但表里没有「重启」以外的同类词，换个词一模一样再犯一次。宁可多屏蔽。
  '下载', '主动', '安装', '装好', '装上', '弄好', '改好', '接着', '继续', '开始',
  '看看这个', '东西', '问题', '时候', '知道', '觉得', '应该', '可能', '能不能',
  // 泛化虚词：几乎每句都有，当复发线索等于随机开口
  '可以', '需要', '要不', '是不是', '什么', '怎么', '这样', '这些', '那些', '还有', '已经',
  // 「环境自己的名字」：dsh / 微信 / 飞书 这些是容器不是内容。
  // 2026-11-14 实测它张口就是「「dsh」这几天你提了好几次——它是不是才是卡住你的点」，
  // 而我们每句话都在 dsh 里说的，这种问题没有答案。
  'dsh', 'dsh next', '微信', '飞书', '记忆', '插件', '会话', '上下文', '模型',
]);

function detectRecur(imps) {
  const recent = imps.slice(0, 10);
  if (recent.length < 6) return [];
  const count = new Map();
  for (const i of recent) for (const g of grams(i.body)) count.set(g, (count.get(g) || 0) + 1);
  const top = [...count.entries()]
    // 只认中文词。英文/标识符（wechat、dsh、token…）在我们这儿是环境名和技术词，
    // 每天出现几十次，拿去问「它是不是才是卡住你的点」纯属废话。
    // 2026-11-14 实测它就张口问过「「wechat」这几天你提了好几次」。
    .filter(([g, c]) => c >= 3 && g.length >= 2 && !STOP.has(g) && !RECUR_NOISE.has(g)
      && /[\u4e00-\u9fa5]/.test(g))
    .sort((a, b) => b[1] - a[1])[0];
  if (!top) return [];
  const [word, c] = top;
  const hit = recent.filter(i => i.body.includes(word));
  if (hit.length < 3) return [];
  return [{
    kind: 'recur', score: 0.58 + Math.min(0.08, c / 60), id: 'c:' + word, refs: hit.slice(0, 3).map(i => i.id),
    why: `「${word}」最近 ${c} 次浮上来`,
    text: `「${word}」这几天你提了好几次——它是不是才是现在真正卡住的点？`,
  }];
}

/* ---------- 补充：一句话推翻了另一句话（只认具体宾语，宁缺勿滥） ---------- */
function detectReversal(imps) {
  const out = [];
  const pool = imps.filter(i => (i.kind === 'pref' || i.kind === 'fact')).slice(0, 200);
  const df = new Map();
  for (const i of pool) for (const r of rulesOf(i.body)) df.set(r.obj, (df.get(r.obj) || 0) + 1);
  for (const L of pool) {
    if (polarity(L.body) >= 0) continue;
    const pats = rulesOf(L.body)
      .filter(r => r.obj.length >= 3 && /^[a-zA-Z][a-zA-Z0-9_.-]+$/.test(r.obj))
      .filter(r => (df.get(r.obj) || 0) <= 3);          // 到处都有的词不配当主题
    if (!pats.length) continue;
    const other = pool.find(i => {
      if (i.id === L.id) return false;
      if (Math.abs(i.created - L.created) < 6 * 3600) return false;
      if (polarity(i.body) < 0) return false;
      return pats.some(r => hitRule(r, i.body));
    });
    if (!other) continue;
    const [oldOne, newOne] = L.created <= other.created ? [L, other] : [other, L];
    out.push({
      kind: 'reversal', score: 0.86, id: 'v:' + oldOne.id + ':' + newOne.id,
      why: `同一个东西两样说法（${hhmm(oldOne.created)} vs ${hhmm(newOne.created)}）`,
      text: `「${humanize(oldOne.body)}」和后来的「${humanize(newOne.body)}」对不上，我按后一个来？`,
      refs: [oldOne.id, newOne.id],
    });
    if (out.length >= 2) break;
  }
  return out;
}

/* ---------- 对外：想一遍，给结论 ---------- */
export const __debug = { grams, sim, overlap, polarity, rulesOf, hitRule, commonRun };

export function think(db, { recentLimit = 400, now: nowFn = null } = {}) {
  const deps = { now: nowFn || undefined };
  let imps = [];
  try {
    // who 必须查出来：下面「这条依据的事件到底是谁的事」那段读的就是 r.who，
    // 之前 SELECT 里没有它，r.who 永远是 undefined，那套判据形同虚设。
    imps = db.prepare(`SELECT id, created, kind, body, project, status, who
        FROM impressions WHERE status='active'
        ORDER BY created DESC LIMIT ?`).all(recentLimit);
  } catch { return { pick: null, signals: [], reason: '读库失败' }; }

  const signalsRaw = [
    // ...detectContradiction(imps),  ← 暂不启用：真库误报率高，等接语义模型再开
    // ...detectReversal(imps),  ← 同样暂不启用：真实语料里仍会撞出无关配对
    ...detectRegress(imps),
    ...detectResume(imps, deps),
    ...detectCause(db, imps),
    ...detectPromise(imps),
    ...detectQuiet(imps, deps),
    ...detectStall(imps),
    // ...detectRecur(imps),  ← 2026-11-14 停用。
    // 它连着三次开口全是废话：「重启是不是卡住的点」「「dsh」这几天你提了好几次」
    // 「「通道」这几天你提了好几次」。它不是推理，是词频；而高频词在我们这儿
    // 永远是环境名（dsh / 微信 / 通道 / 记忆 / 插件）。补词表只是追着跑，换个词又冒出来。
    // 真要放回来，得先有分得出「他真正在乎的实词」的语义模型。
  ].filter(s => s && s.text);

  // 刚聊过，就别问「你怎么不说话了」。
  // stall / quiet 的全部内容都是「有一阵子没动静」，只要最近三小时内还有新记忆，
  // 这句话必然是错的 —— 2026-11-14 实测它差点在微信里说出「微信这边 194 小时没动静」，
  // 而那时候人正在微信里打字。宁可晚三小时说，也不能说错。
  const newestAt = imps.length ? Math.max(...imps.map((i) => Number(i.created) || 0)) : 0;
  const talkedHoursAgo = newestAt
    ? ((nowFn ? nowFn() : Date.now()) - newestAt * 1000) / 3600000
    : 999;
  const signals = signalsRaw.filter((s) => {
    if (s.kind !== 'stall' && s.kind !== 'quiet') return true;
    return talkedHoursAgo >= 3;
  });

  if (!signals.length) {
    return {
      pick: null, signals: [], signalsRaw,
      reason: signalsRaw.length
        ? `刚聊过（${talkedHoursAgo.toFixed(1)} 小时前还有新记忆），这会儿不催`
        : '没什么值得说的',
    };
  }

  // 新鲜度衰减：信号涉及的记忆越旧越不值钱；矛盾/复发/沉默类不看新旧
  // stall 必须一起跳过——它的全部内容就是「这东西已经很久没动了」，
  // 拿新鲜度去罚它等于自我否定：越沉默分越低，越低越开不了口，
  // 于是飞书断了 147 小时、微信断了 193 小时这种事永远说不出来。
  // 2026-11-14 又漏了三个同类：pend、resume，以及 cause。
  //   pend：一条 8.5 天前的承诺本该得 0.745，被按 refs 的新鲜度扣到 0.48 —— 直接埋在门槛下。
  //         可"答应的事还没办"这件事，恰恰是越老越该问，拿新旧去罚它是自相矛盾。
  //   resume：它整句话就是「隔了挺久」，按新鲜度罚等于自己取消自己。
  //   cause：「因为国内的网，所以装插件走镜像」这种是环境前提，不会随时间失效；
  //         他自己确认过的边反而被压到 0.517（门槛 0.55），一个字都说不出来。
  //         因果要说的是「这条还成不成立」，不是「它太老了」。
  const NO_DECAY = new Set(['contradict', 'regress', 'quiet', 'stall', 'pend', 'resume', 'cause']);
  for (const s of signals) {
    if (NO_DECAY.has(s.kind)) continue;
    const refs = imps.filter(i => (s.refs || []).includes(i.id));
    const newest = refs.length ? Math.max(...refs.map(r => r.created)) : 0;
    s.score *= 1 - Math.min(0.35, ageDays(newest) / 12);
  }

  // ① 同一类信号今天已经说过一次，就压一半——防止它翻来覆去念同一条
  try {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const rows = db.prepare('SELECT kind, COUNT(*) c FROM feedback WHERE ts >= ? GROUP BY kind').all(d.getTime() / 1000);
    const spokeToday = new Map(rows.map((r) => [r.kind, r.c]));
    for (const s of signals) {
      if ((spokeToday.get(s.kind) || 0) >= 1) s.score *= 0.5;
    }
  } catch { /* 反馈表读不到就不压 */ }

  // ② 复发类只认"最近三天内"的新踩点：隔了几天的旧事再念一遍没有意义
  for (const s of signals) {
    if (s.kind !== 'regress') continue;
    const refs = imps.filter((i) => (s.refs || []).includes(i.id));
    const newest = refs.length ? Math.max(...refs.map((r) => r.created)) : 0;
    if (newest && ageDays(newest) > 3) s.score *= 0.35;
  }

  // 按历史成绩调权：老被否的那类信号自己降级，认过的加分
  for (const s of signals) {
    try { s.score *= weightOf(db, s.kind); } catch { /* 权重读不到就用原分 */ }
  }

  // ③ 准入：这条依据的事件，到底是谁的事？
  // 借 dsh-superagent 的准入表思路：不是"有信号就开口"，而是先看证据是谁的。
  //   他的话（pref / identity / promise，或正文以"他说/他要求/他让我"开头）→ 满分
  //   只是我自己的活（fact / method / lesson 里我自己写的）→ 打七折
  // 复发类（recur）要求更高：只有落在他自己说过的事上才允许开口，
  // 否则就是把我的工作日志当成"你反复提的事"来质问他——上一版那句
  // "重启是不是卡住的点"就是这么来的。
  const HIS_START = /^(他说|他要|他想|他让|他要求|他问|他觉|他不|他更|他喜|他希|他需)/;
  const MINE_START = /^(我|我把|我用|我改|我加|我写|我算|我查|我跑|我装|我推|我发现|我验)/;
  for (const s of signals) {
    const refs = imps.filter((i) => (s.refs || []).includes(i.id));
    const hisShare = refs.length
      ? refs.filter((r) => {
        // ① 新数据：写库时已经标好 who，直接信，不要再猜
        if (r.who === 'his') return true;
        if (r.who === 'mine') return false;
        // ② 老数据（who 为 NULL）才退回推断
        if (['pref', 'identity', 'promise'].includes(r.kind)) return true;
        if (MINE_START.test(String(r.body || ''))) return false;
        // ③ 剩下的默认「他说的」。库里 99% 是他的话，默认 mine 才是系统性错误——
        //    实测 427 条里只有 4 条被认成 his，连「和我说话语气可爱一点」都被判成我的活。
        return true;
      }).length / refs.length
      : 0;
    // quiet 这类信号本质在说他，不该按证据来源判成我自己的事
    s.admission = (s.kind === 'quiet' || hisShare >= 0.5) ? 'his' : 'mine';
    // 原来这里还有一刀 s.score *= 0.7。门槛已经是 0.55 / 0.66 两档，
    // 再乘 0.7 等于同一件事罚两遍：误判成 mine 的记忆叠上 recur 的 ×0.6，
    // 最强信号被压到 0.45，永远撞不上门槛。身份判定已经修了，这一刀就不该留。
  }

  // 复发类：落在他自己说过的事上照常开口；只是我自己的活也留一口气（×0.6），
  // 但门槛对"我的事"本来就更高，所以要复现得够密才说得上话。
  // （2026-11-07 他选了"松"：宁可偶尔多问一句，也别永远不开口）
  for (const s of signals) {
    if (s.kind === 'recur' && s.admission !== 'his') s.score *= 0.6;
  }

  signals.sort((a, b) => b.score - a.score);
  const top = signals[0];
  if (!top) return { pick: null, signals, reason: '准入之后没有能开口的了' };
  const floor = top.admission === 'his' ? 0.55 : 0.66;   // 「松」：他自己的事 0.72 → 0.66
  if (top.score < floor) {
    return { pick: null, signals, reason: `最强信号只有 ${top.score.toFixed(2)}（${top.admission === 'his' ? '他的话' : '我自己的事'}，门槛 ${floor}），不值得打扰` };
  }
  return { pick: top, signals, reason: `选了 ${top.kind}（${top.score.toFixed(2)}，${top.admission === 'his' ? '他说过的' : '我自己的事'}）` };
}

/* ---------- 说过就记住：同一条 7 天内不再提 ---------- */
const SAID_KEY = 'think_said';

function loadSaid(db) {
  try {
    const row = db.prepare("SELECT v FROM meta WHERE k=?").get(SAID_KEY);
    const o = row ? JSON.parse(row.v) : null;
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

export function recentlySaid(db, id, days = 7) {
  const said = loadSaid(db);
  const ts = Number(said[id] || 0);
  return ts > 0 && (Date.now() / 1000 - ts) < days * DAY;
}

export function rememberSaid(db, id) {
  try {
    const said = loadSaid(db);
    const now = Date.now() / 1000;
    for (const k of Object.keys(said)) if (now - Number(said[k] || 0) > 30 * DAY) delete said[k];
    said[id] = now;
    db.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
      .run(SAID_KEY, JSON.stringify(said));
  } catch {}
}

export function inQuietHours(now = new Date()) {
  const h = now.getHours();
  return h >= 23 || h < 8;
}

/* ---------- 可选润色：有 llm 就用它改口吻，改了也还是这句话 ---------- */
export async function polish(text, llm, logger) {
  if (!llm || typeof llm.stream !== 'function') return text;
  try {
    const chunks = [];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12000);
    let route = {};
    if (typeof llm.resolveCallConfig === 'function') {
      try { route = (await llm.resolveCallConfig({})) || {}; } catch {}
    }
    const stream = llm.stream({
      ...(route.provider ? { provider: route.provider } : {}),
      ...(route.model ? { model: route.model } : {}),
      system: '把这句话改得更自然一点，只说这一句，不要解释、不要加引号、不要称呼。保持原意和事实。',
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      maxTokens: 120,
      signal: ac.signal,
    });
    for await (const c of stream) {
      const t = c?.delta?.text ?? c?.text ?? (c?.type === 'text-delta' ? c.text : '');
      if (typeof t === 'string') chunks.push(t);
    }
    clearTimeout(timer);
    const out = chunks.join('').trim().replace(/^["「『]|["」』]$/g, '');
    if (out.length >= 4 && out.length <= 120 && !/\n/.test(out)) return out;
    return text;
  } catch (e) {
    logger?.warn?.(`[brain] 润色跳过：${e && e.message}`);
    return text;
  }
}
