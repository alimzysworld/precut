import { InlineError } from "./ui";
import { formatPercent } from "./processingFormat";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { CutEdit, DraftTimeline, OverlayItem } from "../../../shared/schema";
import { getApi } from "../data";
import { FOCUS } from "./ui";
import { useShortcuts } from "../hooks/useShortcuts";
import { pinKeyAt, pinKeys, pinLoss, pinPiece, pinTrackId, reelTime, shownSource, sourceToFrame, type PinChoice } from "../../../shared/pin-keys";

type Edit = (edit: CutEdit, baseVersion?: number) => void | Promise<{ cutId: string; version: number } | undefined>;
export type OverlaySession = { root: string; cutId?: string; selected: string | null; preview: OverlayItem | null; version: number; busy: boolean; timeline: DraftTimeline; edit: Edit; seek: (time: number) => void };
type Session = OverlaySession;
const sessions = new Map<string, Session>();
const timelines = new WeakMap<DraftTimeline, Session>();
const listeners = new Set<() => void>();
let revision = 0;
const publish = () => { revision++; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useOverlaySession(timeline?: DraftTimeline | null): Session | undefined {
  const [, refresh] = useState(revision);
  useEffect(() => { const stop = subscribe(() => refresh(revision)); refresh(revision); return stop; }, []);
  return timeline ? timelines.get(timeline) : undefined;
}
export function useOverlayEditor(root: string, cutId: string | undefined, version: number, timeline: DraftTimeline | null | undefined, edit: Edit | undefined, busy: boolean, seek: (time: number) => void) {
  const latest = useRef({ edit, seek }); latest.current = { edit, seek };
  const make = (tl: DraftTimeline): Session => {
    const prior = sessions.get(`${root}\0${cutId}`);
    const newest = tl.overlays?.find(item => !prior?.timeline.overlays?.some(old => old.id === item.id));
    return { root, cutId, selected: newest?.id ?? (tl.overlays?.some(item => item.id === prior?.selected) ? prior!.selected : null), preview: null, version, timeline: tl, busy,
      edit: (change, base) => latest.current.edit?.(change, base), seek: t => latest.current.seek(t) };
  };
  // MOT1b: a new version's timeline has its session from its first render, carrying the selection, so the panel that
  // shows the selected overlay never drops it for a render (it used to fall back to the clip list and lose its scroll).
  if (cutId && timeline && edit && !timelines.has(timeline)) { const early = make(timeline); sessions.set(`${root}\0${cutId}`, early); timelines.set(timeline, early); }
  useEffect(() => {
    if (!cutId || !timeline || !edit) return;
    const key = `${root}\0${cutId}`;
    const session = make(timeline);
    sessions.set(key, session); timelines.set(timeline, session); publish();
    return () => { if (timelines.get(timeline) === session) { timelines.delete(timeline); publish(); } };
  }, [root, cutId, version, timeline, edit !== undefined, busy]);
  return useOverlaySession(timeline);
}
export function previewOverlay(session: Session, item: OverlayItem | null) { session.preview=item; publish(); }
export function selectOverlay(session: Session, id: string) {
  session.selected = id; session.preview = null;
  const item = session.timeline.overlays?.find(item => item.id === id);
  if (item) session.seek(Math.min(item.e - .001, item.s + .3));
  publish();
}
export async function addOverlayFiles(session: Session, files: string[], time: number) {
  if (session.busy) return;
  let base = session.version;
  for (const source of files) {
    const result = await session.edit({ kind: "overlay", op: "add", source, item: { s: time, e: time + 2, x: .5, y: .42, w: .7, corner: "round", enter: "pop", exit: "fade", sound: "pop" } }, base);
    if (!result) break;
    base = result.version;
  }
}

// ---- TRK1c: stick it to something, by hand. The stage picks the thing (a box on the paused frame), main follows it
// through the clip (the MCP's pin_graphic and update_pin, so Ask and the inspector make the same change) and the result
// lands as one undoable version. Tracking runs on main: the player keeps playing. Soft fills only, never a stroke.
export type PinBox = { x: number; y: number; w: number; h: number };
/** TRK2: a flat thing's four corners on the frame, TL, TR, BR, BL (fractions). */
export type PinQuad = number[][];
/** lock: TRK2, picking the thing a clip's frame locks on (the piece and its reel span), not an item to stick. flat: the
 * thing is a flat surface, picked by its four corners (a box dragged out becomes four corners). */
export type PinPick = { itemId: string; again: boolean; box: PinBox | null; thing: string; prefill: boolean; flat: boolean; quad: PinQuad | null; lock?: { piece: number; s: number; e: number } };
export type PinRun = { itemId: string; cutId: string; thing: string; state: "running" | "done" | "failed"; pct: number | null; lost?: string; lostAtS?: number; note?: string; version?: number; lock?: { piece: number; s: number; e: number } };
/** The knobs, named and in the units of MCP update_pin. */
export type PinKnobs = Partial<Pick<PinChoice, "size" | "followScale" | "followRotation" | "steadiness" | "lead" | "fade" | "exit">> & { offset?: { x?: number; y?: number } };
let pick: PinPick | null = null, run: PinRun | null = null, inflight = false, note: { itemId: string; text: string } | null = null;
let held: { cutId: string; version: number; until: number } | null = null, listening = false;
export function usePinState() {
  const [, refresh] = useState(revision);
  useEffect(() => subscribe(() => refresh(revision)), []);
  return { pick, run, note };
}
/** The session showing (and selecting) this item, for the inspector's controls. */
export function overlaySessionFor(itemId: string): Session | undefined {
  for (const session of sessions.values()) if (session.selected === itemId && session.timeline.overlays?.some(item => item.id === itemId)) return session;
  return undefined;
}
const plain = (error: unknown) => (error instanceof Error ? error.message : String(error ?? "")).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") || "Couldn't stick it. Try again.";
export const thingName = (thing: string) => { const name = thing.trim().replace(/^the\s+/i, ""); return name ? `the ${name}` : "it"; };
/** A change is on its way, or main's version has not reached the screen yet: the next one waits for it. */
export function pinWaiting(session: Session | undefined) {
  return inflight || run?.state === "running" || !!session && !!held && held.cutId === session.cutId && session.version < held.version && Date.now() < held.until;
}
function hold(cutId: string, version: number) { held = { cutId, version, until: Date.now() + 10000 }; setTimeout(publish, 10050); }
function listen() {
  if (listening) return;
  listening = true;
  getApi().onPinProgress?.(e => { if (run?.state === "running" && run.itemId === e.itemId && run.cutId === e.cutId) { run = { ...run, pct: e.pct }; publish(); } });
}
export function startPick(session: Session, item: OverlayItem, again = false) {
  if (session.busy || pinWaiting(session) || item.graphic?.frame === "full") return;
  listen();
  pick = { itemId: item.id, again: again && !!item.pin, box: null, thing: item.pin?.thing ?? "", prefill: again && !!item.pin, flat: again && item.pin?.surface === "flat", quad: null };
  if (run?.itemId === item.id) run = null;
  note = null; publish();
}
/** TRK2: pick the thing a clip's frame locks on (the same pick as sticking: a box, or a flat thing's four corners). */
export const lockPickId = (piece: number) => `lock:${piece}`;
export function startLockPick(session: Session, piece: number, span: { s: number; e: number }, again = false, thing = "") {
  if (session.busy || pinWaiting(session)) return;
  listen();
  pick = { itemId: lockPickId(piece), again, box: null, thing, prefill: false, flat: false, quad: null, lock: { piece, ...span } };
  if (run?.itemId === pick.itemId) run = null;
  note = null; publish();
}
export function cancelPick() { if (pick) { pick = null; publish(); } }
/** Flat surface on or off: the box becomes its four corners, the corners their box. */
export function setFlat(flat: boolean) {
  if (!pick || pick.flat === flat) return;
  const b = pick.box, q = pick.quad;
  setPick(flat ? { flat, quad: b ? quadOf(b) : null } : { flat, box: q ? boxOf(q) : b });
}
const quadOf = (b: PinBox): PinQuad => [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
const boxOf = (q: PinQuad): PinBox => { const xs = q.map(p => p[0]), ys = q.map(p => p[1]), x = Math.min(...xs), y = Math.min(...ys); return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }; };
function setPick(next: Partial<PinPick>) { if (pick) { pick = { ...pick, ...next }; publish(); } }
export function dismissPinRun() { if (run && run.state !== "running") { run = null; publish(); } }
async function confirmPick(session: Session, time: number) {
  if (pick?.lock) return confirmLock(session, time);
  const p = pick, item = p && session.timeline.overlays?.find(o => o.id === p.itemId), api = getApi();
  const picked = p && (p.flat ? p.quad : p.box);
  if (!p || !picked || !item || !session.cutId || session.busy || pinWaiting(session)) return;
  if (!api.pinEdit) { note = { itemId: item.id, text: "Sticking needs the desktop app." }; pick = null; publish(); return; }
  const thing = p.thing.trim(), b = p.box, cutId = session.cutId;
  pick = null;
  run = { itemId: item.id, cutId, thing: thing || item.pin?.thing || "", state: "running", pct: null };
  publish();
  try {
    const result = await api.pinEdit(session.root, cutId, session.version, p.again ? "update_pin" : "pin_graphic",
      { itemId: item.id, ...(p.flat && p.quad ? { corners: p.quad, surface: "flat" } : { box: [b!.x, b!.y, b!.w, b!.h], ...(p.again ? { surface: "object" } : {}) }), atS: Math.max(item.s, Math.min(item.e, time)), ...(thing ? { thing } : {}) });
    run = { ...run, state: "done", pct: 100, lost: result.lost, lostAtS: result.lostAtS, version: result.version };
    hold(cutId, result.version);
  } catch (error) { run = { ...run, state: "failed", note: plain(error) }; }
  publish();
}
/** TRK2: lock the clip's frame on the picked thing (MCP lock_on, or update_lock to pick again): one undoable version. */
async function confirmLock(session: Session, time: number) {
  const p = pick, api = getApi(), span = p?.lock, picked = p && (p.flat ? p.quad : p.box);
  if (!p || !span || !picked || !session.cutId || session.busy || pinWaiting(session)) return;
  if (!api.lockEdit) { note = { itemId: p.itemId, text: "Locking needs the desktop app." }; pick = null; publish(); return; }
  const thing = p.thing.trim(), b = p.box, cutId = session.cutId;
  pick = null;
  run = { itemId: p.itemId, cutId, thing, state: "running", pct: null, lock: span };
  publish();
  try {
    const result = await api.lockEdit(session.root, cutId, session.version, p.again ? "update_lock" : "lock_on",
      { piece: span.piece, ...(p.flat && p.quad ? { corners: p.quad, surface: "flat" } : { box: [b!.x, b!.y, b!.w, b!.h], surface: "object" }), atS: Math.max(span.s, Math.min(span.e - .001, time)), ...(thing ? { thing } : {}) });
    run = { ...run, state: "done", pct: 100, lost: result.lost, lostAtS: result.lostAtS, note: result.note, version: result.version };
    hold(cutId, result.version);
  } catch (error) { run = { ...run, state: "failed", note: plain(error) }; }
  publish();
}
/** TRK2: one lock knob change (MCP update_lock, no tracking) or unlock: one undoable version. */
export async function lockCall(session: Session, piece: number, name: "update_lock" | "unlock", knobs: Record<string, unknown> = {}) {
  const api = getApi(), id = lockPickId(piece);
  if (!session.cutId || !api.lockEdit || pinWaiting(session)) return false;
  inflight = true; note = null; if (run?.itemId === id && name === "unlock") run = null; publish();
  try { const result = await api.lockEdit(session.root, session.cutId, session.version, name, { piece, ...knobs }); hold(session.cutId, result.version); return true; }
  catch (error) { note = { itemId: id, text: plain(error) }; return false; }
  finally { inflight = false; publish(); }
}
async function pinCall(given: Session, item: OverlayItem, name: "update_pin" | "unpin", knobs: PinKnobs = {}) {
  const api = getApi(), session = overlaySessionFor(item.id) ?? given;   // the screen's newest, not the one a timer kept
  if (!session.cutId || !api.pinEdit || pinWaiting(session)) return false;
  inflight = true; note = null; publish();
  try { const result = await api.pinEdit(session.root, session.cutId, session.version, name, { itemId: item.id, ...knobs }); hold(session.cutId, result.version); return true; }
  catch (error) { note = { itemId: item.id, text: plain(error) }; session.preview = null; return false; }
  finally { inflight = false; publish(); }
}
/** One knob change (MCP update_pin, no tracking): one undoable version. */
export const changePin = (session: Session, item: OverlayItem, knobs: PinKnobs) => pinCall(session, item, "update_pin", knobs);
/** The plain item, where it sat at the pick frame: one undoable version. */
export const unstick = (session: Session, item: OverlayItem) => { if (run?.itemId === item.id) run = null; return pinCall(session, item, "unpin"); };
/** The pin as these knobs would draw it, on the viewer now (the same per-frame keys the title page reads). */
export function previewPin(session: Session, item: OverlayItem, pin: PinChoice | null) {
  if (!pin) { if (session.preview?.id === item.id) { session.preview = null; publish(); } return; }
  const tl = session.timeline, track = tl.pinTracks?.[pinTrackId(pin)];
  const keys = track && pinKeys({ ...item, pin }, tl.pieces, track, { width: tl.width, height: tl.height, fps: tl.fps ?? 25 });
  if (!keys) return;
  session.preview = { ...item, pin, pinKeys: keys }; publish();
}
/** Where and why the tracker lost the thing while the item is on (reel seconds), or null. */
export function pinLossOf(session: Session | undefined, item: OverlayItem): { text: string; atS: number } | null {
  const tl = session?.timeline, track = item.pin && tl?.pinTracks?.[pinTrackId(item.pin)], piece = track && pinPiece(item, tl!.pieces), loss = piece && pinLoss(item, piece, track);
  return loss && item.pinKeys?.lost ? { text: item.pinKeys.lost, atS: reelTime(piece, loss.atS) } : null;
}
/** Trim to the good part: the item ends where the thing was lost (an ordinary overlay edit, one version). */
export function trimToGood(session: Session, item: OverlayItem, atS: number) {
  if (atS < item.s + 0.2) { note = { itemId: item.id, text: "It holds for less than a moment. Pick it again where it is clear." }; publish(); return; }
  if (run?.itemId === item.id) run = null;
  note = null; publish();
  void session.edit({ kind: "overlay", op: "update", id: item.id, patch: { e: Math.round(atS * 1000) / 1000 } });
}
/** The thing's tracked box at reel time t, in the frame (re-pick starts from it). */
function trackedBox(tl: DraftTimeline, item: OverlayItem, t: number): PinBox | null {
  const track = item.pin && tl.pinTracks?.[pinTrackId(item.pin)], piece = track && pinPiece(item, tl.pieces);
  if (!track || !piece || !track.frames.length) return null;
  const s = shownSource(track, piece, t, tl.fps), f = track.frames.reduce((best, row) => Math.abs(row[0] - s) < Math.abs(best[0] - s) ? row : best);
  if (f[5] < 0 || f[3] <= 0) return null;
  const aspect = track.width / track.height, out = tl.width / tl.height;
  const corners = [[f[1], f[2]], [f[1] + f[3], f[2]], [f[1], f[2] + f[4]], [f[1] + f[3], f[2] + f[4]]].map(([x, y]) => sourceToFrame(piece, t, x, y, aspect, out));
  const x0 = Math.max(0, Math.min(...corners.map(c => c.x))), y0 = Math.max(0, Math.min(...corners.map(c => c.y)));
  const box = { x: x0, y: y0, w: Math.min(1, Math.max(...corners.map(c => c.x))) - x0, h: Math.min(1, Math.max(...corners.map(c => c.y))) - y0 };
  return box.w > 0.01 && box.h > 0.01 ? box : null;
}
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
/** The corners moved together, kept inside the frame. */
const moveQuad = (q: PinQuad, dx: number, dy: number): PinQuad => {
  const xs = q.map(c => c[0]), ys = q.map(c => c[1]);
  const mx = Math.max(-Math.min(...xs), Math.min(1 - Math.max(...xs), dx)), my = Math.max(-Math.min(...ys), Math.min(1 - Math.max(...ys), dy));
  return q.map(([x, y]) => [x + mx, y + my]);
};
const chip = `rounded-lg px-2.5 py-1 text-[11px] text-white bg-white/10 hover:bg-white/20 focus-visible:bg-white/25 disabled:opacity-40 ${FOCUS}`;

export function OverlayHandles({ timeline, time, pause }: { timeline: DraftTimeline; time: number; pause: () => void }) {
  const session = useOverlaySession(timeline);
  const container = useRef<HTMLDivElement>(null), layer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; item: OverlayItem; resize: boolean; width: number; height: number } | null>(null);
  const [aspects, setAspects] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const state = usePinState(), now = useRef(time); now.current = time;
  const selected = timeline.overlays?.find(item => item.id === session?.selected);
  const shown = session?.preview ?? selected;
  // TRK1b: a pinned item's handles sit where it is drawn now, on its thing.
  const pinned = shown?.pinKeys ? pinKeyAt(shown, time) : null;
  const place = pinned && shown ? { x: pinned.x, y: pinned.y, w: pinned.w, rotate: (shown.rotate ?? 0) + pinned.rotate } : shown;
  const active = !!shown && time >= shown.s && time < shown.e && shown.graphic?.frame !== "full" && (!pinned || pinned.opacity > 0);
  // TRK1c: picking the thing for the selected item; its tracking status and result.
  // TRK2: or the thing a clip's frame locks on (no item selected for that).
  const picking: PinPick | null = !session ? null : state.pick?.lock ? state.pick : selected && state.pick?.itemId === selected.id ? state.pick : null;
  const result = state.run && (state.run.state === "running" || state.run.itemId === session?.selected || !!state.run.lock) ? state.run : null;
  const pickDrag = useRef<{ id: number; mode: "draw" | "move" | number; x: number; y: number; box: PinBox | null; quad: PinQuad | null; moved: boolean } | null>(null);
  useEffect(() => {
    if (!state.pick || !session) return;
    const span = state.pick.lock;
    if (span) {
      // The pick is on a paused frame while the clip is on.
      pause();
      const before = document.activeElement as HTMLElement | null;
      requestAnimationFrame(() => layer.current?.focus({ preventScroll: true }));
      if (now.current < span.s || now.current >= span.e) session.seek(Math.min(span.e - .001, span.s + Math.min(.3, (span.e - span.s) / 2)));
      return () => { if (before?.isConnected && (!document.activeElement || document.activeElement === document.body || layer.current?.contains(document.activeElement))) before.focus({ preventScroll: true }); };
    }
    if (session.selected !== state.pick.itemId) { cancelPick(); return; }
    const item = timeline.overlays?.find(o => o.id === state.pick!.itemId);
    if (!item) return;
    pause();
    // The keys go to the stage while picking (the Stick button keeps none), and come back where they were after.
    const before = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => layer.current?.focus({ preventScroll: true }));
    // The pick is on a paused frame while the item is on.
    if (now.current < item.s || now.current >= item.e) session.seek(Math.min(item.e - .001, item.s + Math.min(.3, (item.e - item.s) / 2)));
    return () => { if (before?.isConnected && (!document.activeElement || document.activeElement === document.body || layer.current?.contains(document.activeElement))) before.focus({ preventScroll: true }); };
  }, [state.pick?.itemId, session?.selected]);
  useEffect(() => {
    if (!picking?.prefill || !selected || time < selected.s || time >= selected.e) return;
    const box = trackedBox(timeline, selected, time);
    setPick({ box, quad: picking.flat && box ? quadOf(box) : null, prefill: false });
  }, [picking?.prefill, time]);
  useEffect(() => {
    if (state.run?.state !== "done" || state.run.lost) return;
    const done = state.run, timer = setTimeout(() => { if (run === done) dismissPinRun(); }, 2500);
    return () => clearTimeout(timer);
  }, [state.run]);
  // Keys while picking: Esc cancels, Return sticks, arrows nudge the box (Shift: further). Registered with the screen's
  // shortcuts, newest first, so they win over the panel's Esc and the player's arrows; the name field keeps its own keys.
  function pickKey(event: KeyboardEvent) {
    const box = pick?.box, quad = pick?.flat ? pick.quad : null, target = event.target as HTMLElement | null;
    if (event.key === "Escape") cancelPick();
    else if (event.key === "Enter") { if (target?.tagName === "BUTTON" && target.closest("[data-pin-pick]")) (target as HTMLButtonElement).click(); else if (session) void confirmPick(session, now.current); }
    else if ((quad || box) && event.key.startsWith("Arrow") && target?.tagName !== "INPUT") {
      const step = event.shiftKey ? .02 : .004, dx = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0, dy = event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0;
      if (quad) setPick({ quad: moveQuad(quad, dx, dy) });
      else if (box) setPick({ box: { ...box, x: clamp01(Math.min(1 - box.w, box.x + dx)), y: clamp01(Math.min(1 - box.h, box.y + dy)) } });
    } else return false;
    return true;
  }
  const arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
  useShortcuts("precuts", [
    { id: "pin-pick-cancel", keys: ["Escape"], label: "Stop picking the thing", scope: "precuts", handler: pickKey },
    { id: "pin-pick-stick", keys: ["Enter"], label: "Stick to the boxed thing", scope: "precuts", handler: pickKey },
    { id: "pin-pick-nudge", keys: [...arrows, ...arrows.map(k => `Shift+${k}`)], label: "Nudge the box or corners", scope: "precuts", repeat: true, handler: pickKey },
  ], !!picking && !!session);
  useEffect(() => {
    if (!picking || !session) return;
    // The name field is typing, so the shortcuts pass it by: its Esc and Return come here.
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target as HTMLElement | null)?.closest?.("[data-pin-pick]") === null) return;
      if (pickKey(event)) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  }, [!!picking, session]);
  function start(event: PointerEvent<HTMLButtonElement>, resize: boolean) {
    if (!session || session.busy || !shown || !container.current) return;
    event.preventDefault(); event.stopPropagation(); pause();
    const rect = container.current.getBoundingClientRect();
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, item: shown, resize, width: rect.width, height: rect.height };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d || !session || d.id !== event.pointerId) return;
    const dx = (event.clientX - d.x) / d.width, dy = (event.clientY - d.y) / d.height;
    session.preview = d.resize ? { ...d.item, w: Math.max(.05, Math.min(1, d.item.w + dx * 2)) }
      : { ...d.item, x: Math.max(0, Math.min(1, d.item.x + dx)), y: Math.max(0, Math.min(1, d.item.y + dy)) };
    publish();
  }
  function end(event: PointerEvent<HTMLButtonElement>, cancel = false) {
    const d = drag.current;
    if (!d || !session || d.id !== event.pointerId) return;
    drag.current = null;
    const item = session.preview;
    session.preview = null; publish();
    if (!cancel && item && (item.x !== d.item.x || item.y !== d.item.y || item.w !== d.item.w)) void session.edit({ kind: "overlay", op: "update", id: item.id, patch: { x: item.x, y: item.y, w: item.w } });
  }
  const handlers = { onPointerMove: move, onPointerUp: (e: PointerEvent<HTMLButtonElement>) => end(e), onPointerCancel: (e: PointerEvent<HTMLButtonElement>) => end(e, true), onLostPointerCapture: (e: PointerEvent<HTMLButtonElement>) => end(e, true) };
  // ---- the pick box: drag one out, move it, or pull a corner; a click boxes the word where it is now
  const at = (event: PointerEvent<HTMLElement>) => { const r = container.current!.getBoundingClientRect(); return { x: clamp01((event.clientX - r.left) / r.width), y: clamp01((event.clientY - r.top) / r.height) }; };
  function pickStart(event: PointerEvent<HTMLElement>, mode: "draw" | "move" | number) {
    if (!picking || !container.current || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const p = at(event);
    pickDrag.current = { id: event.pointerId, mode, x: p.x, y: p.y, box: picking.box, quad: picking.quad, moved: false };
    layer.current?.setPointerCapture(event.pointerId);
  }
  function pickMove(event: PointerEvent<HTMLElement>) {
    const d = pickDrag.current;
    if (!d || d.id !== event.pointerId || !container.current) return;
    const p = at(event), r = container.current.getBoundingClientRect();
    if (!d.moved && Math.hypot((p.x - d.x) * r.width, (p.y - d.y) * r.height) < 4) return;
    d.moved = true;
    const span = (ax: number, ay: number, bx: number, by: number): PinBox => ({ x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) });
    // TRK2: a flat surface: a box dragged out becomes its four corners; each corner then moves on its own.
    if (pick?.flat) {
      if (d.mode === "draw" || !d.quad) setPick({ quad: quadOf(span(d.x, d.y, p.x, p.y)) });
      else if (d.mode === "move") setPick({ quad: moveQuad(d.quad, p.x - d.x, p.y - d.y) });
      else { const k = d.mode; setPick({ quad: d.quad.map((c, i) => i === k ? [p.x, p.y] : c) }); }
      return;
    }
    if (d.mode === "draw" || !d.box) setPick({ box: span(d.x, d.y, p.x, p.y) });
    else if (d.mode === "move") setPick({ box: { ...d.box, x: clamp01(Math.min(1 - d.box.w, d.box.x + p.x - d.x)), y: clamp01(Math.min(1 - d.box.h, d.box.y + p.y - d.y)) } });
    else { const b = d.box, k = d.mode, fx = k === 0 || k === 3 ? b.x + b.w : b.x, fy = k < 2 ? b.y + b.h : b.y; setPick({ box: span(fx, fy, p.x, p.y) }); }
  }
  function pickEnd(event: PointerEvent<HTMLElement>) {
    const d = pickDrag.current;
    if (!d || d.id !== event.pointerId) return;
    pickDrag.current = null;
    if (pick?.flat) { if (pick.quad && boxOf(pick.quad).w < .01 && boxOf(pick.quad).h < .01) setPick({ quad: d.quad }); return; }
    if (d.mode === "draw" && !d.moved && place && shown && container.current && !pick?.lock) {
      // A click: a box around the word where it sits now, a little bigger than it.
      const r = container.current.getBoundingClientRect(), aspect = aspects[shown.id] || (shown.graphic ? shown.graphic.widthPx / shown.graphic.heightPx : 1);
      const w = place.w * 1.2, h = place.w * (r.width / r.height) / aspect * 1.4;
      const x = clamp01(place.x - w / 2), y = clamp01(place.y - h / 2);
      setPick({ box: { x, y, w: Math.min(1, place.x + w / 2) - x, h: Math.min(1, place.y + h / 2) - y } });
    } else if (pick?.box && (pick.box.w < .01 || pick.box.h < .01)) setPick({ box: d.box });
  }
  // Clear of the player's own controls (format, Crop and full screen over the top edge; the transport at the bottom), and
  // of the thing: the bar goes low when the box is high.
  // The bar goes on the side with more room above or below the thing, so it never sits over a corner being pulled.
  const quad = picking?.flat ? picking.quad : null, box = picking ? (quad ? boxOf(quad) : picking.flat ? null : picking.box) : null, low = !!box && box.y < 1 - box.y - box.h;
  const status = result?.state === "running" ? `Following ${thingName(result.thing)}…` : result?.state === "done" && !result.lost ? `${result.lock ? "Locked on" : "Stuck to"} ${thingName(result.thing)}` : null;
  const kind = picking?.lock ? "lock" : "stick";
  return <div ref={container} className="pointer-events-none absolute inset-0 z-[5]" onDragOver={event => {
    if (session && !session.busy && event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }
  }} onDrop={event => {
    if (!session || session.busy) return;
    event.preventDefault(); event.stopPropagation();
    const paths = Array.from(event.dataTransfer.files).map(file => getApi().pathForFile(file)).filter(Boolean);
    if (!paths.length) { setError("Drop images in the desktop app, or use Add image."); return; }
    setError(null); void addOverlayFiles(session, paths, time).catch(e => setError(e instanceof Error ? e.message : "Couldn't add the images."));
  }}>
    {/* The drop target covers the picture, leaving controls above it. */}
    {session ? <div className="pointer-events-auto absolute inset-0" aria-label="Drop images on the player" /> : null}
    {(timeline.overlays ?? []).map(item => <img key={item.id} src={item.url} alt="" className="hidden" onLoad={event => {
      const image = event.currentTarget; setAspects(prior => prior[item.id] === image.naturalWidth / image.naturalHeight ? prior : { ...prior, [item.id]: image.naturalWidth / image.naturalHeight });
    }} />)}
    {session && shown && active && !picking && aspects[shown.id] ? <div className="absolute" style={{ left: `${place!.x * 100}%`, top: `${place!.y * 100}%`, width: `${place!.w * 100}%`, aspectRatio: aspects[shown.id], transform: `translate(-50%, -50%) rotate(${place!.rotate ?? 0}deg)` }}>
      <button type="button" aria-label="Move selected image" disabled={session.busy} onPointerDown={event => start(event, false)} {...handlers}
        onKeyDown={event => { if (!event.key.startsWith("Arrow")) return; event.preventDefault(); const step = event.shiftKey ? .05 : .01; void session.edit({ kind: "overlay", op: "update", id: shown.id, patch: { x: shown.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0), y: shown.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) } }); }}
        className={`pointer-events-auto absolute inset-0 cursor-move rounded bg-white/[0.08] hover:bg-white/[0.14] focus-visible:bg-white/20 ${FOCUS}`} style={{ touchAction: "none" }} />
      <button type="button" aria-label="Resize selected image" disabled={session.busy} onPointerDown={event => start(event, true)} {...handlers}
        onKeyDown={event => { if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); void session.edit({ kind: "overlay", op: "update", id: shown.id, patch: { w: shown.w + (event.key === "ArrowRight" ? .02 : -.02) } }); }}
        className={`pointer-events-auto absolute -bottom-2 -right-2 size-4 cursor-nwse-resize rounded-full bg-white ${FOCUS}`} style={{ touchAction: "none" }} />
    </div> : null}
    {picking && session ? <div ref={layer} data-pin-pick tabIndex={-1} role="application" aria-label={kind === "lock" ? "Pick the thing to lock on" : "Pick the thing to stick to"} className={`pointer-events-auto absolute inset-0 cursor-crosshair select-none ${FOCUS}`} style={{ touchAction: "none" }}
      onPointerDown={event => pickStart(event, "draw")} onPointerMove={pickMove} onPointerUp={pickEnd} onPointerCancel={pickEnd}>
      {quad ? <>
        {/* TRK2: a flat surface: everything but its quad dimmed a little, the quad a soft fill, its corners to pull. No strokes. */}
        <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
          <path d={`M0 0H1V1H0Z M${quad.map(c => `${c[0]} ${c[1]}`).join(" L")}Z`} fillRule="evenodd" className="fill-black/30" />
          <path data-pin-quad d={`M${quad.map(c => `${c[0]} ${c[1]}`).join(" L")}Z`} className="pointer-events-auto cursor-move fill-white/[0.22]" onPointerDown={event => pickStart(event as unknown as PointerEvent<HTMLElement>, "move")} />
        </svg>
        {quad.map((c, k) => <span key={k} data-pin-corner={k} onPointerDown={event => pickStart(event, k)} className="absolute size-3 cursor-move rounded-[3px] bg-white"
          style={{ left: `${c[0] * 100}%`, top: `${c[1] * 100}%`, transform: "translate(-50%, -50%)" }} />)}
      </> : box ? <>
        {/* Everything but the thing is dimmed a little: four soft fills around the box. */}
        {[{ left: 0, top: 0, width: "100%", height: `${box.y * 100}%` }, { left: 0, top: `${(box.y + box.h) * 100}%`, width: "100%", bottom: 0 },
          { left: 0, top: `${box.y * 100}%`, width: `${box.x * 100}%`, height: `${box.h * 100}%` }, { left: `${(box.x + box.w) * 100}%`, right: 0, top: `${box.y * 100}%`, height: `${box.h * 100}%` }]
          .map((style, i) => <div key={i} className="pointer-events-none absolute bg-black/30" style={style} />)}
        <div data-pin-box className="absolute cursor-move rounded-[3px] bg-white/[0.22]" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }} onPointerDown={event => pickStart(event, "move")}>
          {[0, 1, 2, 3].map(k => <span key={k} data-pin-corner={k} onPointerDown={event => pickStart(event, k)} className={`absolute size-2 rounded-[2px] bg-white ${k === 0 || k === 2 ? "cursor-nwse-resize" : "cursor-nesw-resize"}`}
            style={{ left: k === 0 || k === 3 ? 0 : "100%", top: k < 2 ? 0 : "100%", transform: "translate(-50%, -50%)" }} />)}
        </div>
      </> : <div className="pointer-events-none absolute inset-0 bg-black/20" />}
      <div data-pin-bar onPointerDown={event => event.stopPropagation()} className={`absolute inset-x-2 ${low ? "bottom-24" : "top-14"} flex cursor-default flex-wrap items-center gap-1.5 rounded-xl bg-black/65 p-1.5 text-[11px] text-white backdrop-blur-sm`}>
        <span className="min-w-0 flex-[1_1_100%] px-1 leading-snug text-white/85">{picking.flat
          ? quad ? `Pull each corner onto a corner of the flat thing, then ${kind}.` : "Drag a box over the flat thing; its corners then move one by one."
          : box ? `Fit the box to the thing, then ${kind}.` : kind === "lock" ? "Drag a box over the thing to hold still." : "Drag a box over the thing to follow, or click to box the word."}</span>
        <button type="button" data-pin-flat aria-pressed={picking.flat} onClick={() => setFlat(!picking.flat)} className={`rounded-lg px-2.5 py-1 text-[11px] text-white ${picking.flat ? "bg-white/30 hover:bg-white/35 focus-visible:bg-white/40" : "bg-white/10 hover:bg-white/20 focus-visible:bg-white/25"} ${FOCUS}`}>Flat surface</button>
        <input aria-label="What is it" placeholder={kind === "lock" ? "What is it? (phone)" : "What is it? (cup)"} value={picking.thing} maxLength={40} onChange={event => setPick({ thing: event.target.value })}
          className={`min-w-0 flex-1 rounded-lg bg-white/10 px-2 py-1 text-[11px] text-white placeholder:text-white/45 focus:bg-white/20 ${FOCUS}`} />
        <button type="button" data-pin-stick disabled={!(picking.flat ? quad : box) || session.busy} onClick={() => void confirmPick(session, now.current)} className={`rounded-lg bg-white px-2.5 py-1 text-[11px] font-semibold text-black hover:bg-white/85 focus-visible:bg-white/75 disabled:opacity-40 ${FOCUS}`}>{kind === "lock" ? "Lock" : "Stick"}</button>
        <button type="button" onClick={cancelPick} className={chip}>Cancel</button>
      </div>
    </div> : null}
    {status ? <div role="status" data-pin-status={result!.state} className="absolute left-2 top-14 overflow-hidden rounded-full bg-black/55 text-[11px] text-white backdrop-blur-sm">
      <span className="absolute inset-y-0 left-0 bg-white/20 transition-[width] duration-150" style={{ width: formatPercent(result!.state === "running" ? result!.pct ?? 0 : 100) }} />
      <span className="relative block px-2.5 py-1 tabular-nums">{status}{result!.state === "running" && result!.pct != null ? ` ${formatPercent(result!.pct)}` : ""}</span>
    </div> : null}
    {session && selected && result && result.itemId === selected.id && (result.state === "failed" || result.lost) ? <div data-pin-result role="status" onPointerDown={event => event.stopPropagation()} className="pointer-events-auto absolute inset-x-2 top-14 space-y-1.5 rounded-xl bg-black/65 p-2 text-[11px] text-white backdrop-blur-sm">
      <div className="flex items-start gap-2"><p data-pin-loss className="min-w-0 flex-1 pt-1 leading-snug">{result.state === "failed" ? result.note : result.lost}</p>
        <button type="button" onClick={dismissPinRun} className={chip}>Done</button></div>
      <div className="flex flex-wrap gap-1.5">
        {result.lost && result.lostAtS != null ? <button type="button" disabled={session.busy || pinWaiting(session)} onClick={() => trimToGood(session, selected, result.lostAtS!)} className={chip}>Trim to the good part</button> : null}
        <button type="button" disabled={session.busy || pinWaiting(session)} onClick={() => startPick(session, selected, !!selected.pin)} className={chip}>Pick again</button>
      </div>
    </div> : null}
    {session && result?.lock && (result.state === "failed" || result.lost) ? <div data-lock-result role="status" onPointerDown={event => event.stopPropagation()} className="pointer-events-auto absolute inset-x-2 top-14 space-y-1.5 rounded-xl bg-black/65 p-2 text-[11px] text-white backdrop-blur-sm">
      <div className="flex items-start gap-2"><p data-pin-loss className="min-w-0 flex-1 pt-1 leading-snug">{result.state === "failed" ? result.note : `${result.note ?? ""} ${result.lost}.`.trim()}</p>
        <button type="button" onClick={dismissPinRun} className={chip}>Done</button></div>
      <div className="flex flex-wrap gap-1.5"><button type="button" disabled={session.busy || pinWaiting(session)} onClick={() => startLockPick(session, result.lock!.piece, result.lock!, result.state !== "failed", result.thing)} className={chip}>Pick again</button></div>
    </div> : null}
    {error ? <InlineError className="absolute inset-x-2 top-12 rounded bg-black/80 p-2 text-micro text-white">{error}</InlineError> : null}
  </div>;
}
