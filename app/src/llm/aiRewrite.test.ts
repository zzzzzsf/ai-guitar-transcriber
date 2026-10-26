import { describe, expect, it } from 'vitest';
import { localShiftDown, rewriteAlphaTex } from './aiRewrite';
import type { FrettedNote } from '../profiles/IInstrumentProfile';

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
});

describe('rewriteAlphaTex（AI 改谱编排）', () => {
  it('LLM 成功：剥围栏与解释行 → source llm + diff 统计', async () => {
    const chat = async () => ({
      text: '好的，改编如下：\n```\\tempo 120 :8 0.6 | :8 3.5 | :4 5.2\n```\n祝练习愉快！',
    });
    const out = await rewriteAlphaTex({ alphaTex: TEX, instruction: '降到前 5 品', llm: LLM, chat });
    expect(out.source).toBe('llm');
    expect(out.alphaTex).toBe('\\tempo 120 :8 0.6 | :8 3.5 | :4 5.2');
    expect(out.review?.diff.changedBars).toEqual([2, 3]);
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
      alphaTex: TEX,
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
});
