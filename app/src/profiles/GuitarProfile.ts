/**
 * GuitarProfile — 吉他物理规则引擎（首期核心，冻结自《吉他扒谱-细化方案 v4.1》§4.1/§4.2）。
 *
 * 五步后处理流水线：
 *   filterNotes → clusterEvents → detectTuning(Auto-Capo) → routeFretboard(Viterbi) → detectArticulation → toAlphaTex
 */
import type {
  CapoSuggestion,
  ClusterEvents,
  DetectArticulation,
  DetectTuning,
  FilterNotes,
  FingeringStyle,
  FrettedNote,
  IInstrumentProfile,
  InstrumentConfig,
  ProfileContext,
  RawNote,
  RouteFretboard,
  ToAlphaTex,
  TransformStep,
  TranscriptionResult,
} from './IInstrumentProfile';
import type { CostWeights } from './costWeights';
import { resolveWeights } from './costWeights';
import { detectKey, keyToAlphaTexToken } from '../core/keyDetector';
import type { KeySelection } from '../core/keyDetector';
import { barStartsFromSections } from '../core/quantizer';

// ---------- 常量 ----------

export {
  STANDARD_TUNING,
  DROP_D_TUNING,
  DADGAD_TUNING,
  OPEN_G_TUNING,
  OPEN_D_TUNING,
} from './tunings';
import { STANDARD_TUNING, DROP_D_TUNING, DADGAD_TUNING, OPEN_G_TUNING, OPEN_D_TUNING, midiName } from './tunings';

const NAMED_TUNINGS: [string, number[]][] = [
  ['标准调弦', STANDARD_TUNING],
  ['Drop D', DROP_D_TUNING],
  ['DADGAD', DADGAD_TUNING],
  ['Open G', OPEN_G_TUNING],
  ['Open D', OPEN_D_TUNING],
];

function tuningName(tuning: number[]): string {
  const key = tuning.join(',');
  return NAMED_TUNINGS.find(([, t]) => t.join(',') === key)?.[0] ?? '自定义调弦';
}

/** 吉他物理音域硬约束：Drop D 最低 D2(38) ~ 最高 E6(88) */
export const PITCH_MIN = 38;
export const PITCH_MAX = 88;
/** 剔除持续时间 < 35ms 的孤立泛音碎音 */
export const MIN_NOTE_DURATION = 0.035;
/** 同帧复音上限（6 根琴弦） */
export const POLYPHONY_LIMIT = 6;
/** 同帧判定窗口（秒） */
export const POLYPHONY_WINDOW = 0.035;
/** 扫弦物理延迟窗口：拨片划过 6 弦约 20~60ms */
export const STRUM_WINDOW = 0.05;
/** 寻路分簇窗口（秒） */
export const CLUSTER_WINDOW = 0.05;
/** 推弦/滑音碎片合并：起始间隔上限 */
export const BEND_MERGE_GAP = 0.045;
/** 视为“碎片”的最大时值（秒） */
export const FRAGMENT_MAX = 0.12;
/** 泛音候选与基频的半音差：3 次泛音 12·log₂3≈19.02 → +19，4 次泛音 +24（§2.1） */
export const HARMONIC_SEMITONES = [19, 24];
/** 「能量显著更弱」判定：疑似泛音 velocity ≤ 基频音符 velocity × 此比例（§2.1） */
export const HARMONIC_VELOCITY_RATIO = 0.6;
export const MAX_FRET = 24;
/** beam search 宽度（K=50~200 取中值） */
export const BEAM_WIDTH = 64;
/** 每簇最多保留的候选指法数 */
export const MAX_CLUSTER_CANDIDATES = 64;

// Auto-Capo 评分权重（§4.2 权重表）
const CAPO_W_OPENHIT = 2.0;
const CAPO_W_STRETCH = 1.0;
const CAPO_W_FRETAG = 0.5;
const CAPO_W_HIGHFRET = 1.0;
const CAPO_UNMAPPED_PENALTY = 8;
const CAPO_CONFLICT_PENALTY = 5;

