import { describe, expect, it } from 'vitest';
import { detectChords } from './chordDetector';
import { buildBeatGrid } from './quantizer';
import type { FrettedNote } from '../profiles/IInstrumentProfile';

/** 第 stringNo 弦（1=高音 E）第 fret 品 → FrettedNote */
function fn(bar: number, t: number, stringNo: number, fret: number, bpm = 80): FrettedNote {
  const tunings = [64, 59, 55, 50, 45, 40]; // 弦 1→6 空弦 MIDI
  const barSec = 4 * (60 / bpm);
  return {
    string: stringNo,
    fret,
    onset: Number((bar * barSec + t * (60 / bpm)).toFixed(6)),
    duration: 0.3,
    pitch: tunings[stringNo - 1] + fret,
  };
}

describe('detectChords（本地和弦标注降级）', () => {
  it('Em → C → G → D 和弦进行正确识别', () => {
    const grid = buildBeatGrid(80, 12);
    const notes: FrettedNote[] = [
      // 小节 0：Em 分解 E2 B2 E3 G3 B3 E4
      fn(0, 0, 6, 0), fn(0, 0.5, 5, 2), fn(0, 1, 4, 2), fn(0, 1.5, 3, 0),
      fn(0, 2, 2, 0), fn(0, 2.5, 1, 0), fn(0, 3, 2, 0), fn(0, 3.5, 3, 0),
      // 小节 1：C
      fn(1, 0, 5, 3), fn(1, 0.5, 4, 2), fn(1, 1, 3, 0), fn(1, 1.5, 2, 1),
      fn(1, 2, 1, 0), fn(1, 2.5, 2, 1), fn(1, 3, 3, 0), fn(1, 3.5, 4, 2),
      // 小节 2：G
      fn(2, 0, 6, 3), fn(2, 0.5, 5, 2), fn(2, 1, 4, 0), fn(2, 1.5, 3, 0),
      fn(2, 2, 2, 0), fn(2, 2.5, 2, 3), fn(2, 3, 2, 0), fn(2, 3.5, 3, 0),
      // 小节 3：D
      fn(3, 0, 4, 0), fn(3, 0.5, 4, 4), fn(3, 1, 3, 2), fn(3, 1.5, 2, 3),
      fn(3, 2, 1, 2), fn(3, 2.5, 2, 3), fn(3, 3, 3, 2), fn(3, 3.5, 4, 4),
    ];
    const labels = detectChords(notes, grid);
    expect(labels.map((l) => l.name)).toEqual(['Em', 'C', 'G', 'D']);
    expect(labels.map((l) => l.bar)).toEqual([0, 1, 2, 3]);
  });

  it('Em7 开放把位扫弦（E G B D + 外音 A）判为 Em7（低音加分）', () => {
    const grid = buildBeatGrid(80, 3);
    const notes: FrettedNote[] = [
      fn(0, 0, 6, 0), fn(0, 0.01, 5, 2), fn(0, 0.02, 4, 0),
      fn(0, 0.03, 3, 0), fn(0, 0.04, 2, 0), fn(0, 0.05, 1, 0),
    ];
    const labels = detectChords(notes, grid);
    expect(labels[0].name).toBe('Em7');
  });

  it('转位和弦标注低音（D/F#）', () => {
    const grid = buildBeatGrid(80, 3);
    // F# 低音 + D A D → D 大三第二转位
    const notes: FrettedNote[] = [fn(0, 0, 4, 4), fn(0, 1, 3, 2), fn(0, 2, 2, 3)];
    const labels = detectChords(notes, grid);
    expect(labels[0].name).toBe('D/F#');
  });

  it('单音小节只给根音名', () => {
    const grid = buildBeatGrid(80, 3);
    const labels = detectChords([fn(0, 0, 6, 0)], grid);
    expect(labels[0].name).toBe('E');
  });

  it('无音符返回空数组', () => {
    expect(detectChords([], buildBeatGrid(80, 3))).toEqual([]);
  });

  it('变速曲（§3.5 多段）：第二段按自己的 BPM 计小节边界', () => {
    const grid = {
      sections: [
        { start: 0, end: 8, bpm: 120, timeSignature: [4, 4] as [number, number] },
        { start: 8, end: 20, bpm: 60, timeSignature: [4, 4] as [number, number] },
      ],
      beats: [],
    };
    const notes: FrettedNote[] = [
      // 段 A 第 1 小节（t=0）：E 小三（E G B）
      { string: 6, fret: 0, onset: 0, duration: 0.3, pitch: 40 },
      { string: 5, fret: 2, onset: 0.1, duration: 0.3, pitch: 47 },
      { string: 4, fret: 2, onset: 0.2, duration: 0.3, pitch: 52 },
      { string: 3, fret: 0, onset: 0.3, duration: 0.3, pitch: 55 },
      // 段 B 第 1 小节（t=8，全局第 4 小节起）：C 大三
      { string: 5, fret: 3, onset: 8, duration: 0.3, pitch: 48 },
      { string: 4, fret: 2, onset: 8.1, duration: 0.3, pitch: 52 },
      { string: 3, fret: 0, onset: 8.2, duration: 0.3, pitch: 55 },
      // 段 B 第 2 小节（t=12，60BPM 小节长 4s）：G 大三
      { string: 6, fret: 3, onset: 12, duration: 0.3, pitch: 43 },
      { string: 4, fret: 0, onset: 12.1, duration: 0.3, pitch: 50 },
      { string: 3, fret: 0, onset: 12.2, duration: 0.3, pitch: 55 },
    ];
    const labels = detectChords(notes, grid);
    // 段 A 4 小节 → 段 B 从小节 4 起；旧逻辑全曲按 120BPM 算会把 t=12 落进小节 6
    expect(labels.map((l) => l.bar)).toEqual([0, 4, 5]);
    expect(labels.map((l) => l.name)).toEqual(['Em', 'C', 'G']);
  });
});
