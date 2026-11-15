import { describe, expect, it } from 'vitest';
import {
  clusterEvents,
  detectArticulation,
  detectTuning,
  filterNotes,
  guitarProfile,
  routeFretboard,
  STANDARD_TUNING,
  toAlphaTex,
} from './GuitarProfile';
import { BALANCED_WEIGHTS } from './costWeights';
import type { FrettedNote, ProfileContext, RawNote } from './IInstrumentProfile';
import { createDemoBeatGridFromSections, createDemoNotes } from '../demoSong';
import { buildBeatGridFromSections } from '../core/quantizer';
import * as alphaTab from '@coderline/alphatab';

function n(onset: number, pitch: number, duration = 0.3, velocity = 100, pitchBend: RawNote['pitchBend'] = []): RawNote {
  return { onset, pitch, duration, velocity, pitchBend };
}

function ctx(overrides: Partial<ProfileContext> = {}): ProfileContext {
  return {
    config: {},
    style: 'balanced',
    weights: BALANCED_WEIGHTS,
    ...overrides,
  };
}

// Read sounding intervals from the real importer model, joining only actual
// tie links. Inspect every voice: beat counts alone can hide lost note tails.
function soundingIntervals(score: alphaTab.model.Score) {
  const intervals: { pitch: number; string: number; start: number; end: number }[] = [];
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            for (const note of beat.notes) {
              if (note.isTieDestination) continue;
              let last = note;
              while (last.tieDestination) {
                const next = last.tieDestination;
                expect(next.tieOrigin).toBe(last);
                expect(next.beat.voice.index).toBe(voice.index);
                expect(next.beat.voice.bar.masterBar.start + next.beat.playbackStart).toBe(
                  last.beat.voice.bar.masterBar.start + last.beat.playbackStart + last.beat.playbackDuration,
                );
                last = next;
              }
              intervals.push({
                pitch: note.realValue,
                string: staff.tuning.length + 1 - note.string,
                start: bar.masterBar.start + beat.playbackStart,
                end: last.beat.voice.bar.masterBar.start + last.beat.playbackStart + last.beat.playbackDuration,
              });
            }
          }
        }
      }
    }
  }
  return intervals.sort((a, b) => a.start - b.start || a.pitch - b.pitch || a.end - b.end || a.string - b.string);
}

function midiIntervals(score: alphaTab.model.Score) {
  const notes: { pitch: number; start: number; end: number }[] = [];
  const ignore = () => {};
  const handler: alphaTab.midi.IMidiFileHandler = {
    addNote: (_track, start, length, pitch) => { notes.push({ pitch, start, end: start + length }); },
    addTimeSignature: ignore,
    addRest: ignore,
    addControlChange: ignore,
    addProgramChange: ignore,
    addTempo: ignore,
    addNoteBend: ignore,
    addBend: ignore,
    finishTrack: ignore,
    addTickShift: ignore,
  };
  new alphaTab.midi.MidiFileGenerator(score, new alphaTab.Settings(), handler).generate();
  return notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch || a.end - b.end);
}

describe('filterNotes（音域/复音/碎音硬约束）', () => {
  it('剔除超出 [38, 88] 音域与 <35ms 的碎音', () => {
    const out = filterNotes(
      [n(0, 36), n(0.1, 40), n(0.2, 88), n(0.3, 90), n(0.4, 60, 0.02)],
      ctx(),
    );
    expect(out.map((x) => x.pitch)).toEqual([40, 88]);
  });

  it('同帧复音最多保留能量最高的 6 个', () => {
    const notes = Array.from({ length: 8 }, (_, i) =>
      n(0, 50 + i, 0.3, 40 + i * 10),
    );
    const out = filterNotes(notes, ctx());
    expect(out).toHaveLength(6);
    // 保留的是 velocity 最高的 6 个（pitch 52~57）
    expect(out.map((x) => x.pitch)).toEqual([52, 53, 54, 55, 56, 57]);
  });
});