// ---------- 内部类型 ----------

type Choice = { stringIdx: number; fret: number };
type Candidate = {
  /** 与 notes/pitches 一一对应（均按音高降序） */
  assign: Choice[];
  pitches: number[];
  notes: RawNote[];
  /** 簇内代价（不含转移） */
  intra: number;
  /** 手掌中心把位（非空弦品位均值） */
  pos: number;
};

// ---------- 工具函数 ----------

/** 按 onset 窗口分簇（扫弦对齐后同簇音符共享起始时间） */
export function buildClusters(notes: RawNote[], window: number): RawNote[][] {
  const sorted = [...notes].sort((a, b) => a.onset - b.onset);
  const clusters: RawNote[][] = [];
  for (const n of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && n.onset - last[0].onset <= window) last.push(n);
    else clusters.push([n]);
  }
  return clusters;
}

function maxAbsCents(bend: { cents: number }[]): number {
  return bend.reduce((m, p) => Math.max(m, Math.abs(p.cents)), 0);
}

// ---------- 1. 音域与复音硬约束过滤 ----------

export const filterNotes: FilterNotes = (notes) => {
  const inRange = notes.filter(
    (n) => n.pitch >= PITCH_MIN && n.pitch <= PITCH_MAX && n.duration >= MIN_NOTE_DURATION,
  );
  const kept: RawNote[] = [];
  for (const cluster of buildClusters(inRange, POLYPHONY_WINDOW)) {
    const top = [...cluster]
      .sort((a, b) => b.velocity - a.velocity)
      .slice(0, POLYPHONY_LIMIT);
    top.sort((a, b) => a.pitch - b.pitch);
    kept.push(...top);
  }
  return kept.sort((a, b) => a.onset - b.onset);
};

// ---------- 2. 扫弦聚拢 + 推弦合并 ----------

export const clusterEvents: ClusterEvents = (notes) => {
  const sorted = notes.map((n) => ({ ...n })).sort((a, b) => a.onset - b.onset);
  const out: RawNote[] = [];
  let i = 0;
  while (i < sorted.length) {
    const head = sorted[i];
    const strum: RawNote[] = [head];
    let dir: 'up' | 'down' | null = null;
    let j = i + 1;
    while (j < sorted.length) {
      const prev = strum[strum.length - 1];
      const next = sorted[j];
      const dt = next.onset - prev.onset;
      if (dt > STRUM_WINDOW) break;
      const dp = next.pitch - prev.pitch;
      if (dp === 0) break;
      const d = dp > 0 ? ('up' as const) : ('down' as const);
      if (dir === null) dir = d;
      else if (dir !== d) break;
      strum.push(next);
      j++;
    }
    if (strum.length > 1) {
      // 下扫/上扫的物理延迟不应渲染成碎琶音：对齐到簇内最早音头
      const t0 = strum[0].onset;
      for (const s of strum) s.onset = t0;
    }
    out.push(...strum);
    i = j;
  }

  // 推弦/滑音还原：把连续滑动的半音碎片合并为单一音符（bendrescue）
  const merged: RawNote[] = [];
  for (const n of out) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const gap = n.onset - (prev.onset + prev.duration);
      const dp = Math.abs(n.pitch - prev.pitch);
      const fragmentish = prev.duration < FRAGMENT_MAX || n.duration < FRAGMENT_MAX;
      const bendish = prev.pitchBend.length > 0 || n.pitchBend.length > 0;
      if (gap <= BEND_MERGE_GAP && dp <= 2 && (bendish || fragmentish)) {
        prev.duration = n.onset + n.duration - prev.onset;
        prev.pitchBend = [...prev.pitchBend, ...n.pitchBend];
        continue;
      }
    }
    merged.push(n);
  }
  markSuspectedHarmonics(merged);
  return merged;
};

