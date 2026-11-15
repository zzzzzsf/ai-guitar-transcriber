import { describe, expect, it, vi } from 'vitest';
import * as alphaTab from '@coderline/alphatab';
import { localShiftDown, rewriteAlphaTex } from './aiRewrite';
import type { FrettedNote } from '../profiles/IInstrumentProfile';
import { LlmError } from './llmClient';

const STANDARD = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4（低音弦在前）
const LLM = { providerId: 'deepseek' as const, baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', apiKey: 'sk-x' };
const TEX = '\\tempo 120 :8 0.6 | :8 2.5 | :4 3.2';

function fn(onset: number, pitch: number, string: number, fret: number): FrettedNote {
  return { onset, duration: 0.25, pitch, string, fret, velocity: 90 };
}

describe('localShiftDown（本地降把位规则，§1.3 降级）', () => {
  it('高品同音下移到低品（A4：2 弦 10 品 → 1 弦 5 品）', () => {
    const out = localShiftDown([fn(0, 69, 2, 10)], STANDARD);
    expect(out[0]).toMatchObject({ string: 1, fret: 5, pitch: 69 });
  });

  it('已在最低品（空弦）不动', () => {
    const out = localShiftDown([fn(0, 64, 1, 0)], STANDARD);
    expect(out[0]).toMatchObject({ string: 1, fret: 0 });
  });

  it('指板顶端无更低候选保持原位', () => {
    const out = localShiftDown([fn(0, 88, 1, 24)], STANDARD);
    expect(out[0]).toMatchObject({ string: 1, fret: 24 });
  });

  it('簇内同弦互斥：先挪高品音占住低品空位，次音让位', () => {
    // 69(2弦10品) 与 64(2弦5品) 同簇：69 → 1弦5品；64 的 1 弦空品被占 → 保持原位
    const out = localShiftDown([fn(0, 69, 2, 10), fn(0.01, 64, 2, 5)], STANDARD);
    const a4 = out.find((n) => n.pitch === 69)!;
    const e4 = out.find((n) => n.pitch === 64)!;
    expect(a4).toMatchObject({ string: 1, fret: 5 });
    expect(e4).toMatchObject({ string: 2, fret: 5 });
  });

  it('不同簇互不占位', () => {
    const out = localShiftDown([fn(0, 69, 2, 10), fn(0.5, 69, 2, 10)], STANDARD);
    expect(out.every((n) => n.string === 1 && n.fret === 5)).toBe(true);
  });

  it('Capo=3 的 G4 保持实际音高，3 弦 12 品移到 1 弦 3 品', () => {
    const original = fn(0, 70, 3, 12);
    const [note] = localShiftDown([original], STANDARD, 3);
    expect(note).toMatchObject({ string: 1, fret: 3, pitch: 70 });
    expect(STANDARD[STANDARD.length - note.string] + 3 + note.fret).toBe(70);
    expect(original).toMatchObject({ string: 3, fret: 12 });
  });

  it('预留空弦音的唯一位置，避免移动音与兜底原位争用 1 弦', () => {
    const notes = [fn(0, 64, 3, 9), fn(0, 64, 1, 0)];
    const out = localShiftDown(notes, STANDARD);
    expect(out).toEqual([expect.objectContaining({ string: 2, fret: 5 }), expect.objectContaining({ string: 1, fret: 0 })]);
    expect(new Set(out.map((n) => n.string)).size).toBe(2);
    expect(out.map((n) => STANDARD[STANDARD.length - n.string] + n.fret)).toEqual([64, 64]);
  });

  it('无无冲突解或音高上下文不一致时明确失败，不能伪造位置', () => {
    expect(() => localShiftDown([fn(0, 64, 1, 0), fn(0, 64, 1, 0)])).toThrow('同弦冲突');
    expect(() => localShiftDown([fn(0, 70, 3, 12)], STANDARD, 0)).toThrow('不一致');
  });
});

describe('rewriteAlphaTex（AI 改谱编排）', () => {
  it('LLM 成功：剥围栏与解释行 → source llm + diff 统计', async () => {
    const before = '\\tempo 120 :8 10.2 | :8 12.3 | :4 9.3';
    const after = '\\tempo 120 :8 5.1 | :8 3.1 | :4 0.1';
    const chat = async () => ({
      text: `好的，改编如下：\n\`\`\`${after}\n\`\`\`\n祝练习愉快！`,
    });
    const out = await rewriteAlphaTex({ alphaTex: before, instruction: '降到前 5 品', llm: LLM, chat });
    expect(out.source).toBe('llm');
    expect(out.alphaTex).toBe(after);
    expect(out.review?.diff.changedBars).toEqual([1, 2, 3]);
    expect(out.review?.stats.tempoAfter).toEqual([120]);
  });

  it('首轮删 \\tempo 被拒 → 修复轮救回（chat 两次）', async () => {
    let calls = 0;
    const chat = async () => {
      calls += 1;
      return calls === 1
        ? { text: ':8 0.6 | :8 3.5 | :4 5.2' } // 丢了 \tempo
        : { text: '\\tempo 120 :8 0.6 | :8 3.5 | :4 5.2' };
    };
    const out = await rewriteAlphaTex({ alphaTex: TEX, instruction: '简化', llm: LLM, chat });
    expect(calls).toBe(2);
    expect(out.source).toBe('llm');
  });

  it('两轮都不合格 → 降级本地降把位（notes 经 localShiftDown 后重新出谱）', async () => {
    const chat = async () => ({ text: '抱歉我改不了这个。' });
    const retexArgs: FrettedNote[][] = [];
    const out = await rewriteAlphaTex({
      alphaTex: '\\tempo 120 :8 10.2',
      instruction: '降把位',
      notes: [fn(0, 69, 2, 10)],
      tuning: STANDARD,
      llm: LLM,
      chat,
      retex: (notes) => {
        retexArgs.push(notes);
        return '\\tempo 120 :8 5.1';
      },
    });
    expect(out.source).toBe('local-fallback');
    expect(out.notice).toContain('降把位');
    // retex 收到的是降把位后的音符（A4 已到 1 弦 5 品）
    expect(retexArgs[0][0]).toMatchObject({ string: 1, fret: 5 });
    expect(out.alphaTex).toBe('\\tempo 120 :8 5.1');
  });

  it('未连接 LLM → 直接本地降级；无 notes 时返回原文 + notice', async () => {
    const out = await rewriteAlphaTex({ alphaTex: TEX, instruction: '降把位' });
    expect(out.source).toBe('local-fallback');
    expect(out.alphaTex).toBe(TEX);
    expect(out.notice).toContain('未连接');
  });

  it.each([
    '把这段高把位 Solo 改写到前 5 品内',
    '请改到前五品',
    '换把位',
    'lower fret position',
    'revoice within the first five frets',
    '处理一下这个谱',
    '降把位，不要简化节奏',
  ])('指令「%s」保护音高并拒绝可解析的错音', async (instruction) => {
    const before = '\\tempo 80 . :4 10.2';
    const chat = vi.fn(async () => ({ text: '\\tempo 80 . :4 6.1' }));
    const out = await rewriteAlphaTex({ alphaTex: before, instruction, llm: LLM, chat });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(out.alphaTex).toBe(before);
    expect(out.notice).toContain('未应用改编');
    expect(out.notice).toContain('实际音高');
  });

  it.each(['把这段高把位 Solo 改写到前 5 品内', '请改到前五品', '换把位', 'revoice within the first five frets'])(
    '「%s」允许语义一致的真实降把位', async (instruction) => {
      const out = await rewriteAlphaTex({ alphaTex: '\\tempo 80 . :4 10.2', instruction, llm: LLM,
        chat: async () => ({ text: '\\tempo 80 . :4 5.1' }) });
      expect(out.source).toBe('llm');
      expect(out.alphaTex).toBe('\\tempo 80 . :4 5.1');
    },
  );

  it('简化明确允许删音；显式 reposition 策略仍保护原音符', async () => {
    const before = '\\tempo 80 . :4 (10.2 0.6) | :4 12.3';
    const after = '\\tempo 80 . :4 10.2 | :4 r';
    const chat = async () => ({ text: after });
    const simplified = await rewriteAlphaTex({ alphaTex: before, instruction: '简化分解和弦，删除一些音符', llm: LLM, chat });
    expect(simplified.source).toBe('llm');
    expect(simplified.alphaTex).toBe(after);
    const strict = await rewriteAlphaTex({ alphaTex: before, instruction: '简化', editPolicy: 'reposition', llm: LLM, chat });
    expect(strict.alphaTex).toBe(before);
  });

  it('未提供保留上下文的 retex 时逐字保留原谱的 BPM、调号、变速及注释', async () => {
    const before = '\\title "保留原谱"\n\\tempo 80 . \\ks eminor :4 10.2 | \\tempo 90 :4 r';
    const out = await rewriteAlphaTex({ alphaTex: before, instruction: '降把位', notes: [fn(0, 69, 2, 10)] });
    expect(out.alphaTex).toBe(before);
    expect(out.notice).toContain('出谱上下文');
    expect(out.notice).toContain('未应用改编');
  });

  it('安全本地出谱保留 Capo、调号、BPM 和原位变速，alphaTab 回读音高与拍点一致', async () => {
    const before = '\\tempo 80 \\capo 3 . \\ks eminor :4 12.3 | \\tempo 90 :4 r';
    const after = '\\tempo 80 \\capo 3 . \\ks eminor :4 3.1 | \\tempo 90 :4 r';
    const retex = vi.fn((_notes: FrettedNote[]) => after);
    const out = await rewriteAlphaTex({
      alphaTex: before, instruction: '降把位', notes: [fn(0, 70, 3, 12)], tuning: STANDARD, capo: 3, retex,
    });
    expect(retex.mock.calls[0][0][0]).toMatchObject({ string: 1, fret: 3, pitch: 70 });
    expect(out.alphaTex).toBe(after);
    expect(out.review?.verdict).toBe('accept');
    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.initFromString(out.alphaTex, new alphaTab.Settings());
    const score = importer.readScore();
    const staff = score.tracks[0].staves[0];
    expect(score.tempo).toBe(80);
    expect(staff.capo).toBe(3);
    expect(staff.bars[0].keySignatureType).toBe(alphaTab.model.KeySignatureType.Minor);
    expect(staff.bars[0].voices[0].beats[0].notes[0].realValue).toBe(70);
    expect(score.masterBars[1].tempoAutomations[0].value).toBe(90);
    expect(score.masterBars[1].tempoAutomations[0].ratioPosition).toBe(0);
  });

  it.each([
    '\\tempo 120 . \\ks eminor :4 5.1 | \\tempo 90 :4 r',
    '\\tempo 80 . \\ks cmajor :4 5.1 | \\tempo 90 :4 r',
    '\\tempo 80 . \\ks eminor :4 5.1',
    '\\tempo 80 . \\ks eminor :4 5.1 | :4 r',
    '\\tempo 80 . :q 5.1',
  ])('拒绝不安全本地出谱并保持原文：%s', async (bad) => {
    const before = '\\tempo 80 . \\ks eminor :4 10.2 | \\tempo 90 :4 r';
    const out = await rewriteAlphaTex({ alphaTex: before, instruction: '降把位', notes: [fn(0, 69, 2, 10)], retex: () => bad });
    expect(out.alphaTex).toBe(before);
    expect(out.notice).toContain('未通过语义保护');
  });

  it.each(['清洗错音', '简化分解和弦', '加上文字标注', '不要降把位', '降把位并加入重音', '降把位加歌词'])('本地不支持「%s」：不调用出谱、不冒称降把位', async (instruction) => {
    const retex = vi.fn(() => TEX);
    const out = await rewriteAlphaTex({ alphaTex: TEX, instruction, notes: [fn(0, 69, 2, 10)], retex });
    expect(out.alphaTex).toBe(TEX);
    expect(retex).not.toHaveBeenCalled();
    expect(out.notice).toContain('不支持此指令');
    expect(out.notice).not.toContain('已按本地规则执行');
  });

  it('网络失败也不能把错音清洗替换为降把位', async () => {
    const retex = vi.fn(() => TEX);
    const out = await rewriteAlphaTex({ alphaTex: TEX, instruction: '清洗错音', llm: LLM,
      notes: [fn(0, 69, 2, 10)], retex, chat: async () => { throw new LlmError('network', 'offline'); } });
    expect(out.alphaTex).toBe(TEX);
    expect(out.notice).toContain('offline');
    expect(out.notice).toContain('不支持此指令');
    expect(retex).not.toHaveBeenCalled();
  });

  it('本地出谱异常清楚返回原因并保留原谱', async () => {
    const out = await rewriteAlphaTex({ alphaTex: '\\tempo 80 . :4 10.2', instruction: '降把位',
      notes: [fn(0, 69, 2, 10)], retex: () => { throw new Error('export failed'); } });
    expect(out.alphaTex).toBe('\\tempo 80 . :4 10.2');
    expect(out.notice).toContain('export failed');
  });

  it('取消不能被当成网络失败后继续执行本地改编', async () => {
    const retex = vi.fn(() => TEX);
    await expect(rewriteAlphaTex({ alphaTex: TEX, instruction: '降把位', llm: LLM,
      notes: [fn(0, 69, 2, 10)], retex, chat: async () => { throw new LlmError('aborted', 'cancelled'); } }))
      .rejects.toMatchObject({ kind: 'aborted' });
    expect(retex).not.toHaveBeenCalled();
  });
});
