/**
 * 演示数据：Step 1 用写死的 alphaTex 验证渲染链路；
 * createDemoNotes 提供一段真实的 RawNote 序列（含扫弦错位、推弦弯音、闷音），
 * 用于在 UI 中直接跑通 GuitarProfile 五步流水线（Step 2 验收）。
 *
 * §3.5 变速演示：前 4 小节 80 BPM、后 4 小节 60 BPM（真变速·段落级），
 * createDemoBeatTimes 提供与音符时值一致的逐拍序列（模拟从音频检出的拍点），
 * 供 detectTempoCandidates 演示候选检测 → 确认/自动应用 → 分段 \tempo 输出全流程。
 */
import type { RawNote, BeatGrid, BeatSection } from './profiles/IInstrumentProfile';
import { STANDARD_TUNING } from './profiles/tunings';
import { buildBeatGrid, buildBeatGridFromSections } from './core/quantizer';

/** Step 1 初始渲染用（alphaTab 官方示例风格的指弹片段） */
export const DEMO_ALPHA_TEX = [
  '\\tempo 80',
  '.',
  '\\track "吉他" \\instrument 25',
  [
    '0.6.8 2.5.8 2.4.8 0.3.8 0.2.8 0.1.8 0.2.8 0.3.8',
    '3.5.8 2.4.8 0.3.8 1.2.8 0.1.8 1.2.8 0.3.8 2.4.8',
    '3.6.8 2.5.8 0.4.8 0.3.8 0.2.8 3.2.8 0.2.8 0.3.8',
    '0.4.8 4.4.8 2.3.8 3.2.8 2.1.8 3.2.8 2.3.8 4.4.8',
  ].join(' | '),
].join('\n');

/** 标准调弦下（弦号, 品）→ MIDI pitch */
function pitchOf(stringNo: number, fret: number): number {
  return STANDARD_TUNING[6 - stringNo] + fret;
}

function note(onset: number, duration: number, pitch: number, velocity = 100, bend: RawNote['pitchBend'] = []): RawNote {
  return { onset: Number(onset.toFixed(3)), duration, pitch, velocity, pitchBend: bend };
}

const BPM_A = 80; // 前 4 小节
const BPM_B = 60; // 后 4 小节（§3.5 真变速）
const ARPEGGIO_SEC = 4 * 4 * (60 / BPM_A); // 12s
export const DEMO_DURATION = ARPEGGIO_SEC + 4 * 4 * (60 / BPM_B); // 28s

/** 前 4 小节：和弦分解琶音（Em → C → G → D，每小节 8 个八分音符，上行+回落） */
const ARPEGGIO_BARS: [number, number][][] = [
  // [弦号, 品]
  [[6, 0], [5, 2], [4, 2], [3, 0], [2, 0], [1, 0], [2, 0], [3, 0]], // Em: E2 B2 E3 G3 B3 E4
  [[5, 3], [4, 2], [3, 0], [2, 1], [1, 0], [2, 1], [3, 0], [4, 2]], // C: C3 E3 G3 C4 E4
  [[6, 3], [5, 2], [4, 0], [3, 0], [2, 0], [2, 3], [2, 0], [3, 0]], // G: G2 B2 D3 G3 B3 D4
  [[4, 0], [4, 4], [3, 2], [2, 3], [1, 2], [2, 3], [3, 2], [4, 4]], // D: D3 F#3 A3 D4 F#4
];

/** 第 5 小节起：整和弦扫弦（Em / C / G / D，每弦错开 12ms 模拟拨片物理延迟） */
const STRUM_CHORDS: [number, number][][] = [
  [[6, 0], [5, 2], [4, 0], [3, 0], [2, 0], [1, 0]], // Em
  [[5, 3], [4, 2], [3, 0], [2, 1], [1, 0]], // C
  [[6, 3], [5, 2], [4, 0], [3, 0], [2, 0], [1, 3]], // G
  [[4, 0], [3, 2], [2, 3], [1, 2]], // D
];

/** 变速后的目标分段（检测应用后的期望结果，亦用于演示音频生成） */
export function createDemoTempoSections(): BeatSection[] {
  return [
    { start: 0, end: ARPEGGIO_SEC, bpm: BPM_A, timeSignature: [4, 4] },
    { start: ARPEGGIO_SEC, end: DEMO_DURATION, bpm: BPM_B, timeSignature: [4, 4] },
  ];
}

/** 未检测时的初始分段：全曲恒定 80 BPM（变速候选由 detectTempoCandidates 发现） */
export function createDemoBeatGrid(): BeatGrid {
  return buildBeatGrid(BPM_A, DEMO_DURATION, [4, 4]);
}

/** 检测/应用后的分段 BeatGrid */
export function createDemoBeatGridFromSections(): BeatGrid {
  return buildBeatGridFromSections(createDemoTempoSections());
}

/**
 * 逐拍序列（模拟从音频检出的拍点）：与音符时值严格一致——
 * 前 12s 拍距 0.75s（80 BPM），后 16s 拍距 1.0s（60 BPM）。
 */
export function createDemoBeatTimes(): number[] {
  const beats: number[] = [];
  for (let t = 0; t < ARPEGGIO_SEC - 1e-9; t += 60 / BPM_A) beats.push(Number(t.toFixed(6)));
  for (let t = ARPEGGIO_SEC; t < DEMO_DURATION - 1e-9; t += 60 / BPM_B) beats.push(Number(t.toFixed(6)));
  return beats;
}

export function createDemoNotes(): RawNote[] {
  const notes: RawNote[] = [];
  let t = 0;
  // 琶音部分（80 BPM：八分音符 = 0.375s）
  const eighthA = 60 / BPM_A / 2;
  for (const bar of ARPEGGIO_BARS) {
    for (const [stringNo, fret] of bar) {
      notes.push(note(t, 0.33, pitchOf(stringNo, fret), 96));
      t += eighthA;
    }
  }
  // 扫弦部分（60 BPM：拍 = 1.0s）：每小节第一拍下扫、第三拍上扫（错位 onset 由 clusterEvents 聚拢）
  const beatB = 60 / BPM_B;
  for (let bar = 0; bar < STRUM_CHORDS.length; bar++) {
    const chord = STRUM_CHORDS[bar];
    const barStart = ARPEGGIO_SEC + bar * 4 * beatB;
    const down = chord; // 低→高 = 下扫
    const up = [...chord].reverse(); // 高→低 = 上扫
    down.forEach(([stringNo, fret], i) => {
      notes.push(note(barStart + i * 0.012, 1.4, pitchOf(stringNo, fret), 104 - i * 2));
    });
    up.forEach(([stringNo, fret], i) => {
      notes.push(note(barStart + 2 * beatB + i * 0.012, 1.2, pitchOf(stringNo, fret), 92 - i * 2));
    });
  }
  // 结尾推弦演示：E4 长音 + 上弯 200 cents（→ {b(0 4)}）
  const outro = ARPEGGIO_SEC + 3 * 4 * beatB + 3.5 * beatB;
  notes.push(
    note(outro, 0.45, pitchOf(1, 0), 110, [
      { time: 0.1, cents: 60 },
      { time: 0.3, cents: 140 },
      { time: 0.45, cents: 200 },
    ]),
  );
  return notes;
}
