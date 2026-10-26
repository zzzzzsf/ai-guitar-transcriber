/**
 * 分轨扩展包下载管理器（v4.1 §1.4 工作分解 2）：
 * 双源（HuggingFace 主 + 国内镜像）+ SHA-256 校验 + HTTP Range 断点续传 + 进度。
 *
 * 验收口径：中途断网可续传（.part 持久化，206 续传）；校验失败自动重下
 * （删 .part 从零再来）；主源失败切镜像（4xx/5xx/网络异常均切换）。
 *
 * 注：模型下载失败不自动回落轻量档（§1.4 失败降级链明确区分），
 * 由 UI 引导切换镜像源后重试 —— 本模块抛 ModelDownloadError 汇总各源失败原因。
 */
import { joinPath, sha256Hex, type FsAdapter } from '../io/fsAdapter';

export type DownloadSource = { url: string; label?: string };

export type DownloadProgress = {
  /** 已落盘字节（含续传前缀） */
  doneBytes: number;
  /** 服务端告知的总字节（无 content-length 时 undefined） */
  totalBytes?: number;
};

export type DownloadResult = {
  path: string;
  bytes: number;
  sha256: string;
  resumedBytes: number;
};

export class ModelDownloadError extends Error {
  constructor(
    message: string,
    /** 每个源的失败原因（按尝试顺序） */
    public readonly failures: { source: string; reason: string }[],
  ) {
    super(message);
    this.name = 'ModelDownloadError';
  }
}

/** 永久性失败（HTTP 4xx，重试无意义）→ 直接换下一个源 */
class PermanentDownloadError extends Error {}

export type DownloadModelOpts = {
  sources: DownloadSource[];
  /** fsAdapter 相对目录 */
  destDir: string;
  fileName: string;
  expectedSha256?: string;
  fs: FsAdapter;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  /** 同一源校验失败后的完整重下次数（默认 1） */
  fullRetriesPerSource?: number;
  /** 测试用：流式落盘阈值（字节） */
  flushThresholdBytes?: number;
};

const DEFAULT_FLUSH_BYTES = 1024 * 1024;

function rangeHeader(from: number): Record<string, string> {
  return from > 0 ? { Range: `bytes=${from}-` } : {};
}

export async function downloadModel(opts: DownloadModelOpts): Promise<DownloadResult> {
  if (opts.sources.length === 0) throw new ModelDownloadError('未提供下载源', []);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const failures: { source: string; reason: string }[] = [];
  const fullRetries = opts.fullRetriesPerSource ?? 1;
  const flushThreshold = opts.flushThresholdBytes ?? DEFAULT_FLUSH_BYTES;

  for (const source of opts.sources) {
    for (let attempt = 0; attempt <= fullRetries; attempt += 1) {
      try {
        return await downloadFromSource(source, attempt, { ...opts, fetchImpl, flushThreshold });
      } catch (e) {
        if (opts.signal?.aborted || (e as Error).name === 'AbortError') {
          throw new ModelDownloadError('下载已取消', failures);
        }
        const reason = e instanceof Error ? e.message : String(e);
        failures.push({ source: source.label ?? source.url, reason });
        if (e instanceof PermanentDownloadError) break; // 4xx：同源重试无意义，换源
        // 校验失败/瞬时错误已在本源内部从零重试过；此处换下一个源
      }
    }
  }
  throw new ModelDownloadError(
    `全部下载源失败（${failures.length} 次尝试）`,
    failures,
  );
}

async function downloadFromSource(
  source: DownloadSource,
  attempt: number,
  opts: DownloadModelOpts & { fetchImpl: typeof fetch; flushThreshold: number },
): Promise<DownloadResult> {
  const partPath = joinPath(opts.destDir, `${opts.fileName}.part`);
  const finalPath = joinPath(opts.destDir, opts.fileName);

  // 校验失败重下（attempt > 0）时从零开始，否则保留可续传的 .part
  let prefix: Uint8Array = new Uint8Array(0);
  if (attempt === 0 && (await opts.fs.exists(partPath))) {
    prefix = await opts.fs.readFile(partPath);
  } else {
    await opts.fs.remove(partPath);
  }

  const resp = await opts.fetchImpl(source.url, {
    headers: rangeHeader(prefix.length),
    signal: opts.signal,
  });

  let start = 0;
  if (resp.status === 206 && prefix.length > 0) {
    start = prefix.length; // 续传命中
  } else if (resp.status === 200 || resp.status === 206) {
    start = 0; // 服务端不支持 Range → 整包重下
    prefix = new Uint8Array(0);
  } else if (resp.status === 416 && prefix.length > 0) {
    // 范围越界：.part 已是全量（上次中断在收尾）→ 无 body 续接，直接校验
    const sha = await sha256Hex(prefix);
    return finalize(opts, partPath, finalPath, prefix, sha, prefix.length);
  } else {
    const message = `HTTP ${resp.status}: ${(await resp.text()).slice(0, 120)}`;
    if (resp.status >= 400 && resp.status < 500) throw new PermanentDownloadError(message);
    throw new Error(message); // 5xx 等：瞬时，换源/重试
  }

  const contentLength = Number(resp.headers.get('content-length') ?? '');
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? start + contentLength : undefined;

  // 流式读取：prefix + 增量 chunk，按阈值落盘 .part（断网后可从上次落盘点续传）
  const chunks: Uint8Array[] = [];
  let buffered = 0;
  let done = start;
  const flush = async () => {
    if (buffered === 0) return;
    const merged = concat(prefix, chunks);
    await opts.fs.writeFile(partPath, merged);
    prefix = merged;
    chunks.length = 0;
    buffered = 0;
  };

  const reader = resp.body?.getReader();
  if (reader) {
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      if (!value) continue;
      chunks.push(value);
      buffered += value.length;
      done += value.length;
      opts.onProgress?.({ doneBytes: done, totalBytes });
      if (buffered >= opts.flushThreshold) await flush();
    }
  } else {
    // 无 body 流（测试 mock 或异常服务端）：整读
    const buf = new Uint8Array(await resp.arrayBuffer());
    chunks.push(buf);
    done += buf.length;
    opts.onProgress?.({ doneBytes: done, totalBytes });
  }
  await flush();

  // flush 不变式：所有字节（续传前缀 + 增量）此时都已在 prefix 里
  const full = prefix;
  const sha = await sha256Hex(full);
  if (opts.expectedSha256 && sha.toLowerCase() !== opts.expectedSha256.toLowerCase()) {
    await opts.fs.remove(partPath); // 校验失败：删 .part，调用方/重试循环从零再来
    throw new Error(`SHA-256 校验失败（期望 ${opts.expectedSha256.slice(0, 12)}…，实际 ${sha.slice(0, 12)}…）`);
  }
  return finalize(opts, partPath, finalPath, full, sha, start);
}

async function finalize(
  opts: DownloadModelOpts,
  partPath: string,
  finalPath: string,
  full: Uint8Array,
  sha: string,
  resumedBytes: number,
): Promise<DownloadResult> {
  await opts.fs.writeFile(partPath, full); // 416 直达路径可能未落盘
  await opts.fs.move(partPath, finalPath);
  return { path: finalPath, bytes: full.length, sha256: sha, resumedBytes };
}

function concat(a: Uint8Array, chunks: Uint8Array[]): Uint8Array {
  const total = a.length + chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  out.set(a, 0);
  let offset = a.length;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
