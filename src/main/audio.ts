import { cleanClipSound } from './stem-mix';
import type { ClipSoundClean } from '../shared/schema';
import { MUSIC_DUCK } from '../shared/music-duck';
import { sourceAudio, sourceAudioInput } from './source-audio';
export { audioSpan, joinAudioMix } from './join-audio';
import { tool } from "./tools";
// Fixed, local DSP. Only the complete cut gets loudness normalisation.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AudioFinish } from "../shared/schema";
import { currentActivity, runActivity } from "./activity";
import { audioCacheDir, isolateVoiceTake, localAudioProcess, measureSourceAudio, sourceIdentity } from "./voice-isolation";
import { breathWords, cleanupBreaths, BREATH_CLEANUP_REASON } from "./breaths";

export const DEFAULT_AUDIO_FINISH: AudioFinish = { clean: true, denoise: 0.6, loudnessLUFS: -14, auto: true, breaths: true, design: true };
/** Shared by the audible mix and editor automation's sidechain probe. */
export function duckingFilter(bus: 'music' | 'effects'): string {
  return bus === 'music'
    ? `sidechaincompress=threshold=0.025:ratio=8:attack=${MUSIC_DUCK.attackS*1000}:release=${MUSIC_DUCK.releaseS*1000}:makeup=1:mix=${1-10**(-MUSIC_DUCK.speechDb/20)}`
    : 'sidechaincompress=threshold=0.025:ratio=6:attack=10:release=250:makeup=1';
}
const exec = promisify(execFile);
const CACHE_REV = 1;
const jobs = new Map<string, Promise<string>>();

function modelFile(): string {
  // Match pipeline resources: extraResources in a packaged app, repo in dev.
  const relative = "pipeline/models/sh.rnnn";
  const candidates = [
    ...(process.resourcesPath ? [path.join(process.resourcesPath, relative)] : []),
    ...(typeof __dirname === "string" ? [path.resolve(__dirname, "../..", relative)] : []),
    path.resolve(relative),
  ];
  const file = candidates.find(existsSync);
  if (!file) throw new Error("The bundled voice cleanup model is missing: pipeline/models/sh.rnnn.");
  return file;
}

// FFmpeg parses a filtergraph, then each filter's options. Escape both layers;
// execFile passes this directly, so there is no shell quoting involved.
function filterValue(value: string): string {
  return value.replace(/[\\':]/g, "\\$&").replace(/[\\'\[\],;]/g, "\\$&");
}

/** The -af chain for one voice piece; "" = leave the voice as it is. */
export function normalizeAudio(finish: AudioFinish): AudioFinish {
  const result = { ...finish };
  if (result.evenOutVoices !== undefined && typeof result.evenOutVoices !== "boolean") throw new Error("Choose whether to even out voices.");
  if (result.design !== undefined && typeof result.design !== "boolean") throw new Error("Choose whether sound design is on or off.");
  if (result.breaths !== undefined && typeof result.breaths !== "boolean") throw new Error("Choose whether breath cleanup is on or off.");
  if (result.auto !== undefined && typeof result.auto !== "boolean") throw new Error("Choose whether Auto mix is on or off.");
  if (result.clean && !Number.isFinite(result.denoise)) throw new Error("Voice denoise strength must be finite.");
  if (result.eq) {
    if (![result.eq.low, result.eq.mid, result.eq.high].every(n => Number.isFinite(n) && n >= -6 && n <= 6)) throw new Error("Voice EQ must be between -6 and +6 dB.");
    if (!result.eq.low && !result.eq.mid && !result.eq.high) delete result.eq;
  }
  return result;
}
export function voiceFilter(finish: AudioFinish, isolated = false): string {
  finish = normalizeAudio(finish);
  const filters: string[] = [];
  if (finish.clean) {
    if (!Number.isFinite(finish.denoise)) throw new Error("Voice denoise strength must be finite.");
    const mix = Math.max(0, Math.min(1, finish.denoise));
    filters.push(`highpass=f=80,${isolated ? "" : `arnndn=m=${filterValue(modelFile())}:mix=${mix},`}` +
      "deesser=i=0.15:m=0.3:f=0.5,acompressor=threshold=0.125:ratio=2:attack=30:release=250:makeup=1");
  }
  if (finish.eq?.low) filters.push(`bass=g=${finish.eq.low}:f=120:t=q:w=0.707`);
  if (finish.eq?.mid) filters.push(`equalizer=f=2500:t=q:w=1:g=${finish.eq.mid}`);
  if (finish.eq?.high) filters.push(`treble=g=${finish.eq.high}:f=8000:t=q:w=0.707`);
  // Some cleanup filters emit NaN in their final partial frame. PCM encoding
  // hides it, but a float sidechain detector stays poisoned for the whole cut.
  if (finish.clean) filters.push("aeval=exprs='if(isnan(val(ch))+isinf(val(ch)),0,val(ch))':c=same");
  return filters.join(",");
}

