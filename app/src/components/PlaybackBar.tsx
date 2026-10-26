import { useEffect, useState } from 'react';
import type { AlphaTabApi } from '@coderline/alphatab';
import {
  Metronome,
  Pause,
  Play,
  Repeat,
  Square,
  Timer,
  Music4,
  Volume2,
} from 'lucide-react';
import type { KeyResult, KeySelection } from '../core/keyDetector';
import SelectMenu from './SelectMenu';

/** alphaTab PlayerState.Playing = 1（枚举未从包入口导出，用数值比较） */
const PLAYER_STATE_PLAYING = 1;

/** 播放移调/记谱移调分离（§3.4）：调号下拉覆盖 12 根音 × 大/小调 */
const KEY_TONICS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const KEY_OPTIONS: { value: string; label: string }[] = KEY_TONICS.flatMap((name, pc) => [
  { value: `${pc}:major`, label: `${name} 大调` },
  { value: `${pc}:minor`, label: `${name} 小调` },
]);

function parseKeySelection(v: string): KeySelection | null {
  if (!v) return null;
  const [pc, mode] = v.split(':');
  const tonicPc = Number(pc);
  if (!Number.isInteger(tonicPc) || (mode !== 'major' && mode !== 'minor')) return null;
  return { tonicPc, mode };
}

type Props = {
  api: AlphaTabApi | null;
  /** 当前转谱的调性检测结果（显示用） */
  detectedKey?: KeyResult | null;
  keyOverride?: KeySelection | null;
  onKeyOverride?: (v: KeySelection | null) => void;
  /** §3.4 原曲对照：播放谱面时同步播放原曲（50% 音量） */
  backingOn?: boolean;
  backingAvailable?: boolean;
  onToggleBacking?: () => void;
};

