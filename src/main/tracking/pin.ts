// TRK1b: a graphic or title pinned to a thing in the shot. pin_graphic, update_pin and unpin land as one undoable
// version each; the tracks a version's pins read are loaded once and kept in memory; the title page (live, Apple and
// export) draws from pinKeys (src/shared/pin-keys.ts), so all three place the item on the same numbers.
import { BrowserWindow } from 'electron';
import type { Clip, DraftPiece, OverlayItem, TitleCue, TitleTrack } from '../../shared/schema';
import { lostText, pinAt, pinHeld, pinKeys, pinLoss, pinPiece, pinTrackId, reelTime, sanitizePin, sourceToFrame, type PinChoice, type TrackFile } from '../../shared/pin-keys';
import { sourceTime } from '../../shared/picture-keys';
import { withClipTransforms } from '../../shared/clip-transform';
import { clipDimensions } from '../../shared/media';
import { readTrack, trackClip } from './track';
import { runActivity } from '../activity';

export const PIN_TRACK_LABEL = 'Following a pinned thing';
type Pinned = { pin?: PinChoice | null };
const memory = new Map<string, TrackFile>(), background = new Map<string, Promise<void>>();
const memoryKey = (root: string, pin: PinChoice) => `${root}\n${pinTrackId(pin)}`;
const pickOf = (pin: PinChoice) => pin.track.corners ? { s: pin.pickS, corners: pin.track.corners } : { s: pin.pickS, box: pin.track.box };

/** The tracks a set of pinned things read, by pinTrackId: from memory, else the shoot's cache. A missing one is tracked
 * again: waited for (export, the pin tools), or in the background, where the item draws at its pick placement until
 * the timeline reads it again. */
export async function pinTracks(root: string, items: Pinned[], clips: Clip[], wait: boolean): Promise<Record<string, TrackFile>> {
  const found: Record<string, TrackFile> = {};
  for (const { pin } of items) {
    if (!pin) continue;
    const id = pinTrackId(pin), at = memoryKey(root, pin);
    if (found[id]) continue;
    let track = memory.get(at) ?? (pin.track.key ? await readTrack(root, pin.track.key) : null);
    if (!track) {
      const clip = clips.find(c => c.id === pin.track.clipId);
      if (!clip) { if (wait) throw new Error("The clip a graphic is pinned to isn't in this shoot any more. Unpin it or pin it again."); continue; }
      const run = () => trackClip(root, clip, pickOf(pin), { s: pin.track.s, e: pin.track.e }, pin.track.mode);
      if (wait) {
        try { track = await run(); }
        catch (error) { throw new Error(`Couldn't follow the thing a graphic is pinned to, so it can't be drawn in place. ${error instanceof Error ? error.message : ''}`.trim(), { cause: error }); }
      } else {
        if (!background.has(at)) background.set(at, runActivity({ kind: 'render', root, target: { clipId: clip.id }, label: PIN_TRACK_LABEL, cancelable: true }, async () => {
          memory.set(at, await run());
          for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('api:sidekick-changed', root);
        }).catch(error => console.error('[pin] track:', error)).finally(() => background.delete(at)));
        continue;
      }
    }
    memory.set(at, track);
    if (memory.size > 64) memory.delete(memory.keys().next().value!);
    found[id] = track;
  }
  return found;
}

/** Each pinned overlay and title cue with its keys through these pictures (export: waited, so nothing draws unpinned). */
export function withPinKeys<T extends { s: number; e: number; x?: number; y?: number; w?: number; pin?: PinChoice | null }>(items: T[], pieces: DraftPiece[], tracks: Record<string, TrackFile>, frame: { width: number; height: number; fps: number }): T[] {
  return items.map(item => {
    const track = item.pin && tracks[pinTrackId(item.pin)], keys = track && pinKeys(item, pieces, track, frame);
    return keys ? { ...item, pinKeys: keys } : item;
  });
}
export async function pinForExport<O extends OverlayItem>(root: string, overlays: O[], titles: TitleTrack | null | undefined, pieces: DraftPiece[], frame: { width: number; height: number; fps: number }, clips: Clip[]) {
  const pinned = [...overlays, ...titles?.cues ?? []].filter(item => item.pin);
  if (!pinned.length) return { overlays, titles };
  const tracks = await pinTracks(root, pinned, clips, true);
  return { overlays: withPinKeys(overlays, pieces, tracks, frame), titles: titles && { ...titles, cues: withPinKeys(titles.cues, pieces, tracks, frame) } };
}

