import { describe, expect, it } from 'vitest';
import {
  buildTempoMap,
  detectTempoCandidates,
  expandGradientToSteps,
  barStartTime,
  buildBeatGrid,
  buildBeatGridFromSections,
  quantizeNotes,
} from './quantizer';
import type { BeatSection, RawNote } from '../profiles/IInstrumentProfile';

/** 量化测试用 RawNote 构造 */
function qn(onset: number, duration = 0.2, pitch = 52): RawNote {
  return { onset, duration, pitch, velocity: 90, pitchBend: [] };
}

/** 恒定 BPM 的拍点序列 */
function beats(bpm: number, count: number, offset = 0): number[] {
  const beat = 60 / bpm;
  return Array.from({ length: count }, (_, i) => Number((offset + i * beat).toFixed(6)));
}

/** LCG 伪随机（可复现） */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

describe('detectTempoCandidates（§3.5：BOCPD + CI 判据）', () => {
  it('真变速 120→90（各 16 拍）：检出单一候选、置信度高、无渐变标记', () => {
    const times = [...beats(120, 16), ...beats(90, 16, 16 * 0.5)];
    const cands = detectTempoCandidates(times);
    expect(cands.length).toBeGreaterThanOrEqual(1);
    const c = cands[0];
    expect(c.bpmBefore).toBeGreaterThan(110);
    expect(c.bpmBefore).toBeLessThan(130);
    expect(c.bpmAfter).toBeGreaterThan(80);
    expect(c.bpmAfter).toBeLessThan(100);
    // 变速点在边界（第 16 拍 ≈ 8.0s）±2 拍内
    expect(Math.abs(c.time - 8.0)).toBeLessThan(1.4);
    expect(c.confidence).toBeGreaterThan(0.8);
    expect(c.gradient).toBe(false);
  });

  it('恒定 BPM：无候选（不扰动用户）', () => {
    expect(detectTempoCandidates(beats(120, 40))).toEqual([]);
  });

  it('稳拍小幅变速 118→122 可检出（CI 判据替代 ±8% 阈值）', () => {
    const times = [...beats(118, 24), ...beats(122, 24, 24 * (60 / 118))];
    const cands = detectTempoCandidates(times);
    expect(cands.length).toBeGreaterThanOrEqual(1);
    expect(cands[0].bpmAfter).toBeGreaterThan(118);
    // 置信度落入确认流区间（渐进 UX：中置信提示确认，不自动应用）
    expect(cands[0].confidence).toBeGreaterThan(0.3);
    expect(cands[0].confidence).toBeLessThan(0.8);
  });

  it('演奏不稳（±3% 抖动）不误报（CI 宽自动降灵敏度）', () => {
    const rand = lcg(12345);
    const times: number[] = [];
    let t = 0;
    for (let i = 0; i < 48; i++) {
      times.push(Number(t.toFixed(6)));
      t += 0.5 * (1 + (rand() - 0.5) * 0.06);
    }
    const cands = detectTempoCandidates(times);
    expect(cands.every((c) => c.confidence < 0.8)).toBe(true);
  });

  it('渐变变速：密集变点簇标记为 gradient', () => {
    // 120 → 90 线性渐变（每拍递减）
    const times: number[] = [];
    let t = 0;
    let bpm = 120;
    for (let i = 0; i < 48; i++) {
      times.push(Number(t.toFixed(6)));
      t += 60 / bpm;
      bpm = Math.max(90, bpm - 1.2); // 24 拍内线性降到 90 后恒定
    }
    for (let i = 0; i < 12; i++) {
      times.push(Number(t.toFixed(6)));
      t += 60 / bpm;
    }
    const cands = detectTempoCandidates(times);
    expect(cands.length).toBeGreaterThanOrEqual(1);
    const gradient = cands.find((c) => c.gradient);
    expect(gradient).toBeDefined();
    expect(gradient!.bpmAfter).toBeLessThan(105);
  });
});

describe('buildTempoMap（变速点表 → 分段）', () => {
  it('单点 80→60 分两段', () => {
    const map = buildTempoMap(28, [4, 4], 80, [{ time: 12, bpm: 60 }]);
    expect(map).toHaveLength(2);
    expect(map[0]).toMatchObject({ start: 0, end: 12, bpm: 80 });
    expect(map[1]).toMatchObject({ start: 12, bpm: 60 });
  });

  it('相邻段差 < 2 BPM 自动合并', () => {
    const map = buildTempoMap(20, [4, 4], 120, [
      { time: 5, bpm: 121 },
      { time: 10, bpm: 119 },
    ]);
    expect(map).toHaveLength(1);
    expect(map[0].bpm).toBe(120);
  });

  it('越界/重复变速点被清理', () => {
    const map = buildTempoMap(20, [4, 4], 90, [
      { time: -1, bpm: 100 },
      { time: 25, bpm: 100 },
      { time: 10, bpm: 130 },
      { time: 10, bpm: 140 },
    ]);
    expect(map).toHaveLength(2);
    expect(map[1].bpm).toBe(140);
  });
});

