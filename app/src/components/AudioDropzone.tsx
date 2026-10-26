import { useCallback, useState } from 'react';
import { UploadCloud, AudioWaveform, ChevronRight } from 'lucide-react';
import { useSettings } from '../settings';
import { TIER_INFO } from '../types';
import type { SettingsSection } from '../settings';

type Props = {
  audio: { name: string; size: number } | null;
  onFile: (file: File) => void;
  onOpenSettings: (section: SettingsSection) => void;
};

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 音频拖拽导入（档位等设置统一收纳在设置面板 → 档位设置；演示素材在 设置 → 测试） */
export default function AudioDropzone({ audio, onFile, onOpenSettings }: Props) {
  const [dragging, setDragging] = useState(false);
  const { settings } = useSettings();
  const tierInfo = TIER_INFO[settings.tier];
  const inputRef = useCallback((el: HTMLInputElement | null) => {
    el?.addEventListener('change', () => {
      const f = el.files?.[0];
      if (f) onFile(f);
      el.value = '';
    });
  }, [onFile]);

  return (
    <div className="glass p-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        onClick={() => document.getElementById('audio-file-input')?.click()}
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-7 text-center transition-colors ${
          dragging
            ? 'border-accent-strong bg-accent-soft'
            : 'border-white/15 bg-white/[0.02] hover-border-accent hover:bg-accent-soft'
        }`}
      >
        <input
          id="audio-file-input"
          type="file"
          accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg"
          className="hidden"
          ref={inputRef}
        />
        <UploadCloud className={`h-7 w-7 ${dragging ? 'text-accent' : 'text-zinc-500'}`} />
        <div className="text-sm text-zinc-300">拖入音频，或点击选择文件</div>
        <div className="text-[11px] text-zinc-600">MP3 / WAV / FLAC / M4A · 本地处理，不上传任何数据</div>
        {audio && (
          <div className="mt-1 flex items-center gap-1.5 rounded-lg bg-accent-soft px-2.5 py-1 text-[11px] text-accent">
            <AudioWaveform className="h-3.5 w-3.5" />
            {audio.name} · {formatSize(audio.size)}
          </div>
        )}
      </div>

      {/* 当前档位（详细设置在 设置面板 → 档位设置）；演示/测试素材统一收纳在 设置 → 测试，不在主页露出 */}
      <button
        onClick={() => onOpenSettings('tier')}
        className="group mt-3 flex w-full items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover-border-accent"
      >
        <span className="text-[11px] text-zinc-500">当前档位</span>
        <span className="text-[11px] font-medium text-zinc-200">{tierInfo.label}</span>
        <span className="text-[10px] text-zinc-600">{tierInfo.time}</span>
        <ChevronRight className="ml-auto h-3.5 w-3.5 text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
      </button>
    </div>
  );
}