/**
 * 泛音误检抑制（§2.1 2026-10 补，标记制）：多音高检测的经典错误是把 3/4 次泛音
 * 误检为独立音符（合成演示音频上表现为 19~24 品伪音符）。同簇内（onset 对齐）
 * 相对更强低音 +19/+24 半音、能量显著更弱 → 标记 suspectedHarmonic。
 * 认知澄清（§2.1）：只标记不删除——Viterbi 无法抑制伪音符（音符既已检出音高必须
 * 落在某处，w_fret/pos_prior 只在有替代位置时起效，reach 约束簇内跨度不约束绝对
 * 品位），toAlphaTex 阶段不入谱，交 §2.4 编辑器处置。
 */
export function markSuspectedHarmonics(notes: RawNote[]): void {
  for (const cluster of buildClusters(notes, POLYPHONY_WINDOW)) {
    const byPitch = [...cluster].sort((a, b) => a.pitch - b.pitch);
    for (const cand of byPitch) {
      if (cand.suspectedHarmonic) continue;
      for (const base of byPitch) {
        if (base === cand || base.suspectedHarmonic) continue;
        const diff = cand.pitch - base.pitch;
        if (!HARMONIC_SEMITONES.includes(diff)) continue;
        // 能量显著更弱才标记；与基频同量级的音是真音符（八度关系很常见）
        if (cand.velocity > base.velocity * HARMONIC_VELOCITY_RATIO) continue;
        cand.suspectedHarmonic = true;
        break;
      }
    }
  }
}

// ---------- 3. 调弦与变调夹自动推导（Auto-Capo，§4.2） ----------

type CapoEval = {
  tuning: number[];
  capo: number;
  score: number;
  openHit: number;
  avgStretch: number;
  avgFret: number;
  highFretRate: number;
  unmappedRate: number;
  conflictRate: number;
};

/** 每个音符取“品位最低”的可弹位置；返回 null 表示该调弦下弹不出 */
function mapNotes(
  notes: RawNote[],
  tuning: number[],
  capo: number,
): (Choice | null)[] {
  return notes.map((n) => {
    let best: Choice | null = null;
    for (let s = 0; s < tuning.length; s++) {
      const fret = n.pitch - (tuning[s] + capo);
      if (fret >= 0 && fret <= MAX_FRET && (!best || fret < best.fret)) {
        best = { stringIdx: s, fret };
      }
    }
    return best;
  });
}

function evaluateCapoCandidate(
  notes: RawNote[],
  tuning: number[],
  capo: number,
  reach: number,
): CapoEval {
  const mapped = mapNotes(notes, tuning, capo);
  const unmapped = mapped.filter((m) => m === null).length;
  const mappedNotes = mapped.filter((m): m is Choice => m !== null);
  const openHit = mappedNotes.length
    ? mappedNotes.filter((m) => m.fret === 0).length / mappedNotes.length
    : 0;
  const avgFret = mappedNotes.length
    ? mappedNotes.reduce((s, m) => s + m.fret, 0) / mappedNotes.length
    : 0;
  const highFretRate = mappedNotes.length
    ? mappedNotes.filter((m) => m.fret > 12).length / mappedNotes.length
    : 0;

  const clusters = buildClusters(notes, CLUSTER_WINDOW);
  const mappedByNote = new Map<RawNote, Choice | null>();
  notes.forEach((n, i) => mappedByNote.set(n, mapped[i]));
  let conflictCount = 0;
  let stretchSum = 0;
  for (const c of clusters) {
    const choices = c.map((n) => mappedByNote.get(n) ?? null);
    const used = new Set<number>();
    let conflict = false;
    const frets: number[] = [];
    choices.forEach((ch) => {
      if (!ch) return;
      if (used.has(ch.stringIdx)) conflict = true;
      used.add(ch.stringIdx);
      if (ch.fret > 0) frets.push(ch.fret);
    });
    if (conflict) conflictCount++;
    const stretch =
      frets.length >= 2 ? Math.max(...frets) - Math.min(...frets) : 0;
    stretchSum += Math.min(stretch, reach + 4);
  }

  const unmappedRate = notes.length ? unmapped / notes.length : 0;
  const conflictRate = clusters.length ? conflictCount / clusters.length : 0;
  const avgStretch = clusters.length ? stretchSum / clusters.length : 0;
  const score =
    CAPO_W_OPENHIT * openHit -
    CAPO_W_STRETCH * avgStretch -
    CAPO_W_FRETAG * avgFret -
    CAPO_W_HIGHFRET * highFretRate -
    CAPO_UNMAPPED_PENALTY * unmappedRate -
    CAPO_CONFLICT_PENALTY * conflictRate;
  return { tuning, capo, score, openHit, avgStretch, avgFret, highFretRate, unmappedRate, conflictRate };
}