function targetFor(finish: AudioFinish): string {
  const value = finish.loudnessLUFS;
  if (!Number.isFinite(value) || value < -70 || value > -5) {
    throw new Error("Loudness target must be between -70 and -5 LUFS.");
  }
  return `loudnorm=I=${value}:TP=-1.5:LRA=11`;
}

export interface LoudnessMeasurement {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

async function ffmpeg(args: string[]): Promise<string> {
  return localAudioProcess(tool("ffmpeg"), ["-hide_banner", "-nostdin", "-nostats", ...args]);
}

/** Pass one, on the entire assembled mix. null means no measurable loudness. */
export async function measureLoudness(input: string, finish: AudioFinish = DEFAULT_AUDIO_FINISH,
  span?: { start: number; duration: number; filter: string }): Promise<LoudnessMeasurement | null> {
  const stderr = await ffmpeg([...(span ? ["-ss", `${span.start}`, "-t", `${span.duration}`] : []), ...await sourceAudioInput(path.resolve(input)), "-vn", "-af",
    `${span?.filter ? span.filter + "," : ""}${targetFor(finish)}:print_format=json`, "-f", "null", "-"]);
  const report = JSON.parse(stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1)) as Record<string, string>;
  if (report.input_i === "-inf") return null;
  const measurement = Object.fromEntries(["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]
    .map(key => [key, report[key] === undefined ? NaN : Number(report[key])])) as unknown as LoudnessMeasurement;
  if (!Object.values(measurement).every(Number.isFinite)) throw new Error("FFmpeg returned an invalid loudness measurement.");
  return measurement;
}

/** Pass two. Use the same target as pass one; never normalise individual spans. */
export function loudnessFilter(measured: LoudnessMeasurement | null, finish: AudioFinish = DEFAULT_AUDIO_FINISH): string {
  const target = targetFor(finish);
  if (!measured) return "anull"; // loudnorm can generate invalid samples for silence.
  if (!Object.values(measured).every(Number.isFinite)) throw new Error("Invalid loudness measurement.");
  return `${target}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
    `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}` +
    `:offset=${measured.target_offset}:linear=true`;
}

async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

let engine: Promise<string> | undefined;
function engineVersion(): Promise<string> {
  return engine ??= exec(tool("ffmpeg"), ["-version"], { timeout: 10_000 }).then(({ stdout }) => stdout);
}

// Serialise writes to the same destination without sharing stale work when its
// input/settings change. Atomic replacement keeps failed renders out of cache.
function serial(output: string, render: () => Promise<string>): Promise<string> {
  const previous = jobs.get(output) ?? Promise.resolve("");
  const job = previous.catch(() => "").then(render);
  jobs.set(output, job);
  void job.finally(() => { if (jobs.get(output) === job) jobs.delete(output); }).catch(() => {});
  return job;
}

async function renderCached(input: string, output: string, settings: () => Promise<unknown>,
  render: (temporary: string) => Promise<void>): Promise<string> {
  output = path.resolve(output);
  return serial(output, async () => {
    input = await fs.realpath(input);
    let existing: string | undefined;
    try { existing = await fs.realpath(output); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (input === output || input === existing) throw new Error("Audio output must differ from its source.");
    const sourceHash = await digest(input);
    const key = createHash("sha256").update(JSON.stringify({ revision: CACHE_REV, input, sourceHash,
      settings: await settings(), engine: await engineVersion() })).digest("hex");
    const cache = `${output}.audio-cache.json`;
    try {
      const hit = JSON.parse(await fs.readFile(cache, "utf8")) as { key: string; outputHash: string };
      if (hit.key === key && hit.outputHash === await digest(output)) return output;
    } catch { /* No valid cache: render again. */ }
    await fs.mkdir(path.dirname(output), { recursive: true });
    const token = randomUUID();
    const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${token}.tmp${path.extname(output)}`);
    const manifest = `${cache}.${token}.tmp`;
    try {
      await render(temporary);
      if (await digest(input) !== sourceHash) throw new Error("Audio source changed during rendering. Please retry.");
      const outputHash = await digest(temporary);
      await fs.writeFile(manifest, JSON.stringify({ key, outputHash }) + "\n");
      await fs.rename(temporary, output);
      await fs.rename(manifest, cache);
      return output;
    } finally {
      await fs.rm(temporary, { force: true });
      await fs.rm(manifest, { force: true });
    }
  });
}

