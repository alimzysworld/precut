import { NumberField } from "./ui";
import { Tile, EmptyState } from "./ui";
import { DialogSurface } from "./ui";
import { SegmentedPills, SearchField } from "./ui";
import { Row } from "./ui";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check, MagnifyingGlass, PencilSimple, Plus, Star, Trash, X } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { instant, spring } from "../motion";
import { clipKind, clipShaky } from "./ClipDrawer";
import type { Clip, QualitySpan, Shoot, TakeAttempt } from "../../../shared/schema";
import { isLibraryField, libraryFields, libraryOptions, matchesLibraryFilter, type LibraryField } from "../../../main/library-filters";

import { clipStarred } from "../../../main/footage-stars";

export type FilterField = LibraryField | "starred" | "verdict" | "kind" | "shot" | "shake" | "length" | "sound" | "said" | "didNotSay" | "quality" | "pace" | "hooks" | "soundbite" | "scene" | "eyeContact";
export interface ClipFilter { field: FilterField; operator: "is" | "is not"; values: string[] }
export interface ClipView { id: string; name: string; filters: ClipFilter[]; query: string }
interface ViewStore { views: ClipView[]; defaultId: string; qualityViewsVersion: 1 }
export const CLIP_VIEWS_KEY = "st-footage.clip-views";
const FIELDS: { field: FilterField; label: string; group: string; values: [string, string][] }[] = [
  { field: "starred", label: "Starred", group: "Clip", values: [["yes", "Starred"]] },
  { field: "verdict", label: "Verdict", group: "Clip", values: ["best", "alt", "maybe", "unusable"].map(v => [v, v]) },
  { field: "kind", label: "Kind", group: "Clip", values: [["talking", "Talking"], ["broll", "B-roll"], ["setup", "Setup"], ["unknown", "Unknown"]] },
  { field: "shot", label: "Shot size", group: "Clip", values: ["wide", "medium", "close", "unknown"].map(v => [v, v]) },
  { field: "shake", label: "Shake", group: "Clip", values: ["steady", "shaky", "unmeasured"].map(v => [v, v]) },
  { field: "length", label: "Length", group: "Clip", values: [["short", "Under 30 s"], ["medium", "30 s to 2 min"], ["long", "2 min or more"]] },
  { field: "sound", label: "Mic or camera", group: "Sound", values: [["mic", "Mic"], ["camera", "Camera"], ["unchecked", "Not checked"]] },
  { field: "said", label: "Said", group: "Words", values: [] },
  { field: "didNotSay", label: "Did not say", group: "Words", values: [] },
  { field: "quality", label: "Quality", group: "Quality", values: [["soft-focus", "Soft focus"], ["exposure", "Exposure"], ["sound", "Sound problems"], ["duplicate", "Duplicate"], ["clean", "No flags"]] },
  { field: "pace", label: "Pace", group: "Delivery", values: [["slow", "Slow"], ["normal", "Normal"], ["fast", "Fast"]] },
  { field: "hooks", label: "Hooks", group: "Delivery", values: [["yes", "Hook"]] },
  { field: "soundbite", label: "Has soundbite", group: "Delivery", values: [["yes", "Has soundbite"]] },
  { field: "scene", label: "Tag contains", group: "Scene", values: [] },
  { field: "eyeContact", label: "Eye contact above", group: "Eye contact", values: [] },
  ...Object.entries(libraryFields).map(([field, label]) => ({ field: field as LibraryField, label, group: "Library", values: [] as [string, string][] })),
];
const fieldInfo = (field: FilterField) => FIELDS.find(f => f.field === field)!;

