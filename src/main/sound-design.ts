import { sourceAudioInput } from './source-audio';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { app } from 'electron';
import type { Api, CutEdit, CutVersion, SfxItem, SoundRole } from '../shared/schema';
import { validMusicShape } from '../shared/music-shape';
import { laneDb } from '../shared/lane-levels';
import type { StoredVersion } from './sidekick';
import type { FxPlan } from './edits-fx';
import type { CaptionTrack } from './titles/captions';
import { planFx, mapTime } from './edits-fx';
import { currentActivity, runActivity } from './activity';
import { soundDuration, soundEvents, synthSound } from './sfx';
import { measureLoudness } from './audio';
import { sourceIdentity } from './voice-isolation';
import { tool } from './tools';

const kinds = ['whoosh', 'hit', 'pop', 'riser', 'impact', 'ambience', 'roomtone', 'ui', 'other'];
const synthKinds = ['whoosh', 'hit', 'pop', 'riser', 'impact'] as const;
type LibrarySound = { id: string; name: string; kind: SfxItem['kind']; lengthS: number; file: string; role?: SoundRole; hitS?: number; punchDb?: number };
const roles: SoundRole[] = ['hit', 'accent', 'ui', 'ambience'];
/** PRO3a: each role's level against the edit's voice: the sound's loudest 50 ms (RMS dBFS) minus the voice's integrated
 * loudness (LUFS) as it plays in the mix. The launch video's 109 cues, measured the same way against its lead (music 0.6,
 * -14.4 LUFS), put hits at a median -2.4 dB, accents -13.0, UI -26.3. On a real talking-head edit a thud at +5.6
 * was about 3 dB hot over "back" and wanted 3 to 4 dB less (PRO0), so a hit sits at -1: under the words, not lost.
 * Ambience is a bed 20 dB under the voice. gainDb trims around it: 0 = the role's level. Evidence: qa/PRO3a/measurements.json. */
