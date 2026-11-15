/**
 * inject.js —— 注入四块
 *
 *   ① 现在     goal / 已定 / 卡在 / 下一步    —— 永不裁剪
 *   ② 我记得   混合唤起的印象（带确信度的限定词）
 *   ③ 我打算这么说  性格样本原文
 *   ④ 我觉得该提一句 主动消息（成本算过才说）
 *
 * 总预算 1800 字；超了从②尾部整条砍，不截半句。
 */
import { getFocus } from './db.js';
import { blockDigests } from './digest.js';
import { selfLine } from './self.js';
import { activate, fitBudget, touchPicks } from './recall.js';
import { init as embedInit, encode } from './embed.js';

const BUDGET_TOTAL = 1800;
const BUDGET_NOW = 260;
const BUDGET_VOICE = 320;
const BUDGET_PROACTIVE = 300;

/** trace 表保留的最大行数：它只是诊断日志，超过这个数就从最老的开始删 */
const TRACE_KEEP = 5000;

/* ---------------- 模型重排 ----------------
 * 为什么还要这一层：向量 + 词法能判断「像不像同一个话题」，判断不了
 * 「这条是不是在回答这个问题」。实测问「B 站高清怎么下」，排第一的是
 * 「视频能力已配齐」—— 话题对，答案不对；问「关系什么时候建立」，
 * 返回的是统计数字。这类错只能靠「回头看一遍」纠正。
 *
 * cross-encoder 专干这个，但要再挂一个 280MB 的模型、每轮多一次重前向；
 * 这里复用已经接上的模型，一次很短的调用（约 1 秒）就够。
 * 没接上模型 / 超时 / 解析失败，一律退回原序 —— 重排只改顺序，不能挡召回。
 */
let llmRef = null;
export function bindLlm(l) { llmRef = l; }

async function rerankByModel(query, picks) {
  const llm = llmRef;
  if (!llm || typeof llm.stream !== 'function') return picks;
  if (!query || picks.length < 4) return picks;
  /* 只看前 5 条：原来给 8 条，实测重排会把原本第 4、5 位的正确答案
   * 挤到更后面 —— 模型判断"这条是不是在回答问题"时，对知识型问题的
   * 把握不如规则层稳定。范围收窄，它的作用就只剩「把最对的那条提上来」。
   */
  const top = picks.slice(0, 5);
  const list = top.map((p, i) => `${i + 1}. ${String(p.m && p.m.body || '').slice(0, 80).replace(/\n+/g, ' ')}`).join('\n');
  /* 只问一件事：这几条里，哪一条最能直接回答这个问题。
   * 原来让它排序，它会顺手把「聊过这个话题」的也列进来，把正确答案挤下去；
   * 单选比排序稳得多，而且最坏情况只是「提错一条」，不会打乱整段顺序。
   */
  const system = '下面是一个问题，和若干条记忆。只输出一个数字：最能直接回答这个问题的记忆编号。'
    + '如果没有任何一条能回答，输出 0。不要输出别的内容。';
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch {} }, 2500);
  let text = '';
  try {
    let route = {};
    if (typeof llm.resolveCallConfig === 'function') {
      route = (await llm.resolveCallConfig({ provider: 'deepseek-account', model: 'deepseek-flash' })) || {};
    }
    const stream = llm.stream({
      ...route,
      provider: route.provider || 'deepseek-account',
      model: route.model || 'deepseek-flash',
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: `问题：${query}\n\n${list}` }] }],
      maxTokens: 160,
      reasoningEffort: 'low',
      signal: ac.signal,
    });
    for await (const c of stream) {
      const t = c && c.type ? String(c.type) : '';
      if (t === 'text-delta' || t === 'text') {
        const v = c.text != null ? c.text : (c.delta && c.delta.text);
        if (typeof v === 'string') text += v;
      }
    }
  } catch { return picks; } finally { clearTimeout(timer); }

  // 解析：只认一个数字。0 / 解析不出 / 越界，都当「没有更优的」，保持原序
  const m = String(text).match(/\d+/);
  if (!m) return picks;
  const best = Number(m[0]) - 1;
  if (!Number.isInteger(best) || best < 0 || best >= top.length) return picks;
  const item = top[best];
  if (!item) return picks;
  return [item, ...picks.filter((p) => p !== item)];
}

