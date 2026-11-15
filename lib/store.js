/**
 * store.js —— 记忆的落盘与载入
 *
 * 为什么用 JSONL 而不是 SQLite：
 *   上一版为了「像大脑」，堆了 30 个 Python 模块、一张 15 列的表、两个进程。
 *   结果是大部分时间里，它在修自己。这一版反过来：一条记忆一行文本，
 *   打开就能看，坏了能手工改，坏一行不影响别的行。
 *
 * 文件：
 *   memories.jsonl  一条记忆一行
 *   events.jsonl    什么时候被想起来过（可选的轻量日志，坏了不影响记忆）
 *
 * 一条记忆长这样：
 *   { id, ts, kind, text, about, tags, weight, uses, lastUse, pinned, status }
 *   kind: fact / preference / lesson / method / identity / episode
 */
import {
  existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_DIR = join(homedir(), '.dsh', 'brain');

export function resolveDir(config = {}) {
  return config.dataDir || process.env.BRAIN_DIR || DEFAULT_DIR;
}

let nextSeq = 0;
function newId() {
  nextSeq += 1;
  return `m${Date.now().toString(36)}${nextSeq.toString(36)}`;
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, 'memories.jsonl');
    this.eventFile = join(dir, 'events.jsonl');
    this.items = [];
    this.dirty = false;
    this.load();
  }

  load() {
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch { /* 目录建不出来，后面写的时候会再报一次 */ }
    if (!existsSync(this.file)) {
      this.items = [];
      return this.items;
    }
    const raw = readFileSync(this.file, 'utf8');
    const out = [];
    let broken = 0;
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        // 半行、缺字段的坏条目直接跳过 —— 一条坏不该带走全部
        if (o && typeof o.text === 'string' && o.text.trim()) out.push(normalize(o));
        else broken += 1;
      } catch {
        broken += 1;
      }
    }
    this.items = out;
    this.broken = broken;
    return out;
  }

  get size() {
    return this.items.length;
  }

  add({ text, kind = 'fact', about = '', tags = [], weight = 1 }) {
    const item = normalize({
      id: newId(),
      ts: Date.now() / 1000,
      kind,
      text: String(text).trim(),
      about: about || '',
      tags,
      weight,
    });
    this.items.push(item);
    try {
      appendFileSync(this.file, JSON.stringify(item) + '\n', 'utf8');
    } catch (e) {
      this.dirty = true;
      this.flush();
      throw e;
    }
    return item;
  }

  update(item) {
    const i = this.items.findIndex((m) => m.id === item.id);
    if (i < 0) return false;
    this.items[i] = normalize({ ...this.items[i], ...item });
    this.flush();
    return true;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((m) => m.id !== id);
    if (this.items.length === before) return false;
    this.flush();
    return true;
  }

  /** 整份重写（原子：先写 .tmp 再换名，中途断电不会把原文件切坏） */
  flush() {
    const tmp = this.file + '.tmp';
    const body = this.items.map((m) => JSON.stringify(m)).join('\n') + '\n';
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, this.file);
    this.dirty = false;
    return this.items.length;
  }

  /** 记一笔「想起来了」，用来让常用的记忆慢慢变重 */
  touch(ids = []) {
    if (!ids.length) return;
    const now = Date.now() / 1000;
    let changed = false;
    for (const m of this.items) {
      if (ids.includes(m.id)) {
        m.uses += 1;
        m.lastUse = now;
        changed = true;
      }
    }
    if (changed) {
      // 触碰是高频动作，不立刻整份重写；攒着，等下次真写入或退出时再落盘
      this.dirty = true;
      try {
        appendFileSync(
          this.eventFile,
          JSON.stringify({ ts: now, recall: ids }) + '\n',
          'utf8'
        );
      } catch { /* 日志坏了不影响记忆 */ }
    }
  }
}

function normalize(o) {
  const now = Date.now() / 1000;
  return {
    id: o.id || newId(),
    ts: Number(o.ts) || now,
    kind: o.kind || 'fact',
    text: String(o.text || '').trim(),
    about: String(o.about || ''),
    tags: Array.isArray(o.tags) ? o.tags : [],
    weight: Number(o.weight) || 1,
    uses: Number(o.uses) || 0,
    lastUse: Number(o.lastUse) || 0,
    pinned: o.pinned ? 1 : 0,
    status: o.status || 'active',
  };
}
