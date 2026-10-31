import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app } from 'electron';
import { getMusicFolder } from './settings';
import { musicReferences } from './music';
import { AUDIO_FILE } from './music-file';
import { tool } from './tools';
import { runActivity, awaitSoundPreparation } from './activity';
import type { LibraryTrack, MusicCatalog } from '../shared/music-library';

type Entry = { key: string; track: LibraryTrack };
let state: MusicCatalog = { tracks: [], total: 0, completed: 0, failed: 0, measuring: false, etaS: null };
let scan: Promise<void> | undefined, work: Promise<void> | undefined, signature = '', checked = 0, lastFolder: string | null | undefined;
export function invalidateMusicCatalog() { checked = 0; }
async function json(file: string) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return {}; } }
export async function musicCatalog(retry = false): Promise<MusicCatalog> {
  const folder = await getMusicFolder();
  if (retry) invalidateMusicCatalog();
  // Canceling background work must survive the panel's next polling request.
  if (state.error && folder === lastFolder && !retry) return structuredClone(state);
  if (!scan && (!checked || folder !== lastFolder || Date.now() - checked > 2000) && !work) {
    lastFolder = folder;
    scan = refresh(folder).finally(() => { scan = undefined; });
  }
  await scan;
  return structuredClone(state);
}
export async function measuredMusic(): Promise<LibraryTrack[]> {
  // Legacy listing promises a fresh filesystem view, including removed files.
  invalidateMusicCatalog();
  return awaitSoundPreparation(async () => {
    await musicCatalog();
    await work;
    // References may have been added while a previous scan was measuring.
    await musicCatalog();
    await work;
    return structuredClone(state.tracks);
  });
}
/** Tracks measured on their own, out of turn (an edit's track, see measureTrackNow), by file. The library's next
 * listing takes them as measured while their file is unchanged, and saves them with the rest. */
