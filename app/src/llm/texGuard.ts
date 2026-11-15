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
  try {
    let count = 0;
    for (const track of readScore(tex).tracks) {
      for (const staff of track.staves) {
        for (const bar of staff.bars) {
          for (const voice of bar.voices) {
            for (const beat of voice.beats) count += beat.notes.filter((n) => !n.isTieDestination).length;
          }
        }
      }
    }
    return count;
  } catch { /* 无法解析时仍为错误预览提供近似统计。 */ }
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

function barFingerprints(tex: string): string[] | null {
  try {
    const score = readScore(tex);
    return score.masterBars.map((master, index) => JSON.stringify({
      signature: [master.timeSignatureNumerator, master.timeSignatureDenominator],
      tempo: master.tempoAutomations.map((a) => [a.value, a.ratioPosition, a.isLinear]),
      tracks: score.tracks.map((track) => track.staves.map((staff) => {
        const bar = staff.bars[index];
        return bar ? {
          key: [bar.keySignature, bar.keySignatureType],
          voices: bar.voices.map((voice) => voice.beats.map((beat) => ({
            start: beat.playbackStart, duration: beat.playbackDuration,
            notes: beat.notes.map((note) => JSON.stringify({
              string: note.string, fret: note.fret, pitch: note.realValue,
              tie: note.isTieDestination, palmMute: note.isPalmMute,
              hammerPull: note.isHammerPullOrigin, slide: note.slideOutType,
              bend: note.bendPoints?.map((point) => [point.offset, point.value]),
            })).sort(),
          }))),
        } : null;
      })),
    }));
  } catch { return null; }
}

