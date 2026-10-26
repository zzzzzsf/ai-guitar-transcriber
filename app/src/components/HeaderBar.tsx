import { Guitar, Scale, Rocket, Zap, Settings2, ChevronRight } from 'lucide-react';
import { useSettings } from '../settings';
import { TIER_INFO } from '../types';
import type { SettingsSection } from '../settings';

const TIER_ICONS = { light: Zap, balanced: Scale, pro: Rocket } as const;

type Props = {
  onOpenSettings: (section: SettingsSection) => void;
};

export default function HeaderBar({ onOpenSettings }: Props) {
  const { settings } = useSettings();
  const tierInfo = TIER_INFO[settings.tier];
  const TierIcon = TIER_ICONS[settings.tier];

  return (
    <header className="flex items-center gap-4 px-5 py-3 border-b border-white/10 bg-black/30 backdrop-blur-xl">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-grad shadow-accent">
          <Guitar className="h-5 w-5 text-white" />
        </div>
        <div className="leading-tight">
          <h1 className="text-[15px] font-semibold tracking-wide">AI 智能扒谱</h1>
          <p className="text-[11px] text-zinc-500">Guitar-First · 本地离线优先 · MIT 开源</p>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {/* 当前档位徽章 → 点击进入 档位设置 */}
        <button
          onClick={() => onOpenSettings('tier')}
          title={`性能档位：${tierInfo.name} · ${tierInfo.mem}`}
          className="group flex items-center gap-2 rounded-xl border-accent bg-accent-soft py-1.5 pl-2.5 pr-2 text-xs font-medium text-accent transition-colors hover-bg-accent-soft hover:border-accent-strong"
        >
          <TierIcon className="h-3.5 w-3.5" />
          <span className="hidden md:inline">{tierInfo.label.split(' ')[1]}</span>
          <ChevronRight className="h-3 w-3 opacity-70 transition-transform group-hover:translate-x-0.5" />
        </button>

        <button
          onClick={() => onOpenSettings('general')}
          title="设置"
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-zinc-400 transition-colors hover-text-accent hover-border-accent"
        >
          <Settings2 className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
