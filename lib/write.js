/**
 * write.js —— 写入侧：先判断值不值得记
 *
 * 三道闸（对应 MEMORY.md 第四节）：
 *   ① 是不是过程话      → 只进事件，不进印象
 *   ② 有没有新增        → 相似度 > 0.85 视为重复，只给旧条加分
 *   ③ 是哪一类          → 分不出来就不记（宁可漏，不可滥）
 *
 * 另外负责：场景切分、关系建立、因果建立、冲突覆盖。
 * 所有函数都不抛异常给调用方——写入失败不能影响对话。
 */
import { now, newId } from './db.js';
import { addCause } from './cause.js';
import {
  tokens, sim, isProcessNarrative, classify, causeKind, splitCause, projectOf, clip, splitSentences,
} from './text.js';

/* ---------------- 事件层 ---------------- */

export function recordEvent(db, { role, body, session = '', turn = 0, project = '' }) {
  const text = String(body || '').trim();
  if (!text) return null;
  const info = db.prepare(
    'INSERT INTO events (ts, role, body, session, turn, project, digest) VALUES (?,?,?,?,?,?,?)'
  ).run(now(), role, text, session, turn, project || projectOf(text), 'raw');
  return Number(info.lastInsertRowid);
}

/* ---------------- 场景切分 ---------------- */

const SCENE_GAP_SEC = 20 * 60;      // 20 分钟断开
const SCENE_CLOSE_SEC = 30 * 60;    // 30 分钟无事件算结束
const TURN_WORDS = /(另外|对了|换个事|换个话题|先不说这个|说个别的|顺便)/;

/**
 * 找出当前该挂到哪个场景；需要时新建。
 * 规则：时间间隔 > 20 分钟 / 话题重叠 < 0.2 / 出现转折词 → 新场景
 */
export function resolveScene(db, { text, project = '' }) {
  const t = now();
  const last = db.prepare('SELECT * FROM scenes ORDER BY to_ts DESC LIMIT 1').get();
  if (!last) return createScene(db, { text, project });

  const gap = t - (last.to_ts || 0);
  const sameProject = !project || !last.project || project === last.project;
  const qt = tokens(text);
  let overlap = 0;
  try {
    const members = JSON.parse(last.members || '[]');
    if (members.length) {
      const bodies = db.prepare(
        `SELECT body FROM impressions WHERE id IN (${members.map(() => '?').join(',')})`
      ).all(...members);
      const sceneTokens = new Set();
      for (const b of bodies) for (const tk of tokens(b.body)) sceneTokens.add(tk);
      let hit = 0;
      for (const tk of qt) if (sceneTokens.has(tk)) hit += 1;
      overlap = qt.size ? hit / qt.size : 0;
    }
  } catch { overlap = 1; }

  const turnWord = TURN_WORDS.test(String(text || ''));
  if (gap > SCENE_GAP_SEC || !sameProject || turnWord || (qt.size >= 3 && overlap < 0.2)) {
    return createScene(db, { text, project });
  }
  return last;
}

