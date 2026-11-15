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
  it('多声部只统计共享小节，第二声部变更落在正确的小节号', () => {
    const before = '\\tempo 120 . \\voice :1 0.6 | :1 r \\voice :1 0.1 | :1 r';
    const after = '\\tempo 120 . \\voice :1 0.6 | :1 r \\voice :1 0.1 | :1 1.1';
    expect(diffBars(before, after)).toEqual({ changedBars: [2], addedBars: 0, removedBars: 0 });
    const review = reviewTexEdit(before, after);
    expect(review.stats.barsBefore).toBe(2);
    expect(review.stats.notesBefore).toBe(2);
    expect(review.stats.notesAfter).toBe(3);
  });

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

  it('\\tempo 新增被拒（不能仅保留原数字序列）', () => {
    const review = reviewTexEdit(GOOD_TEX, '\\tempo 120 :8 0.6 | \\tempo 140 :8 2.5 | :4 3.2');
    expect(review.verdict).toBe('reject');
    expect(review.stats.tempoAfter).toEqual([120, 140]);
  });

  it('相同 BPM 数字序列但跨小节移动变速点 → reject', () => {
    const before = '\\tempo 120 . \\ks cmajor :4 0.6 | \\tempo 90 :4 0.6';
    const after = '\\tempo 120 . \\ks cmajor \\tempo 90 :4 0.6 | :4 0.6';
    expect(extractTempoMarkers(before)).toEqual(extractTempoMarkers(after));
    expect(reviewTexEdit(before, after).issues.some((s) => s.includes('拍点'))).toBe(true);
    expect(reviewTexEdit(before, after).verdict).toBe('reject');
  });

  it('小节内 beat tempo 移动一拍 → reject；原位置只改指法可接受', () => {
    const before = '\\tempo 80 . :4 10.2 12.3{tempo 90} 9.3';
    const moved = '\\tempo 80 . :4 5.1{tempo 90} 3.1 0.1';
    const retained = '\\tempo 80 . :4 5.1 3.1{tempo 90} 0.1';
    expect(reviewTexEdit(before, moved, 'reposition').verdict).toBe('reject');
    expect(reviewTexEdit(before, retained, 'reposition').verdict).toBe('accept');
    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.initFromString(retained, new alphaTab.Settings());
    const score = importer.readScore();
    const automation = score.masterBars[0].tempoAutomations[1];
    expect(automation.value).toBe(90);
    expect(automation.ratioPosition * score.masterBars[0].calculateDuration()).toBe(960);
  });

  it.each([
    ['音高', '\\tempo 80 . \\ks cmajor :4 11.2 | :4 12.3'],
    ['删小节', '\\tempo 80 . \\ks cmajor :4 10.2'],
    ['调号', '\\tempo 80 . \\ks f#major :4 10.2 | :4 12.3'],
    ['Capo', '\\tempo 80 \\capo 5 . \\ks cmajor :4 10.2 | :4 12.3'],
    ['调弦', '\\tempo 80 \\tuning D4 B3 G3 D3 A2 E2 . \\ks cmajor :4 10.2 | :4 12.3'],
    ['拍号', '\\tempo 80 . \\ts 3 4 \\ks cmajor :4 10.2 | :4 12.3'],
    ['时值', '\\tempo 80 . \\ks cmajor :8 10.2 | :4 12.3'],
  ])('降把位拒绝更改%s', (_label, after) => {
    const before = '\\tempo 80 . \\ks cmajor :4 10.2 | :4 12.3';
    expect(checkAlphaTexParses(after).ok).toBe(true);
    expect(reviewTexEdit(before, after, 'reposition').verdict).toBe('reject');
  });

  it('同音更换弦品保持 Capo 和调弦；按实际发声音高回读', () => {
    const before = '\\tempo 80 \\capo 3 . \\ks eminor :4 12.3';
    const after = '\\tempo 80 \\capo 3 . \\ks eminor :4 3.1';
    expect(reviewTexEdit(before, after, 'reposition').verdict).toBe('accept');
    const pitches = [before, after].map((tex) => {
      const importer = new alphaTab.importer.AlphaTexImporter();
      importer.initFromString(tex, new alphaTab.Settings());
      return importer.readScore().tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].realValue;
    });
    expect(pitches).toEqual([70, 70]);
  });

  it('和弦必须保持同拍音高多重集；不能改为顺序弹奏或吞掉同音重叠', () => {
    const before = '\\tempo 80 . :4 (9.3 0.1)';
    expect(reviewTexEdit(before, '\\tempo 80 . :4 0.1 4.2', 'reposition').verdict).toBe('reject');
    expect(reviewTexEdit(before, '\\tempo 80 . :4 0.1', 'reposition').verdict).toBe('reject');
    expect(reviewTexEdit(before, '\\tempo 80 . :4 (0.1 0.1)', 'reposition').issues).toContain('降把位产生跨声部同弦冲突');
    expect(reviewTexEdit(before, '\\tempo 80 . :4 (5.2 0.1)', 'reposition').verdict).toBe('accept');
  });

  it('简化/默认拆轨策略允许删音；降把位策略拒绝同样的删音', () => {
    const before = '\\tempo 80 . :4 (10.2 0.6) | :4 12.3';
    const after = '\\tempo 80 . :4 10.2 | :4 r';
    expect(reviewTexEdit(before, after).verdict).toBe('accept');
    expect(reviewTexEdit(before, after, 'arrange').verdict).toBe('accept');
    expect(reviewTexEdit(before, after, 'reposition').verdict).toBe('reject');
  });

  it('原谱不可解析时拒绝，不能仅验证输出', () => {
    expect(reviewTexEdit(':q 0.6', GOOD_TEX).verdict).toBe('reject');
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
