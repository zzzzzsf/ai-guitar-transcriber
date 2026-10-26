import { useState } from 'react';
import { Check, Plus, RotateCcw, Timer, X } from 'lucide-react';
import type { TempoCandidate } from '../core/quantizer';
import type { BeatSection } from '../profiles/IInstrumentProfile';
import { TEMPO_CONFIRM } from '../core/quantizer';

type Props = {
  sections: BeatSection[];
  /** 待确认候选（中置信度，§3.5 确认流） */
  candidates: TempoCandidate[];
  /** 最近一次自动应用的候选（可撤销） */
  autoApplied: TempoCandidate | null;
  busy?: boolean;
  onAccept: (c: TempoCandidate) => void;
  onReject: (c: TempoCandidate) => void;
  onUndoAuto: () => void;
  onInsert: (bar: number, bpm: number) => void;
  onReset: () => void;
};

/** 每段的小节数（按段内 BPM 折算） */
function barsOf(s: BeatSection): number {
  const barSec = (s.timeSignature?.[0] ?? 4) * (60 / s.bpm);
  return Math.max(1, Math.round((s.end - s.start) / barSec));
}

/**
 * 变速段面板（§3.5 首期：一键插段 + 检测候选确认流）。
 * 渐进 UX：高置信自动应用（此处显示可撤销）、中置信进入确认流、低置信不出现。
 */
export default function TempoMapPanel({
  sections,
  candidates,
  autoApplied,
  busy,
  onAccept,
  onReject,
  onUndoAuto,
  onInsert,
  onReset,
}: Props) {
  const [inserting, setInserting] = useState(false);
  const [bar, setBar] = useState('5');
  const [bpm, setBpm] = useState('90');

  return (
    <div className="glass p-4">
      <div className="mb-3 flex items-center gap-2">
        <Timer className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">变速段</h2>
        <span className="ml-auto rounded-full bg-white/8 px-2 py-0.5 text-[10px] text-zinc-400">
          {sections.length} 段
        </span>
      </div>

      {/* 自动应用提示（高置信度 → 不打扰，仅可撤销） */}
      {autoApplied && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/8 px-3 py-2 text-[11px] text-emerald-300">
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            已自动应用 {Math.round(autoApplied.bpmBefore)} → {Math.round(autoApplied.bpmAfter)} BPM
            （置信度 {autoApplied.confidence}）
          </span>
          <button
            onClick={onUndoAuto}
            disabled={busy}
            title="撤销自动应用，恢复恒定 BPM"
            className="shrink-0 rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-40"
          >
            撤销
          </button>
        </div>
      )}

      {/* 待确认候选（中置信度确认流） */}
      {candidates.map((c) => (
        <div
          key={`${c.time}|${c.bpmAfter}`}
          className="mb-2 flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-[11px] text-amber-200"
        >
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {Math.round(c.bpmBefore)} → {Math.round(c.bpmAfter)} BPM
              {c.gradient && <span className="ml-1 text-[10px] text-amber-400/70">（渐变）</span>}
            </div>
            <div className="text-[10px] text-amber-400/70">
              {c.time.toFixed(1)}s 附近 · 置信度 {c.confidence}
            </div>
          </div>
          <button
            onClick={() => onAccept(c)}
            disabled={busy}
            title="采纳此变速点"
            className="shrink-0 rounded-md border border-emerald-400/30 bg-emerald-500/10 p-1 text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-40"
          >
            <Check className="h-3 w-3" />
          </button>
          <button
            onClick={() => onReject(c)}
            disabled={busy}
            title="忽略此候选"
            className="shrink-0 rounded-md border border-white/10 p-1 text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-40"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}

      {/* 当前分段 */}
      <div className="mb-3 flex flex-wrap gap-1">
        {sections.map((s, i) => {
          const startBar = sections.slice(0, i).reduce((acc, p) => acc + barsOf(p), 0);
          const endBar = startBar + barsOf(s);
          return (
            <span
              key={`${s.start}|${s.bpm}`}
              className="rounded-md bg-black/30 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-300"
              title={`${s.start.toFixed(1)}s ~ ${s.end.toFixed(1)}s`}
            >
              {startBar + 1}–{endBar} 小节 · {Math.round(s.bpm)}
            </span>
          );
        })}
      </div>

      {/* 一键插段 */}
      {inserting ? (
        <div className="mb-3 flex items-center gap-1.5 rounded-xl border border-white/10 bg-black/20 px-2.5 py-2">
          <input
            type="number"
            min={1}
            value={bar}
            onChange={(e) => setBar(e.target.value)}
            placeholder="小节"
            className="w-14 rounded-md border border-white/10 bg-black/30 px-1.5 py-1 text-[11px] text-zinc-200 outline-none focus:border-accent-strong"
          />
          <span className="text-[10px] text-zinc-600">小节起</span>
          <input
            type="number"
            min={30}
            max={400}
            value={bpm}
            onChange={(e) => setBpm(e.target.value)}
            placeholder="BPM"
            className="w-14 rounded-md border border-white/10 bg-black/30 px-1.5 py-1 text-[11px] text-zinc-200 outline-none focus:border-accent-strong"
          />
          <button
            onClick={() => {
              const b = parseInt(bar, 10);
              const p = parseFloat(bpm);
              if (Number.isInteger(b) && b >= 1 && p >= 30 && p <= 400) {
                onInsert(b, p);
                setInserting(false);
              }
            }}
            disabled={busy}
            className="ml-auto rounded-md bg-accent-grad-r px-2 py-1 text-[10px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            添加
          </button>
          <button
            onClick={() => setInserting(false)}
            className="rounded-md p-1 text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <button
            onClick={() => setInserting(true)}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[11px] text-zinc-300 transition-colors hover-border-accent disabled:opacity-40"
          >
            <Plus className="h-3 w-3" />
            插入变速段
          </button>
          <button
            onClick={onReset}
            disabled={busy}
            title="恢复全曲恒定 BPM"
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[11px] text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-40"
          >
            <RotateCcw className="h-3 w-3" />
            重置
          </button>
        </div>
      )}

      {candidates.length === 0 && !autoApplied && (
        <p className="mt-2 text-[10px] leading-relaxed text-zinc-700">
          置信度 ≥ {TEMPO_CONFIRM} 的变速候选会出现在这里确认；改动后自动局部重算量化与指法。
        </p>
      )}
    </div>
  );
}