/** 谱面播放控制条 + 练习模式（§3.4：节拍器/倒计时/A-B 循环均为 alphaTab 现成 API） */
export default function PlaybackBar({
  api,
  detectedKey,
  keyOverride,
  onKeyOverride,
  backingOn = false,
  backingAvailable = false,
  onToggleBacking,
}: Props) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  // 练习模式
  const [metronome, setMetronome] = useState(false);
  const [countIn, setCountIn] = useState(false);
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  const [looping, setLooping] = useState(false);

  useEffect(() => {
    if (!api) return;
    const handler = (args: { state: number }) => {
      setPlaying(args.state === PLAYER_STATE_PLAYING);
    };
    api.playerStateChanged.on(handler);
    return () => api.playerStateChanged.off(handler);
  }, [api]);

  useEffect(() => {
    if (api) api.playbackSpeed = speed;
  }, [api, speed]);

  // 节拍器 / 倒计时（alphaTab 内置合成器通道，音量 0~3）
  useEffect(() => {
    if (api) api.metronomeVolume = metronome ? 1 : 0;
  }, [api, metronome]);
  useEffect(() => {
    if (api) api.countInVolume = countIn ? 0.9 : 0;
  }, [api, countIn]);

  // A-B 选段循环
  useEffect(() => {
    if (!api) return;
    if (looping) {
      if (loopA !== null && loopB !== null) {
        api.playbackRange = {
          startTick: Math.min(loopA, loopB),
          endTick: Math.max(loopA, loopB),
        };
      }
      api.isLooping = true;
    } else {
      api.isLooping = false;
      api.playbackRange = null;
    }
  }, [api, looping, loopA, loopB]);

  return (
    <div className="flex items-center gap-4 px-4 py-2.5 glass">
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => (playing ? api?.pause() : api?.play())}
          disabled={!api}
          title={playing ? '暂停' : '播放'}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-grad text-white shadow-accent transition-transform hover:scale-105 disabled:opacity-40 disabled:hover:scale-100"
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-[1px]" />}
        </button>
        <button
          onClick={() => api?.stop()}
          disabled={!api}
          title="停止"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-40"
        >
          <Square className="h-3 w-3" />
        </button>
      </div>

      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <span>速度</span>
        <input
          type="range"
          min={0.25}
          max={2}
          step={0.05}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          className="w-24"
        />
        <span className="w-9 tabular-nums text-zinc-300">{speed.toFixed(2)}x</span>
      </div>

      {/* 练习模式（§3.4） */}
      <div className="ml-1 flex items-center gap-1 border-l border-white/10 pl-4">
        <button
          onClick={() => setMetronome((v) => !v)}
          disabled={!api}
          title="节拍器（练习用，alphaTab 内置）"
          className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:opacity-40 ${
            metronome
              ? 'border-accent-strong bg-accent-soft text-accent'
              : 'border-white/10 bg-white/5 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Metronome className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => setCountIn((v) => !v)}
          disabled={!api}
          title="倒计时起拍（count-in，1 小节）"
          className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:opacity-40 ${
            countIn
              ? 'border-accent-strong bg-accent-soft text-accent'
              : 'border-white/10 bg-white/5 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Timer className="h-3.5 w-3.5" />
        </button>

        <div className="mx-1 h-5 w-px bg-white/10" />

        <button
          onClick={() => api && setLoopA(api.tickPosition)}
          disabled={!api}
          title={`循环起点 A${loopA !== null ? `（已设 ${Math.round(loopA)} tick）` : '：在播放/光标位置设定'}`}
          className={`h-8 min-w-8 rounded-lg border px-1.5 text-[10px] font-semibold transition-colors disabled:opacity-40 ${
            loopA !== null
              ? 'border-accent-strong bg-accent-soft text-accent'
              : 'border-white/10 bg-white/5 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          A
        </button>
        <button
          onClick={() => api && setLoopB(api.tickPosition)}
          disabled={!api}
          title={`循环终点 B${loopB !== null ? `（已设 ${Math.round(loopB)} tick）` : '：在播放/光标位置设定'}`}
          className={`h-8 min-w-8 rounded-lg border px-1.5 text-[10px] font-semibold transition-colors disabled:opacity-40 ${
            loopB !== null
              ? 'border-accent-strong bg-accent-soft text-accent'
              : 'border-white/10 bg-white/5 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          B
        </button>
        <button
          onClick={() => setLooping((v) => !v)}
          disabled={!api}
          title={`选段循环${loopA !== null && loopB !== null ? '（A-B 区间）' : '（未设 A/B 时循环全曲）'}`}
          className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:opacity-40 ${
            looping
              ? 'border-accent-strong bg-accent-soft text-accent'
              : 'border-white/10 bg-white/5 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Repeat className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 调号显示与手动改（§3.3 第 1 项：15 大小调）+ §3.4 原曲对照 */}
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={() => onToggleBacking?.()}
          disabled={!backingAvailable}
          title="原曲对照（§3.4）：播放谱面时同步播放原曲（50% 音量），核对转谱准确度或跟弹"
          className={`flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[10px] font-medium transition-colors disabled:opacity-40 ${
            backingOn
              ? 'border-accent-strong bg-accent-soft text-accent'
              : 'border-white/10 bg-white/5 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Volume2 className="h-3.5 w-3.5" />
          原曲对照
        </button>
        <Music4 className="h-3.5 w-3.5 text-zinc-500" />
        <SelectMenu
          className="min-w-40"
          value={keyOverride ? `${keyOverride.tonicPc}:${keyOverride.mode}` : ''}
          onChange={(v) => onKeyOverride?.(parseKeySelection(v))}
          items={[
            {
              kind: 'option',
              value: '',
              label: `调号${detectedKey ? `：${detectedKey.name}（自动）` : '：自动'}`,
            },
            ...KEY_OPTIONS.map((o) => ({ kind: 'option' as const, ...o })),
          ]}
          triggerClassName="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] text-zinc-300 outline-none focus:border-accent-strong"
          title="调号：默认使用自动检测结果，可手动指定后重新转谱"
          ariaLabel="调号"
        />
      </div>
    </div>
  );
}