export const qualityLabels: Record<QualitySpan["kind"], string> = {
  "soft-focus": "soft focus", "blown-highlights": "blown highlights", "too-dark": "too dark",
  clipping: "clipping", wind: "wind", rustle: "rustle", noisy: "noise", "no-mic": "no mic",
};
export function topSceneTags(clip: Clip): string[] {
  return [...(clip.quality?.tags ?? [])].sort((a, b) => b.confidence - a.confidence).slice(0, 3).map(tag => tag.label);
}
export function qualityMeasurement(span: QualitySpan): string {
  return `${qualityLabels[span.kind]}: value ${span.value}, ${span.s.toFixed(1)} to ${span.e.toFixed(1)} s`;
}
export function takeQualityFacts(att: TakeAttempt, clip?: Clip): { kind: QualitySpan["kind"]; label: string; measurement: string }[] {
  return [...new Set(att.measures?.flags ?? [])].map(kind => {
    const spans = (clip?.quality?.spans ?? []).filter(span => span.kind === kind && span.s < att.e && span.e > att.s);
    const measurement = spans.length ? spans.map(qualityMeasurement).join("; ") : kind === "soft-focus" && att.measures?.faceQuality != null
      ? `Face capture quality: ${att.measures.faceQuality} (0 to 1)` : `${qualityLabels[kind]} flagged for this take; measurement not available`;
    return { kind, label: qualityLabels[kind], measurement };
  });
}

export function shootPaceThresholds(shoot: Shoot): [number, number] | null {
  const values = shoot.takes.flatMap(take => take.attempts.map(att => att.measures?.wpm))
    .filter((wpm): wpm is number => typeof wpm === "number" && Number.isFinite(wpm) && wpm > 0).sort((a, b) => a - b);
  if (!values.length) return null;
  const quantile = (share: number) => {
    const position = (values.length - 1) * share;
    const lower = Math.floor(position);
    return values[lower] + (values[Math.ceil(position)] - values[lower]) * (position - lower);
  };
  return [quantile(1 / 3), quantile(2 / 3)];
}
const deliveryFields: FilterField[] = ["pace", "hooks", "soundbite", "eyeContact"];
export interface FilterContext { shoot?: Shoot; attempt?: TakeAttempt; pace?: [number, number] | null }

function matchesFactFilter(clip: Clip, filter: ClipFilter, context: FilterContext): boolean {
  const att = context.attempt;
  let matches: boolean;
  switch (filter.field) {
    case "quality": {
      const flags = att ? att.measures?.flags : clip.quality?.spans.map(span => span.kind);
      // An unknown measurement cannot satisfy an inverted condition either.
      if (filter.values.some(value => value === "duplicate" ? clip.quality == null : flags == null)) return false;
      matches = filter.values.some(value => value === "duplicate" ? !!clip.quality?.duplicateOf : value === "clean" ? flags?.length === 0
        : value === "exposure" ? flags?.some(flag => flag === "blown-highlights" || flag === "too-dark")
        : value === "sound" ? flags?.some(flag => ["clipping", "wind", "rustle", "noisy", "no-mic"].includes(flag)) : flags?.includes("soft-focus"));
      break;
    }
    case "scene":
      if (clip.quality == null) return false;
      matches = filter.values.some(value => clip.quality!.tags.some(tag => tag.label.toLowerCase().includes(value.trim().toLowerCase())));
      break;
    case "hooks":
      if (att?.hook == null) return false;
      matches = att.hook; break;
    case "soundbite":
      if (att?.soundbite === undefined) return false;
      matches = !!att?.soundbite?.trim(); break;
    case "eyeContact": {
      const share = att?.measures?.eyeContact;
      if (share == null || !Number.isFinite(share) || share < 0 || share > 1) return false;
      const thresholds = filter.values.map(Number);
      if (thresholds.some(value => !Number.isFinite(value) || value < 0 || value > 100)) return false;
      matches = thresholds.some(value => share > value / 100); break;
    }
    case "pace": {
      const wpm = att?.measures?.wpm;
      const thresholds = context.pace ?? (context.shoot ? shootPaceThresholds(context.shoot) : null);
      if (wpm == null || !Number.isFinite(wpm) || wpm <= 0 || !thresholds) return false;
      matches = filter.values.includes(wpm < thresholds[0] ? "slow" : wpm > thresholds[1] ? "fast" : "normal"); break;
    }
    default: return false;
  }
  return filter.operator === "is" ? matches : !matches;
}