/** 按共享小节时间轴比较各声部，输出变更小节号（1 基）与增删量。 */
export function diffBars(before: string, after: string): BarDiff {
  const parsedBefore = barFingerprints(before);
  const parsedAfter = barFingerprints(after);
  const a = parsedBefore && parsedAfter ? parsedBefore : splitBars(before);
  const b = parsedBefore && parsedAfter ? parsedAfter : splitBars(after);
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

/** Reposition preserves notes; arrangement permits note edits, e.g. split tracks. */
export type TexEditPolicy = 'reposition' | 'arrange';

function readScore(tex: string): alphaTab.model.Score {
  if (!tex.trim()) throw new Error('alphaTex 为空');
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(tex, new alphaTab.Settings());
  return importer.readScore();
}

function semantics(score: alphaTab.model.Score) {
  return {
    tempo: {
      initial: score.tempo,
      points: score.masterBars.flatMap((bar) =>
        bar.tempoAutomations.map((a) => ({
          bar: bar.index,
          // Compare a musical location, not the order of BPM numbers in text.
          tick: Math.round(a.ratioPosition * bar.calculateDuration() * 1e6) / 1e6,
          bpm: a.value,
          linear: a.isLinear,
          visible: a.isVisible,
        })),
      ),
    },
    structure: score.masterBars.map((bar) => ({
      timeSignature: [bar.timeSignatureNumerator, bar.timeSignatureDenominator],
      duration: bar.calculateDuration(),
      pickup: bar.isAnacrusis,
      freeTime: bar.isFreeTime,
      repeatStart: bar.isRepeatStart,
      repeatCount: bar.repeatCount,
      alternateEndings: bar.alternateEndings,
      tripletFeel: bar.tripletFeel,
      directions: [...(bar.directions ?? [])].sort(),
    })),
    instruments: score.tracks.map((track) =>
      track.staves.map((staff) => ({
        tuning: staff.stringTuning.tunings,
        capo: staff.capo,
        transposition: staff.transpositionPitch,
        displayTransposition: staff.displayTranspositionPitch,
        mute: track.playbackInfo.isMute,
        solo: track.playbackInfo.isSolo,
      })),
    ),
    keys: score.tracks.map((track) =>
      track.staves.map((staff) =>
        staff.bars.map((bar) => [bar.keySignature, bar.keySignatureType]),
      ),
    ),
    music: score.tracks.map((track) =>
      track.staves.map((staff) =>
        staff.bars.map((bar) =>
          bar.voices.map((voice) =>
            voice.beats.map((beat) => ({
              start: beat.playbackStart,
              duration: beat.playbackDuration,
              grace: beat.graceType,
              notes: beat.notes.map((note) => JSON.stringify({
                pitch: note.realValue,
                tie: note.isTieDestination,
                dead: note.isDead,
                ghost: note.isGhost,
                staccato: note.isStaccato,
                palmMute: note.isPalmMute,
                letRing: note.isLetRing,
                harmonic: [note.harmonicType, note.harmonicValue],
                bend: note.bendPoints?.map((p) => [p.offset, p.value]) ?? [],
                trill: note.isTrill ? note.trillValue : null,
                hammerPull: note.isHammerPullOrigin,
                slide: note.slideOutType,
              })).sort(),
            })),
          ),
        ),
      ),
    ),
  };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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

/** Compare parsed musical semantics; note equality is opt-in for repositioning. */
export function reviewTexEdit(
  before: string,
  after: string,
  policy: TexEditPolicy = 'arrange',
): TexEditReview {
  const issues: string[] = [];
  let original: alphaTab.model.Score | undefined;
  let candidate: alphaTab.model.Score | undefined;
  try { original = readScore(before); }
  catch (e) { issues.push(`原谱不可解析：${(e as Error).message}`); }
  try { candidate = readScore(after); }
  catch (e) { issues.push(`输出不可解析：${(e as Error).message}`); }

  const tempoBefore = extractTempoMarkers(before);
  const tempoAfter = extractTempoMarkers(after);
  const barsBefore = original?.masterBars.length ?? splitBars(before).length;
  const barsAfter = candidate?.masterBars.length ?? splitBars(after).length;
  if (original && candidate) {
    const a = semantics(original);
    const b = semantics(candidate);
    if (!same(a.tempo, b.tempo)) issues.push('\\tempo 的 BPM、所在小节或拍点发生变化（含新增/删除）');
    if (!same(a.structure, b.structure)) issues.push('小节结构变化：小节数、拍号、弱起或反复结构不一致');
    if (!same(a.instruments, b.instruments)) issues.push('调弦、Capo 或移调设置发生变化');
    if (!same(a.keys, b.keys)) issues.push('调号或调号所在小节发生变化');
    if (policy === 'reposition' && !same(a.music, b.music)) {
      issues.push('降把位必须保留每小节/拍点的实际音高、时值、和弦及延音语义');
    }
    const declared = (bar: alphaTab.model.MasterBar) => bar.calculateDuration();
    for (const masterBar of candidate.masterBars) {
      const limit = declared(masterBar);
      const filled = candidate.tracks.flatMap((track) =>
        track.staves.flatMap((staff) => staff.bars[masterBar.index]?.voices ?? []),
      ).reduce((end: number, voice) => {
        const beats = voice?.beats ?? [];
        return Math.max(end, beats.reduce((beatEnd, beat) =>
          Math.max(beatEnd, beat.playbackStart + beat.playbackDuration), 0));
      }, 0);
      if (filled > limit) {
        issues.push(`第 ${masterBar.index + 1} 小节装入 ${filled} ticks，超过拍号声部容量 ${limit} ticks`);
      }
    }
    if (policy === 'reposition') {
      for (const track of candidate.tracks) {
        for (const staff of track.staves) {
          for (const bar of staff.bars) {
            const used = new Map<number, number>();
            for (const voice of bar.voices) {
              for (const beat of voice.beats) {
                for (const note of beat.notes.filter((n) => n.isStringed)) {
                  const start = bar.masterBar.start + beat.playbackStart;
                  const end = start + beat.playbackDuration;
                  const previous = used.get(note.string);
                  if (previous !== undefined && start < previous) {
                    issues.push('降把位产生跨声部同弦冲突');
                  }
                  used.set(note.string, Math.max(previous ?? 0, end));
                }
              }
            }
          }
        }
      }
    }
  }

  const diff = diffBars(before, after);
  const verdict = issues.length === 0 ? 'accept' : 'reject';

  return {
    verdict,
    issues,
    stats: {
      barsBefore,
      barsAfter,
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
