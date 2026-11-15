import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryFsAdapter, textToBytes } from '../io/fsAdapter';
import {
  isDesktopRuntime,
  runDesktopSeparation,
  setDesktopSeparationInternalsForTest,
  subscribeDesktopSeparation,
} from './desktopSeparation';
import { SeparatorError } from './separatorRunner';

const SOURCE = textToBytes('RIFF-source');
const TAURI_IPC_SERIALIZE = '__TAURI_TO_IPC_KEY__';

/** Matches the serialization contract of @tauri-apps/api/core Channel. */
class FakeTauriChannel {
  onmessage: ((value: unknown) => void) | null;

  constructor(onmessage?: (value: unknown) => void) {
    this.onmessage = onmessage ?? null;
  }

  toJSON() {
    return this[TAURI_IPC_SERIALIZE]();
  }

  [TAURI_IPC_SERIALIZE]() {
    return '__CHANNEL__:7001';
  }
}

function response(stems: Record<string, string>) {
  return {
    stems,
    workDir: 'desktop-separation/42',
    elapsedMs: 123,
  };
}

afterEach(() => {
  setDesktopSeparationInternalsForTest(null);
  vi.unstubAllGlobals();
});

describe('desktopSeparation（Tauri IPC 契约）', () => {
  it('Tauri 壳存在但 IPC 未就绪 → unavailable，不误发命令', async () => {
    setDesktopSeparationInternalsForTest({});
    await expect(
      runDesktopSeparation(SOURCE, {
        tier: 'balanced',
        outDir: 'stems-work/balanced',
        fs: new MemoryFsAdapter(),
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('注入 IPC 后识别为桌面运行时', async () => {
    setDesktopSeparationInternalsForTest({ invoke: async () => null });
    expect(isDesktopRuntime()).toBe(true);
  });

  it('以 base64 传源音频，并把返回 guitar.wav 写入 FsAdapter', async () => {
    const fs = new MemoryFsAdapter();
    let payload: Record<string, unknown> | undefined;
    let progressChannel: FakeTauriChannel | undefined;
    const progress: number[] = [];
    let cancelCalls = 0;
    setDesktopSeparationInternalsForTest({
      Channel: FakeTauriChannel,
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, data?: Record<string, unknown>) => {
        if (command === 'separation_run') {
          payload = data;
          progressChannel = data?.onProgress as FakeTauriChannel;
          if (
            !progressChannel ||
            progressChannel[TAURI_IPC_SERIALIZE]() !== '__CHANNEL__:7001'
          ) {
            throw new Error('separation_run requires a serializable onProgress Channel');
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
          return response({ guitar: btoa('RIFF-guitar'), vocals: btoa('RIFF-vocals') });
        }
        if (command === 'cancel_separation') cancelCalls += 1;
        return null;
      },
    });

    const out = await runDesktopSeparation(SOURCE, {
      tier: 'pro',
      outDir: 'stems-work/pro',
      fs,
      onProgress: (value) => progress.push(value),
    });

    const request = payload?.request as
      | { runId: number; tier: string; inputBytes: string }
      | undefined;
    if (!request) throw new Error('missing separation request');
    expect(request.tier).toBe('pro');
    expect(new Uint8Array(Buffer.from(request.inputBytes, 'base64'))).toEqual(SOURCE);
    expect(out.stems.guitar).toBe('desktop-separation/42/guitar.wav');
    expect((await fs.readFile(out.stems.guitar!)).length).toBe(11);
    expect(progressChannel).toBeInstanceOf(FakeTauriChannel);
    expect(JSON.parse(JSON.stringify(payload))).toMatchObject({
      onProgress: '__CHANNEL__:7001',
    });
    progressChannel?.onmessage?.({ runId: request.runId, data: 'progress=42.5' });
    expect(progress).toEqual([42.5]);
    expect(cancelCalls).toBe(0);
  });

  it('预先取消时抛出 aborted，不启动 sidecar', async () => {
    let separateCalls = 0;
    let cancelRunId: unknown;
    const invoke = async (command: string, data?: Record<string, unknown>) => {
      if (command === 'separation_run') {
        separateCalls += 1;
        return new Promise<unknown>((resolve) => {
          setTimeout(() => resolve(response({ guitar: btoa('late') })), 40);
        });
      }
      if (command === 'cancel_separation') cancelRunId = data?.runId;
      return null;
    };
    setDesktopSeparationInternalsForTest({
      Channel: FakeTauriChannel,
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      runDesktopSeparation(SOURCE, {
        tier: 'balanced',
        outDir: 'stems-work/balanced',
        fs: new MemoryFsAdapter(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(separateCalls).toBe(0);
    expect(cancelRunId).toBeUndefined();
  });

  it('运行中取消 → 调用 cancel_separation，并以 aborted 拒绝', async () => {
    const cancelRunIds: unknown[] = [];
    let releaseRun!: (value: unknown) => void;
    setDesktopSeparationInternalsForTest({
      Channel: FakeTauriChannel,
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, data?: Record<string, unknown>) => {
        if (command === 'separation_run') {
          return new Promise<unknown>((resolve) => {
            releaseRun = resolve;
          });
        }
        if (command === 'cancel_separation') cancelRunIds.push(data?.runId);
        return null;
      },
    });
    const controller = new AbortController();
    const run = runDesktopSeparation(SOURCE, {
      tier: 'balanced',
      outDir: 'stems-work/balanced',
      fs: new MemoryFsAdapter(),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(releaseRun).toEqual(expect.any(Function)));
    controller.abort();
    releaseRun(response({ guitar: btoa('late-success') }));
    await expect(run).rejects.toMatchObject({ kind: 'aborted' });
    expect(cancelRunIds).toHaveLength(1);
    expect(cancelRunIds[0]).toEqual(expect.any(Number));
  });

  it('正常返回但缺 guitar.wav → missing 错误', async () => {
    setDesktopSeparationInternalsForTest({
      Channel: FakeTauriChannel,
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async () => response({ vocals: btoa('RIFF-vocals') }),
    });
    await expect(
      runDesktopSeparation(SOURCE, {
        tier: 'balanced',
        outDir: 'stems-work/balanced',
        fs: new MemoryFsAdapter(),
      }),
    ).rejects.toBeInstanceOf(SeparatorError);
  });

  it('取消正在建立的事件监听 → 注册完成后立即注销并释放回调', async () => {
    let completeListen!: (value: unknown) => void;
    const unregistered: number[] = [];
    const calls: Array<{ command: string; payload?: Record<string, unknown> }> = [];
    const invoke = async (command: string, payload?: Record<string, unknown>) => {
      calls.push({ command, payload });
      if (command === 'plugin:event|listen') {
        return new Promise<unknown>((resolve) => {
          completeListen = resolve;
        });
      }
      return null;
    };
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    setDesktopSeparationInternalsForTest({
      invoke,
      transformCallback: () => 17,
      unregisterCallback: (id) => unregistered.push(id),
    });

    const unsubscribe = subscribeDesktopSeparation(vi.fn());
    unsubscribe();
    completeListen(31);
    await vi.waitFor(() => {
      expect(calls.some((call) => call.command === 'plugin:event|unlisten')).toBe(true);
      expect(unregistered).toContain(17);
    });
    expect(calls.find((call) => call.command === 'plugin:event|unlisten')?.payload)
      .toMatchObject({ event: 'sidecar:event', eventId: 31 });
  });
});
