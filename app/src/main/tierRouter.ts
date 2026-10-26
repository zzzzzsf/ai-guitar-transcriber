/**
 * 三档运行时编排 TierRouter（v4.1 §1.4）。
 *
 *   轻量档: 原曲 → 带通 → basic-pitch（不分轨）
 *   均衡档: [缓存命中?] → separator-cli(INT8 htdemucs_6s, 3s 窗) → guitar.wav → 轻量档后半段
 *   高配档: 同上，FP16 + 高重叠（10s 窗）
 *
 * 失败降级链：spawn 失败/超时/崩溃/缺 guitar.wav → 自动回落轻量档，
 * notice 一次性提示、不中断出谱；用户主动取消（abort）不降级、直接抛出。
 * stems 按内容 hash + 档位缓存，同曲重跑/切档重算不重复分轨。
 *
 * 档位切换语义（转写中禁止切换；出谱后切换重跑分轨+转写并由 editOverlay
 * 回放保护人工修正）属于 UI 编排层，本引擎只提供可重入的 routeTier。
 */
import type { PerformanceTier } from '../types';
import { joinPath, type FsAdapter } from '../io/fsAdapter';
import {
  isSidecarRuntimeAvailable,
  runSeparation,
  SeparatorError,
  type SeparationTier,
  type StemName,
} from './separatorRunner';
import { cacheKeyOf, findStems, saveStems } from './stemsCache';

export type TierRouteOutcome =
  | { mode: 'light'; usedStem: 'original'; degradedFrom?: SeparationTier; notice?: string }
  | {
      mode: 'sidecar';
      tier: SeparationTier;
      usedStem: 'guitar';
      stems: Partial<Record<StemName, string>>;
      fromCache: boolean;
      notice?: string;
    };

export type RouteTierOpts = {
  tier: PerformanceTier;
  /** 原曲文件路径（node 侧可见；separator-cli 的 --input） */
  inputPath: string;
  /** 原曲字节（缓存 hash 用；浏览器侧由调用方持有） */
  inputBytes: () => Promise<Uint8Array>;
  /** 工作区根（fsAdapter 相对路径；stems 缓存与临时输出都放这里） */
  workRoot: string;
  fs: FsAdapter;
  separatorPath?: string;
  onProgress?: (pct: number) => void;
  /** 一次性提示通道（降级、缓存复用等） */
  onNotice?: (message: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 测试注入分轨实现 */
  runSeparationImpl?: typeof runSeparation;
};

const TIER_LABEL: Record<SeparationTier, string> = { balanced: '均衡档', pro: '高配档' };

export async function routeTier(opts: RouteTierOpts): Promise<TierRouteOutcome> {
  if (opts.tier === 'light') {
    return { mode: 'light', usedStem: 'original' };
  }
  const tier = opts.tier as SeparationTier;

  // 缓存查询先于运行时判断：命中缓存不需要分轨能力（外壳分轨 → 回浏览器打开的混合场景）
  const hash = await cacheKeyOf(opts.inputBytes);
  const cached = await findStems(opts.fs, opts.workRoot, hash, tier);
  if (cached?.guitar) {
    const notice = '分轨缓存命中：同曲同档不重复分轨';
    opts.onNotice?.(notice);
    return { mode: 'sidecar', tier, usedStem: 'guitar', stems: cached, fromCache: true, notice };
  }

  if (!isSidecarRuntimeAvailable()) {
    const notice = '当前运行时无分轨 sidecar（需桌面外壳），已自动回落轻量档直接转写';
    opts.onNotice?.(notice);
    return { mode: 'light', usedStem: 'original', degradedFrom: tier, notice };
  }

  const outDir = joinPath(opts.workRoot, 'stems-work', `${hash}-${tier}`);
  const separate = opts.runSeparationImpl ?? runSeparation;
  try {
    const result = await separate(opts.inputPath, {
      tier,
      outDir,
      fs: opts.fs,
      separatorPath: opts.separatorPath,
      onProgress: opts.onProgress,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });

    // 产物搬进缓存目录（guitar.wav 必在 —— runSeparation 已校验）
    const stemBytes: Record<string, Uint8Array> = {};
    for (const [stem, path] of Object.entries(result.stems)) {
      if (path) stemBytes[stem] = await opts.fs.readFile(path);
    }
    const stems = await saveStems(opts.fs, opts.workRoot, hash, tier, stemBytes);
    await opts.fs.remove(outDir);
    return { mode: 'sidecar', tier, usedStem: 'guitar', stems, fromCache: false };
  } catch (e) {
    if (e instanceof SeparatorError) {
      if (e.kind === 'aborted') throw e; // 用户取消不降级
      const notice = `${TIER_LABEL[tier]}分轨失败（${e.kind}），已自动回落轻量档直接转写：${e.message}`;
      opts.onNotice?.(notice);
      return { mode: 'light', usedStem: 'original', degradedFrom: tier, notice };
    }
    throw e;
  }
}
