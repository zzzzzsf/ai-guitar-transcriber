import { describe, expect, it } from 'vitest';
import { annotateChords, normalizeChordName, validateAndNormalize } from './chordAnnotator';
import { LlmError } from './llmClient';
import type { BeatGrid, FrettedNote } from '../profiles/IInstrumentProfile';

const GRID: BeatGrid = { sections: [{ start: 0, end: 8, bpm: 120, timeSignature: [4, 4] }], beats: [] };

function note(onset: number, pitch: number, string: number, fret: number): FrettedNote {
  return { onset, duration: 0.4, pitch, string, fret, velocity: 90 };
}

// E 小调五声音符（40=E2 47=B2 52=E3 55=G3 59=B3 64=E4），第 1 小节 Em、第 2 小节 C（缺 E→用 48/52/55）
const NOTES: FrettedNote[] = [
  note(0, 40, 6, 0), note(0.1, 47, 5, 0), note(0.2, 52, 4, 0), note(0.3, 55, 3, 0), note(0.4, 59, 2, 0),
  note(2, 48, 6, 1), note(2.1, 52, 5, 2), note(2.2, 55, 4, 0), note(2.3, 60, 3, 0),
];

const LLM = { providerId: 'deepseek' as const, baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', apiKey: 'sk-x' };

describe('normalizeChordName', () => {
  it('根音大写与合法后缀原样通过', () => {
    expect(normalizeChordName('Em')).toBe('Em');
    expect(normalizeChordName('Cmaj7')).toBe('Cmaj7');
    expect(normalizeChordName('D/F#')).toBe('D/F#');
    expect(normalizeChordName('f#m')).toBe('F#m');
    expect(normalizeChordName('Bb')).toBe('Bb');
    expect(normalizeChordName('A7')).toBe('A7');
  });
  it('非法根音/超长 → null', () => {
    expect(normalizeChordName('Hm')).toBeNull();
    expect(normalizeChordName('不是和弦')).toBeNull();
    expect(normalizeChordName('E' + '9'.repeat(30))).toBeNull();
  });
});

describe('validateAndNormalize（前置校验）', () => {
  it('越界小节与非法和弦名拒收，同小节保首条，按 bar 排序', () => {
    const raw = [
      { bar: 2, name: 'C' },
      { bar: 0, name: 'Em' },   // 越界
      { bar: 99, name: 'G' },   // 越界
      { bar: 1, name: 'em' },   // 归一化 Em
      { bar: 1, name: 'Am' },   // 同小节重复 → 丢弃（bar=1 已有）
      { bar: 3, name: '???' },  // 非法
    ];
    const gate = validateAndNormalize(raw, 4);
    expect(gate.chords).toEqual([
      { bar: 1, name: 'Em' },
      { bar: 2, name: 'C' },
    ]);
    expect(gate.kept).toBe(2);
    expect(gate.rejected).toBe(4);
  });
});

describe('annotateChords 三条路径', () => {
  it('未连接 → 本地音程推断', async () => {
    const out = await annotateChords({ notes: NOTES, beatGrid: GRID, alphaTex: ':8 0.6 | :8 2.5', barCount: 2 });
    expect(out.source).toBe('local');
    expect(out.chords.length).toBeGreaterThan(0);
    expect(out.chords[0].name).toMatch(/^[A-G]/);
  });

  it('LLM 合法输出 → source llm + 归一化', async () => {
    const chat = async () => ({
      text: '{"chords":[{"bar":1,"name":"em"},{"bar":2,"name":"C/G"}]}',
    });
    const out = await annotateChords({
      notes: NOTES, beatGrid: GRID, alphaTex: ':8 0.6 | :8 2.5', barCount: 2,
      llm: LLM, chat,
    });
    expect(out.source).toBe('llm');
    expect(out.chords).toEqual([
      { bar: 1, name: 'Em' },
      { bar: 2, name: 'C/G' },
    ]);
  });

  it('首轮垃圾输出 → 修复轮救回（chat 调用两次）', async () => {
    let calls = 0;
    const chat = async () => {
      calls += 1;
      return calls === 1
        ? { text: '我认为第一小节是 Em，第二小节可能是 C。' }
        : { text: '{"chords":[{"bar":1,"name":"Em"},{"bar":2,"name":"C"}]}' };
    };
    const out = await annotateChords({
      notes: NOTES, beatGrid: GRID, alphaTex: ':8 0.6 | :8 2.5', barCount: 2,
      llm: LLM, chat,
    });
    expect(calls).toBe(2);
    expect(out.source).toBe('llm');
    expect(out.chords).toHaveLength(2);
  });

  it('拒收率过半 → 整体拒收并降级本地（notice 带原因）', async () => {
    const chat = async () => ({
      text: '{"chords":[{"bar":1,"name":"Em"},{"bar":2,"name":"???"},{"bar":3,"name":"!!!"},{"bar":4,"name":"%%"}]}',
    });
    const out = await annotateChords({
      notes: NOTES, beatGrid: GRID, alphaTex: ':8 0.6 | :8 2.5', barCount: 8,
      llm: LLM, chat,
    });
    expect(out.source).toBe('local-fallback');
    expect(out.notice).toContain('降级');
    expect(out.chords.length).toBeGreaterThan(0);
  });

  it('LLM 网络/鉴权失败 → 降级本地 + notice', async () => {
    const chat = async () => {
      throw new LlmError('auth', 'API Key 无效或无权限（HTTP 401）');
    };
    const out = await annotateChords({
      notes: NOTES, beatGrid: GRID, alphaTex: ':8 0.6 | :8 2.5', barCount: 2,
      llm: LLM, chat,
    });
    expect(out.source).toBe('local-fallback');
    expect(out.notice).toContain('401');
  });

  it('两轮都非法 → 降级本地', async () => {
    const chat = async () => ({ text: '抱歉我不会 JSON。' });
    const out = await annotateChords({
      notes: NOTES, beatGrid: GRID, alphaTex: ':8 0.6 | :8 2.5', barCount: 2,
      llm: LLM, chat,
    });
    expect(out.source).toBe('local-fallback');
  });
});
