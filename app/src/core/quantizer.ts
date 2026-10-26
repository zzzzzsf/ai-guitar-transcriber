/**
 * BPM 节拍检测与量化网格 — 冻结自《吉他扒谱-细化方案 v4.1》§3.1（借鉴 Malody 范式）。
 *
 * 三大范式：
 * 1. 谐波相关（HarmonicCorrelation）替纯自相关：同一拍点同时评估半拍/一拍/两拍，消歧倍频/半频。
 * 2. 分段 BPM：支持变速曲（指弹 rubato、摇滚变拍），输出 BeatSection[]。
 * 3. 手动 tap 测量：中位数离群剔除 + 圆周相位 + 置信度。
 *
 * 纯 TS 实现，无外部依赖。
 */
import type { BeatGrid, BeatSection, RawNote } from '../profiles/IInstrumentProfile';

// ---------- FFT（radix-2 迭代） ----------

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const uRe = re[a];
        const uIm = im[a];
        const vRe = re[b] * curRe - im[b] * curIm;
        const vIm = re[b] * curIm + im[b] * curRe;
        re[a] = uRe + vRe;
        im[a] = uIm + vIm;
        re[b] = uRe - vRe;
        im[b] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// ---------- onset 包络（HFC：频谱加权，对瞬态敏感） ----------

export type OnsetEnvelope = { hopSec: number; values: Float32Array };

const FFT_FRAME = 1024;
/** hop 必须远小于节拍周期：hop=256 时相邻点击的帧相位仅差 0.16 hop，
 *  否则帧网格会与每 2 拍结构性对齐，包络被人为加上“强弱拍”（倍频误判根源） */
const FFT_HOP = 256;

export function computeOnsetEnvelope(samples: Float32Array, sampleRate: number): OnsetEnvelope {
  const hopSec = FFT_HOP / sampleRate;
  const nFrames = Math.max(1, Math.floor((samples.length - FFT_FRAME) / FFT_HOP) + 1);
  const hfc = new Float64Array(nFrames);
  const re = new Float64Array(FFT_FRAME);
  const im = new Float64Array(FFT_FRAME);
  const window = new Float64Array(FFT_FRAME);
  for (let i = 0; i < FFT_FRAME; i++) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_FRAME - 1)));

  for (let f = 0; f < nFrames; f++) {
    const off = f * FFT_HOP;
    for (let i = 0; i < FFT_FRAME; i++) {
      re[i] = off + i < samples.length ? samples[off + i] * window[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    let sum = 0;
    for (let k = 1; k < FFT_FRAME / 2; k++) {
      const mag2 = re[k] * re[k] + im[k] * im[k];
      sum += mag2 * k;
    }
    hfc[f] = sum;
  }

  const values = new Float32Array(nFrames);
  for (let f = 1; f < nFrames; f++) values[f] = Math.max(0, hfc[f] - hfc[f - 1]);
  // 多遍 3 帧滑动平均（≈宽三角核）：加宽 onset 峰，抹平 FFT hop 网格相位 cycling
  // 造成的峰形抖动——本包络只用于 BPM 检测，不需要保留瞬态精度（音符 onset 由
  // basic-pitch 提供）。
  for (let pass = 0; pass < 4; pass++) smooth3(values);
  normalize(values);
  return { hopSec, values };
}

function smooth3(v: Float32Array): void {
  let prev = v[0];
  for (let i = 1; i < v.length - 1; i++) {
    const cur = v[i];
    v[i] = (prev + cur + v[i + 1]) / 3;
    prev = cur;
  }
}

function normalize(v: Float32Array): void {
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, v[i]);
  if (max > 0) for (let i = 0; i < v.length; i++) v[i] /= max;
}

// ---------- 谐波相关 BPM 检测 ----------

const BPM_MIN = 40;
const BPM_MAX = 300;

/**
 * 分数滞后自相关：对包络做线性插值平移后求 Pearson 相关。
 * 整数滞后会在帧网格上产生系统性伪影（半帧错位的相关度远低于真值），
 * 完美周期信号下 P 与 2P 的相关度必须相等，倍频解析才可靠。
 */