/** One voice span, as 48 kHz PCM WAV for a layered editor track. No loudnorm. */
export async function cleanVoiceFile(input: string, output: string, finish: AudioFinish = DEFAULT_AUDIO_FINISH,
  span?: { root: string; start: number; duration: number; clean?: ClipSoundClean }): Promise<string> {
  if (path.extname(output).toLowerCase() !== ".wav") throw new Error("Cleaned voice output must be a WAV file.");
  const resolved = path.resolve(output), marker = `${path.sep}.sidething${path.sep}`;
  const root = span?.root ?? (resolved.includes(marker) ? resolved.slice(0, resolved.indexOf(marker)) : path.dirname(resolved));
  const facts = await measureSourceAudio(root, input);
  const prepared = await prepareVoicePiece(root, input, finish, span?.start ?? 0, span?.duration ?? facts.durationS, span?.clean);
  // Playback converts to stereo before cleanup. Nonlinear compressors and
  // de-essers must see that same channel level in editor WAVs too.
  const filter = ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo', prepared.filter,
    `apad,atrim=duration=${span?.duration ?? facts.durationS}`].filter(Boolean).join(',');
  return renderCached(input, output, async () => ({ operation: "voice", filter, span, prepared: await sourceIdentity(prepared.file),
    modelHash: finish.clean ? await digest(modelFile()) : null }), async temporary => {
    await runActivity({ kind: "render", root, target: null, label: "Preparing editor voice", cancelable: true }, async () => ffmpeg(["-v", "error", "-y",
      "-ss", `${(span?.start ?? 0) - (prepared.sourceStart ?? 0)}`, "-t", `${span?.duration ?? facts.durationS}`, ...await sourceAudioInput(path.resolve(prepared.file)), "-vn",
      ...(filter ? ["-af", filter] : []), "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le", "-f", "wav", temporary]),
      { renderLane: "background" });
  });
}

/** Whole-cut two-pass loudness. WAV for editors, MP4/MOV with picture copied.
 * finish.clean only controls span cleanup; the complete mix always gets its
 * requested listening level. Pass a distinct output path, never an original.
 */
