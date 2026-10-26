/**
 * 吉他调弦常量（空弦 MIDI，低→高）。
 * 独立成模块：让 demoSong/UI 可以静态引用常量，而 GuitarProfile 引擎本体
 * 保持由 ProfileRegistry 动态 import 懒加载（减小首屏体积）。
 */

/** 标准调弦 E2 A2 D3 G3 B3 E4 */
export const STANDARD_TUNING = [40, 45, 50, 55, 59, 64];
export const DROP_D_TUNING = [38, 45, 50, 55, 59, 64];
export const DADGAD_TUNING = [38, 45, 50, 55, 57, 62];
export const OPEN_G_TUNING = [38, 43, 50, 55, 59, 62];
export const OPEN_D_TUNING = [38, 45, 50, 54, 57, 62];

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiName(pitch: number): string {
  return `${PITCH_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}
