/**
 * db.js —— 建库、schema、迁移
 *
 * 整个系统只有这一个数据库文件，用 Node 24 内置的 node:sqlite，
 * 不编译任何原生模块，不依赖任何第三方包。
 *
 * 九张表，对应 MEMORY.md 里的九个概念：
 *   events      事件（地基，只追加，也是灾备）
 *   impressions 印象（真正的记忆）
 *   bonds       关系（同在/重复）
 *   causes      因果（单独一张表，因为是单向且字段多）
 *   scenes      场景（唤起的最小单位）
 *   focus       现状（永远带在注入里）
 *   voice       性格（从对话里长出来的样本）
 *   trace       每轮为什么想起这些
 *   meta        schema 版本等杂项
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const SCHEMA_VERSION = 1;

export function defaultDir(config = {}) {
  return (config && config.dataDir) || process.env.BRAIN_DIR || join(homedir(), '.dsh', 'brain');
}

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- ① 事件：只追加。任何印象被质疑时翻回这里核对，也是库坏时重放的地基。
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        REAL NOT NULL,
  role      TEXT NOT NULL,              -- user / assistant / tool
  body      TEXT NOT NULL,
  session   TEXT,
  turn      INTEGER,
  project   TEXT,
  digest    TEXT DEFAULT 'raw'          -- raw / distilled / skipped / missing
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_digest ON events(digest);

-- ② 印象：真记忆。允许不完整，带确信度。
CREATE TABLE IF NOT EXISTS impressions (
  id        TEXT PRIMARY KEY,
  created   REAL NOT NULL,
  happened  REAL,
  kind      TEXT NOT NULL,              -- fact/pref/lesson/method/promise
  body      TEXT NOT NULL,
  gist      TEXT,
  certainty REAL DEFAULT 0.8,
  weight    REAL DEFAULT 1.0,
  uses      INTEGER DEFAULT 0,
  last_use  REAL,
  level     TEXT DEFAULT 'clear',       -- clear / blur / sunk
  project   TEXT,
  expires   REAL,
  src       TEXT,                       -- JSON 数组：来源 event id，可能不全
  scene     TEXT,
  status    TEXT DEFAULT 'active'       -- active / superseded / unsure / review
);
CREATE INDEX IF NOT EXISTS idx_imp_status ON impressions(status);
CREATE INDEX IF NOT EXISTS idx_imp_scene ON impressions(scene);
CREATE INDEX IF NOT EXISTS idx_imp_project ON impressions(project);

-- ③ 关系：同在 / 重复（因果单独一张表）
--    why 存结构化的「为什么连」：给 3D 详情面板渲染成人话，也方便追溯来源
CREATE TABLE IF NOT EXISTS bonds (
  a    TEXT NOT NULL REFERENCES impressions(id) ON DELETE CASCADE,
  b    TEXT NOT NULL REFERENCES impressions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                   -- co / repeat
  w    REAL DEFAULT 1.0,
  why  TEXT,
  PRIMARY KEY (a, b, kind)
);
CREATE INDEX IF NOT EXISTS idx_bonds_a ON bonds(a);
CREATE INDEX IF NOT EXISTS idx_bonds_b ON bonds(b);

-- ④ 因果：单向，a 是因 b 是果，绝不排序存储。
CREATE TABLE IF NOT EXISTS causes (
  id        TEXT PRIMARY KEY,
  cause     TEXT NOT NULL REFERENCES impressions(id) ON DELETE CASCADE,
  effect    TEXT NOT NULL REFERENCES impressions(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,              -- direct/condition/purpose/instrument/pathological/counterfactual
  certainty REAL DEFAULT 0.9,
  evidence  TEXT,
  verified  INTEGER DEFAULT 0,
  last_seen REAL,
  status    TEXT DEFAULT 'active',      -- active / suspect / resolved / disproven
  why       TEXT                        -- 结构化的「为什么这条因果成立」
);
CREATE INDEX IF NOT EXISTS idx_cause_c ON causes(cause);
CREATE INDEX IF NOT EXISTS idx_cause_e ON causes(effect);

-- ⑤ 场景：唤起的最小单位
CREATE TABLE IF NOT EXISTS scenes (
  id      TEXT PRIMARY KEY,
  title   TEXT,
  goal    TEXT,
  mood    TEXT,
  from_ts REAL,
  to_ts   REAL,
  project TEXT,
  members TEXT                          -- JSON 数组
);

-- ⑥ 现状：永远整条带进注入，永不裁剪
CREATE TABLE IF NOT EXISTS focus (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  goal      TEXT,
  confirmed TEXT,                       -- JSON 数组
  blockers  TEXT,                       -- JSON 数组
  next      TEXT,
  project   TEXT,
  updated   REAL
);

-- ⑦ 性格：good / bad / rule 三类样本
CREATE TABLE IF NOT EXISTS voice (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  why  TEXT,
  ts   REAL
);

-- ⑧ 追溯：这一轮为什么想起这些
CREATE TABLE IF NOT EXISTS trace (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      REAL,
  turn    INTEGER,
  query   TEXT,
  picks   TEXT,
  bytes   INTEGER,
  degraded TEXT
);

-- ⑨ 全文索引：中文用自切二元组存 tok 列，查询时同样切。
CREATE VIRTUAL TABLE IF NOT EXISTS imp_fts USING fts5(
  body, tok, content='', tokenize='unicode61'
);

-- ⑩ 小结：把一段时间里同一个项目的记忆压成几句话。
--   注入时先给小结，细节按需展开——同样预算能装下多得多的东西。
CREATE TABLE IF NOT EXISTS digests (
  id      TEXT PRIMARY KEY,
  scope   TEXT NOT NULL,          -- project / week
  project TEXT,
  from_ts REAL,
  to_ts   REAL,
  count   INTEGER,
  text    TEXT NOT NULL,
  ts      REAL
);

-- ⑪ 反馈：主动说的话，你后来是认了还是否了。用来调各类信号的权重。
CREATE TABLE IF NOT EXISTS feedback (
  id     TEXT PRIMARY KEY,
  kind   TEXT,
  text   TEXT,
  refs   TEXT,
  ts     REAL,
  verdict TEXT DEFAULT 'pending',   -- pending / good / bad
  judge_ts REAL
);

-- ⑪ 向量：可选加速器。整表删掉也不影响主流程，只是抽象问句差一点。
CREATE TABLE IF NOT EXISTS vectors (
  id  TEXT PRIMARY KEY REFERENCES impressions(id) ON DELETE CASCADE,
  dim INTEGER,
  vec BLOB NOT NULL,
  ts  REAL
);
`;

export function openDb(dir = defaultDir()) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'brain.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec('PRAGMA foreign_keys = ON');
  ensureSchema(db);
  // 老库没有外键约束（建表时就没写，SQLite 也补不上），只能靠启动时扫一遍。
  // 但「只在启动扫一次」对长跑的服务等于没有——server.mjs 那边会定期再调 pruneOrphans。
  try { pruneOrphans(db); } catch { /* 清理失败不影响启动 */ }
  return { db, file };
}

