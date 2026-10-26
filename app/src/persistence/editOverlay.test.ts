import { describe, expect, it } from 'vitest';
import { applyOverlay, compactOverlay, makeFretEdit, makeRemoveEdit, noteIdOf } from './editOverlay';
import type { FrettedNote } from '../profiles/IInstrumentProfile';

const STANDARD_TUNING = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4（低音弦在前）

function note(onset: number, pitch: number, string: number, fret: number): FrettedNote {
  return { onset, duration: 0.3, pitch, string, fret, velocity: 90 };
}

const BASE: FrettedNote[] = [
  note(0, 40, 6, 0),
  note(0.25, 45, 5, 0),
  note(0.5, 52, 4, 3),
];

describe('noteIdOf', () => {
  it('内容指纹确定性生成，重算后同位置同音同弦承接同 id', () => {
    expect(noteIdOf(BASE[0])).toBe(noteIdOf(note(0, 40, 6, 0)));
    expect(noteIdOf(BASE[0])).not.toBe(noteIdOf(BASE[1]));
  });
});

describe('applyOverlay 回放合并', () => {
  it('改弦品并按调弦重算 pitch', () => {
    // 52(E3) 原在 4 弦 3 品 → 改到 3 弦 7 品：G3(55) + 7 = 62(D4)
    const entry = makeFretEdit(BASE[2], 3, 7);
    const { notes, applied, conflicts } = applyOverlay(BASE, [entry], STANDARD_TUNING);
    expect(applied).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
    const moved = notes.find((n) => n.onset === 0.5)!;
    expect(moved.string).toBe(3);
    expect(moved.fret).toBe(7);
    expect(moved.pitch).toBe(62);
  });

  it('改时值等非弦品字段不触发 pitch 重算', () => {
    const entry = { noteId: noteIdOf(BASE[0]), changes: { duration: 0.9 }, at: 1 };
    const { notes } = applyOverlay(BASE, [entry]);
    expect(notes.find((n) => n.onset === 0)!.duration).toBe(0.9);
  });

  it('remove 删除音符（疑似泛音处置）', () => {
    const { notes } = applyOverlay(BASE, [makeRemoveEdit(BASE[1])]);
    expect(notes.map((n) => n.pitch)).toEqual([40, 52]);
  });

  it('noteId 消失（重算后音符被合并）→ 冲突清单', () => {
    const entry = makeFretEdit(BASE[2], 3, 7);
    const { applied, conflicts } = applyOverlay(BASE.slice(0, 2), [entry]);
    expect(applied).toHaveLength(0);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].noteId).toBe(noteIdOf(BASE[2]));
  });

  it('未知字段被忽略（可编辑字段白名单）', () => {
    const entry = { noteId: noteIdOf(BASE[0]), changes: { velocity: 15, fret: 5 }, at: 1 };
    const { notes } = applyOverlay(BASE, [entry]);
    const n = notes.find((x) => x.onset === 0)!;
    expect(n.fret).toBe(5);
    expect(n.velocity).toBe(90); // velocity 不在白名单
  });
});

describe('compactOverlay 折叠', () => {
  it('同 noteId 后写覆盖先写', () => {
    const entries = [
      makeFretEdit(BASE[0], 5, 1, 10),
      makeFretEdit(BASE[0], 4, 2, 20),
    ];
    const compact = compactOverlay(entries);
    expect(compact).toHaveLength(1);
    expect(compact[0].changes).toEqual({ string: 4, fret: 2 });
  });

  it('remove 后再改 → 恢复并只带最新字段', () => {
    const id = noteIdOf(BASE[1]);
    const compact = compactOverlay([
      makeRemoveEdit(BASE[1], 10),
      { noteId: id, changes: { duration: 0.8 }, at: 20 },
    ]);
    expect(compact).toHaveLength(1);
    expect(compact[0].remove).toBeUndefined();
    expect(compact[0].changes).toEqual({ duration: 0.8 });
  });

  it('remove 后再有字段变更 → 复活（与 compactOverlay 语义一致）', () => {
    const { notes } = applyOverlay(BASE, [
      makeRemoveEdit(BASE[1], 10),
      { noteId: noteIdOf(BASE[1]), changes: { duration: 0.8 }, at: 20 },
    ]);
    const revived = notes.find((n) => n.onset === 0.25)!;
    expect(revived.duration).toBe(0.8);
    expect(notes).toHaveLength(3);
  });

  it('末次 remove 生效', () => {
    const id = noteIdOf(BASE[2]);
    const compact = compactOverlay([
      { noteId: id, changes: { fret: 9 }, at: 10 },
      makeRemoveEdit(BASE[2], 20),
    ]);
    expect(compact[0].remove).toBe(true);
    expect(compact[0].changes).toBeUndefined();
  });

  it('不同 noteId 互不干扰且保持首现顺序', () => {
    const compact = compactOverlay([
      makeFretEdit(BASE[2], 3, 7, 30),
      makeFretEdit(BASE[0], 6, 1, 40),
    ]);
    expect(compact.map((e) => e.noteId)).toEqual([noteIdOf(BASE[2]), noteIdOf(BASE[0])]);
  });
});