// ---- the tools
export interface PinRequest {
  box?: number[]; corners?: number[][]; atS?: number; surface?: 'object' | 'flat'; thing?: string;
  offset?: { x?: number; y?: number }; size?: number; followScale?: number; followRotation?: boolean; steadiness?: number; lead?: number; fade?: number; exit?: 'auto' | 'hold' | 'carry';
}
const KNOBS = ['offset', 'size', 'followScale', 'followRotation', 'steadiness', 'lead', 'fade', 'exit', 'thing'] as const;
type Target = { kind: 'overlay'; item: OverlayItem } | { kind: 'cue'; item: TitleCue };

async function context(root: string, cutId: string, version: number, itemId: string) {
  const { loadDraftVersion } = await import('../sidekick');
  const record = await loadDraftVersion(root, cutId, version);
  const overlay = record.overlays?.find(o => o.id === itemId), cue = record.titles?.cues.find(c => c.id === itemId);
  const target: Target | null = overlay ? { kind: 'overlay', item: overlay } : cue ? { kind: 'cue', item: cue } : null;
  if (!target) throw new Error('That graphic is not in this version.');
  if (target.kind === 'overlay' && target.item.graphic?.frame === 'full') throw new Error('A full frame graphic replaces the picture, so there is nothing to pin it to.');
  if (target.kind === 'cue' && (target.item.role !== 'title' || target.item.id.startsWith('kinetic-') || target.item.id.startsWith('lower-third:'))) throw new Error('Only a graphic or a designed title can be pinned; captions follow the words.');
  // TASTE1: a full-screen scene replaces the picture, so there is nothing of the shot to follow under it.
  const { fullScreenOver, underFullScreen } = await import('../graphics/edit');
  const under = fullScreenOver(record.overlays, target.item.s, target.item.e, target.item.id);
  if (under) throw new Error(underFullScreen(under));
  const { draftTimeline } = await import('../draft');
  const timeline = await draftTimeline(root, cutId, version);
  const pieces = withClipTransforms(timeline.pieces, record.pieceFx);
  return { record, target, pieces, frame: { width: timeline.width, height: timeline.height, fps: timeline.fps ?? record.assembly.template.fps }, clips: record.assembly.shoot.clips };
}

/** What the agent hears back: how long it holds while the item is on, and the loss in plain words and as the reel second
 * it happens (TRK1c: where "Trim to the good part" ends the item). */
function report(item: { s: number; e: number }, pin: PinChoice, piece: DraftPiece, track: TrackFile) {
  const loss = pinLoss(item, piece, track), at = loss && reelTime(piece, loss.atS);
  return { heldS: Math.round(pinHeld(item, piece, track) * 100) / 100, ...(loss ? { lost: lostText(loss, at!, pin.thing), lostAtS: Math.round(at! * 1000) / 1000 } : {}) };
}
/** TRK1c: the hands-on path (the inspector and the stage) hears how far the tracker is, 0 to 1. */
export interface PinOptions { onProgress?: (share: number) => void }

/** The pin's placement at its pick frame (x, y and, for an overlay, w), and the loss written onto it. */
function placed(target: Target, pin: PinChoice, piece: DraftPiece, track: TrackFile, frame: { width: number; height: number }) {
  const loss = pinLoss(target.item, piece, track), withLoss: PinChoice = { ...pin, ...(loss ? { lost: loss } : {}) };
  if (!loss) delete withLoss.lost;
  const key = pinAt({ pin: withLoss }, piece, reelTime(piece, pin.pickS), track, frame);
  if (!key) throw new Error("Couldn't follow that in the clip: the tracker lost it at once. Pick it where it is clear and still.");
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  return { pin: withLoss, x: clamp(key.x), y: clamp(key.y), ...(target.kind === 'overlay' ? { w: Math.max(0.05, Math.min(1, key.w)) } : {}) };
}

async function save(root: string, cutId: string, version: number, target: Target, patch: Record<string, unknown>, label: string) {
  const { editCut, finishStoredVersion } = await import('../sidekick');
  if (target.kind === 'overlay') return editCut(root, cutId, version, { kind: 'overlay', op: 'update', id: target.item.id, patch } as never);
  // A designed title: one version with that cue changed, through the same versioned save the overlays use.
  return runActivity({ kind: 'edit', root, target: { cutId, version }, label, cancelable: true }, () =>
    finishStoredVersion(root, cutId, version, true, async (record, assembly) => {
      if (!record.titles) throw new Error('That title is no longer in this version.');
      const cues = record.titles.cues.map(c => {
        if (c.id !== target.item.id) return c;
        const next = { ...c, ...patch } as TitleCue & { pin?: PinChoice };
        if (!next.pin) delete next.pin;
        return next;
      });
      record.titles = { ...record.titles, cues };
      record.feedback = !patch.pin ? 'Unpinned a title' : (target.item as { pin?: PinChoice }).pin ? 'Changed the pin on a title' : 'Pinned a title';   // REL09e
      record.assembly = assembly;
      const { renderStoredPreview } = await import('../sidekick');
      await renderStoredPreview(root, cutId, record, assembly);
      return { cutId, version: record.version };
    }));
}

