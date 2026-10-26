import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import { Play, Pause, Volume2, FileAudio, X } from 'lucide-react';
import { ACCENT_THEMES, useSettings } from '../settings';
import { barStartsFromSections } from '../core/quantizer';
import type { BeatGrid } from '../profiles/IInstrumentProfile';

type Props = {
  audioUrl: string | null;
  fileName: string | null;
  onClear?: () => void;
  /** 当前变速表：在波形上叠加小节线（§3.5 网格 overlay，变速对错一眼可辨） */
  beatGrid?: BeatGrid | null;
};

/** 多轨波形与混音台（当前：单轨预览；分轨 Mute/Solo/推子随桌面外壳 + 分轨扩展包接入） */
export default function WaveformMixer({ audioUrl, fileName, onClear, beatGrid }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [ready, setReady] = useState(false);
  const { settings } = useSettings();
  const accentFrom = ACCENT_THEMES[settings.themeAccent].from;
  const isLight = settings.themeMode === 'light';
  const waveColor = isLight ? '#d4d4d8' : '#3f3f46';
  const cursorColor = isLight ? '#52525b' : '#a1a1aa';
  const regionStrong = isLight ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.35)';
  const regionSoft = isLight ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.16)';

  useEffect(() => {
    setReady(false);
    setPlaying(false);
    if (!audioUrl || !containerRef.current) return;
    const regions = RegionsPlugin.create();
    regionsRef.current = regions;
    const ws = WaveSurfer.create({
      container: containerRef.current,
      height: 64,
      waveColor,
      progressColor: accentFrom,
      cursorColor,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      url: audioUrl,
    });
    ws.registerPlugin(regions);
    ws.on('ready', () => {
      setReady(true);
      ws.setVolume(volume);
    });
    ws.on('play', () => setPlaying(true));
    ws.on('pause', () => setPlaying(false));
    ws.on('finish', () => setPlaying(false));
    wsRef.current = ws;
    return () => {
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  // 主题色/明暗切换：波形颜色热更新
  useEffect(() => {
    wsRef.current?.setOptions({ progressColor: accentFrom, waveColor, cursorColor });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accentFrom, waveColor, cursorColor]);

  // §3.5 网格 overlay：小节线叠加在波形上（变速对错一眼可辨）
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !ready) return;
    regions.clearRegions();
    if (!beatGrid) return;
    const { starts } = barStartsFromSections(beatGrid.sections, 400);
    starts.forEach((t, i) => {
      regions.addRegion({
        start: t,
        end: t + 0.02,
        content: i % 4 === 0 ? String(i + 1) : '',
        color: i % 4 === 0 ? regionStrong : regionSoft,
        drag: false,
        resize: false,
      });
    });
  }, [ready, beatGrid, regionStrong, regionSoft]);

  return (
    <div className="glass px-4 py-3">
      <div className="mb-2 flex items-center gap-3">
        <button
          onClick={() => wsRef.current?.playPause()}
          disabled={!ready}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-accent transition-colors hover:bg-white/15 disabled:opacity-40"
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 translate-x-[1px]" />}
        </button>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-400">
          <FileAudio className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="truncate">{fileName ?? '拖入音频文件后显示波形（原曲轨）'}</span>
        </div>
        {fileName && onClear && (
          <button
            onClick={onClear}
            title="移除音频"
            className="ml-1 rounded-md p-1 text-zinc-600 transition-colors hover:text-zinc-300"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Volume2 className="h-3.5 w-3.5 text-zinc-500" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => {
              const v = Number(e.target.value);
              setVolume(v);
              wsRef.current?.setVolume(v);
            }}
            className="w-20"
            title="原曲轨音量推子"
          />
        </div>
      </div>
      <div ref={containerRef} className="min-h-[64px]" />
      {!audioUrl && (
        <div className="-mt-[64px] flex h-[64px] items-center justify-center text-[11px] text-zinc-700">
          WaveSurfer 波形区
        </div>
      )}
    </div>
  );
}
