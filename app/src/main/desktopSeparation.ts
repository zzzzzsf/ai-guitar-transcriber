/**
 * 桌面分轨桥：WebView 通过 Tauri IPC 调用 Rust command。
 *
 * Rust 侧负责临时落盘源音频、spawn externalBin、收集 stems、清理工作目录；
 * 本层把返回的字节交给 TierRouter 缓存，并保持与 Node separatorRunner 相同的
 * 错误类型与 guitar.wav 校验，浏览器构建不依赖 @tauri-apps/api。
 */
import type { FsAdapter } from '../io/fsAdapter';
import {
  type RunSeparationOpts,
  type SeparationResult,
  type StemName,
  SeparatorError,
} from './separatorRunner';

type TauriInvoke = (
  command: string,
  payload?: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<unknown>;

type TauriGlobal = {
  core?: {
    invoke?: TauriInvoke;
    Channel?: new (onmessage?: (value: unknown) => void) => TauriIpcChannel;
  };
};

type TauriIpcChannel = {
  onmessage: ((value: unknown) => void) | null;
  toJSON: () => string;
};

type TauriInternals = {
  invoke?: TauriInvoke;
  Channel?: new (onmessage?: (value: unknown) => void) => TauriIpcChannel;
  transformCallback?: (callback: (value: unknown) => void, once?: boolean) => number;
  unregisterCallback?: (id: number) => void;
};

export type DesktopSeparationResult = {
  stems: Partial<Record<StemName, string>>;
  workDir: string;
  elapsedMs?: number;
};

type EventPayload = {
  runId: number;
  name: string;
  stream: 'stdout' | 'stderr' | 'exit' | 'error';
  data: string;
};

function internals(): TauriInternals | null {
  if (testInternals) return testInternals;
  if (typeof window === 'undefined') return null;
  const tauri = (window as Window & { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return tauri?.invoke ? tauri : null;
}

function desktopMarkerPresent(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as Window & { isTauri?: boolean }).isTauri === true;
}

/** 测试注入：模拟 Tauri IPC 与事件回调。 */
export function setDesktopSeparationInternalsForTest(
  value: TauriInternals | null,
): void {
  testInternals = value;
}

let testInternals: TauriInternals | null = null;

export function isDesktopRuntime(): boolean {
  if (testInternals) return Boolean(testInternals.invoke);
  return Boolean(desktopMarkerPresent() || internals() || globalInvoke());
}

function globalInvoke(): TauriInvoke | null {
  if (typeof window === 'undefined') return null;
  const tauri = (window as Window & { __TAURI__?: TauriGlobal }).__TAURI__;
  return tauri?.core?.invoke ?? null;
}

async function invoke<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const tauri = internals();
  const call = tauri?.invoke ?? globalInvoke();
  if (!call) throw new Error('当前运行时没有 Tauri IPC');
  return call(command, payload) as Promise<T>;
}

/**
 * 订阅 Rust 的 sidecar:event。仅用于把真实进度/取消状态反馈给用户。
 * 命令本身负责最终结果，所以这里监听失败不应导致分轨失败。
 */
export function subscribeDesktopSeparation(
  onEvent: (payload: EventPayload) => void,
): () => void {
  const tauri = internals();
  const tauriWindow = (typeof window !== 'undefined' ? window : undefined) as
    | (Window & {
        __TAURI__?: {
          event?: {
            listen?: (
              event: string,
              handler: (event: { payload: EventPayload }) => void,
            ) => Promise<() => void>;
          };
        };
      })
    | undefined;
  const globalEvent = tauriWindow?.__TAURI__?.event;
  if (!tauri?.transformCallback && globalEvent?.listen) {
    let active = true;
    let stop: (() => void) | null = null;
    void globalEvent
      .listen('sidecar:event', (message) => {
        if (active) onEvent(message.payload);
      })
      .then((unlisten) => {
        if (active) stop = unlisten;
        else void unlisten();
      })
      .catch(() => {});
    return () => {
      active = false;
      if (stop) void stop();
    };
  }
  if (!tauri?.transformCallback) return () => {};

  let active = true;
  let eventId: number | null = null;
  let listenPending = true;
  const callbackId = tauri.transformCallback(
    (message) => {
      if (!active) return;
      const event = message as { event?: string; payload?: EventPayload };
      if (event.event === 'sidecar:event' && event.payload) onEvent(event.payload);
    },
    false,
  );
  void invoke<number>('plugin:event|listen', {
    event: 'sidecar:event',
    target: { kind: 'Any' },
    handler: callbackId,
  })
    .then((id) => {
      listenPending = false;
      if (active) {
        eventId = id;
      } else {
        void invoke('plugin:event|unlisten', {
          event: 'sidecar:event',
          eventId: id,
        })
          .catch(() => {})
          .finally(() => tauri.unregisterCallback?.(callbackId));
      }
    })
    .catch(() => {
      listenPending = false;
      tauri.unregisterCallback?.(callbackId);
    });

  return () => {
    active = false;
    if (eventId !== null) {
      void invoke('plugin:event|unlisten', {
        event: 'sidecar:event',
        eventId,
      })
        .catch(() => {})
        .finally(() => tauri.unregisterCallback?.(callbackId));
    } else if (!listenPending) {
      tauri.unregisterCallback?.(callbackId);
    }
  };
}

/** 检查 externalBin 是否随应用提供。 */
export async function isDesktopSeparatorAvailable(): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  try {
    return await invoke<boolean>('separator_available');
  } catch {
    return false;
  }
}

