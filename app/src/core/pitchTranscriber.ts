/**
 * Basic Pitch 转写封装（v4.0 §2 轻量极速档引擎 / v4.1 §6 Step 3）。
 *
 * 实测注记（2026-10，@spotify/basic-pitch 1.0.1 + tfjs 3.21）：
 * - evaluateModel 只接受 22050Hz 单声道输入：AudioBuffer 采样率不符直接 throw、
 *   Float32Array 按 22050 假定 —— §3.2 修订条所称"重采样交给 basic-pitch 自己"
 *   在 TS 包中不成立，重采样仍由 audioPreprocessor 承担（§3.2 自带兜底条款）。
 * - 模型随 npm 包分发（model/，约 0.9MB，并非 v4.0 所述 17MB），已随 public/model/
 *   提供，运行期零联网，契合本地离线优先。
 * - onComplete 暴露 frames/onsets/contours 原始概率矩阵（§3.1 交叉验证的
 *   onset 概率可从这里取），首期直接使用 noteFramesToTime 的音符 onset 序列。
 * - pitchBends 语义（包内 generateFileData 源码）：第 i 个值是音符时长内
 *   均匀第 i 个采样点的音分偏移，time = start + i * duration / len。
 * - 长曲按 60~90s 分段喂入（§3.2：静音切点优先 + 固定切点 3s 重叠兜底，
 *   后处理一律在合并后的全局 note 流上跑），见下方分段常量与 transcribeAudio。
 */
import { BasicPitch } from '@spotify/basic-pitch';
import {
  addPitchBendsToNoteEvents,
  noteFramesToTime,
  outputToNotesPoly,
} from '@spotify/basic-pitch';
import type { NoteEventTime } from '@spotify/basic-pitch';
import type { RawNote } from '../profiles/IInstrumentProfile';

/** 随包分发的 TFJS 模型（public/model/，权重分片按相对路径解析） */
export const BASIC_PITCH_MODEL_URL = '/model/model.json';

/** outputToNotesPoly 官方示例阈值（basic-pitch-ts README：onset/frame 0.25，最短 5 帧）。
 *  §2.1 泛音误检抑制配套的"阈值收紧"留待 §1.2 真实语料基线实测后校准，先保持官方值。 */
export const ONSET_THRESHOLD = 0.25;
export const FRAME_THRESHOLD = 0.25;
export const MIN_NOTE_FRAMES = 5;

// ---------- 长曲分段（§3.2 2026-10 细化：静音切点 + 重叠兜底 + 后处理全局） ----------

/** 单段推理时长上限（秒）：超过则按 60~90s 分段喂入 basic-pitch */
export const MAX_CHUNK_SECONDS = 90;
/** 分段目标时长（秒）（60~90 取中） */
export const CHUNK_TARGET_SECONDS = 75;
/** 固定切点兜底时的重叠秒数（§3.2：2~5s 取中） */
export const CHUNK_OVERLAP_SECONDS = 3;
/** 静音判定：窗口 RMS ≤ 全曲最大 RMS × 此比例视为低能量切点 */
export const SILENCE_RMS_RATIO = 0.02;
/** 切点搜索半径（秒）：在理想切点 ± 此范围内找最低能量窗 */
export const CUT_SEARCH_SECONDS = 12;
/** 最短分段时长（秒）：避免搜索产生碎段 */
export const MIN_CHUNK_SECONDS = 30;
/** 重叠区重复音符合并：同音高 onset 容差（秒） */
export const MERGE_ONSET_TOLERANCE = 0.25;
/** RMS 包络窗长（秒） */
const RMS_WINDOW_SECONDS = 0.05;

export type CutPoint = { time: number; silent: boolean };
export type ChunkRegion = {
  start: number;
  end: number;
  /** 与前一段的重叠秒数（0 = 静音切点，无重叠） */
  overlapWithPrev: number;
};

function rmsEnvelope(samples: Float32Array, sampleRate: number): { env: Float32Array; hop: number } {
  const hop = Math.max(1, Math.round(RMS_WINDOW_SECONDS * sampleRate));
  const n = Math.floor(samples.length / hop);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < hop; j++) {
      const v = samples[i * hop + j];
      sum += v * v;
    }
    env[i] = Math.sqrt(sum / hop);
  }
  return { env, hop };
}

