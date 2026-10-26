import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Bookmark,
  CheckCircle2,
  FlaskConical,
  Gauge,
  Info,
  Link2Off,
  MessageSquareText,
  Monitor,
  Palette,
  RotateCcw,
  Scale,
  Rocket,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Volume2,
  X,
  Zap,
} from 'lucide-react';
import type { PerformanceTier } from '../types';
import { TIER_INFO } from '../types';
import {
  ACCENT_THEMES,
  FINGERING_STYLE_LABEL,
  NOTE_COLORS,
  QUANTIZE_LABEL,
  resolveNoteHex,
  useSettings,
} from '../settings';
import type { AccentId, NoteColorId, SettingsSection } from '../settings';
import { COPILOT_PROVIDERS, useCopilot } from '../copilot';
import type { CopilotProviderId } from '../copilot';
import SelectMenu from './SelectMenu';
import type { SelectItem } from './SelectMenu';

type Props = {
  initialSection: SettingsSection;
  onClose: () => void;
  /** 演示流水线运行中（测试分区按钮置灰） */
  busy?: boolean;
  onRunDemo: () => void;
  onLoadDemoAudio: () => void;
};

const NAV_ITEMS: { id: SettingsSection; label: string; icon: typeof Zap }[] = [
  { id: 'tier', label: '档位设置', icon: Gauge },
  { id: 'display', label: '显示设置', icon: Monitor },
  { id: 'theme', label: '主题设置', icon: Palette },
  { id: 'copilot', label: 'AI Copilot', icon: Sparkles },
  { id: 'general', label: '通用设置', icon: SlidersHorizontal },
  { id: 'test', label: '测试', icon: FlaskConical },
  { id: 'about', label: '关于', icon: Info },
];

const TIER_ICONS: Record<PerformanceTier, typeof Zap> = {
  light: Zap,
  balanced: Scale,
  pro: Rocket,
};

const FINGERING_STYLE_IDS = ['easy', 'balanced', 'faithful'] as const;
const QUANTIZE_IDS = ['strict', 'soft', 'off'] as const;

// ---------- 通用控件 ----------

function SectionTitle({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
      {desc && <p className="mt-0.5 text-[11px] text-zinc-500">{desc}</p>}
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-white/5 bg-white/[0.02] px-3.5 py-3">
      <div className="min-w-0">
        <div className="text-xs font-medium text-zinc-200">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg border border-white/10 bg-black/30 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
            value === o.value
              ? 'bg-accent-grad-r text-white shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 rounded-full transition-colors ${
        checked ? 'bg-accent-grad-r' : 'bg-zinc-700'
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
          checked ? 'left-[22px]' : 'left-0.5'
        }`}
      />
    </button>
  );
}

// ---------- 分区：档位设置 ----------

function TierSection() {
  const { settings, update } = useSettings();
  return (
    <div className="space-y-4">
      <SectionTitle
        title="性能档位"
        desc="用户自选高低配，零硬件探测复杂度（v4.0 §3）。均衡/高配档的分轨引擎需桌面外壳（sidecar 扩展包）后开放。"
      />
      <div className="space-y-2">
        {(Object.keys(TIER_INFO) as PerformanceTier[]).map((t) => {
          const info = TIER_INFO[t];
          const Icon = TIER_ICONS[t];
          const active = settings.tier === t;
          return (
            <button
              key={t}
              onClick={() => update({ tier: t })}
              className={`w-full rounded-xl border px-3.5 py-3 text-left transition-all ${
                active
                  ? 'border-accent-strong bg-accent-soft shadow-md'
                  : 'border-white/10 bg-white/[0.02] hover:border-white/20'
              }`}
            >
              <div className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${active ? 'text-accent' : 'text-zinc-500'}`} />
                <span className="text-xs font-semibold text-zinc-100">{info.label}</span>
                <span className="text-[10px] text-zinc-600">{info.name}</span>
                {info.sidecar && (
                  <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] text-amber-400">
                    分轨引擎 · 需桌面外壳
                  </span>
                )}
                {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent-grad" />}
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">{info.desc}</p>
              <div className="mt-1 flex gap-3 text-[10px] text-zinc-600">
                <span>{info.mem}</span>
                <span>{info.time}</span>
              </div>
            </button>
          );
        })}
      </div>

      <SectionTitle title="转谱与节拍" desc="作用于 GuitarProfile 流水线与量化网格。" />
      <Row label="指法风格" hint={FINGERING_STYLE_LABEL[settings.fingeringStyle].desc}>
        <Segmented
          value={settings.fingeringStyle}
          onChange={(v) => update({ fingeringStyle: v })}
          options={FINGERING_STYLE_IDS.map((id) => ({ value: id, label: FINGERING_STYLE_LABEL[id].label }))}
        />
      </Row>
      <Row label="量化强度" hint="将音符对齐到 1/16 节拍网格（逐拍双网格检测三连音）。">
        <Segmented
          value={settings.quantizeStrength}
          onChange={(v) => update({ quantizeStrength: v })}
          options={QUANTIZE_IDS.map((id) => ({ value: id, label: QUANTIZE_LABEL[id].split('（')[0] }))}
        />
      </Row>
      <Row
        label="轻量档带通滤波"
        hint="仅轻量档：70Hz~8kHz 带通滤除底鼓/镲片串音（audioPreprocessor）。"
      >
        <Toggle checked={settings.bandpass} onChange={(v) => update({ bandpass: v })} />
      </Row>
    </div>
  );
}

