/**
 * alphaTex 输出前置校验 + diff 统计（v4.1 §1.3 “输出前置校验” 与 §2.4 diff 预览的后端）。
 *
 * AI 改谱流程的强制关卡：LLM 返回的 alphaTex 先过这里 ——
 * ① 可解析校验（alphaTab AlphaTexImporter 试解析，失败即拒收）；
 * ② \tempo 保留校验（§3.5 BYOK 约束：LLM 不得删改变速标记）；
 * ③ 结构 diff 统计（增删改小节清单）供 UI 高亮预览，用户确认后才落谱。
 */
import * as alphaTab from '@coderline/alphatab';

export type TexParseCheck = { ok: true } | { ok: false; error: string };

/** 用 alphaTex 导入器试解析 —— 与渲染器同一解析器，过不了这里就上不了谱面 */
export function checkAlphaTexParses(tex: string): TexParseCheck {
  if (!tex.trim()) return { ok: false, error: 'alphaTex 为空' };
  try {
    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.initFromString(tex, new alphaTab.Settings());
    importer.readScore();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}

/** 提取 \tempo 标记序列（保序）—— 改谱前后对比用 */
export function extractTempoMarkers(tex: string): number[] {
  const out: number[] = [];
  const re = /\\tempo\s+(\d+(?:\.\d+)?)/g;
  for (const m of tex.matchAll(re)) out.push(Number(m[1]));
  return out;
}

/** 提取 `\ks` 调号序列（辅助校验：调号也不应被 AI 擅自改动） */
export function extractKeySignatures(tex: string): string[] {
  const out: string[] = [];
  const re = /\\ks\s+([A-Ga-g][#b]?[a-zA-Z]*)/g;
  for (const m of tex.matchAll(re)) out.push(m[1]);
  return out;
}

function countNotes(tex: string): number {
  // 先剥掉 \tempo 120.5 / \ks 之类元命令，防其小数被当音符记号
  const body = tex.replace(/\\[a-z]+\s+([^\s|]+)/gi, '');
  // 音符记号 "弦.品"（本工程导出格式 "fret.string"，通用场景兼容 "string.fret"）
  return (body.match(/\d+\.\d+/g) ?? []).length;
}

function splitBars(tex: string): string[] {
  return tex
    .split('|')
    .map((b) => b.replace(/\s+/g, ' ').trim())
    .filter((b) => b.length > 0);
}

export type BarDiff = {
  changedBars: number[];
  addedBars: number;
  removedBars: number;
};

/** 小节级 diff：按 "|" 切分逐小节对比，输出变更小节号（1 基）与增删量 */
export function diffBars(before: string, after: string): BarDiff {
  const a = splitBars(before);
  const b = splitBars(after);
  const changedBars: number[] = [];
  const common = Math.min(a.length, b.length);
  for (let i = 0; i < common; i++) {
    if (a[i] !== b[i]) changedBars.push(i + 1);
  }
  return {
    changedBars,
    addedBars: Math.max(0, b.length - a.length),
    removedBars: Math.max(0, a.length - b.length),
  };
}

/** \tempo 序列 before 必须是 after 的保序子序列（允许新增，不允许删改） */
function droppedTempoMarkers(before: number[], after: number[]): number[] {
  let j = 0;
  const dropped: number[] = [];
  for (const t of before) {
    while (j < after.length && after[j] !== t) j += 1;
    if (j >= after.length) dropped.push(t);
    else j += 1;
  }
  return dropped;
}

export type TexEditReview = {
  /** verdict=reject 时任何调用方都不得落谱 */
  verdict: 'accept' | 'reject';
  issues: string[];
  stats: {
    barsBefore: number;
    barsAfter: number;
    notesBefore: number;
    notesAfter: number;
    tempoBefore: number[];
    tempoAfter: number[];
    keysBefore: string[];
    keysAfter: string[];
  };
  diff: BarDiff;
};

/** AI 改谱输出的完整关卡：解析 → tempo 保留 → 结构统计 */
export function reviewTexEdit(before: string, after: string): TexEditReview {
  const issues: string[] = [];

  const parse = checkAlphaTexParses(after);
  if (!parse.ok) issues.push(`输出不可解析：${parse.error}`);

  const tempoBefore = extractTempoMarkers(before);
  const tempoAfter = extractTempoMarkers(after);
  const dropped = droppedTempoMarkers(tempoBefore, tempoAfter);
  if (dropped.length) issues.push(`\\tempo 标记被删除或改动：${dropped.join(', ')}`);

  const barsBefore = splitBars(before);
  const barsAfter = splitBars(after);
  if (barsAfter.length !== barsBefore.length) {
    issues.push(`小节数变化：${barsBefore.length} → ${barsAfter.length}`);
  }

  const diff = diffBars(before, after);
  const verdict = parse.ok && dropped.length === 0 ? 'accept' : 'reject';

  return {
    verdict,
    issues,
    stats: {
      barsBefore: barsBefore.length,
      barsAfter: barsAfter.length,
      notesBefore: countNotes(before),
      notesAfter: countNotes(after),
      tempoBefore,
      tempoAfter,
      keysBefore: extractKeySignatures(before),
      keysAfter: extractKeySignatures(after),
    },
    diff,
  };
}

/**
 * 从 LLM 回复中剥出 alphaTex 正文：去 ``` 围栏、去“以下是…”之类的首尾解释行。
 * 返回 null 表示看起来根本不含谱面（连 "|" 都没有）。
 */
export function extractAlphaTex(text: string): string | null {
  let t = text.trim();
  const fence = t.match(/```(?:alphatex|tex)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // 去首尾非谱面行：保留含 '|' 或 '\' 元命令或音符记号的行
  const lines = t.split(/\r?\n/);
  while (lines.length && !/([|\\]|\d+\.\d+)/.test(lines[0])) lines.shift();
  while (lines.length && !/([|\\]|\d+\.\d+)/.test(lines[lines.length - 1])) lines.pop();
  const joined = lines.join('\n').trim();
  if (!joined || (!joined.includes('|') && !joined.includes('\\'))) return null;
  return joined;
}
