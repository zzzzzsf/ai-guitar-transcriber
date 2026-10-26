/**
 * 乐器插件统一契约 — 冻结自《吉他扒谱-细化方案 v4.1》§2.1。
 *
 * 设计采用“函数式可组合 pipeline”而非 OOP 继承：每个 transform 都是纯函数，
 * 可任意组合、顺序可调、好测（鼓/人声类乐器直接跳过 routeFretboard 即可）。
 */
import type { CostWeights } from './costWeights';
import type { KeyResult, KeySelection } from '../core/keyDetector';

/** Basic Pitch 原始输出（冻结类型；tuplet 为量化器 §3.1 双网格新增的可选扩展） */
export type RawNote = {
  /** 秒 */
  onset: number;
  /** 秒 */
  duration: number;
  /** MIDI 0-127 */
  pitch: number;
  /** 0-127 */
  velocity: number;
  pitchBend: { time: number; cents: number }[];
  /** 量化器判定的连音类型（'3' = 三连音） */
  tuplet?: '3';
  /**
   * 泛音误检抑制（§2.1 2026-10 补）：同簇内相对更强低音 +19/+24 半音且能量显著弱
   * → 标记"疑似泛音"。只标记不删除，Viterbi 照常寻路，toAlphaTex 不入谱，
   * 交 §2.4 编辑器处置（用户可恢复）。
   */
  suspectedHarmonic?: boolean;
};

/** 来自 quantizer（§3.1） */
export type BeatSection = {
  start: number;
  end: number;
  bpm: number;
  timeSignature: [number, number];
};
export type BeatGrid = { sections: BeatSection[]; beats: number[] };

export type InstrumentConfig = {
  /** 调弦（空弦 MIDI 数组，低→高）；未提供时走 Auto-Capo 自动推导 */
  tuning?: number[];
  capo?: number;
  stringCount?: number;
};

export type FrettedNote = {
  /** alphaTab 弦号：1 = 最高音弦（high E），6 = 低音 E 弦 */
  string: number;
  fret: number;
  onset: number;
  duration: number;
  pitch: number;
  bend?: { time: number; cents: number }[];
  techniques?: ('bend' | 'slide' | 'hammer' | 'pull' | 'palmMute')[];
  /** routeFretboard 从 RawNote 透传，detectArticulation 的闷音判定需要 */
  velocity?: number;
  /** 量化器判定的连音类型（'3' = 三连音），toAlphaTex 生成 {tu 3} */
  tuplet?: '3';
  /** 泛音误检抑制标记（从 RawNote 透传；toAlphaTex 不入谱，§2.4 编辑器可处置） */
  suspectedHarmonic?: boolean;
};

export type TranscriptionResult = {
  alphaTex: string;
  notes: FrettedNote[];
  meta: {
    tuning: number[];
    capo: number;
    suggestedCapo?: CapoSuggestion[];
    /** 调性检测结果（§3.3 调号输出） */
    key?: KeyResult;
  };
};

export type CapoSuggestion = {
  capo: number;
  tuning: number[];
  score: number;
  reason: string;
};

export type TuningResult = {
  /** 选定调弦（空弦 MIDI，低→高） */
  tuning: number[];
  capo: number;
  /** Auto-Capo Top 3 候选（含理由），按分数降序 */
  suggestions: CapoSuggestion[];
  autoDetected: boolean;
};

export type InstrumentId = 'guitar' | 'bass' | 'piano' | 'drums' | 'vocal';

/** 指法风格三档（§4.1，映射权重预设） */
export type FingeringStyle = 'easy' | 'balanced' | 'faithful';

/**
 * Pipeline 通用步骤（§2.1 hook 清单）。各 Profile 按需选取子集：
 * - filterNotes        音域/复音/碎音过滤
 * - clusterEvents      扫弦聚拢 + 推弦合并（bendrescue）
 * - detectTuning       调弦 + Capo 推导
 * - routeFretboard     Viterbi 寻路（鼓/人声不含）
 * - detectArticulation 演奏技巧检测（需已分配弦品，故在 routeFretboard 之后）
 * - toAlphaTex         格式化输出（§3.3：含 \ks 调号、休止符、{tu N} 连音）
 */

/**
 * 执行上下文：按 pipeline 顺序传递并携带中间结果。
 * key/keyOverride 为 §3.3 调号输出的数据源（检测结果双用于 Auto-Capo KeyFit）。
 */
export interface ProfileContext {
  /** 已校验的用户配置（zod 运行时校验后） */
  config: InstrumentConfig;
  style: FingeringStyle;
  weights: CostWeights;
  beatGrid?: BeatGrid;
  /** Auto-Capo 候选调弦集合（默认标准 + Drop D） */
  candidateTunings?: number[][];
  /** detectTuning 写入，routeFretboard 读取 */
  tuning?: TuningResult;
  /** 调性检测结果（transcribe 写入，toAlphaTex 生成 \ks） */
  key?: KeyResult;
  /** UI 手动指定的调性（优先于检测结果） */
  keyOverride?: KeySelection | null;
}

/** 统一 transform 签名（冻结）：(input, ctx) => O */
export type Transform<I, O> = (input: I, ctx: ProfileContext) => O;

export type FilterNotes = Transform<RawNote[], RawNote[]>;
export type ClusterEvents = Transform<RawNote[], RawNote[]>;
export type DetectTuning = Transform<RawNote[], TuningResult>;
export type RouteFretboard = Transform<RawNote[], FrettedNote[]>;
export type DetectArticulation = Transform<FrettedNote[], FrettedNote[]>;
export type ToAlphaTex = Transform<FrettedNote[], string>;

/** pipeline 中实际出现的步骤（联合类型，runPipeline 按序处理） */
export type TransformStep =
  | FilterNotes
  | ClusterEvents
  | DetectTuning
  | RouteFretboard
  | DetectArticulation
  | ToAlphaTex;

export interface IInstrumentProfile {
  instrument: InstrumentId;
  /** 显式声明、顺序自定义 */
  pipeline: readonly TransformStep[];
  defaultConfig: InstrumentConfig;
  /**
   * 完整转写：按 pipeline 顺序执行并串联中间结果。
   * （v4.1 的 hook 输入/输出类型各不相同，统一入口由各 Profile 自行串联。）
   */
  transcribe(notes: RawNote[], ctx?: Partial<Omit<ProfileContext, 'tuning'>>): TranscriptionResult;
  /** → alphaTex 文本（BYOK 用） */
  serializeForLlm(result: TranscriptionResult): string;
}