/**
 * 一次桌面分轨。inputBytes 由调用方从 File 原样提供；Rust 会在临时目录内
 * 写入 input.wav，再以同一档位参数启动 demucs，所以下游拿到的 guitar.wav
 * 确实来自分轨而不是原始混音。
 */
export async function runDesktopSeparation(
  inputBytes: Uint8Array,
  opts: RunSeparationOpts & {
    fs: FsAdapter;
    signal?: AbortSignal;
  },
): Promise<SeparationResult> {
  if (!isDesktopRuntime()) {
    throw new SeparatorError('unavailable', '当前运行时无桌面分轨 IPC');
  }
  const runId = nextRunId();
  let commandSettled = false;
  const onAbort = () => {
    if (commandSettled) return;
    void invoke('cancel_separation', { runId }).catch(() => {});
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (opts.signal?.aborted) throw new SeparatorError('aborted', '分轨已取消');
    const globalChannel = (typeof window !== 'undefined'
      ? (window as Window & { __TAURI__?: TauriGlobal }).__TAURI__?.core?.Channel
      : undefined);
    const Channel = globalChannel ?? testInternals?.Channel;
    if (!Channel) {
      throw new SeparatorError('unavailable', '当前 Tauri 运行时缺少 IPC Channel API');
    }
    const channel = new Channel((message) => {
      const progress = message as { data?: unknown } | null;
      if (typeof progress?.data !== 'string') return;
      const match = /progress[=:]\s*(\d+(?:\.\d+)?)/i.exec(progress.data);
      if (match) opts.onProgress?.(Math.max(0, Math.min(100, Number(match[1]))));
    });
    const raw = await invoke<DesktopSeparationResult>('separation_run', {
      request: {
        runId,
        tier: opts.tier,
        inputBytes: bytesToBase64(inputBytes),
      },
      onProgress: channel,
    });
    commandSettled = true;
    if (opts.signal?.aborted) throw new SeparatorError('aborted', '分轨已取消');
    if (!raw.stems.guitar) {
      throw new SeparatorError('missing', '分轨结果缺少 guitar.wav');
    }
    const stems: Partial<Record<StemName, string>> = {};
    for (const [name, encoded] of Object.entries(raw.stems)) {
      if (typeof encoded !== 'string') continue;
      const path = `${raw.workDir}/${name}.wav`;
      await opts.fs.writeFile(path, base64ToBytes(encoded));
      stems[name as StemName] = path;
    }
    return { stems, stemsDir: raw.workDir };
  } catch (error) {
    if (
      opts.signal?.aborted ||
      /取消|取消成功/i.test(String((error as Error)?.message ?? error))
    ) {
      throw new SeparatorError('aborted', '分轨已取消');
    }
    if (error instanceof SeparatorError) throw error;
    throw new SeparatorError('spawn', `桌面分轨失败：${(error as Error).message}`);
  } finally {
    commandSettled = true;
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

let runSequence = 0;
function nextRunId(): number {
  runSequence += 1;
  return Date.now() * 1000 + runSequence;
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
