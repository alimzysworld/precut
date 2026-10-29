import { MenuOption } from "./ui/patterns";
import { forwardRef, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type InputHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, animate, animateMini, spring as springGenerator, motion, useReducedMotion, type HTMLMotionProps, type Variants } from "framer-motion";
import * as presets from "../motion";
import { badgeTokens, type BadgeTone } from "../theme";
import { useShortcuts } from "../hooks/useShortcuts";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
export * from "./ui/patterns";
export { PanelBoundary } from "./ui/PanelBoundary";
export * from "./ui/InfoTip";
import { Tooltip } from "./ui/InfoTip";
import { DialogSurface, MenuSurface, InlineError, SectionHeader, useDialogFocus } from "./ui/patterns";
export { Magnify } from "../motion";

export const reducedTransition = presets.instant;
export function useMotionPresets() {
  const reduced = useReducedMotion();
  const opacityOnly = (variants: Variants): Variants => Object.fromEntries(
    Object.entries(variants).map(([key, value]) => [key, typeof value === "object"
      ? { opacity: value.opacity, transition: reducedTransition } : value]),
  );
  return {
    reduced,
    page: reduced ? opacityOnly(presets.page) : presets.page,
    item: reduced ? opacityOnly(presets.item) : presets.item,
    drawer: reduced ? opacityOnly(presets.drawer) : presets.drawer,
    pop: reduced ? opacityOnly(presets.pop) : presets.pop,
    layoutTransition: reduced ? reducedTransition : presets.spring.soft,
  };
}

const FirstList = createContext(true);
export function MotionList({ children, ...props }: HTMLMotionProps<"div">) {
  const first = useRef(true);
  const { reduced } = useMotionPresets();
  useEffect(() => { first.current = false; }, []);
  return <FirstList.Provider value={first.current}>
    <motion.div role="list" data-motion-list variants={reduced ? {} : { ...presets.list, animate: {} }} initial="initial" animate="animate" {...props}>{children}</motion.div>
  </FirstList.Provider>;
}
export function MotionItem({ index = 0, ...props }: HTMLMotionProps<"div"> & { index?: number }) {
  const first = useContext(FirstList);
  const { item, reduced } = useMotionPresets();
  // Hover never participates in layout projection, including in a 16-card grid.
  return <motion.div role="listitem" data-motion-item data-motion-index={index} variants={item} initial={first ? "initial" : false} animate="animate" transition={reduced ? reducedTransition : presets.spring.sheet} {...props} />;
}

export function Img({ src, className = "", style, onLoad, onError, instant = false, ...props }: HTMLMotionProps<"img"> & { instant?: boolean }) {
  const { reduced } = useMotionPresets();
  const [loaded, setLoaded] = useState<string>();
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => { if (ref.current?.complete && ref.current.naturalWidth) setLoaded(src); }, [src]);
  return <motion.span className={`relative block overflow-hidden bg-ink/[0.04] ${className}`} style={style}>
    <motion.img {...props} data-magnify-image ref={ref} src={src} className="h-full w-full object-[inherit]" style={{ objectFit: "inherit" }}
      initial={false} animate={{ opacity: instant || loaded === src ? 1 : 0 }}
      transition={instant || reduced ? reducedTransition : presets.imgIn}
      onLoad={(e) => { setLoaded(src); onLoad?.(e); }} onError={(e) => { setLoaded(undefined); onError?.(e); }} />
  </motion.span>;
}
export const FOCUS =
  "outline-none";

export { Slider, parseSliderValue } from "./finish/Controls";

export function Card({ children, className = "", onClick, ...props }: HTMLMotionProps<"div">) {
  const magnify = presets.useMagnify();
  return <motion.div {...magnify} onClick={onClick} className={`st-card st-glass-surface overflow-hidden rounded-2xl p-5 ${className}`} {...props} style={{ ...props.style, ...magnify.style }}>{children}</motion.div>;
}

type ButtonVariant = "primary" | "secondary" | "ghost";
export function Button({
  variant = "secondary",
  className = "",
  ...props
}: HTMLMotionProps<"button"> & { variant?: ButtonVariant }) {
  const magnify = presets.useMagnify("control", props.disabled);
  const styles: Record<ButtonVariant, string> = {
    primary: "st-button-primary font-semibold",
    secondary: "st-button-secondary font-medium",
    ghost: "font-medium text-muted hover:bg-ink/[0.06] hover:text-ink",
  };
  return (
    <motion.button
      {...magnify}
      className={`inline-flex items-center justify-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-45 ${styles[variant]} ${FOCUS} ${className}`}
      {...props}
      style={{ ...props.style, ...magnify.style }}
    />
  );
}

