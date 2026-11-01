// TRK1: follow a picked thing through a clip span (pipeline/track.swift, Vision on this Mac), both directions from the
// pick frame, cached per clip, pick, span and mode at <shoot>/.sidething/tracks/<key>.json like the person mattes.
// The cache is in the clip's oriented, normalised source space (precut's own quarter turn applied); the losses are
// measured here on the raw track, never smoothed away.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Clip } from '../../shared/schema';
import type { TrackFile, TrackFrame, TrackLoss, TrackLossWhy, TrackMode } from '../../shared/pin-keys';
import { clipFilterTurn } from '../../shared/media';
import { tool, toolEnvironment } from '../tools';
import { currentActivity } from '../activity';

export const TRACK_VERSION = 'trk2-4';
const LONG_SIDE = 1920;
export interface TrackPick { s: number; box?: { x: number; y: number; w: number; h: number }; corners?: number[][] }
const pending = new Map<string, Promise<TrackFile>>();

// ---- loss: TRK0's four signals on the raw track, in tracking order from the pick frame
interface Raw { t: number; b: [number, number, number, number] | null; c: number; q?: number[]; a?: number; e?: string }
/** The first lost frame going away from the pick (rows[0]), and why, or null. Box sizes in the tracker's pixels. */
export function findLoss(rows: Pick<Raw, 'b' | 'c' | 'a' | 'e'>[], width: number, height: number): { index: number; why: TrackLossWhy } | null {
  const edge = (i: number) => rows.slice(Math.max(0, i - 6), i + 1).some(({ b }) => !!b && b[2] > 0 && (b[0] <= 0.01 || b[1] <= 0.01 || b[0] + b[2] >= 0.99 || b[1] + b[3] >= 0.99));
  const lost = (index: number, kind: 'gone' | 'low' | 'fast'): { index: number; why: TrackLossWhy } =>
    ({ index, why: edge(index) ? 'left' : kind === 'gone' ? 'lost' : kind === 'low' ? 'covered' : 'fast' });
  let low = 0, frozen = 0, moved = false, prev: Raw['b'] = null;
  for (let i = 0; i < rows.length; i++) {
    const { b, c, a, e } = rows[i];
    if (!b || b[2] <= 0 || c < 0 || e) return lost(low ? i - low : i, 'gone');
    low = c < 0.3 ? low + 1 : 0;
    if (low >= 3) return lost(i - 2, 'low');
    // A flat thing cannot grow or shrink 15% in one frame: the fit broke.
    if (a != null && Math.abs(Math.log(Math.max(a, 1e-6))) > 0.15) return lost(i, 'fast');
    if (prev) {
      // Vision keeps its last box when it gives up: exactly frozen for 3 frames on a handheld shot is a loss
      // (a freeze before the first real update is a slow start).
      // TRK2: a plane quad held still while its border can't be read (a blurred frame) is not Vision giving up.
      const same = a == null && b.every((v, k) => Math.abs(v - prev![k]) < 1e-5);
      frozen = same ? frozen + 1 : 0; moved ||= !same;
      if (moved && frozen >= 3) return lost(i - 3, 'fast');
      if (Math.hypot((b[0] - prev[0]) * width, (b[1] - prev[1]) * height) > 0.35 * Math.max(b[3] * height, b[2] * width)) return lost(i, 'fast');
    }
    prev = b;
  }
  return null;
}

// ---- precut's extra quarter turn on top of the file's own orientation (what the helper sees)
function turnPoint(turn: number, x: number, y: number): [number, number] {
  return turn === 90 ? [1 - y, x] : turn === 180 ? [1 - x, 1 - y] : turn === 270 ? [y, 1 - x] : [x, y];
}
function turnBox(turn: number, b: [number, number, number, number]): [number, number, number, number] {
  const p = [turnPoint(turn, b[0], b[1]), turnPoint(turn, b[0] + b[2], b[1] + b[3])];
  const x = Math.min(p[0][0], p[1][0]), y = Math.min(p[0][1], p[1][1]);
  return [x, y, Math.abs(p[0][0] - p[1][0]), Math.abs(p[0][1] - p[1][1])];
}
/** Corners TL, TR, BR, BL stay in that order on screen after the turn. */
function turnCorners(turn: number, q: number[]): number[] {
  const points = [0, 1, 2, 3].map(k => turnPoint(turn, q[2 * k], q[2 * k + 1])), shift = turn / 90;
  return [0, 1, 2, 3].flatMap(k => points[(k + 4 - shift) % 4]);
}
export const turnForTest = { turnPoint, turnBox, turnCorners };

