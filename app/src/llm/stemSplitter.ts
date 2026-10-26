/**
 * 双吉他拆轨编排器（v4.0 §4.2 特性 3：单轨 → Lead / Rhythm 双轨）。
 *
 * §1.3 降级策略明确：双吉他拆轨**无本地降级** —— LLM 失败/输出不合格直接抛
 * LlmError，由 UI 层禁用按钮并提示（引擎不做兜底，避免静默给出残缺拆轨）。
 *
 * 前置校验（texGuard + 拆轨专属）：
 * - 两轨均可被 alphaTexImporter 解析；
 * - 原谱 \tempo 序列在两轨中都保留（保序子序列）；
 * - 两轨小节数与原谱一致（播放同步的前提，prompt 契约的硬校验）。
 */
import { z } from 'zod';
import { chatWith, extractJson, LlmError, type LlmChatOptions, type LlmConfig, type LlmMessage } from './llmClient';
import { SPLIT_SYSTEM_PROMPT, buildSplitUserPrompt } from './guitarPrompts';
import { extractAlphaTex, reviewTexEdit, type TexEditReview } from './texGuard';

const SplitPayloadSchema = z.object({
  lead: z.string().min(1),
  rhythm: z.string().min(1),
});

export type SplitResult = {
  lead: string;
  rhythm: string;
  reviews: { lead: TexEditReview; rhythm: TexEditReview };
};

export type SplitInput = {
  alphaTex: string;
  llm?: LlmConfig;
  chat?: (messages: LlmMessage[], opts?: LlmChatOptions) => Promise<{ text: string }>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

const SPLIT_REPAIR_PROMPT =
  '你上一条回复未通过校验：\n{issues}\n请重新输出 {"lead":"...","rhythm":"..."}，两轨都必须保留原谱全部 \\tempo 标记且小节数与原谱一致，只输出 JSON。';

function reviewTrack(before: string, track: string, label: string): { ok: true; review: TexEditReview } | { ok: false; issues: string[] } {
  const candidate = extractAlphaTex(track);
  if (!candidate) return { ok: false, issues: [`${label} 轨中找不到 alphaTex 谱面`] };
  const review = reviewTexEdit(before, candidate);
  const issues = [...review.issues];
  if (review.stats.barsAfter !== review.stats.barsBefore) {
    issues.push(`${label} 轨小节数与原谱不一致（${review.stats.barsBefore} → ${review.stats.barsAfter}）`);
  }
  if (review.verdict === 'reject' || issues.length > 0) return { ok: false, issues };
  return { ok: true, review };
}

export async function splitGuitars(input: SplitInput): Promise<SplitResult> {
  if (!input.llm) throw new LlmError('badRequest', '双吉他拆轨需要连接大模型（无本地降级）');
  const chat =
    input.chat ??
    ((messages: LlmMessage[], opts?: LlmChatOptions) =>
      chatWith(input.llm!, messages, { ...opts, fetchImpl: input.fetchImpl, signal: input.signal }));

  const messages: LlmMessage[] = [
    { role: 'system', content: SPLIT_SYSTEM_PROMPT },
    { role: 'user', content: buildSplitUserPrompt(input.alphaTex) },
  ];

  for (let round = 0; round < 2; round++) {
    const { text } = await chat(messages, { jsonMode: true, temperature: 0.2, signal: input.signal });
    const extraction = extractJson(text);
    if (!extraction.ok) {
      messages.push({ role: 'assistant', content: text.slice(0, 2000) });
      messages.push({ role: 'user', content: SPLIT_REPAIR_PROMPT.replace('{issues}', extraction.error) });
      continue;
    }
    const parsed = SplitPayloadSchema.safeParse(extraction.value);
    if (!parsed.success) {
      messages.push({ role: 'assistant', content: text.slice(0, 2000) });
      messages.push({
        role: 'user',
        content: SPLIT_REPAIR_PROMPT.replace(
          '{issues}',
          `JSON 结构不符：${parsed.error.issues[0]?.message ?? 'schema 不匹配'}`,
        ),
      });
      continue;
    }
    const leadCheck = reviewTrack(input.alphaTex, parsed.data.lead, 'Lead');
    const rhythmCheck = reviewTrack(input.alphaTex, parsed.data.rhythm, 'Rhythm');
    if (leadCheck.ok && rhythmCheck.ok) {
      return {
        lead: extractAlphaTex(parsed.data.lead)!,
        rhythm: extractAlphaTex(parsed.data.rhythm)!,
        reviews: { lead: leadCheck.review, rhythm: rhythmCheck.review },
      };
    }
    const issues = [
      ...(leadCheck.ok ? [] : leadCheck.issues),
      ...(rhythmCheck.ok ? [] : rhythmCheck.issues),
    ];
    messages.push({ role: 'assistant', content: text.slice(0, 2000) });
    messages.push({ role: 'user', content: SPLIT_REPAIR_PROMPT.replace('{issues}', issues.join('\n')) });
  }
  throw new LlmError('parse', '模型两轮都未输出通过校验的双轨 JSON（双吉他拆轨无降级）');
}
