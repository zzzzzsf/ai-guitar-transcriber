/**
 * 调性检测（Krumhansl-Schmuckler）— 新增自《吉他扒谱-细化方案》§3.3 第 1 项（最高优先，必做）。
 *
 * 检测结果双用：① 五线谱调号（toAlphaTex 生成 `\ks`，否则 C 外调性全靠临时记号不可读）；
 * ② Auto-Capo 的 KeyFit 评分项（首期权重 0，两者独立）。
 *
 * 算法：时长加权音级分布 × Krumhansl-Kessler 音级相关轮廓，24 个大小调旋转取最大相关。
 * 纯 TS，无外部依赖。
 */
import type { RawNote } from '../profiles/IInstrumentProfile';

const PITCH_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Krumhansl-Kessler 音级轮廓（major / minor） */
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export type KeyMode = 'major' | 'minor';

export type KeyResult = {
  /** 根音音级 0-11（0 = C） */
  tonicPc: number;
  mode: KeyMode;
  /** 显示名，如 "C"、"Em"、"F#" */
  name: string;
  /** 与 KK 轮廓的 Pearson 相关系数 0~1 */
  confidence: number;
};

/** UI/流水线用的手动指定调性 */
export type KeySelection = { tonicPc: number; mode: KeyMode };

export function keyDisplayName(tonicPc: number, mode: KeyMode): string {
  return `${PITCH_NAMES[((tonicPc % 12) + 12) % 12]}${mode === 'minor' ? 'm' : ''}`;
}

/**
 * alphaTex `\ks` 调号记号（源码确认的合法 token 集合）：
 * 大调 15 个（含 cb/gb/db/ab/eb/bb 降号侧）+ 小调 15 个。
 * 按根音音级映射到最常用记法（C♯ 用 c#，E♭ 用 eb，A♯ 小调用 a#minor）。
 */
export function keyToAlphaTexToken(tonicPc: number, mode: KeyMode): string {
  const pc = ((tonicPc % 12) + 12) % 12;
  const MAJOR: [number, string][] = [
    [0, 'cmajor'], [1, 'c#major'], [2, 'dmajor'], [3, 'ebmajor'], [4, 'emajor'],
    [5, 'fmajor'], [6, 'f#major'], [7, 'gmajor'], [8, 'abmajor'], [9, 'amajor'],
    [10, 'bbmajor'], [11, 'bmajor'],
  ];
  const MINOR: [number, string][] = [
    [0, 'cminor'], [1, 'c#minor'], [2, 'dminor'], [3, 'd#minor'], [4, 'eminor'],
    [5, 'fminor'], [6, 'f#minor'], [7, 'gminor'], [8, 'g#minor'], [9, 'aminor'],
    [10, 'a#minor'], [11, 'bminor'],
  ];
  const table = mode === 'major' ? MAJOR : MINOR;
  const token = table.find(([pc2]) => pc2 === pc)?.[1];
  if (!token) throw new Error(`无法映射调号: pc=${pc} ${mode}`);
  return token;
}

/** 时长加权的音级分布（0-11） */
function pitchClassProfile(notes: RawNote[]): Float64Array {
  const profile = new Float64Array(12);
  for (const n of notes) {
    const pc = ((n.pitch % 12) + 12) % 12;
    profile[pc] += Math.max(n.duration, 0.05);
  }
  return profile;
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = a[i] - ma;
    const dy = b[i] - mb;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  return denom > 1e-12 ? sxy / denom : 0;
}

/** Krumhansl-Schmuckler 调性检测：音级分布与 24 个大小调 KK 轮廓旋转取最大相关 */
export function detectKey(notes: RawNote[]): KeyResult | null {
  if (notes.length === 0) return null;
  const profile = pitchClassProfile(notes);
  // 全部音级为 0（不可能但防御）→ 不给结论
  let total = 0;
  for (let i = 0; i < 12; i++) total += profile[i];
  if (total <= 0) return null;

  let best: { tonicPc: number; mode: KeyMode; r: number } | null = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    // 轮廓旋转：tonic 对齐到 pc 0
    for (const [kk, mode] of [
      [KK_MAJOR, 'major'],
      [KK_MINOR, 'minor'],
    ] as const) {
      const rotated = kk.map((_, i) => kk[(((i - tonic) % 12) + 12) % 12]);
      const r = pearson(profile, rotated);
      if (!best || r > best.r) best = { tonicPc: tonic, mode, r };
    }
  }
  if (!best) return null;
  return {
    tonicPc: best.tonicPc,
    mode: best.mode,
    name: keyDisplayName(best.tonicPc, best.mode),
    confidence: Math.max(0, Math.min(1, best.r)),
  };
}
