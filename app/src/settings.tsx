/**
 * 应用设置中心：类型 / 默认值 / zod 校验 / localStorage 持久化 / React Context。
 *
 * 原则（对齐 docs/吉他扒谱-细化方案 v4.1 §1.3）：
 * - 普通界面偏好存 localStorage；
 * - 涉密数据（BYOK API Key）永远不进 localStorage，装壳后走 OS keychain（本文件不涉及）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { z } from 'zod';
import type { FingeringStyle } from './profiles/IInstrumentProfile';
import type { QuantizeStrength } from './core/quantizer';
import type { PerformanceTier } from './types';

export type SettingsSection =
  | 'tier'
  | 'display'
  | 'theme'
  | 'copilot'
  | 'general'
  | 'test'
  | 'about';

// ---------- 主题（设置 → 主题设置） ----------

export const ACCENT_THEMES = {
  violet: { label: '霓虹紫', from: '#8b5cf6', to: '#d946ef' },
  ocean: { label: '深海蓝', from: '#3b82f6', to: '#22d3ee' },
  sunset: { label: '落日橙', from: '#fb923c', to: '#f43f5e' },
  emerald: { label: '翡翠绿', from: '#10b981', to: '#2dd4bf' },
  sakura: { label: '樱花粉', from: '#ec4899', to: '#c084fc' },
} as const;
export type AccentId = keyof typeof ACCENT_THEMES;

/** 谱面音符颜色（alphaTab mainGlyphColor）：dark 主题下可切纯白实验 */
export const NOTE_COLORS = {
  default: { label: '浅灰（默认）', hex: '#e4e4e7' },
  white: { label: '纯白', hex: '#ffffff' },
  accent: { label: '跟随主题色', hex: null },
} as const;
export type NoteColorId = keyof typeof NOTE_COLORS;

export type ThemeMode = 'dark' | 'light';

/** 音符颜色解析：浅色主题下自动换成深色墨水（纯白→纯黑、浅灰→深墨） */
export function resolveNoteHex(
  noteColor: NoteColorId,
  themeMode: ThemeMode,
  accentFrom: string,
): string {
  if (noteColor === 'accent') return accentFrom;
  if (themeMode === 'light') return noteColor === 'white' ? '#000000' : '#27272a';
  return NOTE_COLORS[noteColor].hex;
}

export type AppSettings = {
  version: 1;
  // ---- 档位设置 ----
  /** 三级性能档位（轻量/均衡/高配） */
  tier: PerformanceTier;
  /** 指法风格三档 → Viterbi 权重预设（省力/均衡/忠于原音） */
  fingeringStyle: FingeringStyle;
  /** 量化强度：对齐 1/16 网格策略（严格/软/关） */
  quantizeStrength: QuantizeStrength;
  /** 轻量档音频带通滤波 70Hz~8kHz（audioPreprocessor） */
  bandpass: boolean;
  // ---- 显示设置 ----
  /** 谱面缩放（alphaTab display.scale） */
  scoreScale: number;
  /** 谱面布局：横向单行 / 纵向页面 */
  scoreLayout: 'horizontal' | 'page';
  /** 播放时自动滚动跟随 */
  followPlayback: boolean;
  /** 显示播放光标 */
  showCursor: boolean;
  /** 首页显示波形区 */
  showWaveform: boolean;
  /** 界面动效（Framer Motion） */
  animations: boolean;
  // ---- 主题设置 ----
  /** 界面明暗模式 */
  themeMode: ThemeMode;
  /** 主题色预设（accent 渐变色对） */
  themeAccent: AccentId;
  /** 谱面音符颜色（dark 主题：浅灰 / 纯白 / 跟随主题色） */
  noteColor: NoteColorId;
  // ---- 通用设置 ----
  /** 内置合成器总音量（alphaTab masterVolume） */
  masterVolume: number;
  // ---- AI Copilot（BYOK 预设）----
  // 注意：这里只存非涉密的连接偏好（模型 ID / 接口地址）；API Key 永不落盘
  /** 各厂商手填保存的模型 ID（providerId → 列表，新的在前） */
  copilotSavedModels: Record<string, string[]>;
  /** 自定义连接方案预设（接口地址 + 模型，新的在前） */
  copilotCustomPresets: { baseUrl: string; model: string }[];
};

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  tier: 'light',
  fingeringStyle: 'balanced',
  quantizeStrength: 'soft',
  bandpass: true,
  scoreScale: 1,
  scoreLayout: 'horizontal',
  followPlayback: true,
  showCursor: true,
  showWaveform: true,
  animations: true,
  themeMode: 'dark',
  themeAccent: 'violet',
  noteColor: 'default',
  masterVolume: 0.8,
  copilotSavedModels: {},
  copilotCustomPresets: [],
};