export function ensureSchema(db) {
  db.exec(DDL);
  // 老库补列（CREATE TABLE IF NOT EXISTS 不会改已存在的表）
  addColumnIfMissing(db, 'bonds', 'why', 'TEXT');
  addColumnIfMissing(db, 'causes', 'why', 'TEXT');
  // 这条印象是「他说的」还是「我自己的活」——写库时就定，不再事后用正则猜。
  // 老库补列后是 NULL，由 backfillWho() 一次性回填。
  addColumnIfMissing(db, 'impressions', 'who', 'TEXT');
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version');
  if (!row) {
    db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  }
  return SCHEMA_VERSION;
}

/**
 * 清理所有「端点已经不在了」的衍生数据。
 *
 * 老实现只清 causes，而且只在 openDb 里跑一次 —— 这意味着长跑的服务
 * 里，印象被 supersede / 删除之后，bonds 和 vectors 会一直挂着死引用：
 * 实测 bonds 807/1365 指向非 active，vectors 180/591 是孤儿。
 *
 * 新库有 FOREIGN KEY ... ON DELETE CASCADE 兜底；老库的表建的时候没带，
 * SQLite 也不支持给已有表补外键，所以只能靠这个函数定期扫。
 */
export function pruneOrphans(db) {
  const out = { causes: 0, bonds: 0, vectors: 0 };
  try {
    out.causes = Number(db.prepare(`
      DELETE FROM causes
       WHERE NOT EXISTS(SELECT 1 FROM impressions i WHERE i.id = causes.cause)
          OR NOT EXISTS(SELECT 1 FROM impressions i WHERE i.id = causes.effect)
    `).run()?.changes || 0);
  } catch { /* 表还没建好就跳过 */ }
  try {
    out.bonds = Number(db.prepare(`
      DELETE FROM bonds
       WHERE NOT EXISTS(SELECT 1 FROM impressions i WHERE i.id = bonds.a)
          OR NOT EXISTS(SELECT 1 FROM impressions i WHERE i.id = bonds.b)
    `).run()?.changes || 0);
  } catch { /* 同上 */ }
  try {
    out.vectors = Number(db.prepare(`
      DELETE FROM vectors
       WHERE NOT EXISTS(SELECT 1 FROM impressions i WHERE i.id = vectors.id)
    `).run()?.changes || 0);
  } catch { /* 同上 */ }
  return out;
}

