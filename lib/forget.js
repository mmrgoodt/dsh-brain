/**
 * forget.js —— 三层遗忘
 *
 * clear  → 完整的，直接注入
 * blur   → 只留一句大意（30 天没被想起）
 * sunk   → 沉底，只在强相关时才可能被捞出来（90 天）
 *
 * 约定和规矩（pref / promise）不参与降级——那是你定的事，不因为没用过就淡掉。
 *
 * 2026-11-14 补了第四层：容量淘汰。
 * 起因是全库拆解把 1036 条记忆的 created 全刷成了同一天，
 * 上面两条按天数判的规则于是永远不触发 —— 整个遗忘机制成了死代码，记忆只增不减。
 * 时间不可信，就改用「有没有真的被用到」来判：超过容量上限时，先把
 * 没人召回、又没连上关系和因果的末位记忆沉底。
 */
const BLUR_DAYS = 30;
const SUNK_DAYS = 90;
const ACTIVE_CAP = 900;      // 活跃记忆的软上限，超过就从最没用的开始沉

/** 一条记忆的"分量"：被用过、被连过、被因果引用过，都算数 */
function weightOfRow(db, id) {
  let bonds = 0, causes = 0, uses = 0, w = 1, kind = 'fact';
  try { bonds = db.prepare('SELECT COUNT(*) c FROM bonds WHERE a=? OR b=?').get(id, id)?.c || 0; } catch {}
  try { causes = db.prepare('SELECT COUNT(*) c FROM causes WHERE (cause=? OR effect=?) AND status=\'active\'').get(id, id)?.c || 0; } catch {}
  try {
    const r = db.prepare('SELECT uses, weight, kind FROM impressions WHERE id=?').get(id);
    uses = Number(r?.uses || 0); w = Number(r?.weight || 1); kind = String(r?.kind || 'fact');
  } catch {}
  // 教训和方法比一般事实更值钱：它们是从具体经历里提炼出来的，重写一遍成本高
  const kindBonus = kind === 'lesson' ? 3 : kind === 'method' ? 2 : 0;
  return uses * 2 + (w - 1) * 3 + bonds * 0.4 + causes * 1.5 + kindBonus;
}

export function runForgetting(db, { now = Date.now() / 1000, dryRun = false, cap = ACTIVE_CAP } = {}) {
  const day = 86400;
  const stat = { blur: 0, sunk: 0, skipped: 0 };

  try {
    // 先沉底：很久没被想起、也不是约定的
    const toSunk = db.prepare(`
      SELECT id FROM impressions
      WHERE status='active' AND level='blur'
        AND kind NOT IN ('pref','promise')
        AND COALESCE(last_use, created) < ?
    `).all(now - SUNK_DAYS * day);
    if (!dryRun) {
      const st = db.prepare("UPDATE impressions SET level='sunk' WHERE id=?");
      for (const r of toSunk) st.run(r.id);
    }
    stat.sunk = toSunk.length;

    // 再模糊：一个月没被想起来的
    const toBlur = db.prepare(`
      SELECT id FROM impressions
      WHERE status='active' AND level='clear'
        AND kind NOT IN ('pref','promise')
        AND COALESCE(last_use, created) < ?
    `).all(now - BLUR_DAYS * day);
    if (!dryRun) {
      const st = db.prepare("UPDATE impressions SET level='blur' WHERE id=?");
      for (const r of toBlur) st.run(r.id);
    }
    stat.blur = toBlur.length;

    stat.skipped = db.prepare(
      "SELECT COUNT(*) c FROM impressions WHERE status='active' AND kind IN ('pref','promise')"
    ).get().c;

    /* 容量淘汰：时间不可信时，靠"有没有被用到"来控量。
     * 只看 fact / method / lesson —— 规矩和约定不参与（那是他定的事）。
     * 排序按分量从小到大，正好先淘汰没人召回、又没连上关系和因果的孤立记忆。
     *
     * 计数必须只算「可召回的」（clear / blur）。原来把 sunk 也算进 activeN，
     * 于是 sunk 越多 → 越超容量 → 再把 clear 沉下去 → sunk 更多，恶性循环：
     * 实测 2000 条的库里 1489 条被沉底，真正还能召回的只剩 538 条 ——
     * 这也是「问什么都召回不准」的真正原因。
     */
    const activeN = db.prepare(
      "SELECT COUNT(*) c FROM impressions WHERE status='active' AND level IN ('clear','blur')"
    ).get().c;
    if (activeN > cap) {
      /* 一周内写进来的不参与淘汰：它们还没机会被用到，uses=0 只是因为太新。
       * 不加这条，实测「他认为抽取质量主要取决于输入和判据」这种刚写下、
       * 谁都还没问过的知识，一超容量就被沉底 —— 刚记的东西反而最先被忘。
       */
      const pool = db.prepare(`SELECT id FROM impressions
        WHERE status='active' AND kind NOT IN ('pref','promise') AND level!='sunk'
          AND COALESCE(created, 0) < ?
        LIMIT 4000`).all(now - 7 * day);
      const scored = pool.map((r) => ({ id: r.id, s: weightOfRow(db, r.id) }))
        .sort((a, b) => a.s - b.s);
      const need = Math.min(activeN - cap, scored.length);
      const victims = scored.slice(0, need);
      if (!dryRun) {
        const st = db.prepare("UPDATE impressions SET level='sunk' WHERE id=?");
        for (const v of victims) st.run(v.id);
      }
      stat.evicted = victims.length;
      stat.evictedSample = victims.slice(0, 3).map((v) => {
        try { return String(db.prepare('SELECT body FROM impressions WHERE id=?').get(v.id)?.body || '').slice(0, 40); } catch { return ''; }
      });
    } else {
      stat.evicted = 0;
    }
  } catch (e) {
    return { ...stat, error: e && e.message };
  }
  return stat;
}

export function levelStats(db) {
  const out = {};
  for (const r of db.prepare("SELECT level, COUNT(*) c FROM impressions WHERE status='active' GROUP BY level").all()) {
    out[r.level] = r.c;
  }
  return out;
}
