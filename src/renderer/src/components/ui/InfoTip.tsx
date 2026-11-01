import { cloneElement, isValidElement, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "../icons";

/** Shared by control explanations and shortcut hints. The portal escapes sheet clipping. */
/** `state` is a quiet word after the label (a toggle's on or off, why a button waits); `below` opens it under the control. */
export function Tooltip({ label, shortcut, state, below = false, children, wrap = false }: { label: string; shortcut?: string; state?: string; below?: boolean; children: ReactNode; wrap?: boolean }) {
  const id = useId(), anchor = useRef<HTMLSpanElement>(null), tip = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false), [dismissed, setDismissed] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const open = (hovered || focused) && !dismissed;
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect(), t = tip.current?.getBoundingClientRect();
      if (!a || !t) return;
      setPosition({ left: Math.max(8, Math.min(innerWidth - t.width - 8, a.left + a.width / 2 - t.width / 2)),
        top: (below ? innerHeight - a.bottom < t.height + 8 : a.top >= t.height + 8) ? a.top - t.height : Math.min(innerHeight - t.height - 8, a.bottom) });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); setDismissed(true);
    };
    place();
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, label, shortcut, state, below]);
  return <span ref={anchor} className="inline-flex items-center" onMouseEnter={() => { setHovered(true); setDismissed(false); }} onMouseLeave={() => setHovered(false)}
    onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocused(false); }}>
    {isValidElement<{ "aria-describedby"?: string }>(children) ? cloneElement(children, { "aria-describedby": [children.props["aria-describedby"], id].filter(Boolean).join(" ") }) : children}
    {open ? createPortal(<span ref={tip} id={id} role="tooltip" data-precut-tooltip className={`st-tooltip fixed z-[300] rounded-lg px-3 py-2 text-micro font-normal ${wrap ? "w-64 whitespace-normal" : "w-max whitespace-nowrap"}`}
      style={{ ...position, maxWidth: "calc(100vw - 16px)", border: 0, outline: "none", boxShadow: "none", filter: "none", backdropFilter: "none" }}>
      {label}{state && <span className="ml-1.5 opacity-70">{state}</span>}{shortcut && <kbd className="ml-3 font-mono">{shortcut}</kbd>}
    </span>, document.body) : <span id={id} hidden>{label}{state ? `, ${state}` : ""}{shortcut ? ` (${shortcut})` : ""}</span>}
  </span>;
}

export function InfoTip({ label, children }: { label: string; children: string }) {
  return <Tooltip label={children} wrap><button type="button" aria-label={`About ${label.toLowerCase()}`}
    onClick={event => { event.preventDefault(); event.stopPropagation(); }} onDoubleClick={event => event.stopPropagation()}
    className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-ink/[0.05] text-muted hover:bg-ink/[0.1] hover:text-ink focus-visible:bg-[var(--selection-fill)] focus-visible:text-ink"
    style={{ border: 0, outline: "none", boxShadow: "none", filter: "none", backdropFilter: "none" }}><Info size={14} /></button></Tooltip>;
}

/** The info button stays outside the label so opening help never toggles a control. */
export function InfoLabel({ label, htmlFor, children }: { label: string; htmlFor: string; children: string }) {
  return <span className="inline-flex items-center gap-1"><label htmlFor={htmlFor}>{label}</label><InfoTip label={label}>{children}</InfoTip></span>;
}

export const CONTROL_TIPS = {
  fit: "Shortens or repeats the song so it ends with your last frame.",
  story: "Chooses parts of the song to match your story, from the opening to the payoff.",
  beat: "Moves cuts onto the beat while keeping each clip's best moment and protecting spoken words.",
  stems: "Dips the melody under speech while drums and bass keep going. Needs Sound separation.",
  duck: "Turns the music down while someone talks, then brings it back.",
  mix: "Cleans voices, levels clips and sets the music under them.",
  correct: "Balances brightness and white balance across clips. Keeps changes you made by hand.",
  correctClip: "Balances this clip's brightness and white balance.",
  fade: "Lifts dark areas and softens bright areas for a faded film look.",
  diffusion: "Softens fine detail and spreads bright highlights for a softer picture.",
  intensity: "Sets how strongly the chosen look changes the picture.",
  energy: "Adds small changes in framing at cuts. Punchy also shortens pauses between words.",
} as const;