function toSuggestion(e: CapoEval): CapoSuggestion {
  return {
    capo: e.capo,
    tuning: e.tuning,
    score: Number(e.score.toFixed(3)),
    reason: `Capo ${e.capo} + ${tuningName(e.tuning)}：空弦命中 ${Math.round(e.openHit * 100)}%，平均跨度 ${e.avgStretch.toFixed(1)} 品，高品音 ${Math.round(e.highFretRate * 100)}%`,
  };
}

export const detectTuning: DetectTuning = (notes, ctx) => {
  const reach = ctx.weights.reach;

  // 用户显式配置优先：固定调弦下仅自动推导 Capo
  if (ctx.config.tuning) {
    const tuning = ctx.config.tuning;
    const evals: CapoEval[] = [];
    if (ctx.config.capo !== undefined) {
      evals.push(evaluateCapoCandidate(notes, tuning, ctx.config.capo, reach));
    } else {
      for (let capo = 0; capo <= 7; capo++) {
        evals.push(evaluateCapoCandidate(notes, tuning, capo, reach));
      }
      evals.sort((a, b) => b.score - a.score);
    }
    const best = evals[0];
    const suggestions = [...evals]
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(toSuggestion);
    return { tuning, capo: best?.capo ?? 0, suggestions, autoDetected: ctx.config.capo === undefined };
  }

  const candidateTunings = ctx.candidateTunings ?? [STANDARD_TUNING, DROP_D_TUNING];
  const evals: CapoEval[] = [];
  for (const tuning of candidateTunings) {
    for (let capo = 0; capo <= 7; capo++) {
      evals.push(evaluateCapoCandidate(notes, tuning, capo, reach));
    }
  }
  evals.sort((a, b) => b.score - a.score);
  const best = evals[0];
  return {
    tuning: best.tuning,
    capo: best.capo,
    suggestions: evals.slice(0, 3).map(toSuggestion),
    autoDetected: true,
  };
};

// ---------- 4. Viterbi 弦品寻路（beam search，§4.1） ----------

function choiceCost(ch: Choice, w: CostWeights): number {
  return (
    w.wFret * (ch.fret / 24) +
    (ch.fret === 0 ? w.wOpen : 0) +
    w.wPosPrior * Math.abs(ch.fret - w.posPriorCenter)
  );
}

function stretchCost(stretch: number, w: CostWeights): number {
  if (stretch <= w.reach) return 0;
  return Math.exp((stretch - w.reach) * 0.7);
}