function createScene(db, { text, project = '' }) {
  const id = newId('sc');
  const t = now();
  db.prepare(
    'INSERT INTO scenes (id, title, goal, mood, from_ts, to_ts, project, members) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, clip(text, 20), '', '', t, t, project || projectOf(text), '[]');
  return db.prepare('SELECT * FROM scenes WHERE id = ?').get(id);
}

function touchScene(db, sceneId) {
  db.prepare('UPDATE scenes SET to_ts = ? WHERE id = ?').run(now(), sceneId);
}

function addSceneMember(db, sceneId, impId, title) {
  const row = db.prepare('SELECT members, title FROM scenes WHERE id = ?').get(sceneId);
  if (!row) return;
  let arr = [];
  try { arr = JSON.parse(row.members || '[]'); } catch { arr = []; }
  if (arr.includes(impId)) return;
  arr.push(impId);
  if (arr.length > 200) arr = arr.slice(-200);
  db.prepare('UPDATE scenes SET members = ?, to_ts = ? WHERE id = ?')
    .run(JSON.stringify(arr), now(), sceneId);
  if (!row.title && title) {
    db.prepare('UPDATE scenes SET title = ? WHERE id = ?').run(clip(title, 20), sceneId);
  }
}

/* ---------------- 印象层：三道闸 ---------------- */

/** 找相似印象：返回 {dup, near} —— dup 是同一条，near 是讲过好几次 */
function findSimilar(db, body, kind) {
  // ORDER BY 不能省：没有它时 SQLite 按存储顺序取前 2000 条 = 最老的 2000 条，
  // 新记忆永远进不了候选，查重直接失效（库超过 2000 条那天就全瞎了）。
  const rows = db.prepare(
    "SELECT id, body, kind, weight, certainty FROM impressions WHERE status = 'active' ORDER BY created DESC LIMIT 2000"
  ).all();
  let dup = null;
  let near = null;
  let dupScore = 0;
  const bt = tokens(body);
  for (const r of rows) {
    const s = sim(bt, tokens(r.body));
    if (s > dupScore) dupScore = s;
    // dup 只在同 kind 内认定。跨 kind 的字面重合是「同一件事的不同侧面」
    // （lesson 的规矩和 pref 的偏好可以一模一样），合并掉一条就是丢一条。
    if (s >= 0.85 && r.kind === kind && (!dup || s > dup.score)) dup = { ...r, score: s };
    // near 用独立 if：原来写成 else if，导致 ≥0.85 的候选永远进不了 near，
    // 而跨 kind 的 0.9 相似又因为上面那道 kind 闸进不了 dup —— 两头都空。
    if (s >= 0.55 && (!near || s > near.score)) near = { ...r, score: s };
  }
  return { dup, near, best: dupScore };
}

/** 冲突判定：同 kind、主题重合、但取值不同 → 旧的失效 */
function findConflict(db, body, kind) {
  if (kind === 'pref' || kind === 'lesson' || kind === 'method') return null;
  const rows = db.prepare(
    "SELECT id, body FROM impressions WHERE status = 'active' AND kind = ? ORDER BY created DESC LIMIT 500"
  ).all(kind);
  const bt = tokens(body);
  const values = (sv) => new Set((String(sv).match(/[A-Za-z]:[\\/][^\s，。；]+|\b\d{2,5}\b|\d+\.\d+/g) || []));
  const nv = values(body);
  if (!nv.size) return null;
  for (const r of rows) {
    const rt = tokens(r.body);
    // 主题重合用 Jaccard，不用绝对命中数。hit >= 2 的判据两头都错：
    // 短句两三个词一撞就够 2 次（"用 Clash" 撞 "装 Clash" 算冲突），
    // 长句里 2 次命中等于毫无关系；而三个字以内的印象永远够不到 2。
    let inter = 0;
    for (const tk of bt) if (rt.has(tk)) inter += 1;
    if (!inter) continue;
    const union = bt.size + rt.size - inter;
    if (union > 0 && inter / union < 0.5) continue;
    // 判冲突必须两侧都能撮到具体取值，且至少一个值不同。
    // 旧写法只要求本侧有值，对面没有该值就算冲突 —— 等于「凡带数字就冲突」。
    const ov = values(r.body);
    if (!ov.size) continue;
    let diff = false;
    for (const v of nv) if (!ov.has(v)) { diff = true; break; }
    if (diff) return r;
  }
  return null;
}

/**
 * 写入一条印象。返回 {id, action, kind} 或 null。
 * action: new / merged / skipped
 */
/* ---------- 冲突覆盖：新规矩进来，同类旧说法该退场 ----------
 * 踩过的坑（2026-11-14 他亲手点出来）：11-05 那条「重启要用 schtasks 计划任务」
 * 被引用 400 次、权重涨到 3.0；11-13 他改口「固定用桌面 bat、别自建计划任务」，
 * 新的一条权重只有 1.0 —— 于是旧的一直压着新的，直到他在 3D 图里点开才发现。
 * 现在写入规矩类记忆时先扫一遍同类：足够像、且方向相反（一边「要」一边「不要」），
 * 就把旧的标 superseded，并在 gist 里写明被谁取代。
 *
 * 判断方向时「不要」优先：像「不要自建计划任务，固定用桌面 bat」这种混合句，
 * 它的本意是纠正旧的「要自建」，按否定记账才对。
 */
const NEG_W = /(别|不要|不用|不需要|禁止|避免|不能)/;
const POS_W = /(要|必须|应该|固定用|一律|统一|记得)/;
const dirOf = (s) => (NEG_W.test(String(s || '')) ? -1 : (POS_W.test(String(s || '')) ? 1 : 0));

function flagConflict(db, { id, text, kind }) {
  if (kind !== 'pref' && kind !== 'lesson') return null;
  const mine = dirOf(text);
  if (!mine) return null;               // 方向都不明的，不判
  const mineKeys = tokens(text);
  let rows = [];
  try {
    rows = db.prepare(
      "SELECT id, body, uses, weight FROM impressions WHERE status='active' AND id<>? AND kind IN ('pref','lesson') ORDER BY created DESC LIMIT 300"
    ).all(id);
  } catch { return null; }

  for (const r of rows) {
    const d = dirOf(r.body);
    if (!d || d === mine) continue;     // 同向的不算冲突
    // 用「共享实词」而不是 sim：实测那对真冲突的句子 sim 只有 0.10 ——
    // 「重启要用 schtasks」和「不要自建计划任务、固定用桌面 bat」讲的是同一件事，
    // 但 bigram 几乎不重合。门槛降到能抓住它，就会把毫不相干的两条也抓进来。
    const theirs = tokens(r.body);
    let common = 0;
    for (const t of mineKeys) if (theirs.has(t)) common += 1;
    if (common >= 3) return { oldId: r.id, common, dir: d, uses: r.uses };
  }
  return null;
}

export function writeImpression(db, { body, kind, role = 'user', sceneId = '', project = '', certainty, eventIds = [] }) {
  const text = clip(body, 400);
  if (!text) return null;
  if (!kind) return null;

  // 质量闸：以前只拦空串，于是「啊啊啊」「1」「好」这种也会被当成一条记忆写进库，
  // 检索时和白捡的分一样参与排序，等于往池子里倒沙子。
  // 三条底线：至少有点长度、有文字字符、不是同一个字重复。
  const meaningful = (s) => {
    const t = String(s || '').trim();
    if (t.length < 6) return false;
    if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(t)) return false;
    const uniq = new Set(t.replace(/[\s\p{P}]/gu, '').split('')).size;
    if (uniq <= 2) return false;
    return true;
  };
  if (!meaningful(text)) return null;

  const { dup, near } = findSimilar(db, text, kind);

  // ① 重复：只给旧条加分，不新建
  if (dup) {
    // weight 必须有上限。原来是无上限 +0.3，一条被反复提起的印象能涨到几十，
    // 而 recall 的公式里 weight 又不参与（见 recall.js），等于白涨还污染统计。
    db.prepare(
      `UPDATE impressions SET weight = MIN(3.0, weight + 0.3), certainty = MIN(1.0, certainty + 0.05),
       uses = uses + 1, last_use = ? WHERE id = ?`
    ).run(now(), dup.id);
    return { id: dup.id, action: 'merged', kind };
  }

  // ② 冲突：旧的失效，不删
  const conflict = findConflict(db, text, kind);

  const id = newId('imp');
  const t = now();
  const conf = typeof certainty === 'number'
    ? certainty
    : (role === 'user' ? 0.9 : 0.6);
  const proj = project || projectOf(text);

  // 「谁的事」在写库这一刻就定死。以前全靠 think.js 事后拿
  // /^(他说|他要|他让…)/ 去猜正文开头，427 条里猜对 4 条（0.9%）——
  // 因为库里存的都是压缩过的第三人称短句，根本不带"他说"。
  // 现在 role 就是答案：user 说的就是他的事，assistant 说的才是我的活。
  const who = role === 'user' ? 'his' : 'mine';

  db.prepare(
    `INSERT INTO impressions
     (id, created, happened, kind, body, gist, certainty, weight, uses, last_use, level, project, expires, src, scene, status, who)
     VALUES (?,?,?,?,?,?,?,?,0,NULL,'clear',?,NULL,?,?, 'active',?)`
  ).run(
    id, t, t, kind, text, clip(text, 60), conf,
    kind === 'lesson' ? 1.5 : 1.0,   // 教训天生更重
    // src 存真实来源事件 id。之前这里硬编码成 '[]'，等于把「这条记忆来自哪一轮」永久丢掉，
    // 想回溯某条印象是从哪句话里抽出来的就永远查不到了。
    proj, JSON.stringify(Array.isArray(eventIds) ? eventIds : []), sceneId, who
  );

  // 新规矩可能和旧的同类说法方向相反。这里只报警、不自动改库：
  // 「同一件事」在中文里用词差异太大（实测真冲突的一对 sim 只有 0.10），
  // 规则判准的那天再打开自动降级，现在先让日志把候选攒起来。
  try {
    const sw = flagConflict(db, { id, text, kind });
    if (sw) {
      console.warn(`[brain] 疑似冲突：新 ${id} 与旧 ${sw.oldId}（旧条用过 ${sw.uses} 次、方向相反、共享 ${sw.common} 个实词）——建议核对后手动作废旧条`);
    }
  } catch { /* 判不出来就当没发生，不影响写入 */ }

  // 全文索引（自切二元组，存进 tok 列）
  // rowid 必须跟 impressions 对齐，不能取 imp_fts 自己的 MAX(rowid)+1 ——
  // 旧写法第二次起就撞 fts 主键，异常被下面吞掉，几百条印象只有几十条真进了索引。
  try {
    const row = db.prepare('SELECT rowid AS r FROM impressions WHERE id = ?').get(id);
    if (row) {
      db.prepare('INSERT OR REPLACE INTO imp_fts (rowid, body, tok) VALUES (?, ?, ?)')
        .run(row.r, text, [...tokens(text)].join(' '));
    }
  } catch (err) {
    console.warn('[brain] FTS 索引写入失败:', id, err && err.message);
  }

  // 场景挂载
  if (sceneId) addSceneMember(db, sceneId, id, text);

  // ③ 因果：认标记词，但不再无脑连上一句
  //    旧做法是「因 = 全局上一条 active 印象」，隔八小时的两件不相干事也能连成因果；
  //    CAUSE_MIN_REL 又只有 0.12，几乎不设防。现在只在同场景最近 5 条里挑最相关的，
  //    门槛 0.35，并且走 addCause —— 有环检测、有证据校验、倒挂自动降级。
  const ck = causeKind(text);
  if (ck) {
    const cands = sceneId
      ? db.prepare(
        "SELECT id, body, happened, created FROM impressions WHERE status = 'active' AND id != ? AND scene = ? ORDER BY created DESC LIMIT 5"
      ).all(id, sceneId)
      : db.prepare(
        "SELECT id, body, happened, created FROM impressions WHERE status = 'active' AND id != ? ORDER BY created DESC LIMIT 5"
      ).all(id);
    let prev = null;
    let best = 0;
    for (const c of cands) {
      const prevTs = c.happened || c.created || 0;
      if (prevTs > t) continue;            // 果不能早于因：倒挂的候选根本不参与挑
      const rel = sim(text, c.body || '');
      if (rel > best) { best = rel; prev = c; }
    }
    if (prev && best >= CAUSE_MIN_REL) {
      addCause(db, {
        cause: prev.id,
        effect: id,
        kind: ck.kind,
        // verified 留 0：这条是从话里的标记词猜的，没人验证过它真的成立
        certainty: role === 'user' ? 0.75 : 0.6,
        evidence: eventIds,
        by: role === 'user' ? 'auto-user' : 'auto-assistant',
        why: {
          t: 'cause', mark: ck.mark, ts: t, src: eventIds, by: role,
          rel: Number(best.toFixed(3)), scene: sceneId || '',
        },
      });
    }
  }

  // ④ 重复关系：讲过好几次的，连一条 repeat
  if (near) {
    const whyRepeat = JSON.stringify({
      t: 'repeat', ts: t, other: clip(near.body, 60), src: eventIds,
    });
    db.prepare(
      `INSERT INTO bonds (a, b, kind, w, why) VALUES (?, ?, 'repeat', 0.5, ?)
       ON CONFLICT(a, b, kind) DO UPDATE SET w = MIN(2.0, w + 0.5)`
    ).run(near.id, id, whyRepeat);
  }

  // ⑤ 同在：同场景最近 5 条连边
  if (sceneId) {
    const scene = db.prepare('SELECT title, project FROM scenes WHERE id = ?').get(sceneId);
    const siblings = db.prepare(
      "SELECT id FROM impressions WHERE scene = ? AND id != ? ORDER BY created DESC LIMIT 5"
    ).all(sceneId, id);
    for (const s of siblings) {
      const whyCo = JSON.stringify({
        t: 'co', scene: sceneId, sceneTitle: scene ? scene.title : '', ts: t, src: eventIds,
      });
      db.prepare(
        `INSERT INTO bonds (a, b, kind, w, why) VALUES (?, ?, 'co', 0.5, ?)
         ON CONFLICT(a, b, kind) DO NOTHING`
      ).run(s.id, id, whyCo);
    }
  }

  /* ⑥ 关键词邻居。
   * 上面两种判据在拆解产物上全都失效：
   *   · repeat 要「几乎一样」——拆出来的每条都不同，永远不触发；
   *   · co 要 sceneId——拆解时没有场景，也触发不了。
   * 结果 2026-11-14 实测：1017 条记忆只剩 49 条关系，图成散沙。
   * 这里按「共享实词 ≥ 2」再连一次，把有共同话题的条目接起来。
   */
  try {
    const mine = tokens(text);
    if (mine.size >= 2) {
      const cands = db.prepare(
        "SELECT id, body FROM impressions WHERE status='active' AND id != ? ORDER BY created DESC LIMIT 200"
      ).all(id);
      const scored = [];
      for (const c of cands) {
        const theirs = tokens(String(c.body || ''));
        if (!theirs.size) continue;
        const [small, big] = mine.size <= theirs.size ? [mine, theirs] : [theirs, mine];
        let hit = 0;
        for (const t of small) if (big.has(t)) hit += 1;
        if (hit >= 2) scored.push({ id: c.id, hit });
      }
      scored.sort((a, b) => b.hit - a.hit);
      const ins = db.prepare(
        `INSERT INTO bonds (a, b, kind, w, why) VALUES (?, ?, 'co', ?, ?)
         ON CONFLICT(a, b, kind) DO UPDATE SET w = MAX(w, excluded.w)`
      );
      for (const s of scored.slice(0, 3)) {
        const [x, y] = id < s.id ? [id, s.id] : [s.id, id];
        ins.run(x, y, Number(Math.min(0.8, 0.3 + s.hit * 0.1).toFixed(2)), `共享 ${s.hit} 个词`);
      }
    }
  } catch { /* 连不上不影响写入 */ }

  if (conflict) {
    // 方向：旧说法 → 新说法。之前写反了，箭头指向了过去，时间上就成了「果早于因」。
    // 注意顺序：必须先把边连上再降级旧印象 —— addCause 的 idOf 只认 active，
    // 先 supersede 会让这条边连不出来。
    addCause(db, {
      cause: conflict.id,
      effect: id,
      kind: 'direct',
      // 旧写法直接写 verified=1、certainty=0.95，跟上面「verified 留 0」自相矛盾。
      // 这是拿正则比出来的「取值不一样」，没有任何人确认过，只能算待复核。
      certainty: 0.5,
      evidence: eventIds,
      by: 'auto-conflict',
      why: {
        t: 'cause', mark: '取值变了', ts: t, src: eventIds,
        note: `新说法覆盖旧说法：${clip(conflict.body || '', 60)}`,
      },
    });
    // 关系重连：旧条目被新说法覆盖后，原来挂在它身上的关系边和因果边
    // 还指着那条 superseded 的记忆 —— 读到一半就断了。
    // 这里把边转接到新版本上，链路不断。
    try {
      const bonds = db.prepare(
        'SELECT a, b, kind, w, why FROM bonds WHERE a = ? OR b = ?'
      ).all(conflict.id, conflict.id);
      for (const b of bonds) {
        const na = b.a === conflict.id ? id : b.a;
        const nb = b.b === conflict.id ? id : b.b;
        if (na === nb) continue;
        try {
          db.prepare(
            `INSERT INTO bonds (a, b, kind, w, why) VALUES (?,?,?,?,?)
             ON CONFLICT(a, b, kind) DO UPDATE SET w = MIN(2.0, w + excluded.w)`
          ).run(na, nb, b.kind, b.w, b.why);
          db.prepare('DELETE FROM bonds WHERE a = ? AND b = ? AND kind = ?').run(b.a, b.b, b.kind);
        } catch { /* 单条失败不阻断 */ }
      }
      db.prepare('UPDATE causes SET cause = ? WHERE cause = ? AND effect != ?').run(id, conflict.id, id);
      db.prepare('UPDATE causes SET effect = ? WHERE effect = ? AND cause != ?').run(id, id, conflict.id);
    } catch { /* 转接失败不阻断写入 */ }
    db.prepare("UPDATE impressions SET status = 'superseded' WHERE id = ?").run(conflict.id);
  }

  return { id, action: conflict ? 'supersede' : 'new', kind, conflict: conflict ? conflict.id : null };
}