function correlationAtLag(env: Float32Array, lagFrac: number): number {
  const lo = Math.floor(lagFrac);
  const t = lagFrac - lo;
  const n = env.length - lo - 1;
  if (n < 8) return 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += env[i];
    sy += env[i + lo] * (1 - t) + env[i + lo + 1] * t;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = env[i] - mx;
    const dy = env[i + lo] * (1 - t) + env[i + lo + 1] * t - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  return denom > 1e-12 ? sxy / denom : 0;
}

/**
 * 谐波相关评分（Malody 范式）：
 * corr(lag×0.5)×0.2 + corr(lag)×1.0 + corr(lag×2)×0.15
 */
function harmonicScore(env: Float32Array, hopSec: number, bpm: number): number {
  const lag = 60 / bpm / hopSec;
  return (
    0.2 * correlationAtLag(env, lag * 0.5) +
    1.0 * correlationAtLag(env, lag) +
    0.15 * correlationAtLag(env, lag * 2)
  );
}

/**
 * 倍频/半频解析：完美周期信号下整倍周期相关度同样为 1，加和公式天然偏向慢速候选。
 * 若本候选的半拍滞后仍高度相关（说明拍点本身是细分），则翻倍到更快的拍层级。
 */
function resolveOctave(bpm: number, env: Float32Array, hopSec: number): number {
  let result = bpm;
  for (let guard = 0; guard < 4; guard++) {
    if (result * 2 > BPM_MAX) break;
    const lag = 60 / result / hopSec;
    const self = correlationAtLag(env, lag);
    const half = correlationAtLag(env, lag * 0.5);
    if (half < 0.5 || half <= 0.8 * self) break;
    result *= 2;
  }
  return result;
}

function bestBpmInRange(env: Float32Array, hopSec: number, lo: number, hi: number, step: number): number {
  let best = 120;
  let bestScore = -Infinity;
  for (let bpm = lo; bpm <= hi; bpm += step) {
    const s = harmonicScore(env, hopSec, bpm);
    if (s > bestScore) {
      bestScore = s;
      best = bpm;
    }
  }
  return best;
}

function bestBpm(env: Float32Array, hopSec: number): number {
  const coarse = bestBpmInRange(env, hopSec, BPM_MIN, BPM_MAX, 0.5);
  // 粗搜后 ±1 BPM 精搜，再做倍频解析
  const fine = bestBpmInRange(env, hopSec, Math.max(BPM_MIN, coarse - 1), Math.min(BPM_MAX, coarse + 1), 0.05);
  return resolveOctave(fine, env, hopSec);
}

export type DetectTempoOptions = {
  /** 分段分析窗口（秒） */
  windowSec?: number;
  /** 分段滑窗步长（秒） */
  hopSec?: number;
};

/**
 * 分段 BPM 检测：支持变速曲；相邻段偏差 < 5% 合并，短孤岛段被剔除。
 */
