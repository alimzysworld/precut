// TRK2: the locked frame. The picture steadies on a picked thing: lock_on tracks it through the clip (the same pick and
// tracker as pin_graphic) and saves PieceFx.lock; update_lock changes the knobs (anchor, keep size, max zoom) without
// tracking again; unlock takes it off. Each lands as one undoable version. The lock is baked into the clip's framing
// keys (edits-fx.ts fxPictures, after framing, before the punches and the clip transform), so the Chrome viewer, the
// Apple player and the export all steady the picture on the same numbers. When holding the thing would need more
// zoom than max zoom allows, it locks as far as that zoom allows and says what a full lock needs.
import { BrowserWindow } from 'electron';
import type { Clip, DraftPiece, PieceFx } from '../../shared/schema';
import { LOCK_DEFAULTS, lockAt, lockChoice, lockNote, lostText, reelTime, sanitizeLock, type PieceLock, type TrackFile, type TrackLoss } from '../../shared/pin-keys';
import { sourceTime } from '../../shared/picture-keys';
import { withClipTransforms } from '../../shared/clip-transform';
import { readTrack, trackClip } from './track';
import { lockTrackFor, rememberLockTrack } from './lock-tracks';
import { sourcePick } from './pin';
import { runActivity } from '../activity';

export const LOCK_TRACK_LABEL = 'Following a locked thing';
const background = new Map<string, Promise<void>>();
const pickOf = (lock: PieceLock) => lock.track.corners ? { s: lock.pickS, corners: lock.track.corners } : { s: lock.pickS, box: lock.track.box };

/** The tracks the version's locked clips read, into memory (planFx reads them from there). A missing one is tracked
 * again: waited for (export, the lock tools), or in the background, the clip playing as framed until it is read again. */
export async function loadLockTracks(root: string, pieceFx: (PieceFx | null)[] | undefined, clips: Clip[], wait: boolean) {
  for (const fx of pieceFx ?? []) {
    const lock = fx?.lock;
    if (!lock) continue;
    const key = lock.track.key;
    if (lockTrackFor(key)) continue;
    const cached = key ? await readTrack(root, key) : null;
    if (cached) { rememberLockTrack(cached); continue; }
    const clip = clips.find(c => c.id === lock.track.clipId);
    if (!clip) { if (wait) throw new Error("The clip a locked frame follows isn't in this shoot any more. Unlock it or lock it again."); continue; }
    const run = () => trackClip(root, clip, pickOf(lock), { s: lock.track.s, e: lock.track.e }, lock.track.mode);
    if (wait) {
      try { rememberLockTrack(await run(), key); }
      catch (error) { throw new Error(`Couldn't follow the thing a frame is locked on, so it can't be steadied. ${error instanceof Error ? error.message : ''}`.trim(), { cause: error }); }
      continue;
    }
    const at = `${root}\n${key ?? JSON.stringify(lock.track)}`;
    if (!background.has(at)) background.set(at, runActivity({ kind: 'render', root, target: { clipId: clip.id }, label: LOCK_TRACK_LABEL, cancelable: true }, async () => {
      rememberLockTrack(await run(), key);
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('api:sidekick-changed', root);
    }).catch(error => console.error('[lock] track:', error)).finally(() => background.delete(at)));
  }
}

// ---- the tools
export interface LockRequest {
  box?: number[]; corners?: number[][]; atS?: number; surface?: 'object' | 'flat'; thing?: string;
  anchor?: 'picked' | 'least'; scale?: boolean; maxZoom?: number;
}
export interface LockOptions { onProgress?: (share: number) => void }
const KNOBS = ['anchor', 'scale', 'maxZoom', 'thing'] as const;