export async function measureAndNormalise(input: string, output: string, finish: AudioFinish = DEFAULT_AUDIO_FINISH): Promise<string> {
  const target = targetFor(finish);
  const extension = path.extname(output).toLowerCase();
  if (![".wav", ".mp4", ".mov"].includes(extension)) throw new Error("Normalised audio output must be WAV, MP4 or MOV.");
  return renderCached(input, output, async () => ({ operation: "mix", target, extension }), async temporary => {
    const measured = await measureLoudness(input, finish);
    // Decoding AAC can expose its final padded packet. Bound the replacement
    // audio to the original cut so remuxing cannot lengthen the timeline.
    const durationArgs: string[] = [];
    if (extension !== ".wav") {
      const { stdout } = await exec(tool("ffprobe"), ["-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", path.resolve(input)], { timeout: 30_000 });
      const duration = Number(stdout.trim());
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("Cannot measure the complete mix duration.");
      durationArgs.push("-t", String(duration));
    }
    const selected = await sourceAudio(input);
    await ffmpeg(["-v", "error", "-y", ...(extension === '.wav' ? await sourceAudioInput(input) : ['-i', path.resolve(input),
      ...(!selected ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : [])]),
      ...(extension === ".wav" ? ["-vn"] : ["-map", "0:v:0?", "-c:v", "copy"]),
      ...(extension === '.wav' ? [] : ['-map', selected ? `0:${selected.index}` : '1:a:0']), "-af", loudnessFilter(measured, finish), "-ar", "48000",
      ...(extension === ".wav" ? ["-c:a", "pcm_s24le", "-f", "wav"] : ["-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart"]),
      ...durationArgs, temporary]);
  });
}