export function detectBpmSections(env: OnsetEnvelope, opts: DetectTempoOptions = {}): BeatSection[] {
  const windowSec = opts.windowSec ?? 6;
  const hopSecWin = opts.hopSec ?? 3;
  const winFrames = Math.max(16, Math.round(windowSec / env.hopSec));
  const hopFrames = Math.max(8, Math.round(hopSecWin / env.hopSec));

  const points: { time: number; bpm: number }[] = [];
  if (env.values.length <= winFrames) {
    const bpm = bestBpm(env.values, env.hopSec);
    points.push({ time: 0, bpm });
  } else {
    for (let start = 0; start + winFrames <= env.values.length; start += hopFrames) {
      const sub = env.values.subarray(start, start + winFrames);
      points.push({ time: start * env.hopSec, bpm: bestBpm(sub, env.hopSec) });
    }
  }
  if (points.length === 0) return [];

  // 相邻段偏差 < 5% 合并
  const merged: { startTime: number; endTime: number; bpms: number[] }[] = [];
  for (const p of points) {
    const last = merged[merged.length - 1];
    const mean = last ? last.bpms.reduce((s, b) => s + b, 0) / last.bpms.length : 0;
    if (last && Math.abs(p.bpm - mean) / mean < 0.05) {
      last.bpms.push(p.bpm);
      last.endTime = p.time + windowSec;
    } else {
      merged.push({ startTime: p.time, endTime: p.time + windowSec, bpms: [p.bpm] });
    }
  }

  // 剔除短孤岛段（< 1.5 个窗口宽，且与邻段差 < 5%）
  const sections: BeatSection[] = [];
  for (let i = 0; i < merged.length; i++) {
    const m = merged[i];
    const bpm = m.bpms.reduce((s, b) => s + b, 0) / m.bpms.length;
    const duration = m.endTime - m.startTime;
    const isShortIsland =
      merged.length > 1 &&
      duration < windowSec * 1.5 &&
      ((i > 0 && Math.abs(bpm - avgOf(merged[i - 1])) / avgOf(merged[i - 1]) < 0.05) ||
        (i < merged.length - 1 && Math.abs(bpm - avgOf(merged[i + 1])) / avgOf(merged[i + 1]) < 0.05));
    if (isShortIsland && sections.length > 0) {
      sections[sections.length - 1].end = m.endTime;
      continue;
    }
    const start = sections.length === 0 ? 0 : sections[sections.length - 1].end;
    sections.push({ start, end: m.endTime, bpm: Number(bpm.toFixed(1)), timeSignature: [4, 4] });
  }
  // 补齐末尾到包络结束
  const totalSec = env.values.length * env.hopSec;
  if (sections.length) sections[sections.length - 1].end = Math.max(sections[sections.length - 1].end, totalSec);
  return sections;
}

function avgOf(m: { bpms: number[] }): number {
  return m.bpms.reduce((s, b) => s + b, 0) / m.bpms.length;
}

/** 一步到位：PCM → onset 包络 → 分段 BPM */
export function detectTempo(samples: Float32Array, sampleRate: number): BeatSection[] {
  return detectBpmSections(computeOnsetEnvelope(samples, sampleRate));
}

// ---------- BeatGrid 构建 ----------

export function buildBeatGrid(
  bpm: number,
  durationSec: number,
  timeSignature: [number, number] = [4, 4],
): BeatGrid {
  const beatSec = 60 / bpm;
  const beats: number[] = [];
  for (let t = 0; t <= durationSec + 1e-9; t += beatSec) beats.push(Number(t.toFixed(6)));
  return { sections: [{ start: 0, end: durationSec, bpm, timeSignature }], beats };
}

export function buildBeatGridFromSections(sections: BeatSection[]): BeatGrid {
  const beats: number[] = [];
  for (const s of sections) {
    const beatSec = 60 / s.bpm;
    for (let t = s.start; t < s.end - 1e-9; t += beatSec) beats.push(Number(t.toFixed(6)));
  }
  return { sections, beats };
}

// ---------- 手动 tap 测量（§3.1：中位数 + 离群剔除 + 圆周相位 + 置信度） ----------

export type TapResult = { bpm: number; confidence: number; /** beat 0 落点（ms） */ phaseMs: number };

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

export function tapTempo(tapsMs: number[]): TapResult {
  const intervals: number[] = [];
  for (let i = 1; i < tapsMs.length; i++) {
    const d = tapsMs[i] - tapsMs[i - 1];
    // 间隔过滤 100ms ~ 2000ms
    if (d >= 100 && d <= 2000) intervals.push(d);
  }
  if (intervals.length < 3) return { bpm: 0, confidence: 0, phaseMs: 0 };

  const med = median(intervals);
  // 中位数离群剔除：tolerance = max(55ms, median×35%)
  const tol = Math.max(55, med * 0.35);
  const kept = intervals.filter((d) => Math.abs(d - med) <= tol);
  const used = kept.length >= 2 ? kept : [med];
  const avg = used.reduce((s, d) => s + d, 0) / used.length;
  const bpm = clamp(60000 / avg, 30, 400);

  // 稳定性：归一化中位绝对偏差
  const mad = median(used.map((d) => Math.abs(d - med)));
  const instability = clamp(mad / med, 0, 1);
  // 置信度 = (taps-3)/9 先 clamp 0.15~1.0，再乘 (1 - instability×0.75)，最终 clamp 0.05~0.99
  const sampleConf = clamp((tapsMs.length - 3) / 9, 0.15, 1.0);
  const confidence = clamp(sampleConf * (1 - instability * 0.75), 0.05, 0.99);

  // 圆周相位（atan2 向量和）求 beat 0 落点
  const period = 60000 / bpm;
  let sinSum = 0;
  let cosSum = 0;
  for (const t of tapsMs) {
    const angle = ((t % period) / period) * 2 * Math.PI;
    sinSum += Math.sin(angle);
    cosSum += Math.cos(angle);
  }
  const phaseMs = (Math.atan2(sinSum, cosSum) / (2 * Math.PI)) * period;

  return { bpm: Number(bpm.toFixed(1)), confidence: Number(confidence.toFixed(2)), phaseMs };
}