/** 因果连线的最低相关度：太低说明两句根本不是一件事，宁可不连。0.12 等于不设防 */
const CAUSE_MIN_REL = 0.35;

/* ---------------- 一整轮 ---------------- */

/**
 * 一轮对话写进来。
 * @returns {{events:number[], impressions:Array}}
 */
export function ingestTurn(db, { user = '', assistant = '', session = '', turn = 0, project = '' }) {
  const out = { events: [], impressions: [] };
  const t = now();

  // 事件一律入库，一字不改
  for (const [role, body] of [['user', user], ['assistant', assistant]]) {
    if (!String(body || '').trim()) continue;
    const id = recordEvent(db, { role, body, session, turn, project });
    if (id) out.events.push(id);
  }
  if (!out.events.length) return out;

  // 整轮写进一个事务。writeImpression 一次要发六到九条独立语句
  // （印象、FTS、场景成员、因果、bond……），中途抛错就留下「印象进去了、
  // 索引没写、因果没连」的半截数据；index.js 那边还有 withTimeout 包着，
  // 超时后 Promise 被丢掉，而 SQLite 那几行照样在写。
  // 事件在事务外（原文必须先落地），印象与标记要么全成要么全废。
  const ownTx = !db.inTransaction;
  if (ownTx) db.exec('BEGIN IMMEDIATE');
  try {
  const scene = resolveScene(db, { text: user || assistant, project });
  touchScene(db, scene.id);

  const userKind = classify(user, 'user');

  // 用户侧：分类 → 写入
  // 含「A 因为 B」的句子拆成两条（果 + 因），再连一条因果边——
  // 合成一条的话，以后问「为什么」和问「出了什么事」都只能命中一半。
  const split = splitCause(user);
  if (split) {
    const eff = writeImpression(db, {
      body: split.effect, kind: userKind || 'fact', role: 'user', sceneId: scene.id, project,
      eventIds: out.events,
    });
    const cau = writeImpression(db, {
      body: split.cause, kind: 'fact', role: 'user', sceneId: scene.id, project, certainty: 0.85,
      eventIds: out.events,
    });
    if (eff && cau) {
      // 用户亲口说的「A 因为 B」，比从标记词里猜的可信一档，但仍然不是「被验证过」的，
      // verified 只能由 verifyCause 置 1。
      addCause(db, {
        cause: cau.id,
        effect: eff.id,
        kind: split.kind,
        certainty: 0.85,
        evidence: out.events,
        by: 'auto-split',
        why: { t: 'cause', mark: split.mark, ts: now(), src: out.events },
      });
      // 同一句话拆出来的两条，写得有先后，但事情是同时发生的。
      // 把「因」的时间钉在「果」之前，否则时间先验会把它们判成倒挂。
      try {
        const tc = db.prepare('SELECT COALESCE(happened, created) t FROM impressions WHERE id=?').get(cau.id)?.t || now();
        db.prepare('UPDATE impressions SET happened = ? WHERE id = ?').run(tc, eff.id);
        db.prepare('UPDATE impressions SET happened = ? WHERE id = ?').run(tc - 0.002, cau.id);
      } catch { /* 时间戳修不了也不影响主流程 */ }
      out.impressions.push(eff, cau);
    } else if (eff) out.impressions.push(eff);
  } else {
    // 一整段里常常塞着好几条不相干的事。整段入库会让它们永远绑在一起，
    // 后面判规矩、判矛盾全被牵连（「不要改我的 purge」那次的误报就是这么来的）。
    const pieces = splitSentences(user);
    if (pieces.length > 1) {
      for (const pc of pieces) {
        const k = classify(pc, 'user');
        if (!k || isProcessNarrative(pc)) continue;
        const r = writeImpression(db, {
          body: pc, kind: k, role: 'user', sceneId: scene.id, project,
          eventIds: out.events,
        });
        if (r) out.impressions.push(r);
      }
    } else if (userKind && !isProcessNarrative(user)) {
      // 之前这里漏了 eventIds，96% 的印象 src 是空数组，
      // 因果边找不到「哪一轮对话催出来的」这条线索。
      const r = writeImpression(db, {
        body: user, kind: userKind, role: 'user', sceneId: scene.id, project,
        eventIds: out.events,
      });
      if (r) out.impressions.push(r);
    }
  }

  // 我这一侧：只收教训/方法/事实，且必须不是过程话
  const asKind = classify(assistant, 'assistant');
  if (asKind && (asKind === 'lesson' || asKind === 'method' || asKind === 'fact')) {
    const body = clip(assistant, 400);
    if (!isProcessNarrative(body)) {
      const r = writeImpression(db, {
        body, kind: asKind, role: 'assistant', sceneId: scene.id, project, certainty: 0.6,
      });
      if (r) out.impressions.push(r);
    }
  }

  // 事件标记（原文永远留着）。只有真抽出印象才算 distilled；
  // 一条都没抽出来的是 skipped —— 之前无条件写 distilled，等于告诉后台
  // 「这轮我消化过了」，其实什么都没留下，那批内容从此再没人看。
  const digestMark = out.impressions.length ? 'distilled' : 'skipped';
  for (const id of out.events) {
    db.prepare('UPDATE events SET digest = ? WHERE id = ?').run(digestMark, id);
  }

  if (ownTx) db.exec('COMMIT');
  } catch (err) {
    if (ownTx) {
      try { db.exec('ROLLBACK'); } catch { /* 回滚本身失败也只能继续往上抛 */ }
    }
    // 全废：印象没落库，事件也不标消化，下一轮还能重来。
    out.impressions.length = 0;
    out.events.length = 0;
    out.error = (err && err.message) || String(err);
    console.warn('[brain] ingestTurn 写入失败，已回滚:', out.error);
    return out;
  }

  // 向量后台补：不 await，不阻塞这一轮，失败就当没有
  if (out.impressions.length) {
    void (async () => {
      try {
        const { init, encode, toBlob } = await import('./embed.js');
        const { invalidateCache } = await import('./recall.js');
        const st = await init({ allowRemote: false });
        if (!st.ok) return;
        for (const r of out.impressions) {
          const row = db.prepare('SELECT body FROM impressions WHERE id = ?').get(r.id);
          if (!row) continue;
          const v = await encode(row.body);
          if (!v) continue;
          db.prepare('INSERT OR REPLACE INTO vectors (id, dim, vec, ts) VALUES (?,?,?,?)')
            .run(r.id, v.length, toBlob(v), now());
        }
        invalidateCache();
      } catch { /* 向量失败不影响任何东西 */ }
    })();
  }

  return out;
}
