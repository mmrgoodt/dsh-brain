/**
 * next.js —— 「接下来干什么」：把定时播报换成待问才答
 *
 * 他否掉的是「每天早上一遍待办」那种形式，不是那个能力。
 * 所以这里不推送、不按点念：把该干的事做成一张活的池子，
 * 他什么时候问就什么时候排给他。触发权在他，判断权在代码。
 */
import { tokens } from './text.js';

const DO = /(要做|该做|明天|下次|回头|别忘了|记得要|待办|还没做完|继续|接着弄|接着做)/;
const END = /(办完了|已完成|搞定了|做完了)/;
// 转述、闲聊、事后复盘都不算待办
const TRANSCRIPT = /^(他|我)(说|问|告诉|觉得|想|要求)/;
const PROCESS = /(已经|之后|后来|结果|所以|然后)/;

function pOf(i) { return String(i.project || '').trim() || '未归类'; }

export function suggestNext(db, { limit = 3, nowMs = Date.now() } = {}) {
  const rows = db.prepare(
    "SELECT id, body, kind, project, created FROM impressions WHERE status='active' ORDER BY created DESC LIMIT 600"
  ).all();

  const NL = String.fromCharCode(10);
  const df = new Map();
  for (const r of rows) for (const t of tokens(String(r.body || ''))) df.set(t, (df.get(t) || 0) + 1);
  const now = nowMs / 1000;
  const items = [];

  for (const r of rows) {
    const body = String(r.body || '').trim();
    if (!DO.test(body) || END.test(body)) continue;
    if (TRANSCRIPT.test(body)) continue;
    if (body.length < 12) continue;
    if (PROCESS.test(body) && !/^(明天|下次|记得|别忘了|待办)/.test(body)) continue;
    const days = (now - Number(r.created || 0)) / 86400;
    if (days > 45) continue;
    const flat = body.split(NL).join(' ');
    const clause = flat.split(/[。；]/).map((x) => x.trim()).filter((x) => DO.test(x) && !END.test(x))[0] || flat;

    // 关键一步：看这件事后来有没有被"办完了"接住。
    // 只在同一件事上找（共享至少一个少见词），别把不相干的完成句当兑现。
    const key = [...tokens(clause)].filter((t) => t.length >= 2 && (df.get(t) || 0) <= 8);
    if (key.length) {
      const done = rows.some((o) => {
        if (Number(o.created) <= Number(r.created)) return false;
        const ob = String(o.body || '');
        if (!END.test(ob)) return false;
        return key.some((t) => ob.includes(t));
      });
      if (done) continue;
    }
    items.push({
      kind: 'todo', score: 0.82 - Math.min(0.3, days / 60), id: r.id, project: pOf(r),
      text: String(clause).slice(0, 80), why: Math.round(days) + ' 天前说过的',
    });
  }

  const byProj = new Map();
  for (const r of rows) {
    const p = pOf(r);
    if (p === '未归类') continue;
    const cur = byProj.get(p) || { last: 0, lastId: null, lastBody: '', n: 0 };
    if (Number(r.created) > cur.last) {
      cur.last = Number(r.created);
      cur.lastId = r.id;
      cur.lastBody = String(r.body || '').slice(0, 60);
    }
    cur.n += 1;
    byProj.set(p, cur);
  }
  for (const [p, v] of byProj) {
    const gap = (now - v.last) / 86400;
    if (gap < 2.5 || v.n < 4) continue;
    items.push({
      kind: 'stall', score: 0.62 + Math.min(0.18, gap / 30), id: v.lastId, project: p,
      text: v.lastBody, why: '断了 ' + Math.round(gap * 24) + ' 小时',
    });
  }

  const seen = new Set();
  const out = [];
  for (const it of items.sort((a, b) => b.score - a.score)) {
    const key = it.project + '|' + String(it.text).slice(0, 18);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}