function genCandidates(cluster: RawNote[], tuning: number[], capo: number, w: CostWeights): Candidate[] {
  const sortedNotes = [...cluster].sort((a, b) => b.pitch - a.pitch);
  const pitches = sortedNotes.map((n) => n.pitch);
  const choiceLists = pitches.map((pitch) => {
    const list: Choice[] = [];
    for (let s = 0; s < tuning.length; s++) {
      const fret = pitch - (tuning[s] + capo);
      if (fret >= 0 && fret <= MAX_FRET) list.push({ stringIdx: s, fret });
    }
    list.sort((a, b) => choiceCost(a, w) - choiceCost(b, w));
    if (list.length === 0) {
      // 兜底：该音在此调弦/品数内弹不出（理论上 Auto-Capo 已规避），夹到最近可弹品位
      let bestS = 0;
      let bestDist = Infinity;
      for (let s = 0; s < tuning.length; s++) {
        const d = Math.abs(pitch - (tuning[s] + capo));
        if (d < bestDist) {
          bestDist = d;
          bestS = s;
        }
      }
      const fret = Math.min(Math.max(pitch - (tuning[bestS] + capo), 0), MAX_FRET);
      list.push({ stringIdx: bestS, fret });
    }
    return list;
  });

  const out: Candidate[] = [];
  const dfs = (
    i: number,
    used: Set<number>,
    assign: Choice[],
    cost: number,
    lo: number,
    hi: number,
    stretchLimit: number,
  ) => {
    if (out.length >= 512) return;
    if (i === pitches.length) {
      const nz = assign.filter((c) => c.fret > 0).map((c) => c.fret);
      const stretch = nz.length >= 2 ? Math.max(...nz) - Math.min(...nz) : 0;
      const pos = nz.length ? nz.reduce((s, f) => s + f, 0) / nz.length : 0;
      out.push({
        assign: [...assign],
        pitches,
        notes: sortedNotes,
        intra: cost + w.wStretch * stretchCost(stretch, w),
        pos,
      });
      return;
    }
    for (const ch of choiceLists[i]) {
      if (used.has(ch.stringIdx)) continue;
      const nlo = ch.fret > 0 ? Math.min(lo, ch.fret) : lo;
      const nhi = ch.fret > 0 ? Math.max(hi, ch.fret) : hi;
      if (nhi - nlo > stretchLimit) continue;
      used.add(ch.stringIdx);
      assign.push(ch);
      dfs(i + 1, used, assign, cost + choiceCost(ch, w), nlo, nhi, stretchLimit);
      assign.pop();
      used.delete(ch.stringIdx);
    }
  };
  dfs(0, new Set(), [], 0, Infinity, -Infinity, w.reach * 2);
  if (out.length === 0) {
    // 兜底：reach×2 强剪枝可能清空候选（泛音堆叠簇高低调并存时，如 6 弦 0 品 +
    // 1 弦 10 品同簇）——放宽剪枝重试。stretch 代价仍在 intra 内生效，只是不让
    // beam 因空候选集灭束（灭束 = 整曲 0 音符，比个别簇指法差严重得多）
    dfs(0, new Set(), [], 0, Infinity, -Infinity, Infinity);
  }

  // 去重 + 截断
  const seen = new Set<string>();
  const unique = out.filter((c) => {
    const key = c.assign.map((a) => `${a.stringIdx}:${a.fret}`).join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a.intra - b.intra);
  return unique.slice(0, MAX_CLUSTER_CANDIDATES);
}

function transitionCost(prev: Candidate, curr: Candidate, dt: number, w: CostWeights): number {
  let cost = 0;
  // 把位移动：时间衰减 + 休止豁免
  if (dt <= w.moveFreeGap) {
    cost += w.wMove * Math.abs(curr.pos - prev.pos) * Math.exp(-dt * w.timeFactorK);
  }
  // 换弦：与把位移动是两个维度，同音换弦单独计价
  const prevByPitch = new Map<number, number>();
  prev.assign.forEach((ch, i) => prevByPitch.set(prev.pitches[i], ch.stringIdx));
  let stringChanges = 0;
  curr.assign.forEach((ch, i) => {
    const prevString = prevByPitch.get(curr.pitches[i]);
    if (prevString !== undefined && prevString !== ch.stringIdx) stringChanges++;
  });
  cost += w.wStringChange * stringChanges;
  return cost;
}

export const routeFretboard: RouteFretboard = (notes, ctx) => {
  if (notes.length === 0) return [];
  const tuning = ctx.tuning?.tuning ?? ctx.config.tuning ?? STANDARD_TUNING;
  const capo = ctx.tuning?.capo ?? ctx.config.capo ?? 0;
  const w = ctx.weights;
  const clusters = buildClusters(notes, CLUSTER_WINDOW);
  // 同帧复音上限（§4.1 同弦互斥的推论）：簇内音符数 > 弦数时候选集为空
  // （6 根弦放不下 8 个音，beam 整段灭束——长曲量化后泛音堆叠会触发）→
  // 与 filterNotes 的复音上限同策略，保留 velocity 最高的前 N 个
  const stringCount = tuning.length;
  const candLists = clusters.map((c) =>
    genCandidates(
      c.length > stringCount ? [...c].sort((a, b) => b.velocity - a.velocity).slice(0, stringCount) : c,
      tuning,
      capo,
      w,
    ),
  );

  type Node = { cand: Candidate; prev: Node | null; cost: number };
  let beam: Node[] = [];
  let prevClusterIdx = -1;
  for (let t = 0; t < candLists.length; t++) {
    const list = candLists[t];
    // 防御：候选为空的簇跳过（该簇音符不入路由），beam 存活优先于个别簇的指法
    if (list.length === 0) continue;
    if (beam.length === 0) {
      beam = list.map((c) => ({ cand: c, prev: null, cost: c.intra }));
    } else {
      const dt = clusters[t][0].onset - clusters[prevClusterIdx][0].onset;
      const next: Node[] = [];
      for (const node of beam) {
        for (const cand of list) {
          next.push({
            cand,
            prev: node,
            cost: node.cost + cand.intra + transitionCost(node.cand, cand, dt, w),
          });
        }
      }
      next.sort((a, b) => a.cost - b.cost);
      beam = next.slice(0, BEAM_WIDTH);
    }
    prevClusterIdx = t;
  }
  if (beam.length === 0) return [];
  const best = beam.reduce((m, n) => (n.cost < m.cost ? n : m), beam[0]);

  const chain: Candidate[] = [];
  for (let node: Node | null = best; node; node = node.prev) chain.unshift(node.cand);

  const out: FrettedNote[] = [];
  chain.forEach((cand) => {
    // assign[i] 与 cand.notes[i]（音高降序）一一对应
    cand.assign.forEach((ch, i) => {
      const raw = cand.notes[i];
      out.push({
        // alphaTab 弦号：1 = 最高音弦；stringIdx 0 = 低音弦
        string: tuning.length - ch.stringIdx,
        fret: ch.fret,
        onset: raw.onset,
        duration: raw.duration,
        pitch: raw.pitch,
        bend: raw.pitchBend.length ? raw.pitchBend : undefined,
        velocity: raw.velocity,
        tuplet: raw.tuplet,
        suspectedHarmonic: raw.suspectedHarmonic,
      });
    });
  });
  return out.sort((a, b) => a.onset - b.onset || a.string - b.string);
};

// ---------- 5. 演奏技巧检测（需已分配弦品） ----------

const LEGATO_GAP = 0.04;

export const detectArticulation: DetectArticulation = (notes) => {
  const sorted = [...notes].sort((a, b) => a.onset - b.onset);
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    const techniques: NonNullable<FrettedNote['techniques']> = [];
    // 闷音：短促 + 低力度
    if ((n.velocity ?? 127) < 55 && n.duration < 0.3) techniques.push('palmMute');
    // 推弦：pitchBend 明显（≥ 1 个半音）
    if (n.bend && maxAbsCents(n.bend) >= 100) techniques.push('bend');

    const next = sorted[i + 1];
    if (next && next.string === n.string) {
      const gap = next.onset - (n.onset + n.duration);
      const df = next.fret - n.fret;
      if (gap <= LEGATO_GAP && Math.abs(df) >= 1) {
        // 同弦相邻品：滑音（跨 2 品以上）或击/勾弦
        const mark = Math.abs(df) >= 2 ? 'slide' : df > 0 ? 'hammer' : 'pull';
        next.techniques = [...(next.techniques ?? []), mark];
      }
    }
    if (techniques.length) n.techniques = [...(n.techniques ?? []), ...techniques];
  }
  return sorted;
};