export interface PreparedVoice {
  file: string;
  sourceStart?: number;
  breathCleanup?: { enabled: boolean; reason: string; counts: { breaths: number; clicks: number; plosives: number } };
  filter: string;
  gainDb: number;
  peakDb: number | null;
  speechLUFS: number | null;
}
/** Piece loudness is gated after take isolation/tone/manual EQ, before the person's clip gain. */
export async function prepareVoicePiece(root: string, input: string, finish: AudioFinish, start: number, duration: number, clean: ClipSoundClean = "none"): Promise<PreparedVoice> {
  finish = normalizeAudio(finish);
  if (![start, duration].every(Number.isFinite) || start < 0 || duration <= 0) throw new Error("Invalid voice measurement span.");
  if (!await sourceAudio(input)) return { file: input, filter: '', gainDb: 0, peakDb: null, speechLUFS: null };
  if (clean !== 'none') {
    const file = await cleanClipSound(root,input,clean);
    const prepared = await prepareVoicePiece(root,file,{...finish,clean:false,breaths:false},start,duration);
    return prepared;
  }
  const facts = await measureSourceAudio(root, input);
  const isolated = finish.auto !== false && finish.clean ? await isolateVoiceTake(root, input, Math.max(0, Math.min(1, finish.denoise)),
    `arnndn=m=${filterValue(modelFile())}:mix=${Math.max(0, Math.min(1, finish.denoise))},highpass=f=80`, await digest(modelFile())) : null;
  const repaired = finish.breaths !== false ? await cleanupBreaths(root, isolated?.file ?? input, start, duration, await breathWords(root, input), isolated ? "" : facts.filter) : null;
  const file = repaired?.file ?? isolated?.file ?? input, sourceStart = repaired?.sourceStart ?? 0;
  const breathCleanup = { enabled: finish.breaths !== false, reason: repaired?.reason ?? BREATH_CLEANUP_REASON,
    counts: { breaths: repaired?.events.filter(e => e.kind === "breath").length ?? 0, clicks: repaired?.events.filter(e => e.kind === "click").length ?? 0, plosives: repaired?.events.filter(e => e.kind === "plosive").length ?? 0 } };
  const routing = isolated || (repaired && repaired.file !== input) ? "" : facts.filter;
  if (finish.auto === false && finish.evenOutVoices !== true) return { file, sourceStart, breathCleanup, filter: [routing, voiceFilter(finish)].filter(Boolean).join(","), gainDb: 0, peakDb: facts.peakDb, speechLUFS: null };
  const filter = [routing, voiceFilter(finish, !!isolated),
    finish.auto !== false && facts.boomDb ? `bass=g=${facts.boomDb}:f=150:t=q:w=0.707` : "",
    finish.auto !== false && facts.presenceDb ? `equalizer=f=3000:t=q:w=0.8:g=${facts.presenceDb}` : ""].filter(Boolean).join(",");
  const source = await sourceIdentity(file), span = { start: start - sourceStart, duration, filter };
  const key = createHash("sha256").update(JSON.stringify({ revision: 1, source, span })).digest("hex");
  const receipt = path.join(await audioCacheDir(root), `speech-${key}.json`);
  let measurement: LoudnessMeasurement | null;
  try { measurement = JSON.parse(await fs.readFile(receipt, "utf8")).measurement; }
  catch {
    measurement = await runActivity({ kind: "render", root, target: null, label: "Matching voice levels", cancelable: true },
      () => measureLoudness(file, DEFAULT_AUDIO_FINISH, span), { renderLane: "background" });
    const temporary = `${receipt}.${randomUUID()}.tmp`;
    try { currentActivity()?.signal.throwIfAborted(); await fs.writeFile(temporary, JSON.stringify({ measurement })); await fs.rename(temporary, receipt); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  // Silence is left alone. The absolute gate prevents amplifying silent room tone.
  const gainDb = finish.evenOutVoices !== false && measurement && measurement.input_i > -60 && Math.abs(-20-measurement.input_i)>.75 ? Math.max(-30, Math.min(30, -20 - measurement.input_i)) : 0;
  return { file, sourceStart, breathCleanup, filter: [filter, gainDb ? `volume=${gainDb}dB` : ""].filter(Boolean).join(","), gainDb,
    peakDb: measurement ? measurement.input_tp + gainDb : null, speechLUFS: measurement?.input_i ?? null };
}

/** Sample-accurate redaction with a 1 kHz replacement at measured voice RMS.
 * Room tone is mixed afterwards by J2, leaving mute spans in the same room. */
export function appendBleeps(filters: string[], input: string, spans: { s: number; e: number; sound: "beep" | "mute"; levelDb?: number }[]): void {
  const gates = spans.map(b => `between(t,${b.s},${b.e}-1/48000)`);
  const gate = `min(1,${gates.join('+')})`;
  const tones = spans.flatMap((b,i) => b.sound === 'beep' ? [`${gates[i]}*${Math.min(.7, Math.SQRT2 * 10 ** ((b.levelDb ?? -20) / 20))}*sin(2*PI*1000*(t-${b.s}))*min(1,min((t-${b.s})/0.005,(${b.e}-t)/0.005))`] : []);
  const expression = (channel: number) => `val(${channel})*(1-${gate})${tones.length ? '+' + tones.join('+') : ''}`;
  // Rename the input producer so downstream callers retain their stable label.
  const from = `[${input}]`, renamed = `${input}BeforeBleep`;
  for (let i = 0; i < filters.length; i++) filters[i] = filters[i].split(from).join(`[${renamed}]`);
  filters.push(`[${renamed}]aeval=exprs='${expression(0)}|${expression(1)}',aformat=channel_layouts=stereo[${input}]`);
}

/** RMS after the exact voice cleanup, before the person's clip gain. */
export async function bleepVoiceLevel(root: string, prepared: PreparedVoice, start: number, duration: number): Promise<number> {
  const key = createHash('sha256').update(JSON.stringify({ source: await sourceIdentity(prepared.file), start, duration, sourceStart: prepared.sourceStart, filter: prepared.filter })).digest('hex');
  const receipt = path.join(await audioCacheDir(root), `bleep-level-${key}.json`);
  try { const saved = JSON.parse(await fs.readFile(receipt, 'utf8')); if (Number.isFinite(saved.level)) return saved.level; } catch { /* cache miss */ }
  const report = await runActivity({ kind: 'render', root, target: null, label: 'Matching bleep level', cancelable: true }, async () => ffmpeg(['-v', 'info', '-ss', `${Math.max(0, start - (prepared.sourceStart ?? 0))}`, '-t', `${duration}`, ...await sourceAudioInput(prepared.file), '-vn', '-af', [prepared.filter, 'volumedetect'].filter(Boolean).join(','), '-f', 'null', '-']), { renderLane: 'background' });
  const value = Number(report.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1]), level = Number.isFinite(value) ? value : -60;
  const temporary = `${receipt}.${randomUUID()}.tmp`;
  try { currentActivity()?.signal.throwIfAborted(); await fs.writeFile(temporary, JSON.stringify({ level })); await fs.rename(temporary, receipt); }
  finally { await fs.rm(temporary, { force: true }); }
  return level;
}
