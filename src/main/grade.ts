import { gradeWork } from "./grade-work";
import { exposureBatch } from './exposure-batch';
import { canVideoToolboxDecode } from './video-decode';
import { basicLinear as inverse709 } from "./basics";
import { validInput } from "../shared/grade-math";
import { LOOKS, isLookPreset, lookIntensity, normalizePieceLook, gradeForPiece, gradeForLook, LUT_SIZE, GRADE_BOUNDS, CAMERA_INPUTS, neutralGrade, clampGrade, cleanLinear, encodeCameraCurve, decodeCameraCurve, cameraLinear709, convertCameraRGB, expose, applyNeutralBase, lookTransform, gradeTransform } from "../shared/grade-math";
import type { LookGrade, LookPreference, GalleryLook, GradeInput, PieceCorrection, LutOptions, CameraInput, CameraGrade, NeutralBase } from "../shared/grade-math";
export { LOOKS, isLookPreset, lookIntensity, normalizePieceLook, gradeForPiece, gradeForLook, LUT_SIZE, GRADE_BOUNDS, CAMERA_INPUTS, neutralGrade, clampGrade, cleanLinear, encodeCameraCurve, decodeCameraCurve, cameraLinear709, convertCameraRGB, expose, applyNeutralBase, lookTransform, gradeTransform } from "../shared/grade-math";
export type { LookGrade, LookPreference, GalleryLook, GradeInput, PieceCorrection, LutOptions, CameraInput, CameraGrade, NeutralBase } from "../shared/grade-math";
// Fixed camera conversion first; only the person's look is judged by the model.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirInShoot } from "./shoot-dir";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BasicAdjust, Clip, ClipMeta, Grade, LookPreset, PieceLook, Shoot } from "../shared/schema";
import { MIXER_HUES, mixerTransform, normalizeMixer } from "./mixer";
export { mixerTransform, normalizeMixer, validMixer } from "./mixer";
import { tool } from "./tools";
import { currentActivity, runActivity, withRenderSlot, threads } from "./activity";
import { BASIC_BOUNDS, normalizeBasic, hasBasic, basicBefore, basicAfter, basicLinear, basicDisplay } from "./basics";
import daylightSample from "../renderer/src/assets/samples/daylight.jpg?asset";
import warmSample from "../renderer/src/assets/samples/warm.jpg?asset";
import nightSample from "../renderer/src/assets/samples/night.jpg?asset";
import skylineSample from "../renderer/src/assets/samples/skyline.jpg?asset";
import type { CutItem } from "./export";
import type { ReelAssembly } from "./reel";
import type { RunModelInput } from "./ai";

type RGB = [number, number, number];
const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const luma = (rgb: RGB) => .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
function hueSaturation(rgb: RGB) {
  const high=Math.max(...rgb),low=Math.min(...rgb),d=high-low;
  let h=d<1e-8?0:high===rgb[0]?60*((rgb[1]-rgb[2])/d%6):high===rgb[1]?60*((rgb[2]-rgb[0])/d+2):60*((rgb[0]-rgb[1])/d+4);
  if(h<0)h+=360;return {hue:h,saturation:high>0?d/high:0,chroma:d};
}
function skinLike(rgb: RGB) {const {hue,saturation,chroma}=hueSaturation(rgb),y=luma(rgb);return hue>=10&&hue<=65&&saturation>=.15&&saturation<=.7&&chroma>=.018&&y>.06&&y<.85;}
export interface LookOptions {
  cwd?: string;
  engine?: RunModelInput["engine"];
  runModel?: (input: RunModelInput) => Promise<string>;
}
export function gradeInput(profile: ClipMeta["pictureProfile"]): GradeInput {
  const p = (profile ?? "").toLowerCase();
  if (/s[ -]?log3/.test(p)) return "slog3";
  if (/hlg|arib.std.b67/.test(p)) return "hlg";
  if (/rec[. -]?709|bt[. -]?709|^709$/.test(p)) return "rec709";
  return "unknown"; // Never guess log from a missing profile.
}

export interface GradeDetection {
  profile: CameraInput; detectedBy: string; evidence: string[]; certain: boolean;
}
export interface ColourMetadata {
  transfer?: string; primaries?: string; matrix?: string; range?: string;
  exif?: Record<string, string>; dolbyCompatibility?: number; camera?: string;
}
type ColourClip = { meta: ClipMeta | null; colour?: ColourMetadata; gradeDetection?: GradeDetection };
/** String default preserves editor integrations. details=true returns provenance;
 * the same result is attached to clip.gradeDetection for clip-data inspection. */
export function gradeInputFor(clip: ColourClip, details: true): GradeDetection;
export function gradeInputFor(clip: ColourClip): CameraInput;
export function gradeInputFor(clip: ColourClip, details?: true): CameraInput | GradeDetection {
  const colour = clip.colour ?? (clip.meta as (ClipMeta & { colour?: ColourMetadata }) | null)?.colour ?? {};
  const evidence = [clip.meta?.pictureProfile ?? "", ...Object.entries(colour.exif ?? {}).map(([k, v]) => `${k}=${v}`),
    colour.transfer ?? "", colour.primaries ?? "", clip.meta?.codec ?? ""].filter(Boolean);
  const info = evidence.join(" ").toLowerCase().replace(/[_-]/g, " ");
  const make = clip.meta?.camera?.toLowerCase() ?? "";
  let profile: CameraInput = "unknown", detectedBy = "No unambiguous curve and gamut; identity Rec.709 fallback";
  // Do not accept successors (Apple Log2, F-Log2C) as the older curve/gamut.
  const unsupported = /apple\s*log\s*2|f\s*log\s*2\s*c|log\s*c[234]|d\s*log|s\s*log\s*[14]/.test(info);
  const candidates: CameraInput[] = [];
  if (/apple\s*log(?!\s*2)|iphone\s*log\b/.test(info)) candidates.push("apple-log");
  if (/\bs\s*log\s*3\b/.test(info)) {
    if (/\bs\s*gamut\s*3\s*(?:\.\s*)?cine/.test(info)) candidates.push("slog3");
    else if (/\bs\s*gamut\s*3\b/.test(info)) candidates.push("slog3-sgamut3");
  }
  if (/\bs\s*log\s*2\b/.test(info) && /\bs\s*gamut(?!\s*3)/.test(info)) candidates.push("slog2");
  if (/\bc(?:anon)?\s*log\s*2\b/.test(info) && /cinema\s*gamut/.test(info)) candidates.push("clog2");
  if (/\bc(?:anon)?\s*log\s*3\b/.test(info) && /cinema\s*gamut/.test(info)) candidates.push("clog3");
  if (/\bn\s*log\b/.test(info)) candidates.push("nlog");
  if (/\bv\s*log(?:\s*l)?\b/.test(info)) candidates.push("vlog");
  if (/\bf\s*log\s*2\b/.test(info)) candidates.push("flog2");
  else if (/\bf\s*log\b/.test(info)) candidates.push("flog");
  const logs = [...new Set(candidates)];
  if (!unsupported && logs.length === 1 && !/arib|2084|\bhlg\b|\bpq\b/i.test(colour.transfer ?? "")) {
    profile = logs[0]; detectedBy = "Explicit picture profile / exiftool curve and published gamut";
  } else if (!unsupported && !logs.length && !/\blog|log\d/.test(info.replace(/\bs\s*log/g, "log"))) {
    const dolbyHLG = colour.dolbyCompatibility === 4 || (/dolby\s*vision/.test(info) && /(?:profile\s*)?8[.]4\b/.test(info));
    const hlg = /hlg|arib[ .]std[ .]b67|arib std b67/.test(info) || dolbyHLG;
    const pq = /smpte\s*(?:st\s*)?2084|\bpq\b|hdr10/.test(info) || colour.dolbyCompatibility === 1;
    const bt2020 = /bt[ .]?2020|rec[ .]?2020/.test(info);
    if (hlg !== pq && (bt2020 || dolbyHLG)) {
      profile = hlg ? "hlg" : "pq"; detectedBy = "ffprobe transfer + BT.2020 primaries / Dolby base-layer compatibility";
    } else if (!hlg && !pq && /srgb|iec61966[ .]2[ .]1/.test(info)) {
      profile = "srgb"; detectedBy = "Explicit sRGB transfer";
    } else if (!hlg && !pq && /rec[ .]?709|bt[ .]?709|\bsdr\b/.test(info) && !/bt[ .]?2020|p3/.test(colour.primaries ?? "")) {
      profile = "rec709"; detectedBy = "Explicit Rec.709 / SDR metadata";
    }
  }
  // Camera make is provenance, never evidence of a recording mode by itself.
  const result: GradeDetection = { profile, certain: profile !== "unknown", detectedBy,
    evidence: [...evidence, ...(make ? [`camera=${clip.meta!.camera}`] : [])] };
  clip.gradeDetection = result;
  return details ? result : profile;
}

const metadataJobs = new Map<string, Promise<ColourMetadata>>();
function localJson(command: string, args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool(command), args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (b: Buffer) => { output += b.toString(); if (output.length > 4_000_000) child.kill("SIGKILL"); });
    child.stderr.on("data", (b: Buffer) => { error = (error + b.toString()).slice(-2000); });
    child.once("error", e => { clearTimeout(timer); reject(e); });
    child.once("close", code => { clearTimeout(timer); try { if (code) throw new Error(error); resolve(JSON.parse(output)); } catch (e) { reject(e); } });
  });
}
/** Read-only originals; persistent probe cache lives in the caller's grade cache.
 * process.py currently drops these tags, so grading probes them independently. */
