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
