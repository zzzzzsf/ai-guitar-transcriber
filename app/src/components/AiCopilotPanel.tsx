import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Music4,
  Sparkles,
  Split,
  Undo2,
  Wand2,
  X,
} from 'lucide-react';
import { useCopilot } from '../copilot';
import type { ChordLabel } from '../core/chordDetector';
import type { SettingsSection } from '../settings';
import type { AiRewriteResult } from '../llm/aiRewrite';
import type { ChordAnnotationSource } from '../llm/chordAnnotator';
import type { SplitResult } from '../llm/stemSplitter';

type Props = {
  onOpenSettings: (section: SettingsSection) => void;
  /** 是否已有转谱结果（Copilot 功能作用于当前谱面） */
  hasResult: boolean;
  /** 和弦标注结果（逐小节） */
  chords: ChordLabel[] | null;
  /** 和弦标注来源与降级说明 */
  chordMeta: { source: ChordAnnotationSource; notice?: string } | null;
  copilotBusy: boolean;
  connected: boolean;
  /** AI 改谱待确认预览 */
  rewritePreview: AiRewriteResult | null;
  /** 双吉他拆轨待选用预览 */
  splitPreview: SplitResult | null;
  aiCanUndo: boolean;
  onAnnotateChords: () => void;
  onSimplify: () => void;
  onRunRewrite: (instruction: string) => void;
  onAcceptRewrite: () => void;
  onDiscardRewrite: () => void;
  onUndoAiEdit: () => void;
  onRunSplit: () => void;
  onApplySplit: (track: 'lead' | 'rhythm') => void;
  onDiscardSplit: () => void;
};

const REWRITE_PRESETS = ['把这段高把位 Solo 改写到前 5 品内', '把复杂指弹简化为新手好按的分解和弦', '清洗明显的错音与碎音'];

const CHORD_SOURCE_LABEL: Record<ChordAnnotationSource, string> = {
  llm: '大模型',
  local: '本地规则 · 离线',
  'local-fallback': '本地降级',
};

/**
 * 主页面 AI Copilot 功能面板。
 * 连接管理在 设置 → AI Copilot；此处提供三特性入口：
 * - 和弦标注 / 新手简化：未连接也可用（本地规则，离线）
 * - AI 改谱 / 双吉他拆轨：需连接（LLM 推理，产出经前置校验 → 预览确认 → 落谱）
 * 全部落谱操作可撤销（会话内回滚栈）。
 */
