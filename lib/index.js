/**
 * index.js —— DSH 宿主插件入口
 *
 * ⚠️ 安全约束（上一版进过三次安全模式，这里按最保守的写法）
 *   1. 纯宿主代码：package.json 里没有 dsh.client，不放任何 client.js
 *   2. inject = []：不依赖任何 DSH 服务
 *   3. 模块顶层不做任何 IO；一切在 apply 里 try/catch
 *   4. 每个 hook 都有超时；最坏结果是「记忆不工作」，绝不让 DSH 起不来
 *
 * 两个事件：
 *   system-prompt/assemble  → 注入「现在 / 我记得 / 我的说话样本」
 *   session/event turn/end  → 写事件 + 提炼印象
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, stats } from './db.js';
import { buildInjection, afterInject } from './inject.js';
import { ingestTurn, writeImpression, recordEvent } from './write.js';
import { extractByModel } from './extract-model.js';
import { tidyBatch } from './tidy-model.js';
import { judgeBatch } from './cause-model.js';
import { addCause } from './cause.js';
import { loadPushConfig, pushText } from './push.js';
import { runForgetting } from './forget.js';
import { pickProactive, markProactive, proactiveState } from './proactive.js';
import { think, recentlySaid, rememberSaid, inQuietHours, polish } from './think.js';
import { buildDigests } from './digest.js';
import { createDbStore, bindSelf } from './db-store.js';
import { setName, getName } from './self.js';
import { registerBrainTools, bindCauseDb } from './tools.js';
import { recordSent, judgeLast } from './feedback.js';
import { consolidate } from './consolidate.js';
import { extractCauses } from './cause-extract.js';

export const name = 'brain';
export const inject = [];

const INJECT_TIMEOUT_MS = 800;
const WRITE_TIMEOUT_MS = 2000;

let warned = new Set();
function warnOnce(logger, key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  try { logger?.warn?.(`[brain] ${msg}`); } catch { /* ignore */ }
}

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/* ---------------- 事件体取文本 ----------------
 * 踩过的坑：user 事件的正文在 data.content，
 * assistant 事件在 data.message.content。只读一种就会把其中一侧读成空。
 */
function textOf(event) {
  const d = event && event.data;
  if (!d) return '';
  const content = Array.isArray(d.content) ? d.content : (d.message && d.message.content);
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
}

/** 取某一轮的 user / assistant 文本 */
function extractTurn(events, turn) {
  const startIdx = events.findLastIndex(
    (e) => e.type === 'turn/start' && e.data && e.data.turn === turn
  );
  if (startIdx < 0) return { user: '', assistant: '' };
  const endIdx = events.findIndex(
    (e, i) => i > startIdx && e.type === 'turn/end' && e.data && e.data.turn === turn
  );
  const win = events.slice(startIdx + 1, endIdx < 0 ? events.length : endIdx);
  let user = '';
  let assistant = '';
  for (const ev of win) {
    const t = textOf(ev);
    if (!t) continue;
    if (ev.type === 'user/message') {
      // 只认真人说的话。宿主塞的 runtime-context / time-context / goal 一律不算，
      // 不然原文层全是 "Current runtime context. This snapshot supersedes…"
      const kind = ev.data && ev.data.source && ev.data.source.kind;
      if (kind && kind !== 'user' && kind !== 'agent-message') continue;
      if (isHostNoise(t)) continue;
      user = t;
    } else if (ev.type === 'assistant/message') {
      assistant = t;
    }
  }
  return { user, assistant };
}

/** 宿主塞进来的合成消息（不是人说的话）。函数声明，会提升，上面能直接用。 */
function isHostNoise(text) {
  return /^(<|Time sampled|Current runtime context|\[OPERATOR ANCHOR)/.test(String(text || ''));
}
function lastUserText(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev.type !== 'user/message') continue;
    const kind = ev.data && ev.data.source && ev.data.source.kind;
    if (kind === 'time-context' || kind === 'runtime-context' || kind === 'goal') continue;
    const t = textOf(ev);
    if (!t) continue;
    if (isHostNoise(t)) continue;
    return t.slice(0, 200);
  }
  return '';
}

/* ---------------- 控制台服务（跟着 DSH 起落） ---------------- */

const CONSOLE_BASE = 'http://127.0.0.1:8737';
// 内置控制台脚本的路径（可选）。默认留空：没配控制台就不会去起这个服务。
// 想用的话，把这里改成你自己的 server.mjs 路径，再把 config.console 打开。
const DEFAULT_CONSOLE_SCRIPT = '';
// ⚠️ 在 Electron 里 process.execPath 是 DSH NEXT.exe，不是 node！
// 用它去 spawn 等于又开一个 DSH。必须显式找真正的 node。
const NODE_CANDIDATES = [
  'C:/Program Files/nodejs/node.exe',
  'C:/Program Files (x86)/nodejs/node.exe',
];

