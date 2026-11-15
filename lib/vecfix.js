/**
 * vecfix.js —— 补齐缺失的记忆向量
 *
 * 问题：只有「一轮对话」那条写路径会补向量。工具写入、改名留痕、旧数据拆分
 * 这几条路都不补，于是那些记忆永远搜不到（语义召回里它们是隐形的）。
 *
 * 这里在定时任务里定期扫一遍缺向量的活跃记忆，补上就完事。
 */
import { now } from './db.js';

export async function backfillVectors(db, logger, { limit = 40 } = {}) {
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT i.id, i.body FROM impressions i
       LEFT JOIN vectors v ON v.id = i.id
       WHERE i.status='active' AND v.id IS NULL
       ORDER BY i.created DESC LIMIT ?`
    ).all(limit);
  } catch { return { ok: false, reason: 'query' }; }
  if (!rows.length) return { ok: true, added: 0 };

  let embed;
  try {
    embed = await import('./embed.js');
  } catch { return { ok: false, reason: 'no-embed' }; }

  const st = await embed.init({ allowRemote: false });
  if (!st.ok) return { ok: false, reason: st.error || 'model-unavailable' };

  let added = 0;
  const ins = db.prepare('INSERT OR REPLACE INTO vectors (id, dim, vec, ts) VALUES (?,?,?,?)');
  for (const r of rows) {
    const v = await embed.encode(r.body);
    if (!v) continue;
    try {
      ins.run(r.id, v.length, embed.toBlob(v), now());
      added += 1;
    } catch { /* 单条失败不影响别的 */ }
  }
  try {
    const { invalidateCache } = await import('./recall.js');
    invalidateCache();
  } catch { /* 失效失败也不影响 */ }
  if (added) logger?.info?.(`[brain] 补向量 ${added} 条（一共 ${rows.length} 条待补）`);
  return { ok: true, added, scanned: rows.length };
}
