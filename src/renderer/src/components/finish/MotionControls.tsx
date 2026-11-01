import { useEffect, useMemo, useRef, useState } from "react";
import type { CutEdit, MotionGraphic, OverlayItem } from "../../../../shared/schema";
import { beatPosition, dedupeBeats, elementLine, motionWords, spokenWord, wordsInSpan, MOTION_STYLES, type MotionChange, type MotionContext, type MotionGrid, type MotionStyle } from "../../../../shared/motion";
import { graphicMotion, setGraphicMotion } from "../../../../main/graphics/templates";
import { standardFrameRate } from "../../../../shared/frame-rate";
import { ChevronLeft, ChevronRight } from "../icons";
import { FOCUS, SectionHeader, Segments, Slider, Switch } from "../ui";
import type { PinChoice } from "../../../../shared/pin-keys";
import { changePin, overlaySessionFor, pinLossOf, pinWaiting, previewPin, startPick, trimToGood, unstick, usePinState, type PinKnobs } from "../OverlayHandles";

// MOT1b (docs/plans/produced/motion-control-spike.md): the one Motion section for anything that moves, and the
// element ticks on its timeline block. Every change is the same one Ask and the MCP make (templates.ts
// setGraphicMotion: change the numbers, resolve them against his words and the beats, rebuild from the template),
// sent as one overlay update, so it is one undoable version. Soft fills only: focus and selection are a fill change.

/** What a motion graphic's times are resolved against, from what the timeline already holds. */
export type MotionSource = { titles?: unknown; captionSource?: unknown; beats?: readonly number[] | null; fps?: number };
export function motionContextOf(source: MotionSource | null | undefined, item: Pick<OverlayItem, "s" | "e">): MotionContext {
  const titles = source?.titles as { captionSource?: unknown } | null | undefined;
  const words = motionWords(titles?.captionSource ? titles : { captionSource: source?.captionSource });
  return { itemS: item.s, itemE: item.e, words, beats: dedupeBeats([...source?.beats ?? []]), syllables: words.map(w => w.s), fps: standardFrameRate(source?.fps || 30) };   // the frames the export draws (EXP3)
}

/** A value kept until one of its inputs changes (a ref, so it also works where only refs and state are available). */
export function useKept<T>(make: () => T, inputs: unknown[]): T {
  const kept = useRef<{ inputs: unknown[]; value: T } | null>(null);
  if (!kept.current || inputs.length !== kept.current.inputs.length || inputs.some((v, i) => !Object.is(v, kept.current!.inputs[i]))) kept.current = { inputs, value: make() };
  return kept.current.value;
}

// The element picked in the inspector or on the timeline: one per item, shared by both.
const picked = new Map<string, string>(), listeners = new Set<() => void>();
export function pickElement(itemId: string, id: string | null) {
  if (id === null) picked.delete(itemId); else picked.set(itemId, id);
  listeners.forEach(fn => fn());
}
export function usePickedElement(itemId: string): string | null {
  const [, redraw] = useState(0);
  useEffect(() => { const fn = () => redraw(n => n + 1); listeners.add(fn); return () => { listeners.delete(fn); }; }, []);
  return picked.get(itemId) ?? null;
}

// What the last change said, kept by item so it survives the inspector redrawing for the new version; shown while the
// graphic is still the one that change made.
const lastSaid = new Map<string, { js: string | undefined; changed: string[]; notes: string[] }>();
// The inspector redraws for each new version; the section it was changed from stays in view, and keyboard focus goes
// back to the control it was on, so the next arrow press nudges again.
let lastTouched: { itemId: string; at: number; focus: string | null } | null = null;

/** One change through the shared path; null when nothing changed. Errors come back as plain words. */
export function motionUpdate(item: OverlayItem, change: MotionChange, ctx: MotionContext): { edit: CutEdit | null; changed: string[]; notes: string[]; graphic: MotionGraphic } {
  const result = setGraphicMotion(item.graphic as MotionGraphic, change, ctx);
  return { edit: result.changed.length ? { kind: "overlay", op: "update", id: item.id, patch: { graphic: result.graphic } } : null, changed: result.changed, notes: result.notes, graphic: result.graphic };
}