/**
 * 拉起本地控制台服务。
 * 已经被别人拉起来（端口活着）就直接返回 null，不起第二份。
 * 进程挂在这个插件的生命周期上：DSH 退出时 ctx.effect 会把它 kill 掉。
 */
async function startConsole(script, logger) {
  if (!script || !existsSync(script)) return null;
  try {
    const r = await fetch(CONSOLE_BASE + '/api/ping', { signal: AbortSignal.timeout(800) });
    if (r.ok) return null;   // 已经在跑
  } catch { /* 没跑，继续 */ }
  try {
    const nodeBin = NODE_CANDIDATES.find((p) => existsSync(p))
      || process.env.BRAIN_NODE
      || process.execPath;
    const child = spawn(nodeBin, [script], {
      cwd: script.replace(/[\/]scripts[\/][^\/]+$/, ''),
      stdio: ['pipe', 'ignore', 'ignore'],   // stdin 一断它就自己退
      windowsHide: true,
      detached: false,
    });
    child.on('error', (e) => warnOnce(logger, 'console', `控制台启动失败：${e.message}`));
    return child;
  } catch (e) {
    warnOnce(logger, 'console', `控制台启动异常：${e.message}`);
    return null;
  }
}

/* 直连聊天通道已于 2026-11-06 整体移除：主动推送改走 IM 插件的投递能力。 */

/* 上次跑遗忘的时间：模块级，进程重启后归零，第一轮就会补跑一次 */
let lastForget = 0;
/* 上次重算小结的时间：两小时一次就够，纯本地，很便宜 */
let lastDigest = 0;
/* 上次补向量的时间 */
let lastVec = 0;

/* ---------------- 主动开口的日上限 ----------------
 * 原来只有「同类信号今天说过一次就压一半」这一道软闸，可 tick 是 30 分钟一次：
 * 只要信号够强，一天能发几十条。那不是主动，是刷屏。
 * 现在给一条硬线：一天最多两句话，跨重启也记得（落 meta 的 k/v）。
 */
const SAY_KEY = 'proactive_daily';
const MAX_SAY_PER_DAY = 2;

function dayKeyLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function saidToday(db) {
  try {
    const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(SAY_KEY);
    const o = row ? JSON.parse(row.v) : null;
    if (o && o.day === dayKeyLocal()) return Number(o.n) || 0;
  } catch { /* 读不到就当今天还没说过 */ }
  return 0;
}

function bumpSaid(db) {
  try {
    const n = saidToday(db) + 1;
    db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
      .run(SAY_KEY, JSON.stringify({ day: dayKeyLocal(), n }));
  } catch { /* 记不上就算了，下轮还会数 */ }
}

/* ---------------- 面板数据（同源路由用） ----------------
 * 「记忆」面板跑在 DSH 自己的页面里，而 DSH 给页面下发的 CSP 是
 *   default-src 'none'; ... connect-src 'self'; ...
 * 面板以前直接 fetch http://127.0.0.1:8737/api/stats，属于跨源，被浏览器
 * 当场掐断，只剩一句 TypeError: Failed to fetch —— 于是六个统计卡永远显示「—」。
 * 这里改成由宿主挂一条同源路由，页面用相对路径取，CSP 就放行了。
 * 字段和 scripts/server.mjs 的 /api/stats 对齐，面板不用改渲染逻辑。
 */
function panelStats(db) {
  const one = (sql) => {
    try { const r = db.prepare(sql).get(); return r ? Object.values(r)[0] : 0; } catch { return 0; }
  };
  const out = {
    impressions: one("SELECT COUNT(*) c FROM impressions WHERE status='active'"),
    events: one('SELECT COUNT(*) c FROM events'),
    raw: one("SELECT COUNT(*) c FROM events WHERE digest='raw'"),
    scenes: one('SELECT COUNT(*) c FROM scenes'),
    bonds: one('SELECT COUNT(*) c FROM bonds'),
    causes: one("SELECT COUNT(*) c FROM causes WHERE status!='disproven'"),
    vectors: one('SELECT COUNT(*) c FROM vectors'),
    voice: one('SELECT COUNT(*) c FROM voice'),
    byKind: {},
    recent: [],
  };
  try {
    for (const r of db.prepare("SELECT kind, COUNT(*) c FROM impressions WHERE status='active' GROUP BY kind").all()) {
      out.byKind[r.kind] = r.c;
    }
  } catch { /* ignore */ }
  try {
    out.recent = db.prepare(
      "SELECT id, kind, body, certainty, uses, created FROM impressions WHERE status='active' ORDER BY created DESC LIMIT 40"
    ).all().map((m) => ({ ...m, body: String(m.body || '').slice(0, 200) }));
  } catch { /* ignore */ }
  return out;
}