describe('expandGradientToSteps / barStartTime', () => {
  it('渐变段按小节展开线性插值', () => {
    const steps = expandGradientToSteps({ start: 8, end: 12, from: 120, to: 90 }, [4, 4]);
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps[0].bpm).toBeCloseTo(120, 0);
    expect(steps[steps.length - 1].bpm).toBeCloseTo(90, 0);
    // 单调递减
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].bpm).toBeLessThanOrEqual(steps[i - 1].bpm);
    }
  });

  it('barStartTime：变速表下小节起点定位', () => {
    const sections: BeatSection[] = [
      { start: 0, end: 12, bpm: 80, timeSignature: [4, 4] },
      { start: 12, end: 28, bpm: 60, timeSignature: [4, 4] },
    ];
    expect(barStartTime(sections, 0)).toBeCloseTo(0, 5);
    expect(barStartTime(sections, 3)).toBeCloseTo(9, 5);
    expect(barStartTime(sections, 4)).toBeCloseTo(12, 5); // 第 5 小节 = 变速后首小节
    expect(barStartTime(sections, 5)).toBeCloseTo(16, 5);
  });
});

describe('quantizeNotes（1:1 不丢 + 双网格 + 段相位）', () => {
  it('数量 1:1、1/16 网格对齐、最短时值一步', () => {
    const grid = buildBeatGrid(120, 8);
    const out = quantizeNotes([qn(0.37), qn(2.0), qn(4.9, 0.05)], grid, 'strict');
    expect(out).toHaveLength(3);
    expect(out[0].onset).toBeCloseTo(0.375, 6); // 1/16 = 0.125s
    expect(out[1].onset).toBeCloseTo(2, 6);
    // 4.9 距三连音网格更近（tuplet），最短一步 = 1/12 拍 ≈ 0.0833s
    expect(out[2].tuplet).toBe('3');
    expect(out[2].duration).toBeGreaterThanOrEqual(1 / 12 - 1e-6);
  });

  it('三连音点胜出时标 tuplet（§3.1 双网格）', () => {
    const grid = buildBeatGrid(120, 8);
    const out = quantizeNotes([qn(1 / 6)], grid, 'strict'); // 拍的 1/3 = 0.1667s
    expect(out[0].onset).toBeCloseTo(1 / 6, 5);
    expect(out[0].tuplet).toBe('3');
  });

  it('soft 档距网格过远 → 自由节奏原样保留（rubato）', () => {
    const grid = buildBeatGrid(120, 8);
    const out = quantizeNotes([qn(0.19)], grid, 'soft');
    expect(out[0].onset).toBe(0.19); // freeTol = beatSec/32 ≈ 0.0156
    expect(out[0].tuplet).toBeUndefined();
  });

  it('off 档完全不动', () => {
    const out = quantizeNotes([qn(0.37)], buildBeatGrid(120, 8), 'off');
    expect(out[0].onset).toBe(0.37);
  });

  it('变速曲段相位：第二段音符按本段网格原点（=段起点）对齐，而非全局 0 倍数', () => {
    // 段边界 7.3s（非两段公倍数）；段 B @120BPM 的 1/16 网格从 7.3 起算
    const sections: BeatSection[] = [
      { start: 0, end: 7.3, bpm: 80, timeSignature: [4, 4] },
      { start: 7.3, end: 20, bpm: 120, timeSignature: [4, 4] },
    ];
    const grid = buildBeatGridFromSections(sections);
    const out = quantizeNotes([qn(7.55)], grid, 'strict');
    // (7.55-7.3)/0.125 = 2 精确命中段内网格；全局原点算法会错位到 7.5
    expect(out[0].onset).toBeCloseTo(7.55, 6);

    // 与 buildBeatGridFromSections 拍点一致性的交叉验证：段 B 拍点 7.3+0.5k
    const beats = grid.beats.filter((t) => t >= 7.3);
    expect(beats[0]).toBeCloseTo(7.3, 6);
    expect(beats[1]).toBeCloseTo(7.8, 5);
    const snappedBeat = quantizeNotes([qn(7.79)], grid, 'strict');
    expect(snappedBeat[0].onset).toBeCloseTo(7.8, 5);
  });
});
