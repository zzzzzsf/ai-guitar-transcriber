import { describe, expect, it } from 'vitest';
import {
  findCutPoints,
  mergeChunkNotes,
  noteEventsToRawNotes,
  planChunks,
} from './pitchTranscriber';
import type { NoteEventTime } from '@spotify/basic-pitch';
import type { RawNote } from '../profiles/IInstrumentProfile';

/** NoteEventTime → RawNote 映射（pitchTranscriber 的纯转换层） */
describe('noteEventsToRawNotes', () => {
  it('映射 onset/duration/pitch/amplitude→velocity', () => {
    const events: NoteEventTime[] = [
      {
        startTimeSeconds: 1.25,
        durationSeconds: 0.5,
        pitchMidi: 64,
        amplitude: 0.8,
      },
    ];
    const notes = noteEventsToRawNotes(events);
    expect(notes).toHaveLength(1);
    expect(notes[0].onset).toBe(1.25);
    expect(notes[0].duration).toBe(0.5);
    expect(notes[0].pitch).toBe(64);
    expect(notes[0].velocity).toBe(Math.round(0.8 * 127));
    expect(notes[0].pitchBend).toEqual([]);
  });

  it('velocity clamp 到 1~127（amplitude 越界防护）', () => {
    const notes = noteEventsToRawNotes([
      { startTimeSeconds: 0, durationSeconds: 0.1, pitchMidi: 40, amplitude: 2.5 },
      { startTimeSeconds: 0, durationSeconds: 0.1, pitchMidi: 40, amplitude: 0 },
    ]);
    expect(notes[0].velocity).toBe(127);
    expect(notes[1].velocity).toBe(1);
  });

  it('pitchBends 按包内语义展开：第 i 点 time = start + i*duration/len，cents 原样透传', () => {
    const notes = noteEventsToRawNotes([
      {
        startTimeSeconds: 2,
        durationSeconds: 1,
        pitchMidi: 60,
        amplitude: 0.5,
        pitchBends: [-100, 0, 100],
      },
    ]);
    expect(notes[0].pitchBend).toEqual([
      { time: 2, cents: -100 },
      { time: 2 + 1 / 3, cents: 0 },
      { time: 2 + 2 / 3, cents: 100 },
    ]);
  });

  it('保持事件顺序与空数组输入', () => {
    expect(noteEventsToRawNotes([])).toEqual([]);
    const two: NoteEventTime[] = [
      { startTimeSeconds: 0, durationSeconds: 0.2, pitchMidi: 45, amplitude: 0.3 },
      { startTimeSeconds: 0.2, durationSeconds: 0.2, pitchMidi: 52, amplitude: 0.6 },
    ];
    const notes = noteEventsToRawNotes(two);
    expect(notes.map((n) => n.pitch)).toEqual([45, 52]);
    expect(notes[1].onset).toBe(0.2);
  });
});

/** RawNote 快捷构造 */
function rn(onset: number, pitch: number): RawNote {
  return { onset, duration: 0.3, pitch, velocity: 100, pitchBend: [] };
}

describe('长曲分段（§3.2：静音切点 + 重叠兜底 + 后处理全局）', () => {
  it('findCutPoints 优先切在静音区（理想切点 ± 搜索窗内找最低能量）', () => {
    // 100s @1kHz：恒定 0.5 幅度，50.0~53.0s 静音
    const s = new Float32Array(100000).fill(0.5);
    s.fill(0, 50000, 53000);
    const cuts = findCutPoints(s, 1000);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].silent).toBe(true);
    expect(cuts[0].time).toBeGreaterThanOrEqual(49.9);
    expect(cuts[0].time).toBeLessThanOrEqual(53);
  });

  it('findCutPoints 无静音区 → 固定切点兜底（不在噪声最小处乱切）', () => {
    const s = new Float32Array(100000).fill(0.5);
    const cuts = findCutPoints(s, 1000);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].silent).toBe(false);
    expect(cuts[0].time).toBeCloseTo(50, 0); // 理想位置 = 100/2
  });

  it('planChunks：静音切点无重叠；固定切点加 3s 重叠', () => {
    expect(planChunks(100, [{ time: 50, silent: true }])).toEqual([
      { start: 0, end: 50, overlapWithPrev: 0 },
      { start: 50, end: 100, overlapWithPrev: 0 },
    ]);
    expect(planChunks(100, [{ time: 50, silent: false }])).toEqual([
      { start: 0, end: 50, overlapWithPrev: 0 },
      { start: 47, end: 100, overlapWithPrev: 3 },
    ]);
  });

  it('mergeChunkNotes：重叠区同音高去重（保留后段完整版本），异音高保留', () => {
    const plan = [
      { start: 0, end: 50, overlapWithPrev: 0 },
      { start: 47, end: 100, overlapWithPrev: 3 },
    ];
    const chunks = [
      [rn(48.4, 60), rn(30, 70)],
      [rn(1.6, 60), rn(1.0, 62), rn(5, 61)], // 相对段起点；重叠区 = [0, 3)
    ];
    const merged = mergeChunkNotes(chunks, plan);
    const at = (t: number) => merged.find((n) => Math.abs(n.onset - t) < 0.01);
    // 同音高 60：48.4 与 48.6 视为同一音，保留后段版本（上下文完整）
    expect(at(48.6)?.pitch).toBe(60);
    expect(at(48.4)).toBeUndefined();
    // 重叠区无对应者的 62 保留（保召回）；Exclusive 区 61 保留；段内其他音符原样保留
    expect(at(48)?.pitch).toBe(62);
    expect(at(52)?.pitch).toBe(61);
    expect(at(30)?.pitch).toBe(70);
    expect(merged).toHaveLength(4);
  });

  it('mergeChunkNotes：静音切点（无重叠）直接顺序拼接', () => {
    const plan = [
      { start: 0, end: 50, overlapWithPrev: 0 },
      { start: 50, end: 100, overlapWithPrev: 0 },
    ];
    const merged = mergeChunkNotes([[rn(49, 60)], [rn(0.5, 62)]], plan);
    expect(merged.map((n) => [n.onset, n.pitch])).toEqual([
      [49, 60],
      [50.5, 62],
    ]);
  });

  it('mergeChunkNotes：重叠区同音高快速重复音一对一配对（间隔 0.15s 不被误并成一个）', () => {
    const plan = [
      { start: 0, end: 50, overlapWithPrev: 0 },
      { start: 47, end: 100, overlapWithPrev: 3 },
    ];
    const a1 = { ...rn(48.0, 60), duration: 0.15 };
    const a2 = { ...rn(48.15, 60), duration: 0.15 };
    const a1b = { ...rn(1.0, 60), duration: 0.2 }; // 后段版本（全局 48.0）
    const a2b = { ...rn(1.15, 60), duration: 0.2 }; // 后段版本（全局 48.15）
    const merged = mergeChunkNotes([[a1, a2, rn(30, 70)]], plan).length; // 先确认前段
    expect(merged).toBe(3);

    const out = mergeChunkNotes([[a1, a2, rn(30, 70)], [a1b, a2b, rn(5, 61)]], plan);
    const rapid = out.filter((n) => n.pitch === 60);
    // 两个重复音各自保留后段版本；旧实现会把 A1 版本错配吞掉只剩 1 个
    expect(rapid).toHaveLength(2);
    expect(rapid.every((n) => n.duration === 0.2)).toBe(true);
    expect(rapid.map((n) => n.onset)).toEqual([48.0, 48.15]);
  });
});
