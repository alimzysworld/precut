// Keep this rule identical to pipeline/source_audio.py. APAC can be flagged
// default alongside AAC, but ffmpeg reports its codec as unknown/none.
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { tool } from './tools';
import { currentActivity } from './activity';

export interface AudioStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  channels?: number;
  disposition?: { default?: number };
}
export function selectSourceAudio(streams: AudioStream[]): AudioStream | null {
  const playable = streams.filter(s => s.codec_type === 'audio' && !!s.codec_name && !['unknown', 'none'].includes(s.codec_name));
  return playable.find(s => s.disposition?.default) ?? playable[0] ?? null;
}
type Probe = { streams: AudioStream[]; duration: number };
const cache = new Map<string, { stamp: string; value: Promise<Probe> }>();
// OPEN1: a fresh launch probed every source again (one ffprobe each: 56 on the first draw of his edit, 6 to 11 s
// under load), so opening an edit after launch waited on them. What ffprobe says about an unchanged file never
// changes, so answers are kept in the app's data folder, keyed by the same size/mtime/ctime stamp and by the
// ffprobe binary itself. A missing, unreadable or foreign cache file only means probing again.
const DISK_LIMIT = 4000;
let disk: Promise<{ file: string; probe: string; entries: Map<string, { stamp: string; value: Probe }> } | null> | null = null;
let diskTimer: ReturnType<typeof setTimeout> | null = null;
async function diskCache() {
  disk ??= (async () => {
    let folder = process.env.SIDETHING_USER_DATA;
    if (!folder) {
      try {
        const electron = await import("electron") as unknown as { app?: { getPath(name: string): string }; default?: { app?: { getPath(name: string): string } } };
        const app = electron.app ?? electron.default?.app;
        if (app && typeof app.getPath === "function") folder = app.getPath("userData");
      } catch { /* not running under Electron: memory only */ }
    }
    if (!folder) return null;
    const binary = tool('ffprobe'), info = await stat(binary).catch(() => null);
    const probe = `${binary}:${info?.size}:${info?.mtimeMs}`, file = path.join(folder, 'source-probes.json');
    const entries = new Map<string, { stamp: string; value: Probe }>();
    try {
      const saved = JSON.parse(await readFile(file, 'utf8')) as { probe?: string; entries?: [string, string, Probe][] };
      if (saved.probe === probe) for (const [source, stamp, value] of saved.entries ?? []) if (Array.isArray(value?.streams) && Number.isFinite(value?.duration)) entries.set(source, { stamp, value });
    } catch { /* first run or a damaged cache: start empty */ }
    return { file, probe, entries };
  })().catch(() => null);
  return disk;
}
function saveDiskSoon() {
  if (diskTimer) return;
  diskTimer = setTimeout(() => {
    diskTimer = null;
    void diskCache().then(async store => {
      if (!store) return;
      while (store.entries.size > DISK_LIMIT) store.entries.delete(store.entries.keys().next().value!);
      const temporary = `${store.file}.${randomUUID()}.tmp`;
      try {
        await mkdir(path.dirname(store.file), { recursive: true });
        await writeFile(temporary, JSON.stringify({ probe: store.probe, entries: [...store.entries].map(([source, { stamp, value }]) => [source, stamp, value]) }));
        await rename(temporary, store.file);
      } finally { await rm(temporary, { force: true }); }
    }).catch(() => { /* a cache that could not be written is probed again next launch */ });
  }, 1000);
  diskTimer.unref?.();
}
async function probe(file: string) {
  const info = await stat(file), stamp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const hit = cache.get(file);
  if (hit?.stamp === stamp) return hit.value;
  const store = await diskCache(), key = path.resolve(file), known = store?.entries.get(key);
  // The await above can interleave with another reader of the same file: share its probe.
  const again = cache.get(file);
  if (again?.stamp === stamp) return again.value;
  const value: Promise<Probe> = known?.stamp === stamp ? Promise.resolve(structuredClone(known.value)) : promisify(execFile)(tool('ffprobe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    { signal: currentActivity()?.signal, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }).then(({ stdout }) => {
    const data = JSON.parse(stdout);
    const result = { streams: (data.streams ?? []) as AudioStream[], duration: Number(data.format?.duration) || 0 };
    // Only what the readers here use: the audio streams' selection fields and the duration.
    if (store) { store.entries.delete(key); store.entries.set(key, { stamp, value: { duration: result.duration, streams: result.streams.filter(s => s.codec_type === 'audio')
      .map(s => ({ index: s.index, codec_type: s.codec_type, codec_name: s.codec_name, channels: s.channels, disposition: { default: s.disposition?.default } })) } }); saveDiskSoon(); }
    return result;
  });
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(file, { stamp, value });
  void value.catch(() => { if (cache.get(file)?.value === value) cache.delete(file); });
  return value;
}
/** Probe several sources at once (bounded), so a reader that then walks them in order never waits on them one by one. */
export async function prefetchSourceAudio(files: readonly string[], concurrency = 6): Promise<void> {
  const queue = [...new Set(files)];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) await probe(file).catch(() => {});
  }));
}
export async function sourceAudioDuration(file: string): Promise<number> { return (await probe(file)).duration; }
export async function sourceAudio(file: string): Promise<AudioStream | null> {
  return selectSourceAudio((await probe(file)).streams);
}
/** An audio-only ffmpeg input with an explicit map. Silent clips stay silent. */
export async function sourceAudioInput(file: string): Promise<string[]> {
  const data = await probe(file), stream = selectSourceAudio(data.streams);
  return stream ? ['-i', file, '-map', `0:${stream.index}`] :
    ['-f', 'lavfi', '-t', String(Math.max(.001, data.duration)), '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:a:0'];
}
/** Numbering used by editor packages spans all source audio channels. */
export async function sourceAudioChannels(file: string) {
  const { streams } = await probe(file), stream = selectSourceAudio(streams);
  return { stream, firstChannel: stream ? streams.filter(s => s.codec_type === 'audio' && s.index < stream.index).reduce((n, s) => n + (s.channels ?? 0), 1) : 1,
    sources: streams.filter(s => s.codec_type === 'audio').length,
    channels: streams.filter(s => s.codec_type === 'audio').reduce((n, s) => n + (s.channels ?? 0), 0) };
}
/** Resolve source selectors after graph inputs are collected. A missing audio
 * stream gets a bounded silence source, while its picture input stays intact. */
export async function mapSourceAudioGraph(args: string[], filters: string[]): Promise<void> {
  const positions = args.flatMap((arg, i) => arg === '-i' ? [i] : []);
  const graph = filters.join(';'), changes = new Map<number, string>(), silence: string[] = [];
  for (const [n, pos] of positions.entries()) {
    if (!new RegExp(`\\[${n}:a(?::0)?\\]`).test(graph)) continue;
    const file = args[pos + 1], data = await probe(file), stream = selectSourceAudio(data.streams);
    if (stream) changes.set(n, `${n}:${stream.index}`);
    else {
      changes.set(n, `fx2Silent${n}`);
      silence.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${Math.max(.001, data.duration)}[fx2Silent${n}]`);
    }
  }
  for (let i = 0; i < filters.length; i++) filters[i] = filters[i].replace(/\[(\d+):a(?::0)?\]/g,
    (label, n) => changes.has(Number(n)) ? `[${changes.get(Number(n))}]` : label);
  filters.unshift(...silence);
}
