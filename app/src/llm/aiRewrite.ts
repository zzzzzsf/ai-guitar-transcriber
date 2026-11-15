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
import { chatWith, LlmError, type LlmChatOptions, type LlmConfig, type LlmMessage } from './llmClient';
import { REWRITE_SYSTEM_PROMPT, buildRewriteUserPrompt } from './guitarPrompts';
import { extractAlphaTex, reviewTexEdit, type TexEditPolicy, type TexEditReview } from './texGuard';

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
  /** Defaults to reposition; explicit simplification/arrangement requests allow note edits. */
  editPolicy?: TexEditPolicy;
  context?: string;
  /** 本地降级（降把位）所需：当前谱面音符；缺省时降级返回原文 */
  notes?: FrettedNote[];
  tuning?: number[];
  capo?: number;
  /** Optional context-aware exporter. Without one, local fallback keeps the input. */
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

function allPositions(pitch: number, tuning: number[], capo: number): { stringIdx: number; fret: number }[] {
  const out: { stringIdx: number; fret: number }[] = [];
  for (let s = 0; s < tuning.length; s++) {
    const fret = pitch - tuning[s] - capo;
    if (fret >= 0 && fret <= MAX_FRET) out.push({ stringIdx: s, fret });
  }
  return out.sort((a, b) => a.fret - b.fret || a.stringIdx - b.stringIdx);
}

/**
 * 降把位重排：按 onset 簇整体分配弦品，每音不升品，簇内弦互斥。
 * 无安全解或上下文矛盾时明确失败；不修改传入音符或实际音高。
 */
export function localShiftDown(
  notes: FrettedNote[],
  tuning: number[] = STANDARD_TUNING,
  capo = 0,
): FrettedNote[] {
  if (!tuning.length || tuning.some((p) => !Number.isInteger(p)) || !Number.isInteger(capo) || capo < 0) {
    throw new Error('降把位需要有效调弦和 Capo');
  }
  const sorted = [...notes].sort((a, b) => a.onset - b.onset);
  const out: FrettedNote[] = [];
  let cluster: FrettedNote[] = [];

  const flush = () => {
    if (cluster.length === 0) return;
    if (cluster.length > tuning.length) throw new Error('同拍音符超过弦数，无法消除同弦冲突');
    // Assign the entire chord, including unchanged notes. A greedy move must
    // never occupy the only string available to another note's fallback.
    const candidates = cluster.map((n) => {
      const index = tuning.length - n.string;
      if (!Number.isInteger(n.string) || index < 0 || index >= tuning.length ||
          !Number.isInteger(n.fret) || n.fret < 0 || n.fret > MAX_FRET ||
          tuning[index] + capo + n.fret !== n.pitch) {
        throw new Error('音符的音高、调弦、Capo 与弦品不一致，无法安全降把位');
      }
      return allPositions(n.pitch, tuning, capo).filter((p) => p.fret <= n.fret);
    });
    const order = cluster.map((_, i) => i).sort((a, b) => candidates[a].length - candidates[b].length);
    const used = new Set<number>();
    const choice: Array<{ stringIdx: number; fret: number }> = [];
    let best: typeof choice | undefined;
    let bestCost = Infinity;
    const assign = (at: number, cost: number) => {
      if (cost >= bestCost) return;
      if (at === order.length) {
        best = [...choice];
        bestCost = cost;
        return;
      }
      const i = order[at];
      for (const p of candidates[i]) {
        if (used.has(p.stringIdx)) continue;
        used.add(p.stringIdx);
        choice[i] = p;
        const moved = tuning.length - p.stringIdx !== cluster[i].string;
        assign(at + 1, cost + p.fret * (cluster.length + 1) + Number(moved));
        used.delete(p.stringIdx);
      }
    };
    assign(0, 0);
    if (!best) throw new Error('无法在不升品的前提下消除同弦冲突，已保留原谱');
    out.push(...cluster.map((n, i) => ({ ...n, string: tuning.length - best![i].stringIdx, fret: best![i].fret })));
    cluster = [];
  };

  for (const n of sorted) {
    if (cluster.length && n.onset - cluster[0].onset > 0.05) flush();
    cluster.push(n);
  }
  flush();
  return out;
}