// ---------- 分区：显示设置 ----------

function DisplaySection() {
  const { settings, update } = useSettings();
  return (
    <div className="space-y-3">
      <SectionTitle title="谱面" desc="alphaTab 渲染参数，改动即时生效。" />
      <Row label="谱面缩放" hint={`${Math.round(settings.scoreScale * 100)}%`}>
        <input
          type="range"
          min={0.7}
          max={1.6}
          step={0.05}
          value={settings.scoreScale}
          onChange={(e) => update({ scoreScale: Number(e.target.value) })}
          className="w-36"
        />
      </Row>
      <Row label="谱面布局" hint="横向单行适合跟播浏览；纵向页面适合整曲概览与打印。">
        <Segmented
          value={settings.scoreLayout}
          onChange={(v) => update({ scoreLayout: v })}
          options={[
            { value: 'horizontal', label: '横向单行' },
            { value: 'page', label: '纵向页面' },
          ]}
        />
      </Row>
      <Row label="跟随播放滚动" hint="播放时谱面自动滚动跟随光标。">
        <Toggle checked={settings.followPlayback} onChange={(v) => update({ followPlayback: v })} />
      </Row>
      <Row label="播放光标" hint="在谱面上显示实时播放位置光标。">
        <Toggle checked={settings.showCursor} onChange={(v) => update({ showCursor: v })} />
      </Row>

      <SectionTitle title="界面" />
      <Row label="显示波形区" hint="首页底部的 WaveSurfer 原曲波形与音量推子。">
        <Toggle checked={settings.showWaveform} onChange={(v) => update({ showWaveform: v })} />
      </Row>
      <Row label="界面动效" hint="关闭后停用面板过渡动画（低配设备更流畅）。">
        <Toggle checked={settings.animations} onChange={(v) => update({ animations: v })} />
      </Row>
    </div>
  );
}

// ---------- 分区：主题设置 ----------