const STYLE_LABEL: Record<MotionStyle, string> = { slam: "Slam", snap: "Snap", flash: "Flash", cut: "Cut", fade: "Fade" };
const GRIDS: { value: string; label: string; grid: MotionGrid }[] = [{ value: "1", label: "Beat", grid: 1 }, { value: "0.5", label: "Half", grid: 0.5 }, { value: "0.25", label: "Quarter", grid: 0.25 }];
const quarter = (n: number) => { const sign = n < 0 ? "-" : n > 0 ? "+" : "", a = Math.abs(n), w = Math.floor(a), f = ["", "¼", "½", "¾"][Math.round((a - w) * 4) % 4]; return `${sign}${w || !f ? w : ""}${f}`; };
const step = "inline-flex size-6 items-center justify-center rounded-md bg-ink/[0.06] text-muted hover:bg-ink/[0.1] hover:text-ink focus-visible:bg-ink/[0.14] focus-visible:text-ink disabled:opacity-40";

function Stepper({ label, value, text, min, max, by, busy, onChange }: { label: string; value: number; text: string; min: number; max: number; by: number; busy: boolean; onChange: (value: number) => void }) {
  return <div className="grid grid-cols-[70px_1fr] items-center gap-2 text-[11px]"><span className="text-muted">{label}</span>
    <div className="flex items-center gap-1.5"><button type="button" aria-label={`Less ${label.toLowerCase()}`} disabled={busy || value <= min} onClick={() => onChange(Math.max(min, value - by))} className={`${step} ${FOCUS}`}><ChevronLeft size={12} /></button>
      <span className="min-w-[64px] text-center tabular-nums text-ink" aria-live="polite">{text}</span>
      <button type="button" aria-label={`More ${label.toLowerCase()}`} disabled={busy || value >= max} onClick={() => onChange(Math.min(max, value + by))} className={`${step} ${FOCUS}`}><ChevronRight size={12} /></button></div></div>;
}