/** The clip's piece by index or by its id in the version's piece list (read_edit). */
function pieceIndex(record: import('../sidekick').StoredVersion, piece: unknown, pieceId: unknown): number {
  if (typeof pieceId === 'string' && pieceId) {
    const found = record.pieces?.findIndex(p => p.id === pieceId) ?? -1;
    if (found < 0) throw new Error('That clip is not in this version. Use a piece id from read_edit.');
    return found;
  }
  if (Number.isInteger(piece) && (piece as number) >= 0) return piece as number;
  throw new Error('Choose the clip to lock: its pieceId from read_edit.');
}
async function context(root: string, cutId: string, version: number, piece: unknown, pieceId: unknown) {
  const { loadDraftVersion } = await import('../sidekick');
  const record = await loadDraftVersion(root, cutId, version), index = pieceIndex(record, piece, pieceId);
  const { planFx } = await import('../edits-fx');
  const fps = record.assembly.template.fps, items = planFx(record.assembly.cutList, fps, record).items.filter(item => item.piece === index);
  if (!items.length) throw new Error('Choose a clip in this cut.');
  const clipId = record.assembly.cutList.find((c, i) => (c.piece ?? i) === index)?.seg?.clip.id;
  const clip = record.assembly.shoot.clips.find(c => c.id === clipId);
  if (!clip) throw new Error('That piece has no clip to lock: pick a clip with picture.');
  if (items.every(item => item.reverse)) throw new Error('A clip playing backwards cannot be locked yet. Play it forwards first.');
  const { draftTimeline } = await import('../draft');
  const timeline = await draftTimeline(root, cutId, version);
  const pictures = withClipTransforms(timeline.pieces, record.pieceFx).filter(p => p.layer === 0 && p.piece === index && p.clipId === clip.id);
  if (!pictures.length) throw new Error("That clip isn't on the picture in this version.");
  const keys = items.flatMap(item => item.timeMap.map(k => k.s)), shown: [number, number] = [Math.min(...keys), Math.max(...keys)];
  return { record, index, clip, pictures, shown, frame: { width: timeline.width, height: timeline.height } };
}
/** The loss inside the part the clip shows, on the reel clock of the picture that shows it. */
function lossShown(track: TrackFile, shown: [number, number], pictures: DraftPiece[]): { loss: TrackLoss; atS: number } | null {
  for (const loss of [track.lostBefore, track.lost]) {
    if (!loss || loss.atS < shown[0] - 1e-6 || loss.atS > shown[1] + 1e-6) continue;
    const picture = pictures.find(p => { const a = sourceTime(p, p.startS), b = sourceTime(p, p.endS); return loss.atS >= Math.min(a, b) - 1e-6 && loss.atS <= Math.max(a, b) + 1e-6; }) ?? pictures[0];
    if (!picture) return null;
    return { loss, atS: reelTime(picture, loss.atS) };
  }
  return null;
}
/** What the agent and the inspector hear back: the zoom it costs, whether it is capped, the cost in plain words, and
 * where the tracker lost the thing (the frame holds still from there). */
function report(lock: PieceLock, track: TrackFile, shown: [number, number], pictures: DraftPiece[]) {
  const key = lockAt(track, lockChoice(lock, shown), lock.pickS);
  if (!key) throw new Error("Couldn't follow that in the clip: the tracker lost it at once. Pick it where it is clear and still.");
  const lost = lossShown(track, shown, pictures);
  return { zoom: Math.round(key.zoom * 1000) / 1000, need: Math.round(key.need * 1000) / 1000, capped: key.capped, note: lockNote(key, lock.maxZoom),
    ...(lost ? { lost: `${lostText(lost.loss, lost.atS, lock.thing)}; the frame holds still from there`, lostAtS: Math.round(lost.atS * 1000) / 1000 } : {}) };
}
async function save(root: string, cutId: string, version: number, record: import('../sidekick').StoredVersion, index: number, lock: PieceLock | null) {
  const { editCut } = await import('../sidekick');
  const fx: PieceFx = { ...record.pieceFx?.[index] };
  if (lock) fx.lock = lock; else delete fx.lock;
  return editCut(root, cutId, version, { kind: 'pieceFx', piece: index, fx: Object.keys(fx).length ? fx : null });
}

/** lock_on: track the thing in the box (or the four corners of a flat thing), frame fractions at reel second atS, through
 * the clip, and steady the picture on it. One undoable version. */
