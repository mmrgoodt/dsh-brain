/**
 * proactive.js —— 主动开口：什么时候该我自己说一句
 *
 * 只决定「现在要不要主动发、发什么」，不接对话。
 * 成本模型：收益（关联度 × 新鲜度）明显大于打扰成本才开口。
 */
const SILENCE_FROM = 23;
const SILENCE_TO = 7;
const MAX_PER_DAY = 2;
const MAX_PER_ITEM_7D = 2;


/** 把一条记忆压成人话：去掉格式符、取第一句、限长 */
function humanize(body, max = 46) {
  let t = String(body || '')
    .replace(/^待办[：:]\s*/, '')
    .replace(/[*`#>|\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = t.search(/[。！？；]/);
  if (cut > 8 && cut < max) t = t.slice(0, cut);
  if (t.length > max) t = t.slice(0, max) + '…';
  return t;
}

/** 语气轻一点：按当前时段换一个开头 */
function opener() {
  const h = new Date().getHours();
  if (h < 5) return '这么晚还没睡';
  if (h < 11) return '早上好';
  if (h < 14) return '中午了';
  if (h < 18) return '下午好';
  return '晚上好';
}

const hourNow = () => new Date().getHours();
const inSilence = () => { const h = hourNow(); return h >= SILENCE_FROM || h < SILENCE_TO; };
const daysAgo = (sec) => (sec ? (Date.now() / 1000 - Number(sec)) / 86400 : 999);
const dayKey = () => new Date().toISOString().slice(0, 10);

function loadLedger(db) {
  try {
    // 表结构是 meta(k, v)，原来这里写的是 meta(key, value) —— 每句都抛
    // "no such column: value" 被 catch 吞掉，于是「今天开了几次口」永远是 0。
    const row = db.prepare("SELECT v FROM meta WHERE k='proactive_ledger'").get();
    const o = row ? JSON.parse(row.value) : null;
    if (o && o.day === dayKey()) return o;
  } catch {}
  return { day: dayKey(), count: 0, items: {} };
}
function saveLedger(db, led) {
  try {
    db.prepare("INSERT INTO meta(k,v) VALUES('proactive_ledger',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
      .run(JSON.stringify(led));
  } catch {}
}

/** 挑一件最值得开口的事；返回 {id,kind,score,text,why} 或 null */
export function pickProactive(db, { force = false } = {}) {
  if (!force && inSilence()) return null;
  const led = loadLedger(db);
  if (!force && led.count >= MAX_PER_DAY) return null;

  const cands = [];

  // ① 悬着的承诺：说了要办、三天没动静
  //    先过一道质量闸——库里有一批误报（把我的回答正文当成了待办），
  //    那些既长又不像人话，拿去开口会很蠢。
  // 黑名单制：只挡"明显不是待办"的，宁可多留几条让评分去筛
  const looksReal = (body) => {
    const b = String(body || '').trim();
    if (b.length < 6 || b.length > 70) return false;        // 太碎或像我or他说的整段话
    if (/^(待办|TODO|小结|结论|报告)/.test(b)) return false;  // 导入标记 / 文档标题
    if (b.length > 45 && /[。！？]$/.test(b)) return false;   // 长句带句号：一整段话
    if (/^(我|我们)(刚才|这轮|上一轮|已经)/.test(b)) return false; // 我的自述
    return true;
  };
  try {
    for (const p of db.prepare(`SELECT id, body, created FROM impressions
        WHERE status='active' AND kind='promise'
          AND created < strftime('%s','now','-3 days')
        ORDER BY created DESC LIMIT 20`).all()) {
      if ((led.items[p.id] || 0) >= MAX_PER_ITEM_7D) continue;
      if (!looksReal(p.body)) continue;
      cands.push({
        id: p.id, kind: 'pend',
        score: 0.6 + Math.min(0.3, daysAgo(p.created) / 30),
        text: `${opener()}，那句「${humanize(p.body)}」的事，后来动了吗？`,
        why: `悬了 ${Math.round(daysAgo(p.created))} 天`,
      });
    }
  } catch {}

  // ② 回归：隔了几天，提一下最近最密集的那个项目
  try {
    const last = db.prepare("SELECT MAX(created) m FROM impressions WHERE status='active'").get();
    const gap = daysAgo(last && last.m);
    if (gap >= 2 && gap < 60) {
      const top = db.prepare(`SELECT project, COUNT(*) c FROM impressions
          WHERE status='active' AND project IS NOT NULL AND project<>''
          GROUP BY project ORDER BY c DESC LIMIT 1`).get();
      if (top && top.project) {
        cands.push({
          id: 'revisit:' + top.project, kind: 'revisit',
          score: 0.5 + Math.min(0.25, gap / 20),
          text: (() => {
            const lastOne = db.prepare(`SELECT body FROM impressions WHERE status='active' AND project=? ORDER BY created DESC LIMIT 1`).get(top.project);
            const hint = lastOne ? humanize(lastOne.body, 30) : '';
            return `${opener()}，有几天没聊${top.project}了${hint ? '，上次停在「' + hint + '」' : ''}，那边后来怎么样？`;
          })(),
          why: `隔了 ${Math.round(gap)} 天`,
        });
      }
    }
  } catch {}

  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  return cands[0].score < 0.55 ? null : cands[0];
}

export function markProactive(db, item) {
  const led = loadLedger(db);
  led.count += 1;
  led.items[item.id] = (led.items[item.id] || 0) + 1;
  saveLedger(db, led);
}

export function proactiveState(db) {
  const led = loadLedger(db);
  return { day: led.day, count: led.count, silence: inSilence(), maxPerDay: MAX_PER_DAY };
}