export function MotionControls({ item, source, busy, onEdit, onPreview }: { item: OverlayItem; source?: MotionSource | null; busy: boolean; onEdit: (edit: CutEdit) => unknown; onPreview?: (graphic: MotionGraphic) => void }) {
  const graphic = item.graphic as MotionGraphic, found = graphicMotion(graphic);
  const ctx = useMemo(() => motionContextOf(source, item), [source, item.s, item.e]);
  const resolved = useMemo(() => found ? setGraphicMotion(graphic, {}, ctx).resolved : null, [graphic, ctx]);
  const [live, setLive] = useState<{ strength?: number; push?: number }>({});
  const [, redraw] = useState(0);
  const said = lastSaid.get(item.id)?.js === graphic.js ? lastSaid.get(item.id)! : null;
  const pick = usePickedElement(item.id), list = useRef<HTMLDivElement>(null), root = useRef<HTMLElement>(null);
  useEffect(() => {
    const touched = lastTouched;
    if (!touched || touched.itemId !== item.id || Date.now() - touched.at > 8000 || !root.current) return;
    lastTouched = null;   // once: a later change made on the timeline must not pull focus back here
    root.current.scrollIntoView?.({ block: "nearest" });
    if (touched.focus) root.current.querySelector<HTMLElement>(touched.focus)?.focus({ preventScroll: true });
  }, [graphic.js]);
  // TRK1c: an item stuck to a thing has the Tracking group here, with or without motion of its own.
  const tracking = item.pin ? <TrackingGroup item={item} busy={busy} /> : null;
  if (!found || !resolved) return tracking ? <section aria-label="Motion" data-motion-controls className="space-y-2.5"><SectionHeader as="h4" className="text-[12px] font-semibold">Motion</SectionHeader>{tracking}</section> : null;
  const { motion, labels } = found, beats = ctx.beats, selected = motion.elements.findIndex(e => e.id === pick);
  function send(change: MotionChange) {
    if (busy) return;
    const active = typeof document === "undefined" ? null : document.activeElement as HTMLElement | null;
    const inside = active && root.current?.contains(active) ? active : null;
    lastTouched = { itemId: item.id, at: Date.now(), focus: inside?.dataset.motionElement ? `[data-motion-element="${inside.dataset.motionElement}"]` : inside?.getAttribute("aria-label") ? `[aria-label="${inside.getAttribute("aria-label")!.replace(/"/g, '\\"')}"]` : null };
    try {
      const out = motionUpdate(item, change, ctx);
      lastSaid.set(item.id, { js: out.graphic.js, changed: out.changed, notes: out.notes });
      if (out.edit) void onEdit(out.edit);
    } catch (error) { lastSaid.set(item.id, { js: graphic.js, changed: [], notes: [error instanceof Error ? error.message : "Couldn't change that."] }); }
    redraw(n => n + 1);
  }
  function preview(change: MotionChange) {
    try { onPreview?.(setGraphicMotion(graphic, change, ctx).graphic); } catch { /* the release says why */ }
  }
  const inSpan = wordsInSpan(ctx);
  const element = (i: number) => motion.elements[i], at = (i: number) => resolved.times[i];
  const plain = (s: string) => s.toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]/gu, "");
  // its own word when it is one of his (a beat-words scene), else the word nearest where it lands now
  const nearestWord = (t: number, label?: string) => inSpan.filter(w => label && w.text && plain(w.text) === plain(label)).sort((a, b) => Math.abs(a.s - t) - Math.abs(b.s - t))[0]
    ?? inSpan.reduce<typeof inSpan[number] | null>((best, w) => !best || Math.abs(w.s - t) < Math.abs(best.s - t) ? w : best, null);
  const onBeat = (i: number) => { const g = motion.grid; return Math.max(0, Math.round((beatPosition(beats, at(i)) - motion.offsetBeats) / g) * g); };
  function keys(event: React.KeyboardEvent) {
    const i = selected;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (i < 0) return;
      event.preventDefault(); event.stopPropagation();
      send({ elements: [{ id: element(i).id, nudge: event.key === "ArrowLeft" ? -1 : 1 }] });
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault(); event.stopPropagation();
      const next = Math.max(0, Math.min(motion.elements.length - 1, (i < 0 ? 0 : i + (event.key === "ArrowUp" ? -1 : 1))));
      pickElement(item.id, element(next).id);
      list.current?.querySelector<HTMLElement>(`[data-motion-element="${element(next).id}"]`)?.focus();
    }
  }
  const strength = live.strength ?? motion.strength, push = live.push ?? motion.push;
  const notes = said ? [...said.changed.length ? [`Changed: ${said.changed.join("; ")}.`] : [], ...said.notes] : resolved.notes;
  return <section ref={root} aria-label="Motion" data-motion-controls className="space-y-2.5">
    <SectionHeader as="h4" className="text-[12px] font-semibold">Motion</SectionHeader>
    <Segments label="Style" variant="compact" value={motion.style} options={MOTION_STYLES.map(s => ({ value: s, label: STYLE_LABEL[s], disabled: busy }))} onChange={value => send({ style: value })} />
    <Slider label="Strength" min={0} max={2} step={0.05} defaultValue={1} value={strength} disabled={busy} onChange={value => { setLive(v => ({ ...v, strength: value })); preview({ strength: value }); }} onRelease={value => { setLive(v => ({ ...v, strength: undefined })); send({ strength: value }); }} />
    <Slider label="Push" min={0} max={8} step={0.5} unit="%" defaultValue={3} value={push} disabled={busy} onChange={value => { setLive(v => ({ ...v, push: value })); preview({ push: value }); }} onRelease={value => { setLive(v => ({ ...v, push: undefined })); send({ push: value }); }} />
    <Stepper label="Hold" value={motion.holdBeats} text={`${quarter(motion.holdBeats).replace("+", "")} beat${motion.holdBeats === 1 ? "" : "s"}`} min={0} max={4} by={0.25} busy={busy} onChange={value => send({ holdBeats: value })} />
    <Stepper label="Offset" value={motion.offsetBeats} text={motion.offsetBeats ? `${quarter(motion.offsetBeats)} beat` : "On the beat"} min={-1} max={1} by={0.25} busy={busy} onChange={value => send({ offsetBeats: value })} />
    <div className="grid grid-cols-[70px_1fr] items-center gap-2 text-[11px]"><span className="text-muted">Grid</span><Segments label="Grid" variant="compact" value={String(motion.grid)} options={GRIDS.map(g => ({ value: g.value, label: g.label, disabled: busy }))} onChange={value => send({ grid: Number(value) as MotionGrid })} /></div>
    <label className="flex items-center justify-between gap-2 text-[11px]"><span className="text-muted">Keep order</span><Switch label="Keep order" checked={motion.keepOrder} disabled={busy} onChange={event => send({ keepOrder: event.target.checked })} /></label>
    <div ref={list} role="listbox" aria-label="When each one lands" aria-activedescendant={undefined} onKeyDown={keys} className="space-y-1">
      {motion.elements.map((e, i) => {
        const on = i === selected, near = nearestWord(at(i), labels[i]);
        return <div key={e.id} className={`rounded-lg px-2 py-1.5 transition-colors ${on ? "bg-accent/15" : "bg-ink/[0.04] hover:bg-ink/[0.07]"}`}>
          <div className="flex items-center gap-1.5">
            <button type="button" role="option" aria-selected={on} data-motion-element={e.id} onClick={() => pickElement(item.id, e.id)} onFocus={() => pickElement(item.id, e.id)}
              className={`min-w-0 flex-1 rounded px-1 text-left focus-visible:bg-accent/20 ${FOCUS}`}>
              <span className="block truncate text-[12px] font-semibold text-ink">{labels[i]}</span>
              <span className="block truncate text-[11px] tabular-nums text-muted">{elementLine(motion, i, resolved.at[i], ctx)}</span>
            </button>
            <button type="button" aria-label={`${labels[i]} earlier`} disabled={busy} onClick={() => { pickElement(item.id, e.id); send({ elements: [{ id: e.id, nudge: -1 }] }); }} className={`${step} ${FOCUS}`}><ChevronLeft size={12} /></button>
            <button type="button" aria-label={`${labels[i]} later`} disabled={busy} onClick={() => { pickElement(item.id, e.id); send({ elements: [{ id: e.id, nudge: 1 }] }); }} className={`${step} ${FOCUS}`}><ChevronRight size={12} /></button>
          </div>
          {on ? <div className="mt-1 flex flex-wrap gap-1">
            <button type="button" disabled={busy || !near || e.word === near.id} onClick={() => near && send({ elements: [{ id: e.id, word: near.id }] })} className={`rounded-md bg-ink/[0.06] px-2 py-1 text-[11px] text-ink hover:bg-ink/[0.1] focus-visible:bg-ink/[0.14] disabled:opacity-40 ${FOCUS}`}>{near ? `Anchor to “${spokenWord(near.text ?? "")}”` : "Anchor to word"}</button>
            <button type="button" disabled={busy || !beats.length || e.beat === onBeat(i)} onClick={() => send({ elements: [{ id: e.id, beat: onBeat(i) }] })} className={`rounded-md bg-ink/[0.06] px-2 py-1 text-[11px] text-ink hover:bg-ink/[0.1] focus-visible:bg-ink/[0.14] disabled:opacity-40 ${FOCUS}`}>On the beat</button>
          </div> : null}
        </div>;
      })}
    </div>
    <p className="text-[11px] text-muted">Arrow keys move the picked one a grid step. Drag its tick on the timeline; hold Option for a free time.</p>
    {notes.length ? <div aria-live="polite" className="space-y-1 rounded-lg bg-ink/[0.04] px-2 py-1.5 text-[11px] text-muted">{notes.map(n => <p key={n}>{n}</p>)}</div> : null}
    {tracking}
  </section>;
}