/** The picked thing, from the frame as he sees it at reel second t back to the clip's own picture (the frame's map is
 * affine at one moment): a box [x, y, w, h], or four corners TL, TR, BR, BL (TRK2: a flat surface, dragged or from the
 * box's corners). Returns its bounding box in the source and, for a flat surface, its quad. */
export function sourcePick(piece: DraftPiece, clip: Clip, frame: { width: number; height: number }, t: number, request: { box?: number[]; corners?: number[][] }, flat: boolean) {
  const { box, corners: given } = request;
  let frameCorners: number[][];
  if (given !== undefined) {
    if (!Array.isArray(given) || given.length !== 4 || !given.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && n >= -0.05 && n <= 1.05))) throw new Error('Give the flat thing as four corners [[x, y], ...], top left, top right, bottom right, bottom left, fractions of the frame.');
    frameCorners = given;
  } else {
    if (!Array.isArray(box) || box.length !== 4 || !box.every(n => Number.isFinite(n)) || box[2] <= 0 || box[3] <= 0) throw new Error('Give the thing as box [x, y, w, h], fractions of the frame from its top left.');
    frameCorners = [[box[0], box[1]], [box[0] + box[2], box[1]], [box[0] + box[2], box[1] + box[3]], [box[0], box[1] + box[3]]];
  }
  const { width, height } = clipDimensions(clip), aspect = width / height, out = frame.width / frame.height;
  const o = sourceToFrame(piece, t, 0, 0, aspect, out), ex = sourceToFrame(piece, t, 1, 0, aspect, out), ey = sourceToFrame(piece, t, 0, 1, aspect, out);
  const a = ex.x - o.x, b = ey.x - o.x, c = ex.y - o.y, d = ey.y - o.y, det = a * d - b * c;
  if (Math.abs(det) < 1e-9) throw new Error('That moment of the clip is not shown, so nothing can be picked there.');
  const back = (x: number, y: number) => [(d * (x - o.x) - b * (y - o.y)) / det, (-c * (x - o.x) + a * (y - o.y)) / det];
  const corners = frameCorners.map(([x, y]) => back(x, y));
  const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]), inside = (n: number) => Math.max(0, Math.min(1, n));
  const source = { x: inside(Math.min(...xs)), y: inside(Math.min(...ys)) } as { x: number; y: number; w: number; h: number };
  source.w = inside(Math.max(...xs)) - source.x; source.h = inside(Math.max(...ys)) - source.y;
  if (source.w < 0.01 || source.h < 0.01) throw new Error('That box is outside the picture. Box the thing where it shows.');
  if (flat) {
    // Four corners in reading order (TL, TR, BR, BL) around a convex quad, whatever order they were dragged in.
    const cx = xs.reduce((n, x) => n + x, 0) / 4, cy = ys.reduce((n, y) => n + y, 0) / 4;
    const around = corners.map(p => [inside(p[0]), inside(p[1])]).sort((p, q) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx));
    const first = around.reduce((best, p, i) => p[0] + p[1] < around[best][0] + around[best][1] ? i : best, 0);
    const quad = [0, 1, 2, 3].map(k => around[(first + k) % 4]);
    const area = quad.reduce((n, p, i) => { const q = quad[(i + 1) % 4]; return n + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
    if (!(area > 1e-4)) throw new Error('Those corners do not make a surface. Drag each corner onto a corner of the flat thing.');
    return { source, quad };
  }
  return { source, quad: undefined };
}

/** pin_graphic: track the thing in the box (frame fractions at reel second atS) through the clip under the item and pin
 * the item to it. One undoable version. */