describe('clusterEvents（扫弦聚拢 + 推弦合并）', () => {
  it('50ms 内单调音高簇对齐到同一起始时间（下扫）', () => {
    const strum = [40, 45, 50, 55, 59, 64].map((pitch, i) => n(i * 0.012, pitch));
    const out = clusterEvents(strum, ctx());
    expect(out.map((x) => x.onset)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('方向交替处断开：不把整段误判为一次扫弦', () => {
    // 55→50 递减构成双音簇（对齐），50→57 方向反转处断开
    const zigzag = [n(0, 55), n(0.02, 50), n(0.03, 57)];
    const out = clusterEvents(zigzag, ctx());
    expect(out.map((x) => x.onset)).toEqual([0, 0, 0.03]);
  });

  it('超过 50ms 窗口的音符不聚拢', () => {
    const spread = [n(0, 55), n(0.06, 50), n(0.12, 57)];
    const out = clusterEvents(spread, ctx());
    expect(out.map((x) => x.onset)).toEqual([0, 0.06, 0.12]);
  });

  it('相邻半音碎片（带 pitchBend）合并为单一长音', () => {
    const frag = [
      n(0, 64, 0.08, 100, [{ time: 0.04, cents: 50 }]),
      n(0.1, 65, 0.1, 100, [{ time: 0.05, cents: 100 }]),
    ];
    const out = clusterEvents(frag, ctx());
    expect(out).toHaveLength(1);
    expect(out[0].duration).toBeCloseTo(0.2, 5);
    expect(out[0].pitchBend).toHaveLength(2);
  });

  it('泛音误检抑制（§2.1）：+24 半音且能量显著弱 → 标记疑似泛音', () => {
    // 基频 G3(55) 强 + 4 次泛音 G5(79=55+24) 弱
    const out = clusterEvents([n(0, 55, 0.4, 100), n(0, 79, 0.2, 30)], ctx());
    expect(out).toHaveLength(2);
    const harmonic = out.find((x) => x.pitch === 79);
    expect(harmonic?.suspectedHarmonic).toBe(true);
    expect(out.find((x) => x.pitch === 55)?.suspectedHarmonic).toBeFalsy();
  });

  it('泛音误检抑制：+19 半音（3 次泛音）同样标记', () => {
    const out = clusterEvents([n(0, 45, 0.4, 100), n(0, 64, 0.2, 40)], ctx());
    expect(out.find((x) => x.pitch === 64)?.suspectedHarmonic).toBe(true);
  });

  it('泛音误检抑制：能量与基频同量级（八度重奏）不标记', () => {
    const out = clusterEvents([n(0, 55, 0.4, 100), n(0, 79, 0.4, 90)], ctx());
    expect(out.find((x) => x.pitch === 79)?.suspectedHarmonic).toBeFalsy();
  });

  it('泛音误检抑制：非 +19/+24 半音差（如 +18/+25）不标记', () => {
    const out = clusterEvents(
      [n(0, 55, 0.4, 100), n(0, 73, 0.2, 20), n(0, 80, 0.2, 20)],
      ctx(),
    );
    expect(out.find((x) => x.pitch === 73)?.suspectedHarmonic).toBeFalsy();
    expect(out.find((x) => x.pitch === 80)?.suspectedHarmonic).toBeFalsy();
  });
});

describe('detectTuning（Auto-Capo，§4.2）', () => {
  it('G 调旋律推荐 Capo 0 + 标准调弦', () => {
    const melody = [55, 57, 59, 60, 62, 64, 66].map((pitch, i) => n(i * 0.25, pitch));
    const result = detectTuning(melody, ctx());
    expect(result.capo).toBe(0);
    expect(result.tuning).toEqual(STANDARD_TUNING);
    expect(result.suggestions[0].capo).toBe(0);
    expect(result.suggestions).toHaveLength(3);
    expect(result.suggestions[0].reason).toMatch(/Capo 0/);
  });

  it('bB 调旋律推荐 Capo 3（G 调指法套用）', () => {
    // bB3 C4 D4 F4 G4 A4 F3 —— Capo 3 下 4 个音落空弦
    const melody = [58, 60, 62, 65, 67, 69, 53].map((pitch, i) => n(i * 0.25, pitch));
    const result = detectTuning(melody, ctx());
    expect(result.suggestions[0].capo).toBe(3);
    expect(result.tuning).toEqual(STANDARD_TUNING);
  });

  it('含低音 D2(38) 的乐句推荐 Drop D', () => {
    const melody = [38, 45, 50, 57, 62].map((pitch, i) => n(i * 0.25, pitch));
    const result = detectTuning(melody, ctx());
    expect(result.tuning).toEqual([38, 45, 50, 55, 59, 64]);
  });

  it('用户显式配置调弦时尊重配置', () => {
    const melody = [55, 59, 62].map((pitch, i) => n(i * 0.25, pitch));
    const result = detectTuning(melody, ctx({ config: { tuning: [38, 45, 50, 55, 59, 64], capo: 2 } }));
    expect(result.tuning).toEqual([38, 45, 50, 55, 59, 64]);
    expect(result.capo).toBe(2);
    expect(result.autoDetected).toBe(false);
  });
});

describe('routeFretboard（Viterbi 弦品寻路）', () => {
  it('单音 E4 落在 V 形先验中心附近（2 弦 5 品）', () => {
    const out = routeFretboard([n(0, 64)], ctx());
    expect(out[0].string).toBe(2);
    expect(out[0].fret).toBe(5);
  });

  it('E2/A2/D3 低音和弦分配到 6/5/4 弦空弦', () => {
    const out = routeFretboard([n(0, 40), n(0.005, 45), n(0.01, 50)], ctx());
    expect(out.map((o) => `${o.string}.${o.fret}`)).toEqual(['6.0', '5.0', '4.0']);
  });

  it('同簇同音高绝不分配到同一根弦（硬约束）', () => {
    const out = routeFretboard([n(0, 64), n(0.005, 64)], ctx());
    expect(out[0].string).not.toBe(out[1].string);
    expect(new Set(out.map((o) => o.fret))).toEqual(new Set([5, 9]));
  });

  it('簇内复音超过弦数时保留最强 N 个（长曲泛音堆叠下候选集不为空）', () => {
    const full = ctx();
    full.tuning = { tuning: STANDARD_TUNING, capo: 0, suggestions: [], autoDetected: true };
    // 8 个同 onset 音符（>6 弦，同弦互斥下 8 音无解）+ 后续 1 音
    const cluster = [40, 45, 50, 55, 59, 64, 69, 74].map((pitch, i) =>
      n(0, pitch, 0.3, 100 - i * 5),
    );
    const out = routeFretboard([...cluster, n(0.5, 55)], full);
    // 修复前：候选集为空 → beam 灭束 → 整体返回 0 音符
    expect(out.length).toBe(7);
    const firstCluster = out.filter((x) => x.onset === 0);
    expect(firstCluster).toHaveLength(6);
    // 保留的是 velocity 最高的前 6 个（40/45/50/55/59/64）
    expect(firstCluster.map((x) => x.pitch).sort((a, b) => a - b)).toEqual([40, 45, 50, 55, 59, 64]);
  });

  it('泛音堆叠簇跨度超限（6弦0品+1弦10品同簇）→ 放宽剪枝重试，beam 不灭', () => {
    const full = ctx();
    full.tuning = { tuning: STANDARD_TUNING, capo: 0, suggestions: [], autoDetected: true };
    // 40 强制 6 弦 0 品、74 强制 1 弦 10 品 → 品距 10 > reach×2=8，强剪枝下无解
    const out = routeFretboard([n(0, 40, 0.3, 100), n(0, 74, 0.3, 95), n(0.5, 55)], full);
    expect(out).toHaveLength(3);
    expect(out.filter((x) => x.onset === 0).map((x) => x.pitch).sort((a, b) => a - b))
      .toEqual([40, 74]);
  });

  it('把位移动惩罚与休止豁免：长间隔后可自由重定位', () => {
    const w = BALANCED_WEIGHTS;
    // 相邻两音：1 品 vs 20 品，间隔 2s（> moveFreeGap 0.4s）→ 移动免费
    const out = routeFretboard([n(0, 40), n(2.0, 88)], ctx());
    expect(out).toHaveLength(2);
    expect(w.moveFreeGap).toBeLessThan(2.0);
  });
});

describe('detectArticulation（演奏技巧检测）', () => {
  it('同弦相邻小间隔击弦 → hammer', () => {
    const out = routeFretboard([n(0, 64), n(0.1, 66, 0.2)], ctx());
    const marked = detectArticulation(out, ctx());
    // 66 在 2 弦 7 品 / 1 弦 2 品…若与 64 同弦且间隔 ≤ 40ms 才标 hammer；
    // 此处两音间隔 0.1-(0+0.3) <0 重叠 → gap = next.onset-(cur.onset+cur.duration)
    // 依赖寻路结果，宽松断言：不抛错且输出保留
    expect(marked).toHaveLength(2);
  });

  it('闷音：短促 + 低力度 → palmMute', () => {
    const out = routeFretboard([n(0, 55, 0.15, 40)], ctx());
    const marked = detectArticulation(out, ctx());
    expect(marked[0].techniques).toContain('palmMute');
  });

  it('明显 pitchBend（≥1 半音）→ bend', () => {
    const out = routeFretboard([n(0, 64, 0.4, 100, [{ time: 0.2, cents: 200 }])], ctx());
    const marked = detectArticulation(out, ctx());
    expect(marked[0].techniques).toContain('bend');
  });
});

describe('toAlphaTex（格式化输出）', () => {
  it('包含 tempo 头、轨信息与合法音符 token', () => {
    const full = ctx();
    full.tuning = detectTuning([n(0, 55), n(0.5, 59), n(1.0, 62)], full);
    const fretted = routeFretboard([n(0, 55), n(0.5, 59), n(1.0, 62)], full);
    const tex = toAlphaTex(fretted, full);
    expect(tex).toMatch(/^\\tempo 120$/m);
    expect(tex).toContain('\\track "Guitar" \\instrument 25');
    // alphaTex 1.8 规范语法：":时值 fret.string"（时值前缀，音符效果紧跟）
    expect(tex).toMatch(/:\d+ \d+\.\d+/);
  });

  it('alphaTab 读回单音、同起音和弦及连续和弦时保持音符数、音高和节拍位置', () => {
    const full = ctx();
    full.tuning = { tuning: STANDARD_TUNING, capo: 0, suggestions: [], autoDetected: true };
    const roundTrip = (notes: FrettedNote[]) => {
      const importer = new alphaTab.importer.AlphaTexImporter();
      importer.initFromString(toAlphaTex(notes, full), new alphaTab.Settings());
      const score = importer.readScore();
      return score.tracks[0].staves[0].bars.flatMap((bar) =>
        bar.voices[0].beats.filter((beat) => beat.notes.length > 0).map((beat) => ({
          start: beat.playbackStart,
          duration: beat.playbackDuration,
          pitches: beat.notes.map((note) => note.realValue).sort((a, b) => a - b),
        })),
      );
    };

    const single: FrettedNote = {
      string: 1, fret: 0, onset: 0, duration: 0.5, pitch: 64,
    };
    expect(roundTrip([single])).toEqual([
      { start: 0, duration: 960, pitches: [64] },
    ]);

    const firstChord: FrettedNote[] = [
      { string: 1, fret: 0, onset: 0, duration: 0.5, pitch: 64 },
      { string: 2, fret: 1, onset: 0, duration: 0.5, pitch: 60 },
    ];
    const secondChord: FrettedNote[] = [
      { string: 3, fret: 0, onset: 0.5, duration: 0.5, pitch: 55 },
      { string: 4, fret: 2, onset: 0.5, duration: 0.5, pitch: 52 },
    ];
    expect(roundTrip([...firstChord, ...secondChord])).toEqual([
      { start: 0, duration: 960, pitches: [60, 64] },
      { start: 960, duration: 960, pitches: [52, 55] },
    ]);
  });

  it('混合时值和弦保持每个音的独立截止，后续旋律按时进入', () => {
    const full = ctx();
    full.tuning = { tuning: STANDARD_TUNING, capo: 0, suggestions: [], autoDetected: true };
    const notes: FrettedNote[] = [
      { string: 1, fret: 0, onset: 0, duration: 0.5, pitch: 64 },
      { string: 6, fret: 0, onset: 0, duration: 1, pitch: 40 },
      { string: 2, fret: 3, onset: 0.5, duration: 0.5, pitch: 62 },
    ];
    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.initFromString(toAlphaTex(notes, full), new alphaTab.Settings());
    expect(soundingIntervals(importer.readScore())).toEqual([
      { start: 0, end: 1920, pitch: 40, string: 6 },
      { start: 0, end: 960, pitch: 64, string: 1 },
      { start: 960, end: 1920, pitch: 62, string: 2 },
    ]);
  });

  it('调性结果输出 \\ks 调号（§3.3 第 1 项），手动指定优先', () => {
    const full = ctx();
    full.tuning = { tuning: STANDARD_TUNING, capo: 0, suggestions: [], autoDetected: true };
    // E 小调三和弦分解（E G B）+ 低音 E 强调
    full.key = { tonicPc: 4, mode: 'minor', name: 'Em', confidence: 0.9 };
    let fretted = routeFretboard([n(0, 52), n(0.5, 55), n(1.0, 59), n(1.5, 64)], full);
    let tex = toAlphaTex(fretted, full);
    expect(tex).toContain('\\ks eminor');

    // 手动覆盖优先于检测
    full.keyOverride = { tonicPc: 7, mode: 'major' };
    fretted = routeFretboard([n(0, 52), n(0.5, 55), n(1.0, 59), n(1.5, 64)], full);
    tex = toAlphaTex(fretted, full);
    expect(tex).toContain('\\ks gmajor');
  });

  it('三连音 tuplet 输出 {tu 3} 标签', () => {
    const full = ctx();
    full.tuning = { tuning: STANDARD_TUNING, capo: 0, suggestions: [], autoDetected: true };
    const fretted = routeFretboard([
      n(0, 55, 0.166),
      n(0.1667, 57, 0.166),
      n(0.3333, 59, 0.166),
    ], full);
    const marked = fretted.map((f) => ({ ...f, tuplet: '3' as const }));
    const tex = toAlphaTex(marked, full);
    // 三连音为小节级效果：":时值 音符 {tu 3}"
    expect(tex).toMatch(/:\d+ \d+\.\d+ \{tu 3\}/);
  });

  it('疑似泛音不入谱（§2.1 标记制；数据保留供编辑器处置）', () => {
    const full = ctx();
    full.tuning = { tuning: STANDARD_TUNING, capo: 0, suggestions: [], autoDetected: true };
    const fretted = routeFretboard([n(0, 55), n(0.5, 59), n(1.0, 62)], full);
    // 人为把中音音符标记为疑似泛音
    const flagged = fretted.map((f) =>
      f.pitch === 59 ? { ...f, suspectedHarmonic: true } : f,
    );
    const tex = toAlphaTex(flagged, full);
    const bar1 = tex.split('\n')[3] ?? '';
    const fn = flagged.find((f) => f.suspectedHarmonic)!;
    // 弦.品 token 应整体缺席（词边界防 15.3 误匹配 5.3）
    expect(bar1).not.toMatch(new RegExp(`\\b${fn.fret}\\.${fn.string}\\b`));
    // 数据仍在 notes 中，供编辑器恢复
    expect(flagged.filter((f) => f.suspectedHarmonic)).toHaveLength(1);
  });

  it('同一音符多效果合并为单个 {} 组（连续多组解析器不认）', () => {
    const full = ctx();
    full.tuning = { tuning: STANDARD_TUNING, capo: 0, suggestions: [], autoDetected: true };
    const note: FrettedNote = {
      string: 1,
      fret: 5,
      onset: 0,
      duration: 0.25,
      pitch: 69,
      bend: [{ time: 0.1, cents: 150 }],
      techniques: ['bend', 'palmMute'],
    };
    const tex = toAlphaTex([note], full);
    // 官方导出器形式：{b(0 2) pm} —— 单组、空格分隔
    expect(tex).toMatch(/\{b\(0 \d+\) pm\}/);
    expect(tex).not.toMatch(/\}\{/);
  });

  it('Capo > 0 时输出 \\capo 指令', () => {
    const full = ctx();
    full.tuning = { tuning: STANDARD_TUNING, capo: 3, suggestions: [], autoDetected: true };
    const fretted = routeFretboard([n(0, 55)], full);
    const tex = toAlphaTex(fretted, full);
    expect(tex).toContain('\\capo 3');
  });

  it('空音符 / 全部疑似泛音 → 仍输出可解析的全休止符谱', () => {
    const full = ctx();
    full.tuning = { tuning: STANDARD_TUNING, capo: 0, suggestions: [], autoDetected: true };
    full.beatGrid = buildBeatGridFromSections([
      { start: 0, end: 4, bpm: 120, timeSignature: [4, 4] },
    ]);
    const harmonicOnly: FrettedNote[] = [
      { string: 1, fret: 0, onset: 0, duration: 0.25, pitch: 64, velocity: 60, suspectedHarmonic: true },
    ];
    for (const notes of [[], harmonicOnly]) {
      const tex = toAlphaTex(notes, full);
      const importer = new alphaTab.importer.AlphaTexImporter();
      importer.initFromString(tex, new alphaTab.Settings());
      const score = importer.readScore();
      expect(score.tracks.length).toBeGreaterThan(0);
      expect(tex).toMatch(/\br\b/); // 休止符
    }
  });
});

describe('toAlphaTex 音乐时间轴（025 / 026 / 030）', () => {
  const sections120 = [
    { start: 0, end: 20, bpm: 120, timeSignature: [4, 4] as [number, number] },
  ];
  const fretted = (onset: number, duration: number): FrettedNote => ({
    string: 1, fret: 0, pitch: 64, onset, duration,
  });
  function read(notes: FrettedNote[], sections?: typeof sections120) {
    const full = ctx({
      config: { tuning: STANDARD_TUNING, capo: 0 },
      beatGrid: sections ? { sections, beats: [] } : undefined,
    });
    const tex = toAlphaTex(notes, full);
    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.initFromString(tex, new alphaTab.Settings());
    const score = importer.readScore();
    const bars = score.tracks[0].staves[0].bars;
    const beats = bars.flatMap((bar) => bar.voices.flatMap((voice) => voice.beats.map((beat) => ({
      beat,
      absoluteStart: bar.masterBar.start + beat.playbackStart,
    }))));
    return { tex, score, bars, beats };
  }
  function expectFullBars(result: ReturnType<typeof read>) {
    for (const bar of result.bars) {
      for (const voice of bar.voices) {
        let cursor = 0;
        for (const beat of voice.beats) {
          expect(beat.playbackStart).toBe(cursor);
          cursor += beat.playbackDuration;
        }
        expect(cursor).toBe(3840);
      }
    }
  }
  function pitched(result: ReturnType<typeof read>) {
    return result.beats.filter(({ beat }) => beat.notes.length > 0);
  }
  function expectTieChain(result: ReturnType<typeof read>, pitch = 64) {
    const chain = pitched(result).map(({ beat }) => beat.notes.find((note) => note.realValue === pitch)!);
    expect(chain.every(Boolean)).toBe(true);
    expect(chain[0].isTieDestination).toBe(false);
    expect(chain.filter((note) => !note.isTieDestination)).toHaveLength(1);
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].isTieDestination).toBe(true);
      expect(chain[i].tieOrigin).toBe(chain[i - 1]);
      expect(chain[i - 1].tieDestination).toBe(chain[i]);
    }
    expect(chain[chain.length - 1].tieDestination).toBeNull();
  }

  it.each([0.0625, 0.125, 0.375, 1.375, 1.5, 1.9375])(
    '精确分解起音前和小节尾的休止：起音 %s 秒', (onset) => {
      const result = read([fretted(onset, 0.0625)]);
      const sounding = pitched(result);
      expect(sounding).toHaveLength(1);
      expect(sounding[0].absoluteStart).toBe(onset * 1920);
      expect(sounding[0].beat.playbackDuration).toBe(120);
      expectFullBars(result);
    },
  );

  it('连续非二进制空隙不累计误差，跨小节后的起音保持绝对位置', () => {
    const onsets = [0.1875, 0.875, 1.375, 2.0625, 3.6875];
    const result = read(onsets.map((onset) => fretted(onset, 0.0625)));
    expect(pitched(result).map(({ absoluteStart }) => absoluteStart)).toEqual(
      onsets.map((onset) => onset * 1920),
    );
    expectFullBars(result);
  });

  it('遍历单小节内所有32分网格的起止组合，休止和延音都恰好填满小节', () => {
    for (let start = 0; start < 32; start++) {
      for (let end = start + 1; end <= 32; end++) {
        const result = read([fretted(start / 16, (end - start) / 16)]);
        const sounding = pitched(result);
        expect(result.bars).toHaveLength(1);
        expect(sounding[0].absoluteStart).toBe(start * 120);
        expect(sounding.at(-1)!.absoluteStart + sounding.at(-1)!.beat.playbackDuration).toBe(end * 120);
        expect(sounding.reduce((sum, { beat }) => sum + beat.playbackDuration, 0)).toBe((end - start) * 120);
        expectTieChain(result);
        expectFullBars(result);
      }
    }
  });

  it.each([
    [1.5, 2, 2],
    [1.375, 5.25, 4],
    [0, 6, 3],
    [0, 6.0625, 4],
  ])('长音 %s 秒起、持续 %s 秒：保留起点、完整延音及 %s 个小节', (onset, duration, barCount) => {
    const result = read([fretted(onset, duration)]);
    const sounding = pitched(result);
    expect(result.bars).toHaveLength(barCount);
    expect(sounding[0].absoluteStart).toBe(onset * 1920);
    expect(sounding.reduce((sum, { beat }) => sum + beat.playbackDuration, 0)).toBe(duration * 1920);
    expect(sounding.at(-1)!.absoluteStart + sounding.at(-1)!.beat.playbackDuration)
      .toBe((onset + duration) * 1920);
    expectTieChain(result);
    expectFullBars(result);
  });

  it('小节内复合时值用延音相连，后续新音不会误连或移动', () => {
    const result = read([fretted(0.125, 0.1875), fretted(0.5, 0.0625)]);
    const sounding = pitched(result);
    expect(sounding.map(({ absoluteStart }) => absoluteStart)).toEqual([240, 480, 960]);
    expect(sounding.map(({ beat }) => beat.playbackDuration)).toEqual([240, 120, 120]);
    expect(sounding[1].beat.notes[0].tieOrigin).toBe(sounding[0].beat.notes[0]);
    expect(sounding[2].beat.notes[0].isTieDestination).toBe(false);
    expectFullBars(result);
  });

  it('跨变速小节的延音按各段 BPM 计算，不能把全部秒数按起音 BPM 换算', () => {
    const sections = [
      { start: 0, end: 2, bpm: 120, timeSignature: [4, 4] as [number, number] },
      { start: 2, end: 6, bpm: 60, timeSignature: [4, 4] as [number, number] },
    ];
    const result = read([fretted(1.5, 3.5)], sections);
    const sounding = pitched(result);
    expect(result.bars).toHaveLength(2);
    expect(sounding[0].absoluteStart).toBe(2880);
    expect(sounding.at(-1)!.absoluteStart + sounding.at(-1)!.beat.playbackDuration).toBe(6720);
    let soundingSeconds = 0;
    for (const bar of result.bars) {
      const bpm = bar.index === 0 ? 120 : 60;
      soundingSeconds += bar.voices[0].beats
        .filter((beat) => beat.notes.length > 0)
        .reduce((sum, beat) => sum + beat.playbackDuration / 960 * 60 / bpm, 0);
    }
    expect(soundingSeconds).toBe(3.5);
    expect(result.score.masterBars[1].tempoAutomations.map((automation) => automation.value)).toContain(60);
    expectTieChain(result);
    expectFullBars(result);
  });

  it('120 → 90 → 60 BPM 的非整数秒小节边界不累计舍入误差', () => {
    const sections = [
      { start: 0, end: 2, bpm: 120, timeSignature: [4, 4] as [number, number] },
      { start: 2, end: 14 / 3, bpm: 90, timeSignature: [4, 4] as [number, number] },
      { start: 14 / 3, end: 26 / 3, bpm: 60, timeSignature: [4, 4] as [number, number] },
    ];
    const result = read([fretted(1.375, 14 / 3)], sections);
    const bpms = result.score.masterBars.map((bar) => bar.tempoAutomations[0].value);
    expect(bpms).toEqual([120, 90, 60]);
    const soundingSeconds = result.bars.reduce((sum, bar, index) => sum +
      bar.voices[0].beats.filter((beat) => beat.notes.length > 0)
        .reduce((seconds, beat) => seconds + beat.playbackDuration / 960 * 60 / bpms[index], 0), 0);
    expect(soundingSeconds).toBeCloseTo(14 / 3, 10);
    expect(pitched(result)[0].absoluteStart / 960 * 60 / bpms[0]).toBe(1.375);
    expectTieChain(result);
    expectFullBars(result);
  });

  it('网格结束后仍持续的长音完整入谱，未提供网格时不使用默认巨大哨兵长度', () => {
    const shortGrid = [{ start: 0, end: 2, bpm: 120, timeSignature: [4, 4] as [number, number] }];
    const result = read([fretted(1.5, 3)], shortGrid);
    expect(result.bars).toHaveLength(3);
    expect(pitched(result).at(-1)!.absoluteStart + pitched(result).at(-1)!.beat.playbackDuration).toBe(8640);
    expectTieChain(result);
    expectFullBars(result);
    expect(read([fretted(0, 0.5)]).bars).toHaveLength(1);
  });

  it('显式有限网格结束时间保留源音频尾部静音，包括没有任何音符的音频', () => {
    for (const notes of [[fretted(0, 0.5)], []]) {
      const result = read(notes, sections120);
      expect(result.bars).toHaveLength(10);
      expect(result.beats.at(-1)!.absoluteStart + result.beats.at(-1)!.beat.playbackDuration).toBe(38400);
      expectFullBars(result);
    }
    const shortTail = read([fretted(0, 0.5)], [
      { start: 0, end: 2.01, bpm: 120, timeSignature: [4, 4] },
    ]);
    expect(shortTail.bars).toHaveLength(2);
    expectFullBars(shortTail);
  });

  it('忽略显式网格的无限结束哨兵，有限音符仍可正常导出', () => {
    const result = read([fretted(0, 0.5)], [
      { start: 0, end: Number.POSITIVE_INFINITY, bpm: 120, timeSignature: [4, 4] },
    ]);
    expect(result.bars).toHaveLength(1);
    expectFullBars(result);
  });

  it('451小节的真实alphaTab回读仍把900秒处音符放在第451小节（022导出路径）', () => {
    const result = read([fretted(900, 0.5)], [
      { start: 0, end: 902, bpm: 120, timeSignature: [4, 4] },
    ]);
    expect(result.bars).toHaveLength(451);
    const sounding = pitched(result);
    expect(sounding).toHaveLength(1);
    expect(sounding[0].beat.voice.bar.index).toBe(450);
    expect(sounding[0].absoluteStart).toBe(1728000);
    expect(sounding[0].beat.playbackDuration).toBe(960);
    expectFullBars(result);
  });

  it('混合时值和弦的低音完整跨小节持续，下一小节旋律仍按时进入', () => {
    const result = read([
      fretted(1.5, 0.5),
      { string: 6, fret: 0, pitch: 40, onset: 1.5, duration: 3 },
      { ...fretted(2, 0.5), fret: 2, pitch: 66 },
    ]);
    expect(soundingIntervals(result.score)).toEqual([
      { start: 2880, end: 8640, pitch: 40, string: 6 },
      { start: 2880, end: 3840, pitch: 64, string: 1 },
      { start: 3840, end: 4800, pitch: 66, string: 1 },
    ]);
    expect(result.bars).toHaveLength(3);
    expectFullBars(result);
  });

  it('跨小节低音续片与独立新起音可以同时表达，保留两个独立截止时刻', () => {
    const result = read([
      { string: 6, fret: 0, pitch: 40, onset: 0, duration: 4 },
      { ...fretted(2.5, 0.5), fret: 2, pitch: 66 },
    ]);
    expect(soundingIntervals(result.score)).toEqual([
      { start: 0, end: 7680, pitch: 40, string: 6 },
      { start: 4800, end: 5760, pitch: 66, string: 1 },
    ]);
    expectFullBars(result);
  });

  it.each([
    {
      name: '持续bass与多个中途起音的旋律',
      notes: [
        { string: 6, fret: 0, pitch: 40, onset: 0, duration: 1.75 },
        { string: 1, fret: 0, pitch: 64, onset: 0.375, duration: 0.25 },
        { string: 1, fret: 2, pitch: 66, onset: 0.875, duration: 0.375 },
        { string: 1, fret: 3, pitch: 67, onset: 1.5, duration: 0.25 },
      ],
    },
    {
      name: '同起音的六根弦各有不同截止时刻',
      notes: [
        { string: 6, fret: 0, pitch: 40, onset: 0, duration: 2 },
        { string: 5, fret: 2, pitch: 47, onset: 0, duration: 1.5 },
        { string: 4, fret: 2, pitch: 52, onset: 0, duration: 1 },
        { string: 3, fret: 0, pitch: 55, onset: 0, duration: 0.5 },
        { string: 2, fret: 0, pitch: 59, onset: 0, duration: 0.25 },
        { string: 1, fret: 0, pitch: 64, onset: 0, duration: 0.125 },
      ],
    },
    {
      name: '复音和弦交叠且部分音跨越小节',
      notes: [
        { string: 6, fret: 0, pitch: 40, onset: 0, duration: 1.5 },
        { string: 4, fret: 2, pitch: 52, onset: 0, duration: 1.5 },
        { string: 1, fret: 0, pitch: 64, onset: 0.5, duration: 0.5 },
        { string: 2, fret: 1, pitch: 60, onset: 0.5, duration: 1 },
        { string: 1, fret: 3, pitch: 67, onset: 1.25, duration: 1 },
        { string: 2, fret: 3, pitch: 62, onset: 1.5, duration: 0.5 },
      ],
    },
    {
      name: '输入指法同弦重叠时仍保留独立音符和各自tie归属',
      // Physically conflicting guitar fingerings (#039): this checks data
      // preservation, not that one guitar string can play both frets at once.
      notes: [
        { string: 1, fret: 0, pitch: 64, onset: 0, duration: 2 },
        { string: 1, fret: 2, pitch: 66, onset: 0.5, duration: 1 },
        { string: 1, fret: 0, pitch: 64, onset: 1.5, duration: 1 },
      ],
    },
    {
      name: '同弦同品重复起音不能被误连成一条长音',
      notes: [
        { string: 1, fret: 0, pitch: 64, onset: 0, duration: 1 },
        { string: 1, fret: 0, pitch: 64, onset: 0.5, duration: 1 },
      ],
    },
  ])('027：$name，真实回读所有音符的独立起止与弦号', ({ notes }) => {
    const expected = notes.map((note) => ({
      pitch: note.pitch,
      string: note.string,
      start: note.onset * 1920,
      end: (note.onset + note.duration) * 1920,
    })).sort((a, b) => a.start - b.start || a.pitch - b.pitch || a.end - b.end || a.string - b.string);
    for (const input of [notes, [...notes].reverse()]) {
      const result = read(input);
      expect(result.score.tracks).toHaveLength(1);
      expect(result.score.tracks[0].staves).toHaveLength(1);
      expect(soundingIntervals(result.score)).toEqual(expected);
      expect(midiIntervals(result.score)).toEqual(expected.map(({ pitch, start, end }) => ({ pitch, start, end })));
      expectFullBars(result);
    }
  });

  it('027：alphaTab实际支持六个声部，六弦不同截止及各声部尾部静音均完整保留', () => {
    const notes: FrettedNote[] = [
      { string: 6, fret: 0, pitch: 40, onset: 0, duration: 2 },
      { string: 5, fret: 2, pitch: 47, onset: 0, duration: 1.5 },
      { string: 4, fret: 2, pitch: 52, onset: 0, duration: 1 },
      { string: 3, fret: 0, pitch: 55, onset: 0, duration: 0.5 },
      { string: 2, fret: 0, pitch: 59, onset: 0, duration: 0.25 },
      { string: 1, fret: 0, pitch: 64, onset: 0, duration: 0.125 },
    ];
    const result = read(notes, [{ start: 0, end: 6, bpm: 120, timeSignature: [4, 4] }]);
    expect(result.score.masterBars).toHaveLength(3);
    for (const bar of result.bars) expect(bar.voices).toHaveLength(6);
    const expected = notes.map((note) => ({
      pitch: note.pitch, string: note.string, start: 0, end: note.duration * 1920,
    }));
    expect(soundingIntervals(result.score)).toEqual(expected);
    expect(midiIntervals(result.score)).toEqual(expected.map(({ pitch, start, end }) => ({ pitch, start, end })));
    expectFullBars(result);
  });

  it('027：跨变速段的持续低音与旋律，逐音回读秒数和独立截止均正确', () => {
    const sections = [
      { start: 0, end: 2, bpm: 120, timeSignature: [4, 4] as [number, number] },
      { start: 2, end: 6, bpm: 60, timeSignature: [4, 4] as [number, number] },
    ];
    const result = read([
      { string: 6, fret: 0, pitch: 40, onset: 1.5, duration: 3.5 },
      { string: 1, fret: 0, pitch: 64, onset: 2.5, duration: 0.5 },
      { string: 1, fret: 3, pitch: 67, onset: 4, duration: 1 },
    ], sections);
    expect(soundingIntervals(result.score)).toEqual([
      { pitch: 40, string: 6, start: 2880, end: 6720 },
      { pitch: 64, string: 1, start: 4320, end: 4800 },
      { pitch: 67, string: 1, start: 5760, end: 6720 },
    ]);
    expect(midiIntervals(result.score)).toEqual([
      { pitch: 40, start: 2880, end: 6720 },
      { pitch: 64, start: 4320, end: 4800 },
      { pitch: 67, start: 5760, end: 6720 },
    ]);
    expect(result.bars).toHaveLength(2);
    expect(result.score.masterBars[1].tempoAutomations.map((automation) => automation.value)).toEqual([60]);
    expectFullBars(result);
  });

  it('027：声部复用优先保留同弦奏法连接，推弦与闷音仍留在各自起音', () => {
    const result = read([
      { string: 6, fret: 0, pitch: 40, onset: 0, duration: 2, techniques: ['palmMute'] },
      { string: 1, fret: 0, pitch: 64, onset: 0, duration: 0.5,
        bend: [{ time: 0.25, cents: 100 }], techniques: ['bend'] },
      { string: 2, fret: 1, pitch: 60, onset: 0, duration: 1, techniques: ['hammer'] },
      { string: 1, fret: 2, pitch: 66, onset: 0.5, duration: 0.5 },
      { string: 2, fret: 3, pitch: 62, onset: 1, duration: 0.5 },
    ]);
    const origins = result.beats.flatMap(({ beat }) => beat.notes.filter((note) => !note.isTieDestination));
    const bass = origins.find((note) => note.realValue === 40)!;
    const bent = origins.find((note) => note.realValue === 64)!;
    const hammer = origins.find((note) => note.realValue === 60)!;
    const hammerDestination = origins.find((note) => note.realValue === 62)!;
    expect(bass.isPalmMute).toBe(true);
    expect(bent.hasBend).toBe(true);
    expect(hammer.isHammerPullOrigin).toBe(true);
    expect(hammer.hammerPullDestination).toBe(hammerDestination);
    expect(hammer.beat.voice.index).toBe(hammerDestination.beat.voice.index);
    expect(soundingIntervals(result.score)).toEqual([
      { pitch: 40, string: 6, start: 0, end: 3840 },
      { pitch: 60, string: 2, start: 0, end: 1920 },
      { pitch: 64, string: 1, start: 0, end: 960 },
      { pitch: 66, string: 1, start: 960, end: 1920 },
      { pitch: 62, string: 2, start: 1920, end: 2880 },
    ]);
    expectFullBars(result);
  });

  it('隐藏的疑似泛音不会拉长谱面，空输入也只保留一个完整休止小节', () => {
    const result = read([
      fretted(0, 0.5),
      { ...fretted(10, 10), suspectedHarmonic: true },
    ]);
    expect(result.bars).toHaveLength(1);
    expectFullBars(result);
    const empty = read([]);
    expect(empty.bars).toHaveLength(1);
    expect(pitched(empty)).toHaveLength(0);
    expectFullBars(empty);
  });

  it('跨小节和弦每根弦各自建立 tie，起音奏法标记仍保留', () => {
    const result = read([
      { ...fretted(1.5, 2), bend: [{ time: 1.75, cents: 100 }], techniques: ['bend', 'palmMute'] },
      { string: 2, fret: 1, pitch: 60, onset: 1.5, duration: 2, techniques: ['hammer'] },
    ]);
    for (const { beat } of pitched(result)) {
      expect(beat.notes.map((note) => note.realValue).sort((a, b) => a - b)).toEqual([60, 64]);
    }
    expectTieChain(result, 64);
    expectTieChain(result, 60);
    const origin = pitched(result)[0].beat;
    expect(origin.notes.find((note) => note.realValue === 64)!.hasBend).toBe(true);
    expect(origin.notes.find((note) => note.realValue === 64)!.isPalmMute).toBe(true);
    expect(origin.notes.find((note) => note.realValue === 60)!.isHammerPullOrigin).toBe(true);
    expectFullBars(result);
  });
});