type PillTone = "good" | "warn" | "danger" | "neutral" | "accent" | BadgeTone;
export function Badge({ tone = "neutral", children, dot = false, icon, className = "" }: {
  tone?: BadgeTone; children: ReactNode; dot?: boolean; icon?: ReactNode; className?: string;
}) {
  const tokens = badgeTokens[tone];
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-micro font-medium ${className}`}
    style={{ backgroundColor: `var(${tokens.fill})`, color: `var(${tokens.ink})` }}>
    {icon ? <span aria-hidden="true" className="flex shrink-0">{icon}</span> : dot && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />}
    {children}
  </span>;
}

/** Legacy tones remain valid while new editorial badges use explicit pairs. */
export function Pill({ tone = "neutral", children, dot, icon, className }: {
  tone?: PillTone; children: ReactNode; dot?: boolean; icon?: ReactNode; className?: string;
}) {
  const aliases = { good: "lime", warn: "amber", danger: "pink", accent: "violet" } as const;
  const resolved = tone in aliases ? aliases[tone as keyof typeof aliases] : tone as BadgeTone;
  return <Badge tone={resolved} dot={dot ?? ["good", "warn", "danger"].includes(tone)} icon={icon} className={className}>{children}</Badge>;
}

const ChipScope = createContext<string | undefined>(undefined);
const chipParents = new WeakMap<Element, string>();
export function ChipGroup({ children, className = "" }: { children: ReactNode; className?: string }) {
  const id = useId();
  return <ChipScope.Provider value={id}><div className={className}>{children}</div></ChipScope.Provider>;
}
export function Chip({ selected = false, className = "", children, group, ...props }: Omit<HTMLMotionProps<"button">, "children"> & { children?: ReactNode; selected?: boolean; group?: string }) {
  const scope = useContext(ChipScope);
  const id = useId();
  const ref = useRef<HTMLButtonElement>(null);
  const [parentScope, setParentScope] = useState<string>();
  useLayoutEffect(() => {
    const parent = ref.current?.closest('[role="group"]') ?? ref.current?.parentElement;
    if (!parent) return;
    if (!chipParents.has(parent)) chipParents.set(parent, id);
    setParentScope(chipParents.get(parent));
  }, [id]);
  const highlight = group ?? scope ?? parentScope;
  const { reduced } = useMotionPresets();
  const magnify = presets.useMagnify("control", props.disabled);
  return <motion.button {...magnify} ref={ref} aria-pressed={selected}
    className={`st-chip relative isolate ${selected ? "font-medium text-ground" : "text-muted hover:text-ink"} rounded-full px-3.5 py-1.5 text-[13px] ${FOCUS} ${className}`} {...props} style={{ ...props.style, ...magnify.style }}>
    {selected && <motion.span aria-hidden="true" layoutId={reduced || !highlight ? undefined : `chip-${highlight}`}
      initial={false} transition={reduced ? reducedTransition : presets.spring.pill} className="absolute inset-0 -z-10 rounded-full bg-ink" />}
    {children}
  </motion.button>;
}

/** Native Tab/arrow behavior is local to each control; global shortcuts belong
 * to the N7 registry. A hint describes a shortcut registered by the caller. */

export function IconButton({ label, shortcut, children, className = "", ...props }: Omit<HTMLMotionProps<"button">, "children"> & {
  label: string; shortcut?: string; children: ReactNode;
}) {
  return <Tooltip label={label} shortcut={shortcut}><Button type="button" {...props} aria-label={label} title={shortcut ? `${label} (${shortcut})` : label}
    className={`st-icon-button size-9 shrink-0 !p-0 ${className}`}>{children}</Button></Tooltip>;
}

export const SearchField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & {
  query?: string; onQueryChange?: (value: string) => void; clearLabel?: string;
  label: string; shortcut?: string | null; shortcutScope?: string; shortcutId?: string; shortcutBindings?: string[];
}>(function SearchField({ label, shortcut = "⌘ K", shortcutScope = "global", shortcutId,
  shortcutBindings = ["Cmd+k"], className = "", query, onQueryChange, clearLabel = "Clear search", ...props }, forwardedRef) {
  const input = useRef<HTMLInputElement | null>(null);
  const id = useId();
  useShortcuts(shortcutScope, shortcut ? [{ id: shortcutId ?? `search-${id}`, scope: shortcutScope,
    keys: shortcutBindings, label, enabled: !props.disabled,
    handler: () => { if (!input.current?.closest("[inert]")) input.current?.focus(); },
  }] : [], Boolean(shortcut));
  return <label className={`st-search flex min-w-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 ${className}`}>
    <MagnifyingGlass size={17} aria-hidden="true" className="shrink-0 text-muted" />
    <input {...props} ref={node => { input.current = node; if (typeof forwardedRef === "function") forwardedRef(node); else if (forwardedRef) forwardedRef.current = node; }} value={query ?? props.value} onChange={onQueryChange ? event => onQueryChange(event.target.value) : props.onChange} type="search" aria-label={label} className={`min-w-0 flex-1 bg-transparent text-small text-ink [&::-webkit-search-cancel-button]:hidden ${FOCUS}`} />
    {onQueryChange && query ? <button type="button" aria-label={clearLabel} onClick={() => { onQueryChange(""); input.current?.focus(); }} className={`text-muted hover:text-ink ${FOCUS}`}><X size={12} /></button> : null}
    {shortcut && <kbd aria-hidden="true" className="shrink-0 rounded px-1 text-micro text-muted font-mono">{shortcut}</kbd>}
  </label>;
});

export type MenuItem = { id: string; label: string; onSelect: () => void; disabled?: boolean; icon?: ReactNode; shortcut?: string };
export function Menu({ label, children, items }: { label: string; children: ReactNode; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const { pop } = useMotionPresets();
  const close = () => { setOpen(false); container.current?.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.focus(); };
  useEffect(() => {
    if (!open) return;
    container.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div ref={container} className="relative inline-flex" onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  }}>
    <Button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(value => !value)} onKeyDown={event => {
        if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(true); }
      }}>{children}</Button>
    <AnimatePresence>{open && <MenuSurface id={id} aria-label={label} variants={pop} initial="initial" animate="animate" exit="exit"
      className="st-pop absolute right-0 top-full z-50 mt-2 min-w-52 rounded-2xl p-1.5" onClose={close}>
      {items.map(item => <MenuOption key={item.id} type="button" role="menuitem" disabled={item.disabled}
        onClick={() => { close(); item.onSelect(); }} className={`st-menu-item flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-small text-ink disabled:opacity-45 ${FOCUS}`}>
        {item.icon}<span className="flex-1">{item.label}</span>{item.shortcut && <kbd className="font-mono text-micro text-muted">{item.shortcut}</kbd>}
      </MenuOption>)}
    </MenuSurface>}</AnimatePresence>
  </div>;
}

export function Modal({ open, onClose, title, children, className = "" }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const { pop } = useMotionPresets();
  useDialogFocus(panel, open);
  return createPortal(<AnimatePresence>{open && <motion.div className="st-scrim fixed inset-0 z-[210] flex items-center justify-center p-6"
    variants={presets.instantFade} initial="initial" animate="animate" exit="exit" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <DialogSurface ref={panel} tabIndex={-1} aria-modal="true" aria-labelledby={titleId}
      variants={pop} className={`glass-modal max-h-[calc(100dvh-48px)] w-full max-w-xl overflow-y-auto rounded-3xl p-6 text-ink ${className}`}
      onClose={onClose}>
      <header className="mb-5 flex items-center justify-between gap-4">
        <SectionHeader as="h2" id={titleId} className="font-display text-title font-semibold">{title}</SectionHeader>
        <IconButton label="Close dialog" onClick={onClose}><X size={18} /></IconButton>
      </header>
      {children}
    </DialogSurface>
  </motion.div>}</AnimatePresence>, document.body);
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  wide = false,
  onLanded,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  wide?: boolean;
  onLanded?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { drawer, reduced } = useMotionPresets();
  useDialogFocus(panelRef, open);
  return createPortal(
    <AnimatePresence>
    {open && <motion.div key="drawer" className="fixed inset-0 z-[60]" initial="initial" animate="animate" exit="exit">
      <motion.button variants={{ initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }} transition={reduced ? reducedTransition : presets.spring.sheet} aria-label="Close panel" onClick={onClose} className="st-scrim absolute inset-0 h-full w-full cursor-default backdrop-blur-[2px]" />
      <DialogSurface
        variants={drawer}
        // Work that depends on the panel waits until its opening spring lands.
        onAnimationComplete={(definition) => { if (definition === "animate") onLanded?.(); }}
        ref={panelRef}
        tabIndex={-1}
        onClose={onClose}
        aria-modal="true"
        aria-label={title}
        className={`glass-modal absolute top-0 right-0 flex h-full w-full flex-col outline-none ${wide ? "max-w-[760px]" : "max-w-[520px]"}`}
        
      >
        <div className="flex items-start justify-between gap-4 px-6 py-5" style={{ borderBottom: "1px solid var(--hair)" }}>
          <div>
            <SectionHeader as="h2" className="font-display text-[18px] font-semibold tracking-tight text-ink">{title}</SectionHeader>
            {subtitle ? <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p> : null}
          </div>
          <button onClick={onClose} aria-label="Close" className={`flex size-9 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-ink/[0.06] hover:text-ink ${FOCUS}`}>
            <X size={17} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </DialogSurface>
    </motion.div>}
    </AnimatePresence>, document.body,
  );
}

export function EmptyState({ title, body, children, variant = "card", as: Tag = "div", className, ...props }: {
  title?: string; body?: string; children?: ReactNode; variant?: "card" | "inline"; as?: "div" | "p" | "span";
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
  if (variant === "inline") return <Tag {...props} className={className ?? "text-micro text-muted"}>{title}{body}{children}</Tag>;
  return <div {...props} className={className ?? "st-glass-surface overflow-hidden rounded-2xl px-8 py-16 text-center"}>
    <div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-accent/12"><span className="st-brand-gradient size-2.5 rounded-full" /></div>
    <SectionHeader as="h2" className="font-display mt-4 text-[18px] font-semibold tracking-tight text-ink">{title}</SectionHeader>
    {body ? <p className="mx-auto mt-1 max-w-md text-[15px] text-muted">{body}</p> : null}
    {children ? <div className="mt-5 flex justify-center gap-2">{children}</div> : null}
  </div>;
}

const LINE_WIDTHS = ["90%", "65%", "82%", "55%"];
export function SkeletonBar({ width = "100%", className = "" }: { width?: string; className?: string }) {
  return <div className={`st-skel-pulse h-3 ${className}`} style={{ width }} />;
}

export function Skeleton({ kind = "lines", count }: { kind?: "tiles" | "table" | "cards" | "list" | "lines"; count?: number }) {
  const n = count ?? { tiles: 4, table: 6, cards: 3, list: 4, lines: 4 }[kind];
  if (kind === "lines") {
    return (
      <div aria-busy="true" aria-label="Loading" className="st-skel-in flex flex-col gap-2.5">
        {Array.from({ length: n }, (_, i) => (
          <SkeletonBar key={i} width={LINE_WIDTHS[i % LINE_WIDTHS.length]} />
        ))}
      </div>
    );
  }
  if (kind === "tiles" || kind === "cards") {
    return (
      <div aria-busy="true" aria-label="Loading" className="st-skel-in grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: n }, (_, i) => (
          <div key={i} className="st-glass-surface rounded-2xl p-5">
            <SkeletonBar width="55%" />
            <SkeletonBar width="80%" className="mt-3 h-6" />
          </div>
        ))}
      </div>
    );
  }
  if (kind === "table") {
    return (
      <div aria-busy="true" aria-label="Loading" className="st-skel-in st-glass-table overflow-hidden rounded-2xl p-4">
        <div className="flex flex-col gap-3">
          {Array.from({ length: n }, (_, i) => (
            <SkeletonBar key={i} width={LINE_WIDTHS[i % LINE_WIDTHS.length]} />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div aria-busy="true" aria-label="Loading" className="st-skel-in flex flex-col gap-2">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="st-glass-surface flex items-center gap-3 rounded-2xl px-4 py-3">
          <div className="st-skel-pulse size-8 shrink-0 rounded-full" />
          <SkeletonBar width={LINE_WIDTHS[i % LINE_WIDTHS.length]} />
        </div>
      ))}
    </div>
  );
}

/** Shared page title row. */
export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <h1 className="font-display text-[28px] leading-none font-semibold tracking-[-0.025em] text-ink">{title}</h1>
      {children}
    </div>
  );
}

/** Native surfaces in pages outside V5's edit boundary share the same physics.
 * Delegation avoids a listener/state subscription on every card and image.
 */
export function MotionSurfaces() {
  const reduced = useReducedMotion();
  useEffect(() => {
    type Playback = { stop: () => void };
    const running = new Map<HTMLElement, Playback>();
    const touched = new Set<HTMLElement>();
    const hovered = new Set<HTMLElement>();
    const panels = new Map<HTMLElement, MutationObserver>();
    const exits = new Map<HTMLElement, () => void>();
    const ghosts = new Set<HTMLElement>();
    let trigger: HTMLElement | null = null;
    let pressed: HTMLElement | null = null;
    const nativeCards = '[data-storyboard-row], [data-cut-thumbnail], [aria-label="Cut versions"] button';
    const cardSelector = `${nativeCards}, article, [data-magnify="card"]`;
    function play(el: HTMLElement, scale: number, y = 0, pressing = false) {
      running.get(el)?.stop();
      touched.add(el);
      running.set(el, animate(el, reduced ? { opacity: scale < 1 ? 0.8 : 1 } : { scale, y },
        reduced ? reducedTransition : pressing ? presets.spring.press : presets.spring.hover));
    }
    function controlAt(target: EventTarget | null) {
      if (!(target instanceof Element)) return null;
      const el = target.closest<HTMLElement>('button, a[href], [role="button"]');
      if (!el || el.closest('[data-timeline], [data-slider]') || el.matches(':disabled, [aria-disabled="true"], [data-magnify]') || el.closest('[data-dock]') || el.matches(nativeCards)) return null;
      // The large opener is part of its card, rather than a second scale layer.
      if (el.closest('article, [data-magnify="card"]') && (el.classList.contains('w-full') || el.className.includes('after:absolute'))) return null;
      return el;
    }
    function surfaces(target: EventTarget | null) {
      const result = new Set<HTMLElement>();
      if (!(target instanceof Element)) return result;
      const card = target.closest<HTMLElement>(cardSelector);
      if (card && !card.matches(':disabled') && !card.querySelector<HTMLButtonElement>('button')?.disabled) result.add(card);
      const control = controlAt(target);
      if (control) result.add(control);
      return result;
    }
    function images(card: HTMLElement) { return card.querySelectorAll<HTMLElement>('[data-magnify-image], :scope[data-cut-thumbnail] > img, :scope[data-cut-thumbnail] > video'); }
    function hover(event: PointerEvent) {
      if (event.pointerType === 'touch') return;
      const next = surfaces(event.type === 'pointerout' ? event.relatedTarget : event.target);
      hovered.forEach((el) => {
        if (next.has(el)) return;
        hovered.delete(el);
        el.style.willChange = '';
        if (!el.matches('article, [data-magnify]')) play(el, 1);
        images(el).forEach((img) => { img.style.willChange = ''; if (!reduced) play(img, 1); });
      });
      next.forEach((el) => {
        if (hovered.has(el)) return;
        hovered.add(el); touched.add(el);
        if (!reduced) el.style.willChange = 'transform';
        // Only controls grow; cards and their pictures stay still.
        if (!el.matches('article, [data-magnify]') && !el.matches(nativeCards)) play(el, 1.03, 0);
      });
    }
    function remember(target: EventTarget | null) {
      if (!(target instanceof Element)) return;
      const candidate = target.closest<HTMLElement>('[aria-haspopup], [aria-expanded], select');
      if (candidate) trigger = candidate;
    }
    function down(event: PointerEvent) {
      if (event.button !== 0) return;
      remember(event.target);
      pressed = controlAt(event.target) ?? (event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-cut-thumbnail], [aria-label="Cut versions"] button:not(:disabled)') : null);
      if (pressed) play(pressed, 0.96, 0, true);
    }
    function release() {
      if (pressed?.isConnected) play(pressed, hovered.has(pressed) ? pressed.matches(nativeCards) ? 1.025 : 1.04 : 1, hovered.has(pressed) && pressed.matches(nativeCards) ? -2 : 0);
      pressed = null;
    }
    function key(event: KeyboardEvent) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') remember(event.target);
      if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
        remember(event.target);
        pressed = controlAt(event.target);
        if (pressed) play(pressed, 0.96, 0, true);
      }
    }
    function panel(el: HTMLElement) {
      if (panels.has(el)) return;
      // Origins may be outside the panel: the Settings sheet grows from its gear.
      const initialBox = el.getBoundingClientRect();
      const anchor = el.getAttribute('aria-labelledby') === 'settings-title'
        ? document.querySelector<HTMLElement>('button[aria-label="Settings"]')
        : el.id ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(el.id)}"]`) ?? trigger
        : el.parentElement?.querySelector<HTMLElement>(':scope > [aria-haspopup][aria-expanded="true"]') ?? trigger;
      if (anchor) {
        const a = anchor.getBoundingClientRect(), box = el.getBoundingClientRect();
        // Initial pop scale is centred; recover its untransformed top/left.
        el.style.transformOrigin = `${a.left + a.width / 2 - box.left + (el.offsetWidth - box.width) / 2}px ${a.top + a.height / 2 - box.top + (el.offsetHeight - box.height) / 2}px`;
      }
      // Shared `pop` owns Settings, the switcher and shoot autopilot. Legacy
      // opacity-only popovers get a separate compositor scale, never layout.
      const native = el.id !== 'shoot-switcher-menu' && el.getAttribute('aria-labelledby') !== 'settings-title' && el.getAttribute('aria-label') !== 'Shoot autopilot';
      if (!native || reduced) { panels.set(el, new MutationObserver(() => {})); return; }
      touched.add(el);
      // Mini uses the compositor directly, so the legacy opacity renderer cannot
      // replace the physical entry. Its presence lifecycle still owns removal.
      running.set(el, animateMini(el, { opacity: [0, 1], scale: [0.96, 1] }, { ...presets.spring.sheet, type: springGenerator }));
      let closing = false;
      function closePanel() {
        if (closing) return;
        closing = true;
        const box = el.isConnected ? el.getBoundingClientRect() : initialBox;
        const current = el.isConnected ? getComputedStyle(el) : null;
        // Native dropdowns can unmount immediately. An inert visual copy lets
        // the press spring finish without changing their focus/data lifecycle.
        const ghost = el.cloneNode(true) as HTMLElement;
        const opacity = current?.opacity ?? '1';
        const scale = current?.scale ?? '1';
        ghost.removeAttribute('id'); ghost.removeAttribute('aria-labelledby');
        ghost.setAttribute('role', 'presentation'); ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
        ghost.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
        Object.assign(ghost.style, { position: 'fixed', left: `${box.left}px`, top: `${box.top}px`, right: 'auto', bottom: 'auto',
          width: `${el.offsetWidth || initialBox.width}px`, height: `${el.offsetHeight || initialBox.height}px`, margin: '0',
          zIndex: '1000', pointerEvents: 'none', visibility: 'visible', transform: 'none', scale, opacity });
        running.get(el)?.stop();
        el.style.visibility = 'hidden';
        ghosts.add(ghost); document.body.appendChild(ghost);
        const exit = animateMini(ghost, { opacity: 0, scale: 0.96 }, { ...presets.spring.press, type: springGenerator });
        running.set(ghost, exit);
        void exit.then(() => { ghost.remove(); ghosts.delete(ghost); running.delete(ghost); });
      }
      exits.set(el, closePanel);
      const expanded = new MutationObserver(() => {
        if (anchor?.getAttribute('aria-expanded') === 'false') closePanel();
      });
      if (anchor) expanded.observe(anchor, { attributes: true, attributeFilter: ['aria-expanded'] });
      panels.set(el, expanded);
    }
    const panelSelector = '.st-pop[role="dialog"], .st-pop[role="menu"], .st-glass-pop[role="listbox"], [aria-labelledby="settings-title"]';
    const observer = new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches(panelSelector)) panel(node);
        node.querySelectorAll<HTMLElement>(panelSelector).forEach(panel);
      }));
      panels.forEach((watcher, el) => {
        if (!el.isConnected) { exits.get(el)?.(); exits.delete(el); watcher.disconnect(); panels.delete(el); running.get(el)?.stop(); running.delete(el); touched.delete(el); }
      });
      touched.forEach((el) => { if (!el.isConnected) { running.get(el)?.stop(); running.delete(el); touched.delete(el); hovered.delete(el); } });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll<HTMLElement>(panelSelector).forEach(panel);
    document.addEventListener('pointerover', hover);
    document.addEventListener('pointerout', hover);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('keyup', release);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    return () => {
      observer.disconnect(); panels.forEach((watcher) => watcher.disconnect());
      running.forEach((animation) => animation.stop());
      ghosts.forEach((ghost) => ghost.remove());
      touched.forEach((el) => { el.style.willChange = ''; if (!el.matches('article, [data-magnify]')) { el.style.transform = ''; el.style.scale = ''; el.style.opacity = ''; el.style.visibility = ''; } });
      document.removeEventListener('pointerover', hover);
      document.removeEventListener('pointerout', hover);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('keyup', release);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
    };
  }, [reduced]);
  return <style>{`
    [data-cut-thumbnail] { overflow: hidden; }
    [data-cut-thumbnail] > [aria-hidden="true"] { bottom: 0; }
  `}</style>;
}