// ---------- 量化网格对齐 ----------

export type QuantizeStrength = 'strict' | 'soft' | 'off';

/**
 * 把每个音符 onset/duration 对齐到节拍网格 —— 逐拍双网格检测（§3.1 修订版）：
 * 每拍同时评估二等分网格（1/16）与三等分网格（三连音 16 分），取拟合误差小者；
 * 三等分胜出时输出 tuplet（吉他三连音极常见，只对齐 2 的幂网格会把三连音时值全错记）。
 * - strict：全部对齐
 * - soft：仅对齐距网格 ≤ 1/32 时值的音符（其余保留原值 = 自由节奏）
 * - off：不量化
 * 同分偏好二等分（bias：三等分需严格更近才胜出）。
 * 分段感知（§3.5）：每个音符使用其所在 BeatSection 的 BPM。
 */
export function quantizeNotes(
  notes: RawNote[],
  grid: BeatGrid,
  strength: QuantizeStrength = 'soft',
): RawNote[] {
  if (strength === 'off') return notes.map((n) => ({ ...n }));
  const sectionAt = (t: number): BeatSection => {
    const s = grid.sections.find((x) => t >= x.start && t < x.end - 1e-9);
    return s ?? grid.sections[grid.sections.length - 1];
  };
  const cache = new Map<BeatSection, { origin: number; binStep: number; triStep: number; freeTol: number }>();
  const stepsFor = (s: BeatSection) => {
    let v = cache.get(s);
    if (!v) {
      const beatSec = 60 / (s?.bpm || 120);
      // 网格原点 = 段起点（与 buildBeatGridFromSections 的段内拍相位一致）；
      // 变速曲第二段的音符按自己段的网格对齐，而非全局 0 的倍数
      v = { origin: s?.start ?? 0, binStep: beatSec / 4, triStep: beatSec / 6, freeTol: beatSec / 32 };
      cache.set(s, v);
    }
    return v;
  };

  // 选择网格：三等分需严格更近才胜出（同分偏二等分）；t 相对段原点取整后平移回去
  const snapIn = (
    t: number,
    origin: number,
    binStep: number,
    triStep: number,
  ): { time: number; tuplet: '3' | undefined } => {
    const rel = t - origin;
    const bin = Math.round(rel / binStep) * binStep + origin;
    const tri = Math.round(rel / triStep) * triStep + origin;
    if (Math.abs(t - tri) < Math.abs(t - bin) - 1e-9) {
      return { time: Number(tri.toFixed(6)), tuplet: '3' as const };
    }
    return { time: Number(bin.toFixed(6)), tuplet: undefined };
  };

  return notes.map((n) => {
    const { origin, binStep, triStep, freeTol } = stepsFor(sectionAt(n.onset));
    const onsetPick = snapIn(n.onset, origin, binStep, triStep);
    const onsetDist = Math.abs(n.onset - onsetPick.time);
    if (strength === 'soft' && onsetDist > freeTol) return { ...n }; // 自由节奏
    const onset = onsetPick.time;
    // 时值终点用与 onset 相同的网格，保证三连音内部一致
    const endRaw = n.onset + n.duration;
    const step = onsetPick.tuplet === '3' ? triStep : binStep;
    const end = Math.max(Math.round((endRaw - origin) / step) * step + origin, onset + step);
    return {
      ...n,
      onset,
      duration: Number((end - onset).toFixed(6)),
      tuplet: onsetPick.tuplet,
    };
  });
}