const settingsSchema = z.object({
  version: z.literal(1),
  tier: z.enum(['light', 'balanced', 'pro']),
  fingeringStyle: z.enum(['easy', 'balanced', 'faithful']),
  quantizeStrength: z.enum(['strict', 'soft', 'off']),
  bandpass: z.boolean(),
  scoreScale: z.number().min(0.7).max(1.6),
  scoreLayout: z.enum(['horizontal', 'page']),
  followPlayback: z.boolean(),
  showCursor: z.boolean(),
  showWaveform: z.boolean(),
  animations: z.boolean(),
  themeMode: z.enum(['dark', 'light']),
  themeAccent: z.enum(['violet', 'ocean', 'sunset', 'emerald', 'sakura']),
  noteColor: z.enum(['default', 'white', 'accent']),
  masterVolume: z.number().min(0).max(1),
  // 带 default()：老版本 localStorage 缺这些字段时补默认值，避免整体回退
  copilotSavedModels: z.record(z.string(), z.array(z.string())).default({}),
  copilotCustomPresets: z
    .array(z.object({ baseUrl: z.string(), model: z.string() }))
    .default([]),
});

const STORAGE_KEY = 'agt.settings.v1';

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = settingsSchema.safeParse(JSON.parse(raw));
    // 校验失败（版本升级/字段损坏）→ 回退默认值，不让坏数据卡死应用
    return parsed.success ? (parsed.data as AppSettings) : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

type SettingsContextValue = {
  settings: AppSettings;
  /** 局部合并更新并持久化 */
  update: (patch: Partial<AppSettings>) => void;
  /** 恢复默认 */
  reset: () => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  // 主题色实时应用：CSS 变量驱动全部 accent 工具类；明暗模式切根元素 class
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const theme = ACCENT_THEMES[settings.themeAccent] ?? ACCENT_THEMES.violet;
    document.documentElement.style.setProperty('--accent-from', theme.from);
    document.documentElement.style.setProperty('--accent-to', theme.to);
    document.documentElement.classList.toggle('light', settings.themeMode === 'light');
  }, [settings.themeAccent, settings.themeMode]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // 存储不可用（隐私模式等）时静默降级为内存态
    }
  }, [settings]);

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const reset = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  const value = useMemo(() => ({ settings, update, reset }), [settings, update, reset]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings 必须在 <SettingsProvider> 内使用');
  return ctx;
}

/** 指法风格显示名（与 v4.1 §4.1 三档滑块一致） */
export const FINGERING_STYLE_LABEL: Record<FingeringStyle, { label: string; desc: string }> = {
  easy: { label: '省力档', desc: '大鼓励空弦、放宽跨度、强低把位偏好（新手推荐）' },
  balanced: { label: '均衡档', desc: '默认权重表，兼顾可弹性与还原度' },
  faithful: { label: '忠于原音档', desc: '不偏置空弦、收紧跨度、弱化先验' },
};

/** 量化强度显示名（v4.1 §3.1 量化强度滑块） */
export const QUANTIZE_LABEL: Record<QuantizeStrength, string> = {
  strict: '严格（全部对齐）',
  soft: '软（只对齐明显拍点）',
  off: '关（保留自由节奏）',
};
