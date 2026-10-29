// VO7-4: waveform peaks, computed once per file and cached in the shoot.
// ffmpeg decodes out of process; the fold below runs per stdout chunk, so
// neither the main process nor the renderer blocks. The cache lives in the
// rebuildable finish cache, keyed by content hash:
//   <root>/.sidething/finish-cache/peaks-<sha256>.bin
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PeakSlice } from "../shared/schema";
import { tool } from "./tools";

export const PEAKS_PER_SECOND = 100;
const RATE = 48000, FRAMES = RATE / PEAKS_PER_SECOND, MAGIC = "PCPK", VERSION = 1, HEADER = 16;
interface Peaks { durationS: number; min: Int8Array; max: Int8Array }

const hashes = new Map<string, string>();          // file identity -> content hash
const loaded = new Map<string, Peaks>();           // content hash -> peaks (small LRU)
const working = new Map<string, Promise<Peaks>>(); // content hash -> the one computation

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

/** Encodes peaks as the cache file: a 16 byte header, then every min, then every max. */
export function encodePeaks(peaks: Peaks): Buffer {
  const out = Buffer.alloc(HEADER + peaks.min.length * 2);
  out.write(MAGIC, 0, "ascii"); out.writeUInt8(VERSION, 4); out.writeUInt16LE(PEAKS_PER_SECOND, 6);
  out.writeUInt32LE(peaks.min.length, 8); out.writeFloatLE(peaks.durationS, 12);
  Buffer.from(peaks.min.buffer, peaks.min.byteOffset, peaks.min.length).copy(out, HEADER);
  Buffer.from(peaks.max.buffer, peaks.max.byteOffset, peaks.max.length).copy(out, HEADER + peaks.min.length);
  return out;
}
export function decodePeaks(bytes: Buffer): Peaks | null {
  if (bytes.length < HEADER || bytes.toString("ascii", 0, 4) !== MAGIC || bytes.readUInt8(4) !== VERSION || bytes.readUInt16LE(6) !== PEAKS_PER_SECOND) return null;
  const count = bytes.readUInt32LE(8);
  if (bytes.length !== HEADER + count * 2) return null;
  const copy = new Int8Array(count * 2);
  copy.set(new Int8Array(bytes.buffer, bytes.byteOffset + HEADER, count * 2));
  return { durationS: bytes.readFloatLE(12), min: copy.subarray(0, count), max: copy.subarray(count) };
}

/** Folds interleaved 16-bit audio into one min and max per 10 ms, across every channel. */
export function peakFolder(channels = 1) {
  const min: number[] = [], max: number[] = [];
  let carry: Buffer | null = null, frame = 0, low = 0, high = 0;
  const quantize = (v: number) => Math.max(-127, Math.min(127, Math.round(v * 127 / 32768)));
  const close = () => { min.push(quantize(low)); max.push(quantize(high)); frame = 0; low = 0; high = 0; };
  return {
    push(chunk: Buffer) {
      const data = carry ? Buffer.concat([carry, chunk]) : chunk;
      const usable = data.length - data.length % (2 * channels);
      // Little-endian samples, read through an aligned view (a copy only when the chunk is odd-aligned).
      const samples = data.byteOffset % 2 === 0 ? new Int16Array(data.buffer, data.byteOffset, usable / 2) : new Int16Array(Uint8Array.from(data.subarray(0, usable)).buffer);
      for (let i = 0; i < samples.length; i += channels) {
        for (let c = 0; c < channels; c++) { const v = samples[i + c]; if (v < low) low = v; if (v > high) high = v; }
        if (++frame === FRAMES) close();
      }
      carry = usable < data.length ? Buffer.from(data.subarray(usable)) : null;
    },
    end(totalFrames: number): Peaks {
      if (frame) close();
      return { durationS: totalFrames / RATE, min: Int8Array.from(min), max: Int8Array.from(max) };
    },
  };
}

async function contentHash(file: string): Promise<string> {
  const stat = await fs.stat(file), identity = `${file}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.ino}`;
  const known = hashes.get(identity);
  if (known) return known;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const digest = hash.digest("hex");
  hashes.set(identity, digest);
  return digest;
}

/** The same source stream playback and export use (the rule in source-audio.ts selectSourceAudio,
 * repeated here so this module stays free of the activity graph), at its own channel count:
 * ffmpeg's mono-to-stereo upmix is 3 dB down and a downmix averages, so neither is a real peak. */
