/**
 * separator-cli 子进程运行器（v4.1 §1.1/§1.4）。
 *
 * 对外只暴露 `input.wav → output_stems/*.wav`（§1.1 统一封装），
 * 与 demucs.cpp / ONNX 版具体实现解耦 —— 我们自己的 separator-cli 包装
 * 约定以下命令行与进度协议（装壳分发时实现该包装，本引擎先行冻结契约）：
 *
 *   separator-cli --input <wav> --output <dir> --model htdemucs_6s
 *                 --segment <sec> [--quantization int8] [--device gpu]
 *   进度：stdout 每行 `progress=<0..100>`（兼容 `NN%` 与 JSON 行）
 *   产物：output 下（可能嵌套一层模型名/曲目名目录）出现 <stem>.wav
 *
 * 失败降级链（§1.4）：spawn 失败/超时/崩溃 → 抛 SeparatorError，
 * 由 tierRouter 自动回落轻量档，UI 一次性提示、不中断出谱。
 *
 * node:child_process 惰性加载 —— 本模块可被浏览器代码 import（类型层面），
 * 只有真正 spawn 才要求 node 运行时（Electron 主进程 / vitest）。
 */
import { joinPath, type FsAdapter } from '../io/fsAdapter';

export type StemName = 'guitar' | 'bass' | 'drums' | 'vocals' | 'piano' | 'other';
export const STEM_NAMES: StemName[] = ['guitar', 'bass', 'drums', 'vocals', 'piano', 'other'];

export type SeparatorErrorKind =
  | 'unavailable' // 无 node 运行时（浏览器 dev；装壳后消失）
  | 'spawn' // 二进制缺失/无法启动
  | 'timeout'
  | 'aborted'
  | 'exit' // 非零退出
  | 'missing'; // 产物缺 guitar.wav

export class SeparatorError extends Error {
  constructor(
    public readonly kind: SeparatorErrorKind,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'SeparatorError';
  }
}

/** 当前运行时能否 spawn 子进程（浏览器 = false → tierRouter 直接降级轻量档） */
export function isSidecarRuntimeAvailable(): boolean {
  return typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node;
}

// ---------- 进度协议 ----------

export function parseProgressLine(line: string): number | null {
  const kv = /progress[=:]\s*(\d+(?:\.\d+)?)/i.exec(line);
  if (kv) return clampPercent(Number(kv[1]));
  const pct = /(?:^|\s)(\d{1,3}(?:\.\d+)?)\s*%/.exec(line);
  if (pct) return clampPercent(Number(pct[1]));
  const json = /^\s*\{.*"?(percent|progress)"?\s*:\s*(\d+(?:\.\d+)?)/.exec(line);
  if (json) return clampPercent(Number(json[2]));
  return null;
}

function clampPercent(v: number): number | null {
  if (!Number.isFinite(v) || v < 0 || v > 100) return null;
  return v;
}

// ---------- 进程运行 ----------

export type RunProcessOpts = {
  command: string;
  args: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
};

export type RunProcessResult = { code: number; stdout: string; stderr: string };

type SpawnFn = (opts: RunProcessOpts) => Promise<RunProcessResult>;

/** 默认实现：node child_process。测试/开发可用它包一层跑 mock 脚本 */
export const nodeSpawn: SpawnFn = async (opts) => {
  if (!isSidecarRuntimeAvailable()) {
    throw new SeparatorError('unavailable', '当前运行时无法启动子进程（需要桌面外壳）');
  }
  const { spawn } = await import('node:child_process');
  return new Promise<RunProcessResult>((resolve, reject) => {
    const child = spawn(opts.command, opts.args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          finish(new SeparatorError('timeout', `分轨超时（${opts.timeoutMs}ms），已终止子进程`));
          child.kill();
        }, opts.timeoutMs)
      : null;

    const onExternalAbort = () => {
      finish(new SeparatorError('aborted', '分轨已取消'));
      child.kill();
    };
    opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

    function finish(error?: Error, result?: RunProcessResult) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
      error ? reject(error) : resolve(result!);
    }

    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(new SeparatorError('spawn', `无法启动分轨程序：${err.message}`, String(code ?? '')));
    });

    let stdoutTail = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      stdoutTail += text;
      const lines = stdoutTail.split(/\r?\n/);
      stdoutTail = lines.pop() ?? '';
      for (const line of lines) opts.onStdoutLine?.(line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      if (stdoutTail) opts.onStdoutLine?.(stdoutTail);
      finish(undefined, { code: code ?? -1, stdout, stderr });
    });
  });
};