const measuredNow = new Map<string, Entry>();
type Candidate = { file: string; key: string; size: number; mtimeMs: number };
/** One track's facts: its probe, plus tempo and loudness that Python already measured for this exact file. */
async function probeTrack(candidate: Candidate, measured: { entries?: Record<string, unknown> }, signal?: AbortSignal): Promise<LibraryTrack> {
  const { stdout } = await promisify(execFile)(tool('ffprobe'), ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index:stream_tags:format=duration:format_tags', '-of', 'json', candidate.file], { signal, timeout: 30_000, maxBuffer: 1024 * 1024 });
  const data = JSON.parse(stdout), durationS = Number(data.format?.duration);
  if (!data.streams?.length || !Number.isFinite(durationS) || durationS <= 0) throw Error('Invalid audio');
  const raw = Object.fromEntries(Object.entries({ ...data.streams[0]?.tags, ...data.format.tags }).map(([k,v]) => [k.toLowerCase(), v]));
  const tags: NonNullable<LibraryTrack['tags']> = {};
  for (const key of ['title','artist','album','genre','comment'] as const) if (typeof raw[key] === 'string') tags[key] = (raw[key] as string).slice(0, 4000);
  // Python owns music-cache.json. Reuse its measured tempo/loudness only
  // when path, size and nanosecond mtime still match; never overwrite it.
  const analysis = Object.entries(measured.entries ?? {}).find(([key]) => {
    try { const [file, size, ns] = JSON.parse(key); return file === candidate.file && size === candidate.size && Math.abs(Number(ns) / 1e6 - candidate.mtimeMs) < .01; } catch { return false; }
  })?.[1] as { tempo?: number; integratedLUFS?: number } | undefined;
  const bpm = Number(raw.tbpm ?? raw.bpm ?? raw.tempo ?? analysis?.tempo);
  return { file: candidate.file, name: path.basename(candidate.file, path.extname(candidate.file)), durationS, bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null, tags, ...(Number.isFinite(analysis?.integratedLUFS) ? { integratedLUFS: analysis!.integratedLUFS } : {}) };
}
/** An edit's own track, measured now and on its own (one probe), so opening the edit never waits for the rest of the
 * library: that measuring runs in the background lane behind every other background job (room tone, previews, live
 * voice), and a draft whose track was new to the catalog (a changed file, a fresh library) sat on "Loading draft…"
 * for as long as all of that took. The file joins the catalog exactly as a measured one does. */
export async function measureTrackNow(file: string): Promise<string | null> {
  if (state.tracks.some(track => track.file === file)) return file;
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile() || !AUDIO_FILE.test(file)) return null;
  const candidate: Candidate = { file, key: JSON.stringify([file, stat.size, stat.mtimeMs, stat.ctimeMs]), size: stat.size, mtimeMs: stat.mtimeMs };
  try {
    const track = await probeTrack(candidate, await json(path.join(app.getPath('userData'), 'music-cache.json')));
    measuredNow.set(file, { key: candidate.key, track });
    if (!state.tracks.some(t => t.file === file)) state.tracks.push(track);
    return file;
  } catch { return null; }
}
async function refresh(folder: string | null) {
  const entries = folder ? await fs.readdir(folder, { withFileTypes: true }).catch(() => []) : [];
  const files = [...new Set([...(await musicReferences()), ...entries.filter(e => e.isFile()).map(e => path.resolve(folder!, e.name))])].filter(f => AUDIO_FILE.test(f)).sort();
  const candidates: Candidate[] = [];
  for (const file of files) {
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.isFile()) candidates.push({ file, key: JSON.stringify([file, stat.size, stat.mtimeMs, stat.ctimeMs]), size: stat.size, mtimeMs: stat.mtimeMs });
  }
  checked = Date.now();
  const nextSignature = JSON.stringify(candidates.map(c => c.key));
  if (signature === nextSignature && !state.error) return;
  signature = nextSignature;
  const cachePath = path.join(app.getPath('userData'), 'music-library.json');
  const cache = await json(cachePath), measured = await json(path.join(app.getPath('userData'), 'music-cache.json'));
  const saved: Record<string, Entry> = cache.version === 1 ? cache.entries ?? {} : {};
  const next: Record<string, Entry> = {};
  state = { tracks: [], total: candidates.length, completed: 0, failed: 0, measuring: false, etaS: null };
  const pending: typeof candidates = [];
  let unsaved = false;
  for (const candidate of candidates) {
    const known = saved[candidate.file]?.key === candidate.key, hit = known ? saved[candidate.file] : measuredNow.get(candidate.file);
    if (hit?.key === candidate.key) { next[candidate.file] = hit; state.tracks.push(hit.track); state.completed++; unsaved ||= !known; }
    else pending.push(candidate);
  }
  const write = async () => {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const temp = `${cachePath}.${process.pid}.tmp`;
    try { await fs.writeFile(temp, JSON.stringify({ version: 1, entries: next })); await fs.rename(temp, cachePath); }
    finally { await fs.unlink(temp).catch(() => {}); }
  };
  // A track measured out of turn is saved like one the pass measured.
  if (!pending.length) { if (unsaved) await write().catch(() => {}); return; }
  state.measuring = true;
  // A single cancelable background slot. Listing returns before probes run.
  work = runActivity({ kind: 'render', root: null, target: null, label: 'Measuring music', cancelable: true }, async activity => {
    const started = Date.now(); let done = 0;
    for (const candidate of pending) {
      activity.signal.throwIfAborted();
      try {
        // Measured out of turn while this pass ran (an edit's track): kept as it is.
        const now = measuredNow.get(candidate.file);
        const track = now?.key === candidate.key ? now.track : await probeTrack(candidate, measured, activity.signal);
        next[candidate.file] = { key: candidate.key, track };
        const at = state.tracks.findIndex(t => t.file === candidate.file);
        if (at >= 0) state.tracks[at] = track; else state.tracks.push(track);
      } catch (error) { activity.signal.throwIfAborted(); state.failed++; }
      state.completed++; done++;
      state.etaS = Math.ceil((Date.now() - started) / 1000 / done * (pending.length - done));
      activity.progress(state.completed / state.total * 100, undefined, state.etaS);
      if (done % 10 === 0) await write();
    }
    await write();
  }, { renderLane: 'background' }).catch(() => { state.error = 'Measuring paused. Retry to finish.'; signature = ''; }).finally(() => { state.measuring = false; state.etaS = null; work = undefined; });
}
