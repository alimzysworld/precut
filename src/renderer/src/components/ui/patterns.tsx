import { NamedMessage } from "../ClipNames";
import * as presets from "../../motion";
import { createElement, forwardRef, useEffect, useId, type RefObject, type ElementType, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { motion, useReducedMotion, type MotionProps, type HTMLMotionProps } from "framer-motion";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { usePageActive } from "../../hooks/usePageActivity";

/** Shared pattern geometry. Callers keep content, state and domain actions. */
export function Row({ as: Tag = "div", icon, label, value, chevron, children, className = "", ...props }: {
  as?: "div" | "label" | "button"; icon?: ReactNode; label?: ReactNode; value?: ReactNode; chevron?: boolean;
} & ComponentPropsWithoutRef<"button"> & { htmlFor?: string }) {
  return createElement(Tag, { ...props, className: `flex items-center justify-between gap-3 ${className}` }, <>
    {label !== undefined ? <><span className="flex min-w-0 items-center gap-2">{icon}{label}</span><span className="ml-auto text-muted">{value}</span>{chevron && <CaretRight aria-hidden="true" size={14} />}</> : children}
  </>);
}

export function SectionHeader({ as: Tag = "h3", heading, className = "font-medium", children, ...props }: ComponentPropsWithoutRef<"h3"> & { as?: "h2" | "h3" | "h4"; heading?: string }) {
  if (heading !== undefined) return <div className="mb-5"><Tag {...props} className="font-display text-title font-semibold">{heading}</Tag>{children && <p className="mt-2 text-small leading-relaxed text-muted">{children}</p>}</div>;
  return <Tag {...props} className={className}>{children}</Tag>;
}

export function Tile({ as: Tag = "button", selected, className = "", ...props }: ComponentPropsWithoutRef<"button"> & {
  as?: "button" | "article" | "div"; selected?: boolean;
} & Pick<MotionProps, "initial" | "animate" | "exit" | "transition">) {
  return createElement((props.initial || props.animate ? motion[Tag] : Tag) as ElementType, { ...props, type: Tag === "button" ? props.type ?? "button" : undefined, "aria-pressed": Tag === "button" ? selected ?? props["aria-pressed"] : undefined,
    className: `${selected === undefined ? "" : selected ? "bg-ink/10" : "bg-ink/[0.04]"} outline-none ${className || "rounded-lg"}` });
}

/** Native checkbox semantics keep labels, Space, change events and fieldsets working. */
export function Switch({ label, className = "", ...props }: Omit<ComponentPropsWithoutRef<"input">, "type" | "role"> & { label?: string }) {
  return <input aria-label={label} {...props} type="checkbox" role={props["aria-checked"] === "mixed" ? "checkbox" : "switch"} aria-checked={props["aria-checked"] ?? props.checked}
    className={`h-6 w-11 shrink-0 cursor-pointer appearance-none rounded-full bg-ink/15 p-0.5 before:block before:size-5 before:rounded-full before:bg-[var(--control-thumb)] checked:bg-[image:var(--st-brand-gradient)] checked:before:translate-x-5 disabled:cursor-not-allowed disabled:opacity-45 outline-none ${className}`} />;
}

export function InlineError({ as: Tag = "p", error, children, className = "text-micro text-danger", ...props }: ComponentPropsWithoutRef<"p"> & { as?: "p" | "div"; error?: string | null }) {
  if (!children && !error) return null;
  return <Tag {...props} role="alert" className={className}><NamedMessage>{children ?? error}</NamedMessage></Tag>;
}

export function NumberField({ numeric = true, className = "w-20 rounded-lg bg-ink/[0.06] p-2 text-ink outline-none", ...props }: Omit<ComponentPropsWithoutRef<"input">, "type"> & { numeric?: boolean }) {
  return <input {...props} type={numeric ? "number" : "text"} className={className} />;
}

export function BackHeader({ children, className = "", ...props }: ComponentPropsWithoutRef<"button">) {
  return <button type="button" aria-label="Back" {...props} className={`sticky top-0 z-30 flex min-h-14 shrink-0 items-center gap-1 bg-surface px-3 text-small text-ink outline-none ${className}`}>
    <CaretLeft size={30} aria-hidden="true" />{children}
  </button>;
}

export function ProgressRing({ pct, label, className = "text-accent" }: { pct: number | null; label: string; className?: string }) {
  const value = typeof pct === "number" && Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null;
  return <span role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined} className={`relative inline-flex size-4 shrink-0 items-center justify-center ${className}`}>
    <svg aria-hidden="true" viewBox="0 0 32 32" className={`absolute inset-0 size-4 -rotate-90 ${value === null ? "motion-safe:animate-spin" : ""}`}>
      <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeOpacity=".12" strokeWidth="2" />
      <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" pathLength="100" strokeDasharray={`${value ?? 22} 100`} className="motion-safe:transition-[stroke-dasharray]" />
    </svg>
  </span>;
}

/** One menu keyboard policy, including disabled items and focus restoration. */
export const MenuSurface = forwardRef<HTMLDivElement, HTMLMotionProps<"div"> & { onClose?: () => void }>(function MenuSurface({ onClose, onKeyDown, className = "", ...props }, ref) {
  return <motion.div {...props} ref={ref} role="menu" className={`st-pop ${className}`} onKeyDown={event => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose?.(); return; }
    if (event.key === "Tab") { onClose?.(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }} />;
});

