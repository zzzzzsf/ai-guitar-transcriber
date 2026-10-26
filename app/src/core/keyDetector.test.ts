import { describe, expect, it } from 'vitest';
import { detectKey, keyToAlphaTexToken, keyDisplayName } from './keyDetector';
import type { RawNote } from '../profiles/IInstrumentProfile';

/** 音阶构造：midi 音级序列，每个八分音符，首尾主音加倍时值强调 */
function scale(pitches: number[]): RawNote[] {
  return pitches.map((pitch, i) => ({
    onset: i * 0.25,
    duration: i === 0 || i === pitches.length - 1 ? 0.5 : 0.25,
    pitch,
    velocity: 100,
    pitchBend: [],
  }));
}

describe('detectKey（Krumhansl-Schmuckler 调性检测，§3.3 第 1 项）', () => {
  it('C 自然大调音阶 → C 大调', () => {
    const key = detectKey(scale([60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60]));
    expect(key?.name).toBe('C');
    expect(key?.mode).toBe('major');
    expect(key?.confidence).toBeGreaterThan(0.7);
  });

  it('G 大调音阶（含 F#）→ G 大调', () => {
    const key = detectKey(scale([67, 69, 71, 72, 74, 76, 78, 79, 78, 76, 74, 72, 71, 69, 67]));
    expect(key?.name).toBe('G');
    expect(key?.mode).toBe('major');
  });

  it('A 自然小调音阶 → A 小调', () => {
    const key = detectKey(scale([57, 59, 60, 62, 64, 65, 67, 69, 67, 65, 64, 62, 60, 59, 57]));
    expect(key?.name).toBe('Am');
    expect(key?.mode).toBe('minor');
  });

  it('E 小调音阶（含 F#）→ E 小调', () => {
    const key = detectKey(scale([64, 66, 67, 69, 71, 72, 74, 76, 74, 72, 71, 69, 67, 66, 64]));
    expect(key?.name).toBe('Em');
    expect(key?.mode).toBe('minor');
  });

  it('空输入返回 null', () => {
    expect(detectKey([])).toBeNull();
  });
});

describe('keyToAlphaTexToken（\\ks 记号映射，alphaTab 源码确认的 token 集）', () => {
  it('常用调名映射正确', () => {
    expect(keyToAlphaTexToken(4, 'minor')).toBe('eminor');
    expect(keyToAlphaTexToken(7, 'major')).toBe('gmajor');
    expect(keyToAlphaTexToken(0, 'major')).toBe('cmajor');
    expect(keyToAlphaTexToken(10, 'major')).toBe('bbmajor');
    expect(keyToAlphaTexToken(3, 'major')).toBe('ebmajor');
    expect(keyToAlphaTexToken(6, 'major')).toBe('f#major');
    expect(keyToAlphaTexToken(8, 'minor')).toBe('g#minor');
    expect(keyToAlphaTexToken(3, 'minor')).toBe('d#minor');
  });

  it('显示名一致（黑键按常用记法升降号）', () => {
    expect(keyDisplayName(4, 'minor')).toBe('Em');
    expect(keyDisplayName(10, 'major')).toBe('Bb');
    expect(keyDisplayName(3, 'major')).toBe('Eb');
    expect(keyDisplayName(6, 'major')).toBe('F#');
  });
});
