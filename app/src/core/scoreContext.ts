import { importer, model, Settings } from '@coderline/alphatab';
import type { FrettedNote } from '../profiles/IInstrumentProfile';

export function countScoreBars(tex: string): number {
  const reader = new importer.AlphaTexImporter();
  reader.initFromString(tex, new Settings());
  return reader.readScore().masterBars.length;
}

/** 从实际采纳的谱面恢复后续操作所需的音符，不继续使用改谱前的数据。 */
export function readGuitarScore(tex: string): { notes: FrettedNote[]; tuning: number[]; capo: number } {
  const reader = new importer.AlphaTexImporter();
  reader.initFromString(tex, new Settings());
  const score = reader.readScore();
  if (score.tracks.length !== 1 || score.tracks[0].staves.length !== 1) {
    throw new Error('当前改谱操作需要单轨吉他谱');
  }
  const staff = score.tracks[0].staves[0];
  const changes = [{ tick: 0, bpm: score.tempo }];
  for (const bar of score.masterBars) {
    for (const automation of bar.tempoAutomations) {
      if (automation.isLinear) throw new Error('当前改谱上下文暂不支持连续速度渐变');
      changes.push({ tick: bar.start + automation.ratioPosition * bar.calculateDuration(), bpm: automation.value });
    }
  }
  changes.sort((a, b) => a.tick - b.tick);
  const secondsAt = (tick: number) => {
    let seconds = 0;
    let cursor = 0;
    let bpm = changes[0].bpm;
    for (const change of changes) {
      if (change.tick > tick) break;
      seconds += (change.tick - cursor) / 960 * 60 / bpm;
      cursor = change.tick;
      bpm = change.bpm;
    }
    return seconds + (tick - cursor) / 960 * 60 / bpm;
  };
  const notes: FrettedNote[] = [];
  const origins = new Map<model.Note, FrettedNote>();
  for (const bar of staff.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        const tick = bar.masterBar.start + beat.playbackStart;
        const onset = secondsAt(tick);
        const end = secondsAt(tick + beat.playbackDuration);
        for (const note of beat.notes) {
          if (!note.isStringed || !Number.isFinite(note.realValue)) {
            throw new Error('改谱音符缺少有效弦品，无法同步后续操作');
          }
          if (note.isTieDestination) {
            const origin = note.tieOrigin && origins.get(note.tieOrigin);
            if (!origin) throw new Error('改谱延音缺少有效起音');
            origin.duration = Math.max(origin.duration, end - origin.onset);
          if (note.bendPoints?.length) {
            const originEnd = origin.onset + origin.duration;
            const points = note.bendPoints.map((point) => ({
              time: origin.onset + (originEnd - origin.onset) * point.offset / model.BendPoint.MaxPosition,
              cents: point.value * 50,
            }));
            const originBend = origin.bend ?? [];
            origin.bend = [...originBend, ...points.filter((p) =>
              !originBend.some((q) => Math.abs(q.time - p.time) < 1e-6 && Math.abs(q.cents - p.cents) < 1e-6),
            )].sort((a, b) => a.time - b.time);
            origin.techniques = [...(origin.techniques ?? [])];
            if (!origin.techniques?.includes('bend')) origin.techniques.push('bend');
          }
            origins.set(note, origin);
            continue;
          }
          const techniques: NonNullable<FrettedNote['techniques']> = [];
          if (note.isPalmMute) techniques.push('palmMute');
          if (note.isHammerPullOrigin) techniques.push('hammer');
          if (note.slideOutType !== model.SlideOutType.None) techniques.push('slide');
          const bend = note.bendPoints?.map((point) => ({
            time: onset + (end - onset) * point.offset / model.BendPoint.MaxPosition,
            cents: point.value * 50,
          }));
          if (bend?.length) techniques.push('bend');
          const fretted: FrettedNote = {
            // alphaTab 模型弦号与 alphaTex 输入/本项目高音弦=1 的方向相反。
            string: staff.stringTuning.tunings.length - note.string + 1,
            fret: note.fret, pitch: note.realValue,
            onset, duration: end - onset, techniques, bend,
            tuplet: beat.tupletNumerator === 3 ? '3' : undefined,
          };
          notes.push(fretted);
          origins.set(note, fretted);
        }
      }
    }
  }
  return { notes: notes.sort((a, b) => a.onset - b.onset || a.string - b.string),
    tuning: [...staff.stringTuning.tunings].reverse(), capo: staff.capo };
}