export async function readGradeMetadata(clip: Clip, root: string, cacheDir: string): Promise<GradeDetection> {
  const target = clip as Clip & ColourClip, file = path.resolve(root, clip.file), stat = await fs.stat(file);
  const key = createHash("sha256").update(JSON.stringify({ revision: 2, file, size: stat.size, mtime: stat.mtimeMs })).digest("hex");
  let job = metadataJobs.get(key);
  if (!job) {
    job = (async () => {
      const cached = path.join(cacheDir, `colour-metadata-${key}.json`);
      try { const value = JSON.parse(await fs.readFile(cached, "utf8"));
        if (value && value.revision === 2 && value.colour && typeof value.colour === "object") return value.colour as ColourMetadata;
      } catch { /* re-probe missing or corrupt cache */ }
      const results = await Promise.allSettled([
        localJson("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_streams", "-of", "json", file]),
        localJson("exiftool", ["-j", "-s", "-G", "-Make", "-Model", "-ColorSpace", "-ColorPrimaries", "-TransferCharacteristics",
          "-Gamma", "-GammaEquation", "-CaptureGammaEquation", "-CaptureColorPrimaries", "-PictureProfile", "-CanonLog", "-VideoGamma", file]),
      ]);
      const colour: ColourMetadata = {};
      if (results[0].status === "fulfilled") {
        const stream = (results[0].value as { streams?: Record<string, unknown>[] }).streams?.[0];
        if (stream) {
          for (const [k, tag] of Object.entries({ transfer: "color_transfer", primaries: "color_primaries", matrix: "color_space", range: "color_range" }))
            if (typeof stream[tag] === "string") (colour as Record<string, unknown>)[k] = stream[tag];
          const dv = (stream.side_data_list as Record<string, unknown>[] | undefined)?.find(s => s.dv_bl_signal_compatibility_id !== undefined);
          if (dv) colour.dolbyCompatibility = Number(dv.dv_bl_signal_compatibility_id);
          colour.exif = Object.fromEntries(Object.entries((stream.tags ?? {}) as Record<string, unknown>).filter(([k]) => /gamma|profile|transfer|primar|color.space/i.test(k)).map(([k,v]) => [`ffprobe:${k}`, String(v)]));
        }
      }
      if (results[1].status === "fulfilled") {
        const tags = (results[1].value as Record<string, unknown>[])?.[0] ?? {};
        // EXIF/Canon MakerNotes ColorSpace often describes the embedded JPEG
        // thumbnail, even in C-Log movies. It cannot identify the video curve.
        colour.exif = { ...colour.exif, ...Object.fromEntries(Object.entries(tags).filter(([k,v]) =>
          !/SourceFile|Make$|Model$/.test(k) && !(/(?:EXIF|MakerNotes):ColorSpace$/.test(k) && /srgb|adobe/i.test(String(v))))
          .map(([k,v]) => [k, String(v)])) };
        const make=Object.entries(tags).find(([k])=>/Make$/.test(k))?.[1];
        const model=Object.entries(tags).find(([k])=>/Model$/.test(k))?.[1];
        if(model) colour.camera=make && !String(model).toLowerCase().includes(String(make).toLowerCase()) ? `${make} ${model}` : String(model);
      }
      // Do not persist failed probes: a later installation/retry must recover.
      if (results.every(r => r.status === "fulfilled")) await atomicWrite(cached, JSON.stringify({ revision: 2, colour }));
      return colour;
    })();
    metadataJobs.set(key, job);
  }
  try { target.colour = await job; if (target.meta && !target.meta.camera && target.colour.camera) target.meta.camera=target.colour.camera; return gradeInputFor(target, true); }
  finally { metadataJobs.delete(key); }
}

/** PS4: LUTs live in the app's own user-data folder, so an isolated profile (QA, a second install) never writes into
 * another one. Plain Node (QA bundles without Electron) uses a temporary folder. */
async function defaultCacheDir(): Promise<string> {
  const override = process.env.SIDETHING_USER_DATA;
  if (override) return path.join(override, "luts");
  try {
    const electron = await import("electron") as unknown as { app?: { getPath(name: string): string }; default?: { app?: { getPath(name: string): string } } };
    const app = electron.app ?? electron.default?.app;
    if (app && typeof app.getPath === "function") return path.join(app.getPath("userData"), "luts");
  } catch { /* not running under Electron */ }
  return path.join(os.tmpdir(), "precut", "luts");
}

async function atomicWrite(file: string, data: string): Promise<void> {
  await mkdirInShoot(path.dirname(file));  // FIX3: a shoot's finish cache never recreates a moved shoot
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, data, "utf8"); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}

/** A LUT a filter is about to name: written when its content differs, otherwise its access time is set to now
 * (contents and mtime unchanged), so the cache budget (storage.ts ages files by the later of the two) counts it
 * as in use and never evicts it between building a render's filters and ffmpeg opening it. */
async function keepCube(file: string, existing: string | undefined, data: string): Promise<void> {
  if (existing !== data) { await atomicWrite(file, data); return; }
  // Only when it has not been marked in the last few minutes (the budget's in-use window is 15).
  await fs.stat(file).then(stat => Date.now() - stat.atimeMs > 5 * 60_000 ? fs.utimes(file, new Date(), stat.mtime) : undefined)
    .catch(() => { /* still readable; the render goes on */ });
}