// ---------- 变速曲处理（§3.5）：BOCPD 变点检测 + CI 判据 + 候选置信度 ----------

export type TempoCandidate = {
  /** 变速点位置（秒，该拍的时刻） */
  time: number;
  /** 变速点前的拍索引（逐拍序列下标） */
  beatIndex: number;
  /** 变速前段 BPM（中位估计） */
  bpmBefore: number;
  /** 变速后段 BPM（中位估计） */
  bpmAfter: number;
  /** 候选置信度 = BOCPD 变点后验峰值 × CI 分离度（0~1，§3.5 统一定义） */
  confidence: number;
  /** 渐变段标记：BOCPD 密集变点簇（后处理合并为线性渐变） */
  gradient: boolean;
  /** 渐变段终点（秒；仅 gradient 候选有） */
  endTime?: number;
};

/** 渐进 UX 阈值（§3.5）：≥ 此值自动应用不打扰 */
export const TEMPO_AUTO_APPLY = 0.8;
/** 渐进 UX 阈值（§3.5）：≥ 此值进入确认流，低于则不出现 */
export const TEMPO_CONFIRM = 0.4;

type RunState = { logp: number; n: number; mean: number; m2: number };

function logSumExp(a: number, b: number): number {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

/**
 * 变速候选检测（§3.5 三层升级）：
 * 1. 统计显著性：每段 BPM 估计自带 95% CI，段间 CI 不重叠才算候选（保守判据，
 *    稳拍下 118→122 可检出；演奏不稳段 CI 宽自动钝感）；
 * 2. BOCPD 变点检测：逐拍 BPM 序列上的贝叶斯在线变点（高斯预测 + 常数风险函数），
 *    输出每时间点变速后验；密集变点簇 → 渐变段标记；
 * 3. 段落先验：boundaryTimes（段落边界，如能量/结构分割）附近变点概率加权，
 *    纯吉他独奏结构信号弱时传空数组自动退化为均匀先验。
 */
export function detectTempoCandidates(
  beatTimes: number[],
  opts: { runLenPrior?: number; boundaryTimes?: number[] } = {},
): TempoCandidate[] {
  if (beatTimes.length < 8) return [];
  const runLenPrior = opts.runLenPrior ?? 16;
  const hazard = 1 / runLenPrior;

  // 逐拍局部 BPM（4 拍滑窗均值），观测噪声 σ 用相邻拍间隔差的稳健估计
  const intervals: number[] = [];
  for (let i = 1; i < beatTimes.length; i++) intervals.push(beatTimes[i] - beatTimes[i - 1]);
  const diffs: number[] = [];
  for (let i = 1; i < intervals.length; i++) diffs.push(Math.abs(intervals[i] - intervals[i - 1]));
  const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const sigmaI = Math.max(1.4826 * median(diffs), 0.002); // 拍间隔噪声（秒），下限 2ms
  const W = 4;
  const bpmSeries: number[] = [];
  for (let i = 0; i + W <= intervals.length; i++) {
    let sum = 0;
    for (let k = 0; k < W; k++) sum += intervals[i + k];
    bpmSeries.push(60 / (sum / W));
  }
  if (bpmSeries.length < 4) return [];
  const bpmDiffs: number[] = [];
  for (let i = 1; i < bpmSeries.length; i++) bpmDiffs.push(Math.abs(bpmSeries[i] - bpmSeries[i - 1]));
  const sigmaB = Math.max(1.4826 * median(bpmDiffs), 0.5); // BPM 观测噪声，下限 0.5
  const obsVar = sigmaB * sigmaB;
  // 变点假设（r=0，新游程）的宽先验预测：标准 BOCPD 中新游程的预测应基于游程均值的先验，
  // 而非旧游程的预测分布——否则观测意外时新旧似然比退化为 h/(1-h)，变点永远检不出
  const priorMean = median(bpmSeries);
  const priorStd = Math.max(30, 6 * sigmaB);
  const priorPredictive = (x: number): number =>
    Math.exp(-0.5 * ((x - priorMean) / priorStd) ** 2) / Math.sqrt(2 * Math.PI * priorStd * priorStd);

  // BOCPD（高斯已知观测方差 + 常数风险函数），R = 游程长度后验
  let runs: RunState[] = [{ logp: 0, n: 0, mean: 0, m2: 0 }];
  const cpProb: number[] = [];
  for (let t = 0; t < bpmSeries.length; t++) {
    const x = bpmSeries[t];
    const next: RunState[] = [];
    let cpLogSum = -Infinity;
    for (const s of runs) {
      const predVar = obsVar + (s.n > 1 ? s.m2 / (s.n - 1) / s.n : 0);
      const predMean = s.n > 0 ? s.mean : x;
      const z = (x - predMean) / Math.sqrt(predVar);
      const pred = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI * predVar);
      const lp = Math.log(Math.max(pred, 1e-300));
      cpLogSum = logSumExp(cpLogSum, s.logp + Math.log(Math.max(priorPredictive(x), 1e-300)) + Math.log(hazard));
      // Welford 更新
      const n2 = s.n + 1;
      const delta = x - s.mean;
      const mean2 = s.mean + delta / n2;
      const m22 = s.m2 + delta * (x - mean2);
      next.push({ logp: s.logp + lp + Math.log(1 - hazard), n: n2, mean: mean2, m2: m22 });
    }
    // 变点：新游程 r=0
    next.push({ logp: cpLogSum, n: 1, mean: x, m2: 0 });
    // 归一化 + 剪枝（保留 top 24）
    next.sort((a, b) => b.logp - a.logp);
    const kept = next.slice(0, 24);
    const maxLogp = kept[0].logp;
    let sumExp = 0;
    for (const s of kept) s.logp -= maxLogp;
    for (const s of kept) sumExp += Math.exp(s.logp);
    for (const s of kept) s.logp -= Math.log(sumExp);
    // 变点后验 = r=0 的概率质量（新游程恰为本次观测）
    const cpMass = Math.exp(kept.find((s) => s.n === 1 && s.mean === x)?.logp ?? -Infinity);
    cpProb.push(Number.isFinite(cpMass) ? Math.min(1, cpMass) : 0);
    runs = kept;
  }

  // 后处理：阈值 → 聚簇（≤3 拍间隔合并）→ 渐变标记（簇宽 ≥4 拍）
  const TH = 0.2;
  const clusters: { startIdx: number; endIdx: number; peakIdx: number; peak: number }[] = [];
  for (let i = 0; i < cpProb.length; i++) {
    if (cpProb[i] < TH) continue;
    const last = clusters[clusters.length - 1];
    if (last && i - last.endIdx <= 3) {
      last.endIdx = i;
      if (cpProb[i] > last.peak) {
        last.peak = cpProb[i];
        last.peakIdx = i;
      }
    } else {
      clusters.push({ startIdx: i, endIdx: i, peakIdx: i, peak: cpProb[i] });
    }
  }

  const candidates: TempoCandidate[] = [];
  for (const c of clusters) {
    const i = c.peakIdx; // bpmSeries[i] 覆盖 intervals[i..i+W)
    const beatIdx = i + W - 1; // 变速点 ≈ 该窗口末拍
    if (i < 5 || beatIdx <= 0 || beatIdx >= beatTimes.length - 1) continue; // 需要足够历史（排除序列起点的建立瞬态）
    const side = (a: number, b: number): number[] => {
      const lo = Math.max(0, a);
      const hi = Math.min(bpmSeries.length, b);
      return hi <= lo ? [] : bpmSeries.slice(lo, hi);
    };
    const before = side(i - 8, i - 1);
    const after = side(i + 1, i + 8);
    if (before.length < 2 || after.length < 2) continue;
    const med = (v: number[]) => {
      const s = [...v].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const ciHalf = (v: number[]) => {
      const m = v.reduce((s, x) => s + x, 0) / v.length;
      const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, v.length - 1));
      return (1.96 * sd) / Math.sqrt(v.length);
    };
    const bpmBefore = med(before);
    const bpmAfter = med(after);
    const delta = Math.abs(bpmAfter - bpmBefore);
    if (delta < 1) continue; // 无实质变化
    const sep = Math.min(1, delta / (ciHalf(before) + ciHalf(after) + 1e-6)); // CI 分离度
    candidates.push({
      time: beatTimes[Math.min(beatIdx, beatTimes.length - 1)],
      beatIndex: beatIdx,
      bpmBefore: Number(bpmBefore.toFixed(1)),
      bpmAfter: Number(bpmAfter.toFixed(1)),
      confidence: Number((c.peak * sep).toFixed(2)),
      gradient: c.endIdx - c.startIdx >= 4,
    });
  }
  // 渐变趋势检测（与 BOCPD 突变互补）：BOCPD 假设段内突变，线性渐变不会密集触发变点；
  // 用滑窗线性拟合斜率显著且持续延伸来捕获渐变段（§3.5 渐变 = 密集变点簇 → 线性段）
  const Wg = 8;
  let gi = 0;
  while (gi + Wg <= bpmSeries.length) {
    const fit = (a: number, b: number) => {
      let sx = 0;
      let sy = 0;
      let sxy = 0;
      let sxx = 0;
      for (let k = a; k < b; k++) {
        sx += k;
        sy += bpmSeries[k];
        sxy += k * bpmSeries[k];
        sxx += k * k;
      }
      const n = b - a;
      const denom = n * sxx - sx * sx;
      const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
      return { slope, intercept: (sy - slope * sx) / n };
    };
    const w0 = fit(gi, gi + Wg);
    if (Math.abs(w0.slope) * Wg > 4 * sigmaB) {
      // 延伸：逐步扩大窗口重新拟合，点持续贴近趋势线且总变化仍显著则继续
      // （重拟合会稀释斜率——总变化掉回噪声水平说明这是阶跃而非渐变，交给 BOCPD 路径）
      let j = gi + Wg;
      while (j < bpmSeries.length) {
        const ext = fit(gi, j + 1);
        if (Math.abs(ext.slope) * (j + 1 - gi) <= 4 * sigmaB) break;
        if (Math.abs(bpmSeries[j] - (ext.intercept + ext.slope * j)) > 2.5 * sigmaB + 0.5) break;
        j++;
      }
      // 持续性判别：真渐变的斜率持续多个窗口；阶跃的“趋势”延伸即停（交给 BOCPD 突变路径）
      if (j - gi >= Wg + 4) {
        const bpmBefore = bpmSeries[gi];
        const bpmAfter = bpmSeries[Math.min(j - 1, bpmSeries.length - 1)];
        const delta = Math.abs(bpmAfter - bpmBefore);
        // 变化集中度判别（原始拍间隔）：阶跃的变化集中在单步，渐变是分散的——
        // 单步跳变占总变化的一半以上视为阶跃，不算渐变
        const spanStart = Math.max(0, gi);
        const spanEnd = Math.min(intervals.length, j + Wg);
        let maxJump = 0;
        for (let k = spanStart + 1; k < spanEnd; k++) {
          maxJump = Math.max(maxJump, Math.abs(intervals[k] - intervals[k - 1]));
        }
        const ivBefore = median(intervals.slice(Math.max(0, gi - 4), Math.max(1, gi)));
        const ivAfter = median(intervals.slice(Math.min(intervals.length, j), Math.min(intervals.length, j + 8)));
        const totalChange = Math.abs(ivAfter - ivBefore);
        const stepLike = totalChange > 0 && maxJump > Math.max(3 * sigmaI, 0.5 * totalChange);
      if (delta >= 4 && !stepLike) {
        candidates.push({
          time: beatTimes[Math.min(gi, beatTimes.length - 1)],
          beatIndex: gi,
          bpmBefore: Number(bpmBefore.toFixed(1)),
          bpmAfter: Number(bpmAfter.toFixed(1)),
          confidence: Number(
            Math.min(0.99, 0.5 + 0.5 * Math.min(1, delta / (4 * sigmaB + 1e-6))).toFixed(2),
          ),
          gradient: true,
          endTime: beatTimes[Math.min(j, beatTimes.length - 1)],
        });
      }
        gi = j;
      } else {
        gi = Math.max(j, gi + 1);
      }
    } else {
      gi++;
    }
  }
  return candidates.sort((a, b) => a.time - b.time);
}