// These are explicit user conditions over existing data, never new AI judgements.
export function matchesClipFilters(clip: Clip, filters: ClipFilter[], context: FilterContext = {}): boolean {
  const delivery = filters.filter(filter => deliveryFields.includes(filter.field) && filter.values.length);
  if (!context.attempt && delivery.length) {
    const attempts = context.shoot?.takes.flatMap(take => take.attempts).filter(att => att.clipId === clip.id) ?? [];
    if (!attempts.some(attempt => delivery.every(filter => matchesFactFilter(clip, filter, { ...context, attempt })))) return false;
  }
  return filters.every(filter => {
    if (!filter.values.length) return true;
    if (isLibraryField(filter.field)) return matchesLibraryFilter(clip, filter.field, filter.values, filter.operator);
    if (deliveryFields.includes(filter.field)) return context.attempt ? matchesFactFilter(clip, filter, context) : true;
    if (filter.field === "quality" || filter.field === "scene") return matchesFactFilter(clip, filter, context);
    let value: string | undefined;
    switch (filter.field) {
      case "starred": value = (context.shoot ? context.attempt ? context.shoot.takes.some(t => t.attempts[t.starred] === context.attempt && !context.attempt?.practice) : clipStarred(context.shoot, clip) : false) ? "yes" : "no"; break;
      case "verdict": value = clip.judgement?.verdict; break;
      case "kind": value = clipKind(clip) ?? "unknown"; break;
      case "shot": value = clip.judgement?.shot ?? "unknown"; break;
      case "shake": { const shaky = clipShaky(clip); value = shaky === undefined ? "unmeasured" : shaky ? "shaky" : "steady"; break; }
      case "sound": value = clip.sound ? "mic" : clip.sound === null ? "camera" : "unchecked"; break;
      case "length": { const seconds = clip.meta?.durationS; value = seconds == null ? undefined : seconds < 30 ? "short" : seconds < 120 ? "medium" : "long"; break; }
      case "said":
      case "didNotSay": {
        // Missing transcription is unknown, not evidence that words were absent.
        if (clip.transcript == null) return false;
        const text = clip.transcript.map(segment => segment.text).join(" ").toLowerCase();
        const said = filter.values.some(word => text.includes(word.trim().toLowerCase()));
        const matches = filter.field === "said" ? said : !said;
        return filter.operator === "is" ? matches : !matches;
      }
    }
    if (value === undefined) return false;
    const matches = filter.values.includes(value);
    return filter.operator === "is" ? matches : !matches;
  });
}

export function starterClipViews(): ViewStore {
  const view = (id: string, name: string, filters: ClipFilter[] = []): ClipView => ({ id, name, filters, query: "" });
  return { defaultId: "all", qualityViewsVersion: 1, views: [
    view("all", "All clips"), view("best", "Starred", [{ field: "starred", operator: "is", values: ["yes"] }]),
    view("talking", "Talking", [{ field: "kind", operator: "is", values: ["talking"] }]),
    view("broll", "B-roll", [{ field: "kind", operator: "is", values: ["broll"] }]),
    view("review", "Needs a look", [{ field: "verdict", operator: "is", values: ["maybe", "unusable"] }]),
    view("clean", "Clean takes", [{ field: "quality", operator: "is", values: ["clean"] }]),
    view("hooks", "Hooks", [{ field: "hooks", operator: "is", values: ["yes"] }]),
  ] };
}