/** Returns the cached 33^3 conversion cube's absolute path. No model or ffmpeg. */
export async function buildLut(input: CameraInput, options: LutOptions = {}): Promise<string> {
  input = CAMERA_INPUTS.includes(input) ? input : "unknown";
  const table = await gradeWork({kind:"conversion",grade:{...neutralGrade("rec709"),input}});
  const data = `TITLE "Precut ${input} to Rec709 v4"\n${table.cube!}`;
  // Content hash invalidates the cache whenever the maths or size changes;
  // comparing contents also repairs incomplete/corrupt files left on disk.
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
  const file = path.resolve(options.cacheDir ?? await defaultCacheDir(), `${input}-${hash}.cube`);
  let existing: string | undefined;
  try { existing = await fs.readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await keepCube(file, existing, data);
  return file;
}

// Escape BOTH ffmpeg's option parser and filtergraph parser, without a shell.
// The returned chain is an argv value, never a shell command.
function filterValue(value: string): string {
  const option = value.replace(/[\\':]/g, "\\$&");
  return option.replace(/[\\'\[\],;]/g, "\\$&");
}

// Exposure corrects actual face clipping, never a chosen skin brightness.
export const FACE_CLIP_LEVEL = .98;
export const FACE_CLIPPED_SHARE = .01; // More than 1% of face pixels, any channel.
export const PIECE_EXPOSURE_LIMIT = 1;
const EXPOSURE_REVISION = 6;
/** PS4: draft.ts keeps each piece's finished colour by content under this. Change it whenever a measurement below
 * changes (exposure, setup base revision 3, piece match v1, metadata revision 2), so old results are not reused. */
export const COLOUR_MEASUREMENT_REVISION = `exposure-${EXPOSURE_REVISION}/setup-4/match-1/metadata-2/preview-sampling-1`;
// Scene key decides where skin sits, as a colourist would: a low-key night scene keeps
// faces lower than a bright daytime one. Values are face median luma (display-referred).
// Log footage is usually exposed bright on purpose, so these only ever pull down.
const SKIN_TARGET_BY_KEY = { low: .34, mid: .40, high: .46 } as const;
// A night street with city lights and a close subject measures a frame median near .2: low-key.
function sceneKey(median: number): keyof typeof SKIN_TARGET_BY_KEY { return median < .26 ? "low" : median < .4 ? "mid" : "high"; }
export interface ExposureSpan { clipId: string; s: number; e: number; pieceIndex?: number }
/** Match the compositor's frame rounding and overlay truncation exactly. */
export function exposureSpans(cuts: CutItem[], overlays: ReelAssembly["broll"], fps: number): ExposureSpan[] {
  const spans: (ExposureSpan & { timelineS: number })[] = cuts.flatMap((c, pieceIndex) => c.seg ? [{ clipId: c.seg.clip.id, pieceIndex,
    s: c.inFrames / (c.clipFpsR.num / c.clipFpsR.den),
    e: c.inFrames / (c.clipFpsR.num / c.clipFpsR.den) + c.durTimelineFrames / fps,
    timelineS: c.offsetFrames / fps }] : []);
  for (const [overlayIndex, overlay] of overlays.entries()) {
    const piece = cuts.filter((c, index) => (c.piece ?? index) === overlay.voiceIndex);
    if (!piece.length || !overlay.seg.clip.meta) continue;
    const sourceFps = overlay.seg.clip.meta.fps, s = Math.ceil(overlay.seg.s * sourceFps) / sourceFps;
    const length = Math.min(Math.floor(overlay.seg.e * sourceFps) / sourceFps - s, piece.reduce((n, c) => n + c.durTimelineFrames / fps, 0));
    if (length > 0) spans.push({ clipId: overlay.seg.clip.id, pieceIndex: cuts.length + overlayIndex, s, e: s + length, timelineS: piece[0].offsetFrames / fps });
  }
  return spans.sort((a, b) => a.timelineS - b.timelineS).map(({ timelineS: _, ...span }) => span);
}
export interface PieceExposure {
  stops: number; rolloff: number; before: number; after: number;
  clippedBefore: number; clippedAfter: number; samples: number[];
  regions: ("face" | "centre")[];
}
export interface PieceExposureOptions {
  root: string; s: number; e: number; neighbours?: ExposureSpan[];
}
interface ExposureSample { pixels: string; samples: number[]; regions: ("face" | "centre")[] }
const exposureJobs = new Map<string, Promise<ExposureSample>>();

/** Subject coordinates are centres in top-left frame space, not box origins.
 * Body/saliency detections are never face measurements. */
function exposureFaces(clip: Clip) {
  return (clip.subject?.samples ?? []).filter(s => s.kind === "face" &&
    [s.t, s.x, s.y, s.w, s.h].every(Number.isFinite) && s.t >= 0 &&
    (!clip.meta || s.t < clip.meta.durationS) && s.w > 0 && s.h > 0 &&
    s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1 && s.w <= 1 && s.h <= 1)
    .sort((a, b) => a.t - b.t || a.x - b.x || a.y - b.y);
}
export function exposureRegion(clip: Clip, time: number): { x: number; y: number; w: number; h: number; kind: "face" | "centre" } {
  const faces = exposureFaces(clip);
  const face = faces.reduce<typeof faces[number] | undefined>((best, s) =>
    !best || Math.abs(s.t - time) < Math.abs(best.t - time) ? s : best, undefined);
  if (!face || Math.abs(face.t - time) > 1) return { x: 1 / 3, y: 1 / 3, w: 1 / 3, h: 1 / 3, kind: "centre" };
  const x = clamp(face.x - face.w / 2), y = clamp(face.y - face.h / 2);
  return { x, y, w: Math.min(face.w, 1 - x), h: Math.min(face.h, 1 - y), kind: "face" };
}

const exposureDecode = (clip: Clip): string[] => /h264|hevc|h265/i.test(clip.meta?.codec ?? '') && canVideoToolboxDecode(clip.meta?.codec) ? ['-hwaccel', 'videotoolbox'] : [];
function exposureFrame(args: string[]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const signal = currentActivity()?.signal;
    signal?.throwIfAborted();
    const child = spawn(tool("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-threads", String(threads(4)), "-filter_threads", String(threads(4)), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const chunks: Buffer[] = []; let bytes = 0, stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 64 * 6) child.kill("SIGKILL"); else chunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => {
      cleanup();
      if (signal?.aborted) { reject(signal.reason); return; }
      if (code !== 0 || bytes !== 64 * 64 * 6) reject(new Error(`Couldn't measure skin exposure: ${stderr || "incomplete frame"}`));
      else resolve(Buffer.concat(chunks));
    });
  }).catch(error => {
    if (!args.includes('-hwaccel') || currentActivity()?.signal.aborted) throw error;
    return exposureFrame(args.filter((arg, i) => arg !== '-hwaccel' && args[i - 1] !== '-hwaccel'));
  });
}

async function sampleExposure(clip: Clip, cacheDir: string, options: PieceExposureOptions): Promise<ExposureSample> {
  // One deterministic sample set across the entire camera file. Neither the
  // requested edit span nor its neighbours can alter the setup's correction.
  const faces = exposureFaces(clip), count = Math.min(8, faces.length);
  const fps = clip.meta?.fps && clip.meta.fps > 0 ? clip.meta.fps : 25;
  const samples = [...new Set(Array.from({ length: count }, (_, i) => {
    const face = faces[Math.min(faces.length - 1, Math.floor((i + .5) * faces.length / count))];
    return Math.floor(face.t * fps + 1e-7) / fps;
  }))];
  if (!samples.length) return { pixels: "", samples: [], regions: [] };
  const regions = samples.map(t => exposureRegion(clip, t));
  const file = path.resolve(options.root, clip.file), stat = await fs.stat(file);
  const { clipGradeFilter } = await import("./preview");
  const conversion = await clipGradeFilter(clip, neutralGrade("unknown"), cacheDir);
  const key = createHash("sha256").update(JSON.stringify({ revision: EXPOSURE_REVISION, file, size: stat.size,
    mtime: stat.mtimeMs, samples, conversion, regions })).digest("hex");
  const pending = exposureJobs.get(key); if (pending) return pending;
  const job = (async () => {
    const cached = path.join(cacheDir, `exposure-${key}.json`);
    try {
      const value = JSON.parse(await fs.readFile(cached, "utf8")) as ExposureSample;
      if (value && typeof value.pixels === "string" && Buffer.from(value.pixels, "base64").length === samples.length * 64 * 64 * 6 &&
          JSON.stringify(value.samples) === JSON.stringify(samples) && JSON.stringify(value.regions) === JSON.stringify(regions.map(r => r.kind))) return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    const frames: Buffer[] = [];
    for (const [i, t] of samples.entries()) {
      const r = regions[i];
      frames.push(await exposureFrame([...exposureDecode(clip), "-ss", String(t), "-i", file, "-vf",
        `${conversion},crop=w=iw*${r.w}:h=ih*${r.h}:x=iw*${r.x}:y=ih*${r.y},scale=64:64:flags=neighbor,format=rgb48le`,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb48le", "pipe:1"]));
    }
    const value: ExposureSample = { pixels: Buffer.concat(frames).toString("base64"), samples, regions: regions.map(r => r.kind) };
    await atomicWrite(cached, JSON.stringify(value)); return value;
  })();
  exposureJobs.set(key, job);
  try { return await job; } finally { exposureJobs.delete(key); }
}

function pixelsOf(sample: ExposureSample): RGB[] {
  const bytes = Buffer.from(sample.pixels, "base64"), pixels: RGB[] = [];
  for (let i = 0; i < bytes.length; i += 6) pixels.push([bytes.readUInt16LE(i) / 65535, bytes.readUInt16LE(i + 2) / 65535, bytes.readUInt16LE(i + 4) / 65535]);
  return pixels;
}
function exposureStats(pixels: RGB[], exposure?: { stops: number; rolloff: number }) {
  if (!pixels.length) return { median: 0, clipped: 0 };
  const values: number[] = []; let clipped = 0;
  for (const pixel of pixels) {
    const rgb = expose(pixel, exposure); values.push(luma(rgb));
    if (Math.max(...rgb) >= FACE_CLIP_LEVEL) clipped++;
  }
  values.sort((a, b) => a - b);
  return { median: (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2, clipped: clipped / pixels.length };
}

/** Only pull down meaningful face clipping, by at most one stop. All face-bearing
 * pieces from the same camera file use the identical setup measurement/value.
 * Face-less shots stay untouched. No neighbour matching or within-shot drift. */
export async function measurePieceExposure(clip: Clip, cacheDir: string, options: PieceExposureOptions): Promise<PieceExposure> {
  const { s, e } = options;
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s ||
      (clip.meta && e > clip.meta.durationS + .05)) throw new Error("Choose a valid exposure source span.");
  const hasFace = exposureFaces(clip).some(face => face.t >= s && face.t < e);
  if (!hasFace) return { stops: 0, rolloff: .63, before: 0, after: 0,
    clippedBefore: 0, clippedAfter: 0, samples: [], regions: [] };
  const detection = await readGradeMetadata(clip, options.root, cacheDir);
  if (!detection.certain) return { stops: 0, rolloff: .63, before: 0, after: 0,
    clippedBefore: 0, clippedAfter: 0, samples: [], regions: [] };
  const sample = await sampleExposure(clip, cacheDir, options), pixels = pixelsOf(sample);
  const resultKey = createHash("sha256").update(JSON.stringify({ revision: EXPOSURE_REVISION, sample,
    clipLevel: FACE_CLIP_LEVEL, clippedShare: FACE_CLIPPED_SHARE, limit: PIECE_EXPOSURE_LIMIT })).digest("hex");
  const resultFile = path.join(cacheDir, `piece-exposure-${resultKey}.json`);
  try {
    const result = JSON.parse(await fs.readFile(resultFile, "utf8")) as PieceExposure;
    if (result && [result.stops, result.rolloff, result.before, result.after, result.clippedBefore, result.clippedAfter].every(Number.isFinite) &&
        result.stops >= -PIECE_EXPOSURE_LIMIT && result.stops <= 0 && result.rolloff === .63 &&
        result.clippedBefore >= 0 && result.clippedBefore <= 1 && result.clippedAfter >= 0 && result.clippedAfter <= 1 &&
        JSON.stringify(result.samples) === JSON.stringify(sample.samples) && JSON.stringify(result.regions) === JSON.stringify(sample.regions)) return result;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  const before = exposureStats(pixels);
  // Whole-frame key from one converted frame at the middle sample.
  const file = path.resolve(options.root, clip.file);
  const { clipGradeFilter } = await import("./preview");
  const conversion = await clipGradeFilter(clip, neutralGrade("unknown"), cacheDir);
  const mid = sample.samples[Math.floor(sample.samples.length / 2)];
  const frame = await exposureFrame([...exposureDecode(clip), "-ss", String(mid), "-i", file, "-vf", `${conversion},scale=64:64,format=rgb48le`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb48le", "pipe:1"]);
  const frameLuma: number[] = [];
  for (let i = 0; i + 6 <= frame.length; i += 6) frameLuma.push(luma([frame.readUInt16LE(i) / 65535, frame.readUInt16LE(i + 2) / 65535, frame.readUInt16LE(i + 4) / 65535]));
  frameLuma.sort((a, b) => a - b);
  const target = SKIN_TARGET_BY_KEY[sceneKey(frameLuma[Math.floor(frameLuma.length / 2)] ?? .3)];
  let stops = before.median > target ? Math.max(-PIECE_EXPOSURE_LIMIT, Math.log2(target / before.median)) : 0;
  if (exposureStats(pixels, { stops, rolloff: .63 }).clipped > FACE_CLIPPED_SHARE) {
    let lo = -PIECE_EXPOSURE_LIMIT, hi = stops;
    // Smallest pull that takes the clipped share to <= 1%, or the stop limit.
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (exposureStats(pixels, { stops: mid, rolloff: .63 }).clipped > FACE_CLIPPED_SHARE) hi = mid;
      else lo = mid;
    }
    stops = lo;
  }
  const after = exposureStats(pixels, { stops, rolloff: .63 });
  const result: PieceExposure = { stops, rolloff: .63, before: before.median, after: after.median,
    clippedBefore: before.clipped, clippedAfter: after.clipped, samples: sample.samples, regions: sample.regions };
  await atomicWrite(resultFile, JSON.stringify(result)); return result;
}

const identityBase = (): NeutralBase => ({ gains: [1,1,1], neutralRatios: [1,1,1], vibrance: 0, mid: 0, black: 0,
  neutralPixels: 0, skinPixels: 0, medianChroma: 0, measuredMid: 0, measuredBlack: 0, confidence: 0 });
const median = (v: number[]) => { const a = v.slice().sort((a,b) => a-b); return a.length ? (a[Math.floor((a.length-1)/2)] + a[Math.floor(a.length/2)]) / 2 : 0; };
/** Robust restricted grey-world. Face samples are separate evidence, never
 * neutral candidates. Constants bound correction, not an artistic skin target. */
export function estimateNeutralBase(pixels: RGB[], facePixels: RGB[] = []): NeutralBase {
  const base = identityBase(), neutrals: RGB[] = [], chromas: number[] = [], levels: number[] = [];
  for (const rgb of pixels) {
    if (!rgb.every(Number.isFinite)) continue;
    const y=luma(rgb), h=hueSaturation(rgb); levels.push(y);
    if (y > .12 && y < .75 && h.saturation < .18 && !skinLike(rgb)) neutrals.push(rgb);
    if (y > .1 && y < .8 && h.saturation > .06 && h.saturation < .75 && !skinLike(rgb)) chromas.push(h.chroma);
  }
  base.neutralPixels=neutrals.length; base.skinPixels=facePixels.filter(skinLike).length;
  const sorted=levels.slice().sort((a,b)=>a-b);
  base.measuredBlack=sorted[Math.floor(sorted.length*.02)] ?? 0;
  base.measuredMid=median(facePixels.filter(skinLike).map(luma)) || median(neutrals.map(luma));
  base.medianChroma=median(chromas);
  if (neutrals.length >= 64 && neutrals.length >= pixels.length*.015) {
    const means = [0,1,2].map(c => median(neutrals.map(rgb => Math.log(Math.max(rgb[c],.01)/Math.max(luma(rgb),.01)))));
    // Incoherent neutrals indicate mixed sodium/LED light. Reduce confidence
    // as the robust spread rises; never fully remove the scene's lighting.
    const spread=median(neutrals.map(rgb => Math.abs(Math.log(Math.max(rgb[0],.01)/Math.max(rgb[2],.01))-(means[0]-means[2]))));
    base.confidence=clamp(1-spread/.16)*Math.min(1,neutrals.length/(pixels.length*.1));
    base.neutralRatios=means.map(Math.exp) as RGB;
    const gains=means.map(v=>Math.exp(clamp(-v*.25*base.confidence,-.035,.035))) as RGB;
    let strength=1;
    const validFaces=facePixels.filter(skinLike);
    // Reject corrections that leave the natural hue interval or remove skin
    // chroma. No attempt to turn arbitrary coloured face lighting into grey.
    for (let i=0;i<8;i++) {
      const bad=validFaces.filter(rgb => { const h=hueSaturation(rgb.map((v,c)=>v*(1+(gains[c]-1)*strength)) as RGB);
        const before=hueSaturation(rgb); return h.hue<10 || h.hue>65 || h.chroma<before.chroma*.94; }).length;
      if (!validFaces.length || bad/validFaces.length <= .01) break;
      strength*=.5;
    }
    base.gains=gains.map(g=>1+(g-1)*strength) as RGB;
  }
  // Natural chroma target is deliberately a bounded normalisation, not a
  // demand that every scene have the same colourfulness. Sparse colour stays.
  if (chromas.length >= 64 && base.medianChroma > .015) base.vibrance=clamp((.075/base.medianChroma-1)*.15,-.06,.06);
  return base;
}
const neutralJobs = new Map<string, Promise<NeutralBase>>();
/** Small neutral/match samples can use the measured Rec.709 preview. Camera
 * conversion and software decode provenance must agree with the original.
 * Face clipping continues to measure the original's full precision. */
async function measuredPreview(clip: Clip, root: string, cameraConversion: string) {
  const relative = clip.proxy;
  if (!relative) return undefined;
  try {
    const { previewHealth, conversionKey } = await import('./proxies');
    if (previewHealth(root, { ...clip, proxy: relative }).state !== 'healthy') return undefined;
    const directory = path.resolve(root, '.sidething/proxies'), file = path.resolve(directory, relative);
    if (!file.startsWith(directory + path.sep)) return undefined;
    const receipt = JSON.parse(await fs.readFile(`${file}.proxy.json`, 'utf8')) as { conversionKey?: string; softwareCamera?: boolean };
    if (receipt.conversionKey !== conversionKey(cameraConversion, clip) || !canVideoToolboxDecode(clip.meta?.codec) && !receipt.softwareCamera) return undefined;
    return { file, conversion: 'scale=w=64:h=64:in_color_matrix=bt709:in_range=tv:out_range=full,format=gbrp16le' };
  } catch { return undefined; }
}
/** Full-file deterministic sample times make WB constant across all shot spans. */
export async function measureSetupBase(clip: Clip, cacheDir: string, root: string): Promise<NeutralBase> {
  const detection=await readGradeMetadata(clip,root,cacheDir);
  if (!detection.certain) return identityBase();
  const original=path.resolve(root,clip.file),sourceStat=await fs.stat(original),duration=clip.meta?.durationS ?? 0;
  if (!(duration>0)) return identityBase();
  const fps=clip.meta?.fps && clip.meta.fps>0 ? clip.meta.fps : 25;
  const times=[...new Set(Array.from({length:5},(_,i)=>Math.min(Math.max(0,(Math.ceil(duration*fps)-1)/fps),Math.floor(duration*(i+.5)/5*fps)/fps)))];
  const camera=await cameraConversionFilter(clip,cacheDir);
  const boxes=times.map(t=>exposureRegion(clip,t));
  // The measurement follows the original, so a preview arriving later cannot
  // change an already measured white balance. Retain precise legacy readings.
  const basis={file:original,size:sourceStat.size,mtime:sourceStat.mtimeMs,conversion:camera,times,boxes};
  const hash=(revision:number)=>createHash("sha256").update(JSON.stringify({revision,...basis})).digest("hex");
  const key=hash(4);
  let job=neutralJobs.get(key);
  if (!job) {
    job=(async()=>{
      const cached=path.join(cacheDir,`neutral-base-${key}.json`);
      for (const candidate of [cached,path.join(cacheDir,`neutral-base-${hash(3)}.json`)]) try { const v=JSON.parse(await fs.readFile(candidate,"utf8")) as NeutralBase;
        if (Array.isArray(v.neutralRatios)&&v.neutralRatios.length===3&&v.neutralRatios.every(n=>Number.isFinite(n)&&n>0)&&Array.isArray(v.gains)&&v.gains.length===3&&v.gains.every(g=>Number.isFinite(g)&&g>=.96&&g<=1.04)&&
          [v.vibrance,v.mid,v.black,v.neutralPixels,v.skinPixels,v.medianChroma,v.measuredMid,v.measuredBlack,v.confidence].every(Number.isFinite)&&
          Math.abs(v.vibrance)<=.06&&v.mid===0&&v.black===0) { if(candidate!==cached)await atomicWrite(cached,JSON.stringify(v));return v; }
      } catch { /* corrupt/missing measurement is rebuilt */ }
      const pixels: RGB[]=[], facePixels: RGB[]=[];
      const preview=await measuredPreview(clip,root,camera), file=preview?.file??original, conversion=preview?.conversion??camera;
      const commands=times.map(t=>[...(preview ? ['-hwaccel','videotoolbox'] : exposureDecode(clip)), "-ss",String(t),"-i",file,"-vf",`${conversion},scale=64:64,format=rgb48le`,"-frames:v","1","-f","rawvideo","-pix_fmt","rgb48le","pipe:1"]);
      let batch: Buffer[] | undefined;
      if(preview) try { batch=await exposureBatch(commands); } catch { currentActivity()?.signal.throwIfAborted(); /* individual decoder recovery below */ }
      for (const [i] of times.entries()) {
        const frame=batch?.[i]??await exposureFrame(commands[i]);
        const values=pixelsOf({pixels:frame.toString("base64"),samples:[],regions:[]}); pixels.push(...values);
        const r=boxes[i];
        if(r.kind==="face") for(let y=0;y<64;y++) for(let x=0;x<64;x++) if(x/64>=r.x&&x/64<r.x+r.w&&y/64>=r.y&&y/64<r.y+r.h) facePixels.push(values[y*64+x]);
      }
      const value=estimateNeutralBase(pixels,facePixels); await atomicWrite(cached,JSON.stringify(value)); return value;
    })(); neutralJobs.set(key,job);
  }
  try { return await job; } finally { neutralJobs.delete(key); }
}
/** Sum actual cut durations; stable file-name tie break. Never match unknowns.
 * A camera file is a setup: no metadata/time-based grouping guesses. */
export async function matchCutBase(clip: Clip, base: NeutralBase, cacheDir: string, options: PieceExposureOptions): Promise<NeutralBase> {
  if (!options.neighbours?.length || !gradeInputFor(clip,true).certain) return base;
  const totals=new Map<string,number>();
  for(const span of options.neighbours) if(Number.isFinite(span.s)&&Number.isFinite(span.e)&&span.e>span.s) totals.set(span.clipId,(totals.get(span.clipId)??0)+span.e-span.s);
  const dominant=[...totals].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0];
  if(!dominant||dominant===clip.id) return base;
  let shoot: Shoot;
  try { shoot=JSON.parse(await fs.readFile(path.join(options.root,".sidething","index.json"),"utf8")) as Shoot; }
  catch(error) { if((error as NodeJS.ErrnoException).code==="ENOENT") return base; throw error; }
  const reference=shoot.clips.find(c=>c.id===dominant);
  if(!reference) return base;
  const target=await measureSetupBase(reference,cacheDir,options.root);
  if(!gradeInputFor(reference,true).certain) return base;
  return matchMeasuredBases(base,target);
}
export function matchMeasuredBases(base: NeutralBase, target: NeutralBase): NeutralBase {
  const out={...base,gains:[...base.gains] as RGB};
  if(base.confidence>.2&&target.confidence>.2) out.gains=out.gains.map((v,c)=>clamp(v*(1+clamp(target.neutralRatios[c]*target.gains[c]/(base.neutralRatios[c]*v)-1,-.02,.02)*.5),.965,1.035)) as RGB;
  // Avoid matching a night exterior to daylight, or unmeasurable midtones.
  if(base.measuredMid>.1&&target.measuredMid>.1&&Math.max(base.measuredMid,target.measuredMid)/Math.min(base.measuredMid,target.measuredMid)<1.8)
    out.mid=clamp((target.measuredMid-base.measuredMid)*.25,-.012,.012);
  out.black=clamp((target.measuredBlack-base.measuredBlack)*.2,-.003,.003);
  return out;
}
export interface MatchMeasurement { mid: number; neutral: RGB; confidence: number }
/** Median in linear-light log space gives equal EV distance to either side. */
export function matchPieceMeasurements(measurements: MatchMeasurement[], matchRef?: number | null): PieceCorrection[] {
  validateMatchRef(matchRef);
  const selected = matchRef == null ? undefined : measurements[matchRef];
  if (matchRef != null && (!selected || !(selected.mid > .001) || !Number.isFinite(selected.mid))) throw new Error("Choose a reference clip with measured colour.");
  const usable = measurements.filter(m => m.mid > .001 && Number.isFinite(m.mid));
  const reference = selected ? Math.log2(inverse709(selected.mid)) : median(usable.map(m => Math.log2(inverse709(m.mid))));
  const neutral = selected ? selected.confidence > .2 ? selected.neutral : [0,0,0] as RGB
    : [0,1,2].map(c => median(usable.filter(m => m.confidence > .2).map(m => m.neutral[c]))) as RGB;
  return measurements.map((m, i) => {
    if (i === matchRef) return { stops: 0, rolloff: .63, matched: true };
    if (!(m.mid > .001) || !Number.isFinite(m.mid)) return { stops: 0, rolloff: .63, matched: true };
    const stops = clamp(reference - Math.log2(inverse709(m.mid)), -1, .7);
    let gains: RGB | undefined;
    if (m.confidence > .2 && neutral.every(v => v > 0) && m.neutral.every(v => v > 0)) {
      const ratios = m.neutral.map((v,c) => neutral[c] / v) as RGB;
      const norm = luma(ratios);
      gains = ratios.map(v => clamp(v / norm, .8, 1.25)) as RGB;
    }
    return { stops, rolloff: .63, matched: true, ...(gains ? { gains } : {}) };
  });
}
export function validateMatchRef(value: unknown): asserts value is number | null | undefined {
  if (value != null && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) throw new Error("Choose a valid reference clip.");
}
const matchingJobs = new Map<string, Promise<{ measurements: MatchMeasurement[]; corrections: PieceCorrection[] }>>();
async function measureMatchPiece(clip: Clip, base: NeutralBase | null, cacheDir: string, options: PieceExposureOptions): Promise<MatchMeasurement> {
  if (!base || !gradeInputFor(clip, true).certain) return { mid: 0, neutral: [1,1,1], confidence: 0 };
  const original = path.resolve(options.root, clip.file), sourceStat = await fs.stat(original);
  const times = [.15,.5,.85].map(t => options.s + (options.e - options.s) * t);
  const camera = await cameraConversionFilter(clip, cacheDir), regions = times.map(t => exposureRegion(clip, t));
  const key = createHash("sha256").update(JSON.stringify(["piece-match-v1", original, sourceStat.size, sourceStat.mtimeMs, times, regions, camera, base])).digest("hex");
  const cached = path.join(cacheDir, `match-${key}.json`);
  try { const v = JSON.parse(await fs.readFile(cached, "utf8")) as MatchMeasurement;
    if (Number.isFinite(v.mid) && Number.isFinite(v.confidence) && v.neutral?.length === 3 && v.neutral.every(n => Number.isFinite(n) && n > 0)) return v;
  } catch { /* rebuild a missing/invalid measurement */ }
  const preview = await measuredPreview(clip, options.root, camera), file = preview?.file ?? original, conversion = preview?.conversion ?? camera;
  const mids: number[] = [], pixels: RGB[] = [];
  for (const [i,t] of times.entries()) {
    const frame = await exposureFrame([...(preview ? ['-hwaccel','videotoolbox'] : exposureDecode(clip)), "-ss", String(t), "-i", file, "-vf", `${conversion},scale=64:64,format=rgb48le`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb48le", "pipe:1"]);
    const values = pixelsOf({ pixels: frame.toString("base64"), samples: [], regions: [] }).map(rgb => applyNeutralBase(rgb, base));
    pixels.push(...values);
    const r = regions[i];
    for (let y=0; y<64; y++) for (let x=0; x<64; x++) if (x/64 >= r.x && x/64 < r.x+r.w && y/64 >= r.y && y/64 < r.y+r.h) mids.push(luma(values[y*64+x]));
  }
  const measured = estimateNeutralBase(pixels);
  const value = { mid: median(mids), neutral: measured.neutralRatios.map(v => inverse709(clamp(.4*v))) as RGB, confidence: measured.confidence };
  await atomicWrite(cached, JSON.stringify(value)); return value;
}
export async function pieceColour(clip: Clip, cacheDir: string, options: PieceExposureOptions, matching: boolean, matchRef?: number | null): Promise<{ base: NeutralBase | null; exposure: PieceCorrection }> {
  validateMatchRef(matchRef);
  if (matching && matchRef != null) return referencePieceColour(clip, cacheDir, options, matchRef);
  const setup = await measureSetupBase(clip, cacheDir, options.root);
  if (!matching) return { base: gradeInputFor(clip, true).certain ? await matchCutBase(clip, setup, cacheDir, options) : null,
    exposure: gradeInputFor(clip, true).certain ? await measurePieceExposure(clip, cacheDir, options) : { stops: 0, rolloff: .63 } };
  const base = gradeInputFor(clip, true).certain ? setup : null;
  const spans = options.neighbours?.length ? options.neighbours : [{ clipId: clip.id, s: options.s, e: options.e }];
  let shoot: Shoot;
  try { shoot = JSON.parse(await fs.readFile(path.join(options.root, ".sidething", "index.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; shoot = { clips: [clip] } as Shoot; }
  const clips = new Map(shoot.clips.map(c => [c.id,c])); clips.set(clip.id,clip);
  const key = JSON.stringify([options.root, spans, await Promise.all([...clips.values()].filter(c => spans.some(s => s.clipId === c.id)).map(async c => {
    const stat = await fs.stat(path.resolve(options.root,c.file)); return [c, stat.size, stat.mtimeMs];
  }))]);
  let job = matchingJobs.get(key);
  if (!job) {
    job = (async () => {
      const measurements: MatchMeasurement[] = [];
      for (const span of spans) {
        const source = clips.get(span.clipId);
        measurements.push(source ? await measureMatchPiece(source, await measureSetupBase(source, cacheDir, options.root), cacheDir, { ...options, ...span }) : { mid: 0, neutral: [1,1,1], confidence: 0 });
      }
      return { measurements, corrections: matchPieceMeasurements(measurements) };
    })();
    remember(matchingJobs, key, job); job.catch(() => matchingJobs.delete(key));
  }
  const { corrections } = await job;
  const i = spans.findIndex(s => s.clipId === clip.id && Math.abs(s.s-options.s)<1e-5 && Math.abs(s.e-options.e)<1e-5);
  return { base, exposure: corrections[i] ?? matchPieceMeasurements([await measureMatchPiece(clip, base, cacheDir, options)])[0] };
}
/** The reference retains the complete unmatched recipe, including setup WB.
 * Measure that recipe as the target, rather than re-anchoring it to the median. */
async function referencePieceColour(clip: Clip, cacheDir: string, options: PieceExposureOptions, matchRef: number): Promise<{ base: NeutralBase | null; exposure: PieceCorrection }> {
  const spans = options.neighbours?.length ? options.neighbours : [{ clipId: clip.id, s: options.s, e: options.e }];
  const reference = spans.some(s => s.pieceIndex !== undefined) ? spans.find(s => s.pieceIndex === matchRef) : spans[matchRef];
  if (!reference) throw new Error("Choose a reference clip in this edit.");
  const referenceOptions = { ...options, s: reference.s, e: reference.e };
  if (reference.clipId === clip.id && Math.abs(reference.s - options.s) < 1e-5 && Math.abs(reference.e - options.e) < 1e-5) {
    return pieceColour(clip, cacheDir, options, false);
  }
  const shoot = JSON.parse(await fs.readFile(path.join(options.root, ".sidething", "index.json"), "utf8")) as Shoot;
  const source = shoot.clips.find(c => c.id === reference.clipId);
  if (!source) throw new Error("That reference clip is no longer in the shoot.");
  const targetColour = await pieceColour(source, cacheDir, referenceOptions, false);
  const target = await measureMatchPiece(source, targetColour.base, cacheDir, referenceOptions);
  // Unknown camera inputs have no trustworthy matching measurement.
  if (!(target.mid > .001)) throw new Error("Choose a reference clip with measured colour.");
  target.mid = expose([target.mid, target.mid, target.mid], targetColour.exposure)[0];
  const base = gradeInputFor(clip, true).certain ? await measureSetupBase(clip, cacheDir, options.root) : null;
  const measured = await measureMatchPiece(clip, base, cacheDir, options);
  return { base, exposure: matchPieceMeasurements([target, measured], 0)[1] };
}
const liveBases = new Map<string, NeutralBase | null>();
/** Register the exact matched base used by pieceGradeFilter, including identity. */
export function liveBaseId(base: NeutralBase | null): string {
  const hash = createHash("sha256").update(JSON.stringify(base)).digest("hex");
  remember(liveBases, hash, structuredClone(base));
  return `base:${hash}`;
}
// Recipes are small and immutable; cubes are held only by the bounded worker cache.
const pieceRecipes = new Map<string, { base: NeutralBase | null; grade: LookGrade; exposure: NonNullable<LutOptions["pieceExposure"]>; wholeGrade?: LookGrade; pieceLook?: PieceLook | null }>();
const remember = <T>(cache: Map<string, T>, key: string, value: T): T => {
  cache.delete(key); cache.set(key, value);
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  return value;
};
/** Tetrahedral sampling of the finishing tables, red fastest. The six cases
 * follow the descending fractional coordinates, including the upper boundary. */
function tetrahedralCoordinates(rgb: RGB, size: number): number[] {
  const p = rgb.map(v => clamp(v) * (size - 1));
  const lo = p.map(v => Math.min(size - 2, Math.floor(v)));
  const f = p.map((v, i) => v - lo[i]);
  const order = [0, 1, 2].sort((a, b) => f[b] - f[a]);
  const at = (v: number[]) => ((v[2] * size + v[1]) * size + v[0]) * 3;
  const a = at(lo), v = [...lo]; v[order[0]]++; const b = at(v);
  v[order[1]]++; const c = at(v); v[order[2]]++; const d = at(v);
  return [a, b, c, d, f[order[0]], f[order[1]], f[order[2]]];
}
export function sampleTetrahedral(data: number[], rgb: RGB, size = LUT_SIZE): RGB {
  const [a,b,c,d,x,y,z] = tetrahedralCoordinates(rgb, size);
  return [0, 1, 2].map(i => data[a+i] + x * (data[b+i]-data[a+i])
    + y * (data[c+i]-data[b+i]) + z * (data[d+i]-data[c+i])) as RGB;
}
/** Resample the actual finishing stages after camera conversion. Using the
 * same evaluators AND table interpolation preserves their order/custom controls. */
export function livePieceId(base: NeutralBase | null, grade: LookGrade, exposure: NonNullable<LutOptions["pieceExposure"]>, wholeGrade?: LookGrade, pieceLook?: PieceLook | null): string {
  // Registration is cheap; a frame/export asks the worker for the cube on demand.
  const recipe = { base, grade, exposure, wholeGrade, pieceLook };
  const normalized = clampGrade({...grade,input:"rec709"});
  const {matchClips: _matching, matchRef: _reference, look: _words, ...controls} = normalized;
  const id = `piece:${createHash("sha256").update(JSON.stringify({base,grade:{...controls,basic:normalizeBasic(grade.basic),mixer:normalizeMixer(grade.mixer)},exposure})).digest("hex")}`;
  const previous=pieceRecipes.get(id);
  pieceRecipes.set(id, structuredClone({...recipe,wholeGrade:wholeGrade ?? previous?.wholeGrade,pieceLook:pieceLook === undefined ? previous?.pieceLook : pieceLook}));
  if (pieceRecipes.size > 8192) pieceRecipes.delete(pieceRecipes.keys().next().value!);
  return id;
}
/** Small immutable stage description. No cube construction or serialisation. */
export async function liveGrade(id: string) {
  const recipe = pieceRecipes.get(id); if (!recipe) return null;
  const g = clampGrade({ ...recipe.grade, input: "rec709" });
  const baseId = `uniform-base:${JSON.stringify(recipe.base)}`;
  const presetId = `look:${g.preset}`;
  return { baseId, presetId, grade: g, exposure: recipe.exposure, wholeGrade: recipe.wholeGrade, pieceLook: recipe.pieceLook };
}
/** Same 33³ samples/decimal precision/order as the finishing .cube files. */
// OPEN1: live tables run on the colour workers kept for the live player (grade-work.ts), not behind export work.
export async function liveLut(id: string): Promise<{ size: number; data: number[] }> {
  if (id.startsWith("piece:")) {
    const recipe = pieceRecipes.get(id);
    if (!recipe) throw new Error("That piece LUT has expired. Reload the cut timeline.");
    const table = await gradeWork({ kind: "piece", ...recipe }, { live: true });
    return { size: table.size, data: Array.from(table.data) };
  }
  if (id.startsWith("uniform-base:")) {
    const table = await gradeWork({kind:"base",base:JSON.parse(id.slice(13)),grade:neutralGrade("rec709")},{live:true});
    return {size:table.size,data:Array.from(table.data)};
  }
  if (id.startsWith("base:")) {
    const base = liveBases.get(id.slice(5));
    if (base === undefined) throw new Error("That setup LUT has expired. Reload the cut timeline.");
    const table = await gradeWork({kind:"base",base,grade:neutralGrade("rec709")},{live:true});
    return {size:table.size,data:Array.from(table.data)};
  } else if (id.startsWith("look:") && isLookPreset(id.slice(5))) {
    const grade = clampGrade({ ...neutralGrade("rec709"), preset: id.slice(5), intensity: 1 });
    const table = await gradeWork({kind:"preset",grade},{live:true});
    return {size:table.size,data:Array.from(table.data)};
  } else throw new Error("Unknown live LUT.");
}
export async function neutralBaseCube(base: NeutralBase, cacheDir: string): Promise<string> {
  const table=await gradeWork({kind:'base',base,grade:neutralGrade('rec709')});
  const data=table.cube!;
  const hash=liveBaseId(base).slice(5);
  const file=path.join(cacheDir,`neutral-${hash}.cube`);
  let existing='';try{existing=await fs.readFile(file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  await keepCube(file,existing,data);
  return file;
}
export async function neutralBaseFilter(base: NeutralBase, cacheDir: string): Promise<string> {
  return `lut3d=file=${filterValue(await neutralBaseCube(base, cacheDir))}:interp=tetrahedral,format=gbrp16le`;
}
/** Decode YCbCr before the camera LUT. Published log equations use nominal
 * CV/1023. Decode log Y codes without expanding their black/white pedestal.
 * For limited YCbCr, legal chroma spans 896 codes versus luma's 876 (BT.709
 * digital representation); scale the decoded chroma by 876/896 about Y'.
 * This explicit RGB matrix avoids swscale ignoring out_range=tv on RGB. */
export async function cameraConversionFilter(clip: ColourClip, cacheDir: string): Promise<string> {
  const input=gradeInputFor(clip),colour=clip.colour ?? {};
  const hdr=input==="hlg"||input==="pq";
  const wide=/2020/.test(colour.matrix??"")||hdr||input==="apple-log";
  const matrix=wide ? "bt2020" : "bt709";
  const isLog=!["rec709","unknown","srgb","hlg","pq"].includes(input);
  const sourceRange=isLog||colour.range==="pc" ? ":in_range=full" : colour.range==="tv" ? ":in_range=tv" : "";
  let chromaRange="";
  if (isLog&&colour.range==="tv") {
    const k=876/896,weights=wide?[.2627,.6780,.0593]:[.2126,.7152,.0722];
    const names=[["rr","rg","rb"],["gr","gg","gb"],["br","bg","bb"]];
    chromaRange=",colorchannelmixer="+names.flatMap((row,i)=>row.map((name,j)=>`${name}=${(1-k)*weights[j]+(i===j?k:0)}`)).join(":");
  }
  return `scale=in_color_matrix=${matrix}${sourceRange}:out_range=full,format=gbrp16le${chromaRange},lut3d=file=${filterValue(await buildLut(input,{cacheDir}))}:interp=tetrahedral,format=gbrp16le`;
}

/** The finishing compositor uses this for both draft and full-size renders.
 * Keep exportLut independent: a clip LUT must never bake a span's correction.
 * EXP2 tried composing the camera, neutral-base and look cubes into one cube here:
 * preparation grew by about 54 s (one JS worker job per piece) and the finished
 * frames moved by up to 1.11/255 mean, over the 1/255 bar. The passes stay separate. */
export async function pieceGradeFilter(clip: Clip, grade: LookGrade, cacheDir: string, options: PieceExposureOptions): Promise<string> {
  const { base, exposure: correction } = await pieceColour(clip, cacheDir, options, grade.matchClips === true, grade.matchRef);
  const neutral = base ? `${await neutralBaseFilter(base, cacheDir)},` : "";
  return `${await cameraConversionFilter(clip, cacheDir)},${neutral}${await gradeFilter({ ...grade, input: "rec709" }, { cacheDir, pieceExposure: correction })}`;
}

export interface BasicMeasurement {
  histogram: number[]; mid: number; target: number; weight: number;
  neutral: RGB; confidence: number;
}
/** Cheap reads of three small converted proxy frames. Original fallback is
 * camera converted; cached pixels are reusable across pieces and Auto clicks. */
export async function measureBasicHistogram(clip: Clip, cache: string, options: PieceExposureOptions,
  base: NeutralBase | null, exposure: { stops: number; rolloff: number; after?: number }): Promise<BasicMeasurement> {
  const proxyDir = path.resolve(options.root, ".sidething/proxies");
  const proxy = clip.proxy ? path.resolve(proxyDir, clip.proxy) : "";
  if (proxy && !proxy.startsWith(proxyDir + path.sep)) throw new Error("Preview outside cache.");
  const source = path.resolve(options.root, clip.file);
  let file = source, conversion = "";
  if (proxy && await fs.stat(proxy).then(s => s.size > 0).catch(() => false)) file = proxy;
  else conversion = await cameraConversionFilter(clip, cache);
  const stat = await fs.stat(file), sourceStat = await fs.stat(source);
  const duration = clip.meta?.durationS ?? options.e;
  const times = [.15, .5, .85].map(t => Math.max(0, Math.min(duration - .04, duration * t)));
  const key = createHash("sha256").update(JSON.stringify({ revision: 1, file, size: stat.size, mtime: stat.mtimeMs,
    sourceSize: sourceStat.size, sourceMtime: sourceStat.mtimeMs, conversion, times })).digest("hex");
  const cached = path.join(cache, `basic-samples-${key}.json`);
  let sample: ExposureSample | undefined;
  try {
    const value = JSON.parse(await fs.readFile(cached, "utf8")) as ExposureSample;
    if (value.pixels && Buffer.from(value.pixels, "base64").length === times.length * 64 * 64 * 6) sample = value;
  } catch { /* missing/corrupt local cache */ }
  if (!sample) {
    const frames: Buffer[] = [];
    for (const t of times) frames.push(await exposureFrame([...exposureDecode(clip), "-ss", String(t), "-i", file, "-vf",
      `${conversion ? conversion + "," : ""}scale=64:64,format=rgb48le`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb48le", "pipe:1"]));
    sample = { pixels: Buffer.concat(frames).toString("base64"), samples: times, regions: [] };
    await atomicWrite(cached, JSON.stringify(sample));
  }
  const histogram = Array<number>(256).fill(0);
  for (const rgb of pixelsOf(sample)) {
    const corrected = expose(base ? applyNeutralBase(rgb, base) : rgb, exposure);
    histogram[Math.round(clamp(luma(corrected)) * 255)]++;
  }
  const middle = histogramQuantile(histogram, .5);
  // Existing face measurement already includes the automatic per-piece EV.
  const mid = exposure.after && exposure.after > .01 ? exposure.after : middle;
  return { histogram, mid, target: SKIN_TARGET_BY_KEY[sceneKey(middle)], weight: options.e - options.s,
    neutral: base ? base.neutralRatios.map((v, c) => v * base.gains[c]) as RGB : [1, 1, 1], confidence: base?.confidence ?? 0 };
}
function histogramQuantile(histogram: number[], fraction: number): number {
  const count = histogram.reduce((n, v) => n + v, 0);
  let sum = 0;
  for (let i = 0; i < histogram.length; i++) { sum += histogram[i]; if (sum >= count * fraction && sum > 0) return i / (histogram.length - 1); }
  return 0;
}
/** Deterministic duration-weighted global recommendation; no current Basics
 * are fed back in, so repeated Auto does not compound corrections. */
export function estimateAutoBasic(measurements: BasicMeasurement[]): BasicAdjust {
  const basic = normalizeBasic();
  const usable = measurements.filter(m => m.weight > 0 && m.mid > .01 && m.histogram.length === 256 && m.histogram.some(v => v > 0));
  if (!usable.length) return basic;
  const weight = usable.reduce((n, m) => n + m.weight, 0);
  const histogram = Array<number>(256).fill(0);
  let ev = 0, temp = 0, tint = 0;
  for (const m of usable) {
    const w = m.weight / weight, count = m.histogram.reduce((n, v) => n + v, 0);
    m.histogram.forEach((v, i) => { histogram[i] += v / count * w; });
    ev += Math.log2(basicLinear(m.target) / basicLinear(m.mid)) * w;
    // Invert the same linear-light WB gains as the manual controls, using
    // measured neutral ratios after the setup's existing gentle correction.
    const neutral = m.neutral.map(v => Math.max(.001, basicLinear(clamp(.4 * v))));
    const logs = neutral.map(v => Math.log2(v));
    temp += (logs[2] - logs[0]) / .7 * 100 * m.confidence * w;
    tint += (logs[1] - (logs[0] + logs[2]) / 2) / .36 * 100 * m.confidence * w;
  }
  const high = histogramQuantile(histogram, .998), low = histogramQuantile(histogram, .01);
  // Keep practically all measured pixels below white. No exposure boost for
  // empty/black frames; clipped originals cannot be recovered by this panel.
  if (high > 0) ev = Math.min(ev, Math.log2(basicLinear(.99) / basicLinear(high)));
  basic.exposure = clamp(ev, -2, 2);
  const top = basicDisplay(basicLinear(high) * 2 ** basic.exposure);
  const bottom = basicDisplay(basicLinear(low) * 2 ** basic.exposure);
  const mask = (v: number) => { const t = clamp((v - .35) / .65); return t * t * (3 - 2 * t); };
  basic.whites = clamp((.97 - top) / Math.max(.05, .25 * mask(top)) * 100, -60, 60);
  const shadow = 1 - (() => { const t = clamp(bottom / .65); return t * t * (3 - 2 * t); })();
  basic.blacks = clamp((.01 - bottom) / Math.max(.05, .2 * shadow) * 100, -60, 60);
  basic.temperature = clamp(temp, -40, 40); basic.tint = clamp(tint, -40, 40);
  return normalizeBasic(Object.fromEntries(Object.entries(basic).map(([k, v]) => [k, Math.round(v * 1000) / 1000])));
}

export function pieceExposureNote(exposure: PieceExposure): string {
  return `Exposure ${exposure.stops >= 0 ? "+" : ""}${exposure.stops.toFixed(3)} stops before look; rolloff ${exposure.rolloff.toFixed(2)}; face luma ${exposure.before.toFixed(3)} → ${exposure.after.toFixed(3)}. Clip LUT is neutral to piece exposure.`;
}
export function pieceExposureReadmeTable(pieces: { clipId: string; s: number; e: number; exposure: PieceExposure }[]): string {
  return ["Clip | Source in–out (s) | Exposure (stops) | Rolloff | Face luma before → after",
    ...pieces.map(p => `${p.clipId} | ${p.s.toFixed(3)}–${p.e.toFixed(3)} | ${p.exposure.stops.toFixed(3)} | ${p.exposure.rolloff.toFixed(2)} | ${p.exposure.before.toFixed(3)} → ${p.exposure.after.toFixed(3)}`)].join("\n");
}

async function gradeLut(grade: CameraGrade, options: LutOptions): Promise<string> {
  const g = clampGrade({ ...grade, input: validInput(grade.input as GradeInput) });
  const input = CAMERA_INPUTS.includes(grade.input) ? grade.input : "unknown";
  const table = await gradeWork({ kind: "finish", grade: {...g,input}, exposure: options.pieceExposure });
  const data = `TITLE "Precut ${input} clean + ${g.preset} v4"\n${table.cube!}`;
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 20);
  const file = path.resolve(options.cacheDir ?? await defaultCacheDir(), `grade-${hash}.cube`);
  let existing: string | undefined;
  try { existing = await fs.readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await keepCube(file, existing, data);
  return file;
}
/** Original full-range camera RGB -> clean base -> fixed look + word controls.
 * One 16-bit LUT path is shared by thumbnails, drafts, finishing and exports. */
export async function gradeFilter(grade: CameraGrade, options: LutOptions = {}): Promise<string> {
  return `lut3d=file=${filterValue(await gradeLut(grade, options))}:interp=tetrahedral,format=gbrp16le`;
}

async function promptFile(): Promise<string> {
  const candidates = [path.join(process.cwd(), "prompts", "grade.md")];
  if (typeof __dirname !== "undefined") candidates.push(
    path.join(__dirname, "..", "..", "prompts", "grade.md"),
    path.join(__dirname, "..", "..", "..", "prompts", "grade.md"));
  for (const file of candidates) {
    try { return await fs.readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error("The grade prompt (prompts/grade.md) is missing.");
}

/** No look: zero calls. A look: exactly one call through the configured CLI.
 * Optional dependencies make the one-call boundary testable without a login.
 */
export async function gradeFromLook(look: string | null | undefined, input: GradeInput, options: LookOptions = {}): Promise<Grade> {
  const neutral = neutralGrade(input);
  if (!look?.trim()) return neutral;
  const instructions = await promptFile();
  const run = options.runModel ?? (await import("./ai")).runModel;
  const engine = options.engine ?? await (await import("./settings")).getEngine();
  const raw = await run({ engine, cwd: options.cwd ?? process.cwd(), images: [],
    prompt: `${instructions}\n\nRequest (JSON data):\n${JSON.stringify({ input: neutral.input, look })}` });
  let data: unknown;
  try { data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")); }
  catch { throw new Error("The grade model did not return valid JSON."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The grade model did not return a grade object.");
  const values = data as Record<string, unknown>;
  for (const key of Object.keys(GRADE_BOUNDS)) {
    if (typeof values[key] !== "number" || !Number.isFinite(values[key])) throw new Error(`The grade model returned an invalid ${key}.`);
  }
  // Input conversion and original words are NEVER delegated to the model.
  return clampGrade({ ...neutral, exposure: values.exposure as number, contrast: values.contrast as number,
    saturation: values.saturation as number, temperature: values.temperature as number, tint: values.tint as number, look });
}

/** Editor export uses the exact same sampled transform as playback. */
export async function exportLut(grade: CameraGrade, outputPath: string, options: LutOptions = {}): Promise<string> {
  const output = path.resolve(outputPath);
  await atomicWrite(output, await fs.readFile(await gradeLut(grade, { cacheDir: options.cacheDir }), "utf8"));
  return output;
}

export interface LookPreviewOptions { intensity?: number; preset?: string; width?: number; height?: number; end?: number; adjustments?: Grade }
export interface LookPreview { id: string; name: string; description: string; family: GalleryLook["family"]; image: string; still?: string }
const previewJobs = new Map<string, Promise<LookPreview[]>>();
function renderFrame(args: string[]): Promise<void> {
  const signal = currentActivity()?.signal;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(tool("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", "-threads", String(threads(2)), "-filter_threads", "1", ...args], { stdio: ["ignore", "ignore", "pipe"], signal });
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Couldn't render the look frame: ${stderr}`)); });
  });
}
/** Read source media only; cache thumbnails by source fingerprint, time, look
 * numbers and intensity. Optional fourth argument also supplies a framed stage
 * still. The three-argument gallery API remains suitable for setup. */
type SampleFrame = "daylight" | "warm" | "night" | "skyline";
const sampleFiles = { daylight: daylightSample, warm: warmSample, night: nightSample, skyline: skylineSample };
export async function renderSampleLooks(sample: SampleFrame, preset?: LookPreset): Promise<LookPreview[]> {
  if (!Object.hasOwn(sampleFiles, sample)) throw new Error("Choose Daylight, Warm or Night.");
  // The sample tiles are what the person is looking at in an open Look panel, so they go ahead of background colour work.
  return previewActivity("", "", () => renderPreviewGallery("", "", 0, preset ? { preset } : {}, sample, true), "draft");
}
export async function renderLookPreviews(root: string, clipId: string, t: number, options: LookPreviewOptions = {}): Promise<LookPreview[]> {
  return previewActivity(root, clipId, () => renderPreviewGallery(root, clipId, t, options));
}
function previewActivity(root: string, clipId: string, work: () => Promise<LookPreview[]>, lane: "draft" | "background" = "background"): Promise<LookPreview[]> {
  return runActivity({ kind: "looks", root: root || null, target: clipId ? { clipId } : null, label: "Preparing look previews", cancelable: true },
    activity => withRenderSlot(activity, work, lane), { renderLane: lane });
}
async function renderPreviewGallery(root: string, clipId: string, t: number, options: LookPreviewOptions, sampleId: SampleFrame = "daylight", tileOnly = false): Promise<LookPreview[]> {
  if (!Number.isFinite(t) || t < 0) throw new Error("Choose a valid frame time.");
  if (options.preset !== undefined && !isLookPreset(options.preset)) throw new Error("Choose a look from the gallery.");
  const sample = !root && !clipId;
  const shoot = sample ? null : JSON.parse(await fs.readFile(path.join(path.resolve(root), ".sidething", "index.json"), "utf8")) as Shoot;
  const clip = shoot?.clips.find(entry => entry.id === clipId);
  if (!sample && !clip) throw new Error("That clip is no longer in the shoot.");
  const { app } = await import("electron");
  // Node can stat an asar asset, but the external encoder needs its real file.
  const sampleAsset = sampleFiles[sampleId];
  const sampleFile = app.isPackaged ? sampleAsset.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2") : sampleAsset;
  const file = sample ? sampleFile : path.resolve(root, clip!.file), stat = await fs.stat(file);
  const time = sample ? 0 : Math.min(t, Math.max(0, (clip!.meta?.durationS ?? t + 1) - .04));
  const intensity = lookIntensity(options.intensity);
  const key = createHash("sha256").update(JSON.stringify({ file, size: stat.size, mtime: stat.mtimeMs, time, options: { ...options, intensity }, tileOnly, looks: LOOKS, version: 5 })).digest("hex");
  const pending = previewJobs.get(key);
  if (pending) return pending;
  const job = (async () => {
    // App cache rather than the source drive: removable shoots can be read-only.
    const cache = path.join(app.getPath("userData"), "look-previews");
    await fs.mkdir(cache, { recursive: true });
    const baseKey = createHash("sha256").update(JSON.stringify({ file, size: stat.size, mtime: stat.mtimeMs, time, version: 4 })).digest("hex");
    const base = path.join(cache, `${baseKey}-clean.png`);
    const exists = async (f: string) => { try { return (await fs.stat(f)).size > 0; } catch { return false; } };
    const { clipGradeFilter, previewFraming } = await import("./preview");
    if (!await exists(base)) {
      const temp = `${base}.${randomUUID()}.png`;
      try {
        // The bundled JPEG already contains the neutral camera conversion.
        let filter = "scale=960:-2";
        if (clip) {
          await readGradeMetadata(clip, root, cache);
          const setupBase = await measureSetupBase(clip, cache, root);
          filter = `${await clipGradeFilter(clip, neutralGrade("unknown"), cache)},${await neutralBaseFilter(setupBase, cache)},${filter}`;
        }
        await renderFrame([...(sample ? [] : ["-ss", String(time)]), "-i", file, "-vf", filter, "-frames:v", "1", "-pix_fmt", "rgb48be", temp]);
        await fs.rename(temp, base);
      } finally { await fs.rm(temp, { force: true }); }
    }
    const result: LookPreview[] = [];
    // Sequential encodes keep gallery work bounded on a laptop.
    for (const entry of options.preset ? LOOKS.filter(entry => entry.id === options.preset) : LOOKS) {
      currentActivity()?.signal.throwIfAborted();
      const image = path.join(cache, `${key}-${entry.id}.jpg`);
      const filter = await gradeFilter({ ...neutralGrade("rec709"), ...options.adjustments,
        input: "rec709", preset: entry.id, intensity, look: null }, { cacheDir: cache });
      if (!await exists(image)) {
        const temp = `${image}.${randomUUID()}.jpg`;
        try { await renderFrame(["-i", base, "-vf", `${filter},scale=160:160:force_original_aspect_ratio=increase,crop=160:160`, "-frames:v", "1", "-q:v", "3", temp]); await fs.rename(temp, image); }
        finally { await fs.rm(temp, { force: true }); }
      }
      const item: LookPreview = { id: entry.id, name: entry.name, description: entry.description, family: entry.family, image: `data:image/jpeg;base64,${(await fs.readFile(image)).toString("base64")}` };
      if (entry.id === options.preset && !tileOnly) {
        const w = 960, ratio = (options.height ?? 9) / (options.width ?? 16);
        if (!Number.isFinite(ratio) || ratio < .2 || ratio > 5) throw new Error("Choose a valid preview shape.");
        const h = Math.round(w * ratio / 2) * 2, still = path.join(cache, `${key}-stage.jpg`);
        if (!await exists(still)) {
          const temp = `${still}.${randomUUID()}.jpg`;
          try {
            const framing = clip ? previewFraming(clip, time, options.end ?? time + .04, { w, h }, "look", "framed")
              : [`[look]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}[framed]`];
            await renderFrame(["-i", base, "-filter_complex", `[0:v]${filter}[look];${framing.join(";")}`, "-map", "[framed]", "-frames:v", "1", "-q:v", "3", temp]);
            await fs.rename(temp, still);
          } finally { await fs.rm(temp, { force: true }); }
        }
        item.still = `data:image/jpeg;base64,${(await fs.readFile(still)).toString("base64")}`;
      }
      result.push(item);
    }
    return result;
  })();
  previewJobs.set(key, job);
  try { return await job; } finally { previewJobs.delete(key); }
}

/** Delivery copies the actual finishing tables, including measured per-span
 * correction. A composed table is also supplied for editors with one LUT slot. */
export async function editorPieceLuts(clip: Clip, grade: LookGrade, cacheDir: string, options: PieceExposureOptions) {
  clip = structuredClone(clip); // metadata measurement must not mutate the saved edit
  const { base, exposure } = await pieceColour(clip,cacheDir,options,grade.matchClips===true,grade.matchRef);
  const conversion = await buildLut(gradeInputFor(clip),{cacheDir});
  const balance = base ? (await neutralBaseFilter(base,cacheDir),path.join(cacheDir,`neutral-${liveBaseId(base).slice(5)}.cube`)) : null;
  const finish = await gradeLut({...grade,input:'rec709'},{cacheDir,pieceExposure:exposure});
  const stages = [conversion,...balance ? [balance] : [],finish];
  const table = await gradeWork({kind:"compose",grade:neutralGrade("rec709"),files:stages});
  const composed = `TITLE "precut per-piece camera, balance and look"\n${table.cube!}`;
  return {stages,composed};
}