// ---- TRK1c: the Tracking group, for an item stuck to a thing. The knobs are MCP update_pin's, by the same names and
// units (steadiness 0 to 100, follow size = followScale 0 to 1, follow turn = followRotation, offset in thing widths and
// heights, size as a share of the thing's width, lead and fade in frames, exit auto, hold or carry), each change one
// undoable version and no tracking again; the viewer shows a change while it is made. Pick again tracks once more.
const EXITS: { value: PinChoice["exit"]; label: string }[] = [{ value: "auto", label: "Auto" }, { value: "hold", label: "Hold" }, { value: "carry", label: "Carry" }];
const signed = (n: number, digits = 2) => `${n > 0 ? "+" : ""}${Number(n.toFixed(digits))}`;
const frames = (n: number) => `${n} frame${Math.abs(n) === 1 ? "" : "s"}`;
const softButton = `rounded-md bg-ink/[0.06] px-2 py-1 text-[11px] text-ink hover:bg-ink/[0.1] focus-visible:bg-ink/[0.14] disabled:opacity-40 ${FOCUS}`;
function TrackingGroup({ item, busy }: { item: OverlayItem; busy: boolean }) {
  const pin = item.pin!, session = overlaySessionFor(item.id), { note } = usePinState();
  // A knob being moved (slider drag, quick stepper clicks) shows on the viewer at once and lands as one version.
  const [live, setLive] = useState<PinKnobs | null>(null), kept = useRef(live), timer = useRef<ReturnType<typeof setTimeout>>();
  kept.current = live;
  // A new saved pin (not the same pin redrawn) ends what was being moved.
  const saved = JSON.stringify(pin);
  useEffect(() => { kept.current = null; setLive(null); }, [saved]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const off = busy || !session || pinWaiting(session);
  const combine = (a: PinKnobs | null, b: PinKnobs): PinKnobs => ({ ...a, ...b, ...(a?.offset || b.offset ? { offset: { ...a?.offset, ...b.offset } } : {}) });
  const merged = (knobs: PinKnobs | null): PinChoice => ({ ...pin, ...knobs, offset: { ...pin.offset, ...knobs?.offset } });
  const value = merged(live);
  function preview(knobs: PinKnobs) {
    const next = combine(kept.current, knobs);
    kept.current = next; setLive(next);
    if (session) previewPin(session, item, merged(next));
    return next;
  }
  function send(knobs: PinKnobs) {
    clearTimeout(timer.current);
    const all = merged(combine(kept.current, knobs));
    const changed: PinKnobs = {};
    for (const key of ["size", "followScale", "followRotation", "steadiness", "lead", "fade", "exit"] as const) if (all[key] !== pin[key]) (changed as Record<string, unknown>)[key] = all[key];
    if (all.offset.x !== pin.offset.x || all.offset.y !== pin.offset.y) changed.offset = all.offset;
    if (!session || off || !Object.keys(changed).length) { kept.current = null; setLive(null); if (session) previewPin(session, item, null); return; }
    void changePin(session, item, changed).then(ok => { if (!ok) { kept.current = null; setLive(null); } });
  }
  // Steppers: each click shows at once; half a second after the last one, what they add up to lands as one version.
  const latest = useRef(send); latest.current = send;
  function nudge(knobs: PinKnobs) { preview(knobs); clearTimeout(timer.current); timer.current = setTimeout(() => latest.current({}), 500); }
  const loss = pinLossOf(session, item), said = note?.itemId === item.id ? note.text : null, flat = pin.surface === "flat" && pin.track.mode === "plane";
  return <div role="group" aria-label="Tracking" data-tracking-controls className="space-y-2.5 rounded-xl bg-ink/[0.04] p-2.5">
    <div className="flex items-baseline justify-between gap-2"><SectionHeader as="h4" className="text-[12px] font-semibold">Tracking</SectionHeader><span className="truncate text-[11px] text-muted">{pin.thing ? `${flat ? "Printed on" : "Stuck to"} the ${pin.thing}` : flat ? "Printed on a flat surface" : "Stuck to a thing"}</span></div>
    {loss ? <div data-pin-loss-line className="space-y-1 rounded-lg bg-ink/[0.05] px-2 py-1.5 text-[11px]"><p className="text-ink">{loss.text}</p>
      <div className="flex flex-wrap gap-1"><button type="button" disabled={off} onClick={() => session && trimToGood(session, item, loss.atS)} className={softButton}>Trim to the good part</button>
        <button type="button" disabled={off} onClick={() => session && startPick(session, item, true)} className={softButton}>Pick again</button></div></div> : null}
    <Slider label="Steadiness" min={0} max={100} step={1} defaultValue={50} value={value.steadiness} disabled={off} onChange={v => preview({ steadiness: v })} onRelease={v => send({ steadiness: v })} />
    {/* TRK2: on a flat surface the word is printed onto it in perspective, so it already grows and turns with it. */}
    {flat ? null : <Slider label="Follow size" min={0} max={1} step={0.05} defaultValue={0.5} value={value.followScale} disabled={off} onChange={v => preview({ followScale: v })} onRelease={v => send({ followScale: v })} />}
    <Slider label="Size" min={0.1} max={flat ? 0.6 : 3} step={0.05} defaultValue={0.6} value={Math.min(value.size, flat ? 0.6 : 3)} disabled={off} onChange={v => preview({ size: v })} onRelease={v => send({ size: v })} />
    {flat ? null : <label className="flex items-center justify-between gap-2 text-[11px]"><span className="text-muted">Follow turn</span><Switch label="Follow turn" checked={value.followRotation} disabled={off} onChange={event => { preview({ followRotation: event.target.checked }); send({ followRotation: event.target.checked }); }} /></label>}
    <Stepper label="Offset x" value={value.offset.x} text={signed(value.offset.x)} min={-2} max={2} by={0.05} busy={off} onChange={v => nudge({ offset: { x: Number(v.toFixed(3)) } })} />
    <Stepper label="Offset y" value={value.offset.y} text={signed(value.offset.y)} min={-2} max={2} by={0.05} busy={off} onChange={v => nudge({ offset: { y: Number(v.toFixed(3)) } })} />
    <Stepper label="Lead" value={value.lead} text={frames(value.lead).replace(/^(\d)/, value.lead > 0 ? "+$1" : "$1")} min={-3} max={3} by={1} busy={off} onChange={v => nudge({ lead: v })} />
    <Stepper label="Fade" value={value.fade} text={frames(value.fade)} min={0} max={12} by={1} busy={off} onChange={v => nudge({ fade: v })} />
    <div className="grid grid-cols-[70px_1fr] items-center gap-2 text-[11px]"><span className="text-muted">Exit</span><Segments label="Exit" variant="compact" value={value.exit} options={EXITS.map(e => ({ value: e.value, label: e.label, disabled: off }))} onChange={v => { preview({ exit: v as PinChoice["exit"] }); send({ exit: v as PinChoice["exit"] }); }} /></div>
    <div className="flex flex-wrap gap-1">
      {loss ? null : <button type="button" disabled={off} onClick={() => session && startPick(session, item, true)} className={softButton}>Pick again</button>}
      <button type="button" disabled={off} onClick={() => session && void unstick(session, item)} className={softButton}>Unstick</button>
    </div>
    <p className="text-[11px] text-muted">{flat ? "Printed on the surface, kept inside its inner 60%. Offset moves it across the surface." : "Drag the word on the video to move it off the thing; the steppers nudge it."}</p>
    {said ? <p aria-live="polite" className="rounded-lg bg-ink/[0.05] px-2 py-1.5 text-[11px] text-muted">{said}</p> : null}
  </div>;
}