export default function AiCopilotPanel({
  onOpenSettings,
  hasResult,
  chords,
  chordMeta,
  copilotBusy,
  connected,
  rewritePreview,
  splitPreview,
  aiCanUndo,
  onAnnotateChords,
  onSimplify,
  onRunRewrite,
  onAcceptRewrite,
  onDiscardRewrite,
  onUndoAiEdit,
  onRunSplit,
  onApplySplit,
  onDiscardSplit,
}: Props) {
  const { connection } = useCopilot();
  const [instruction, setInstruction] = useState('');
  const featureDisabled = !hasResult || copilotBusy;

  return (
    <div className="glass p-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">AI Copilot</h2>
        {aiCanUndo && !copilotBusy && (
          <button
            onClick={onUndoAiEdit}
            title="撤销最近一次 AI 改谱/拆轨落谱"
            className="ml-auto flex items-center gap-1 rounded-full bg-zinc-700/60 px-2 py-0.5 text-[10px] text-zinc-300 transition-colors hover:bg-zinc-600/60"
          >
            <Undo2 className="h-3 w-3" />
            撤销 AI
          </button>
        )}
        {connected && connection ? (
          <span
            className={`flex min-w-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300 ${aiCanUndo ? '' : 'ml-auto'}`}
            title={`${connection.model} · ${connection.baseUrl}`}
          >
            <CheckCircle2 className="h-3 w-3 shrink-0" />
            <span className="truncate">
              已连接 {connection.label} · {connection.model}
            </span>
          </span>
        ) : (
          <span className={`flex items-center gap-1 rounded-full bg-zinc-700/60 px-2 py-0.5 text-[10px] text-zinc-400 ${aiCanUndo ? '' : 'ml-auto'}`}>
            <CircleDashed className="h-3 w-3" />
            未连接
          </span>
        )}
      </div>

      {/* 和弦标注结果 */}
      {chords && chords.length > 0 && (
        <div className="mb-3 rounded-xl border-accent bg-accent-soft px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-accent opacity-80">
            <Music4 className="h-3 w-3" />
            和弦走向（逐小节 · {chordMeta ? CHORD_SOURCE_LABEL[chordMeta.source] : '本地规则'}）
          </div>
          <div className="flex flex-wrap gap-1">
            {chords.map((c) => (
              <span
                key={c.bar}
                className="rounded-md bg-black/30 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-300"
                title={`第 ${c.bar + 1} 小节`}
              >
                <span className="mr-0.5 text-[8px] text-zinc-600">{c.bar + 1}</span>
                {c.name}
              </span>
            ))}
          </div>
          {chordMeta?.notice && (
            <p className="mt-1.5 flex items-start gap-1 text-[9px] leading-relaxed text-amber-300/90">
              <AlertTriangle className="mt-px h-2.5 w-2.5 shrink-0" />
              {chordMeta.notice}
            </p>
          )}
        </div>
      )}

      {/* AI 改谱确认流（§1.3：前置校验 → diff 预览 → 采纳落谱） */}
      {rewritePreview && (
        <div className="mb-3 rounded-xl border border-accent/40 bg-accent-soft px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium text-accent">
            <Wand2 className="h-3 w-3" />
            改谱预览 · {rewritePreview.source === 'llm' ? '大模型（已过前置校验）' : '本地降级（降把位重排）'}
          </div>
          {rewritePreview.source === 'llm' && rewritePreview.review ? (
            <ul className="space-y-0.5 text-[10px] leading-relaxed text-zinc-300">
              <li>
                小节变化：{rewritePreview.review.diff.changedBars.length > 0
                  ? `改动 ${rewritePreview.review.diff.changedBars.length} 处（第 ${rewritePreview.review.diff.changedBars.slice(0, 12).join('、')}${rewritePreview.review.diff.changedBars.length > 12 ? ' …' : ''} 小节）`
                  : '无改动'}
                {rewritePreview.review.diff.addedBars > 0 && ` · 新增 ${rewritePreview.review.diff.addedBars}`}
                {rewritePreview.review.diff.removedBars > 0 && ` · 删除 ${rewritePreview.review.diff.removedBars}`}
              </li>
              <li>
                音符数：{rewritePreview.review.stats.notesBefore} → {rewritePreview.review.stats.notesAfter} · 谱面字符 {rewritePreview.review.stats.barsBefore} 小节 → {rewritePreview.review.stats.barsAfter} 小节
              </li>
              <li className="text-emerald-300">
                \tempo 变速标记已保留（{rewritePreview.review.stats.tempoAfter.length} 处）
              </li>
            </ul>
          ) : (
            <p className="text-[10px] leading-relaxed text-zinc-300">{rewritePreview.notice ?? '已按本地降把位规则重排指法。'}</p>
          )}
          <div className="mt-2 flex gap-1.5">
            <button
              onClick={onAcceptRewrite}
              className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-accent-grad-r px-2 py-1.5 text-[10px] font-semibold text-white transition-opacity hover:opacity-90"
            >
              <Check className="h-3 w-3" />
              采纳并落谱
            </button>
            <button
              onClick={onDiscardRewrite}
              className="flex items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[10px] text-zinc-300 transition-colors hover:bg-white/[0.06]"
            >
              <X className="h-3 w-3" />
              放弃
            </button>
          </div>
        </div>
      )}

      {/* 双吉他拆轨预览 */}
      {splitPreview && (
        <div className="mb-3 rounded-xl border border-accent/40 bg-accent-soft px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium text-accent">
            <Split className="h-3 w-3" />
            拆轨预览 · 两轨均已通过校验（tempo/小节数一致）
          </div>
          {(['lead', 'rhythm'] as const).map((track) => (
            <div key={track} className="mb-1.5">
              <div className="mb-0.5 flex items-center justify-between">
                <span className="text-[9px] font-medium text-zinc-400">{track === 'lead' ? 'Lead · 主音' : 'Rhythm · 节奏'}</span>
                <button
                  onClick={() => onApplySplit(track)}
                  className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[9px] text-zinc-200 transition-colors hover-bg-accent-soft"
                >
                  应用此轨
                </button>
              </div>
              <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/30 px-2 py-1.5 font-mono text-[9px] leading-relaxed text-zinc-400">
                {track === 'lead' ? splitPreview.lead : splitPreview.rhythm}
              </pre>
            </div>
          ))}
          <button
            onClick={onDiscardSplit}
            className="flex w-full items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[10px] text-zinc-300 transition-colors hover:bg-white/[0.06]"
          >
            <X className="h-3 w-3" />
            放弃拆轨
          </button>
        </div>
      )}

      {!connected && (
        <button
          onClick={() => onOpenSettings('copilot')}
          className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl bg-accent-grad-r px-3 py-2.5 text-xs font-semibold text-white shadow-md transition-opacity hover:opacity-90"
        >
          去设置连接 AI
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}

      {/* 本地即时操作（未连接也可用） */}
      <div className="grid gap-1.5">
        <FeatureButton
          icon={Sparkles}
          label="自动标注和弦"
          hint={featureDisabled ? (hasResult ? '处理中…' : '请先运行转谱') : connected ? '大模型 · 失败自动降级本地' : '本地规则 · 离线可用'}
          disabled={featureDisabled}
          onClick={onAnnotateChords}
        />
        <FeatureButton
          icon={Wand2}
          label="新手简化改谱（省力档）"
          hint={featureDisabled ? (hasResult ? '处理中…' : '请先运行转谱') : '本地规则 · 重排指法 · 可撤销'}
          disabled={featureDisabled}
          onClick={onSimplify}
        />
      </div>

      {/* AI 改谱指令（连接后解锁） */}
      {connected && (
        <div className="mt-2 rounded-xl border border-white/10 bg-white/[0.02] p-2.5">
          <div className="mb-1.5 flex flex-wrap gap-1">
            {REWRITE_PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => setInstruction(p)}
                disabled={featureDisabled}
                className={`rounded-full border px-2 py-0.5 text-[9px] transition-colors ${
                  featureDisabled
                    ? 'border-white/8 text-zinc-700'
                    : 'border-white/10 text-zinc-400 hover-border-accent hover:text-zinc-200'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="用自然语言描述改谱要求，如：把高把位段落改到前 5 品…"
            rows={2}
            disabled={featureDisabled}
            className="w-full resize-none rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-accent-strong disabled:opacity-50"
          />
          <div className="mt-1.5 flex gap-1.5">
            <button
              onClick={() => onRunRewrite(instruction)}
              disabled={featureDisabled || !instruction.trim()}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent-grad-r px-2 py-2 text-[11px] font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Wand2 className="h-3.5 w-3.5" />
              AI 改谱
            </button>
            <button
              onClick={onRunSplit}
              disabled={featureDisabled}
              title={hasResult ? '拆分为 Lead / Rhythm 双轨（无本地降级）' : '请先运行转谱'}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[11px] text-zinc-200 transition-colors hover-bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Split className="h-3.5 w-3.5" />
              拆轨
            </button>
          </div>
        </div>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-zinc-700">
        {connected
          ? 'AI 改谱与拆轨的输出均先过可解析校验与 \\tempo 保留校验，预览确认后才落谱；谱面 alphaTex 文本将发送到你连接的模型提供商。'
          : '连接你的大模型 API Key 后解锁 AI 改谱与拆轨（BYOK，Key 只保存在会话内存，刷新即清除）。'}
      </p>
    </div>
  );
}

function FeatureButton({
  icon: Icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: typeof Sparkles;
  label: string;
  hint: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
        disabled
          ? 'border-white/8 bg-white/[0.02] text-zinc-600'
          : 'border-white/10 bg-white/[0.03] text-zinc-200 hover-border-accent hover-bg-accent-soft'
      }`}
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${disabled ? 'text-zinc-700' : 'text-accent'}`} />
      <span className="min-w-0">
        <span className="block truncate">{label}</span>
        <span className={`block truncate text-[10px] ${disabled ? 'text-zinc-700' : 'text-zinc-500'}`}>{hint}</span>
      </span>
    </button>
  );
}