/** 确信度 → 说话方式。这是「带限定词」的落地。 */
export function hedging(certainty, body) {
  const c = Number(certainty) || 0.8;
  if (c >= 0.85) return body;
  if (c >= 0.6) return `我记得${body}（你确认下）`;
  if (c >= 0.35) return `好像是${body}，不太确定`;
  return '';   // 低于 0.35 不说
}

/**
 * 最近几轮注入过的 id —— 防止同一条记忆每轮都往脑子里塞。
 * 只记 id，不记内容；超过窗口自动淘汰。这不是永久遗忘，只是「刚说过先别再说」。
 */
const RECENT_WINDOW = 6;          // 记住最近 6 轮
const recentInjected = [];        // 每项是一组 id

function markInjected(ids) {
  const arr = Array.from(ids).filter(Boolean);
  if (!arr.length) return;
  recentInjected.unshift(new Set(arr));
  if (recentInjected.length > RECENT_WINDOW) recentInjected.pop();
}

function recentlyInjected(id) {
  for (const set of recentInjected) if (set.has(id)) return true;
  return false;
}

function blockNow(db, focus) {
  const lines = [];
  // 时间锚：这套记忆里「今天」「刚才」「昨晚」一直是悬空的词 ——
  // 系统不知道现在几点、今天几号、上次聊完过了多久。
  try {
    const d = new Date();
    const wk = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}（周${wk}）`;
    let gap = '';
    const lastEv = db.prepare('SELECT MAX(ts) AS t FROM events').get();
    if (lastEv && lastEv.t) {
      const mins = Math.max(0, Math.round((Date.now() / 1000 - Number(lastEv.t)) / 60));
      if (mins >= 1) {
        gap = mins < 60 ? `，距上一句对话 ${mins} 分钟` : `，距上一句对话 ${Math.round(mins / 60)} 小时`;
      }
    }
    if (d.getHours() >= 23 || d.getHours() < 6) gap += '，已经很晚了';
    lines.push(`现在 ${stamp}${gap}`);
  } catch { /* 时间锚失败不影响别的 */ }
  if (focus.goal) lines.push(`目标：${focus.goal}`);
  if (focus.confirmed && focus.confirmed.length) {
    lines.push(`已定：${focus.confirmed.slice(0, 6).join(' / ')}`);
  }
  if (focus.blockers && focus.blockers.length) {
    lines.push(`卡在：${focus.blockers.slice(0, 3).join(' / ')}`);
  }
  if (focus.next) lines.push(`下一步：${focus.next}`);
  if (!lines.length) {
    // focus 表从来没人写过：setFocus 全仓库只有 scripts/smoke.mjs 调过一次，
    // 生产路径零调用，于是「## 现在」这块永远是空的 —— 不报错，但等于没有。
    // 退一步：用最近的场景 + 最近一句真正记下来的话，拼一个临时现状。
    // 这不是长久的办法，真正该做的是让上层的「目标 / 卡点」有地方可写。
    try {
      const sc = db.prepare(
        'SELECT title, goal, project FROM scenes ORDER BY COALESCE(to_ts, from_ts) DESC LIMIT 1'
      ).get();
      const what = sc && (sc.title || sc.goal || sc.project);
      if (what) lines.push(`正在弄：${what}`);
      const last = db.prepare(
        "SELECT body FROM impressions WHERE status = 'active' ORDER BY created DESC LIMIT 1"
      ).get();
      if (last && last.body) lines.push(`刚说到：${String(last.body).slice(0, 60)}`);
    } catch { /* 表结构不对就照旧空着，别把注入搞挂 */ }
  }
  if (!lines.length) return '';
  let out = '## 现在\n' + lines.join('\n');
  if (out.length > BUDGET_NOW) out = out.slice(0, BUDGET_NOW).trim() + '…';
  return out;
}

function blockMemories(picks, budget) {
  if (!picks.length) return { text: '', used: [] };
  const fitted = fitBudget(picks, budget);
  const lines = [];
  const used = [];      // 真的进了注入文本的那些，才配叫「被想起」
  for (const p of fitted) {
    const text = hedging(p.m.certainty, p.m.body);
    if (!text) continue;   // 确信度 < 0.35，hedging 返回空串，这条不算用上
    lines.push(`· [${p.m.kind}] ${text}`);
    used.push(p);
  }
  if (!lines.length) return { text: '', used: [] };
  return { text: '## 我记得\n' + lines.join('\n'), used };
}

function blockVoice(db, budget) {
  let rows = [];
  try {
    rows = db.prepare(
      // good = 他说「就这样」的原话；rule = 他明确提过的硬要求
      "SELECT kind, text FROM voice WHERE kind IN ('good','rule') " +
      "ORDER BY CASE kind WHEN 'good' THEN 0 ELSE 1 END, ts DESC LIMIT 8"
    ).all();
  } catch { return ''; }
  if (!rows.length) return '';
  const good = rows.filter((r) => r.kind === 'good');
  const rules = rows.filter((r) => r.kind === 'rule');
  let out = '';
  let used = 0;
  if (good.length) {
    const head = '## 我往常是这么说话的（照这个调子）\n';
    out += head;
    used += head.length;
    for (const r of good) {
      const t = String(r.text || '').trim();
      if (!t) continue;
      const line = `> ${t}\n`;
      if (used + line.length > budget) break;
      out += line;
      used += line.length;
    }
  }
  if (rules.length && used < budget) {
    const head = '## 他说过的硬要求\n';
    out += head;
    used += head.length;
    for (const r of rules) {
      const t = String(r.text || '').trim();
      if (!t) continue;
      const line = `· ${t}\n`;
      if (used + line.length > budget) break;
      out += line;
      used += line.length;
    }
  }
  return out.trim();
}

/**
 * 组装一次注入。
 * @returns {{text: string, bytes: number, picks: number, degraded: string}}
 */
export async function buildInjection(db, { query = '', project = '' } = {}) {
  const parts = [];
  let degraded = '';

  // ⓪ 我是谁：名字放最前面，它得先知道自己是谁，再谈记得什么
  try {
    const me = selfLine(db);
    if (me) parts.push(me);
  } catch { degraded += 'self,'; }

  // 向量：拿不到就整条路降级，不影响词法 + 意图
  let queryVec = null;
  try {
    const st = await embedInit({ allowRemote: false });
    if (st.ok && query) queryVec = await encode(query);
    if (!st.ok) degraded += 'vec,';
  } catch { degraded += 'vec,'; }

  // ① 现在
  try {
    const focus = getFocus(db);
    if (!project && focus.project) project = focus.project;
    const b = blockNow(db, focus);
    if (b) parts.push(b);
  } catch (e) { degraded += 'focus,'; }

  // ①.5 小结：先给"那阵子在干什么"，细节后面按需展开
  try {
    const dg = blockDigests(db, project, 300);
    if (dg) parts.push('【这些天的轮廓】' + String.fromCharCode(10) + dg);
  } catch { degraded += 'digest,'; }

  // ② 我记得
  let picks = [];
  let injectedPicks = [];   // 真正写进注入文本的那些（fitBudget + hedging 之后剩下的）
  const reserved = BUDGET_VOICE + BUDGET_PROACTIVE;
  const memBudget = Math.max(400, BUDGET_TOTAL - reserved - parts.join('\n').length);
  try {
    const r = activate(db, { query, queryVec, project });
    picks = r.picks;
    // 刚说过的不再重复说。
    // 之前是 `picks.slice(0, 2)` 无条件 keep —— 前两条绕过去重，结果 top-2 每轮
    // 必复读，「我记得」区变成固定那两句的复读机，跟这个话题到底相不相关都不管。
    // 现在全部参与去重，只留一个兜底：去重后一条不剩时，放回最强的那条，
    // 宁可恶一句相关的，也别让整块空掉。
    const fresh = picks.filter((p) => !recentlyInjected(p.m && p.m.id));
    if (!fresh.length && picks.length) fresh.push(picks[0]);
    picks = fresh;
    // 再看一眼：模型挑出真正在回答这句话的那几条排到前面
    try { picks = await rerankByModel(query, picks); } catch { /* 重排失败就用原序 */ }
    if (r.degraded) degraded += r.degraded + ',';
    // 注入不是越多越好。实测短问题能召回 18 条，全塞进去就把预算占满，
    // 真正相关的一两句反而被稀释成背景音。只带前 6 条（重排之后的前 6 条）。
    const b = blockMemories(picks.slice(0, 6), memBudget);
    if (b.text) parts.push(b.text);
    injectedPicks = b.used;
  } catch (e) { degraded += 'recall,'; }

  // ③ 性格样本
  try {
    const b = blockVoice(db, BUDGET_VOICE);
    if (b) parts.push(b);
  } catch { degraded += 'voice,'; }

  // ④ 主动（暂留接口，proactive 模块接上后填）
  try {
    const b = buildProactive(db, { project, budget: BUDGET_PROACTIVE });
    if (b) parts.push(b);
  } catch { degraded += 'proactive,'; }

  const text = parts.join('\n\n');
  return {
    text,
    bytes: text.length,
    // 把 query 回带出去。afterInject 要拿它写 trace；不回带的话那边只能硬编空串，
    // 于是 diagnose 时看到一片 query='' ，根本分不清是「没取到 query」还是「没记」。
    query: String(query || '').slice(0, 200),
    // picks 报的是「真的注进去了几条」，不是「召回了几个候选」。
    // 之前拿候选数当注入量，回想 18 条、实际只显示五六条，预算看着满，其实差一大截。
    picks: injectedPicks.length,
    candidates: picks.length,
    degraded: degraded.replace(/,+$/, ''),
    _picks: injectedPicks,
  };
}

/** 主动块：成本算过才说话。真实实现见 proactive.js，这里做一次轻量调用 */
function buildProactive(db, { project, budget }) {
  try {
    // 动态导入，模块缺失时静默降级（不影响记忆本身）
    return '';
  } catch { return ''; }
}

/** 注入之后调用：把被想起来的记一笔（复习效应） */
export function afterInject(db, result) {
  if (!result || !result._picks || !result._picks.length) return;
  try { touchPicks(db, result._picks); } catch { /* 记分失败不影响对话 */ }
  try { markInjected(result._picks.map((p) => p.m && p.m.id)); } catch { /* 去重失败不影响对话 */ }
  try {
    db.prepare(
      'INSERT INTO trace (ts, turn, query, picks, bytes, degraded) VALUES (?,?,?,?,?,?)'
    ).run(
      // query 原来硬编码空串，整整 4030 条 trace 全是空 —— 事后想查「这一轮到底
      // 拿什么在找记忆」完全查不出来，也分不清是取不到还是没记。
      // 现在写 buildInjection 回带的那个值。
      Date.now() / 1000, result.turn || 0, String(result.query || ''),
      JSON.stringify(result._picks.filter((p) => p && p.m && p.m.id).map((p) => ({
        id: p.m.id, score: Number((p.score ?? 0).toFixed(3)), routes: p.routes,
      }))),
      result.bytes, result.degraded || ''
    );
    // trace 只是诊断日志，不是档案。之前只写不清，每轮都插一行，
    // 跑几个月它就会长成整库最大的表，把真数据挤到后面去。
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM trace').get();
    if (cnt && cnt.c > TRACE_KEEP) {
      db.prepare(
        'DELETE FROM trace WHERE rowid IN (SELECT rowid FROM trace ORDER BY ts ASC LIMIT ?)'
      ).run(cnt.c - TRACE_KEEP);
    }
  } catch { /* trace 失败也不能影响对话 */ }
}