export async function pinItem(root: string, cutId: string, version: number, itemId: string, request: PinRequest, options: PinOptions = {}) {
  const { target, pieces, frame, clips } = await context(root, cutId, version, itemId);
  const item = target.item;
  const atS = request.atS ?? item.s;
  if (!(atS >= item.s - 1e-6 && atS <= item.e + 1e-6)) throw new Error(`Pick the thing while the item is on (${item.s.toFixed(2)} to ${item.e.toFixed(2)} s).`);
  const piece = pieces.filter(p => p.clipId && p.layer <= 1 && atS >= p.startS - 1e-6 && atS <= p.endS + 1e-6 && (p.opacity ?? [{ a: 1 }]).some(k => k.a > 0)).sort((a, b) => b.layer - a.layer)[0];
  const clip = piece && clips.find(c => c.id === piece.clipId);
  if (!piece || !clip) throw new Error('There is no clip under the item at that moment to pin it to.');
  const t = Math.max(piece.startS, Math.min(piece.endS, atS));
  const surface = request.surface ?? (request.corners ? 'flat' : 'object'), mode = surface === 'flat' ? 'plane' as const : 'object' as const;
  const { source, quad } = sourcePick(piece, clip, frame, t, request, surface === 'flat');
  // Follow it a little past the item both ways, so trims and speed changes keep the pin without tracking again.
  const pickS = sourceTime(piece, t), ends = [Math.max(item.s, piece.startS), Math.min(item.e, piece.endS)].map(x => sourceTime(piece, x));
  const duration = clip.meta?.durationS ?? Math.max(...ends) + 2;
  const span = { s: Math.max(0, Math.min(...ends, pickS) - 1.5), e: Math.min(duration, Math.max(...ends, pickS) + 1.5) };
  const track = await trackClip(root, clip, quad ? { s: pickS, corners: quad } : { s: pickS, box: source }, span, mode, { onProgress: options.onProgress });
  const knobs = Object.fromEntries(KNOBS.flatMap(k => request[k] !== undefined ? [[k, request[k]]] : []));
  const pin = sanitizePin({ track: { clipId: clip.id, mode, s: span.s, e: span.e, ...(quad ? { corners: quad } : { box: source }), key: track.key }, pickS, surface, ...knobs })!;
  memory.set(memoryKey(root, pin), track);
  const at = placed(target, pin, piece, track, frame);
  const result = await save(root, cutId, version, target, at, 'Pinning a graphic');
  return { ...result, id: item.id, ...report(item, at.pin, piece, track), tracked: !track.cached };
}

/** update_pin: new knobs (no tracking), or a new box (tracks again). One undoable version. */
export async function updatePin(root: string, cutId: string, version: number, itemId: string, request: PinRequest, options: PinOptions = {}) {
  const { target, pieces, frame, clips } = await context(root, cutId, version, itemId);
  const before = target.item.pin;
  if (!before) throw new Error('That graphic is not pinned. Pin it with pin_graphic first.');
  // A new pick tracks again, keeping the knobs he set.
  if (request.box || request.corners) return pinItem(root, cutId, version, itemId, { ...Object.fromEntries(KNOBS.flatMap(k => before[k] !== undefined ? [[k, before[k]]] : [])), ...(request.corners ? {} : { surface: before.surface }), ...request }, options);
  if (request.surface && request.surface !== before.surface) throw new Error('A new surface needs a new pick: give the box or the corners again.');
  const knobs = Object.fromEntries(KNOBS.flatMap(k => request[k] !== undefined ? [[k, k === 'offset' ? { ...before.offset, ...request.offset } : request[k]]] : []));
  const pin = sanitizePin({ ...before, ...knobs })!;
  const track = (await pinTracks(root, [{ pin }], clips, true))[pinTrackId(pin)];
  const piece = pinPiece(target.item, pieces);
  if (!piece) throw new Error("The clip this graphic is pinned to isn't under it any more. Unpin it, or pin it again where it shows.");
  const at = placed(target, pin, piece, track, frame);
  const result = await save(root, cutId, version, target, at, 'Changing a pin');
  return { ...result, id: itemId, ...report(target.item, at.pin, piece, track), tracked: false };
}

/** unpin: the plain item, where it sat at the pick frame. One undoable version. */
export async function unpin(root: string, cutId: string, version: number, itemId: string) {
  const { loadDraftVersion } = await import('../sidekick');
  const record = await loadDraftVersion(root, cutId, version);
  const overlay = record.overlays?.find(o => o.id === itemId), cue = record.titles?.cues.find(c => c.id === itemId);
  const target: Target | null = overlay ? { kind: 'overlay', item: overlay } : cue ? { kind: 'cue', item: cue } : null;
  if (!target) throw new Error('That graphic is not in this version.');
  if (!target.item.pin) throw new Error('That graphic is not pinned.');
  const result = await save(root, cutId, version, target, { pin: undefined }, 'Unpinning a graphic');
  return { ...result, id: itemId };
}