export async function lockOn(root: string, cutId: string, version: number, request: LockRequest & { piece?: number; pieceId?: string }, options: LockOptions = {}) {
  const { record, index, clip, pictures, shown, frame } = await context(root, cutId, version, request.piece, request.pieceId);
  const first = pictures[0], last = pictures[pictures.length - 1];
  const atS = request.atS ?? first.startS + Math.min(0.3, (last.endS - first.startS) / 2);
  const picture = pictures.find(p => atS >= p.startS - 1e-6 && atS <= p.endS + 1e-6);
  if (!picture) throw new Error(`Pick the thing while the clip is on (${first.startS.toFixed(2)} to ${last.endS.toFixed(2)} s).`);
  const t = Math.max(picture.startS, Math.min(picture.endS, atS));
  const surface = request.surface ?? (request.corners ? 'flat' : 'object'), mode = surface === 'flat' ? 'plane' as const : 'object' as const;
  const { source, quad } = sourcePick(picture, clip, frame, t, request, surface === 'flat');
  // The whole part the clip shows, and a little past it both ways, so a trim keeps the lock without tracking again.
  const pickS = sourceTime(picture, t), duration = clip.meta?.durationS ?? shown[1] + 2;
  const span = { s: Math.max(0, Math.min(shown[0], pickS) - 1.5), e: Math.min(duration, Math.max(shown[1], pickS) + 1.5) };
  const track = await trackClip(root, clip, quad ? { s: pickS, corners: quad } : { s: pickS, box: source }, span, mode, { onProgress: options.onProgress });
  rememberLockTrack(track);
  const before = record.pieceFx?.[index]?.lock;
  const knobs = Object.fromEntries(KNOBS.flatMap(k => request[k] !== undefined ? [[k, request[k]]] : before?.[k] !== undefined ? [[k, before[k]]] : []));
  const lock = sanitizeLock({ track: { clipId: clip.id, mode, s: span.s, e: span.e, ...(quad ? { corners: quad } : { box: source }), key: track.key }, pickS, ...knobs })!;
  const said = report(lock, track, shown, pictures);
  const result = await save(root, cutId, version, record, index, lock);
  return { cutId: result.cutId, version: result.version, piece: index, ...said, tracked: !track.cached };
}

/** update_lock: new knobs (no tracking), or a new pick (tracks again, keeping the knobs). One undoable version. */
export async function updateLock(root: string, cutId: string, version: number, request: LockRequest & { piece?: number; pieceId?: string }, options: LockOptions = {}) {
  const { record, index, clip, pictures, shown } = await context(root, cutId, version, request.piece, request.pieceId);
  const before = record.pieceFx?.[index]?.lock;
  if (!before) throw new Error('That clip is not locked. Lock it with lock_on first.');
  if (request.box || request.corners) return lockOn(root, cutId, version, { ...request, piece: index, pieceId: undefined }, options);
  const lock = sanitizeLock({ ...before, ...Object.fromEntries(KNOBS.flatMap(k => request[k] !== undefined ? [[k, request[k]]] : [])) })!;
  await loadLockTracks(root, [{ lock }], [clip], true);
  const track = lockTrackFor(lock.track.key);
  if (!track) throw new Error("Couldn't read the locked thing's track. Pick it again.");
  const said = report(lock, track, shown, pictures);
  const result = await save(root, cutId, version, record, index, lock);
  return { cutId: result.cutId, version: result.version, piece: index, ...said, tracked: false };
}

/** TRK2: each locked clip's cost and loss in this version, from the tracks in memory, for the Lock group (the timeline
 * carries them). A lock whose track isn't read yet says it is tracking. */
export function lockSummaries(record: import('../sidekick').StoredVersion, fx: import('../edits-fx').FxPlan, pictures: DraftPiece[]): import('../../shared/schema').LockSummary[] {
  const out: import('../../shared/schema').LockSummary[] = [];
  record.pieceFx?.forEach((pieceFx, index) => {
    if (!pieceFx?.lock) return;
    const item = fx.items.find(i => i.piece === index && i.lock), lock = item?.lock;
    const shown = pictures.filter(p => p.layer === 0 && p.piece === index);
    if (!lock) { out.push({ piece: index, zoom: 1, need: 1, capped: false, note: 'Following the thing to lock on…', ...(pieceFx.lock.thing ? { thing: pieceFx.lock.thing } : {}), tracking: true }); return; }
    try { out.push({ piece: index, ...report(lock.lock, lock.track, lock.span, shown.length ? shown : []), ...(lock.lock.thing ? { thing: lock.lock.thing } : {}) }); } catch { /* lost at once: the note comes with the next pick */ }
  });
  return out;
}

/** unlock: the clip as framed again. One undoable version. */
export async function unlock(root: string, cutId: string, version: number, request: { piece?: number; pieceId?: string }) {
  const { loadDraftVersion } = await import('../sidekick');
  const record = await loadDraftVersion(root, cutId, version), index = pieceIndex(record, request.piece, request.pieceId);
  if (!record.pieceFx?.[index]?.lock) throw new Error('That clip is not locked.');
  const result = await save(root, cutId, version, record, index, null);
  return { cutId: result.cutId, version: result.version, piece: index };
}
export { LOCK_DEFAULTS };
