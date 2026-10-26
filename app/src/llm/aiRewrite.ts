/**
 * AI 改谱编排器（v4.0 §4.2 特性 2：自然语言把位重构 / 新手降维 / 错音清洗）。
 *
 * 流程（§1.3 输出前置校验）：
 *   指令 + 原谱 → guitarPrompts → LLM → extractAlphaTex（剥围栏/解释行）
 *   → texGuard.reviewTexEdit（可解析 + \tempo 保留 + diff 统计）
 *   → reject 则带校验错误重问一轮（修复轮）→ 仍失败走本地降级。
 *
 * 本地降级（§1.3）：高品位同音移到低品位的纯规则重排（localShiftDown）——
 * 只覆盖“降把位”语义，其它指令降级时原样返回并附 notice。
 * diff 预览数据（review）随结果返回，用户确认后才落谱（§2.2 snapshot 兜底）。
 */
import type { FrettedNote } from '../profiles/IInstrumentProfile';
import { STANDARD_TUNING } from '../profiles/tunings';
import { BALANCED_WEIGHTS } from '../profiles/costWeights';
import { chatWith, LlmError, type LlmChatOptions, type LlmConfig, type LlmMessage } from './llmClient';
import { REWRITE_SYSTEM_PROMPT, buildRewriteUserPrompt } from './guitarPrompts';
import { extractAlphaTex, reviewTexEdit, type TexEditReview } from './texGuard';

export type AiRewriteResult = {
  alphaTex: string;
  source: 'llm' | 'local-fallback';
  /** source=llm 时必带：diff 预览与统计（UI 确认流数据源） */
  review?: TexEditReview;
  notice?: string;
};

