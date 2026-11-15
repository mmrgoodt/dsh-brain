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
    if (r.degraded) degraded += r.degraded + ',';
    const b = blockMemories(picks, memBudget);
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