/** 兼容旧调用方：只清因果 */
export function pruneCauses(db) {
  return pruneOrphans(db).causes;
}

function addColumnIfMissing(db, table, col, type) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  } catch { /* 补列失败不影响主流程 */ }
}

/* ---------------- 小工具 ---------------- */

export const now = () => Date.now() / 1000;

let seq = 0;
export function newId(prefix = 'imp') {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36)}`;
}

export function getFocus(db) {
  const r = db.prepare('SELECT * FROM focus WHERE id = 1').get();
  if (!r) return { goal: '', confirmed: [], blockers: [], next: '', project: '', updated: 0 };
  const parse = (s) => {
    try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  return {
    goal: r.goal || '',
    confirmed: parse(r.confirmed),
    blockers: parse(r.blockers),
    next: r.next || '',
    project: r.project || '',
    updated: r.updated || 0,
  };
}

export function setFocus(db, patch) {
  const cur = getFocus(db);
  const next = { ...cur, ...patch, updated: now() };
  db.prepare(
    `INSERT INTO focus (id, goal, confirmed, blockers, next, project, updated)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       goal=excluded.goal, confirmed=excluded.confirmed, blockers=excluded.blockers,
       next=excluded.next, project=excluded.project, updated=excluded.updated`
  ).run(
    next.goal || '',
    JSON.stringify(next.confirmed || []),
    JSON.stringify(next.blockers || []),
    next.next || '',
    next.project || '',
    next.updated
  );
  return next;
}

export function stats(db) {
  const one = (sql) => {
    try { const r = db.prepare(sql).get(); return r ? Object.values(r)[0] : 0; } catch { return 0; }
  };
  return {
    events: one('SELECT COUNT(*) FROM events'),
    raw: one("SELECT COUNT(*) FROM events WHERE digest = 'raw'"),
    impressions: one('SELECT COUNT(*) FROM impressions'),
    active: one("SELECT COUNT(*) FROM impressions WHERE status = 'active'"),
    scenes: one('SELECT COUNT(*) FROM scenes'),
    bonds: one('SELECT COUNT(*) FROM bonds'),
    causes: one(`SELECT COUNT(*) FROM causes c
                  WHERE c.status != 'disproven'
                    AND EXISTS(SELECT 1 FROM impressions i WHERE i.id = c.cause)
                    AND EXISTS(SELECT 1 FROM impressions i WHERE i.id = c.effect)`),
    voice: one('SELECT COUNT(*) FROM voice'),
  };
}
