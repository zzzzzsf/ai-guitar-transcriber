import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import type { AlphaTabApi } from '@coderline/alphatab';
import HeaderBar from './components/HeaderBar';
import TabViewer from './components/TabViewer';
import PlaybackBar from './components/PlaybackBar';
import WaveformMixer from './components/WaveformMixer';
import AudioDropzone from './components/AudioDropzone';
import AiCopilotPanel from './components/AiCopilotPanel';
import SettingsModal from './components/SettingsModal';
import { SettingsProvider, useSettings, FINGERING_STYLE_LABEL } from './settings';
import type { SettingsSection } from './settings';
import type { PerformanceTier } from './types';
import { CopilotProvider, useCopilot } from './copilot';
import type { AiRewriteResult } from './llm/aiRewrite';
import type { ChordAnnotationSource } from './llm/chordAnnotator';
import type { SplitResult } from './llm/stemSplitter';
import {
  DEMO_ALPHA_TEX,
  DEMO_DURATION,
  createDemoBeatTimes,
  createDemoNotes,
} from './demoSong';
import { ProfileRegistry } from './profiles/registry';
import type { BeatGrid, BeatSection, RawNote, TranscriptionResult } from './profiles/IInstrumentProfile';
import {
  buildBeatGridFromSections,
  buildTempoMap,
  barStartTime,
  detectTempo,
  detectTempoCandidates,
  applyTempoCandidates,
  quantizeNotes,
  TEMPO_AUTO_APPLY,
  TEMPO_CONFIRM,
} from './core/quantizer';
import type { TempoCandidate } from './core/quantizer';
import type { ChordLabel } from './core/chordDetector';
import type { KeySelection } from './core/keyDetector';
import { preprocessAudio, decodeToAudioBuffer, audioBufferToSamples } from './core/audioPreprocessor';
import { transcribeAudio, MAX_CHUNK_SECONDS } from './core/pitchTranscriber';
import { annotateChords as annotateChordsEngine } from './llm/chordAnnotator';
import { rewriteAlphaTex as rewriteAlphaTexEngine } from './llm/aiRewrite';
import { splitGuitars as splitGuitarsEngine } from './llm/stemSplitter';
import type { LlmConfig } from './llm/llmClient';
import TempoMapPanel from './components/TempoMapPanel';
import { MemoryFsAdapter, OpfsFsAdapter, type FsAdapter } from './io/fsAdapter';
import { routeTier } from './main/tierRouter';
import {
  isDesktopRuntime,
  runDesktopSeparation,
  subscribeDesktopSeparation,
} from './main/desktopSeparation';
import type { SeparationTier } from './main/separatorRunner';
import { countScoreBars, readGuitarScore } from './core/scoreContext';

type AudioState = { url: string; name: string; size: number };
/** 一次成功转谱的完整上下文：Copilot 功能（标注/改谱）都作用于它 */
type LastRun = { rawNotes: RawNote[]; beatGrid: BeatGrid; result: TranscriptionResult };

/** 演示曲恒定基线分段（未应用任何变速候选时） */
function baseDemoSections(): BeatSection[] {
  return [{ start: 0, end: DEMO_DURATION, bpm: 80, timeSignature: [4, 4] }];
}

function candidateKey(c: TempoCandidate): string {
  return `${c.time.toFixed(3)}|${c.bpmAfter}`;
}

function signalThrowIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('转写已取消');
  error.name = 'AbortError';
  throw error;
}