/**
 * 选长曲分段切点（§3.2）：理想位置 = 全曲按目标时长均分；在每个理想位置
 * ±CUT_SEARCH 范围内找最低能量 50ms 窗——落在静音/低能量区则持续音不会被切断
 * （silent=true，喂入无需重叠，≥0.4s 静音间隔与 move_free_gap 天然对齐）；整个
 * 搜索窗都无低能量区时退回固定切点（silent=false，喂入回看重叠区、合并去重）。
 */
export function findCutPoints(samples: Float32Array, sampleRate: number): CutPoint[] {
  const duration = samples.length / sampleRate;
  const nChunks = Math.max(2, Math.round(duration / CHUNK_TARGET_SECONDS));
  if (duration / nChunks < MIN_CHUNK_SECONDS) return [];
  const { env, hop } = rmsEnvelope(samples, sampleRate);
  let maxRms = 0;
  for (const v of env) maxRms = Math.max(maxRms, v);
  const silenceFloor = maxRms * SILENCE_RMS_RATIO;
  const envAt = (t: number) =>
    env[Math.min(env.length - 1, Math.max(0, Math.floor((t * sampleRate) / hop)))];
  const cuts: CutPoint[] = [];
  for (let k = 1; k < nChunks; k++) {
    const ideal = (duration / nChunks) * k;
    const lo = Math.max(
      cuts.length ? cuts[cuts.length - 1].time + MIN_CHUNK_SECONDS : MIN_CHUNK_SECONDS,
      ideal - CUT_SEARCH_SECONDS,
    );
    const hi = Math.min(duration - MIN_CHUNK_SECONDS, ideal + CUT_SEARCH_SECONDS);
    if (hi <= lo) {
      cuts.push({ time: ideal, silent: false });
      continue;
    }
    let bestT = -1;
    let bestRms = Infinity;
    for (let t = lo; t <= hi; t += RMS_WINDOW_SECONDS) {
      const r = envAt(t);
      if (r < bestRms) {
        bestRms = r;
        bestT = t;
      }
    }
    // 低能量窗 → 切在静音处；整窗都"响" → 固定切点兜底（不在噪声最小处乱切）
    if (bestT >= 0 && bestRms <= silenceFloor) cuts.push({ time: bestT, silent: true });
    else cuts.push({ time: ideal, silent: false });
  }
  return cuts;
}

/** 由切点生成分段区域（喂入切片的 [start, end) 与各段与前段的重叠秒数） */
export function planChunks(duration: number, cuts: CutPoint[]): ChunkRegion[] {
  const plan: ChunkRegion[] = [];
  let start = 0;
  let overlap = 0;
  for (const cut of [...cuts, { time: duration, silent: true }]) {
    plan.push({ start, end: cut.time, overlapWithPrev: overlap });
    overlap = cut.silent ? 0 : CHUNK_OVERLAP_SECONDS;
    start = cut.time - overlap;
  }
  return plan;
}

/**
 * 合并分段音符（§3.2：分段只作用于神经推理，合并后的全局 note 流才进入
 * 扫弦聚拢/Viterbi/量化）。非静音切点的重叠区：同音高且时间区间重叠
 * （或 onset 差 ≤ 容差，容忍截断版本边界抖动）视为同一音符——保留后段
 * 版本（其推理上下文完整，前段版本在边界处被截断）。
 * 配对为一对一消费制：重叠区内同音高的快速重复音（间隔小于容差）各自
 * 配对各自的版本，不会把前段两个音错并成一个。静音切点直接顺序拼接。
 * 无对应的重叠区音符保留（保召回，交后续算法/编辑器）。
 */