/** The cache file from the helper's lines: precut's turn applied, both directions joined in time order, losses found. */
export function buildTrack(rows: Raw[], done: Record<string, number>, meta: { key: string; clipId: string; mode: TrackMode; s: number; e: number; pickS: number; fps: number; turn: number }): TrackFile {
  const { turn } = meta, swap = turn % 180 !== 0, width = swap ? done.height : done.width, height = swap ? done.width : done.height;
  const turned: Raw[] = rows.map(r => ({ ...r, b: r.b ? turnBox(turn, r.b) : null, ...(r.q ? { q: turnCorners(turn, r.q) } : {}) }));
  const pickT = Number.isFinite(done.pickT) ? done.pickT : meta.pickS;
  const forward = turned.filter(r => r.t >= pickT - 1e-4).sort((a, b) => a.t - b.t);
  const backward = [forward[0], ...turned.filter(r => r.t < pickT - 1e-4).sort((a, b) => b.t - a.t)].filter(Boolean);
  const loss = (list: Raw[]): TrackLoss | undefined => { const found = findLoss(list, width, height); return found ? { atS: list[found.index].t, why: found.why } : undefined; };
  const lost = loss(forward), lostBefore = backward.length > 1 ? loss(backward) : undefined;
  const all = [...backward.slice(1).reverse(), ...forward];
  return { version: TRACK_VERSION, key: meta.key, clipId: meta.clipId, mode: meta.mode, fps: done.rate || meta.fps, width, height, s: meta.s, e: meta.e, pickS: pickT,
    frames: all.map(r => [r.t, ...(r.b ?? [0, 0, 0, 0]), r.e ? -1 : r.c] as TrackFrame),
    ...(meta.mode === 'plane' ? { corners: all.map(r => r.q ?? []), area: all.map(r => r.a ?? null) } : {}),
    ...(lost ? { lost } : {}), ...(lostBefore ? { lostBefore } : {}), ...(Number.isFinite(done.fps) ? { speed: done.fps } : {}) };
}

// ---- the cache
async function tracksDirectory(root: string) {
  const base = path.join(root, '.sidething'), directory = path.join(base, 'tracks');
  for (const folder of [base, directory]) {
    await fs.mkdir(folder).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if ((await fs.lstat(folder)).isSymbolicLink() || await fs.realpath(folder) !== folder) throw new Error('Tracks must stay inside this shoot.');
  }
  return directory;
}
async function readCached(file: string, key: string): Promise<TrackFile | null> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  const track = await fs.readFile(file, 'utf8').then(JSON.parse, () => null) as TrackFile | null;
  return track?.version === TRACK_VERSION && track.key === key && Array.isArray(track.frames) ? track : null;
}
function runHelper(source: string, args: string[], signal?: AbortSignal, onRow?: (count: number) => void): Promise<{ rows: Raw[]; done: Record<string, number> }> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(tool('track'), [source, ...args], { env: toolEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => child.kill('SIGKILL'), deadline = setTimeout(stop, 10 * 60_000);
    signal?.addEventListener('abort', stop, { once: true });
    const rows: Raw[] = [];
    let done: Record<string, number> | undefined, stderr = '';
    createInterface({ input: child.stdout }).on('line', line => {
      try { const row = JSON.parse(line); if (row.done) done = row; else if (Number.isFinite(row.t)) { rows.push(row); onRow?.(rows.length); } } catch { /* not ours */ }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
    const finish = () => { clearTimeout(deadline); signal?.removeEventListener('abort', stop); };
    child.once('error', error => { finish(); reject(error); });
    child.once('close', code => {
      finish();
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0 && done) resolve({ rows, done });
      else reject(new Error(`Couldn't follow that in the clip. ${stderr.replace(/^track: /, '').trim()}`.trim()));
    });
  });
}

