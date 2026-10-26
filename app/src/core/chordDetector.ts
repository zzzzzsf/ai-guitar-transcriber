/**
 * 本地和弦标注（BYOK 降级路径）— 冻结自《吉他扒谱-细化方案 v4.1》§1.3：
 * “和弦标注 → 降级为本地音程规则推断（小节内音高集合匹配常用和弦字典）”。
 *
 * 输入已分配弦品的音符与节拍网格，按小节聚合音级权重后匹配和弦字典，
 * 输出逐小节和弦名。纯 TS，无外部依赖。
 */
import type { BeatGrid, BeatSection, FrettedNote } from '../profiles/IInstrumentProfile';

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** 常用和弦字典：三和弦与常见七和弦/挂留 */
const TEMPLATES: { suffix: string; intervals: number[] }[] = [
  { suffix: '', intervals: [0, 4, 7] }, // 大三
  { suffix: 'm', intervals: [0, 3, 7] }, // 小三
  { suffix: '7', intervals: [0, 4, 7, 10] }, // 属七
  { suffix: 'm7', intervals: [0, 3, 7, 10] }, // 小七
  { suffix: 'sus4', intervals: [0, 5, 7] }, // 挂四
  { suffix: 'dim', intervals: [0, 3, 6] }, // 减三
];

const CHORD_TONE_WEIGHT = 1.0;
const NON_CHORD_PENALTY = 0.8;
const BASS_ROOT_BONUS = 0.2;
const TEMPLATE_SIZE_PENALTY = 0.05; // 同分时偏好更简单的三和弦

export type ChordLabel = { bar: number; name: string };

const FALLBACK_SECTION: BeatSection = { start: 0, end: Infinity, bpm: 120, timeSignature: [4, 4] };

/** 段内小节长度（秒）= 每小节拍数 × 60 / BPM */
function barSeconds(section: BeatSection): number {
  const tsNum = section.timeSignature?.[0] ?? 4;
  return tsNum * (60 / (section.bpm || 120));
}

/**
 * 全局时间 → 0 基小节号。变速曲（§3.5）逐段计算小节长度：段起始小节号 =
 * 前面各段小节数累加（段边界默认落在小节线上，取 round 防浮点漂移）。
 */
export function barIndexOf(t: number, sections: BeatSection[]): { bar: number; section: BeatSection } {
  const list = sections.length ? sections : [FALLBACK_SECTION];
  let baseBar = 0;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const next = list[i + 1];
    const inSection = t >= s.start - 1e-6 && (next === undefined || t < next.start - 1e-6);
    if (inSection || i === list.length - 1) {
      const bar = baseBar + Math.floor((t - s.start) / barSeconds(s) + 1e-6);
      return { bar: Math.max(0, bar), section: s };
    }
    const span = (next ? next.start : s.end) - s.start;
    baseBar += Math.max(1, Math.round(span / barSeconds(s)));
  }
  return { bar: 0, section: list[0] };
}

function pitchClass(pitch: number): number {
  return ((pitch % 12) + 12) % 12;
}

/**
 * 按小节检测和弦：音高按持续时长加权，落在和弦内加分、和弦外扣分，
 * 低音（最低音）等于根音时小幅加分；同分偏好简单三和弦。
 */
export function detectChords(notes: FrettedNote[], beatGrid: BeatGrid): ChordLabel[] {
  if (notes.length === 0) return [];
  const sections = beatGrid.sections.length ? beatGrid.sections : [FALLBACK_SECTION];

  // 按小节聚合：音级权重 + 低音音级（小节边界逐段变速感知）
  const bars = new Map<number, { weights: Float64Array; bassPitch: number }>();
  for (const n of notes) {
    const { bar } = barIndexOf(n.onset, sections);
    let entry = bars.get(bar);
    if (!entry) {
      entry = { weights: new Float64Array(12), bassPitch: n.pitch };
      bars.set(bar, entry);
    }
    entry.weights[pitchClass(n.pitch)] += Math.max(n.duration, 0.05);
    if (n.pitch < entry.bassPitch) entry.bassPitch = n.pitch;
  }

  const labels: ChordLabel[] = [];
  for (const [bar, { weights, bassPitch }] of [...bars.entries()].sort((a, b) => a[0] - b[0])) {
    const bassPc = pitchClass(bassPitch);
    let bestName: string | null = null;
    let bestScore = 0;
    for (let root = 0; root < 12; root++) {
      for (const { suffix, intervals } of TEMPLATES) {
        const inChord = new Set(intervals.map((i) => (root + i) % 12));
        let score = 0;
        for (let pc = 0; pc < 12; pc++) {
          if (weights[pc] <= 0) continue;
          score += inChord.has(pc) ? CHORD_TONE_WEIGHT * weights[pc] : -NON_CHORD_PENALTY * weights[pc];
        }
        score -= TEMPLATE_SIZE_PENALTY * intervals.length;
        if (bassPc === root) score += BASS_ROOT_BONUS;
        if (score > bestScore) {
          bestScore = score;
          bestName = PITCH_NAMES[root] + suffix;
        }
      }
    }
    if (bestName && bassPc !== pitchClassOfRoot(bestName)) {
      // 转位和弦标注低音（如 D/F#）
      bestName = `${bestName}/${PITCH_NAMES[bassPc]}`;
    }
    if (bestName) labels.push({ bar, name: bestName });
  }
  return labels;
}

function pitchClassOfRoot(name: string): number {
  const letter = name[0];
  const sharp = name[1] === '#';
  const idx = PITCH_NAMES.indexOf(sharp ? `${letter}#` : letter);
  return idx < 0 ? -1 : idx;
}