export function mergeChunkNotes(chunks: RawNote[][], plan: ChunkRegion[]): RawNote[] {
  const merged: RawNote[] = [];
  chunks.forEach((chunkNotes, i) => {
    const { start, overlapWithPrev } = plan[i];
    for (const n of chunkNotes) {
      const note = { ...n, onset: n.onset + start };
      const noteEnd = note.onset + Math.max(n.duration, 0.01);
      if (overlapWithPrev > 0 && n.onset < overlapWithPrev) {
        const idx = merged.findIndex((m) => {
          if (m.pitch !== note.pitch) return false;
          const mEnd = m.onset + Math.max(m.duration, 0.01);
          const overlaps = note.onset < mEnd && m.onset < noteEnd;
          return overlaps || Math.abs(m.onset - note.onset) <= MERGE_ONSET_TOLERANCE;
        });
        if (idx >= 0) {
          merged.splice(idx, 1); // 消费配对项，保证一对一
          merged.push(note);
          continue;
        }
      }
      merged.push(note);
    }
  });
  return merged.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
}

/**
 * 转写入口：≤90s 单次推理；长曲按 §3.2 分段（静音切点优先）后合并为全局
 * note 流。onProgress 统一为 0~100（跨段按占比累计）。
 */
export async function transcribeAudio(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (percent: number) => void,
): Promise<RawNote[]> {
  const duration = samples.length / sampleRate;
  if (duration <= MAX_CHUNK_SECONDS) {
    return transcribeToRawNotes(samples, sampleRate, onProgress);
  }
  const cuts = findCutPoints(samples, sampleRate);
  const plan = planChunks(duration, cuts);
  const chunks: RawNote[][] = [];
  for (let i = 0; i < plan.length; i++) {
    const { start, end } = plan[i];
    const slice = samples.subarray(Math.round(start * sampleRate), Math.round(end * sampleRate));
    const chunkNotes = await transcribeToRawNotes(slice, sampleRate, (pct) => {
      onProgress?.(((i + pct / 100) / plan.length) * 100);
    });
    chunks.push(chunkNotes);
  }
  return mergeChunkNotes(chunks, plan);
}

/** 单例：模型只加载一次（BasicPitch.model 为 Promise<GraphModel>，tfjs 自动缓存） */
let instance: BasicPitch | null = null;
function basicPitchInstance(): BasicPitch {
  instance ??= new BasicPitch(BASIC_PITCH_MODEL_URL);
  return instance;
}

/**
 * NoteEventTime → RawNote（纯函数，单测覆盖）。
 * amplitude ∈ [0,1] → velocity 0-127（clamp 防越界）；
 * pitchBends 按包内语义展开为 {time, cents} 均匀序列。
 */
export function noteEventsToRawNotes(events: NoteEventTime[]): RawNote[] {
  return events.map((e) => {
    const bends = e.pitchBends ?? [];
    return {
      onset: e.startTimeSeconds,
      duration: e.durationSeconds,
      pitch: e.pitchMidi,
      velocity: Math.max(1, Math.min(127, Math.round(e.amplitude * 127))),
      pitchBend: bends.map((cents, i) => ({
        time: e.startTimeSeconds + (i * e.durationSeconds) / bends.length,
        cents,
      })),
    };
  });
}

/**
 * 22050Hz mono 音频 → RawNote[]。
 * @param onProgress 推理进度 0~100（evaluateModel 逐帧回调 0~1，此处放大为百分数）
 */
export async function transcribeToRawNotes(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (percent: number) => void,
): Promise<RawNote[]> {
  if (sampleRate !== 22050) {
    throw new Error(
      `Basic Pitch 需要 22050Hz 单声道输入（audioPreprocessor 产物），收到 ${sampleRate}Hz`,
    );
  }
  const bp = basicPitchInstance();
  let frames: number[][] = [];
  let onsets: number[][] = [];
  let contours: number[][] = [];
  await bp.evaluateModel(
    samples,
    // evaluateModel 按约 2s 切片逐次回调 onComplete（inference.ts 循环内每次
    // 调用传的是当前切片的解包矩阵），必须按时间序拼接而非覆盖，否则只留尾部
    (f, o, c) => {
      frames = frames.concat(f);
      onsets = onsets.concat(o);
      contours = contours.concat(c);
    },
    (percent) => onProgress?.(percent * 100),
  );
  const noteEvents = addPitchBendsToNoteEvents(
    contours,
    outputToNotesPoly(frames, onsets, ONSET_THRESHOLD, FRAME_THRESHOLD, MIN_NOTE_FRAMES),
  );
  return noteEventsToRawNotes(noteFramesToTime(noteEvents));
}
