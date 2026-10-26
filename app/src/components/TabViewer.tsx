import { useEffect, useRef, useState } from 'react';
import { AlphaTabApi, LayoutMode, ScrollMode } from '@coderline/alphatab';
import { ACCENT_THEMES, resolveNoteHex } from '../settings';

export type TabDisplaySettings = {
  /** 谱面缩放（display.scale） */
  scoreScale: number;
  /** 谱面布局 */
  scoreLayout: 'horizontal' | 'page';
  /** 跟随播放滚动 */
  followPlayback: boolean;
  /** 显示播放光标 */
  showCursor: boolean;
  /** 合成器总音量 */
  masterVolume: number;
  /** 音符颜色方案（主题设置） */
  noteColor: 'default' | 'white' | 'accent';
  /** 主题色 id（noteColor = accent 时取其主色） */
  themeAccent: 'violet' | 'ocean' | 'sunset' | 'emerald' | 'sakura';
  /** 界面明暗模式（浅色下音符用深色墨水） */
  themeMode: 'dark' | 'light';
};

type Props = {
  tex: string;
  display: TabDisplaySettings;
  onApiReady?: (api: AlphaTabApi | null) => void;
};

/**
 * alphaTab 渲染资源颜色热更新：Color 类未从包导出，但其构造器 new Color(r,g,b,a)
 * 是公开签名 —— 借现有实例的 constructor 构造新色，避免销毁重建整个渲染器
 * （重建在明暗快速切换时会把渲染面留成 0×0 空白）。
 */
/**
 * 把目标墨水色写入 alphaTab 渲染资源：借运行时 Color 实例的官方 static
 * `Color.fromJson` 解析（构造器参数语义有歧义，且 strings 直塞不稳定）。
 * 返回是否发生了实际变化（供 renderFinished 兜底避免重渲染死循环）。
 */
function applyScoreColors(res: Record<string, unknown>, noteHex: string, barHex: string): boolean {
  const cur = res.mainGlyphColor as { constructor?: { fromJson?: (v: unknown) => unknown }; rgba?: string } | undefined;
  const fromJson = cur?.constructor?.fromJson;
  if (!cur || typeof fromJson !== 'function') return false;
  const note = fromJson.call(cur.constructor, noteHex) as { rgba: string } | null;
  const bar = fromJson.call(cur.constructor, barHex) as { rgba: string } | null;
  if (!note || !bar) return false;
  const curNote = (res.mainGlyphColor as { rgba?: string }).rgba?.toLowerCase();
  const curBar = (res.barNumberColor as { rgba?: string }).rgba?.toLowerCase();
  const changed = curNote !== note.rgba.toLowerCase() || curBar !== bar.rgba.toLowerCase();
  res.mainGlyphColor = note;
  res.secondaryGlyphColor = note;
  res.scoreInfoColor = note;
  res.barNumberColor = bar;
  return changed;
}

/**
 * alphaTab 六线谱渲染画布（Step 1 核心验收项）。
 * 字体与音源由 @coderline/alphatab-vite 插件拷贝到 public/font|soundfont/，100% 本地离线。
 * 缩放/滚动/光标/音量/颜色均经 api.updateSettings() 热更新；
 * 布局切换需要重建渲染器，由父组件以 key 重挂载实现（本组件按挂载周期只建一个实例）。
 */
export default function TabViewer({ tex, display, onApiReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef(display);
  displayRef.current = display;
  const [api, setApi] = useState<AlphaTabApi | null>(null);
  const [failed, setFailed] = useState(false);
  // 音符颜色（设置 → 主题设置）：浅色模式下自动换深色墨水
  const accentFrom = ACCENT_THEMES[display.themeAccent].from;
  const noteColorHex = resolveNoteHex(display.noteColor, display.themeMode, accentFrom);
  // 用户要求：小节号数字跟随主题色（alphaTab 默认暗红太暗）
  const barNumberColor = accentFrom;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const d = displayRef.current;
    let instance: AlphaTabApi | null = null;
    try {
      instance = new AlphaTabApi(el, {
        core: { engine: 'html5', fontDirectory: '/font/' },
        display: {
          layoutMode: d.scoreLayout === 'page' ? LayoutMode.Page : LayoutMode.Horizontal,
          scale: d.scoreScale,
          resources: {
            mainGlyphColor: noteColorHex,
            barNumberColor,
            secondaryGlyphColor: noteColorHex,
            scoreInfoColor: noteColorHex,
          },
        },
        player: {
          soundFont: '/soundfont/sonivox.sf2',
          scrollMode: d.followPlayback ? ScrollMode.Continuous : ScrollMode.Off,
          enableCursor: d.showCursor,
        },
      });
      instance.error.on((e) => console.error('[alphaTab]', e));
      instance.masterVolume = d.masterVolume;
      // dev/E2E 诊断钩子：页面控制台可直接探查 alphaTab 运行时状态（生产无依赖）
      (window as unknown as { __tabApi?: AlphaTabApi | null }).__tabApi = instance;
      setApi(instance);
      onApiReady?.(instance);
    } catch (e) {
      console.error('alphaTab 初始化失败', e);
      setFailed(true);
    }
    return () => {
      (window as unknown as { __tabApi?: AlphaTabApi | null }).__tabApi = null;
      instance?.destroy();
      setApi(null);
      onApiReady?.(null);
    };
    // 一个挂载周期只建一个实例：布局变化由父组件 key 重挂载；颜色走热更新。
    // onApiReady 为稳定引用。 eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!api || !tex) return;
    api.tex(tex);
  }, [api, tex]);

  // 颜色热更新（音符色 / 小节号主题色 / 明暗墨水）。
  // 两层保障：设置变化时立即应用；并挂 renderFinished 兜底 —— alphaTab 的
  // tex()/布局重渲染会以默认黑重建墨水色（实测），渲染完成后校验并重应用。
  useEffect(() => {
    if (!api) return;
    const apply = () => {
      const res = api.settings.display.resources as unknown as Record<string, unknown>;
      if (applyScoreColors(res, noteColorHex, barNumberColor)) {
        api.updateSettings();
        api.render();
      }
    };
    apply();
    api.renderFinished.on(apply);
    return () => api.renderFinished.off(apply);
  }, [api, noteColorHex, barNumberColor]);

  // 缩放热更新：改 scale → updateSettings → 重排版
  useEffect(() => {
    if (!api) return;
    api.settings.display.scale = display.scoreScale;
    api.updateSettings();
    api.render();
  }, [api, display.scoreScale]);

  // 滚动/光标热更新
  useEffect(() => {
    if (!api) return;
    api.settings.player.scrollMode = display.followPlayback ? ScrollMode.Continuous : ScrollMode.Off;
    api.settings.player.enableCursor = display.showCursor;
    api.updateSettings();
  }, [api, display.followPlayback, display.showCursor]);

  // 音量热更新
  useEffect(() => {
    if (!api) return;
    api.masterVolume = display.masterVolume;
  }, [api, display.masterVolume]);

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        谱面渲染引擎初始化失败，请刷新重试
      </div>
    );
  }
  return (
    <div className="at-wrap relative h-full">
      <div ref={containerRef} className="h-full" />
      {!api && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-600">
          正在加载谱面渲染引擎…
        </div>
      )}
    </div>
  );
}