function requestedPolicy(instruction: string): TexEditPolicy {
  // Ignore explicitly forbidden edits, e.g. "降把位，不要简化节奏".
  const positive = instruction.replace(/(?:不要|不得|无需|禁止|不允许|do not|don't)[^，,。;；.!]*/gi, '');
  return /简化|清洗|错音|删音|删除|去掉.*音|(?:改变|改写|修改|调整|简化).*?(?:节奏|时值)|编曲|重新编配|simplif|arrang|compos|remove.*notes?|clean.*notes?|change.*(?:rhythm|duration)/i.test(positive)
    ? 'arrange' : 'reposition';
}

function positionOnlyInstruction(instruction: string): boolean {
  if (requestedPolicy(instruction) === 'arrange') return false;
  // Local fallback has a deliberately small whitelist. Merely mentioning
  // "降把位" in a mixed/unknown request must not silently discard the rest.
  const text = instruction.trim().replace(/[\s。.!！]+/g, '');
  return /^(?:请|请帮我|帮我)?(?:降把位|降低把位|换把位|重排把位|降到低把位|移到低把位)(?:重排)?$/i.test(text) ||
    /^(?:请|请帮我|帮我)?(?:(?:把|将)(?:这段|此段|整段|这首)?(?:高把位)?(?:solo|独奏|旋律|谱面)?)?(?:改写|改|重排|移|挪|降|降低|限制|控制)(?:到|在)?前[\d一二三四五六七八九十]+品(?:内|以内)?$/i.test(text) ||
    /^(?:lower(?:the)?(?:fret)?position|refinger|revoice)(?:within(?:the)?(?:first)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)frets?)?$/i.test(text);
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
  let lastIssues = '回复中找不到 alphaTex 谱面';

  for (let round = 0; round < 2; round++) {
    const { text } = await chat(messages, { temperature: 0.2, signal: input.signal });
    const candidate = extractAlphaTex(text);
    if (candidate) {
      const review = reviewTexEdit(input.alphaTex, candidate,
        input.editPolicy ?? requestedPolicy(input.instruction));
      if (review.verdict === 'accept') return { alphaTex: candidate, review };
      lastIssues = review.issues.join('；');
      // 校验失败：带 issues 进修复轮
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: REWRITE_REPAIR_PROMPT.replace('{issues}', review.issues.join('\n')) });
      continue;
    }
    lastIssues = '回复中找不到 alphaTex 谱面';
    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'user', content: REWRITE_REPAIR_PROMPT.replace('{issues}', '回复中找不到 alphaTex 谱面') });
  }
  throw new LlmError('parse', `模型两轮都未输出通过校验的 alphaTex：${lastIssues}`);
}

/** 入口：LLM 优先，失败/未连接 → 本地降把位降级（§1.3 降级策略） */
export async function rewriteAlphaTex(input: AiRewriteInput): Promise<AiRewriteResult> {
  const ensureActive = () => {
    if (input.signal?.aborted) throw new LlmError('aborted', '改谱已取消');
  };
  ensureActive();
  const fallback = async (notice: string): Promise<AiRewriteResult> => {
    ensureActive();
    const unchanged = (reason: string): AiRewriteResult => ({
      alphaTex: input.alphaTex, source: 'local-fallback',
      notice: `${notice}；${reason}；已保留原谱，未应用改编`,
    });
    if (!positionOnlyInstruction(input.instruction) || input.editPolicy === 'arrange') {
      return unchanged('本地规则不支持此指令');
    }
    if (!input.notes?.length) return unchanged('缺少可安全重排的音符');
    if (!input.retex) return unchanged('缺少保留原速度、调号和小节结构的出谱上下文');
    try {
      const shifted = localShiftDown(input.notes, input.tuning ?? STANDARD_TUNING, input.capo ?? 0);
      const original = [...input.notes].sort((a, b) => a.onset - b.onset);
      const changed = shifted.some((n, i) => n.string !== original[i].string || n.fret !== original[i].fret);
      if (!changed) return unchanged('没有找到更低且无同弦冲突的把位');
      const alphaTex = await input.retex(shifted);
      ensureActive();
      const review = reviewTexEdit(input.alphaTex, alphaTex, 'reposition');
      if (review.verdict === 'reject') return unchanged(`本地出谱未通过语义保护：${review.issues.join('；')}`);
      if (alphaTex === input.alphaTex) return unchanged('出谱结果未改变');
      return { alphaTex, source: 'local-fallback', review,
        notice: `${notice}；已按本地规则执行同音降把位重排` };
    } catch (e) {
      if (e instanceof LlmError && e.kind === 'aborted') throw e;
      return unchanged(`本地重排失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (!input.llm) {
    return fallback('未连接大模型（本地降级仅支持降把位重排）');
  }

  try {
    const { alphaTex, review } = await rewriteWithLlm(input);
    ensureActive();
    return { alphaTex, source: 'llm', review };
  } catch (e) {
    if (e instanceof LlmError && e.kind === 'aborted') throw e;
    const reason = e instanceof LlmError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : String(e);
    return fallback(`大模型改谱失败（${reason}）`);
  }
}
