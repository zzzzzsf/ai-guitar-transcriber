import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';

export type SelectItem =
  | { kind: 'header'; label: string }
  | { kind: 'option'; value: string; label: string; removable?: boolean };

type Props = {
  value: string;
  items: SelectItem[];
  onChange: (value: string) => void;
  /** 删除某个可移除选项（如已保存的预设），面板保持展开 */
  onRemove?: (value: string) => void;
  /** 容器布局类，默认 w-full（在工具条等场景可传 min-w-* 让宽度随内容） */
  className?: string;
  /** 触发按钮样式，默认与设置面板输入框一致 */
  triggerClassName?: string;
  title?: string;
  ariaLabel?: string;
};

const TRIGGER_DEFAULT =
  'w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-300 outline-none focus:border-accent-strong';

/** 面板最大高度：超过则视口下方放不下时自动向上弹出 */
const PANEL_MAX_H = 264;

/**
 * 页面内自绘下拉，替代原生 <select>：原生弹层由浏览器在页面外层绘制，
 * 在内嵌 WebView 中锚点会错位（弹出在窗口角落），且配色无法跟随主题。
 * 支持分组标题与可删除选项（用于已保存预设）。
 */
export default function SelectMenu({
  value,
  items,
  onChange,
  onRemove,
  className = 'w-full',
  triggerClassName = TRIGGER_DEFAULT,
  title,
  ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const options = items.filter((it): it is Extract<SelectItem, { kind: 'option' }> => it.kind === 'option');

  // 点击面板外任意处收起
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  function openMenu() {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) setUp(window.innerHeight - rect.bottom < PANEL_MAX_H && rect.top > PANEL_MAX_H);
    setOpen(true);
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    });
  }

  function choose(v: string) {
    onChange(v);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'Escape') {
      // 只收起下拉，不冒泡到设置模态的全局 Escape 关闭
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = options[active];
      if (o) choose(o.value);
    }
  }

  const current = options.find((o) => o.value === value);

  return (
    <div ref={rootRef} className={`relative ${className}`} onKeyDown={onKeyDown}>
      <button
        type="button"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={`flex items-center gap-1.5 text-left ${triggerClassName}`}
      >
        <span className="min-w-0 flex-1 truncate">{current?.label ?? ''}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div
          ref={listRef}
          role="listbox"
          className={`absolute z-30 max-h-64 w-full overflow-y-auto rounded-lg border border-white/10 bg-zinc-900/95 p-1 shadow-xl shadow-black/40 backdrop-blur-xl ${
            up ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          }`}
        >
          {items.map((it, i) => {
            if (it.kind === 'header') {
              return (
                <div
                  key={`h:${it.label}`}
                  className="px-2.5 pb-1 pt-1.5 text-[9px] font-semibold tracking-wider text-zinc-500"
                >
                  {it.label}
                </div>
              );
            }
            const oi = items.slice(0, i).filter((x) => x.kind === 'option').length;
            const selected = it.value === value;
            return (
              <div key={it.value} className="group flex items-center">
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  title={it.label}
                  onMouseEnter={() => setActive(oi)}
                  onClick={() => choose(it.value)}
                  className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                    selected
                      ? 'bg-accent-soft font-medium text-accent'
                      : active === oi
                        ? 'bg-white/10 text-zinc-200'
                        : 'text-zinc-300'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {selected && <Check className="h-3 w-3 shrink-0" />}
                </button>
                {it.removable && onRemove && (
                  <button
                    type="button"
                    title="删除此预设"
                    aria-label={`删除 ${it.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(it.value);
                    }}
                    className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-zinc-600 opacity-0 transition-opacity hover:bg-white/10 hover:text-rose-300 focus:opacity-100 group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
