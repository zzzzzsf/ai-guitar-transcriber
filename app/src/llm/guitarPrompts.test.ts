import { describe, expect, it } from 'vitest';
import { buildSplitUserPrompt, PROMPT_TEX_LIMIT } from './guitarPrompts';

describe('完整拆轨输入', () => {
  it('小节计数不要求末尾分隔符，忽略空白尾段', () => {
    for (const tex of ['\\tempo 120 . :4 3.2 | :4 0.1', '\\tempo 120 . :4 3.2 | :4 0.1 | ']) {
      expect(buildSplitUserPrompt(tex)).toContain('2 小节');
      expect(buildSplitUserPrompt(tex)).toContain(tex);
    }
  });

  it('超长谱面仍完整提供给要求完整双轨输出的模型', () => {
    const tex = '\\tempo 80 . ' + ':4 3.2 | '.repeat(Math.ceil(PROMPT_TEX_LIMIT / 8)) + '\\tempo 60 :4 7.1';
    expect(tex.length).toBeGreaterThan(PROMPT_TEX_LIMIT);
    expect(buildSplitUserPrompt(tex)).toContain(tex);
  });

  it('多声部共享两小节，不把声部各自的竖线重复计入小节数', () => {
    const tex = '\\tempo 120 . \\voice :1 0.6 | :1 r \\voice :1 0.1 | :1 r';
    expect(buildSplitUserPrompt(tex)).toContain('2 小节');
  });
});
