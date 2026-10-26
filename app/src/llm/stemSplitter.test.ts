import { describe, expect, it } from 'vitest';
import { splitGuitars } from './stemSplitter';
import { LlmError } from './llmClient';

const LLM = { providerId: 'kimi' as const, baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3', apiKey: 'sk-x' };
/** 2 小节原谱（两轨拆分后小节数必须一致） */
const TEX = '\\tempo 120 :8 0.6 | :8 2.5';
const GOOD_LEAD = '\\tempo 120 :8 0.6 | :8 0.6';
const GOOD_RHYTHM = '\\tempo 120 :8 2.5 | :8 2.5';

describe('splitGuitars（双吉他拆轨，无本地降级）', () => {
  it('成功拆分：两轨可解析、\\tempo 保留、小节数一致', async () => {
    const chat = async () => ({
      text: JSON.stringify({ lead: GOOD_LEAD, rhythm: GOOD_RHYTHM }),
    });
    const out = await splitGuitars({ alphaTex: TEX, llm: LLM, chat });
    expect(out.lead).toBe(GOOD_LEAD);
    expect(out.rhythm).toBe(GOOD_RHYTHM);
    expect(out.reviews.lead.verdict).toBe('accept');
    expect(out.reviews.rhythm.verdict).toBe('accept');
  });

  it('坏 JSON → 修复轮救回（chat 两次）', async () => {
    let calls = 0;
    const chat = async () => {
      calls += 1;
      return calls === 1
        ? { text: '我觉得 Lead 是高音部分，Rhythm 是伴奏…' }
        : { text: JSON.stringify({ lead: GOOD_LEAD, rhythm: GOOD_RHYTHM }) };
    };
    const out = await splitGuitars({ alphaTex: TEX, llm: LLM, chat });
    expect(calls).toBe(2);
    expect(out.lead).toBe(GOOD_LEAD);
  });

  it('Lead 轨删 \\tempo 两轮 → 抛 LlmError（不做本地降级）', async () => {
    const chat = async () => ({
      text: JSON.stringify({ lead: ':8 0.6 | :8 0.6', rhythm: GOOD_RHYTHM }),
    });
    await expect(splitGuitars({ alphaTex: TEX, llm: LLM, chat })).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'parse',
    });
  });

  it('小节数不一致两轮 → 抛 LlmError（播放同步硬约束）', async () => {
    const chat = async () => ({
      text: JSON.stringify({ lead: '\\tempo 120 :8 0.6', rhythm: GOOD_RHYTHM }), // 1 小节 vs 2 小节
    });
    await expect(splitGuitars({ alphaTex: TEX, llm: LLM, chat })).rejects.toBeInstanceOf(LlmError);
  });

  it('未连接 → 直接抛 badRequest（UI 据此禁用按钮）', async () => {
    await expect(splitGuitars({ alphaTex: TEX })).rejects.toMatchObject({ kind: 'badRequest' });
  });
});