// ---------- 6. 生成 alphaTex ----------

function durValue(beats: number): number {
  const clamped = Math.min(Math.max(beats, 0.125), 4);
  const v = Math.round(Math.log2(4 / clamped));
  return 2 ** Math.min(Math.max(v, 0), 5);
}

function beatsOf(value: number): number {
  return 4 / value;
}

/**
 * 音符级效果（紧跟 fret.string，alphaTab 1.8 noteProperties 表）：bend/hammer/palmMute。
 * 多个效果合并进同一个 {} 组（官方导出器形式：{b(0 4) pm}）——连续多个 {} 组
 * （{b(0 4)}{pm}）解析器不认。注意 alphaTex 1.8 语法：时长是音符组的 ":N" 前缀
 * 而非 "fret.string.N" 尾缀——旧三段式后跟的效果花括号会按小节级属性路由而报错。
 */
function noteEffectsOf(n: FrettedNote): string {
  const tokens: string[] = [];
  for (const t of n.techniques ?? []) {
    if (t === 'bend' && n.bend) {
      const quarters = Math.max(1, Math.round(maxAbsCents(n.bend) / 50));
      tokens.push(`b(0 ${quarters})`);
    } else if (t === 'hammer') tokens.push('h');
    else if (t === 'palmMute') tokens.push('pm');
  }
  return tokens.length ? `{${tokens.join(' ')}}` : '';
}