export const ROLE_LEVEL_DB: Record<SoundRole, number> = { hit: -1, accent: -13, ui: -26, ambience: -20 };
/** Measured once per file: the loudest 50 ms and where the sound lands (the onset of its loudest moment). */
export type SoundShape = { punchDb: number; hitS: number };
export function measureSoundShape(stereo: Float32Array, rate = 48000): SoundShape {
  const frames = Math.floor(stereo.length / 2), energy = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) energy[i + 1] = energy[i] + (stereo[2 * i] ** 2 + stereo[2 * i + 1] ** 2) / 2;
  const rms = (centre: number, width: number) => { const a = Math.max(0, centre - (width >> 1)), b = Math.min(frames, a + width); return b > a ? Math.sqrt((energy[b] - energy[a]) / (b - a)) : 0; };
  const hop = Math.round(rate / 1000), short = Math.round(rate * .01), long = Math.round(rate * .05);
  let punch = 0, peak = 0, at = 0;
  for (let i = 0; i < frames; i += hop) { punch = Math.max(punch, rms(i, long)); const v = rms(i, short); if (v > peak) { peak = v; at = i; } }
  // Walk back from the loudest 10 ms while it stays within 3 dB: a slam lands on its attack, a whoosh on its swell.
  while (at - hop >= 0 && rms(at - hop, short) >= peak / Math.SQRT2) at -= hop;
  return { punchDb: Math.round(2000 * Math.log10(Math.max(punch, 1e-9))) / 100, hitS: Math.round(at / rate * 1000) / 1000 };
}
const shapes = new Map<string, Promise<SoundShape>>();
/** The manifest's measurement for a bundled sound; one decode for anything else (cached per file identity). */
export async function soundShape(root: string, id: string): Promise<SoundShape> {
  const library = id.startsWith('lib:') ? (await libraryFiles([], false)).find(s => s.id === id) : undefined;
  if (library?.punchDb !== undefined && library.hitS !== undefined) return { punchDb: library.punchDb, hitS: library.hitS };
  const file = library?.file || (id.startsWith('lib:synth-') ? await synthSound(id.slice('lib:synth-'.length) as typeof synthKinds[number]) : await resolveSound(root, id));
  const key = hash(await sourceIdentity(file));
  if (!shapes.has(key)) {
    const pending = execute(tool('ffmpeg'), ['-v', 'error', '-nostdin', ...await sourceAudioInput(file), '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, signal: currentActivity()?.signal })
      .then(({ stdout }) => measureSoundShape(new Float32Array(stdout.buffer, stdout.byteOffset, stdout.length >> 2)));
    shapes.set(key, pending); void pending.catch(() => shapes.delete(key));
  }
  return shapes.get(key)!;
}
/** The voice's integrated loudness as it plays in this edit's mix, before the master: what a role level is set against.
 * Auto (or Even out voices) levels every voice to -20 LUFS; otherwise the narration takes, or the cut's camera voice, are
 * measured (on a real edit the raw take reads within 1 LU of the voice in the finished mix). The voice or clip-sound
 * lane moves it with the voice. */
export async function voiceReferenceDb(version: Pick<CutVersion, 'audio' | 'voiceover' | 'laneLevels'> & { assembly?: Pick<StoredVersion['assembly'], 'reel'> }, root: string): Promise<number> {
  const takes = [...new Set((version.voiceover?.lines ?? []).flatMap(l => l.take ? [path.resolve(root, l.take.file)] : []))];
  const lane = laneDb(version, takes.length ? 'voice' : 'clip-sound');
  if (version.audio?.auto !== false || version.audio?.evenOutVoices === true) return -20 + lane;
  if (!takes.length) return (version.assembly?.reel.voiceLUFS ?? -20) + lane;
  const levels = (await Promise.all(takes.map(f => soundLevel(f).catch(() => null)))).flatMap(m => m && m.input_i > -70 ? [m.input_i] : []);
  return (levels.length ? 10 * Math.log10(levels.reduce((sum, l) => sum + 10 ** (l / 10), 0) / levels.length) : -20) + lane;
}
/** PRO3a: where a sound starts so its measured hit lands at landAtS. */
export async function placeByLanding(root: string, file: string, landAtS: number): Promise<number> {
  if (!Number.isFinite(landAtS) || landAtS < 0) throw new Error('Give landAtS as edit seconds.');
  const atS = Math.round((landAtS - (await soundShape(root, file)).hitS) * 1e6) / 1e6;
  if (atS < 0) throw new Error(`That sound needs ${(landAtS - atS).toFixed(3)} s before its hit; land it later than ${(landAtS - atS).toFixed(3)} s.`);
  return atS;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const execute = promisify(execFile);
function sfxDirectory() {
  return app.isPackaged ? path.join(process.resourcesPath, 'sfx') : path.join(app.getAppPath(), 'resources/sfx');
}
async function shootRoots(): Promise<string[]> {
  try {
    const roots = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'shoots.json'), 'utf8'));
    return Array.isArray(roots) ? roots.flatMap(r => typeof r?.root === 'string' ? [path.resolve(r.root)] : []) : [];
  } catch { return []; }
}
async function safeSoundCache(root: string): Promise<string> {
  const realRoot = await fs.realpath(root), side = path.join(realRoot, '.sidething'), directory = path.join(side, 'sfx');
  await fs.mkdir(side, { recursive: true });
  if (await fs.realpath(side) !== side) throw new Error('The sound cache cannot follow a shoot cache symlink.');
  await fs.mkdir(directory, { recursive: true });
  if (await fs.realpath(directory) !== directory) throw new Error('The sound cache must stay inside this shoot.');
  return directory;
}
/** Only catalogue entries and files in the shoot's sound cache are playable. */
export async function resolveSound(root: string, id: string): Promise<string> {
  if (typeof id !== 'string') throw new Error('Choose a sound from the library.');
  if (id.startsWith('lib:')) {
    const found = (await libraryFiles([])).find(s => s.id === id);
    if (!found) throw new Error('That sound is not in the library.');
    return found.file;
  }
  const directory = await fs.realpath(path.join(root, '.sidething/sfx'));
  const realRoot = await fs.realpath(root);
  if (!directory.startsWith(realRoot + path.sep + '.sidething' + path.sep)) throw new Error('The sound cache must stay inside this shoot.');
  const file = await fs.realpath(path.resolve(root, id));
  if (!file.startsWith(directory + path.sep) || !['.wav', '.ogg', '.mp3', '.m4a', '.flac'].includes(path.extname(file).toLowerCase()) || !(await fs.stat(file)).isFile()) throw new Error('Choose a sound in this shoot’s sound library.');
  return file;
}
export async function libraryFiles(roots?: string[], prepare = true): Promise<LibrarySound[]> {
  const directory = sfxDirectory();
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const result: LibrarySound[] = manifest.sounds.map((s: LibrarySound) => ({ ...s, file: path.join(directory, s.file) }));
  for (const kind of synthKinds) result.push({ id: `lib:synth-${kind}`, name: `soft ${kind}`, kind, lengthS: soundDuration[kind], file: prepare ? await synthSound(kind) : '' });
  for (const root of roots ?? await shootRoots()) {
    const cache = path.join(root, '.sidething/sfx');
    for (const name of await fs.readdir(cache).catch(() => [])) {
      if (!/\.(wav|ogg|mp3|m4a|flac)$/i.test(name) || name.startsWith('.')) continue;
      let file: string;
      try { file = await resolveSound(root, path.join(cache, name)); } catch { continue; }
      const meta = await fs.readFile(`${file}.json`, 'utf8').then(JSON.parse).catch(() => ({}));
      const probe = await execute(tool('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { signal: currentActivity()?.signal });
      result.push({ id: file, file, name: meta.name ?? meta.prompt ?? path.basename(name, path.extname(name)), kind: name.startsWith('roomtone-') ? 'roomtone' : meta.kind && kinds.includes(meta.kind) ? meta.kind : 'other', lengthS: Number(probe.stdout) });
    }
  }
  return result;
}
export async function soundLibrary(): ReturnType<Api['soundLibrary']> {
  return (await libraryFiles()).map(({ file: _file, punchDb: _punch, ...s }) => ({ ...s, url: `st-media://local/sounds/${encodeURIComponent(s.id)}` }));
}
export function validateSfx(item: SfxItem, duration: number): SfxItem {
  if (!item || typeof item.file !== 'string' || !item.file || typeof item.name !== 'string' || !item.name.trim() ||
    !kinds.includes(item.kind) || !Number.isFinite(item.atS) || item.atS < 0 || item.atS >= duration ||
    !Number.isFinite(item.gainDb) || item.gainDb < -24 || item.gainDb > 6 ||
    (item.lengthS !== undefined && (!Number.isFinite(item.lengthS) || item.lengthS <= 0 || item.lengthS > duration - item.atS + 1e-6)) ||
    (item.reason !== undefined && typeof item.reason !== 'string') || (item.role !== undefined && !roles.includes(item.role))) throw new Error('Choose a sound, a time inside the edit, gain from -24 to 6 dB and a role of hit, accent, ui or ambience.');
  return { id: item.id, file: item.file, name: item.name.trim(), atS: item.atS, gainDb: item.gainDb, kind: item.kind, auto: item.auto,
    ...(item.lengthS === undefined ? {} : { lengthS: item.lengthS }), ...(item.reason === undefined ? {} : { reason: item.reason }), ...(item.role === undefined ? {} : { role: item.role }) };
}

/** Bounded-memory local scan. Reject transcript speech, clipped and digitally silent windows. */
async function quietWindow(file: string, words: { s: number; e: number }[], offset: number): Promise<{ start: number; rms: number } | null> {
  const child = spawn(tool('ffmpeg'), ['-v', 'error', '-nostdin', ...await sourceAudioInput(file), '-vn', '-af', 'highpass=f=80,lowpass=f=6000', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], { signal: currentActivity()?.signal, killSignal: 'SIGKILL' });
  let pending = Buffer.alloc(0), window = 0, best: { start: number; rms: number } | null = null, error = '';
  child.stderr.on('data', b => { error = (error + b).slice(-2000); });
  const done = new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(error || 'Could not measure room tone.'))); });
  // Attach a rejection handler immediately while consuming stdout.
  void done.catch(() => {});
  try {
    for await (const data of child.stdout) {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 48000) { // 0.75 s at 16 kHz, float32
        const block = pending.subarray(0, 48000), start = window++ * .75;
        if (!words.some(w => w.s + offset < start + .87 && w.e + offset > start - .12)) {
          let energy = 0, peak = 0;
          for (let i = 0; i < block.length; i += 4) { const v = block.readFloatLE(i); energy += v * v; peak = Math.max(peak, Math.abs(v)); }
          const rms = Math.sqrt(energy / 12000);
          if (rms > 1e-7 && peak < .5 && peak / rms < 10 && (!best || rms < best.rms)) best = { start, rms };
        }
        pending = pending.subarray(48000);
      }
    }
    await done;
    return best;
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
}
/** Periodic overlap loop, DC removed and matched to the measured noise floor. */
export function roomLoop(source: Float32Array): Float32Array {
  const fade = Math.min(5760, Math.floor(source.length / 4)), count = source.length - fade;
  if (fade < 2) throw new Error('Room tone needs a longer clean stretch.');
  const result = new Float32Array(count);
  result.set(source.subarray(fade, count));
  for (let i = 0; i < fade; i++) {
    const w = .5 - .5 * Math.cos(Math.PI * i / (fade - 1));
    result[count - fade + i] = source[count + i] * (1 - w) + source[i] * w;
  }
  const mean = result.reduce((sum, x) => sum + x, 0) / count;
  for (let i = 0; i < count; i++) result[i] -= mean;
  const rms = Math.sqrt(result.reduce((sum, x) => sum + x * x, 0) / count);
  const target = Math.min(10 ** (-42 / 20), Math.max(10 ** (-58 / 20), rms));
  for (let i = 0; i < count; i++) result[i] *= target / Math.max(rms, 1e-12);
  return result;
}
function floatWav(samples: Float32Array): Buffer {
  const b = Buffer.alloc(44 + samples.length * 4);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(48000, 24); b.writeUInt32LE(192000, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 4, 40);
  samples.forEach((value, i) => b.writeFloatLE(value, 44 + i * 4)); return b;
}
const rooms = new Map<string, Promise<string | null>>();
export async function roomTone(root: string, record: Pick<StoredVersion, 'assembly'>): Promise<string | null> {
  const candidates: { file: string; words: { s: number; e: number }[]; offset: number; identity: Awaited<ReturnType<typeof sourceIdentity>> }[] = [];
  for (const clip of record.assembly.shoot.clips) {
    if (!clip.sound && !(clip.meta?.audioChannels ?? 0)) continue;
    const file = path.resolve(root, clip.sound?.file ?? clip.file);
    const words = clip.transcript?.flatMap(s => s.words ?? []) ?? [];
    const offset = clip.sound?.offsetS ?? 0;
    const aligned = words.map(w => ({ s: w.s + offset, e: w.e + offset }));
    const existing = candidates.find(c => c.file === file);
    if (existing) { existing.words.push(...aligned); continue; }
    try { candidates.push({ file, words: aligned, offset: 0, identity: await sourceIdentity(file) }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const key = hash({ revision: 3, candidates }), directory = path.join(root, '.sidething/sfx'), output = path.join(directory, `roomtone-${key}.wav`);
  if (await fs.stat(output).then(s => s.size > 44).catch(() => false)) return output;
  if (await fs.readFile(`${output}.missing.json`, 'utf8').then(() => true).catch(() => false)) return null;
  if (rooms.has(output)) return rooms.get(output)!;
  const work = runActivity({ kind: 'render', root, target: null, label: 'Finding clean room tone', cancelable: true }, async activity => {
    let best: { file: string; start: number; rms: number } | null = null;
    for (const [i, c] of candidates.entries()) {
      const quiet = await quietWindow(c.file, c.words, c.offset);
      if (quiet && (!best || quiet.rms < best.rms)) best = { file: c.file, ...quiet };
      activity.progress(100 * (i + 1) / candidates.length);
    }
    if (!best) {
      activity.signal.throwIfAborted();
      await safeSoundCache(root);
      await fs.writeFile(`${output}.missing.json`, JSON.stringify({ reason: 'No clean non-silent stretch outside speech.' }));
      return null; // Never loop speech or invent the shoot's ambience.
    }
    const { stdout } = await execute(tool('ffmpeg'), ['-v', 'error', '-nostdin', '-ss', `${best.start}`, '-t', '0.75', ...await sourceAudioInput(best.file), '-vn', '-af', 'highpass=f=80,lowpass=f=6000', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024, signal: activity.signal });
    const samples = Float32Array.from({ length: stdout.length / 4 }, (_, i) => stdout.readFloatLE(i * 4));
    await safeSoundCache(root);
    const temp = `${output}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, floatWav(roomLoop(samples))); activity.signal.throwIfAborted(); await fs.rename(temp, output);
      await fs.writeFile(`${output}.json`, JSON.stringify({ name: 'Room tone from your shoot', kind: 'roomtone', source: best, loopS: (samples.length - Math.min(5760, Math.floor(samples.length / 4))) / 48000 }));
    } finally { await fs.rm(temp, { force: true }); }
    return output;
  }, { renderLane: 'background' });
  rooms.set(output, work);
  try { return await work; } finally { rooms.delete(output); }
}

/** Pure placement. Stable ids suppress duplicates when the person has moved a sound. */
export function autoSounds(version: CutVersion, plan: FxPlan, room: string | null, authored?: SfxItem[], suppressed: string[] = []): SfxItem[] {
  const manual = (version.sfx ?? []).filter(s => !s.auto), placed: SfxItem[] = [];
  const add = (id: string, item: Omit<SfxItem, 'id' | 'auto'>) => {
    if (!suppressed.includes(id) && !manual.some(s => s.id === id) && item.atS < plan.durationS) placed.push({ ...item, id, auto: true });
  };
  if (room && version.audio?.design === false) for (const [index, bleep] of (version.bleeps ?? []).entries()) {
    if (bleep.sound !== 'mute') continue;
    plan.items.forEach((item, i) => {
      const s = Math.max(bleep.s, item.timeMap[0].s), e = Math.min(bleep.e, item.timeMap.at(-1)!.s);
      if (item.piece !== bleep.piece || e <= s || item.reverse) return;
      const atS = mapTime(item.timeMap, s), end = mapTime(item.timeMap, e);
      add(`auto:bleep-roomtone-${index}-${i}`, { file: room, name: 'Room tone', kind: 'roomtone', atS, lengthS: end - atS, gainDb: -12, reason: 'Room tone keeps muted words in the same room.' });
    });
  }
  if (version.audio?.design !== false) {
    if (room) add('auto:roomtone', { file: room, name: 'Room tone', kind: 'roomtone', atS: 0, lengthS: plan.durationS, gainDb: -12, reason: 'The quietest clean stretch of your shoot keeps cuts and gaps in the same room.' });
    if (authored) authored.filter(s => s.kind !== 'roomtone').forEach(s => add(s.id, s));
    else {
      plan.joins.forEach((j, i) => {
        const sound = j.choice.sound ?? (j.auto && !version.transition && (j.choice.kind === 'whip' || j.choice.kind === 'zoom') ? 'whoosh' : null);
        if (sound) add(`auto:join:${i}`, { file: `lib:synth-${sound}`, name: sound, kind: sound, atS: j.atS, gainDb: -12, reason: `Follows the ${j.choice.kind} transition.` });
      });
      const track = version.titles as CaptionTrack | undefined;
      const lines = track?.kinetic?.lines ?? [];
      const starts = [...new Set([...lines.filter(l => track?.captionStyle?.hook !== 'off' && !version.bigLines?.some(b => b.s === l.s && !b.big) && (l.hook || track?.captionStyle?.hook === 'all' || version.bigLines?.some(b => b.s === l.s && b.big))).map(l => l.s), ...(version.bigLines ?? []).filter(l => l.big).map(l => l.s)])];
      starts.sort((a, b) => a - b).forEach((s, i) => add(`auto:caption:${i}`, { file: 'lib:synth-pop', name: 'Caption pop', kind: 'pop', atS: s, gainDb: -12, reason: 'Marks the landing of a big caption line.' }));
    }
  }
  return [...manual, ...placed].sort((a, b) => a.atS - b.atS || a.id.localeCompare(b.id));
}
export async function refreshSoundDesign(root: string, record: StoredVersion, authored?: SfxItem[]): Promise<void> {
  if (record.voiceMixNeedsMeasure && record.assembly.reel.music) {
    const { measureReelVoice } = await import('./reel');
    const voiceLUFS = await measureReelVoice(root, record.assembly.cutList.filter(c => c.seg?.lineIndex !== null), record.assembly.template);
    record.assembly.reel.voiceLUFS = voiceLUFS;
    if (voiceLUFS !== null) {
      const gainDb = Math.round((voiceLUFS - 15 - record.assembly.reel.music.musicLUFS) * 100) / 100;
      record.assembly.reel.music.gainDb = gainDb;
      if (record.music) record.music = { ...record.music, gainDb };
    }
  }

  delete record.voiceMixNeedsMeasure;
  const plan = planFx(record.assembly.cutList, record.assembly.template.fps, record);
  const room = (record.audio?.design === false && !record.bleeps?.some(b => b.sound === 'mute')) || !plan.durationS ? null : await roomTone(root, record);
  const wanted = authored ?? record.soundDesign?.authored;
  const valid: SfxItem[] = [];
  for (const item of wanted ?? []) {
    if (record.audio?.design === false || record.soundDesign?.suppressed?.includes(item.id) || record.sfx?.some(s => s.id === item.id && !s.auto)) continue;
    try {
      if (item.file.startsWith('generate:')) {
        const prompt = item.file.slice('generate:'.length).trim();
        const found = (await libraryFiles([root], false)).find(sound => sound.name.toLowerCase() === prompt.toLowerCase());
        if (found) valid.push({ ...item, file: found.id });
        else {
          const { soundKey, generateSoundForEdit } = await import('./sound-gen');
          if (!(await soundKey('status')).elevenlabs) {
            record.warnings = [...(record.warnings ?? []), `Skipped ${item.name}: connect ElevenLabs to make this sound.`];
            continue;
          }
          const seconds = Math.max(.5, Math.min(30, item.lengthS ?? 2));
          const sound = await generateSoundForEdit(root, prompt, seconds, `${record.createdAt}:${record.version}`);
          valid.push({ ...item, file: sound.file, name: sound.name });
        }
      } else { await resolveSound(root, item.file); valid.push(item); }
    }
    catch (error) { record.warnings = [...(record.warnings ?? []), `Skipped ${item.name}: ${item.file.startsWith('generate:') && error instanceof Error ? error.message : 'that sound is not in the library.'}`]; }
  }
  record.sfx = autoSounds(record, plan, room, wanted === undefined ? undefined : valid, record.soundDesign?.suppressed);
  const warning = 'Room tone needs a clean non-silent stretch in your shoot. No room tone was added.';
  record.warnings = (record.warnings ?? []).filter(w => w !== warning);
  if (!room && record.audio?.design !== false && plan.durationS) record.warnings.push(warning);
}
const levels = new Map<string, Promise<Awaited<ReturnType<typeof measureLoudness>>>>();
async function soundLevel(file: string) {
  const key = hash(await sourceIdentity(file));
  if (!levels.has(key)) {
    const pending = runActivity({ kind: 'render', root: null, target: null, label: 'Measuring sound level', cancelable: true }, () => measureLoudness(file), { renderLane: 'background' });
    levels.set(key, pending); void pending.catch(() => levels.delete(key));
  }
  return levels.get(key)!;
}
export type PreparedEffect = { id?: string; atS: number; file: string; sound?: import('../shared/schema').TransitionSound; lengthS?: number; gainDb?: number; normalizeDb?: number; loopSamples?: number; bed?: boolean };
export async function prepareDesignSounds(root: string, plan: FxPlan, version: Pick<CutVersion, 'sfx' | 'audio' | 'overlays'> & Partial<Pick<CutVersion, 'voiceover' | 'laneLevels'>> & { assembly?: Pick<StoredVersion['assembly'], 'reel'> }): Promise<PreparedEffect[]> {
  const items = version.sfx ?? [];
  // PRO3a: a sound with a role sits at that role's level against this edit's voice, whatever its file's loudness.
  const voice = items.some(s => s.role) ? await voiceReferenceDb(version, root) : 0;
  // A saved auto pass owns join sounds. Overlays always retain their own sound.
  const events = soundEvents(version.sfx !== undefined ? { ...plan, joins: [] } : plan, version);
  const output: PreparedEffect[] = [];
  for (const event of events) output.push({ ...event, file: await synthSound(event.sound) });
  for (const item of items) {
    if (item.atS >= plan.durationS || item.atS < 0) continue;
    if (item.auto && version.audio?.design === false) continue;
    const file = await resolveSound(root, item.file), bed = item.kind === 'roomtone' || item.kind === 'ambience';
    const level = bed || item.role ? null : await soundLevel(file);
    const roleDb = item.role ? ROLE_LEVEL_DB[item.role] + voice - (await soundShape(root, item.file)).punchDb : undefined;
    let loopSamples: number | undefined;
    if (bed && item.lengthS) {
      const probe = await execute(tool('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { signal: currentActivity()?.signal });
      loopSamples = Math.round(Number(probe.stdout) * 48000);
    }
    output.push({ id:item.id, atS: item.atS, file, lengthS: Math.min(item.lengthS ?? plan.durationS, plan.durationS - item.atS), gainDb: item.gainDb, normalizeDb: roleDb !== undefined ? Math.round(Math.max(-60, Math.min(24, roleDb)) * 100) / 100 : level ? Math.max(-24, Math.min(24, -22 - level.input_i)) : 0, loopSamples, bed });
  }
  return output;
}
export function editSounds(root: string, cutId: string, version: number, edit: Extract<CutEdit, { kind: 'sfx' }>) {
  return runActivity({ kind: 'edit', root, target: { cutId, version }, label: 'Updating sounds', cancelable: true }, async () => {
    if (!['add', 'update', 'remove', 'musicShape'].includes(edit.op)) throw new Error('Choose add, update or remove for a sound, or musicShape.');
    const { finishStoredVersion, renderStoredPreview } = await import('./sidekick');
    return finishStoredVersion(root, cutId, version, true, async (record, assembly) => {
      const duration = planFx(assembly.cutList, assembly.template.fps, record).durationS, items = [...(record.sfx ?? [])];
      if (edit.op === 'musicShape') {
        // PRO3a: the music's stillnesses and hit dips live on the music, so every mix that reads the music reads them.
        const music = record.music !== undefined ? record.music : assembly.reel.music ? { file: assembly.reel.music.file, startS: assembly.reel.music.startS, gainDb: assembly.reel.music.gainDb,
          ...(assembly.reel.music.endS === undefined ? {} : { endS: assembly.reel.music.endS }), ...(assembly.reel.music.fit ? { fit: true } : {}), ...(assembly.reel.music.followStory ? { followStory: true } : {}) } : null;
        if (!music) throw new Error('This edit has no music to shape. Add music first.');
        const shape = edit.shape === null ? [] : validMusicShape(edit.shape, duration);
        const { shape: _old, ...rest } = music;
        record.music = shape.length ? { ...rest, shape } : rest;
        record.assembly = assembly;
        await renderStoredPreview(root, cutId, record, assembly);
        return { cutId, version: record.version };
      }
      const index = edit.op === 'add' ? -1 : items.findIndex(s => s.id === edit.id);
      if (edit.op !== 'add' && index < 0) throw new Error('That sound is no longer in this edit.');
      if (edit.op === 'add' || edit.op === 'update') {
        const { landAtS, ...given } = edit.op === 'add' ? edit.item : edit.patch;
        const merged = edit.op === 'add' ? { ...given, id: randomUUID(), auto: false } as SfxItem : { ...items[index], ...given, id: items[index].id, auto: false };
        if (landAtS !== undefined) { await resolveSound(root, merged.file); merged.atS = await placeByLanding(root, merged.file, landAtS); }
        const item = validateSfx(merged, duration);
        await resolveSound(root, item.file);
        if (edit.op === 'add') items.push(item); else items[index] = item;
      } else {
        if (items[index].id.startsWith('auto:')) record.soundDesign = { ...record.soundDesign, suppressed: [...(record.soundDesign?.suppressed ?? []), items[index].id] };
        items.splice(index, 1);
      }
      record.sfx = items; record.assembly = assembly;
      await renderStoredPreview(root, cutId, record, assembly);
      return { cutId, version: record.version };
    });
  });
}