/**
 * 由变速点表构建分段 BeatSection[]（§3.5 参数表）：
 * - steps：{time, bpm} 升序变速点（bpm 为该点之后的新速度）；
 * - 相邻段 BPM 差 < 2 自动合并（渐变插值后的可读性保证）；
 * - 末段延伸到 durationSec。变速点对齐小节线由调用方（UI/检测后处理）负责。
 */
export function buildTempoMap(
  durationSec: number,
  timeSignature: [number, number],
  baseBpm: number,
  steps: { time: number; bpm: number }[],
): BeatSection[] {
  const clean = steps
    .map((s) => ({ time: Math.max(0, Math.min(s.time, durationSec - 1e-6)), bpm: Math.min(400, Math.max(30, s.bpm)) }))
    .filter((s) => s.time > 1e-6 && s.time < durationSec - 1e-6)
    .sort((a, b) => a.time - b.time);
  const sections: BeatSection[] = [];
  let cursor = 0;
  let bpm = Math.min(400, Math.max(30, baseBpm));
  for (const s of clean) {
    if (s.time - cursor < 1e-6) {
      bpm = s.bpm; // 同点重复取后者
      continue;
    }
    sections.push({ start: cursor, end: s.time, bpm: Number(bpm.toFixed(1)), timeSignature });
    cursor = s.time;
    bpm = s.bpm;
  }
  sections.push({ start: cursor, end: durationSec, bpm: Number(bpm.toFixed(1)), timeSignature });
  // 相邻差 < 2 BPM 合并
  const merged: BeatSection[] = [];
  for (const s of sections) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.bpm - s.bpm) < 2) last.end = s.end;
    else merged.push({ ...s });
  }
  return merged;
}