/**
 * The track of one picked thing over [span.s, span.e] source seconds of a clip, from the frame at pick.s, both ways.
 * A second call with the same clip file, pick, span and mode reads the cache and runs nothing.
 */
export async function trackClip(root: string, clip: Clip, pick: TrackPick, span: { s: number; e: number }, mode: TrackMode,
  options: { signal?: AbortSignal; onProgress?: (share: number) => void } = {}): Promise<TrackFile & { cached: boolean }> {
  if (mode !== 'object' && mode !== 'plane') throw new Error('Choose to follow an object or a flat surface.');
  const duration = clip.meta?.durationS ?? Infinity, frame = 1 / (clip.meta?.fps || 25);
  if (![span.s, span.e, pick.s].every(Number.isFinite) || span.s < 0 || span.e <= span.s || span.e > duration + frame || pick.s < span.s || pick.s > span.e)
    throw new Error('Pick a moment inside the part of the clip to follow.');
  const inside = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;
  if (pick.corners ? pick.corners.length !== 4 || !pick.corners.every(p => p.length === 2 && p.every(inside))
    : !pick.box || ![pick.box.x, pick.box.y, pick.box.w, pick.box.h].every(inside) || pick.box.w <= 0 || pick.box.h <= 0 || pick.box.x + pick.box.w > 1 + 1e-6 || pick.box.y + pick.box.h > 1 + 1e-6)
    throw new Error('Pick the thing inside the frame.');
  const realRoot = await fs.realpath(root), source = await fs.realpath(path.resolve(root, clip.file));
  if (!source.startsWith(realRoot + path.sep)) throw new Error('The clip must stay inside this shoot.');
  const stat = await fs.stat(source), turn = clipFilterTurn(clip);
  const choice = { pick: pick.corners ? { s: pick.s, corners: pick.corners } : { s: pick.s, box: pick.box }, span: { s: span.s, e: span.e }, mode };
  const key = createHash('sha256').update(JSON.stringify([TRACK_VERSION, clip.id, path.relative(realRoot, source), stat.size, stat.mtimeMs, turn, LONG_SIDE, choice])).digest('hex');
  const directory = await tracksDirectory(realRoot), file = path.join(directory, `${key}.json`);
  const cached = await readCached(file, key);
  if (cached) return { ...cached, cached: true };
  if (!pending.has(file)) pending.set(file, (async () => {
    // The helper sees the file's own orientation: undo precut's extra turn on the pick, apply it to the answer.
    const back = (360 - turn) % 360;
    const helperPick = pick.corners ? { corners: turnCorners(back, pick.corners.flat()).reduce<number[][]>((a, v, i) => (i % 2 ? a[a.length - 1].push(v) : a.push([v]), a), []) }
      : (([x, y, w, h]) => ({ x, y, w, h }))(turnBox(back, [pick.box!.x, pick.box!.y, pick.box!.w, pick.box!.h]));
    // TRK1c: how far through the span it is (both directions from the pick), for the stage's quiet status.
    const frames = Math.max(1, (span.e - span.s) * (clip.meta?.fps || 25)), report = options.onProgress;
    const { rows, done } = await runHelper(source, [String(span.s), String(span.e), String(pick.s), mode, JSON.stringify(helperPick), String(LONG_SIDE)], options.signal ?? currentActivity()?.signal,
      report && (count => report(Math.min(0.99, count / frames))));
    const track = buildTrack(rows, done, { key, clipId: clip.id, mode, s: span.s, e: span.e, pickS: pick.s, fps: clip.meta?.fps || 25, turn });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(track)); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
    return track;
  })().finally(() => pending.delete(file)));
  return { ...await pending.get(file)!, cached: false };
}
/** The cached track a pin points at, or null when it has to be tracked again (cache cleared, clip changed). */
export async function readTrack(root: string, key: string): Promise<TrackFile | null> {
  if (!/^[a-f0-9]{64}$/.test(key)) return null;
  const realRoot = await fs.realpath(root), directory = path.join(realRoot, '.sidething', 'tracks');
  if (await fs.realpath(directory).catch(() => null) !== directory) return null;
  return readCached(path.join(directory, `${key}.json`), key);
}