// ---------- 分轨主入口 ----------

export type SeparationTier = 'balanced' | 'pro';

export type RunSeparationOpts = {
  tier: SeparationTier;
  /** 输出目录（fsAdapter 相对路径，或 node 侧绝对路径 —— 传 fs 时为相对路径） */
  outDir: string;
  fs?: FsAdapter;
  /** separator-cli 可执行文件路径（装壳后由下载管理器解析） */
  separatorPath?: string;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 测试注入 */
  spawnImpl?: SpawnFn;
};

export type SeparationResult = {
  /** stem → 文件路径（fs 相对路径） */
  stems: Partial<Record<StemName, string>>;
  /** 实际发现 stems 的目录 */
  stemsDir: string;
};

export const DEFAULT_SEPARATION_TIMEOUT_MS = 900_000;

export function buildSeparatorArgs(inputPath: string, opts: RunSeparationOpts): string[] {
  const args = [
    '--input', inputPath,
    '--output', opts.outDir,
    '--model', 'htdemucs_6s',
    '--segment', opts.tier === 'balanced' ? '3' : '10',
  ];
  if (opts.tier === 'balanced') args.push('--quantization', 'int8');
  if (opts.tier === 'pro') args.push('--overlap', 'high');
  return args;
}

export async function runSeparation(inputPath: string, opts: RunSeparationOpts): Promise<SeparationResult> {
  const spawnFn = opts.spawnImpl ?? nodeSpawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SEPARATION_TIMEOUT_MS;
  const args = buildSeparatorArgs(inputPath, opts);

  let result: RunProcessResult;
  try {
    result = await spawnFn({
      command: opts.separatorPath ?? 'separator-cli',
      args,
      timeoutMs,
      signal: opts.signal,
      onStdoutLine: (line) => {
        const pct = parseProgressLine(line);
        if (pct !== null && opts.onProgress) opts.onProgress(pct);
      },
    });
  } catch (e) {
    if (e instanceof SeparatorError) throw e;
    throw new SeparatorError('spawn', `分轨进程异常：${(e as Error).message}`);
  }

  if (result.code !== 0) {
    throw new SeparatorError('exit', `分轨进程退出码 ${result.code}`, result.stderr.slice(0, 300));
  }

  const stems = opts.fs ? await discoverStems(opts.fs, opts.outDir) : null;
  if (opts.fs && !stems?.guitar) {
    // guitar.wav 是吉他扒谱的关键产物（§1.1 模型选择依据）
    throw new SeparatorError('missing', '分轨产物中缺少 guitar.wav', `已发现: ${Object.keys(stems ?? {}).join(', ') || '无'}`);
  }
  return { stems: stems ?? {}, stemsDir: opts.outDir };
}

/** 在输出目录（≤3 层深）里找 <stem>.wav */
export async function discoverStems(fs: FsAdapter, outDir: string): Promise<Partial<Record<StemName, string>>> {
  const stems: Partial<Record<StemName, string>> = {};
  const queue: string[] = [outDir];
  for (let depth = 0; depth < 3 && queue.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      let entries;
      try {
        entries = await fs.list(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = joinPath(dir === '' ? entry.path : dir, entry.path);
        if (entry.dir) next.push(full);
        else {
          const stem = entry.path.replace(/\.wav$/i, '').toLowerCase() as StemName;
          if (STEM_NAMES.includes(stem) && !stems[stem]) stems[stem] = full;
        }
      }
    }
    queue.splice(0, queue.length, ...next);
  }
  return stems;
}