/** 把浏览器解码后的 PCM 封装成 16-bit RIFF/WAVE，供 demucs 子进程直接读取。 */
function encodePcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function Workspace() {
  const { settings } = useSettings();
  const { connection, getApiKey } = useCopilot();
  const [tex, setTex] = useState(DEMO_ALPHA_TEX);
  const [audio, setAudio] = useState<AudioState | null>(null);
  const [tabApi, setTabApi] = useState<AlphaTabApi | null>(null);
  const [busy, setBusy] = useState(false);
  const [copilotBusy, setCopilotBusy] = useState(false);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [chords, setChords] = useState<ChordLabel[] | null>(null);
  /** 调号手动覆盖（null = 使用自动检测，§3.3） */
  const [keyOverride, setKeyOverride] = useState<KeySelection | null>(null);
  // ---- 变速段（§3.5）----
  const [tempoSections, setTempoSections] = useState<BeatSection[] | null>(null);
  const [tempoCandidates, setTempoCandidates] = useState<TempoCandidate[]>([]);
  const [autoApplied, setAutoApplied] = useState<TempoCandidate | null>(null);
  const tempoUndoRef = useRef<BeatSection[] | null>(null);
  const [ignoredRef] = useState(() => ({ current: new Set<string>() }));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('tier');
  // ---- 真实音频转谱（§6 Step 3 轻量档闭环）----
  /** 当前音频时长（秒），变速插段需要 */
  const [audioDurationSec, setAudioDurationSec] = useState(0);
  const [isRealAudio, setIsRealAudio] = useState(false);
  /** 当前转写源音符（demo 或 basic-pitch 产物），变速改动后全链路重算共用 */
  const notesSourceRef = useRef<RawNote[] | null>(null);
  /** 最近一次前处理产物（BPM 重新检测用） */
  const samplesRef = useRef<{ samples: Float32Array; sampleRate: number } | null>(null);
  const separationNoticeRef = useRef<string | null>(null);
  const sourceSettingsRef = useRef<{
    tier: PerformanceTier;
    bandpass: boolean;
    startedAt: number;
    sourceRevision: number;
  } | null>(null);
  const activeFileRef = useRef<File | null>(null);
  const activeAbortRef = useRef<AbortController | null>(null);
  const rerunTierRef = useRef(false);
  const runRevisionRef = useRef(0);
  // ---- Copilot（BYOK）----
  /** 和弦标注来源/降级说明（逐小节结果在 chords） */
  const [chordMeta, setChordMeta] = useState<{ source: ChordAnnotationSource; notice?: string } | null>(null);
  /** AI 改谱待确认预览（采纳才落谱，§1.3 前置校验 → 确认流） */
  const [rewritePreview, setRewritePreview] = useState<AiRewriteResult | null>(null);
  /** 双吉他拆轨预览（Lead/Rhythm 待选用） */
  const [splitPreview, setSplitPreview] = useState<SplitResult | null>(null);
  /** AI 改谱回滚栈（§2.2 snapshot 的会话内轻量版） */
  const aiHistoryRef = useRef<{
    tex: string; label: string; lastRun: LastRun; sourceNotes: RawNote[] | null;
  }[]>([]);
  const copilotVersionRef = useRef(0);
  const [aiCanUndo, setAiCanUndo] = useState(false);
  // ---- §3.4 原曲对照（原曲 + MIDI 合成同时发声）----
  const [backingOn, setBackingOn] = useState(false);
  const backingAudioRef = useRef<HTMLAudioElement | null>(null);
  const [backingVolume, setBackingVolume] = useState(0.5);
  const [speed, setSpeed] = useState(1);
  const [status, setStatus] = useState(
    '就绪 · Step 1 界面与渲染 ✓ · Step 2 GuitarProfile 核心 ✓ · Step 3 Basic Pitch 轻量档 ✓ · Step 4 AI Copilot（BYOK）已接入 —— 拖入吉他音频即可转谱',
  );

  const openSettings = useCallback((section: SettingsSection) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);
  const onApiReady = useCallback((api: AlphaTabApi | null) => setTabApi(api), []);

  function resetCopilotContext() {
    copilotVersionRef.current += 1;
    aiHistoryRef.current = [];
    setAiCanUndo(false);
    setCopilotBusy(false);
    setChords(null);
    setChordMeta(null);
    setRewritePreview(null);
    setSplitPreview(null);
  }

  /** 统一转写入口：分段 → 网格 → 量化 → 五步流水线（变速改动后全链路重算） */
  async function runTranscription(source: RawNote[], sections: BeatSection[], tempoNote?: string): Promise<boolean> {
    const revision = runRevisionRef.current;
    resetCopilotContext();
    setBusy(true);
    await new Promise((r) => setTimeout(r, 30));
    if (revision !== runRevisionRef.current) return false;
    try {
      if (isRealAudio && separationNoticeRef.current) {
        tempoNote = `${tempoNote ? `${tempoNote} · ` : ''}${separationNoticeRef.current}`;
      }
      const profile = await ProfileRegistry.get('guitar');
      const beatGrid = buildBeatGridFromSections(sections);
      const styleName = FINGERING_STYLE_LABEL[settings.fingeringStyle].label;
      // 量化强度设置真实作用于转写流水线（分段感知，含三连音双网格）
      const rawNotes = quantizeNotes(source, beatGrid, settings.quantizeStrength);
      const result = profile.transcribe(rawNotes, {
        beatGrid,
        style: settings.fingeringStyle,
        keyOverride,
      });
      setTex(result.alphaTex);
      setLastRun({ rawNotes, beatGrid, result });
      setChords(null);
      const top = result.meta.suggestedCapo?.[0];
      const key = result.meta.key;
      const harmonics = result.notes.filter((n) => n.suspectedHarmonic).length;
      setStatus(
        `转写完成：${result.notes.length} 个音符 → alphaTex ${result.alphaTex.length} 字符 · 调性 ${key ? `${key.name}（置信度 ${key.confidence.toFixed(2)}）` : '未识别'} · 指法风格 ${styleName} · ${tempoNote ? `${tempoNote} · ` : ''}Capo 推荐：${top?.reason ?? '—'}${harmonics ? ` · 疑似泛音 ${harmonics} 已标记（不入谱，编辑器可处置）` : ''}`,
      );
      return true;
    } catch (e) {
      setStatus(`转写失败：${String(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function runDemo() {
    activeAbortRef.current?.abort();
    runRevisionRef.current += 1;
    activeFileRef.current = null;
    sourceSettingsRef.current = null;
    samplesRef.current = null;
    setAudio((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
    setBackingOn(false);
    resetCopilotContext();
    setBusy(true);
    setStatus('正在运行 GuitarProfile 五步流水线：过滤 → 聚拢 → Auto-Capo → Viterbi → 技巧检测 → alphaTex…');
    // 让 UI 先渲染出运行状态
    await new Promise((r) => setTimeout(r, 50));
    // §3.5：变速候选检测（拍点序列模拟自音频 onset 检出）
    ignoredRef.current = new Set();
    const demoNotes = createDemoNotes();
    notesSourceRef.current = demoNotes;
    setIsRealAudio(false);
    setAudioDurationSec(0);
    separationNoticeRef.current = null;
    const all = detectTempoCandidates(createDemoBeatTimes());
    const visible = all.filter((c) => c.confidence >= TEMPO_CONFIRM);
    const auto = visible.filter((c) => c.confidence >= TEMPO_AUTO_APPLY);
    const confirm = visible.filter((c) => c.confidence < TEMPO_AUTO_APPLY);
    let sections = baseDemoSections();
    let tempoNote: string | undefined;
    if (auto.length > 0) {
      // 高置信度 → 自动应用不打扰（渐进 UX）
      tempoUndoRef.current = structuredClone(sections);
      sections = applyTempoCandidates(sections, auto);
      const c = auto[auto.length - 1];
      tempoNote = `检测到变速 ${Math.round(c.bpmBefore)} → ${Math.round(c.bpmAfter)} BPM（置信度 ${c.confidence}）已自动应用`;
      setAutoApplied(c);
    } else {
      tempoUndoRef.current = null;
      setAutoApplied(null);
    }
    setTempoSections(sections);
    setTempoCandidates(confirm);
    await runTranscription(demoNotes, sections, tempoNote);
  }

  /** 候选采纳（确认流） */
  async function acceptTempo(c: TempoCandidate) {
    if (!tempoSections) return;
    tempoUndoRef.current = structuredClone(tempoSections);
    const sections = applyTempoCandidates(tempoSections, [c]);
    setTempoSections(sections);
    setTempoCandidates((list) => list.filter((x) => candidateKey(x) !== candidateKey(c)));
    setAutoApplied(c);
    if (!notesSourceRef.current) return;
    await runTranscription(
      notesSourceRef.current,
      sections,
      `变速 ${Math.round(c.bpmBefore)} → ${Math.round(c.bpmAfter)} BPM 已采纳`,
    );
  }

  /** 候选忽略（本次会话不再出现） */
  function rejectTempo(c: TempoCandidate) {
    ignoredRef.current.add(candidateKey(c));
    setTempoCandidates((list) => list.filter((x) => candidateKey(x) !== candidateKey(c)));
  }

  /** 撤销最近一次变速候选：恢复该次应用前的完整分段。 */
  async function undoAutoTempo() {
    if (!notesSourceRef.current || !tempoUndoRef.current) return;
    const sections = tempoUndoRef.current;
    tempoUndoRef.current = null;
    setTempoSections(sections);
    setAutoApplied(null);
    await runTranscription(notesSourceRef.current, sections);
  }

  /** 一键插段（§3.5 手动入口 1）：小节标尺定位 → 输入 BPM → 全链路重算 */
  async function insertTempo(bar: number, bpm: number) {
    if (!tempoSections || !notesSourceRef.current) return;
    const time = barStartTime(tempoSections, bar - 1);
    const steps = tempoSections.slice(1).map((s) => ({ time: s.start, bpm: s.bpm }));
    steps.push({ time, bpm });
    const duration = isRealAudio ? audioDurationSec : DEMO_DURATION;
    const sections = buildTempoMap(duration, [4, 4], tempoSections[0]?.bpm ?? 80, steps);
    tempoUndoRef.current = null;
    setAutoApplied(null);
    setTempoSections(sections);
    await runTranscription(
      notesSourceRef.current,
      sections,
      `手动插入变速段：第 ${bar} 小节起 ${bpm} BPM`,
    );
  }

  /** 重置 BPM：demo 回恒定分段；真实音频对缓存的前处理产物重新检测 */
  async function resetTempo() {
    if (!notesSourceRef.current) return;
    setBusy(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      const sections = isRealAudio && samplesRef.current
        ? detectTempo(samplesRef.current.samples, samplesRef.current.sampleRate)
        : baseDemoSections();
      tempoUndoRef.current = null;
      setTempoSections(sections);
      setAutoApplied(null);
      setTempoCandidates([]);
      await runTranscription(notesSourceRef.current, sections, '已重新检测 BPM 并重排缓存音符');
    } catch (error) {
      setStatus(`BPM 重新检测失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 当前 BYOK 连接 → 引擎 LlmConfig（Key 从会话内存取；本地 Ollama 可无 Key） */
  function llmConfig(): LlmConfig | undefined {
    if (!connection) return undefined;
    return {
      providerId: connection.providerId,
      baseUrl: connection.baseUrl,
      model: connection.model,
      apiKey: getApiKey(),
    };
  }

  /** 声部共享小节时间轴，不能把各声部的竖线重复计数。 */
  function barCountOf(t: string): number {
    return countScoreBars(t);
  }

  /** AI 操作落谱（统一推入回滚栈） */
  function applyAiTex(nextTex: string, label: string, generatedRun?: LastRun): boolean {
    if (!lastRun) return false;
    let nextRun: LastRun;
    try {
      const base = generatedRun ?? lastRun;
      const parsed = readGuitarScore(nextTex);
      const velocities = new Map(base.result.notes.map((n) => [
        `${n.onset.toFixed(6)}|${n.pitch}`, n.velocity ?? 100,
      ]));
      const notes = parsed.notes.map((n) => ({
        ...n, velocity: velocities.get(`${n.onset.toFixed(6)}|${n.pitch}`) ?? 100,
      }));
      nextRun = {
        ...base,
        rawNotes: notes.map((n) => ({
          onset: n.onset, duration: n.duration, pitch: n.pitch, velocity: n.velocity,
          pitchBend: n.bend ?? [], tuplet: n.tuplet,
        })),
        result: {
          alphaTex: nextTex, notes,
          meta: { ...base.result.meta, tuning: parsed.tuning, capo: parsed.capo },
        },
      };
    } catch (error) {
      setStatus(`无法应用改谱：${String(error)}`);
      return false;
    }
    copilotVersionRef.current += 1;
    setCopilotBusy(false);
    aiHistoryRef.current.push({
      tex, label, lastRun: structuredClone(lastRun),
      sourceNotes: structuredClone(notesSourceRef.current),
    });
    if (aiHistoryRef.current.length > 20) aiHistoryRef.current.shift();
    setAiCanUndo(true);
    setTex(nextTex);
    setLastRun(nextRun);
    notesSourceRef.current = nextRun.rawNotes;
    setChords(null);
    setChordMeta(null);
    setRewritePreview(null);
    setSplitPreview(null);
    return true;
  }

  /** 撤销最近一次 AI 改谱/拆轨落谱 */
  function undoAiEdit() {
    const prev = aiHistoryRef.current.pop();
    if (!prev) return;
    copilotVersionRef.current += 1;
    setCopilotBusy(false);
    setAiCanUndo(aiHistoryRef.current.length > 0);
    setTex(prev.tex);
    setLastRun(prev.lastRun);
    notesSourceRef.current = prev.sourceNotes;
    setTempoSections(prev.lastRun.beatGrid.sections);
    setChords(null);
    setChordMeta(null);
    setRewritePreview(null);
    setSplitPreview(null);
    setStatus(`已撤销：${prev.label}`);
  }

  /** Copilot：自动标注和弦 —— 已连接走 LLM（失败自动降级本地），未连接走本地规则（§1.3） */
  async function annotateChords() {
    if (!lastRun || busy || copilotBusy) return;
    const version = ++copilotVersionRef.current;
    setCopilotBusy(true);
    setChordMeta(null);
    await new Promise((r) => setTimeout(r, 30));
    try {
      if (version !== copilotVersionRef.current) return;
      const out = await annotateChordsEngine({
        notes: lastRun.result.notes,
        beatGrid: lastRun.beatGrid,
        alphaTex: tex,
        barCount: barCountOf(tex),
        key: lastRun.result.meta.key?.name,
        llm: llmConfig(),
      });
      if (version !== copilotVersionRef.current) return;
      setChords(out.chords);
      setChordMeta({ source: out.source, notice: out.notice });
      const srcLabel =
        out.source === 'llm' ? '大模型' : out.source === 'local' ? '本地规则 · 离线' : '本地降级';
      setStatus(
        `和弦标注完成（${srcLabel}）：${out.chords.map((l) => l.name).join(' | ')}${out.notice ? ` · ${out.notice}` : ''}`,
      );
    } catch (e) {
      if (version === copilotVersionRef.current) setStatus(`和弦标注失败：${String(e)}`);
    } finally {
      if (version === copilotVersionRef.current) setCopilotBusy(false);
    }
  }

  /** Copilot：新手简化改谱 —— 用省力档权重重新寻路（本地规则，瞬时离线） */
  function simplifyForBeginner() {
    if (!lastRun || busy || copilotBusy) return;
    const version = ++copilotVersionRef.current;
    setCopilotBusy(true);
    setStatus('正在按省力档（新手）权重重新寻路…');
    setTimeout(async () => {
      try {
        const profile = await ProfileRegistry.get('guitar');
        if (version !== copilotVersionRef.current) return;
        const result = profile.transcribe(lastRun.rawNotes, {
          beatGrid: lastRun.beatGrid,
          style: 'easy',
          keyOverride,
        });
        if (!applyAiTex(result.alphaTex, '新手简化（省力档重排）', { ...lastRun, result })) return;
        setStatus(
          `新手简化改谱完成：${result.notes.length} 个音符已按省力档重排指法（空弦偏好 ↑ · 跨度放宽 · 低把位偏好 ↑）· 可撤销`,
        );
      } catch (e) {
        if (version === copilotVersionRef.current) setStatus(`简化改谱失败：${String(e)}`);
      } finally {
        if (version === copilotVersionRef.current) setCopilotBusy(false);
      }
    }, 50);
  }

  /** Copilot：AI 改谱（LLM 两轮 + 前置校验；产出进预览，采纳才落谱） */
  async function runRewrite(instruction: string) {
    if (!lastRun || !instruction.trim() || busy || copilotBusy) return;
    const version = ++copilotVersionRef.current;
    setCopilotBusy(true);
    setRewritePreview(null);
    const connectedLabel = connection ? `${connection.label} · ${connection.model}` : '';
    setStatus(
      connection
        ? `AI 改谱中（${connectedLabel}）：${instruction.trim()}…`
        : '未连接大模型 —— 正在检查本地规则是否支持此要求…',
    );
    await new Promise((r) => setTimeout(r, 30));
    try {
      if (version !== copilotVersionRef.current) return;
      const meta = lastRun.result.meta;
      const out = await rewriteAlphaTexEngine({
        alphaTex: tex,
        instruction,
        notes: lastRun.result.notes,
        tuning: meta.tuning,
        capo: meta.capo,
        retex: async (notes) => {
          const [{ toAlphaTex }, { resolveWeights }] = await Promise.all([
            import('./profiles/GuitarProfile'), import('./profiles/costWeights'),
          ]);
          return toAlphaTex(notes, {
            config: { tuning: meta.tuning, capo: meta.capo },
            tuning: { tuning: meta.tuning, capo: meta.capo, suggestions: [], autoDetected: false },
            beatGrid: lastRun.beatGrid,
            key: meta.key,
            keyOverride,
            style: settings.fingeringStyle,
            weights: resolveWeights(settings.fingeringStyle),
          });
        },
        llm: llmConfig(),
      });
      if (version !== copilotVersionRef.current) return;
      if (out.alphaTex === tex) {
        setRewritePreview(null);
        setStatus(`谱面未修改：${out.notice ?? '本次请求没有产生可采纳的改动'}`);
        return;
      }
      setRewritePreview(out);
      const src =
        out.source === 'llm' ? '已通过前置校验，请预览确认' : `本地降级：${out.notice ?? ''}`;
      setStatus(`AI 改谱完成（${out.source === 'llm' ? '大模型' : '本地降级'}）· ${src}`);
    } catch (e) {
      if (version === copilotVersionRef.current) setStatus(`AI 改谱失败：${String(e)}`);
    } finally {
      if (version === copilotVersionRef.current) setCopilotBusy(false);
    }
  }

  /** 采纳 AI 改谱预览 → 落谱 */
  function acceptRewrite() {
    if (!rewritePreview) return;
    if (!applyAiTex(rewritePreview.alphaTex, 'AI 改谱')) return;
    setStatus('AI 改谱已落谱 · 可撤销');
  }

  /** Copilot：双吉他拆轨（LLM 专属，无本地降级 → 未连接禁用） */
  async function runSplit() {
    if (!lastRun || !connection || busy || copilotBusy) return;
    const version = ++copilotVersionRef.current;
    setCopilotBusy(true);
    setSplitPreview(null);
    setStatus(`双吉他拆轨中（${connection.label} · ${connection.model}）…`);
    await new Promise((r) => setTimeout(r, 30));
    try {
      if (version !== copilotVersionRef.current) return;
      const out = await splitGuitarsEngine({ alphaTex: tex, llm: llmConfig() });
      if (version !== copilotVersionRef.current) return;
      setSplitPreview(out);
      setStatus('拆轨完成 · 两轨均通过前置校验，请预览并选择要应用的轨');
    } catch (e) {
      if (version === copilotVersionRef.current) setStatus(`双吉他拆轨失败：${String(e)}`);
    } finally {
      if (version === copilotVersionRef.current) setCopilotBusy(false);
    }
  }

  function onFile(file: File) {
    if (busy) return;
    if (audio) URL.revokeObjectURL(audio.url);
    setTex(DEMO_ALPHA_TEX);
    setLastRun(null);
    setTempoSections(null);
    setTempoCandidates([]);
    setAutoApplied(null);
    setAudio({ url: URL.createObjectURL(file), name: file.name, size: file.size });
    void transcribeFile(file);
  }

  /** §6 Step 3 轻量档闭环：文件 → 前处理 → BPM 检测 → Basic Pitch → GuitarProfile → 谱面 */
  async function transcribeFile(file: File): Promise<boolean> {
    resetCopilotContext();
    const startedAt = performance.now();
    activeFileRef.current = file;
    const task = new AbortController();
    activeAbortRef.current?.abort();
    activeAbortRef.current = task;
    const revision = ++runRevisionRef.current;
    setBusy(true);
    try {
      const tier = settings.tier;
      const originalBytes = new Uint8Array(await file.arrayBuffer());
      separationNoticeRef.current = null;
      const withBandpass = tier === 'light' && settings.bandpass;
      setStatus(
        tier === 'light'
          ? `正在解码「${file.name}」并前处理（mono${withBandpass ? ' + 轻量档带通 70Hz~8kHz' : ''}）…`
          : `正在准备「${file.name}」的分轨（${tier === 'balanced' ? '均衡档' : '高配档'}）…`,
      );
      const source =
        tier === 'light'
          ? await preprocessAudio(originalBytes.buffer as ArrayBuffer, { bandpass: withBandpass })
          : await prepareTierSource(originalBytes, tier, task.signal);
      signalThrowIfAborted(task.signal);
      setAudioDurationSec(source.samples.length / source.sampleRate);
      const pipelineOk = await runRealPipeline(source, startedAt);
      if (!pipelineOk) return false;
      signalThrowIfAborted(task.signal);
      if (revision !== runRevisionRef.current) return false;
      sourceSettingsRef.current = {
        tier,
        bandpass: settings.bandpass,
        startedAt,
        sourceRevision: revision,
      };
    } catch (e) {
      const cancelled = task.signal.aborted ||
        ((e as { name?: string }).name === 'SeparatorError' &&
          (e as { kind?: string }).kind === 'aborted');
      if (cancelled) setStatus('转写已取消');
      else setStatus(`转谱失败：${String(e)}`);
      return false;
    } finally {
      if (activeAbortRef.current === task) activeAbortRef.current = null;
      rerunTierRef.current = false;
      setBusy(false);
    }
    return true;
  }

  /** 出谱后切换档位：用原曲字节重跑分轨与转写；转写中禁止切档。 */
  useEffect(() => {
    const current = sourceSettingsRef.current;
    const source = activeFileRef.current;
    if (!current || !source || busy || rerunTierRef.current) return;
    const changed =
      current.tier !== settings.tier ||
      (settings.tier === 'light' && current.bandpass !== settings.bandpass);
    if (!changed) return;
    current.tier = settings.tier;
    current.bandpass = settings.bandpass;
    rerunTierRef.current = true;
    void transcribeFile(source);
  }, [settings.tier, settings.bandpass, busy]);

  /**
   * 均衡/高配必须先从混音提取 guitar.wav，再走与轻量档相同的 Basic Pitch。
   * 失败时由 TierRouter 返回 light 并带 notice，不会把原曲伪装成已分轨。
   */
  async function prepareTierSource(
    originalBytes: Uint8Array,
    tier: SeparationTier,
    signal: AbortSignal,
  ): Promise<{ samples: Float32Array; sampleRate: number }> {
    if (!isDesktopRuntime()) {
      const notice = '当前浏览器无法运行分轨引擎，已自动回落轻量档直接转写';
      separationNoticeRef.current = notice;
      setStatus(`${notice}…`);
      return preprocessAudio(originalBytes.buffer as ArrayBuffer, {
        bandpass: settings.bandpass,
      });
    }

    const originalBuffer = await decodeToAudioBuffer(originalBytes.buffer as ArrayBuffer);
    const inputPcm = await audioBufferToSamples(originalBuffer);
    const separationInput = encodePcm16Wav(inputPcm.samples, inputPcm.sampleRate);
    const fs = await prepareDesktopFs();
    const unsubscribe = subscribeDesktopSeparation((event) => {
      if (event.stream === 'stdout') {
        const pct = /progress[=:]\s*(\d+(?:\.\d+)?)/i.exec(event.data);
        if (pct) {
          setStatus(
            `分轨中（${tier === 'balanced' ? '均衡档' : '高配档'}）… ${Math.round(Number(pct[1]))}%`,
          );
        }
      }
    });
    try {
      const routed = await routeTier({
        tier,
        inputPath: 'input.wav',
        inputBytes: () => Promise.resolve(separationInput),
        workRoot: 'runtime',
        fs,
        signal,
        isRuntimeAvailable: () => true,
        runSeparationImpl: (_input, opts) =>
          runDesktopSeparation(separationInput, {
            ...opts,
            tier,
            fs,
            signal,
          }),
        onNotice: (notice) => {
          separationNoticeRef.current = notice;
        },
        onProgress: (pct) =>
          setStatus(
            `分轨中（${tier === 'balanced' ? '均衡档' : '高配档'}）… ${Math.round(pct)}%`,
          ),
      });
      if (routed.notice) {
        separationNoticeRef.current = routed.notice;
      }
      if (routed.mode === 'light') {
        return preprocessAudio(originalBytes.buffer as ArrayBuffer, {
          bandpass: settings.bandpass,
        });
      }
      const guitarPath = routed.stems.guitar;
      if (!guitarPath) throw new Error('分轨结果缺少 guitar.wav');
      const guitarBytes = await fs.readFile(guitarPath);
      const audioBuffer = await decodeToAudioBuffer(guitarBytes.buffer as ArrayBuffer);
      return audioBufferToSamples(audioBuffer);
    } finally {
      unsubscribe();
    }
  }

  /**
   * 桌面分轨的 stem 字节需要经 FsAdapter 交给 TierRouter 缓存。
   * 若 WebView 的 OPFS 不可用，则用一次性内存适配器；分轨结果仍会写入
   * stems-cache 并由当前转写消费，但跨重启的 OPFS 缓存需平台支持。
   */
  function prepareDesktopFs(): Promise<FsAdapter> {
    return OpfsFsAdapter.isSupported()
      ? OpfsFsAdapter.create('.agtp')
      : Promise.resolve(new MemoryFsAdapter());
  }

  /** BPM 检测 + Basic Pitch 推理（变速重置时对缓存的前处理产物重跑） */
  async function runRealPipeline(
    pre: { samples: Float32Array; sampleRate: number },
    startedAt: number,
    note?: string,
  ) {
    const previousNotes = notesSourceRef.current;
    const previousSections = tempoSections;
    samplesRef.current = pre;
    const durationSec = pre.samples.length / pre.sampleRate;
    const chunkNote =
      durationSec > MAX_CHUNK_SECONDS ? ' · 长曲将按 §3.2 静音切点分段推理' : '';
    setStatus(`正在检测节拍与分段 BPM（§3.1 HFC onset + 谐波相关）…${chunkNote}`);
    await new Promise((r) => setTimeout(r, 30));
    const sections = detectTempo(pre.samples, pre.sampleRate);
    const bpms = [...new Set(sections.map((s) => Math.round(s.bpm)))].join(' → ');
    setStatus(`BPM 检测完成（${sections.length} 段${bpms ? `：${bpms}` : ''}）· Basic Pitch 推理中…`);
    await new Promise((r) => setTimeout(r, 30));
    const raw = await transcribeAudio(pre.samples, pre.sampleRate, (pct) => {
      setStatus(`Basic Pitch 推理中… ${Math.round(pct)}%`);
    });
    notesSourceRef.current = raw;
    setIsRealAudio(true);
    ignoredRef.current = new Set();
    // 面板与本次实际用于出谱的节拍分段保持一致，替换上一首或演示曲的状态。
    setTempoSections(sections);
    tempoUndoRef.current = null;
    setTempoCandidates([]);
    setAutoApplied(null);
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
    const ok = await runTranscription(raw, sections, `${note ? `${note} · ` : ''}${bpms} BPM · 耗时 ${elapsed}s`);
    if (!ok) {
      // 出谱失败时还原转写上下文，避免旧谱面与新音频状态混用。
      notesSourceRef.current = previousNotes;
      setTempoSections(previousSections);
      return false;
    }
    return true;
  }

  /** 加载演示点击轨（§3.5 网格 overlay 验证：拍点与演示曲一致，可听出 80→60 变速） */
  async function loadDemoAudio() {
    try {
      const res = await fetch('/demo/click.wav');
      const blob = await res.blob();
      onFile(new File([blob], 'demo-click-80-60.wav', { type: 'audio/wav' }));
    } catch (e) {
      setStatus(`演示音频加载失败：${String(e)}`);
    }
  }

  function clearAudio() {
    activeAbortRef.current?.abort();
    runRevisionRef.current += 1;
    activeFileRef.current = null;
    sourceSettingsRef.current = null;
    notesSourceRef.current = null;
    samplesRef.current = null;
    rerunTierRef.current = false;
    resetCopilotContext();
    if (audio) URL.revokeObjectURL(audio.url);
    setAudio(null);
    setBackingOn(false);
  }

  // §3.4 原曲同步混播：谱面（MIDI 合成）与原曲同时发声对照；alphaTab 时钟驱动，
  // 漂移超过 150ms 即回同步。alphaTab 原生 BackingTrackPlayer 是"替代合成器"而非
  // 混音（源码 fakeSynthesize），故用手动同步实现"同时听"。
  useEffect(() => {
    const el = backingAudioRef.current;
    if (!tabApi || !el || !backingOn || !audio) return;
    el.volume = backingVolume;
    el.playbackRate = speed;
    const sync = () => {
      const t = tabApi.timePosition / 1000;
      if (Math.abs(el.currentTime - t) > 0.15) el.currentTime = t;
    };
    const onState = (args: { state: number }) => {
      // alphaTab PlayerState.Playing = 1（枚举未从包入口导出）
      if (args.state === 1) {
        sync();
        void el.play().catch(() => {});
      } else {
        el.pause();
      }
    };
    const onPos = () => {
      if (!el.paused) sync();
    };
    if (tabApi.playerState === 1) {
      sync();
      void el.play().catch(() => {});
    }
    tabApi.playerStateChanged.on(onState);
    tabApi.playerPositionChanged.on(onPos);
    return () => {
      tabApi.playerStateChanged.off(onState);
      tabApi.playerPositionChanged.off(onPos);
      el.pause();
    };
  }, [tabApi, backingOn, audio, backingVolume, speed]);

  return (
    <div className="flex h-full flex-col">
      <HeaderBar onOpenSettings={openSettings} />

      <main className="flex min-h-0 flex-1 gap-4 p-4">
        {/* 左：谱面工作区 */}
        <section className="flex min-w-0 flex-1 flex-col gap-3">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass min-h-0 flex-1 overflow-auto p-3"
          >
            {/* 布局切换需要重建 alphaTab 渲染器 → 以 layout 为 key 重挂载 */}
            <TabViewer
              key={settings.scoreLayout}
              tex={tex}
              display={settings}
              onApiReady={onApiReady}
            />
          </motion.div>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
            <PlaybackBar
              api={tabApi}
              detectedKey={lastRun?.result.meta.key ?? null}
              keyOverride={keyOverride}
              onKeyOverride={setKeyOverride}
              backingOn={backingOn}
              backingAvailable={!!audio}
              onToggleBacking={() => setBackingOn((v) => !v)}
              speed={speed}
              onSpeedChange={setSpeed}
            />
          </motion.div>
          {settings.showWaveform && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }}>
              <WaveformMixer
                audioUrl={audio?.url ?? null}
                fileName={audio?.name ?? null}
                onClear={clearAudio}
                beatGrid={lastRun?.beatGrid ?? null}
                backingAudioRef={backingAudioRef}
                volume={backingVolume}
                onVolumeChange={setBackingVolume}
              />
            </motion.div>
          )}
          <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
            <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 align-middle" />
            {status}
          </div>
        </section>

        {/* 右：导入与 Copilot */}
        <aside className="flex w-[340px] shrink-0 flex-col gap-4 overflow-y-auto pr-0.5">
          <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.05 }}>
            <AudioDropzone
              audio={audio ? { name: audio.name, size: audio.size } : null}
              onFile={onFile}
              onOpenSettings={openSettings}
            />
          </motion.div>
          {lastRun && tempoSections && (
            <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.09 }}>
              <TempoMapPanel
                sections={tempoSections}
                candidates={tempoCandidates}
                autoApplied={autoApplied}
                busy={busy}
                onAccept={acceptTempo}
                onReject={rejectTempo}
                onUndoAuto={undoAutoTempo}
                onInsert={insertTempo}
                onReset={resetTempo}
              />
            </motion.div>
          )}
          <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.12 }}>
            <AiCopilotPanel
              onOpenSettings={openSettings}
              hasResult={lastRun !== null}
              chords={chords}
              chordMeta={chordMeta}
              copilotBusy={copilotBusy || busy}
              connected={connection !== null}
              rewritePreview={rewritePreview}
              splitPreview={splitPreview}
              aiCanUndo={aiCanUndo}
              onAnnotateChords={annotateChords}
              onSimplify={simplifyForBeginner}
              onRunRewrite={runRewrite}
              onAcceptRewrite={acceptRewrite}
              onDiscardRewrite={() => setRewritePreview(null)}
              onUndoAiEdit={undoAiEdit}
              onRunSplit={runSplit}
              onApplySplit={(track) => {
                if (!splitPreview) return;
                if (!applyAiTex(track === 'lead' ? splitPreview.lead : splitPreview.rhythm, `应用${track === 'lead' ? '主音' : '节奏'}轨`)) return;
                setStatus(`已应用${track === 'lead' ? '主音（Lead）' : '节奏（Rhythm）'}轨为当前谱面 · 另一轨已丢弃 · 可撤销`);
              }}
              onDiscardSplit={() => setSplitPreview(null)}
            />
          </motion.div>
        </aside>
      </main>

      {/* §3.4 原曲对照：与谱面同步播放的原曲（隐藏元素，音量 50%） */}
      <audio ref={backingAudioRef} src={audio?.url} preload="auto" className="hidden" />

      <AnimatePresence>
        {settingsOpen && (
          <SettingsModal
            initialSection={settingsSection}
            onClose={() => setSettingsOpen(false)}
            busy={busy}
            onRunDemo={() => {
              setSettingsOpen(false);
              void runDemo();
            }}
            onLoadDemoAudio={() => {
              setSettingsOpen(false);
              void loadDemoAudio();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  return (
    <SettingsProvider>
      <CopilotProvider>
        <AppShell />
      </CopilotProvider>
    </SettingsProvider>
  );
}

/** MotionConfig 必须在 SettingsProvider 内部才能读取动效开关 */
function AppShell() {
  const { settings } = useSettings();
  return (
    <MotionConfig reducedMotion={settings.animations ? 'never' : 'always'}>
      <Workspace />
    </MotionConfig>
  );
}