export function readClipViews(): ViewStore {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CLIP_VIEWS_KEY) ?? "null");
    if (!stored || typeof stored !== "object" || !("views" in stored) || !Array.isArray(stored.views)) return starterClipViews();
    const views = stored.views.filter((view): view is ClipView => {
      if (!view || typeof view.id !== "string" || typeof view.name !== "string" || !view.name.trim() || typeof view.query !== "string" || !Array.isArray(view.filters)) return false;
      return view.filters.every((filter: ClipFilter) => filter && FIELDS.some(f => f.field === filter.field) &&
        (filter.operator === "is" || filter.operator === "is not") && Array.isArray(filter.values) &&
        filter.values.every(v => typeof v === "string" && v.trim() && (!fieldInfo(filter.field).values.length || fieldInfo(filter.field).values.some(([value]) => value === v))));
    });
    for (const view of views) if (view.id === "best" && view.name === "Best takes") {
      view.name = "Starred"; view.filters = [{ field: "starred", operator: "is", values: ["yes"] }];
    }
    const unique = views.filter((view, index) => views.findIndex(other => other.id === view.id) === index);
    if (!unique.length) return starterClipViews();
    const defaultId = "defaultId" in stored && unique.some(view => view.id === stored.defaultId) ? String(stored.defaultId) : unique[0].id;
    if (!("qualityViewsVersion" in stored)) {
      for (const view of starterClipViews().views.filter(view => view.id === "clean" || view.id === "hooks")) {
        if (!unique.some(existing => existing.id === view.id)) unique.push(view);
      }
    }
    return { views: unique, defaultId, qualityViewsVersion: 1 };
  } catch { return starterClipViews(); }
}

export function useClipViews(initialQuery?: string) {
  const [store, setStore] = useState(readClipViews);
  const initial = store.views.find(view => view.id === store.defaultId)!;
  const [selectedId, setSelectedId] = useState(initial.id);
  const [filters, setFilters] = useState(initial.filters);
  const [query, setQuery] = useState(initialQuery ?? initial.query);
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(CLIP_VIEWS_KEY, JSON.stringify(store)); setStorageError(false); }
    catch { setStorageError(true); }
  }, [store]);
  const selected = store.views.find(view => view.id === selectedId);
  const dirty = !selected || JSON.stringify(selected.filters) !== JSON.stringify(filters) || selected.query !== query;
  const select = (view: ClipView) => { setSelectedId(view.id); setFilters(view.filters); setQuery(view.query); };
  return {
    ...store, selectedId, filters, setFilters, query, setQuery, dirty, storageError,
    title: selected?.name ?? "Custom view", select,
    save: (name: string) => {
      const view = { id: `view-${crypto.randomUUID()}`, name: name.trim(), filters, query };
      setStore(previous => ({ ...previous, views: [...previous.views, view] }));
      setSelectedId(view.id);
    },
    rename: (id: string, name: string) => setStore(previous => ({ ...previous, views: previous.views.map(view => view.id === id ? { ...view, name: name.trim() } : view) })),
    remove: (id: string) => {
      const views = store.views.filter(view => view.id !== id);
      const next: ViewStore = views.length ? { qualityViewsVersion: 1, views, defaultId: store.defaultId === id ? views[0].id : store.defaultId } : starterClipViews();
      setStore(next);
      if (selectedId === id) select(next.views.find(view => view.id === next.defaultId)!);
    },
    setDefault: (id: string) => setStore(previous => ({ ...previous, defaultId: id })),
  };
}
type Views = ReturnType<typeof useClipViews>;
const buttonClass = "flex items-center gap-2 rounded-lg px-3 py-2 text-small text-ink outline-none hover:bg-ink/[0.06] disabled:opacity-40";
const pillClass = "rounded-full px-3 py-1 text-small outline-none";
const fieldClass = "w-full rounded-lg bg-ink/[0.04] px-3 py-2 text-small text-ink outline-none placeholder:text-muted";

// Shared with the Shoots home. Selection rules stay with the caller.
export { SegmentedPills, SearchField } from "./ui";

function Popover({ anchor, label, onClose, children }: { anchor: HTMLButtonElement | null; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const reduced = useReducedMotion();
  const [position, setPosition] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const width = ref.current?.offsetWidth ?? 340;
      const height = ref.current?.offsetHeight ?? 300;
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: rect.bottom + height + 8 <= window.innerHeight - 12 ? rect.bottom + 8 : Math.max(12, rect.top - height - 8) });
    };
    place();
    const observer = new ResizeObserver(place);
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [anchor, label]);
  useEffect(() => {
    if (!anchor) return;
    ref.current?.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (!ref.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) close.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopImmediatePropagation(); close.current(); anchor.focus({ preventScroll: true });
    };
    const dismiss = () => close.current();
    const scroll = (event: Event) => { if (!ref.current?.contains(event.target as Node)) dismiss(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside);
      window.removeEventListener("keydown", escape, true); window.removeEventListener("resize", dismiss); window.removeEventListener("scroll", scroll, true);
    };
  }, [anchor, label]);
  return createPortal(<AnimatePresence>{anchor ? <DialogSurface ref={ref} onClose={onClose} aria-label={label}
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduced ? instant : spring.sheet}
    className="bg-ground fixed z-[80] max-h-[calc(100dvh-24px)] w-[340px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-2xl p-2 text-small text-ink"
    style={{ ...position, boxShadow: "none", border: 0 }}>{children}</DialogSurface> : null}</AnimatePresence>, document.body);
}