/** 小节级效果（跟在音符组后，beatProperties 表）：slide/pull/tuplet，同组空格分隔 */
function beatEffectsOf(notes: FrettedNote[]): string {
  const tokens: string[] = [];
  for (const n of notes) {
    if (!n.techniques) continue;
    for (const t of n.techniques) {
      if (t === 'slide') tokens.push('s');
      else if (t === 'pull') tokens.push('p');
    }
  }
  if (notes.some((n) => n.tuplet === '3')) tokens.push('tu 3');
  const unique = [...new Set(tokens)];
  return unique.length ? `{${unique.join(' ')}}` : '';
}

export const toAlphaTex: ToAlphaTex = (notes, ctx) => {
  // 泛音误检抑制（§2.1）：疑似泛音不入谱（数据保留在 result.notes，§2.4 编辑器可处置）
  const visible = notes.filter((n) => !n.suspectedHarmonic);
  // 分段感知（§3.5）：每段自己的 BPM → 小节长度逐段不同；段首输出 \tempo
  const sections =
    ctx.beatGrid?.sections && ctx.beatGrid.sections.length
      ? ctx.beatGrid.sections
      : [{ start: 0, end: Number.MAX_SAFE_INTEGER / 8, bpm: 120, timeSignature: [4, 4] as [number, number] }];
  const tsNum = sections[0].timeSignature?.[0] ?? 4;
  const capo = ctx.tuning?.capo ?? ctx.config.capo ?? 0;
  const tuning = ctx.tuning?.tuning ?? ctx.config.tuning ?? STANDARD_TUNING;

  const header = [`\\tempo ${Math.round(sections[0].bpm)}`];
  if (capo > 0) header.push(`\\capo ${capo}`);

  // \tuning 按弦号 1→N（高→低）排列
  const isStandard = tuning.join(',') === STANDARD_TUNING.join(',');
  const trackLine = isStandard
    ? '\\track "Guitar" \\instrument 25'
    : `\\track "Guitar" \\instrument 25 \\tuning ${[...tuning].reverse().map(midiName).join(' ')}`;

  // 小节边界表（每段小节长度随 BPM 变化）
  const { starts: barStarts, bpms: barBpms } = barStartsFromSections(sections);
  const findBar = (t: number): number => {
    let lo = 0;
    let hi = barStarts.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (barStarts[mid] <= t + 1e-6) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  };
  const sectionStarts = sections.map((s) => s.start);
  const isSectionStart = (t: number): boolean =>
    sectionStarts.some((st) => Math.abs(st - t) < 1e-6);

  const barCount = visible.length
    ? Math.max(...visible.map((n) => findBar(n.onset))) + 1
    : 1;
  // 调号（§3.3 第 1 项）：手动指定优先于自动检测；在每个段落起始小节输出 \ks
  const keySel: KeySelection | null =
    ctx.keyOverride ?? (ctx.key ? { tonicPc: ctx.key.tonicPc, mode: ctx.key.mode } : null);
  const keyToken = keySel ? keyToAlphaTexToken(keySel.tonicPc, keySel.mode) : null;
  const bars: string[] = [];
  for (let b = 0; b < barCount; b++) {
    const barStart = barStarts[b];
    const bpm = barBpms[b];
    const beatSec = 60 / bpm;
    const inBar = visible.filter((n) => findBar(n.onset) === b);
    inBar.sort((a, b2) => a.onset - b2.onset);

    const tokens: string[] = [];
    if (b > 0 && isSectionStart(barStart)) tokens.push(`\\tempo ${Math.round(bpm)}`);
    if (keyToken && isSectionStart(barStart)) tokens.push(`\\ks ${keyToken}`);
    let cursor = 0;
    const events: { time: number; notes: FrettedNote[] }[] = [];
    for (const n of inBar) {
      const last = events[events.length - 1];
      if (last && n.onset - last.time <= 0.01) last.notes.push(n);
      else events.push({ time: n.onset, notes: [n] });
    }
    for (const ev of events) {
      const evBeats = (ev.time - barStart) / beatSec;
      let gap = evBeats - cursor;
      if (gap >= 0.249) {
        const v = durValue(gap);
        tokens.push(`:${v} r`);
        cursor += beatsOf(v);
      }
      const durBeats = Math.min(
        Math.max(ev.notes[0].duration / beatSec, 0.125),
        tsNum - cursor,
      );
      const value = durValue(Math.max(durBeats, 0.125));
      const noteTokens = ev.notes
        .map((n) => `${n.fret}.${n.string}${noteEffectsOf(n)}`)
        .join(' ');
      const beat = beatEffectsOf(ev.notes);
      tokens.push(`:${value} ${noteTokens}${beat ? ` ${beat}` : ''}`);
      cursor += beatsOf(value);
    }
    let tail = tsNum - cursor;
    while (tail >= 0.249) {
      const v = durValue(tail);
      tokens.push(`:${v} r`);
      tail -= beatsOf(v);
    }
    bars.push(tokens.join(' '));
  }

  return [header.join(' '), '.', trackLine, bars.join(' | ')].join('\n');
};