/** Shell for centred modals, sheets and nonmodal popovers. */
export const DialogSurface = forwardRef<HTMLDivElement, HTMLMotionProps<"div"> & { onClose?: () => void }>(function DialogSurface({ onClose, onKeyDown, ...props }, ref) {
  return <motion.div {...props} ref={ref} role="dialog" onKeyDown={event => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose?.(); }
    if (event.key !== "Tab" || !props["aria-modal"]) return;
    if (event.target instanceof Element && event.target.closest("[data-mantine-portal]")) return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex="0"]')].filter(el => el.getClientRects().length && !el.closest('[inert]'));
    const first = controls[0], last = controls.at(-1), active = document.activeElement;
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (active === first || active === event.currentTarget)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (active === last || active === event.currentTarget)) { event.preventDefault(); first.focus(); }
  }} />;
});

/** Modal lifecycle shared by the centred and edge variants. */
export function useDialogFocus(panel: RefObject<HTMLElement>, open = true, fallbackSelector?: string) {
  open = usePageActive() && open;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    const background = [...document.body.children].filter(el => el instanceof HTMLElement && !el.contains(panel.current)) as HTMLElement[];
    const inert = background.map(el => el.inert);
    background.forEach(el => { el.inert = true; });
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => {
      background.forEach((el, index) => { el.inert = inert[index]; });
      document.body.style.overflow = overflow;
      previous?.focus();
      if (fallbackSelector && (!document.activeElement || document.activeElement === document.body)) document.querySelector<HTMLElement>(fallbackSelector)?.focus();
    };
  }, [open]);
}

/** Roving focus and linked panels for every inspector tab strip. */
export function Tabs<T extends string>({ label, value, options, onChange, idPrefix, panelId, className = "", itemClassName = "" }: {
  label: string; value: T; options: readonly T[]; onChange: (value: T) => void; idPrefix: string; panelId: string;
  className?: string; itemClassName?: string;
}) {
  return <div role="tablist" aria-label={label} className={className}>{options.map(option => <button key={option} type="button" id={`${idPrefix}-${option}`} role="tab"
    aria-selected={value === option} aria-controls={panelId} tabIndex={value === option ? 0 : -1} onClick={() => onChange(option)}
    className={`min-w-0 flex-1 rounded-lg py-3 text-micro outline-none ${value === option ? "bg-[var(--selection-fill)] font-semibold text-ink" : "text-muted hover:bg-ink/[0.04]"} ${itemClassName}`}
    onKeyDown={event => {
      const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!direction && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      const next = options[event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (options.indexOf(value) + direction + options.length) % options.length];
      onChange(next); document.getElementById(`${idPrefix}-${next}`)?.focus();
    }}>{option}</button>)}</div>;
}

export const MenuOption = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button">>(function MenuOption({ className = "", ...props }, ref) {
  return <button type="button" {...props} ref={ref} role={props.role ?? "menuitem"} className={`st-menu-item outline-none disabled:opacity-45 ${className}`} />;
});

export function Checkbox({ className = "", ...props }: Omit<ComponentPropsWithoutRef<"input">, "type">) {
  return <input {...props} type="checkbox" className={`size-4 shrink-0 accent-accent outline-none ${className}`} />;
}

export function SegmentedControl<T extends string>({ label, value, options, choices, onChange, onSelect, className = "", variant = "pill" }: {
  label: string; value?: T; options?: { value: T; label: ReactNode; disabled?: boolean; selected?: boolean; ariaLabel?: string; title?: string }[]; choices?: readonly T[];
  onChange?: (value: T) => void; onSelect?: (value: T) => void; className?: string; variant?: "pill" | "compact" | "filter";
}) {
  const id = useId(), reduced = useReducedMotion();
  const compact = variant === "compact" || Boolean(choices);
  const items = options ?? choices?.map(choice => ({ value: choice, label: choice[0].toUpperCase() + choice.slice(1) })) ?? [];
  return <div role="group" aria-label={label} className={`${variant === "filter" ? "flex" : "st-segmented"} ${compact ? "flex flex-wrap rounded-xl" : "inline-flex flex-wrap rounded-full"} gap-1 p-1 ${className}`}>
    {items.map(option => {
      const selected = "selected" in option && option.selected !== undefined ? option.selected : value === option.value;
      return <button key={option.value} type="button" aria-pressed={selected} disabled={"disabled" in option ? option.disabled : false} aria-label={"ariaLabel" in option ? option.ariaLabel : undefined} title={"title" in option ? option.title : undefined}
        onClick={() => (onChange ?? onSelect)?.(option.value)} className={`relative inline-flex items-center justify-center min-w-max disabled:opacity-45 ${variant === "filter" ? "st-filter-pill" : compact ? "flex-1 rounded-lg px-2 py-2 text-micro" : "rounded-full px-3.5 py-1.5 text-small"} ${selected ? "text-ink" : "text-muted"} outline-none`}>
        {selected && variant !== "filter" && <motion.span aria-hidden="true" layoutId={reduced || options?.some(item => item.selected) ? undefined : id} className="absolute inset-0 rounded-[inherit] bg-surface" transition={reduced ? presets.instant : presets.spring.pill} />}
        <span className="relative">{option.label}</span>
      </button>;
    })}
  </div>;
}
export { SegmentedControl as Segments, SegmentedControl as SegmentedPills };