function FilterEditor({ filter, options, onApply, onClear }: { filter: ClipFilter; options?: [string, string][]; onApply: (filter: ClipFilter) => void; onClear: () => void }) {
  const [operator, setOperator] = useState(filter.operator);
  const [values, setValues] = useState(filter.values);
  const [word, setWord] = useState("");
  const info = fieldInfo(filter.field);
  const choices = options ?? info.values;
  const freeText = !choices.length && !options;
  const eyeContact = filter.field === "eyeContact";
  const toggle = (value: string) => setValues(previous => previous.includes(value) ? previous.filter(v => v !== value) : [...previous, value]);
  const addWord = () => {
    const value = word.trim();
    if (eyeContact && (!value || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100)) return;
    if (value && !values.includes(value)) setValues(previous => eyeContact ? [value] : [...previous, value]);
    setWord("");
  };
  return <>
    <SegmentedPills label="Filter operator" value={operator} choices={["is", "is not"]} onChange={setOperator} className="m-2" />
    <p className="px-3 pt-3 text-micro text-muted">{info.label}</p>
    <div className="flex flex-wrap gap-1.5 p-3">
      {(freeText ? values.map(value => [value, value]) : [...choices, ...values.filter(v => !choices.some(([key]) => key === v)).map(v => [v, `${v} · 0`])]).map(([value, label]) => <Tile key={value} type="button" aria-pressed={values.includes(value)} onClick={() => toggle(value)} className={`${pillClass} bg-ink/[0.025] ${values.includes(value) ? "bg-ink text-ground" : "text-ink hover:bg-ink/[0.06]"}`}>{label}</Tile>)}
    </div>
    {freeText ? <form className="flex gap-1 px-3 pb-3" onSubmit={event => { event.preventDefault(); addWord(); }}>
      <NumberField autoComplete="off" numeric={eyeContact} min={eyeContact ? 0 : undefined} max={eyeContact ? 100 : undefined} step={eyeContact ? 1 : undefined}
        aria-label={eyeContact ? "Eye contact share (%)" : filter.field === "scene" ? "Scene tag contains" : "Word or phrase"}
        placeholder={eyeContact ? "Share, 0 to 100%" : filter.field === "scene" ? "Tag contains" : "Word or phrase"} value={word} onChange={event => setWord(event.target.value)} className={fieldClass} />
      <button type="submit" aria-label="Add phrase" disabled={!word.trim()} className={buttonClass}><Plus size={14} /></button>
    </form> : null}
    <p className="px-3 pb-3 text-micro text-muted">{eyeContact ? "Share facing the lens, in percent. Informational; fixable in post." : filter.field === "pace" ? "Slow, normal and fast are thirds of measured words per minute across this shoot." : filter.field === "scene" ? "Matches any scene tag containing this text." : filter.field === "didNotSay" ? "Excludes clips containing any selected phrase." : "Matches any selected value."} Missing measurements do not match.</p>
    <div className="flex justify-end gap-2 p-2">
      <button type="button" onClick={onClear} className={buttonClass}>Clear</button>
      <button type="button" disabled={(!values.length && !word.trim()) || (eyeContact && [...values, ...(word.trim() ? [word.trim()] : [])].some(value => !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100))} onClick={() => onApply({ ...filter, operator, values: word.trim() ? [...new Set([...values, word.trim()])] : values })} className={`${pillClass} st-button-primary disabled:opacity-40`}>Apply</button>
    </div>
  </>;
}