// ---------- Profile 组装 ----------

export class GuitarProfile implements IInstrumentProfile {
  readonly instrument = 'guitar' as const;

  readonly defaultConfig: InstrumentConfig = {
    // 不预设调弦/Capo：默认走 Auto-Capo 自动推导（用户显式配置时才固定）
    stringCount: 6,
  };

  readonly pipeline: readonly TransformStep[] = [
    filterNotes,
    clusterEvents,
    detectTuning,
    routeFretboard,
    detectArticulation,
    toAlphaTex,
  ];

  transcribe(
    notes: RawNote[],
    ctx: Partial<Omit<ProfileContext, 'tuning'>> = {},
  ): TranscriptionResult {
    const style: FingeringStyle = ctx.style ?? 'balanced';
    const full: ProfileContext = {
      config: ctx.config ?? this.defaultConfig,
      style,
      weights: ctx.weights ?? resolveWeights(style),
      beatGrid: ctx.beatGrid,
      candidateTunings: ctx.candidateTunings,
    };
    let raw = filterNotes(notes, full);
    raw = clusterEvents(raw, full);
    full.tuning = detectTuning(raw, full);
    // §3.3 第 1 项：调性检测为流水线必做步骤（结果双用于 \ks 调号与 Auto-Capo KeyFit）
    full.key = detectKey(raw) ?? undefined;
    full.keyOverride = ctx.keyOverride ?? null;
    let fretted = routeFretboard(raw, full);
    fretted = detectArticulation(fretted, full);
    const alphaTex = toAlphaTex(fretted, full);
    return {
      alphaTex,
      notes: fretted,
      meta: {
        tuning: full.tuning.tuning,
        capo: full.tuning.capo,
        suggestedCapo: full.tuning.suggestions,
        key: full.key ?? undefined,
      },
    };
  }

  serializeForLlm(result: TranscriptionResult): string {
    return result.alphaTex;
  }
}

export const guitarProfile = new GuitarProfile();
