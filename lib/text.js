/**
 * text.js —— 分词、相似度、分类
 *
 * 全是纯函数，不碰数据库，方便单独测。
 *
 * 分词策略（这是全部检索质量的地基）：
 *   中文连续段切二元组，单字丢弃（信息量太低）
 *   英文、数字、路径、标识符整段保留
 *   不引第三方分词库——中文二元组在短查询上表现足够好，且零依赖
 */

/**
 * 切成可比对的碎片
 *
 * 路径必须两头都要：整串一个 token（查「那个路径」时命中），
 * 每一段也各是一个 token（查「write.js」时也能命中）。
 * 老写法只有一个整串，导致 sim('write.js', 完整路径) = 0.000 ——
 * 换句话说「查 write.js 那条记忆」永远召不回含路径的那条。
 */
export function tokens(s) {
  const text = String(s || '').toLowerCase();
  const out = new Set();
  // ① 盘符路径：整串 + 拆段
  for (const p of text.match(/[a-z]:[\\/][^\s'"`，。；、）)]*/g) || []) {
    out.add(p);
    for (const seg of p.split(/[\\/]+/)) if (seg.length >= 2) out.add(seg);
  }
  // ② 英文词、数字、相对路径、点号标识符、连字符
  for (const w of text.match(/[a-z0-9_./\\-]{2,}/g) || []) out.add(w);
  // ③ 中文二元组
  for (const seg of text.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (seg.length < 2) continue;
    for (let i = 0; i < seg.length - 1; i += 1) out.add(seg.slice(i, i + 2));
  }
  return out;
}

/** Dice 系数，0~1 */
export function sim(a, b) {
  const A = typeof a === 'string' ? tokens(a) : a;
  const B = typeof b === 'string' ? tokens(b) : b;
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit += 1;
  return (2 * hit) / (A.size + B.size);
}

/** 查询覆盖率：短查询命中一两个词就该算高，用覆盖率不用绝对数 */
export function coverage(queryTokens, docTokens) {
  if (!queryTokens.size || !docTokens.size) return 0;
  let hit = 0;
  for (const t of queryTokens) if (docTokens.has(t)) hit += 1;
  return hit / queryTokens.size;
}

/* ---------------- 过程叙述判定 ---------------- */

// 完成义动词：只描述「我做完了」，不携带可复用信息
const DONE_VERBS = /(修好|改好|弄好|搞定|做完|完成了|已推送|推上去|跑通|通过|已安装|装好|构建成功|测试通过|已生成|已删除|已备份)/;
// 具体对象：路径、数字、版本、端口、标识符——有这些就不算纯过程话
const CONCRETE = /([A-Za-z]:[\\/]|\d+\.\d+|\b\d{2,}\b|localhost|127\.0\.0\.1|https?:\/\/|\b[a-z_]+\.(js|py|json|md|db)\b)/i;

/**
 * 判「这句话是不是只说了一句我做完了」。
 *
 * 曾经这里是 `if (t.length < 6) return true;`，拿字数当判据。
 * 结果「别改他的名」「以后先备份」这种最该记住的规矩因为短被当垃圾丢了 ——
 * 短不等于没信息，只有「有完成动词 + 没有具体对象」才是纯过程话。
 */
export function isProcessNarrative(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (DONE_VERBS.test(t) && !CONCRETE.test(t)) return true;
  // 纯符号/纯表情
  if (/^[\s\p{P}\p{Emoji}]+$/u.test(t)) return true;
  return false;
}

/* ---------------- 分类 ---------------- */

const RE_PREF = /(别|不要|不用|以后都?|以后先|我喜欢|我讨厌|少来|别再|不要再|请用|尽量)/;
const RE_LESSON = /(原来|坑在于|教训|记住|以后先|问题出在|根因|是因为|别再犯|下次注意)/;
const RE_METHOD = /(第一步|第二步|先.{1,12}再|流程是|步骤|检查|排查|做法是|办法是)/;
const RE_FACT = /([A-Za-z]:[\\/]|\d+\.\d+|端口|version|配置|账号|密码|密钥|地址|目录|路径|装了|安装|默认)/;
const RE_PROMISE = /(明天|后天|下周|晚点|回头|稍后|记得|提醒我|到时候|待会)/;

// 教训的「强证据」：含这些才算真教训
const RE_LESSON_STRONG = /(原来|坑在于|教训|根因|问题出在|是因为|别再犯|下次注意|不生效|空转)/;

/**
 * 判定这条属于哪一类。判不出来的返回 null —— 宁可漏，不可滥。
 * @param {string} text
 * @param {'user'|'assistant'} role
 */
export function classify(text, role = 'user') {
  const t = String(text || '').trim();
  if (!t || t.length < 4) return null;
  if (isProcessNarrative(t) && role === 'assistant') return null;

  // 我自己说的话，默认不算记忆。
  // 原因：我讲的是「我的行为/我的解释」，不是关于世界的事实——
  // 之前把整段汇报记成 fact，结果注入里全是「404 已修好」这类东西。
  // 唯一例外：明确带教训/根因的结论句。
  if (role === 'assistant') {
    if (t.length < 20) return null;
    if (/^(好|行|收到|明白|嗯|对|可以|记下|记住|好的|好呀|嘿嘿)/.test(t)) return null;
    if (RE_LESSON_STRONG.test(t) && t.length <= 260) return 'lesson';
    return null;
  }

  // 用户说的「别/不要」才是偏好
  if (RE_PREF.test(t)) {
    if (RE_LESSON_STRONG.test(t)) return 'lesson';
    return 'pref';
  }
  // 「和我说话的语气可爱一些」这类要求：没有「别」也没有「以后」，但明显是偏好
  if (/(说话|语气|回答|回复|风格|称呼|叫我|别叫|可爱|正式|生硬)/.test(t)) return 'pref';
  if (RE_LESSON_STRONG.test(t)) return 'lesson';
  // 身份类：名字、称呼、住哪——这类信息永远不该被当成过程话丢掉
  if (/(我叫|我姓|我的名字|本人叫|叫我)/.test(t) && t.length <= 60) return 'fact';
  if (RE_METHOD.test(t)) return 'method';
  if (RE_PROMISE.test(t) && !RE_FACT.test(t)) return 'promise';
  if (RE_FACT.test(t) && CONCRETE.test(t)) return 'fact';
  return null;
}
/* ---------------- 因果标记识别 ---------------- */

// 强标记：出现即可建直接因果
const CAUSE_MARK = /(因为|所以|导致|造成|结果是|原来是|根因|原因是?是?|由于|因此|所以才|问题出在|坑在于|关键在于)/;
// 目的/手段
const PURPOSE_MARK = /(是为了|为的是|目的在|想通过|用.{1,12}来|改成.{1,20}这样|这样就不用)/;
// 条件
const COND_MARK = /(如果不|要是没|没有.{1,12}就|只要.{1,12}就|必须先|才能)/;
// 反事实
const COUNTER_MARK = /(要不是|如果没有|否则就|本来会)/;

/**
 * 从一段话里判断因果类型。返回 {kind, mark} 或 null。
 * 只认标记词，不做统计推断——猜出来的因果是最坏的一类污染。
 */
export function causeKind(text) {
  const t = String(text || '');
  if (COUNTER_MARK.test(t)) return { kind: 'counterfactual', mark: t.match(COUNTER_MARK)[0] };
  if (PURPOSE_MARK.test(t)) return { kind: 'purpose', mark: t.match(PURPOSE_MARK)[0] };
  if (COND_MARK.test(t)) return { kind: 'condition', mark: t.match(COND_MARK)[0] };
  if (CAUSE_MARK.test(t)) {
    const mark = t.match(CAUSE_MARK)[0];
    const kind = /(根因|原因|问题出在|坑在于|关键在于)/.test(mark) ? 'pathological' : 'direct';
    return { kind, mark };
  }
  return null;
}

/**
 * 把「A 因为 B」拆成 {effect: A, cause: B, kind}。
 * 拆不开返回 null。
 *
 * 为什么要拆：一句话里其实有两条记忆——「出了什么事」和「为什么」。
 * 合成一条，以后问「为什么」和问「什么事」都只能命中一半。
 */
const SPLIT_MARKS = ['因为', '由于', '原因是', '根因是', '问题出在', '导致', '所以'];

export function splitCause(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 12) return null;
  const ck = causeKind(t);
  if (!ck) return null;
  for (const mark of SPLIT_MARKS) {
    const i = t.indexOf(mark);
    if (i < 0) continue;
    const isBackward = mark === '所以' || mark === '导致';
    const left = t.slice(0, i).replace(/[，,。；;\s]+$/, '').trim();
    const right = t.slice(i + mark.length).replace(/^[，,。；;\s]+/, '').trim();
    if (left.length < 3 || right.length < 3) continue;   // 中文短句很常见，6 字门槛太高，拆分几乎从不触发
    return isBackward
      ? { cause: left, effect: right, kind: ck.kind, mark }
      : { effect: left, cause: right, kind: ck.kind, mark };
  }
  return null;
}

/* ---------------- 项目推断 ---------------- */

const PROJECT_HINTS = [
  // 顺序有意义：越具体的越靠前，先命中先返回。
  // 2026-11-14 加强过一轮：全库拆解后条目变成 30 字上下的短句，
  // 老规则只认项目名全称，推不出来 —— 结果 1024 条里只有 227 条有 project，
  // 而主动对话的「停滞/久未联系/安静」全依赖这个字段，等于集体失明。
  // 这里是通用示例。你自己的项目请改这一行（或加几行）：
  // 左边是项目名，右边是能把它认出来的关键词。
  { name: '示例项目', re: /(库存|件数|按斤|按件|档口|货物|分拣|进货|卖货)/i },
  { name: '记忆系统', re: /(记忆系统|tan-brain|brain\.db|印象库|唤起|遗忘|dsh-brain|检索|召回|因果|拆分|向量|bonds|神经元|嵌入|突触)/i },
  { name: '飞书', re: /(飞书|feishu)/i },
  { name: '微信', re: /(微信|weixin|wechat|iLink|公众号)/i },
  { name: 'DSH', re: /(\bdsh\b|deepseek-harness|插件市场|cordis|热加载|profile|bundle|工具注册)/i },
];

export function projectOf(text) {
  const t = String(text || '');
  for (const h of PROJECT_HINTS) if (h.re.test(t)) return h.name;
  return '';
}

/* ---------------- 截断 ---------------- */

/** 句末截断，尽量不切句子中间 */
export function clip(text, limit = 200) {
  const t = String(text || '').trim();
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit);
  for (const m of ['。', '！', '？', '；', '\n', '. ']) {
    const i = cut.lastIndexOf(m);
    if (i > limit * 0.5) return cut.slice(0, i + 1).trim();
  }
  return cut.trim() + '…';
}

