/**
 * db-store.js —— 把 SQLite 记忆库包成 tools.js 期待的那个 store 形状
 *
 * 背景：tools.js 是照着一个 JSONL 的 Store 写的（items / add / update / touch /
 * remove / rename / size）。可现在的库是 SQLite，两者接口对不上，导致那三个工具
 * 一直没法注册——文件在，功能是死的。这个模块就是那层适配，只做翻译，不加业务。
 */
import { now, newId } from './db.js';
import { clip } from './text.js';
import { writeImpression } from './write.js';

const KIND_IN = {
  identity: 'fact', preference: 'pref', fact: 'fact',
  lesson: 'lesson', method: 'method', episode: 'fact', promise: 'promise',
};
const KIND_OUT = { fact: 'fact', pref: 'preference', lesson: 'lesson', method: 'method', promise: 'promise' };

function rowToItem(r) {
  return {
    id: r.id,
    ts: r.created,
    kind: KIND_OUT[r.kind] || r.kind,
    text: r.body,
    about: r.project || '',
    tags: [],
    weight: r.weight,
    uses: r.uses,
    lastUse: r.last_use,
    pinned: false,
    status: r.status,
  };
}

export function createDbStore(db) {
  const selectAll = () => {
    try {
      return db.prepare(
        `SELECT id, created, kind, body, project, weight, uses, last_use, status
         FROM impressions WHERE status = 'active' ORDER BY created DESC LIMIT 5000`
      ).all().map(rowToItem);
    } catch { return []; }
  };

  return {
    get items() { return selectAll(); },
    get size() { try { return db.prepare("SELECT COUNT(*) c FROM impressions WHERE status='active'").get().c; } catch { return 0; } },

    add({ kind = 'fact', text = '', about = '', tags = [] } = {}) {
      const k = KIND_IN[kind] || 'fact';
      const clean = clip(String(text || '').trim(), 400);

      /* 走正路：调用 writeImpression，而不是在这里裸 INSERT。
       * 原来这里是第二套写入逻辑，只建 FTS 索引就完事 ——
       * 结果所有经 brain_remember 写进来的记忆都没有向量、没有关系、没有冲突检测，
       * 在语义检索里等于瞎的（2026-11-14 实测：刚写的 7 条系统说明，一条都召不回来）。
       * 失败时退回老写法，保证工具永远能写进去。
       */
      try {
        const r = writeImpression(db, { body: clean, kind: k, role: 'user', project: about || '' });
        if (r && r.id) return { id: r.id, kind: k, text: clean };
        // 返回 null = 被写入管线拒了（太短 / 纯符号 / 同字重复），不该回退到裸写入。
        // 否则质量闸形同虚设：挡下来又被下面的 INSERT 写回去，「啊啊啊」照样进库。
        return null;
      } catch { /* 只有抛异常才退到下面 */ }

      const id = newId('imp');
      const t = now();
      db.prepare(
        `INSERT INTO impressions (id, created, happened, kind, body, gist, certainty, weight, uses, last_use, level, project, expires, src, scene, status)
         VALUES (?,?,?,?,?,?,?,?,0,NULL,'clear',?,NULL,?,?,'active')`
      ).run(id, t, t, k, clean, clip(clean, 60), 0.95, k === 'lesson' ? 1.5 : 1.0, about || null, JSON.stringify(tags), '');
      try {
        const rid = db.prepare('SELECT rowid AS r FROM impressions WHERE id=?').get(id)?.r;
        if (rid) db.prepare('INSERT INTO imp_fts (rowid, body, tok) VALUES (?,?,?)').run(rid, clean, clean.replace(/[^\u4e00-\u9fa5a-z0-9]+/gi, ' '));
      } catch { /* 索引坏了不影响写入 */ }
      return { id, kind: k, text: clean };
    },

    update(item) {
      if (!item || !item.id) return;
      try {
        db.prepare('UPDATE impressions SET weight = MIN(3.0, weight + 0.3), certainty = MIN(1.0, certainty + 0.05), uses = uses + 1, last_use = ? WHERE id = ?')
          .run(now(), item.id);
      } catch { /* 忽略 */ }
    },

    touch(ids = []) {
      const st = db.prepare('UPDATE impressions SET uses = uses + 1, last_use = ? WHERE id = ?');
      for (const id of ids) { try { st.run(now(), id); } catch { /* 忽略 */ } }
    },

    remove(id) {
      try { db.prepare("UPDATE impressions SET status='retired' WHERE id=?").run(id); } catch { /* 忽略 */ }
    },

    rename(name, reason = '') {
      const { setName } = requireSelf();
      return setName(db, name, { reason });
    },
  };
}

// 动态取 self.js，避免顶层循环依赖
let selfMod = null;
function requireSelf() {
  if (!selfMod) throw new Error('self.js 未加载');
  return selfMod;
}
export function bindSelf(mod) { selfMod = mod; }
