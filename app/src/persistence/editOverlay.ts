/**
 * 人工修正打标与回放合并（v4.1 §2.4 核心机制）。
 *
 * 单一事实源在数据模型：用户手改不落原始转写结果，而是写成独立的
 * editOverlay 条目（noteId + 字段变更）；重算触发后新基线与 overlay
 * 回放合并 —— noteId 仍存在则覆盖字段，消失则进冲突清单供确认。
 *
 * noteId 取自「原始转写结果」的内容指纹（onset|pitch|string），确定性生成，
 * 重算前后同位置同音高同弦的音符天然承接同一 id。
 */
import { z } from 'zod';
import type { FrettedNote } from '../profiles/IInstrumentProfile';

export const EDITABLE_FIELDS = ['string', 'fret', 'duration', 'onset', 'pitch', 'techniques', 'suspectedHarmonic'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export const EditEntrySchema = z.object({
  noteId: z.string().min(1),
  /** remove=true 表示删除该音符（如“疑似泛音”确认处置） */
  remove: z.boolean().optional(),
  changes: z.record(z.string(), z.unknown()).optional(),
  at: z.number(),
  note: z.string().max(200).optional(),
});

export type EditEntry = z.infer<typeof EditEntrySchema>;

/** 内容指纹：onset(ms)|pitch|string —— 三元组一致即视为同一音符 */
export function noteIdOf(n: Pick<FrettedNote, 'onset' | 'pitch' | 'string'>): string {
  return `${Math.round(n.onset * 1000)}|${n.pitch}|${n.string}`;
}

/**
 * 合并 overlay：同一 noteId 的多条编辑按时间顺序折叠 ——
 * 字段后写覆盖先写；remove 之后再有字段变更视为恢复该音符（只带最新字段）。
 * 输出保持 noteId 首次出现的时间顺序，便于 UI 按时间轴展示。
 */
export function compactOverlay(entries: EditEntry[]): EditEntry[] {
  const order: string[] = [];
  const state = new Map<string, { remove?: boolean; changes?: Record<string, unknown>; at: number; note?: string }>();
  for (const e of entries) {
    let s = state.get(e.noteId);
    if (!s) {
      s = { at: e.at };
      state.set(e.noteId, s);
      order.push(e.noteId);
    }
    if (e.remove) {
      s.remove = true;
      s.changes = undefined;
    } else if (e.changes) {
      s.changes = s.remove ? { ...e.changes } : { ...(s.changes ?? {}), ...e.changes };
      s.remove = false;
      s.at = e.at;
      s.note = e.note ?? s.note;
    }
  }
  return order.map((id) => {
    const s = state.get(id)!;
    const out: EditEntry = { noteId: id, at: s.at };
    if (s.remove) out.remove = true;
    if (s.changes) out.changes = s.changes;
    if (s.note) out.note = s.note;
    return out;
  });
}

export type OverlayApplyResult = {
  notes: FrettedNote[];
  applied: EditEntry[];
  /** noteId 在新基线里已不存在的条目（§2.4 冲突清单） */
  conflicts: EditEntry[];
};

/**
 * 回放合并：基线音符按 noteId 建索引，逐条应用 overlay。
 * tuning 提供时，改 string/fret 会同步重算 pitch（弦音 + 品），
 * 保证数据模型自洽（tuning 按低音弦在前的约定，与 GuitarProfile 一致）。
 */
export function applyOverlay(
  base: FrettedNote[],
  entries: EditEntry[],
  tuning?: number[],
): OverlayApplyResult {
  const byId = new Map<string, FrettedNote[]>();
  for (const n of base) {
    const id = noteIdOf(n);
    const bucket = byId.get(id);
    if (bucket) bucket.push(n);
    else byId.set(id, [n]);
  }

  const applied: EditEntry[] = [];
  const conflicts: EditEntry[] = [];
  const removed = new Set<FrettedNote>();
  const edited = new Map<FrettedNote, FrettedNote>();

  for (const entry of entries) {
    const targets = byId.get(entry.noteId);
    if (!targets || targets.length === 0) {
      conflicts.push(entry);
      continue;
    }
    applied.push(entry);
    if (entry.remove) {
      for (const t of targets) removed.add(t);
      continue;
    }
    for (const t of targets) {
      // remove 之后的字段变更 = 恢复该音符（与 compactOverlay 语义一致）
      removed.delete(t);
      const source = edited.get(t) ?? t;
      const next: FrettedNote = { ...source };
      const changes = entry.changes ?? {};
      for (const [field, value] of Object.entries(changes)) {
        if ((EDITABLE_FIELDS as readonly string[]).includes(field)) {
          (next as unknown as Record<string, unknown>)[field] = value;
        }
      }
      if (tuning && (('string' in changes) || ('fret' in changes))) {
        const stringIdx = tuning.length - next.string; // alphaTab 弦号 1=最高音弦
        const open = tuning[stringIdx];
        if (open !== undefined) next.pitch = open + next.fret;
      }
      edited.set(t, next);
    }
  }

  const notes = base
    .map((n) => (removed.has(n) ? null : (edited.get(n) ?? n)))
    .filter((n): n is FrettedNote => n !== null)
    .sort((a, b) => a.onset - b.onset || a.string - b.string);

  return { notes, applied, conflicts };
}

/** 便捷构造：改弦品（自动补 pitch 重算的意图标记由调用方带 tuning 应用） */
export function makeFretEdit(note: FrettedNote, string: number, fret: number, at = Date.now()): EditEntry {
  return { noteId: noteIdOf(note), changes: { string, fret }, at };
}

/** 便捷构造：删除音符（疑似泛音确认处置等） */
export function makeRemoveEdit(note: FrettedNote, at = Date.now()): EditEntry {
  return { noteId: noteIdOf(note), remove: true, at };
}