/* ---------------- 分句 ---------------- */

/**
 * 把一段话切成可独立入库的小句。
 *
 * 为什么需要：一句话里常常塞着两三条不同的记忆。之前整段入库，结果
 * 「不要改我的工具 你只需要记住我叫某人」被当成一条，判规矩的时候
 * 后半句就被当成了"踩规矩"的证据——脏数据是检索和推理最大的敌人。
 *
 * 保守策略：只在标点或明确的转折/人称切换处切，切完每段 ≥6 字才留，
 * 最多 3 段——宁可漏切，不可切碎。
 */
const CUT_MARKS = [
  '你只需要', '你只要', '你记得', '以后', '另外', '顺便', '还有',
  '我叫', '我只要', '我想要', '我觉得', '说实话', '总之', '最后',
];

export function splitSentences(text, { max = 3, minLen = 4 } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const pieces = raw
    .replace(/[\r\n]+/g, '\u0001')
    .split(/[。！？!?；;\u0001]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  // 按转折/人称标记切。
  // 老版本是 `if (piece.length <= 24) 不切`，用字数当判据 ——
  // 「不要改我的工具 你只需要记住我叫某人」22 字，正好整段入库，
  // 结果前半句的「不要改」和后半句的「记住名字」被绑成一条，
  // 判规矩时互相污染。现在只看有没有切分标记，不看长短。
  const finer = [];
  for (const piece of pieces) {
    let rest = piece;
    const parts = [];
    for (const mk of CUT_MARKS) {
      const i = rest.indexOf(mk);
      if (i >= minLen && rest.length - i >= minLen) {
        parts.push(rest.slice(0, i).trim());
        rest = rest.slice(i).trim();
      }
    }
    parts.push(rest);
    finer.push(...parts.filter((x) => x.length >= minLen));
  }

  // 还是过长的，按逗号补切一刀
  const out = [];
  for (const t of finer) {
    if (t.length > 60 && out.length + 1 < max) {
      const cl = t.split(/[，,]/).map((x) => x.trim()).filter((x) => x.length >= minLen);
      if (cl.length > 1) { out.push(...cl); continue; }
    }
    out.push(t.replace(/^[，,、\s]+/, '').replace(/[，,、\s]+$/, ''));
  }
  return out.filter((x) => x.length >= minLen).slice(0, max);
}