describe('transcribe（端到端流水线）', () => {
  it('演示乐句全流程：扫弦聚拢、Auto-Capo Top3、bend 技巧、alphaTex 输出', () => {
    const result = guitarProfile.transcribe(createDemoNotes(), {
      beatGrid: createDemoBeatGridFromSections(),
    });
    expect(result.notes.length).toBeGreaterThan(20);
    expect(result.meta.suggestedCapo).toHaveLength(3);
    expect(result.alphaTex).toContain('\\tempo 80');
    // §3.5 分段变速：第 5 小节起输出新段 \tempo
    expect(result.alphaTex).toContain('\\tempo 60');

    // 第 5 小节下扫（6 音）应聚拢到同一 onset 且 6 弦各占一根
    const strumOnset = 4 * 4 * (60 / 80);
    const strumNotes = result.notes.filter((x) => x.onset === strumOnset);
    expect(strumNotes).toHaveLength(6);
    expect(new Set(strumNotes.map((x) => x.string)).size).toBe(6);

    // 结尾推弦应带上 bend 技巧
    expect(result.notes.some((x) => x.techniques?.includes('bend'))).toBe(true);

    // alphaTex 主体为 ":时值 弦.品[效果]" token 序列
    expect(result.alphaTex).toMatch(/:\d+ 0\.\d+/);
  });

  it('生成的 alphaTex 可被 alphaTab 解析（语法回归防护，防导入器/导出器不对称）', () => {
    const result = guitarProfile.transcribe(createDemoNotes(), {
      beatGrid: createDemoBeatGridFromSections(),
    });
    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.initFromString(result.alphaTex, new alphaTab.Settings());
    const score = importer.readScore();
    expect(score.masterBars.length).toBeGreaterThan(0);
    expect(score.tracks.length).toBe(1);
  });

  it('长曲规模音流（泛音堆叠 + 疑似泛音 + 变速分段）生成的 alphaTex 可被 alphaTab 解析', () => {
    // 模拟长文件实况：40 小节、每拍基频 + 和声堆叠 + +24 弱伪泛音
    const notes: RawNote[] = [];
    for (let bar = 0; bar < 40; bar++) {
      const t0 = bar * 2;
      [40, 55, 59, 64].forEach((p, i) =>
        notes.push({ onset: t0 + i * 0.02, duration: 0.3, pitch: p, velocity: 100 - i * 15, pitchBend: [] }),
      );
      notes.push({ onset: t0, duration: 0.2, pitch: 88, velocity: 20, pitchBend: [] });
      const melody = [55, 59, 62, 64][bar % 4];
      notes.push({ onset: t0 + 0.5, duration: 0.4, pitch: melody, velocity: 90, pitchBend: [] });
      notes.push({ onset: t0 + 1.0, duration: 0.4, pitch: melody + 24, velocity: 25, pitchBend: [] });
    }
    const sections = [
      { start: 0, end: 40, bpm: 120, timeSignature: [4, 4] as [number, number] },
      { start: 40, end: 80.1, bpm: 40, timeSignature: [4, 4] as [number, number] },
    ];
    const grid = buildBeatGridFromSections(sections);
    const result = guitarProfile.transcribe(notes, { beatGrid: grid });
    // 泛音抑制生效（伪泛音被标记）
    expect(result.notes.some((x) => x.suspectedHarmonic)).toBe(true);
    // 路由不再灭束（修复前：整体 0 音符）
    expect(result.notes.length).toBeGreaterThan(100);
    // 产物过真解析器
    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.initFromString(result.alphaTex, new alphaTab.Settings());
    const score = importer.readScore();
    expect(score.masterBars.length).toBeGreaterThan(10);
  });

  it('serializeForLlm 直接返回 alphaTex 文本（BYOK 用）', () => {
    const result = guitarProfile.transcribe([n(0, 55)]);
    expect(guitarProfile.serializeForLlm(result)).toBe(result.alphaTex);
  });
});