/** 渐变候选展开：在 [start, end] 内按小节长度线性插值出逐段变速点（§3.5 渐变段处理） */
export function expandGradientToSteps(
  g: { start: number; end: number; from: number; to: number },
  timeSignature: [number, number],
): { time: number; bpm: number }[] {
  const steps: { time: number; bpm: number }[] = [];
  const avgBar = timeSignature[0] * (60 / ((g.from + g.to) / 2));
  for (let t = g.start; t < g.end - 1e-6; t += avgBar) {
    const p = (t - g.start) / (g.end - g.start);
    steps.push({ time: t, bpm: g.from + (g.to - g.from) * p });
  }
  steps.push({ time: g.end, bpm: g.to });
  return steps;
}

/** 当前分段下第 bar 个小节（0 基）的起始时间（UI 插段定位用） */
export function barStartTime(sections: BeatSection[], bar: number): number {
  let count = 0;
  for (const s of sections) {
    const barSec = (s.timeSignature?.[0] ?? 4) * (60 / s.bpm);
    const barsInSection = Math.max(1, Math.ceil((s.end - s.start - 1e-9) / barSec));
    if (bar < count + barsInSection) return s.start + (bar - count) * barSec;
    count += barsInSection;
  }
  const last = sections[sections.length - 1];
  const barSec = (last?.timeSignature?.[0] ?? 4) * (60 / (last?.bpm || 120));
  return (last?.start ?? 0) + bar * barSec;
}

/** 分段 → 小节起点/每小节 BPM 表（toAlphaTex 与波形网格 overlay 共用，上限 limit 根） */
export function barStartsFromSections(
  sections: BeatSection[],
  limit = 400,
): { starts: number[]; bpms: number[] } {
  const starts: number[] = [];
  const bpms: number[] = [];
  for (const s of sections) {
    const barSec = (s.timeSignature?.[0] ?? 4) * (60 / s.bpm);
    for (let t = s.start; starts.length < limit && t < s.end - 1e-9; t += barSec) {
      starts.push(t);
      bpms.push(s.bpm);
    }
  }
  if (starts.length === 0) {
    starts.push(0);
    bpms.push(sections[0]?.bpm ?? 120);
  }
  return { starts, bpms };
}