/* ---------------- 插件主体 ---------------- */

export function apply(ctx, config = {}) {
  // 探针：apply 一进来就落一个文件，用来分清「代码没跑」和「日志被吞」
  try {
    const beacon = 'C:/Users/admin/.dsh/brain/apply-beacon.txt';
    writeFileSync(beacon, `apply entered ${new Date().toISOString()} v=4 tools=${typeof ctx?.tools?.register} effect=${typeof ctx?.effect} logger=${typeof ctx?.logger?.info}
`);
  } catch { /* 探针失败不影响主流程 */ }
  let handle = null;
  try {
    handle = openDb(config.dataDir);
  } catch (e) {
    // 库都开不了，就什么都不做——绝不阻塞 DSH 启动
    warnOnce(ctx.logger, 'opendb', `打开数据库失败，记忆功能停用：${e.message}`);
    return;
  }

  const { db } = handle;
  const enabled = config.enabled !== false;
  const injectEnabled = config.inject !== false;

  // 关键：cordis 不允许直接读 ctx.tools，必须先在 inject(['tools']) 里拿到手。
  // 之前直接 registerBrainTools(ctx, ...) 会抛 "cannot get property "tools" without inject"，
  // 被 try/catch 吞掉，所以工具一直是死的（文件在、功能没生效）。
  try {
    const store = createDbStore(db);
    bindSelf({ setName });
    bindCauseDb(db);
    // 压缩：把一柜子碎片压成几条「那阵子在干什么」。开机跑一次，压坏了原文还在。
    try {
      const cg = consolidate(db);
      if (cg.made) ctx.logger?.info?.(`[brain] 压缩：新增/更新 ${cg.made} 条小结`);
    } catch { /* 压不动就先不压 */ }
    const reg = ctx.inject(['tools'], (tctx) => {
      const log = tctx?.logger || ctx.logger;
      try {
        const disposeTools = registerBrainTools(tctx, store, log);
        if (typeof disposeTools === 'function') {
          tctx.effect(() => disposeTools, 'brain: tools');
        }
        log?.info?.('[brain] 工具已注册：brain_remember / brain_recall / brain_forget / brain_rename');
        try {
          writeFileSync(join(config.dataDir, 'boot-check.json'), JSON.stringify({
            ts: Date.now(),
            at: new Date().toISOString(),
            toolsRegister: typeof tctx?.tools?.register,
            disposed: typeof disposeTools,
            storeSize: store.size,
            name: (() => { try { return getName(db); } catch { return ''; } })(),
          }, null, 2));
        } catch { /* 自检文件写不进不影响主流程 */ }
      } catch (e) {
        try { writeFileSync('C:/Users/admin/.dsh/brain/tools-error.txt', `${new Date().toISOString()} ${e.constructor.name}: ${e.message}
${e.stack}
`); } catch {}
        warnOnce(log, 'tools', `工具注册失败（记忆照常工作）：${e.message}`);
      }
    });
    if (reg && typeof reg.catch === 'function') reg.catch(() => {});
  } catch (e) {
    try { writeFileSync('C:/Users/admin/.dsh/brain/tools-error.txt', `${new Date().toISOString()} inject: ${e.message}
${e.stack}
`); } catch {}
    warnOnce(ctx.logger, 'tools', `工具注册失败（记忆照常工作）：${e.message}`);
  }


  // 同源路由：面板数据（DSH 的 CSP 只允许 connect-src 'self'，见 panelStats 注释）
  let statsHits = 0;
  try {
    const panelRoute = ctx.inject(['webServer'], (wctx) => {
      try {
        const dispose = wctx.webServer.register({
          kind: 'exact',
          path: '/dsh-brain/api/stats',
          handler: (request, response) => {
            try {
              // 只记前几次：面板 15 秒轮询一次，全记会把日志刷满。
              // 这条日志是「路由到底有没有被页面请求到」的唯一现场证据 ——
              // CSP / 协议转发哪一环断了，看这里有没有命中就知道。
              if (statsHits < 3) {
                statsHits += 1;
                (wctx.logger || ctx.logger)?.info?.(`[brain] stats 路由命中 #${statsHits} ${request.method || ''} ${request.url || ''}`);
              }
              if (request.method !== 'GET') {
                response.writeHead(405, { allow: 'GET' });
                response.end();
                return;
              }
              const body = JSON.stringify(panelStats(db));
              response.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              });
              response.end(body);
            } catch (e) {
              try {
                response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
                response.end(JSON.stringify({ error: String((e && e.message) || e) }));
              } catch { /* 头都发出去了就只能断 */ }
            }
          },
        });
        if (typeof dispose === 'function') wctx.effect(() => dispose, 'brain: stats route');
        (wctx.logger || ctx.logger)?.info?.('[brain] 面板数据已挂到 /dsh-brain/api/stats');
      } catch (e) {
        warnOnce(ctx.logger, 'panel-route', `面板路由注册失败（不影响记忆）：${e.message}`);
      }
    });
    if (panelRoute && typeof panelRoute.catch === 'function') panelRoute.catch(() => {});
  } catch (e) {
    warnOnce(ctx.logger, 'panel-inject', `webServer 注入失败（不影响记忆）：${e.message}`);
  }

  try {
    const s = stats(db);
    ctx.logger?.info?.(`[brain] 就绪 ${handle.file} · 印象 ${s.impressions} · 事件 ${s.events}`);
  } catch { /* 统计失败无所谓 */ }

  // 退出时收尾（不需要停后台进程，只是提醒 flush）
  try {
    ctx.effect(() => () => {
      try { db.close(); } catch { /* ignore */ }
    }, 'brain: close db');
  } catch { /* ignore */ }

  // 控制台服务：跟 DSH 同生共死，不常驻、不装计划任务
  if (config.console !== false) {
    void startConsole(config.consoleScript || DEFAULT_CONSOLE_SCRIPT, ctx.logger).then((child) => {
      if (!child) return;
      ctx.logger?.info?.('[brain] 控制台已启动 127.0.0.1:8737');
      try {
        ctx.effect(() => () => {
          try { child.kill(); } catch { /* ignore */ }
        }, 'brain: console server');
      } catch { /* ignore */ }
    });
  }

  // 主动推送：借 IM 插件的投递能力（ctx.dshIm.send）
  if (config.push !== false) {
    let started = false;
    const TICK = 30 * 60 * 1000;
    // dshIm 是后到的：先来的可能是空句柄。所以句柄存成一个可替换的引用，
    // 真句柄再到就把旧的换掉——定时器每次都读最新的那个，不用重启。
    let imRef = null;
    const boot = (dshIm, llm) => {
      if (dshIm && typeof dshIm.send === 'function') imRef = dshIm;
      if (started) return;
      started = true;
      const cfg = loadPushConfig(config.dataDir);
      if (!cfg) {
        ctx.logger?.info?.('[brain] 主动推送未配置（去 IM 设置页配投递目标，把 botId/targetId 写进 ~/.dsh/brain/push.json）');
        return;
      }
      // 重启回执：脚本重启前会留一个标记文件，这里开机补发一条。
      // 教训：开机 4 秒就发，IM 还没把 bot 注册进来，返回 "Unknown bot"；
      // 老代码不管成没成都把标记删了，回执就这么无声消失了。
      // 现在：等一分钟、失败重试 4 次、只有真发出去才删标记。
      try {
        const flagFile = join(config.dataDir, 'notify-after-boot.json');
        if (existsSync(flagFile)) {
          const m = JSON.parse(readFileSync(flagFile, 'utf8') || '{}');
          if (m && m.text) {
            const trySend = (left) => {
              void pushText(imRef || dshIm, cfg, String(m.text), config.dataDir)
                .then((r) => {
                  ctx.logger?.warn?.(`[brain] 重启回执推送：${JSON.stringify(r)}`);
                  if (r && r.ok) {
                    try { unlinkSync(flagFile); } catch {}
                    return;
                  }
                  if (left > 0) setTimeout(() => trySend(left - 1), 45000);
                  else {
                    // 三次都没发出去就认了：记一笔，别无限重试也别装作发过
                    try {
                      writeFileSync(join(config.dataDir, 'notify-dropped.log'),
                        `${new Date().toISOString()} 回执三次都没发出去：${JSON.stringify(r)}
`, { flag: 'a' });
                    } catch {}
                    try { unlinkSync(flagFile); } catch {}
                  }
                })
                .catch(() => {
                  if (left > 0) setTimeout(() => trySend(left - 1), 45000);
                  else { try { unlinkSync(flagFile); } catch {} }
                });
            };
            // 一共三次（立刻 + 两次重试），失败就落盘留证
            setTimeout(() => trySend(2), 60000);
          }
        }
      } catch { /* 回执失败不影响任何东西 */ }

      ctx.logger?.info?.(`[brain] 主动推送就绪 bot=${String(cfg.botId).slice(0, 12)}… target=${cfg.targetId}`);
      // 自测：配置里 testOnStart 为真时，启动 15 秒后立刻发一条（无视静默期）
      if (cfg.testOnStart) {
        setTimeout(async () => {
          const r = await pushText(imRef || dshIm, cfg, cfg.testText || '这条是我自己发出来的，不是测试按钮。以后有话我就这么找你。', config.dataDir);
          ctx.logger?.warn?.(`[brain] 自测推送结果：${JSON.stringify(r)}`);
        }, 15000);
      }

      const tick = async () => {
        // 诊断：每轮必留一笔。之前 think 被跳过时整轮无日志，排查全靠猜。
        try { ctx.logger?.info?.(`[brain] tick ${new Date().toISOString().slice(11, 16)} 静默=${inQuietHours()}`); } catch {}
        // 家务活（遗忘）单独 try：它出问题不许连累主动开口。
        // 之前两者共用一个 try，遗忘里一个未声明变量就能让整个 tick 静默死掉。
        try {
          if (Date.now() - lastForget > 86400000) {
            lastForget = Date.now();
            const st = runForgetting(db);
            ctx.logger?.info?.(`[brain] 遗忘：模糊 ${st.blur} 条 · 沉底 ${st.sunk} 条 · 约定跳过 ${st.skipped} 条`);
          }
        } catch (e) {
          ctx.logger?.warn?.(`[brain] 遗忘失败（不影响开口）：${e && e.message}`);
        }
        // 补向量：工具写入、改名留痕这些路径原来不补向量，等于语义上隐形
        try {
          if (Date.now() - lastVec > 2 * 3600 * 1000) {
            lastVec = Date.now();
            const { backfillVectors } = await import('./vecfix.js');
            void backfillVectors(db, ctx.logger);
          }
        } catch (e) {
          ctx.logger?.warn?.(`[brain] 补向量失败：${e && e.message}`);
        }

        // 分层小结：纯本地计算，两小时重算一次
        try {
          if (Date.now() - lastDigest > 2 * 3600 * 1000) {
            lastDigest = Date.now();
            const d = buildDigests(db);
            if (d.made) ctx.logger?.info?.(`[brain] 小结：更新 ${d.made} 组`);
          }
        } catch (e) {
          ctx.logger?.warn?.(`[brain] 小结失败：${e && e.message}`);
        }

        try {
          // 「先想再开口」：think() 做五种推理——矛盾 / 复发 / 收尾 / 停滞 / 复现。
          // 想不出值得说的事就沉默，这一轮什么都不发；不是到点打招呼。
          if (inQuietHours()) return;
          // 硬上限：一天最多两句。之前只有「同类信号今天说过就压一半」这道软闸，
          // 配上 30 分钟一次的 tick，信号够强就能连发几十条 —— 那不是主动，是刷屏。
          if (saidToday(db) >= MAX_SAY_PER_DAY) {
            ctx.logger?.info?.(`[brain] 今天已经开口 ${MAX_SAY_PER_DAY} 次，收手`);
            return;
          }
          const t = think(db);
          const item = t.pick;
          if (!item) { ctx.logger?.info?.(`[brain] 想了但没说：${t.reason}`); return; }
          if (recentlySaid(db, item.id)) { ctx.logger?.info?.(`[brain] 这条七天内说过：${item.id}`); return; }

          // 有模型服务就把这句话润一下：还是同一件事、同一份依据，只是别说得像模板。
          // 拿不到 llm 就走原句；润色失败也走原句，绝不因为润色丢掉这次开口。
          let say = item.text;
          if (llmSvc && config.polish !== false) {
            try { say = await polish(item.text, llmSvc, ctx.logger); } catch { /* 用原句 */ }
          }

          const r = await pushText(imRef || dshIm, cfg, say, config.dataDir);
          if (r.ok) {
            rememberSaid(db, item.id);
            markProactive(db, item);
            recordSent(db, { ...item, text: say });
            bumpSaid(db);
            ctx.logger?.info?.(`[brain] 主动开口［${item.kind}｜${item.why}］今天第 ${saidToday(db)} 句 → ${say.slice(0, 40)}`);
          } else {
            ctx.logger?.warn?.(`[brain] 主动推送没成：${r.reason || '未知'}`);
          }
        } catch (e) {
          const detail = String((e && e.stack) || e).replace(/\s+/g, ' ').slice(0, 160);
          ctx.logger?.warn?.(`[brain] 主动检查失败：${detail}`);
        }
      };
      const timer = setInterval(() => { void tick(); }, TICK);
      setTimeout(() => { void tick(); }, 90000);
      try { ctx.effect(() => () => { try { clearInterval(timer); } catch {} }, 'brain: proactive'); } catch {}
      ctx.logger?.info?.(`[brain] 主动状态 ${JSON.stringify(proactiveState(db))}`);
    };

    // 探一下 llm 服务：能拿到就用模型组织语言，拿不到就用增强模板
    let llmSvc = null;
    try {
      const lr = ctx.inject(['llm'], (sctx) => {
        const l = sctx?.llm || null;
        llmSvc = l;
        const keys = l ? Object.keys(l).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(l) || {})).filter((k)=>k!=='constructor').join(',') : '无';
        // 直接点名：哪些是可调用的入口。之前只猜了 stream，拿到 0 个字，
        // 结果两轮都在瞎试 —— 把真实方法名列出来最快。
        const callable = l ? ['stream', 'generate', 'complete', 'chat', 'create', 'invoke', 'run', 'ask']
          .filter((k) => typeof l[k] === 'function').join(',') : '无';
        ctx.logger?.warn?.(`[brain] llm 可调方法：${callable || '（一个都没匹配上）'}`);
        ctx.logger?.warn?.(`[brain] llm 全部键：${keys}`);
        // stream 是唯一入口，但参数显然不对（拿回 0 个字）。看看官方那条路
        // resolveCallConfig/prepareCall 到底给出什么形状，照着填才可能通。
        void (async () => {
          // 解析必须带 provider+model，否则 no adapter registered。
          // 先看有哪些可用，再照着填。
          try {
            if (typeof l.listModels === 'function') {
              const m = await l.listModels();
              ctx.logger?.warn?.(`[brain] listModels() → ${JSON.stringify(m).slice(0, 500)}`);
            }
            if (typeof l.listProviders === 'function') {
              const p = await l.listProviders();
              ctx.logger?.warn?.(`[brain] listProviders() → ${JSON.stringify(p).slice(0, 300)}`);
            }
          } catch (e) {
            ctx.logger?.warn?.(`[brain] 列模型失败：${e && e.message}`);
          }
        })();
      });
      if (lr && typeof lr.catch === 'function') lr.catch(() => {});
    } catch {}

    try {
      const r = ctx.inject(['dshIm'], (sctx) => {
        const dshIm = sctx?.dshIm || null;
        ctx.logger?.warn?.(`[brain] dshIm 到手 send=${typeof dshIm?.send}`);
        boot(dshIm, llmSvc);
      });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) {
      warnOnce(ctx.logger, 'dshIm', `注入失败：${e.message}`);
    }
    setTimeout(() => { if (!started) boot(null); }, 8000);
  }

  if (!enabled) {
    ctx.logger?.info?.('[brain] enabled=false，只开库不挂 hook');
    return;
  }

  /* ---------------- 写入用的模型句柄 ----------------
   * 原来 llm 只在 push 开关里探过（给润色用），写入侧拿不到，
   * 于是"这一轮该记成什么"只能靠正则猜。这里单独探一个，跟 push 开关无关。
   */
  let brainLlm = null;
  try {
    const lr = ctx.inject(['llm'], (sctx) => {
      brainLlm = sctx?.llm || null;
      if (brainLlm) ctx.logger?.info?.('[brain] 写入侧已接上模型：由模型判断这一轮该记成什么');
    });
    if (lr && typeof lr.catch === 'function') lr.catch(() => {});
  } catch (e) {
    warnOnce(ctx.logger, 'llm-write', `llm 注入失败（退回正则抽取）：${e.message}`);
  }

  /* ---------------- 给一个 agent 挂读写钩子 ----------------
   * 抽成函数是为了热加载后能补绑：ctx.on('agent/created') 只在**新**会话创建时触发，
   * 插件热重载时当前会话早就存在了，不会再触发一次 —— 结果就是工具照常能用、
   * 每轮结束却不再写库，日志里连报错都没有（2026-11-14 实测踩到，十几分钟对话全丢）。
   */
  const boundAgents = new WeakSet();
  /* 同一轮只处理一次。
   * 实测 2026-11-14 02:42:00–02:42:05：同一轮对话连着触发 8 次，每条都是「8 件 → 入库 0 条」——
   * 热加载会让旧的 session/event 监听器留在那儿，新的又叠上去，插件越重载触发越多。
   * 光是白烧模型调用还好，更要命的是它在 6 秒内把同一条记忆判了 8 次重复。
   */
  const writeOnce = new Set();
  const bindAgent = (agent) => {
    if (!agent || !agent.ctx) return;
    if (boundAgents.has(agent)) return;   // 同一个 agent 只绑一次，否则会重复写
    boundAgents.add(agent);

    /* ---- 读：注入 ---- */
    if (injectEnabled) {
      agent.ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        const result = await next();
        try {
          const events = agent.session?.snapshotEvents?.() ?? [];
          const query = lastUserText(events);
          const out = await withTimeout(
            Promise.resolve().then(() => buildInjection(db, { query })),
            INJECT_TIMEOUT_MS,
            { text: '', bytes: 0, picks: 0, degraded: 'timeout', _picks: [] }
          );
          if (!out || !out.text) return result;

          const sections = Array.isArray(result?.sections)
            ? result.sections.filter((s) => s && s.name !== 'brain:memory')
            : [];
          sections.push({ name: 'brain:memory', order: 8800, text: out.text });

          afterInject(db, out);
          return { ...result, sections };
        } catch (e) {
          warnOnce(ctx.logger, 'inject', `注入失败（已跳过）：${e.message}`);
          return result;
        }
      });
    }

    /* ---- 写：一轮结束 ---- */
    agent.ctx.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'turn/end') return;
        if (session !== undefined && agent.session && session !== agent.session) return;
        const turn = event.data && event.data.turn;
        if (typeof turn !== 'number') return;

        const events = agent.session?.snapshotEvents?.() ?? [];
        const { user, assistant } = extractTurn(events, turn);
        if (!user && !assistant) return;

        const sessionId = agent.session?.id ?? '';
        const turnKey = `${sessionId}::${turn}`;
        if (writeOnce.has(turnKey)) return;
        writeOnce.add(turnKey);
        setTimeout(() => { try { writeOnce.delete(turnKey); } catch {} }, 120000);
        withTimeout(
          Promise.resolve().then(async () => {
            // 让模型判断「这一轮该记成几件事」，而不是把整轮塞成一条。
            // 模型的任何失败都退回原来的正则路线，绝不让记忆因此断掉。
            if (brainLlm && config.modelExtract !== false) {
              const out = await extractByModel(brainLlm, { user, assistant, logger: ctx.logger });
              if (out && out.items.length) {
                // 原文仍然进事件层（回溯要它）；rowid 顺便留作因果的证据
                const evIds = [];
                try {
                  const r1 = recordEvent(db, { role: 'user', body: user, session: sessionId, turn });
                  if (r1) evIds.push(String(r1));
                } catch {}
                try {
                  const r2 = recordEvent(db, { role: 'assistant', body: assistant, session: sessionId, turn });
                  if (r2) evIds.push(String(r2));
                } catch {}
                let n = 0;
                const written = [];
                for (const it of out.items) {
                  try {
                    const r = writeImpression(db, { body: it.text, kind: it.kind, role: 'user', eventIds: evIds });
                    if (r && r.id) written.push({ id: r.id, text: it.text });
                    n += 1;
                  } catch { /* 单条失败不影响其它 */ }
                }

                /* 因果接通。
                 * 以前模型给了 causes 却被我直接扔掉：因果图里挂的全是"你的原话"，
                 * 而记忆主体是"整理后的条目"，两套东西各自为政 ——
                 * 大记忆拆完就成孤岛，正是这个原因。
                 * 现在拿模型给的 cause/effect 文本，在**刚写的条目**里找对应的那条，
                 * 用它的 id 连边。找不到就不连，宁缺毋滥。
                 */
                const pick = (text) => {
                  const t = String(text || '').trim();
                  if (!t) return null;
                  let hit = written.find((w) => w.text === t);
                  if (hit) return hit.id;
                  // 模型常把 cause/effect 写成条目的一部分，或反过来带点修饰
                  hit = written.find((w) => w.text.includes(t) || t.includes(w.text));
                  if (hit) return hit.id;
                  // 落到全库找：因果两头常常是"早就记住的事"，不是本轮新写的
                  // （比如「国内的网」是好几天前的记忆，「用镜像」是它今天的结果）
                  try {
                    const KEY = t.length > 14 ? t.slice(0, 14) : t;
                    const row = db.prepare(
                      "SELECT id FROM impressions WHERE status='active' AND (body = ? OR body LIKE ?) ORDER BY uses DESC, length(body) ASC LIMIT 1"
                    ).get(t, `%${KEY}%`);
                    if (row && row.id) return row.id;
                  } catch { /* 查不到就不连 */ }
                  // 不再退到「字符重合度」那一步：中文里两个不同意思的句子字面重合也能很高，
                  // 宁可这条因果不连，也不要在图里塞一根假边。
                  return null;
                };
                let caused = 0;
                for (const c of (out.causes || [])) {
                  const cid = pick(c.cause);
                  const eid = pick(c.effect);
                  if (!cid || !eid || cid === eid) continue;
                  /* 证据不能用两端自己：addCause 里明写「两端自己不能给自己作证」，
                     传 [cid, eid] 会被全部剔掉，结果就是一条都连不上（2026-11-14 踩到）。
                     优先用本轮事件 rowid；没有就借本轮写的另一条当旁证；都没有就不连。 */
                  const ev = evIds.length
                    ? evIds
                    : written.filter((w) => w.id !== cid && w.id !== eid).map((w) => w.id).slice(0, 2);
                  if (!ev.length) continue;
                  try {
                    const r = addCause(db, { cause: cid, effect: eid, why: c.why || '', evidence: ev, certainty: 0.7, by: 'model' });
                    if (r && r.ok) caused += 1;
                  } catch { /* 连不上就算了，有环检测会拦 */ }
                }

                ctx.logger?.info?.(`[brain] 模型抽取：${out.items.length} 件事，入库 ${n} 条，连因果 ${caused} 条`);
                return;
              }
              ctx.logger?.info?.('[brain] 模型没抽出可记的事，走正则兜底');
            }
            return ingestTurn(db, { user, assistant, session: sessionId, turn });
          }),
          25000,
          null
        ).catch(() => null);

        // 你这一句话，也顺便裁决上一次主动开口到底有没有用（闭环的入口）
        try {
          const j = judgeLast(db, user || '');
          if (j) ctx.logger?.info?.(`[brain] 反馈：${j.kind} → ${j.verdict}（权重 ${j.weight}）`);
        } catch { /* 裁决失败不影响写入 */ }

        // 顺手从这一轮里挖因果：他说话时的「因为…所以…」就是真的因果线索，
        // 不用等他专门说「记一条」。挖不到就跳过，宁可漏也不瞎连。
        try {
          const cx = extractCauses(db, `${user || ''}\n${assistant || ''}`);
          if (cx.found) ctx.logger?.info?.(`[brain] 自动因果：+${cx.found} 条`);
        } catch { /* 抽不到就算了 */ }
      } catch (e) {
        warnOnce(ctx.logger, 'write', `写入失败（已跳过）：${e.message}`);
      }
    });
  };

  /* ---------------- 从关系里挖因果 ----------------
   * 对话里很少真说「因为…所以…」，靠句式抽永远只有个位数。
   * 这里换个问法：取已经连着的两条记忆，问模型「是不是一条导致了另一条」。
   * 判过的对会在 bonds.why 留痕，下次跳过，不会重复烧钱。
   */
  setTimeout(() => {
    let n = 0;
    const step = () => {
      if (n >= 300) { ctx.logger?.info?.('[brain] 因果挖掘本轮结束（300 批）'); return; }
      n += 1;
      judgeBatch(db, brainLlm, { addCause, logger: ctx.logger, batch: 2 })
        .then((r) => {
          if (!r) return setTimeout(step, 5000);
          if (r.done) { ctx.logger?.info?.(`[brain] 因果挖掘完成（本轮 ${n} 批）`); return; }
          setTimeout(step, r.ok ? 2000 : 4000);
        })
        .catch(() => setTimeout(step, 5000));
    };
    step();
  }, 25000);

  ctx.on('agent/created', ({ agent }) => bindAgent(agent));

  /* ---------------- 用模型捋顺旧记忆 ----------------
   * 一次一条（批量会被 reasoning 吃光配额，正文一个字不剩），
   * 一轮最多 30 条，间隔 3 秒；进度存 meta，随时能停、下次接着来。
   */
  setTimeout(() => {
    let n = 0;
    const step = () => {
      if (n >= 250) { ctx.logger?.info?.('[brain] 捋顺本轮结束（250 条），下次启动继续'); return; }
      n += 1;
      tidyBatch(db, brainLlm, { writeImpression, logger: ctx.logger })
        .then((r) => {
          if (!r) return setTimeout(step, 5000);
          if (r.done) { ctx.logger?.info?.(`[brain] 捋顺全部完成（本轮 ${n} 条）`); return; }
          setTimeout(step, r.ok ? 2500 : 800);
        })
        .catch(() => setTimeout(step, 5000));
    };
    step();
  }, 20000);

  // 补绑已经在跑的会话：热加载后这是唯一能救回写入的路。
  // 服务名不确定，几个候选都试一遍，拿到什么算什么；拿不到就只能在下次重启时恢复。
  setTimeout(() => {
    for (const svcName of ['agents', 'agent', 'agentRegistry', 'agentManager']) {
      try {
        ctx.inject([svcName], (sctx) => {
          const svc = sctx && sctx[svcName];
          if (!svc) return;
          let list = null;
          try { if (typeof svc.list === 'function') list = svc.list(); } catch {}
          if (!Array.isArray(list)) { try { if (typeof svc.all === 'function') list = svc.all(); } catch {} }
          if (!Array.isArray(list)) list = null;
          if (!Array.isArray(list)) return;
          let n = 0;
          for (const a of list) {
            if (a && a.ctx && !boundAgents.has(a)) { bindAgent(a); n += 1; }
          }
          if (n) ctx.logger?.info?.(`[brain] 补绑已有会话 ${n} 个（热加载后恢复写入）`);
        });
      } catch { /* 这个服务名不存在，换下一个 */ }
    }
  }, 3000);
}
