import { describe, expect, it } from 'vitest';
import * as alphaTab from '@coderline/alphatab';
import {
  checkAlphaTexParses,
  diffBars,
  extractAlphaTex,
  extractKeySignatures,
  extractTempoMarkers,
  reviewTexEdit,
} from './texGuard';

// alphaTab 1.8.4 实测：数字时值（:4 :8）可解析，字母时值（:q :w）不支持
const GOOD_TEX = '\\tempo 120 :8 0.6 | :8 2.5 | :4 3.2';
const GOOD_TEX_NO_TEMPO = ':8 0.6 | :8 2.5 | :4 3.2';

describe('checkAlphaTexParses（与渲染器同源校验）', () => {
  it('合法谱面通过', () => {
    expect(checkAlphaTexParses(GOOD_TEX)).toEqual({ ok: true });
  });
  it('语法破坏即拒收', () => {
    expect(checkAlphaTexParses('\\tempo 120 :8 0.6 | :8 {').ok).toBe(false);
  });
  it('字母时值 :q 在 1.8.4 不可解析（导出器只发数字时值）', () => {
    expect(checkAlphaTexParses(':q 0.6').ok).toBe(false);
  });
  it('空文本拒收', () => {
    expect(checkAlphaTexParses('   ').ok).toBe(false);
  });
});

describe('标记提取', () => {
  it('\\tempo 序列保序提取', () => {
    expect(extractTempoMarkers('\\tempo 96 | :8 0.6 | \\tempo 132 :8 2.5')).toEqual([96, 132]);
  });
  it('\\ks 调号提取', () => {
    expect(extractKeySignatures('\\ks Em | :8 0.6 | \\ks Dmajor :8 2.5')).toEqual(['Em', 'Dmajor']);
  });
});

describe('diffBars', () => {
  it('识别改动/新增/删除小节', () => {
    const before = ':8 0.6 | :8 2.5 | :q 3.2';
    const after = ':8 0.6 | :8 3.5 | :q 3.2 | :8 5.3';
    expect(diffBars(before, after)).toEqual({ changedBars: [2], addedBars: 1, removedBars: 0 });
    expect(diffBars(before, ':8 0.6 | :8 2.5')).toEqual({ changedBars: [], addedBars: 0, removedBars: 1 });
  });
});

describe('reviewTexEdit（AI 改谱前置关卡）', () => {
  it('合法改编 → accept，统计正确', () => {
    const after = '\\tempo 120 :8 0.6 | :8 3.5 | :4 5.2';
    const review = reviewTexEdit(GOOD_TEX, after);
    expect(review.verdict).toBe('accept');
    expect(review.issues).toEqual([]);
    expect(review.stats.tempoBefore).toEqual([120]);
    expect(review.stats.tempoAfter).toEqual([120]);
    expect(review.diff.changedBars).toEqual([2, 3]);
  });

  it('\\tempo 被删 → reject（§3.5 BYOK 硬约束）', () => {
    const review = reviewTexEdit(GOOD_TEX, GOOD_TEX_NO_TEMPO);
    expect(review.verdict).toBe('reject');
    expect(review.issues.some((i) => i.includes('\\tempo'))).toBe(true);
  });

  it('\\tempo 保留但新增允许（子序列语义）', () => {
    const review = reviewTexEdit(GOOD_TEX, '\\tempo 120 :8 0.6 | \\tempo 140 :8 2.5 | :4 3.2');
    expect(review.verdict).toBe('accept');
    expect(review.stats.tempoAfter).toEqual([120, 140]);
  });

  it('语法破坏 → reject 且带解析错误', () => {
    const review = reviewTexEdit(GOOD_TEX, '\\tempo 120 :8 0.6 | :8 {');
    expect(review.verdict).toBe('reject');
    expect(review.issues[0]).toContain('不可解析');
  });

  it('音符计数与小节计数进 stats（diff 预览数据）；元命令小数不算音符', () => {
    expect(reviewTexEdit(GOOD_TEX, GOOD_TEX_NO_TEMPO).stats.notesBefore).toBe(3);
    expect(reviewTexEdit('\\tempo 120.5 :8 0.6 | :8 2.5', ':8 0.6 | :8 2.5').stats.notesBefore).toBe(2);
    expect(reviewTexEdit(GOOD_TEX, GOOD_TEX_NO_TEMPO).stats.barsBefore).toBe(3);
  });
});

describe('extractAlphaTex', () => {
  it('剥离围栏与前后解释行', () => {
    const text = '好的，改编如下：\n```\\tempo 120 :8 0.6 | :8 2.5```\n希望对你有帮助！';
    expect(extractAlphaTex(text)).toBe('\\tempo 120 :8 0.6 | :8 2.5');
  });
  it('纯谱面原样返回', () => {
    expect(extractAlphaTex(GOOD_TEX)).toBe(GOOD_TEX);
  });
  it('完全不含谱面 → null', () => {
    expect(extractAlphaTex('抱歉，我无法完成这个改编。')).toBeNull();
  });
});

describe('与 alphaTex 渲染器同源（冒烟）', () => {
  it('本模块判定 ok 的谱面，AlphaTexImporter 也能读', () => {
    const check = checkAlphaTexParses(GOOD_TEX);
    expect(check.ok).toBe(true);
    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.initFromString(GOOD_TEX, new alphaTab.Settings());
    expect(importer.readScore().tracks.length).toBeGreaterThan(0);
  });
});