function ThemeSection() {
  const { settings, update } = useSettings();
  const accentIds = Object.keys(ACCENT_THEMES) as AccentId[];
  const noteColorIds = Object.keys(NOTE_COLORS) as NoteColorId[];
  const accentFrom = ACCENT_THEMES[settings.themeAccent].from;
  return (
    <div className="space-y-4">
      <SectionTitle title="主题模式" desc="浅色模式下谱面音符自动换用深色墨水。" />
      <Row label="界面明暗" hint="深色磨砂 / 浅色纸张，切换即时生效。">
        <Segmented
          value={settings.themeMode}
          onChange={(v) => update({ themeMode: v })}
          options={[
            { value: 'dark', label: '深色' },
            { value: 'light', label: '浅色' },
          ]}
        />
      </Row>

      <SectionTitle
        title="主题色"
        desc="驱动界面全部渐变、高亮、按钮配色与谱面小节号，切换即时生效。"
      />
      <div className="grid grid-cols-5 gap-2">
        {accentIds.map((id) => {
          const t = ACCENT_THEMES[id];
          const active = settings.themeAccent === id;
          return (
            <button
              key={id}
              onClick={() => update({ themeAccent: id })}
              className={`group flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 transition-all ${
                active ? 'border-white/30 bg-white/[0.06]' : 'border-white/8 bg-white/[0.02] hover:border-white/20'
              }`}
            >
              <span
                className="h-8 w-8 rounded-full transition-transform group-hover:scale-110"
                style={{
                  backgroundImage: `linear-gradient(135deg, ${t.from}, ${t.to})`,
                  boxShadow: active
                    ? `0 0 0 2px ${settings.themeMode === 'light' ? '#f4f4f5' : '#09090b'}, 0 0 0 4px ${t.from}`
                    : undefined,
                }}
              />
              <span className={`text-[10px] ${active ? 'font-semibold text-zinc-100' : 'text-zinc-500'}`}>
                {t.label}
              </span>
            </button>
          );
        })}
      </div>

      <SectionTitle
        title="音符颜色"
        desc="谱面音符与六线谱数字的颜色（alphaTab mainGlyphColor）；小节号始终跟随主题色。"
      />
      <Row label="音符配色" hint="纯白为深色主题高对比实验方案；浅色主题下自动换深色墨。">
        <Segmented
          value={settings.noteColor}
          onChange={(v) => update({ noteColor: v })}
          options={noteColorIds.map((id) => ({ value: id, label: NOTE_COLORS[id].label.split('（')[0] }))}
        />
      </Row>
      <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-3.5 py-3">
        <span className="text-[11px] text-zinc-500">预览（当前明暗模式下）：</span>
        {noteColorIds.map((id) => {
          const hex = resolveNoteHex(id, settings.themeMode, accentFrom);
          return (
            <span
              key={id}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-white/15 text-sm"
              style={{ color: hex }}
            >
              ♪
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ---------- 分区：AI Copilot 连接 ----------

/** 模型下拉里的“手填模型 ID”哨兵值 */
const CUSTOM_MODEL = '__custom__';

/** 已保存方案胶囊的短标签：去协议头的主机路径 · 模型 */
function presetLabel(baseUrl: string, model: string): string {
  return `${baseUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '')} · ${model}`;
}

function CopilotSection() {
  const { connected, connection, connect, disconnect } = useCopilot();
  const { settings, update } = useSettings();
  const [selected, setSelected] = useState<CopilotProviderId>(connection?.providerId ?? 'deepseek');
  const info = COPILOT_PROVIDERS[selected];
  const [modelChoice, setModelChoice] = useState<string>(info.models[0] ?? '');
  const [customModel, setCustomModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 已保存预设（localStorage，仅存模型 ID / 接口地址；Key 永不落盘）
  const savedModels = settings.copilotSavedModels[selected] ?? [];
  const customPresets = settings.copilotCustomPresets;

  // 显式保存按钮的可用性：非空、非官方列表内置、未保存过（已保存则禁用 = 已收藏信号）
  const trimmedModel = customModel.trim();
  const normalizedBase = baseUrl.trim().replace(/\/+$/, '');
  const canSaveModel =
    modelChoice === CUSTOM_MODEL &&
    trimmedModel.length > 0 &&
    !info.models.includes(trimmedModel) &&
    !savedModels.includes(trimmedModel);
  const canSaveScheme =
    selected === 'custom' &&
    /^https?:\/\//i.test(normalizedBase) &&
    trimmedModel.length > 0 &&
    !customPresets.some((p) => p.baseUrl === normalizedBase && p.model === trimmedModel);

  function pickProvider(id: CopilotProviderId) {
    setSelected(id);
    setModelChoice(COPILOT_PROVIDERS[id].models[0] ?? '');
    setError(null);
  }

  /** 手填模型连接成功后存入该厂商“已保存”（新的在前、去重、上限 6） */
  function saveProviderModel(pid: CopilotProviderId, model: string) {
    if (COPILOT_PROVIDERS[pid].models.includes(model)) return;
    const cur = settings.copilotSavedModels[pid] ?? [];
    update({
      copilotSavedModels: {
        ...settings.copilotSavedModels,
        [pid]: [model, ...cur.filter((m) => m !== model)].slice(0, 6),
      },
    });
  }

  function removeProviderModel(pid: CopilotProviderId, model: string) {
    const next = (settings.copilotSavedModels[pid] ?? []).filter((m) => m !== model);
    update({ copilotSavedModels: { ...settings.copilotSavedModels, [pid]: next } });
    // 删掉的正是当前选中值时回退到推荐列表第一个
    setModelChoice((cur) =>
      cur === model && !COPILOT_PROVIDERS[pid].models.includes(cur)
        ? (COPILOT_PROVIDERS[pid].models[0] ?? '')
        : cur,
    );
  }

  /** 自定义方案连接成功后存为预设（新的在前、按 地址+模型 去重、上限 8） */
  function saveCustomPreset(base: string, model: string) {
    const next = [
      { baseUrl: base, model },
      ...customPresets.filter((p) => p.baseUrl !== base || p.model !== model),
    ].slice(0, 8);
    update({ copilotCustomPresets: next });
  }

  function removeCustomPreset(base: string, model: string) {
    update({
      copilotCustomPresets: customPresets.filter((p) => p.baseUrl !== base || p.model !== model),
    });
  }

  function handleConnect() {
    // 选了“自定义模型 ID…”或自定义服务时必须手填模型，禁止静默回退到默认型号
    const handTyped = selected === 'custom' || modelChoice === CUSTOM_MODEL;
    if (handTyped && !customModel.trim()) {
      setError('请先填写模型 ID');
      return;
    }
    const model = handTyped ? customModel.trim() : modelChoice;
    const normalizedBase = baseUrl.trim().replace(/\/+$/, '');
    const result = connect({
      providerId: selected,
      apiKey,
      baseUrl: selected === 'custom' ? normalizedBase : undefined,
      model,
    });
    if (!result.ok) {
      setError(result.error ?? '连接失败');
      return;
    }
    // 连接成功：手填模型 / 自定义方案自动存为本地预设（不含 Key，非涉密）
    if (selected === 'custom') saveCustomPreset(normalizedBase, model);
    else if (modelChoice === CUSTOM_MODEL) saveProviderModel(selected, model);
    setError(null);
    setApiKey('');
  }

  const providerIds = Object.keys(COPILOT_PROVIDERS) as CopilotProviderId[];

  // 预设厂商的模型下拉：推荐 + 已保存（可删）+ 手填入口；无保存项时不加分组头
  const modelItems: SelectItem[] =
    savedModels.length > 0
      ? [
          { kind: 'header', label: '推荐' },
          ...info.models.map((m) => ({ kind: 'option' as const, value: m, label: m })),
          { kind: 'header', label: '已保存' },
          ...savedModels
            .filter((m) => !info.models.includes(m))
            .map((m) => ({ kind: 'option' as const, value: m, label: m, removable: true })),
          { kind: 'option', value: CUSTOM_MODEL, label: '自定义模型 ID…' },
        ]
      : [
          ...info.models.map((m) => ({ kind: 'option' as const, value: m, label: m })),
          { kind: 'option', value: CUSTOM_MODEL, label: '自定义模型 ID…' },
        ];

  return (
    <div className="space-y-3">
      <SectionTitle
        title="BYOK 连接"
        desc="填入你自己的大模型 API Key（Bring Your Own Key），解锁主页面 Copilot 功能。所有厂商与自定义服务统一走 OpenAI 兼容对话接口。"
      />

      {connected && connection ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/8 px-3.5 py-3">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
          <div className="min-w-0">
            <div className="text-xs font-medium text-emerald-300">
              已连接 {connection.label} · {connection.model}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-zinc-500" title={connection.baseUrl}>
              {connection.baseUrl}
            </div>
          </div>
          <button
            onClick={disconnect}
            className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-1.5 text-[11px] font-medium text-rose-300 transition-colors hover:bg-rose-500/20"
          >
            <Link2Off className="h-3 w-3" />
            断开连接
          </button>
        </div>
      ) : (
        <div className="space-y-3 rounded-xl border border-white/8 bg-white/[0.02] px-3.5 py-3.5">
          <div>
            <label className="mb-1.5 block text-[11px] text-zinc-500">模型提供商</label>
            <div className="grid grid-cols-4 gap-2">
              {providerIds.map((id) => {
                const p = COPILOT_PROVIDERS[id];
                const active = selected === id;
                return (
                  <button
                    key={id}
                    onClick={() => pickProvider(id)}
                    className={`rounded-xl border px-2 py-2 text-left transition-all ${
                      active
                        ? 'border-accent-strong bg-accent-soft shadow-sm'
                        : 'border-white/10 bg-white/[0.02] hover:border-white/25'
                    }`}
                  >
                    <span className={`block truncate text-[11px] font-semibold ${active ? 'text-accent' : 'text-zinc-200'}`}>
                      {p.label}
                    </span>
                    <span className="mt-0.5 block truncate text-[9px] text-zinc-600">{p.host}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {selected === 'custom' ? (
            <>
              {customPresets.length > 0 && (
                <div>
                  <label className="mb-1.5 block text-[11px] text-zinc-500">
                    已保存方案（连接成功后自动记录；点击填入，× 删除）
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {customPresets.map((p) => (
                      <span
                        key={`${p.baseUrl}::${p.model}`}
                        className="flex max-w-full items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] py-1 pl-2.5 pr-1 text-[10px] text-zinc-300"
                      >
                        <button
                          type="button"
                          title={`${p.baseUrl} · ${p.model}`}
                          onClick={() => {
                            setBaseUrl(p.baseUrl);
                            setCustomModel(p.model);
                            setError(null);
                          }}
                          className="min-w-0 max-w-[220px] truncate transition-colors hover:text-accent"
                        >
                          {presetLabel(p.baseUrl, p.model)}
                        </button>
                        <button
                          type="button"
                          aria-label={`删除方案 ${presetLabel(p.baseUrl, p.model)}`}
                          onClick={() => removeCustomPreset(p.baseUrl, p.model)}
                          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-zinc-600 transition-colors hover:bg-white/10 hover:text-rose-300"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <label className="mb-1.5 block text-[11px] text-zinc-500">
                  接口地址（OpenAI 兼容，以 /v1 等结尾）
                </label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://your-host.com/v1"
                  className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-300 outline-none placeholder:text-zinc-700 focus:border-accent-strong"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] text-zinc-500">模型 ID</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    placeholder="qwen3.8-flash / gpt-6-luna / llama3 …"
                    className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-300 outline-none placeholder:text-zinc-700 focus:border-accent-strong"
                  />
                  <button
                    type="button"
                    onClick={() => saveCustomPreset(normalizedBase, trimmedModel)}
                    disabled={!canSaveScheme}
                    title={
                      canSaveScheme
                        ? '保存当前「接口地址 + 模型」为方案卡片（无需连接）'
                        : '填写以 http(s):// 开头的接口地址和模型 ID 后可保存；已收藏的会禁用'
                    }
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-accent-strong bg-accent-soft px-3 text-xs font-medium text-accent transition-opacity disabled:opacity-40"
                  >
                    <Bookmark className="h-3 w-3" />
                    保存方案
                  </button>
                </div>
              </div>
              <p className="text-[10px] leading-relaxed text-zinc-600">
                点「保存方案」立即收藏当前连接信息，连接成功后也会自动记录；点击上方卡片快速填入，× 删除。
              </p>
            </>
          ) : (
            <div>
              <label className="mb-1.5 block text-[11px] text-zinc-500">模型</label>
              {/* 下拉常驻：选“自定义模型 ID…”只在下方补一行输入框，随时可切回列表 */}
              <SelectMenu
                value={modelChoice}
                onChange={(v) => {
                  setModelChoice(v);
                  setError(null);
                }}
                onRemove={(v) => removeProviderModel(selected, v)}
                items={modelItems}
                ariaLabel="模型"
              />
              {modelChoice === CUSTOM_MODEL && (
                <div className="mt-2 flex gap-2">
                  <input
                    type="text"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    placeholder={`手填模型 ID，如 ${info.models[0]}`}
                    className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-300 outline-none placeholder:text-zinc-700 focus:border-accent-strong"
                  />
                  <button
                    type="button"
                    onClick={() => saveProviderModel(selected, trimmedModel)}
                    disabled={!canSaveModel}
                    title={
                      canSaveModel
                        ? '保存到下拉的「已保存」分组（无需连接）'
                        : '填写模型 ID 后可保存；官方列表内置或已收藏的会禁用'
                    }
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-accent-strong bg-accent-soft px-3 text-xs font-medium text-accent transition-opacity disabled:opacity-40"
                  >
                    <Bookmark className="h-3 w-3" />
                    保存
                  </button>
                </div>
              )}
              <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">
                手填的模型 ID 可点「保存」立即收藏，连接成功后也会自动记录；下拉「已保存」分组可选用或删除。
              </p>
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-[11px] text-zinc-500">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={info.keyPlaceholder}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-300 outline-none placeholder:text-zinc-700 focus:border-accent-strong"
            />
            {error && <p className="mt-1.5 text-[11px] text-rose-400">{error}</p>}
          </div>

          <button
            onClick={handleConnect}
            className="w-full rounded-lg bg-accent-grad-r px-3 py-2 text-xs font-semibold text-white shadow-md transition-opacity hover:opacity-90"
          >
            连接
          </button>
        </div>
      )}

      <div className="flex items-start gap-1.5 rounded-lg border border-sky-500/20 bg-sky-500/8 px-2.5 py-2 text-[10px] leading-relaxed text-sky-300/90">
        <MessageSquareText className="mt-0.5 h-3 w-3 shrink-0" />
        模型能力要求：只需支持「文本输入 → 文本输出」的对话接口（OpenAI 兼容
        /chat/completions）即可接入。不需要多模态、函数调用、联网搜索等任何附加能力 ——
        因此这里不做能力标记，任意文本对话大模型（含本地 Ollama / LM Studio）都可用。
      </div>

      <div className="flex items-start gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/8 px-2.5 py-2 text-[10px] leading-relaxed text-amber-300/90">
        <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
        连接即表示你认可所选提供商的隐私政策：连接后使用 Copilot 功能时，谱面 alphaTex 文本会发送到所选提供商。
        Key 仅保存在本次会话内存中，刷新后需重新连接，绝不写入 localStorage / sessionStorage
        （装壳后将改存 OS keychain 并由主进程代理请求）。
      </div>

      <SectionTitle title="连接后可用的功能" />
      <div className="space-y-1.5 text-[11px] text-zinc-400">
        <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
          <span className="font-medium text-zinc-200">自动标注和弦</span>
          <span className="ml-1.5 text-zinc-500">逐小节识别和弦走向 · 大模型推断，失败自动降级本地规则</span>
        </div>
        <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
          <span className="font-medium text-zinc-200">AI 改谱</span>
          <span className="ml-1.5 text-zinc-500">自然语言把位重构 / 新手降维 · 输出过前置校验，预览确认后落谱</span>
        </div>
        <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
          <span className="font-medium text-zinc-200">主音/节奏双吉他拆轨</span>
          <span className="ml-1.5 text-zinc-500">需大模型推理 · 无本地降级，两轨均过校验后选用</span>
        </div>
      </div>
    </div>
  );
}

// ---------- 分区：通用设置 ----------

function GeneralSection() {
  const { settings, update, reset } = useSettings();
  return (
    <div className="space-y-3">
      <SectionTitle title="音频" />
      <Row label="合成器音量" hint={`内置音源播放总音量（${Math.round(settings.masterVolume * 100)}%），影响谱面跟播。`}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={settings.masterVolume}
          onChange={(e) => update({ masterVolume: Number(e.target.value) })}
          className="w-36"
        />
      </Row>

      <SectionTitle title="数据与隐私" />
      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3.5 py-3 text-[11px] leading-relaxed text-emerald-300/90">
        全部音频处理与转谱计算均在本地完成，不上传任何数据。界面偏好仅保存在本机
        localStorage；后续 BYOK 大模型 API Key 将存入操作系统密钥链，绝不落 localStorage。
      </div>

      <SectionTitle title="重置" />
      <Row label="恢复默认设置" hint="清除本机保存的全部界面偏好并恢复默认值。">
        <button
          onClick={reset}
          className="flex items-center gap-1.5 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-1.5 text-[11px] font-medium text-rose-300 transition-colors hover:bg-rose-500/20"
        >
          <RotateCcw className="h-3 w-3" />
          恢复默认
        </button>
      </Row>
    </div>
  );
}

// ---------- 分区：测试 ----------

function TestSection({
  busy,
  onRunDemo,
  onLoadDemoAudio,
}: {
  busy?: boolean;
  onRunDemo: () => void;
  onLoadDemoAudio: () => void;
}) {
  return (
    <div className="space-y-4">
      <SectionTitle
        title="演示与调试"
        desc="内置示例素材，用于验证流水线与网格 overlay；真实音频转谱请直接把文件拖入左侧导入区。"
      />
      <button
        onClick={onRunDemo}
        disabled={busy}
        className="flex w-full items-center gap-3 rounded-xl border-accent bg-accent-soft px-3.5 py-3 text-left transition-colors hover-bg-accent-soft disabled:opacity-50"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-grad shadow-accent">
          <FlaskConical className="h-4.5 w-4.5 text-white" />
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-semibold text-zinc-100">
            {busy ? 'GuitarProfile 流水线运行中…' : '运行演示（内置示例乐句）'}
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-500">
            内置 80→60 BPM 变速示例乐句跑完整五步流水线：过滤 → 聚拢 → Auto-Capo → Viterbi
            寻路 → 技巧检测 → alphaTex，同时演示变速候选检测（§3.5）。
          </span>
        </span>
      </button>
      <button
        onClick={onLoadDemoAudio}
        disabled={busy}
        className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-3 text-left transition-colors hover-border-accent disabled:opacity-50"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03]">
          <Volume2 className="h-4.5 w-4.5 text-zinc-400" />
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-semibold text-zinc-100">加载演示音频</span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-500">
            加载 80→60 变速点击轨到波形区，可听出变速点，并验证波形上的节拍网格 overlay
            与拍点对齐。
          </span>
        </span>
      </button>
      <div className="rounded-xl border border-white/5 bg-white/[0.02] px-3.5 py-3 text-[11px] leading-relaxed text-zinc-500">
        触发后设置面板会自动关闭，结果展示在主界面（谱面 / 波形 / 底部状态栏）。
      </div>
    </div>
  );
}

// ---------- 分区：关于 ----------

function AboutSection() {
  const { settings } = useSettings();
  void settings;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-4">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-grad shadow-accent">
          <Gauge className="h-6 w-6 text-white" />
        </div>
        <div>
          <div className="text-sm font-semibold text-zinc-100">AI 智能扒谱</div>
          <div className="text-[11px] text-zinc-500">ai-guitar-transcriber · v0.1.0 · Guitar-First</div>
        </div>
      </div>
      <div className="space-y-2 text-[11px] leading-relaxed text-zinc-400">
        <p>
          高颜值、免费开源、本地离线优先的智能音乐扒谱软件。首期专精吉他：自动生成符合手指生理结构的六线谱（Tab）与五线谱。
        </p>
        <div className="flex flex-wrap gap-1.5">
          {['Step 1 界面与渲染 ✓', 'Step 2 GuitarProfile 核心 ✓', 'Step 3 Basic Pitch 转谱 ✓', 'Step 4 AI Copilot（BYOK）✓'].map(
            (s) => (
              <span
                key={s}
                className={`rounded-full px-2 py-0.5 text-[10px] ${
                  s.includes('✓')
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-zinc-700/50 text-zinc-500'
                }`}
              >
                {s}
              </span>
            ),
          )}
        </div>
        <p className="pt-1 text-zinc-500">
          产品方案：<code className="text-zinc-400">docs/吉他扒谱.md</code>（v4.0）· 工程细化：
          <code className="text-zinc-400">docs/吉他扒谱-细化方案 v4.1.md</code>
        </p>
        <p className="text-zinc-500">
          主程序以 MIT 协议开源；alphaTab（MPL 2.0）、sonivox 音源（Apache 2.0）、Bravura 字体（OFL 1.1）等第三方组件声明见
          <code className="text-zinc-400"> app/THIRD-PARTY-NOTICES.txt</code>。
        </p>
      </div>
    </div>
  );
}

// ---------- 模态壳 ----------

export default function SettingsModal({ initialSection, onClose, busy, onRunDemo, onLoadDemoAudio }: Props) {
  const [section, setSection] = useState<SettingsSection>(initialSection);

  useEffect(() => setSection(initialSection), [initialSection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="flex h-[540px] w-full max-w-[760px] overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/95 shadow-2xl shadow-black/60 backdrop-blur-xl"
      >
        {/* 二级菜单 */}
        <nav className="flex w-44 shrink-0 flex-col gap-1 border-r border-white/8 bg-black/25 p-3">
          <div className="px-2 py-2 text-[11px] font-semibold tracking-wider text-zinc-500">
            设置
          </div>
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setSection(id)}
              className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-medium transition-colors ${
                section === id
                  ? 'bg-accent-grad-r text-white shadow-md'
                  : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </nav>

        {/* 内容区 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-white/8 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-zinc-100">
              {NAV_ITEMS.find((n) => n.id === section)?.label}
            </h2>
            <button
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {section === 'tier' && <TierSection />}
            {section === 'display' && <DisplaySection />}
            {section === 'theme' && <ThemeSection />}
            {section === 'copilot' && <CopilotSection />}
            {section === 'general' && <GeneralSection />}
            {section === 'test' && (
              <TestSection busy={busy} onRunDemo={onRunDemo} onLoadDemoAudio={onLoadDemoAudio} />
            )}
            {section === 'about' && <AboutSection />}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