async function inputArgs(file: string): Promise<{ args: string[]; channels: number }> {
  const probe = await new Promise<string>((resolve, reject) => execFile(tool("ffprobe"), ["-v", "error", "-show_streams", "-of", "json", file], { timeout: 30_000, maxBuffer: 4 << 20 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const streams = ((JSON.parse(probe).streams ?? []) as { index: number; codec_type?: string; codec_name?: string; channels?: number; disposition?: { default?: number } }[])
    .filter(s => s.codec_type === "audio" && !!s.codec_name && !["unknown", "none"].includes(s.codec_name));
  const stream = streams.find(s => s.disposition?.default) ?? streams[0];
  if (!stream) throw new Error(`${path.basename(file)} has no sound.`);
  const channels = Math.max(1, Math.min(32, stream.channels ?? 1));
  return { args: ["-i", file, "-map", `0:${stream.index}`, "-ac", String(channels)], channels };
}

function decode(file: string, { args, channels }: { args: string[]; channels: number }): Promise<Peaks> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool("ffmpeg"), ["-hide_banner", "-v", "error", "-nostdin", "-threads", "1", ...args, "-vn", "-ar", String(RATE), "-f", "s16le", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    const folder = peakFolder(channels);
    let bytes = 0, stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; folder.push(chunk); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`Couldn't read the sound in ${path.basename(file)}${stderr ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`)); return; }
      resolve(folder.end(Math.floor(bytes / (2 * channels))));
    });
  });
}

async function cacheDir(root: string): Promise<string> {
  const base = await fs.realpath(root), side = path.join(base, ".sidething"), dir = path.join(side, "finish-cache");
  await fs.mkdir(dir, { recursive: true });
  if (await fs.realpath(side) !== side || await fs.realpath(dir) !== dir) throw new Error("The waveform cache must stay inside the shoot.");
  return dir;
}

function remember(hash: string, peaks: Peaks): Peaks {
  loaded.delete(hash); loaded.set(hash, peaks);
  while (loaded.size > 64) loaded.delete(loaded.keys().next().value!);
  return peaks;
}

// Music lives outside shoots. music.ts registers the catalog here, so this module never pulls it in.
let libraryTracks: () => Promise<string[]> = async () => [];
export function setLibraryTracks(list: () => Promise<string[]>): void { libraryTracks = list; }

/** Resolves a shoot file (or a library music track) and refuses anything else. */
async function resolveAudio(root: string, file: string, libraryTrack = false): Promise<{ root: string; file: string }> {
  if (typeof root !== "string" || typeof file !== "string" || !root || !file || root.includes("\0") || file.includes("\0")) throw new Error("Choose a sound in this shoot.");
  const realRoot = await fs.realpath(path.resolve(root));
  await fs.access(path.join(realRoot, ".sidething", "index.json")).catch(() => { throw new Error("Open a shoot first."); });
  const wanted = path.isAbsolute(file) ? file : path.resolve(realRoot, file);
  const real = await fs.realpath(wanted).catch(() => { throw new Error("That sound is missing."); });
  if (!inside(real, realRoot) && !libraryTrack) {
    const tracks: string[] = await libraryTracks().catch(() => []);
    if (!tracks.includes(wanted) && !tracks.includes(real)) throw new Error("That sound is outside this shoot.");
  }
  if (!(await fs.stat(real)).isFile()) throw new Error("That sound is missing.");
  return { root: realRoot, file: real };
}

/** Whole-file peaks: memory, then the cache file, then one ffmpeg pass shared by every caller. */
async function peaksFor(root: string, file: string): Promise<Peaks> {
  const hash = await contentHash(file);
  const hit = loaded.get(hash);
  if (hit) return remember(hash, hit);
  let work = working.get(hash);
  if (!work) {
    work = (async () => {
      const dir = await cacheDir(root), target = path.join(dir, `peaks-${hash}.bin`);
      const saved = await fs.readFile(target).then(decodePeaks, () => null);
      if (saved) return saved;
      const peaks = await decode(file, await inputArgs(file));
      const temp = `${target}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, encodePeaks(peaks)); await fs.rename(temp, target); }
      catch (error) { console.warn("[peaks] could not cache:", error instanceof Error ? error.message : error); }
      finally { await fs.rm(temp, { force: true }); }
      return peaks;
    })();
    working.set(hash, work);
    void work.then(() => {}, () => {}).finally(() => { if (working.get(hash) === work) working.delete(hash); });
  }
  return remember(hash, await work);
}

/** The slice a piece needs, in source seconds. Omitted bounds mean the whole file. */
export async function getPeaks(root: string, file: string, from?: number, to?: number): Promise<PeakSlice> {
  for (const value of [from, to]) if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) throw new Error("Choose a span in seconds.");
  const audio = await resolveAudio(root, file), peaks = await peaksFor(audio.root, audio.file);
  const count = peaks.min.length;
  const start = Math.max(0, Math.min(count, Math.floor((from ?? 0) * PEAKS_PER_SECOND)));
  const end = Math.max(start, Math.min(count, Math.ceil((to ?? peaks.durationS) * PEAKS_PER_SECOND)));
  return { rate: PEAKS_PER_SECOND, from: start / PEAKS_PER_SECOND, to: end / PEAKS_PER_SECOND, durationS: peaks.durationS, min: peaks.min.slice(start, end), max: peaks.max.slice(start, end) };
}

/** Ingest: warm the cache in the background. Failure only means a later lazy try.
 * libraryTrack: the caller already matched the file to the music catalog. */
export function warmPeaks(root: string, file: string, libraryTrack = false): void {
  void new Promise<void>(resolve => setImmediate(resolve)).then(() => resolveAudio(root, file, libraryTrack)).then(audio => peaksFor(audio.root, audio.file))
    .catch(error => console.warn("[peaks]", error instanceof Error ? error.message : error));
}