export type AiRewriteInput = {
  alphaTex: string;
  /** 自然语言改编要求 */
  instruction: string;
  context?: string;
  /** 本地降级（降把位）所需：当前谱面音符；缺省时降级返回原文 */
  notes?: FrettedNote[];
  tuning?: number[];
  capo?: number;
  /** 本地降级重新出谱；缺省用 GuitarProfile 默认上下文（动态加载） */
  retex?: (notes: FrettedNote[]) => string | Promise<string>;
  llm?: LlmConfig;
  /** 测试注入 chat 实现 */
  chat?: (messages: LlmMessage[], opts?: LlmChatOptions) => Promise<{ text: string }>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

// ---------- 本地降级：高品位同音移低品位（§1.3 规则） ----------

/** 同音高全部可按位置（低品优先，同品低音弦优先）；24 = GuitarProfile.MAX_FRET */
const MAX_FRET = 24;

function allPositions(pitch: number, tuning: number[]): { stringIdx: number; fret: number }[] {
  const out: { stringIdx: number; fret: number }[] = [];
  for (let s = 0; s < tuning.length; s++) {
    const fret = pitch - tuning[s];
    if (fret >= 0 && fret <= MAX_FRET) out.push({ stringIdx: s, fret });
  }
  return out.sort((a, b) => a.fret - b.fret || a.stringIdx - b.stringIdx);
}

/**
 * 降把位重排：按 onset 簇处理（簇内同弦互斥），每音从低到高找第一个
 * 比原品位更低且弦未被占用的位置；找不到就保持原位。纯函数，pitch 不变。
 */
export function localShiftDown(
  notes: FrettedNote[],
  tuning: number[] = STANDARD_TUNING,
): FrettedNote[] {
  const sorted = [...notes].sort((a, b) => a.onset - b.onset);
  const out: FrettedNote[] = [];
  let cluster: FrettedNote[] = [];

  const flush = () => {
    if (cluster.length === 0) return;
    const usedStrings = new Set<number>();
    // 高品先挪：腾出的低品空位留给后来者
    const order = [...cluster].sort((a, b) => b.fret - a.fret);
    const moved = new Map<FrettedNote, FrettedNote>();
    for (const n of order) {
      const curStringIdx = tuning.length - n.string; // alphaTab 弦号 → 调弦下标
      const better = allPositions(n.pitch, tuning).find(
        (p) => p.fret < n.fret && !usedStrings.has(p.stringIdx),
      );
      const pick = better ?? { stringIdx: curStringIdx, fret: n.fret };
      usedStrings.add(pick.stringIdx);
      moved.set(
        n,
        pick.stringIdx === curStringIdx && pick.fret === n.fret
          ? n
          : { ...n, string: tuning.length - pick.stringIdx, fret: pick.fret },
      );
    }
    out.push(...cluster.map((n) => moved.get(n)!));
    cluster = [];
  };

  for (const n of sorted) {
    if (cluster.length && n.onset - cluster[0].onset > 0.05) flush();
    cluster.push(n);
  }
  flush();
  return out;
}

function defaultRetex(tuning: number[], capo: number) {
  // 动态 import：GuitarProfile 保持 registry 的懒加载分块，不因本模块进主包
  return async (notes: FrettedNote[]) => {
    const { toAlphaTex } = await import('../profiles/GuitarProfile');
    return toAlphaTex(notes, {
      config: { tuning, capo },
      style: 'balanced',
      weights: BALANCED_WEIGHTS,
      tuning: { tuning, capo, suggestions: [], autoDetected: false },
    });
  };
}

// ---------- LLM 编排 ----------

const REWRITE_REPAIR_PROMPT =
  '你上一条回复未通过校验：\n{issues}\n请重新输出改编后的完整 alphaTex（保留全部 \\tempo 标记与小节数），只输出谱面文本，不要任何解释或代码块围栏。';

async function rewriteWithLlm(input: AiRewriteInput): Promise<{ alphaTex: string; review: TexEditReview }> {
  const chat =
    input.chat ??
    ((messages: LlmMessage[], opts?: LlmChatOptions) =>
      chatWith(input.llm!, messages, { ...opts, fetchImpl: input.fetchImpl, signal: input.signal }));

  const messages: LlmMessage[] = [
    { role: 'system', content: REWRITE_SYSTEM_PROMPT },
    { role: 'user', content: buildRewriteUserPrompt(input.alphaTex, input.instruction, input.context) },
  ];

  for (let round = 0; round < 2; round++) {
    const { text } = await chat(messages, { temperature: 0.2, signal: input.signal });
    const candidate = extractAlphaTex(text);
    if (candidate) {
      const review = reviewTexEdit(input.alphaTex, candidate);
      if (review.verdict === 'accept') return { alphaTex: candidate, review };
      // 校验失败：带 issues 进修复轮
      messages.push({ role: 'assistant', content: text.slice(0, 2000) });
      messages.push({ role: 'user', content: REWRITE_REPAIR_PROMPT.replace('{issues}', review.issues.join('\n')) });
      continue;
    }
    messages.push({ role: 'assistant', content: text.slice(0, 2000) });
    messages.push({ role: 'user', content: REWRITE_REPAIR_PROMPT.replace('{issues}', '回复中找不到 alphaTex 谱面') });
  }
  throw new LlmError('parse', '模型两轮都未输出通过校验的 alphaTex');
}

/** 入口：LLM 优先，失败/未连接 → 本地降把位降级（§1.3 降级策略） */
export async function rewriteAlphaTex(input: AiRewriteInput): Promise<AiRewriteResult> {
  const fallback = async (notice: string): Promise<AiRewriteResult> => {
    if (!input.notes?.length) {
      return { alphaTex: input.alphaTex, source: 'local-fallback', notice };
    }
    const tuning = input.tuning ?? STANDARD_TUNING;
    const capo = input.capo ?? 0;
    const retex = input.retex ?? defaultRetex(tuning, capo);
    const shifted = localShiftDown(input.notes, tuning);
    const alphaTex = await retex(shifted);
    return { alphaTex, source: 'local-fallback', notice: `${notice}；已降级为本地降把位重排` };
  };

  if (!input.llm) {
    return fallback('未连接大模型（本地降级仅支持降把位重排）');
  }

  try {
    const { alphaTex, review } = await rewriteWithLlm(input);
    return { alphaTex, source: 'llm', review };
  } catch (e) {
    const reason = e instanceof LlmError ? `${e.kind}: ${e.message}` : (e as Error).message;
    return fallback(`大模型改谱失败（${reason.slice(0, 120)}）`);
  }
}