export function Filters({ filters, onChange, query, onQueryChange, takes = false, hideSearch = false, shoot }: { filters: ClipFilter[]; onChange: (filters: ClipFilter[]) => void; query: string; onQueryChange: (query: string) => void; takes?: boolean; hideSearch?: boolean; shoot?: Shoot }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [editing, setEditing] = useState<ClipFilter | null>(null);
  const [search, setSearch] = useState("");
  const close = () => { setAnchor(null); };
  const update = (filter: ClipFilter) => onChange([...filters.filter(f => f.field !== filter.field), filter]);
  const optionsFor = (field: FilterField): [string, string][] | undefined => {
    if (isLibraryField(field)) return libraryOptions(shoot?.clips ?? [], field);
    const info = fieldInfo(field);
    if (!shoot || !info.values.length) return undefined;
    return info.values.flatMap(([value, label]) => {
      const count = shoot.clips.filter(c => !c.leftOut && matchesClipFilters(c, [{ field, operator: "is", values: [value] }], { shoot })).length;
      return count ? [[value, `${label} · ${count}`] as [string, string]] : [];
    });
  };
  const availableFields = FIELDS.filter(info => !isLibraryField(info.field) || !!optionsFor(info.field)?.length);
  const takeSelect = (field: "kind" | "verdict" | "sound", label: string) => {
    const active = filters.find(filter => filter.field === field);
    const simple = active?.operator === "is" && active.values.length === 1;
    return <select aria-label={label} className="rounded-xl bg-ink/[0.04] px-3 py-2 text-small text-ink outline-none"
      value={active ? simple ? active.values[0] : "saved" : ""}
      onChange={event => { if (event.target.value === "saved") return; if (event.target.value) update({ field, operator: "is", values: [event.target.value] }); else onChange(filters.filter(filter => filter.field !== field)); }}>
      <option value="">{label}</option>
      {active && !simple ? <option value="saved">{label} {active.operator} {active.values.join(", ")}</option> : null}
      {(optionsFor(field) ?? fieldInfo(field).values).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
    </select>;
  };
  const segmented = (field: "kind" | "sound", options: [string, string][]) => {
    const active = filters.find(f => f.field === field);
    return <SegmentedPills label={field === "kind" ? "Clip kind" : "Clip sound"}
      options={options.flatMap(([value, label]) => {
        const counted = shoot && value !== "all" ? optionsFor(field)?.find(([key]) => key === value) : undefined;
        return shoot && value !== "all" && !counted ? [] : [{ value, label: counted?.[1] ?? label, selected: value === "all" ? !active : active?.operator === "is" && active.values.includes(value) || false }];
      })}
      onSelect={value => {
        if (value === "all") { onChange(filters.filter(f => f.field !== field)); return; }
        // Kind is a quick single choice; sound permits Mic OR Camera and toggles back to any.
        const values = field === "sound" && active?.operator === "is" ? active.values.includes(value) ? active.values.filter(v => v !== value) : [...active.values, value] : [value];
        if (values.length) update({ field, operator: "is", values }); else onChange(filters.filter(f => f.field !== field));
      }} />;
  };
  return <div className="mb-5 flex flex-wrap items-center gap-2" aria-label={takes ? "Take filters" : "Clip filters"}>
    {takes ? <>
      {takeSelect("kind", "Kind of line")}{takeSelect("verdict", "Verdict")}{takeSelect("sound", "Mic or camera")}
      <input aria-label="Words said" placeholder="Words said" value={filters.find(filter => filter.field === "said")?.values.join(", ") ?? ""}
        onChange={event => { const active = filters.find(filter => filter.field === "said"); if (event.target.value.trim()) update({ field: "said", operator: active?.operator ?? "is", values: [event.target.value] }); else onChange(filters.filter(filter => filter.field !== "said")); }}
        className="w-48 max-w-full rounded-xl bg-ink/[0.04] px-3 py-2 text-small text-ink outline-none placeholder:text-muted" />
    </> : null}
    {!takes ? segmented("kind", [["all", "All"], ["talking", "Talking"], ["broll", "B-roll"]]) : null}
    {!takes ? <span aria-hidden="true" className="mx-1 h-4 w-px bg-ink/[0.1]" /> : null}
    {!takes ? segmented("sound", [["mic", "Mic"], ["camera", "Camera"]]) : null}
    {filters.filter(filter => !takes || !["kind", "verdict", "sound", "said"].includes(filter.field)).map(filter => <button key={filter.field} type="button" aria-haspopup="dialog" aria-expanded={!!anchor && editing?.field === filter.field}
      onClick={event => { setEditing(filter); setAnchor(event.currentTarget); }}
      className={`${pillClass} flex max-w-full items-center gap-1.5 bg-ink/[0.025] text-ink hover:bg-ink/[0.04]`}>
      <span className="truncate">{filter.field === "sound" ? "Sound" : fieldInfo(filter.field).label} <span className="text-muted">{filter.operator}</span> {filter.values.map(value => fieldInfo(filter.field).values.find(([v]) => v === value)?.[1] ?? (filter.field === "eyeContact" ? `${value}%` : value)).join(", ")}</span><CaretDown size={12} className="shrink-0 text-muted" />
    </button>)}
    <button type="button" aria-haspopup="dialog" aria-expanded={!!anchor && !editing} onClick={event => { setEditing(null); setSearch(""); setAnchor(event.currentTarget); }} className={`${pillClass} flex items-center gap-1.5 text-ink hover:bg-ink/[0.06]`}><Plus size={14} />Add filter</button>
    {!hideSearch ? <SearchField shortcut={null} query={query} onQueryChange={onQueryChange} label={takes ? "Search takes" : "Search clips"} clearLabel="Clear search" className="ml-auto" /> : null}
    <Popover anchor={anchor} label={editing ? `Edit ${fieldInfo(editing.field).label.toLowerCase()} filter` : "Add filter"} onClose={close}>
      {editing ? <FilterEditor key={editing.field} filter={editing} options={optionsFor(editing.field)} onApply={filter => { update(filter); close(); anchor?.focus(); }} onClear={() => { onChange(filters.filter(f => f.field !== editing.field)); close(); anchor?.focus(); }} /> : <>
        <SearchField label="Search filters" shortcut={null} placeholder="Search filters" value={search} onChange={event => setSearch(event.target.value)} className="m-1" />
        {["Library", "Clip", "Sound", "Words", "Quality", "Delivery", "Scene", "Eye contact"].map(group => {
          const fields = availableFields.filter(field => field.group === group && `${field.label} ${group}`.toLowerCase().includes(search.toLowerCase()));
          return fields.length ? <div key={group} className="py-1">
            <p className="px-3 py-2 text-micro text-muted">{group}</p>
            {fields.map(field => <button key={field.field} type="button" onClick={() => setEditing(filters.find(filter => filter.field === field.field) ?? { field: field.field, operator: "is", values: [] })} className={`${buttonClass} w-full justify-between`}>
              {field.label}{filters.some(filter => filter.field === field.field) ? <Check size={14} /> : null}
            </button>)}
          </div> : null;
        })}
        {!availableFields.some(field => `${field.label} ${field.group}`.toLowerCase().includes(search.toLowerCase())) ? <EmptyState variant="inline" as="p" className="p-3 text-small text-muted">No filters found</EmptyState> : null}
      </>}
    </Popover>
  </div>;
}

export function ClipViewsTitle({ views, onSelect, detail, tools }: { views: Views; onSelect: (view: ClipView) => void; detail?: ReactNode; tools?: ReactNode }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [mode, setMode] = useState<"list" | "save" | "manage">("list");
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const close = () => setAnchor(null);
  return <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
    <div className="min-w-0"><h1><button type="button" aria-label={`Saved views: ${views.title}${views.dirty ? ", modified" : ""}`} aria-haspopup="dialog" aria-expanded={!!anchor}
      onClick={event => { setMode("list"); setAnchor(anchor ? null : event.currentTarget); }} className="flex max-w-full items-center gap-2 rounded-xl font-display text-display font-semibold tracking-tight text-ink outline-none hover:bg-ink/[0.04]">
      <span className="truncate">{views.title}</span>{views.dirty ? <span className="size-1.5 shrink-0 rounded-full bg-ink" title="View modified" /> : null}<CaretDown size={18} className="shrink-0 text-muted" />
    </button></h1>
    {detail ? <p className="mt-1 text-small text-muted">{detail}</p> : null}</div>
    {tools}
    <Popover anchor={anchor} label={mode === "list" ? "Saved views" : mode === "save" ? "Save view" : "Manage views"} onClose={close}>
      {mode === "list" ? <>
        {views.views.map(view => <Tile type="button" key={view.id} aria-pressed={views.selectedId === view.id} onClick={() => { onSelect(view); close(); anchor?.focus(); }} className={`${buttonClass} w-full justify-between`}>
          <span className="min-w-0 truncate">{view.name}</span><span className="flex shrink-0 items-center gap-3">{views.selectedId === view.id ? <Check size={14} aria-label="Current view" /> : null}{views.defaultId === view.id ? <Star size={14} weight="fill" aria-label="Default view" /> : null}</span>
        </Tile>)}
        <div className="mt-1 pt-1">
          <button type="button" onClick={() => { setName(""); setMode("save"); }} className={`${buttonClass} w-full`}>Save view...</button>
          <button type="button" onClick={() => { setRenaming(null); setMode("manage"); }} className={`${buttonClass} w-full`}>Manage views</button>
        </div>
      </> : mode === "save" ? <form className="p-2" onSubmit={event => { event.preventDefault(); if (name.trim()) { views.save(name); close(); anchor?.focus(); } }}>
        <label className="mb-2 block text-micro text-muted" htmlFor="clip-view-name">View name</label>
        <input id="clip-view-name" value={name} onChange={event => setName(event.target.value)} className={fieldClass} autoComplete="off" />
        <div className="mt-3 flex justify-end gap-2"><button type="button" onClick={() => setMode("list")} className={buttonClass}>Cancel</button><button type="submit" disabled={!name.trim()} className={`${pillClass} bg-ink text-ground disabled:opacity-40`}>Save</button></div>
      </form> : <>
        <Row className="px-3 py-2"><span className="text-small">Manage views</span><button type="button" aria-label="Close manage views" onClick={() => { close(); anchor?.focus(); }} className="outline-none"><X size={14} /></button></Row>
        {views.views.map(view => <div key={view.id} className="p-1">
          {renaming === view.id ? <form className="flex gap-1" onSubmit={event => { event.preventDefault(); if (name.trim()) { views.rename(view.id, name); setRenaming(null); } }}>
            <input autoFocus aria-label={`Rename ${view.name}`} value={name} onChange={event => setName(event.target.value)} className={fieldClass} />
            <button type="submit" disabled={!name.trim()} className={buttonClass}>Save</button>
            <button type="button" aria-label="Cancel rename" onClick={() => setRenaming(null)} className={buttonClass}><X size={14} /></button>
          </form> : <div className="flex items-center gap-1"><span className="min-w-0 flex-1 truncate pl-2 text-small">{view.name}</span>
            <Tile type="button" aria-label={`Set ${view.name} as default`} aria-pressed={views.defaultId === view.id} onClick={() => views.setDefault(view.id)} className={buttonClass}><Star size={14} weight={views.defaultId === view.id ? "fill" : "regular"} /></Tile>
            <button type="button" aria-label={`Rename ${view.name}`} onClick={() => { setName(view.name); setRenaming(view.id); }} className={buttonClass}><PencilSimple size={14} /></button>
            <button type="button" aria-label={`Delete ${view.name}`} onClick={() => views.remove(view.id)} className={buttonClass}><Trash size={14} /></button>
          </div>}
        </div>)}
      </>}
    </Popover>
    {views.storageError ? <p role="status" className="text-micro text-muted">Views are available this session. Could not save them on this device.</p> : null}
  </div>;
}
