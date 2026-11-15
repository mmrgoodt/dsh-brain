/**
 * embed.js —— 本地向量（可选加速器，不是地基）
 *
 * 用 transformers.js 跑 ONNX 模型，纯 WASM，不联网也能推理。
 * 模型第一次要下载，之后缓存在本地，断网可用。
 *
 * 设计原则：
 *   拿不到模型 → 整条向量路降级，词法 + 意图照跑，功能残缺但不残废。
 *   编码永远不阻塞写入 —— 写的时候先落库，向量后台补。
 */
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_MODEL = 'Xenova/bge-small-zh-v1.5';
const DEFAULT_CACHE = join(homedir(), '.dsh', 'brain', '.models');

let pipe = null;
let loadingPromise = null;
let failed = '';
let failedAt = 0;
let modelName = '';
/** 失败不是终身判决：模型文件、网络、依赖都有可能是临时坏的 */
const RETRY_COOLDOWN = 5 * 60 * 1000;

/** 加载模型。返回 {ok, dim, model} 或 {ok:false, error} */
export async function init(opts = {}) {
  if (pipe) return { ok: true, dim: pipe.__dim || 0, model: modelName };
  if (failed && !opts.retry) {
    // 老写法是 `if (failed) return`——一次加载失败就永久记住，
    // 整个进程生命周期里再也不会尝试第二次，向量路从此彻底死掉，
    // 而调用方看到的只是「没有向量」，根本不知道是自己被缓存坑了。
    if (Date.now() - failedAt < RETRY_COOLDOWN) return { ok: false, error: failed };
    failed = '';
  }
  if (loadingPromise) return loadingPromise;

  const cacheDir = opts.cacheDir || DEFAULT_CACHE;
  modelName = opts.model || DEFAULT_MODEL;

  loadingPromise = (async () => {
    try {
      const tf = await import('@huggingface/transformers');
      tf.env.cacheDir = cacheDir;
      // 关键：Node 的 fetch 不走系统代理，直接下会 fetch failed。
      // 所以模型文件用 curl 预下载到 cacheDir，这里只从本地读。
      tf.env.localModelPath = cacheDir;
      tf.env.allowLocalModels = true;
      tf.env.allowRemoteModels = opts.allowRemote === true;
      const p = await tf.pipeline('feature-extraction', modelName, {
        dtype: opts.dtype || 'q8',
        progress_callback: opts.onProgress,
      });
      // 先探维度，再赋给模块变量。
      // 老顺序是先 pipe = p 再 probe，probe 一抛就把 pipe 留成一个
      // 没有 __dim 的半成品，调用方以为「向量可用」，dim 却永远是 0。
      const probe = await p(['维度探测'], { pooling: 'mean', normalize: true });
      const dim = probe.dims ? probe.dims[probe.dims.length - 1] : 512;
      p.__dim = dim;
      pipe = p;
      return { ok: true, dim, model: modelName };
    } catch (e) {
      failed = String(e && e.message ? e.message : e).slice(0, 300);
      failedAt = Date.now();
      return { ok: false, error: failed };
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}

export function status() {
  return {
    ready: !!pipe,
    model: modelName,
    dim: pipe ? pipe.__dim || 0 : 0,
    error: failed,
  };
}

/** 编码失败的计数：降级是允许的，静默降级不允许 */
let encodeFails = 0;
let encodeWarned = false;

/** 把一条文本编码成 Float32Array；失败返回 null */
export async function encode(text) {
  if (!pipe) return null;
  const t = String(text || '').trim();
  if (!t) return null;
  try {
    const out = await pipe([t], { pooling: 'mean', normalize: true });
    const dim = out.dims[out.dims.length - 1];
    const vec = Float32Array.from(out.data.slice(0, dim));
    // 全零或含 NaN 的向量在 cosine 里等于噪声，不如当没有
    if (!vec.length) { encodeFails += 1; return null; }
    for (let i = 0; i < vec.length; i += 1) {
      if (!Number.isFinite(vec[i])) { encodeFails += 1; return null; }
    }
    return vec;
  } catch (e) {
    // 老写法是 `catch { return null; }`——静默降级成纯词法检索，
    // 调用方和 trace 里都看不出「向量这一路已经废了」。
    encodeFails += 1;
    if (!encodeWarned) {
      encodeWarned = true;
      console.warn('[brain] 向量编码失败，本轮起降级为词法检索:', (e && e.message) || e);
    }
    return null;
  }
}

/** 供上层看状态：failed / encodeFails 都不该是黑盒 */
export function stats() {
  return { ...status(), encodeFails };
}

/** 批量编码 */
export async function encodeMany(texts = []) {
  if (!pipe || !texts.length) return [];
  const out = [];
  for (const t of texts) out.push(await encode(t));   // 模型小，逐条更稳
  return out;
}

/** 余弦（都已归一化，直接点积即可） */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

/** 存库用：Float32Array → Buffer（BLOB） */
export function toBlob(vec) {
  if (!vec) return null;
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** 读库用：Buffer → Float32Array */
export function fromBlob(buf) {
  if (!buf || !buf.length) return null;
  // 长度不是 4 的倍数时 new Float32Array(ab) 会抛 RangeError。
  // 之前是「一条坏 blob 让整张向量表读空」，现在直接当它不存在。
  if (buf.length % 4 !== 0) return null;
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buf.length; i += 1) view[i] = buf[i];
  return new Float32Array(ab);
}
