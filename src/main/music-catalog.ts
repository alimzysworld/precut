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
async function refresh(folder: string | null) {
  const entries = folder ? await fs.readdir(folder, { withFileTypes: true }).catch(() => []) : [];
  const files = [...new Set([...(await musicReferences()), ...entries.filter(e => e.isFile()).map(e => path.resolve(folder!, e.name))])].filter(f => AUDIO_FILE.test(f)).sort();
  const candidates: { file: string; key: string; size: number; mtimeMs: number }[] = [];
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
  for (const candidate of candidates) {
    const hit = saved[candidate.file];
    if (hit?.key === candidate.key) { next[candidate.file] = hit; state.tracks.push(hit.track); state.completed++; }
    else pending.push(candidate);
  }
  if (!pending.length) return;
  state.measuring = true;
  const write = async () => {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const temp = `${cachePath}.${process.pid}.tmp`;
    try { await fs.writeFile(temp, JSON.stringify({ version: 1, entries: next })); await fs.rename(temp, cachePath); }
    finally { await fs.unlink(temp).catch(() => {}); }
  };
  // A single cancelable background slot. Listing returns before probes run.
  work = runActivity({ kind: 'render', root: null, target: null, label: 'Measuring music', cancelable: true }, async activity => {
    const started = Date.now(); let done = 0;
    for (const candidate of pending) {
      activity.signal.throwIfAborted();
      try {
        const { stdout } = await promisify(execFile)(tool('ffprobe'), ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index:stream_tags:format=duration:format_tags', '-of', 'json', candidate.file], { signal: activity.signal, timeout: 30_000, maxBuffer: 1024 * 1024 });
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
        const track: LibraryTrack = { file: candidate.file, name: path.basename(candidate.file, path.extname(candidate.file)), durationS, bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null, tags, ...(Number.isFinite(analysis?.integratedLUFS) ? { integratedLUFS: analysis!.integratedLUFS } : {}) };
        next[candidate.file] = { key: candidate.key, track }; state.tracks.push(track);
      } catch (error) { activity.signal.throwIfAborted(); state.failed++; }
      state.completed++; done++;
      state.etaS = Math.ceil((Date.now() - started) / 1000 / done * (pending.length - done));
      activity.progress(state.completed / state.total * 100, undefined, state.etaS);
      if (done % 10 === 0) await write();
    }
    await write();
  }, { renderLane: 'background' }).catch(() => { state.error = 'Measuring paused. Retry to finish.'; signature = ''; }).finally(() => { state.measuring = false; state.etaS = null; work = undefined; });
}
