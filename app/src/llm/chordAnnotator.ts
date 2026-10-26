/**
 * 自动和弦标注编排器（v4.1 §1.4 工作分解 5 的“特性收口”）。
 *
 * 三条路径（§1.3 降级策略）：
 * 1. LLM：BYOK 已连接 → guitarPrompts 契约 → llmClient → JSON 提取 →
 *    zod 校验 → 名称/小节号归一化 → 拒收率 >50% 整体拒收（前置校验）；
 *    非法输出追加一次“修复轮”再问。
 * 2. 本地：未连接 → core/chordDetector（音高集合 × 和弦字典）。
 * 3. 降级：LLM 网络/Key/输出不合格 → 本地兜底，notice 带失败原因。
 */
import { z } from 'zod';
import type { BeatGrid, FrettedNote } from '../profiles/IInstrumentProfile';
import { detectChords, type ChordLabel } from '../core/chordDetector';
import {
  chatWith,
  extractJson,
  LlmError,
  type LlmChatOptions,
  type LlmConfig,
  type LlmMessage,
} from './llmClient';
import { CHORD_SYSTEM_PROMPT, buildChordUserPrompt } from './guitarPrompts';

export type ChordAnnotationSource = 'llm' | 'local' | 'local-fallback';

export type ChordAnnotation = {
  chords: ChordLabel[];
  source: ChordAnnotationSource;
  /** source 非 llm 时的原因说明（UI 一次性提示用） */
  notice?: string;
};

const ChordsPayloadSchema = z.preprocess(
  (value) => (Array.isArray(value) ? { chords: value } : value),
  z.object({
    chords: z.array(z.object({ bar: z.number().int().min(1), name: z.string().trim().min(1).max(16) })),
  }),
);

/** 根音 + 常见后缀 + 可选斜杠低音；大小写混合统一根音大写 */
const CHORD_NAME_RE = /^([A-Ga-g])([#b]?)([A-Za-z0-9()#b+,\s]{0,10})(?:\/([A-Ga-g])([#b]?))?$/;

const ROOT_FIX: Record<string, string> = {
  c: 'C', d: 'D', e: 'E', f: 'F', g: 'G', a: 'A', b: 'B',
};

/** 归一化单个和弦名；不合格返回 null（进入拒收统计） */
export function normalizeChordName(name: string): string | null {
  const m = CHORD_NAME_RE.exec(name.trim());
  if (!m) return null;
  const [, rootLetter, rootAcc, suffixRaw, bassLetter, bassAcc] = m;
  const root = `${ROOT_FIX[rootLetter.toLowerCase()] ?? rootLetter.toUpperCase()}${rootAcc ?? ''}`;
  // 后缀去掉空格；首字符若与根音重复大小写混淆（如 "EM"）统一小写化已知后缀
  const suffix = suffixRaw.replace(/\s+/g, '');
  const bass = bassLetter ? `/${ROOT_FIX[bassLetter.toLowerCase()] ?? bassLetter.toUpperCase()}${bassAcc ?? ''}` : '';
  const full = `${root}${suffix}${bass}`;
  return full.length > 24 ? null : full;
}

export type AnnotateChordsInput = {
  /** 已分配弦品的音符（本地降级路径输入） */
  notes: FrettedNote[];
  beatGrid: BeatGrid;
  /** 当前谱面（LLM 路径输入） */
  alphaTex: string;
  /** 谱面总小节数（越界小节前置校验用） */
  barCount: number;
  key?: string;
  /** BYOK 连接信息；缺省走本地 */
  llm?: LlmConfig;
  /** 测试注入 chat 实现；缺省用 chatWith */
  chat?: (messages: LlmMessage[], opts?: LlmChatOptions) => Promise<{ text: string }>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

const REPAIR_USER_PROMPT =
  '你上一条回复不是合法的契约 JSON。请重新输出：只含一个 JSON 对象 {"chords":[{"bar":1,"name":"Em"}, ...]}，不要任何其他文字。';

export async function annotateChords(input: AnnotateChordsInput): Promise<ChordAnnotation> {
  const local = (): ChordAnnotation => ({
    chords: detectChords(input.notes, input.beatGrid),
    source: 'local',
  });

  if (!input.llm) return local();

  try {
    const chords = await annotateWithLlm(input);
    return { chords, source: 'llm' };
  } catch (e) {
    const reason = e instanceof LlmError ? `${e.kind}: ${e.message}` : (e as Error).message;
    return {
      chords: detectChords(input.notes, input.beatGrid),
      source: 'local-fallback',
      notice: `大模型标注失败，已降级本地音程推断（${reason.slice(0, 120)}）`,
    };
  }
}

async function annotateWithLlm(input: AnnotateChordsInput): Promise<ChordLabel[]> {
  const chat =
    input.chat ??
    ((messages: LlmMessage[], opts?: LlmChatOptions) =>
      chatWith(input.llm!, messages, { ...opts, fetchImpl: input.fetchImpl, signal: input.signal }));

  const messages: LlmMessage[] = [
    { role: 'system', content: CHORD_SYSTEM_PROMPT },
    { role: 'user', content: buildChordUserPrompt(input.alphaTex, input.barCount, input.key) },
  ];

  // 两轮：首轮 + 修复轮（输出非法时把原话带回重问一次）
  for (let round = 0; round < 2; round++) {
    const { text } = await chat(messages, { jsonMode: true, temperature: 0.1, signal: input.signal });
    const extraction = extractJson(text);
    if (!extraction.ok) {
      messages.push({ role: 'assistant', content: text.slice(0, 2000) });
      messages.push({ role: 'user', content: REPAIR_USER_PROMPT });
      continue;
    }
    const parsed = ChordsPayloadSchema.safeParse(extraction.value);
    if (!parsed.success) {
      messages.push({ role: 'assistant', content: text.slice(0, 2000) });
      messages.push({ role: 'user', content: REPAIR_USER_PROMPT });
      continue;
    }
    const gate = validateAndNormalize(parsed.data.chords, input.barCount);
    if (gate.kept > 0) {
      if (gate.rejected > gate.kept) {
        // 拒收过半：质量不合格，整体拒收（§1.3 前置校验精神 —— 宁可降级也不落脏数据）
        throw new LlmError('parse', `和弦输出拒收率过高（${gate.rejected}/${gate.rejected + gate.kept}）`);
      }
      return gate.chords;
    }
    // 全部拒收 → 走修复轮
    messages.push({ role: 'assistant', content: text.slice(0, 2000) });
    messages.push({ role: 'user', content: REPAIR_USER_PROMPT });
  }
  throw new LlmError('parse', '模型两轮都未输出合法和弦 JSON');
}

type Gate = { chords: ChordLabel[]; kept: number; rejected: number };

/** 前置校验：小节号越界、和弦名不合法、同小节重复 → 拒收该条（重复保留首条） */
export function validateAndNormalize(raw: { bar: number; name: string }[], barCount: number): Gate {
  const byBar = new Map<number, ChordLabel>();
  let rejected = 0;
  for (const item of [...raw].sort((a, b) => a.bar - b.bar)) {
    if (item.bar < 1 || item.bar > barCount) {
      rejected += 1;
      continue;
    }
    const name = normalizeChordName(item.name);
    if (!name) {
      rejected += 1;
      continue;
    }
    if (byBar.has(item.bar)) {
      rejected += 1;
      continue;
    }
    byBar.set(item.bar, { bar: item.bar, name });
  }
  const chords = [...byBar.entries()].sort((a, b) => a[0] - b[0]).map(([, label]) => label);
  return { chords, kept: chords.length, rejected };
}
