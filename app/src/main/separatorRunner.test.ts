import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryFsAdapter, textToBytes } from '../io/fsAdapter';
import {
  buildSeparatorArgs,
  discoverStems,
  nodeSpawn,
  parseProgressLine,
  runSeparation,
  SeparatorError,
  type RunProcessOpts,
  type RunSeparationOpts,
} from './separatorRunner';
import { routeTier } from './tierRouter';
import { cacheKeyOf, saveStems } from './stemsCache';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/mock-separator.mjs', import.meta.url));

/** 真实产物目录（系统临时区，不污染工程）；每次测试唯一 */
function tempOut(): string {
  return join(tmpdir(), `agtp-sep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

/**
 * 把对 separator-cli 的调用翻译成 node 跑 mock 脚本：
 * --output 重定向到真实临时目录，成功后把产物镜像进内存 fs
 * （模拟“子进程落盘 → 引擎经 FsAdapter 发现产物”）。
 */
function fixtureSpawn(fs: MemoryFsAdapter, realOut: string, extraArgs: string[] = []) {
  return async (opts: RunProcessOpts) => {
    const args = [...opts.args];
    const outIdx = args.indexOf('--output');
    if (outIdx >= 0) args[outIdx + 1] = realOut;
    const result = await nodeSpawn({ ...opts, command: process.execPath, args: [FIXTURE, ...extraArgs, ...args] });
    if (result.code === 0) {
      const { readdir, readFile, rm } = await import('node:fs/promises');
      for (const f of await readdir(realOut)) {
        const data = new Uint8Array(await readFile(join(realOut, f)));
        await fs.writeFile(join('out', f), data);
      }
      await rm(realOut, { recursive: true, force: true });
    }
    return result;
  };
}

describe('parseProgressLine（进度协议）', () => {
  it('progress=NN / progress: NN / NN% / JSON 行', () => {
    expect(parseProgressLine('progress=42')).toBe(42);
    expect(parseProgressLine('progress: 42.5')).toBe(42.5);
    expect(parseProgressLine('separating... 63%')).toBe(63);
    expect(parseProgressLine('{"type":"progress","percent":88}')).toBe(88);
    expect(parseProgressLine('some log line')).toBeNull();
    expect(parseProgressLine('progress=140')).toBeNull();
  });
});

describe('buildSeparatorArgs（三档差异）', () => {
  it('均衡档：INT8 + 3s 窗；高配档：高重叠 + 10s 窗', () => {
    const balanced = buildSeparatorArgs('in.wav', { tier: 'balanced', outDir: 'out' });
    expect(balanced).toContain('--quantization');
    expect(balanced).toContain('int8');
    expect(balanced[balanced.indexOf('--segment') + 1]).toBe('3');

    const pro = buildSeparatorArgs('in.wav', { tier: 'pro', outDir: 'out' });
    expect(pro).not.toContain('--quantization');
    expect(pro[pro.indexOf('--segment') + 1]).toBe('10');
    expect(pro).toContain('--overlap');
  });
});

describe('discoverStems（产物发现，含嵌套目录）', () => {
  it('在 ≤3 层深内找到六个 stem', async () => {
    const fs = new MemoryFsAdapter({
      'out/htdemucs_6s/track/guitar.wav': 'g',
      'out/htdemucs_6s/track/bass.wav': 'b',
      'out/htdemucs_6s/track/drums.wav': 'd',
      'out/htdemucs_6s/track/vocals.wav': 'v',
      'out/htdemucs_6s/track/piano.wav': 'p',
      'out/htdemucs_6s/track/other.wav': 'o',
      'out/htdemucs_6s/track/readme.txt': 'x',
    });
    const stems = await discoverStems(fs, 'out');
    expect(Object.keys(stems).sort()).toEqual(['bass', 'drums', 'guitar', 'other', 'piano', 'vocals']);
    expect(stems.guitar).toBe('out/htdemucs_6s/track/guitar.wav');
  });
});

describe('runSeparation（真实子进程：mock separator-cli）', () => {
  it('成功路径：进度回调 + guitar.wav 必在', async () => {
    const fs = new MemoryFsAdapter();
    const progress: number[] = [];
    const result = await runSeparation('input.wav', {
      tier: 'balanced',
      outDir: 'out',
      fs,
      spawnImpl: fixtureSpawn(fs, tempOut()),
      onProgress: (p) => progress.push(p),
      timeoutMs: 15_000,
    });
    expect(result.stems.guitar).toBe('out/guitar.wav');
    expect(result.stems.vocals).toBe('out/vocals.wav');
    expect(progress.at(-1)).toBe(100);
    expect(progress.length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it('非零退出 → exit 错误并带 stderr', async () => {
    await expect(
      runSeparation('input.wav', {
        tier: 'pro', outDir: 'out', fs: new MemoryFsAdapter(),
        spawnImpl: fixtureSpawn(new MemoryFsAdapter(), tempOut(), ['--fail', 'exit']), timeoutMs: 15_000,
      }),
    ).rejects.toMatchObject({ name: 'SeparatorError', kind: 'exit' });
  }, 20_000);

  it('缺 guitar.wav → missing 错误（吉他扒谱关键产物）', async () => {
    const fs = new MemoryFsAdapter({ 'out/bass.wav': 'b' });
    const fakeSpawn = async (_opts: RunProcessOpts) => ({ code: 0, stdout: 'progress=100', stderr: '' });
    await expect(
      runSeparation('input.wav', { tier: 'balanced', outDir: 'out', fs, spawnImpl: fakeSpawn }),
    ).rejects.toMatchObject({ kind: 'missing' });
  });

  it('超时 → timeout 错误并杀进程', async () => {
    await expect(
      runSeparation('input.wav', {
        tier: 'balanced', outDir: 'out', fs: new MemoryFsAdapter(),
        spawnImpl: fixtureSpawn(new MemoryFsAdapter(), tempOut(), ['--hang']), timeoutMs: 400,
      }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  }, 10_000);

  it('外部 abort → aborted 错误', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    await expect(
      runSeparation('input.wav', {
        tier: 'balanced', outDir: 'out', fs: new MemoryFsAdapter(),
        spawnImpl: fixtureSpawn(new MemoryFsAdapter(), tempOut(), ['--hang']), signal: controller.signal, timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({ kind: 'aborted' });
  }, 10_000);
});

describe('routeTier（TierRouter + 降级链 + stems 缓存）', () => {
  const INPUT_BYTES = textToBytes('RIFF-original-song');

  it('轻量档直通原曲', async () => {
    const out = await routeTier({
      tier: 'light', inputPath: 'song.wav', inputBytes: () => Promise.resolve(INPUT_BYTES),
      workRoot: 'work', fs: new MemoryFsAdapter(),
    });
    expect(out).toEqual({ mode: 'light', usedStem: 'original' });
  });

  it('分轨失败 → 自动回落轻量档，一次性 notice', async () => {
    const notices: string[] = [];
    const out = await routeTier({
      tier: 'balanced', inputPath: 'song.wav', inputBytes: () => Promise.resolve(INPUT_BYTES),
      workRoot: 'work', fs: new MemoryFsAdapter(),
      onNotice: (m) => notices.push(m),
      runSeparationImpl: async () => {
        throw new SeparatorError('spawn', '无法启动分轨程序');
      },
    });
    expect(out.mode).toBe('light');
    expect((out as { degradedFrom?: string }).degradedFrom).toBe('balanced');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('回落轻量档');
  });

  it('用户取消（abort）不降级，直接抛出', async () => {
    await expect(
      routeTier({
        tier: 'pro', inputPath: 'song.wav', inputBytes: () => Promise.resolve(INPUT_BYTES),
        workRoot: 'work', fs: new MemoryFsAdapter(),
        runSeparationImpl: async () => {
          throw new SeparatorError('aborted', '分轨已取消');
        },
      }),
    ).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('缓存命中 → fromCache，不再分轨', async () => {
    const fs = new MemoryFsAdapter();
    const hash = await cacheKeyOf(() => Promise.resolve(INPUT_BYTES));
    await saveStems(fs, 'work', hash, 'balanced', { guitar: textToBytes('g'), vocals: textToBytes('v') });

    let separationRuns = 0;
    const out = await routeTier({
      tier: 'balanced', inputPath: 'song.wav', inputBytes: () => Promise.resolve(INPUT_BYTES),
      workRoot: 'work', fs,
      runSeparationImpl: async () => {
        separationRuns += 1;
        throw new Error('不应到达');
      },
    });
    expect(out.mode).toBe('sidecar');
    expect((out as { fromCache: boolean }).fromCache).toBe(true);
    expect(separationRuns).toBe(0);
  });

  it('成功分轨 → 产物进缓存、工作目录清理；二跑缓存命中', async () => {
    const fs = new MemoryFsAdapter();
    const runSeparationImpl = async (_input: string, opts: RunSeparationOpts) => {
      // 模拟 separator-cli 落盘产物
      await fs.writeFile(`${opts.outDir}/guitar.wav`, textToBytes('guitar-stem'));
      await fs.writeFile(`${opts.outDir}/vocals.wav`, textToBytes('vocals-stem'));
      return {
        stems: { guitar: `${opts.outDir}/guitar.wav`, vocals: `${opts.outDir}/vocals.wav` },
        stemsDir: opts.outDir,
      };
    };
    const first = await routeTier({
      tier: 'balanced', inputPath: 'song.wav', inputBytes: () => Promise.resolve(INPUT_BYTES),
      workRoot: 'work', fs, runSeparationImpl,
    });
    expect(first.mode).toBe('sidecar');
    expect((first as { fromCache: boolean }).fromCache).toBe(false);
    expect(await fs.exists('work/stems-work')).toBe(false); // 工作目录已清理

    const second = await routeTier({
      tier: 'balanced', inputPath: 'song.wav', inputBytes: () => Promise.resolve(INPUT_BYTES),
      workRoot: 'work', fs, runSeparationImpl,
    });
    expect((second as { fromCache: boolean }).fromCache).toBe(true);
    expect((second as { stems: Record<string, string> }).stems.guitar).toMatch(/stems-cache\/.+\.wav$/);
  });
});
