import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps, type Variants } from "framer-motion";
import * as presets from "../motion";
import { X } from "@phosphor-icons/react";

// The only timing override is the accessibility ceiling from the M1 brief.
export const reducedTransition = { duration: Math.min(presets.dur.fast, 120 / 1000) };
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
  // Item delays cap the house stagger at two steps, even for a long grid.
  return <FirstList.Provider value={first.current}>
    <motion.div role="list" data-motion-list variants={reduced ? {} : { ...presets.list, animate: {} }} initial="initial" animate="animate" {...props}>{children}</motion.div>
  </FirstList.Provider>;
}
export function MotionItem({ index = 0, ...props }: HTMLMotionProps<"div"> & { index?: number }) {
  const first = useContext(FirstList);
  const { item, reduced, layoutTransition } = useMotionPresets();
  const stagger = presets.list.animate as { transition: { delayChildren: number; staggerChildren: number } };
  const target = item.animate as { transition: object };
  const variants = { ...item, animate: { ...target, transition: {
    ...target.transition,
    delay: !reduced && first ? stagger.transition.delayChildren + Math.min(index, 1) * stagger.transition.staggerChildren : 0,
  } } };
  return <motion.div role="listitem" data-motion-item layout={reduced ? false : "position"} variants={variants} initial={first ? "initial" : false} animate="animate" transition={{ layout: layoutTransition }} {...props} />;
}

export function Img({ src, className = "", style, onLoad, onError, instant = false, ...props }: HTMLMotionProps<"img"> & { instant?: boolean }) {
  const { reduced } = useMotionPresets();
  const [loaded, setLoaded] = useState<string>();
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => { if (ref.current?.complete && ref.current.naturalWidth) setLoaded(src); }, [src]);
  return <motion.span className={`relative block overflow-hidden bg-ink/[0.04] ${className}`} style={style}>
    <motion.img {...props} ref={ref} src={src} className="h-full w-full object-[inherit]" style={{ objectFit: "inherit" }}
      initial={false} animate={{ opacity: instant || loaded === src ? 1 : 0 }}
      transition={instant ? { duration: 0 } : reduced ? reducedTransition : presets.imgIn}
      onLoad={(e) => { setLoaded(src); onLoad?.(e); }} onError={(e) => { setLoaded(undefined); onError?.(e); }} />
  </motion.span>;
}
export const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export function Card({ children, className = "", onClick, ...props }: HTMLMotionProps<"div">) {
  const { reduced } = useMotionPresets();
  return <motion.div onClick={onClick} whileHover={onClick && !reduced ? presets.hoverLift : undefined} className={`st-glass-surface overflow-hidden rounded-2xl p-5 ${className}`} {...props}>{children}</motion.div>;
}

type ButtonVariant = "primary" | "secondary" | "ghost";
export function Button({
  variant = "secondary",
  className = "",
  ...props
}: HTMLMotionProps<"button"> & { variant?: ButtonVariant }) {
  const { reduced } = useMotionPresets();
  const styles: Record<ButtonVariant, string> = {
    primary: "st-brand-gradient font-semibold text-white",
    secondary: "bg-ink/[0.06] font-medium text-ink hover:bg-ink/[0.1]",
    ghost: "font-medium text-muted hover:bg-ink/[0.06] hover:text-ink",
  };
  return (
    <motion.button
      whileTap={!props.disabled && !reduced ? presets.press : undefined}
      className={`inline-flex items-center justify-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] transition-[background-color,filter,color] duration-150 disabled:cursor-not-allowed disabled:opacity-45 ${styles[variant]} ${FOCUS} ${className}`}
      {...props}
    />
  );
}

type PillTone = "good" | "warn" | "danger" | "neutral" | "accent";
export function Pill({ tone = "neutral", children }: { tone?: PillTone; children: ReactNode }) {
  const tones: Record<PillTone, string> = {
    good: "bg-good-soft text-ink",
    warn: "bg-warn-soft text-ink",
    danger: "bg-danger/12 text-ink",
    neutral: "bg-neutral text-muted",
    // Existing callers use accent for alternatives and informational statuses.
    accent: "bg-neutral text-muted",
  };
  const dots: Partial<Record<PillTone, string>> = {
    good: "bg-good",
    warn: "bg-warn",
    danger: "bg-danger",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-medium ${tones[tone]}`}>
      {dots[tone] && <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dots[tone]}`} />}
      {children}
    </span>
  );
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
  return <motion.button ref={ref} aria-pressed={selected}
    className={`relative isolate ${selected ? "font-medium text-ground" : "st-glass-surface st-glass-hover text-muted hover:text-ink"} rounded-full px-3.5 py-1.5 text-[13px] ${FOCUS} ${className}`} {...props}>
    {selected && <motion.span aria-hidden="true" layoutId={reduced || !highlight ? undefined : `chip-${highlight}`}
      initial={false} transition={reduced ? reducedTransition : presets.spring.pill} className="absolute inset-0 -z-10 rounded-full bg-ink" />}
    {children}
  </motion.button>;
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
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return createPortal(
    <AnimatePresence>
    {open && <motion.div key="drawer" className="fixed inset-0 z-[60]" initial="initial" animate="animate" exit="exit">
      <motion.button variants={{ initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }} transition={reduced ? reducedTransition : { duration: presets.dur.base }} aria-label="Close panel" onClick={onClose} className="st-scrim absolute inset-0 h-full w-full cursor-default backdrop-blur-[2px]" />
      <motion.div
        variants={drawer}
        // Consider the spring landed once it is within one pixel of its target.
        onUpdate={(latest) => { if (reduced || (typeof latest.x === "number" && Math.abs(latest.x) < 1)) onLanded?.(); }}
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`st-glass-pop absolute top-0 right-0 flex h-full w-full flex-col outline-none ${wide ? "max-w-[760px]" : "max-w-[520px]"}`}
        style={{ borderLeft: "1px solid var(--hair)" }}
      >
        <div className="flex items-start justify-between gap-4 px-6 py-5" style={{ borderBottom: "1px solid var(--hair)" }}>
          <div>
            <h2 className="font-display text-[19px] font-semibold tracking-tight text-ink">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p> : null}
          </div>
          <button onClick={onClose} aria-label="Close" className={`flex size-9 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-ink/[0.06] hover:text-ink ${FOCUS}`}>
            <X size={17} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </motion.div>
    </motion.div>}
    </AnimatePresence>, document.body,
  );
}

export function EmptyState({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <div className="st-glass-surface overflow-hidden rounded-2xl px-8 py-16 text-center">
      <div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-accent/12">
        <span className="st-brand-gradient size-2.5 rounded-full" />
      </div>
      <h2 className="font-display mt-4 text-[18px] font-semibold tracking-tight text-ink">{title}</h2>
      {body ? <p className="mx-auto mt-1 max-w-md text-[14px] text-muted">{body}</p> : null}
      {children ? <div className="mt-5 flex justify-center gap-2">{children}</div> : null}
    </div>
  );
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

/** Page title row: 32px Outfit title, actions on the right. Every page uses this. */
export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <h1 className="font-display text-[32px] leading-none font-semibold tracking-[-0.025em] text-ink">{title}</h1>
      {children}
    </div>
  );
}
