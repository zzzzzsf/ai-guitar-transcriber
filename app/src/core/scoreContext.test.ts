import { describe, expect, it } from 'vitest';
import { readGuitarScore } from './scoreContext';
import { toAlphaTex, STANDARD_TUNING } from '../profiles/GuitarProfile';
import { buildBeatGrid } from './quantizer';
import { BALANCED_WEIGHTS } from '../profiles/costWeights';

describe('采纳谱面的后续操作上下文', () => {
  it('实际音高计入 Capo，同时发声音符不被转换为顺序音', () => {
    const result = readGuitarScore('\\tempo 80 \\capo 3 . :4 (12.3 0.6) :4 3.1');
    expect(result.capo).toBe(3);
    expect(result.tuning).toEqual([40, 45, 50, 55, 59, 64]);
    expect(result.notes.map(({ onset, duration, pitch }) => ({ onset, duration, pitch }))).toEqual([
      { onset: 0, duration: 0.75, pitch: 70 },
      { onset: 0, duration: 0.75, pitch: 43 },
      { onset: 0.75, duration: 0.75, pitch: 70 },
    ]);
  });

  it('跨变速段延音恢复为一个原始音符，保留起点和完整秒数', () => {
    const result = readGuitarScore('\\tempo 120 . :2 r :4 r :4 0.1 | \\tempo 60 :2 -.1 :2 r');
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatchObject({ onset: 1.5, duration: 2.5, pitch: 64, string: 1, fret: 0 });
  });

  it('改谱后弦品和删音变化来自新谱，不保留旧数据', () => {
    const before = readGuitarScore('\\tempo 120 . :4 (10.2 0.6)');
    const after = readGuitarScore('\\tempo 120 . :4 5.1');
    expect(before.notes).toHaveLength(2);
    expect(after.notes).toHaveLength(1);
    expect(after.notes[0]).toMatchObject({ string: 1, fret: 5, pitch: 69 });
  });

  it('导出与采纳回读保留跨小节低音和独立旋律的起点、截止与弦品', () => {
    const notes = [
      { string: 6, fret: 0, pitch: 40, onset: 0, duration: 3 },
      { string: 1, fret: 0, pitch: 64, onset: 0.5, duration: 0.25 },
      { string: 2, fret: 1, pitch: 60, onset: 1, duration: 0.5 },
    ];
    const tex = toAlphaTex(notes, {
      config: { tuning: STANDARD_TUNING }, style: 'balanced', weights: BALANCED_WEIGHTS,
      beatGrid: buildBeatGrid(120, 4),
    });
    const parsed = readGuitarScore(tex);
    expect(parsed.notes.map(({ string, fret, pitch, onset, duration }) => ({ string, fret, pitch, onset, duration })))
      .toEqual(notes);
  });
});
