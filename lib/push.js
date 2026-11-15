/**
 * push.js —— 主动推送
 *
 * 两条腿：
 *   ① 微信（默认）—— 调 dsh-wechat-plugin 自带的 dsh-wechat-send CLI。
 *      必须走 CLI，不能直连 iLink：直连的消息插件看不见，不计数、不排队，
 *      窗口用完第 11 条会被微信永久拒掉。
 *   ② IM（旧）—— dsh-im 的 ctx.dshIm.send，需要 push.json 里有 botId/targetId。
 *
 * push.json 形状：
 *   { "channel": "wechat" }                     ← 走微信，不需要 botId/targetId
 *   { "botId": "...", "targetId": "..." }       ← 走 IM（老配置，照旧能用）
 *
 * 微信 CLI 退出码（见 dsh-wechat-send --help）：
 *   0 已发出  1 发送失败可重试  2 用法错/没绑定对话  3 窗口用完了，已排队
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';

const CLI_TIMEOUT = 30000;

/** 找 dsh-wechat-plugin 的 cli.js。找不到就返回 null（调用方降级）。 */
function findWechatCli() {
  const rel = join('dsh-wechat-plugin', 'cli.js');
  const cands = [
    // dsh-brain 和 dsh-wechat-plugin 是同级 node_modules —— 最常见的一条
    join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', rel),
    join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'desktop', 'node_modules', rel),
    join(process.env.APPDATA || '', 'npm', 'node_modules', rel),
  ];
  for (const c of cands) {
    try { if (c && existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

export function loadPushConfig(dir) {
  try {
    const o = JSON.parse(readFileSync(join(dir, 'push.json'), 'utf8'));
    if (!o || typeof o !== 'object') return null;
    const channel = String(o.channel || '').trim().toLowerCase();
    // 显式声明微信：不需要 botId/targetId
    if (channel === 'wechat') return { ...o, channel: 'wechat', format: o.format || 'plain' };
    // 没写 channel 但也没有 IM 目标 —— 现在 IM 插件已经不在了，默认落到微信
    if (!o.botId || !o.targetId) {
      if (o.push === false) return null;
      return { ...o, channel: 'wechat', format: o.format || 'plain' };
    }
    return { ...o, format: o.format || 'plain' };
  } catch { return null; }
}

/** 走微信 CLI 发一条。永远 resolve，不 reject。 */
export function pushViaWechat(text, dataDir) {
  return new Promise((resolve) => {
    const cli = findWechatCli();
    if (!cli) return resolve({ ok: false, reason: 'wechat-cli-not-found', via: 'wechat' });

    // Electron 主进程里 process.execPath 是 DSH NEXT.exe，
    // 加 ELECTRON_RUN_AS_NODE=1 它才肯当 node 用。
    const exe = process.execPath;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    if (!env.DSH_HOME && dataDir) env.DSH_HOME = dirname(dataDir);

    const opts = { timeout: CLI_TIMEOUT, windowsHide: true, env, encoding: 'utf8' };
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };

    try {
      execFile(exe, [cli, String(text)], opts, (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const errOut = String(stderr || '').trim();
        if (!err) return finish({ ok: true, sent: true, via: 'wechat', out });

        const code = typeof err.code === 'number' ? err.code : null;
        // 3 = 窗口用完了，CLI 已经排进队列，等用户下次说话由插件补发。
        // 这里算「已受理」：算成失败会让上层下一轮再挑同一件事，造成重复排队。
        if (code === 3) return finish({ ok: true, queued: true, via: 'wechat', reason: 'window-full-queued', err: errOut || out });
        return finish({ ok: false, via: 'wechat', reason: (code !== null ? `exit-${code}` : (err && err.message)) || 'unknown', err: errOut || out });
      });
    } catch (e) {
      finish({ ok: false, via: 'wechat', reason: e && e.message });
    }
  });
}

/**
 * 发一条。
 * @param {object|null} dshIm  dsh-im 服务（现在通常为 null）
 * @param {object|null} cfg    loadPushConfig 的结果
 * @param {string} text
 * @param {string} [dataDir]   ~/.dsh/brain，用来推 DSH_HOME
 */
export async function pushText(dshIm, cfg, text, dataDir) {
  if (!cfg) return { ok: false, reason: 'no-config' };
  const body = String(text ?? '');
  if (!body.trim()) return { ok: false, reason: 'empty-text' };

  // 默认微信；只有明确配了 IM 目标且没有声明 channel=wechat 时才走 IM
  const preferIm = cfg.channel !== 'wechat' && cfg.botId && cfg.targetId
    && dshIm && typeof dshIm.send === 'function';

  if (preferIm) {
    try {
      const r = await dshIm.send(cfg.botId, cfg.targetId, body, { format: cfg.format });
      if (r?.sent === true) return { ok: true, sent: true, via: 'im', raw: r };
      // IM 说没发出去 —— 落到微信，别让这条话烂掉
      const alt = await pushViaWechat(body, dataDir);
      return alt.ok ? { ...alt, via: 'wechat(fallback)' } : { ok: false, reason: 'im-not-sent', via: 'im', raw: r };
    } catch (e) {
      const alt = await pushViaWechat(body, dataDir);
      return alt.ok ? { ...alt, via: 'wechat(fallback)' } : { ok: false, reason: e && e.message, via: 'im' };
    }
  }

  return pushViaWechat(body, dataDir);
}
