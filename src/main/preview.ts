import { clipTransformGraph, clipTransformMorphGraph, transformAspects } from './transform-render';
import { canVideoToolboxDecode } from './video-decode';
import { finishingRaster, morphRaster, rasterFilter, regionFraming } from './finish-raster';
import { musicStems, pieceSoundSettings, STEM_NAMES } from './stem-mix';
import { musicDuckKeys, stemDuckKeys } from '../shared/music-duck';
import { balancedLook } from "../shared/clip-balance";
import { clipDuckDb, cutMusicKeys } from './music-duck';
import { musicDuckFilter } from '../shared/music-duck';
import { attachedClipSounds, audibleClipBleeps } from './clip-sound';
import { sourceAudio, sourceAudioInput, mapSourceAudioGraph } from './source-audio';
import { voiceoverAudio } from './voiceover-audio';
import { JOIN_FADE_S, voiceJoinFades } from '../shared/voice-edit';
import { activeBackground } from './backgrounds';
import { isLayoutCamera } from '../shared/layout-presets';
import { titleCardColour, splitLayoutTransitions, layoutDecodeGroups } from './layout-math';
import { anglePictures, angleFxPiece } from './angles';
import { presentTitles } from './titles/ul1';
import { layoutPictures, appendLayoutComposite } from './layouts';
import type { LayoutPicture } from './layout-math';
import { layoutGradeFilters } from './layout-colour';
import { appendBleeps, bleepVoiceLevel, duckingFilter } from './audio';
import { audioSpan, joinAudioMix } from './audio';
import { detailGraph, detailActive, NO_DETAIL } from "../renderer/src/components/finish/detailMath";
import { prepareGrainPlate } from "./grain";
import { grainGraph } from "../renderer/src/components/finish/grainMath";
import { reverseVideoFilter } from './reverse';
import { tempoChain } from "./music-space";
import { tool } from "./tools";
import { cutFrame } from "../shared/frame-rate";
import { playableMusic } from "./music-file";
// Draft pictures decode lifted proxies; matched voice uses the recorder WAV.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bundledFile, checkoutFile } from "./bundle-paths";
import { createHash, randomUUID } from "node:crypto";
import { renderNotes } from "./render-notes";
import { app, BrowserWindow } from "electron";
import type { Clip, CutVersion, DraftTimeline, Grade, SubjectSample, Template } from "../shared/schema";
import { clipRotation, clipRotationFilter, clipFileDimensions, displayedClip } from "../shared/media";
import type { CutItem } from "./export";
import type { ReelAssembly } from "./reel";
import { cropXExpression, energyBeats, energyFraming, energyScaleAt, energyZoomFilter, type Energy, type EnergyBeat, type EnergyFraming, framingPlans, framingReference, motionFramingFilter, motionRectAt } from "./framing";
import { framingMotion } from "./motion";
import { laneDb, laneMuted } from '../shared/lane-levels';
import { getPreferences } from "./settings";
import { currentActivity, runActivity, threads } from "./activity";
import { gradeFilter, neutralGrade, gradeForLook, gradeForPiece, cameraConversionFilter, pieceGradeFilter } from "./grade";
import { DEFAULT_AUDIO_FINISH, normalizeAudio, voiceFilter, prepareVoicePiece, loudnessFilter, measureLoudness, type PreparedVoice, type LoudnessMeasurement } from "./audio";
import { measureSourceAudio } from "./voice-isolation";
import { planFx, joinChoices, fxPictures, fxSetpts, fxAudioSegments, type FxItem, type FxPlan, type FxVersion } from "./edits-fx";
import { soundDuration } from "./sfx";
import { prepareDesignSounds, type PreparedEffect } from "./sound-design";
import { renderTitleTrack, titleStream } from "./titles/render";

/**
 * H.264 settings for the compositor's video. The finished file (`full`) is constant quality: VideoToolbox sets the
 * rate from the picture, so a 4K or 60 fps export gets more bits than 720p30 and a still shot gets fewer, where one
 * fixed number was 43 Mbps for everything. 70 measured VMAF 94.8 (worst second 89.8) against a near-lossless source at
 * 21 Mbps for 1080x1920 at 59.9 fps, about half the old 40M file, with frames that look the same at 100% (the creator chose it
 * over 72, 27 Oct; qa/EXP1/SIZE-REPORT.md, qa/EXP1/q70-frames). A -maxrate would
 * switch VideoToolbox back to average-bitrate mode and lose that, so none is set. Drafts stay at a flat 4M.
 */
export function videoEncodeArgs(full: boolean): string[] {
  return ["-c:v", "h264_videotoolbox", "-profile:v", "high", ...(full ? ["-q:v", "70"] : ["-b:v", "4M"])];
}

export interface PreviewOptions {
  name: string; // precut folder basename, without the video extension
  template: Pick<Template, "width" | "height" | "fps">;
  music?: { file: string; startS: number; gainDb: number };
  energy?: Energy;
}

type FrameRect = { x: number; y: number; w: number; h: number };
export type CutFraming = EnergyFraming & { match?: { from: FrameRect; duration: number } };
const bounded = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));

/** Original source pixels. Both players evaluate this same continuous plan. */
export function framingRectAt(plan: CutFraming, t: number): FrameRect | null {
  if (plan.rects) return motionRectAt(plan.rects, t);
  const crop = plan.crop;
  if (!crop) return null;
  let x = crop.x;
  const keys = crop.keyframes;
  if (keys?.length) {
    const i = keys.findIndex(k => k.t >= t);
    if (i <= 0) x = keys[i < 0 ? keys.length - 1 : 0].x;
    else {
      const a = keys[i - 1], b = keys[i], u = bounded((t - a.t) / (b.t - a.t), 0, 1), edge = .15;
      const eased = u < edge ? u * u / (2 * edge * (1 - edge)) : u > 1 - edge ?
        1 - (1 - u) ** 2 / (2 * edge * (1 - edge)) : (u - edge / 2) / (1 - edge);
      x = a.x + (b.x - a.x) * eased;
    }
  }
  const scale = energyScaleAt(plan, t), w = crop.w / scale, h = crop.h / scale;
  const rect = { x: x + plan.x * (crop.w - w), y: crop.y + plan.y * (crop.h - h), w, h };
  if (plan.match) {
    const u = plan.match.duration ? bounded(t / plan.match.duration, 0, 1) : 0, ease = u * u * (3 - 2 * u);
    for (const key of ["x", "y", "w", "h"] as const) rect[key] = plan.match.from[key] + (rect[key] - plan.match.from[key]) * ease;
  }
  return rect;
}

function faceAt(clip: Clip, t: number): SubjectSample | undefined {
  const valid = (clip.subject?.samples ?? []).filter(p => (p.kind === "face" || p.kind === "body") &&
    [p.t, p.x, p.y, p.w, p.h].every(Number.isFinite) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 && p.w > 0 && p.w <= 1 && p.h > 0 && p.h <= 1);
  const kind = valid.some(p => p.kind === "face") ? "face" : "body";
  const track = valid.filter(p => p.kind === kind).sort((a, b) => a.t - b.t);
  if (!track.length) return undefined;
  const i = track.findIndex(p => p.t >= t);
  let p = track[i < 0 ? track.length - 1 : i];
  if (i > 0) {
    const a = track[i - 1], u = (t - a.t) / (p.t - a.t);
    p = { ...p, x: a.x + (p.x - a.x) * u, y: a.y + (p.y - a.y) * u,
      w: a.w + (p.w - a.w) * u, h: a.h + (p.h - a.h) * u };
  }
  return kind === "face" ? p : { ...p, y: p.y - p.h * .35, w: p.w * .6, h: p.h * .32 };
}

/** Match consecutive talking cuts, including filler edits. B-roll and gaps
 * break the run. Geometry stays inside the original frame, without a model. */
export function cutFraming(cuts: CutItem[], fps: number, out: { w: number; h: number }, energy: Energy = "subtle", faceMatch: CutVersion["faceMatch"] = "ease"): (CutFraming | undefined)[] {
  const beats = energyBeats(cuts, fps), plans: (CutFraming | undefined)[] = [];
  cuts.forEach((cut, i) => {
    if (!cut.seg) { plans.push(undefined); return; }
    const start = cut.inFrames / (cut.clipFpsR.num / cut.clipFpsR.den), length = cut.durTimelineFrames / fps;
    const plan: CutFraming = energyFraming(cut.seg.clip, start, start + length, out, energy, beats[i]);
    // J4 owns cut masking and emphasis punches in the shared final rect plan.
    plan.scale = 1; plan.push = 0;
    plans.push(plan);
    const previous = cuts[i - 1], oldPlan = plans[i - 1];
    if (faceMatch === "off" || out.h <= out.w || !plan.crop || !oldPlan || !previous?.seg || cut.seg.lineIndex === null || previous.seg.lineIndex === null) return;
    const oldStart = previous.inFrames / (previous.clipFpsR.num / previous.clipFpsR.den);
    const last = Math.max(0, (previous.durTimelineFrames - 1) / fps);
    const a = faceAt(previous.seg.clip, oldStart + last), b = faceAt(cut.seg.clip, start), old = framingRectAt(oldPlan, last);
    if (!a || !b || !old) return;
    const oldMeta = previous.seg.clip.meta!, meta = cut.seg.clip.meta!;
    const screenX = (a.x * oldMeta.width - old.x) / old.w, screenY = (a.y * oldMeta.height - old.y) / old.h;
    const desiredH = b.h * meta.height / (a.h * oldMeta.height / old.h);
    const h = bounded(desiredH, Math.min(plan.crop.h, out.h / 1.5), plan.crop.h), w = h * out.w / out.h;
    plan.match = { from: { x: bounded(b.x * meta.width - screenX * w, 0, meta.width - w),
      y: bounded(b.y * meta.height - screenY * h, 0, meta.height - h), w, h }, duration: faceMatch === "snap" || energy === "off" ? 0 : .6 };
  });
  return plans;
}

/** Select matching per spine join, leaving transcript sub-item joins intact. */
export function joinFraming(cuts: CutItem[], fps: number, out: { w: number; h: number }, energy: Energy,
  version: FxVersion & Pick<CutVersion, "framing"> = {}, motions = new Map<string, import("./motion").MotionAnalysis>(), reference = out) {
  const choices = joinChoices(cuts, version);
  const modes = new Map<string, (CutFraming | undefined)[]>();
  const plansFor = (mode: "off" | "snap" | "ease") => {
    if (!modes.has(mode)) modes.set(mode, framingPlans({ plan: cutFraming, at: framingRectAt }, cuts, fps, out, energy, mode, version, motions, reference));
    return modes.get(mode)!;
  };
  let j = 0;
  return cuts.map((cut, i) => {
    let mode = version.faceMatch ?? "ease";
    if (i && (cut.piece ?? i) !== (cuts[i - 1].piece ?? i - 1)) {
      const kind = choices[j++].choice.kind;
      mode = kind === "snap" || kind === "ease" ? kind : "off";
    }
    return plansFor(mode)[i];
  });
}

// Render the same rect as framingRectAt. A maximal aspect crop supplies enough
// pixels for zoompan; its moving origin keeps every smaller rect inside it.
function matchedFramingFilter(clip: Clip, plan: CutFraming, out: { w: number; h: number }, fps: number, grade?: string): string {
  const crop = plan.crop!, meta = clip.meta!, match = plan.match!;
  const u = `clip((t+${plan.elapsed})/${plan.duration},0,1)`;
  const scale = `(${plan.scale}*(1+${plan.push}*(${u})*(${u})*(3-2*(${u}))))`;
  const w = `(${crop.w}/${scale})`, h = `(${crop.h}/${scale})`;
  const target = { x: `((${cropXExpression(crop)})+${plan.x}*(${crop.w}-${w}))`,
    y: `(${crop.y}+${plan.y}*(${crop.h}-${h}))`, w, h };
  const v = `clip(t/${match.duration || 1},0,1)`, ease = match.duration ? `((${v})*(${v})*(3-2*(${v})))` : "0";
  const rect = Object.fromEntries((["x", "y", "w", "h"] as const).map(k => [k, `(${match.from[k]}+(${target[k]}-${match.from[k]})*${ease})`])) as Record<keyof FrameRect, string>;
  const baseX = `clip(${rect.x},0,${meta.width - crop.w})`, baseY = `clip(${rect.y},0,${meta.height - crop.h})`;
  const zoom = (expression: string) => expression.replace(/\bt\b/g, "in_time");
  const lut = grade?.indexOf("lut3d=") ?? -1;
  const before = grade ? lut < 0 ? `${grade},` : grade.slice(0, lut) : "", after = lut < 0 ? "" : `${grade!.slice(lut)},`;
  return `${before}crop=w=iw*${crop.w / meta.width}:h=ih*${crop.h / meta.height}:x='iw*(${baseX})/${meta.width}':y='ih*(${baseY})/${meta.height}':exact=1,${after}` +
    `zoompan=z='${zoom(`max(1,${crop.w}/${rect.w})`)}':x='${zoom(`(${rect.x}-${baseX})*iw/${crop.w}`)}':y='${zoom(`(${rect.y}-${baseY})*ih/${crop.h}`)}':d=1:s=${out.w}x${out.h}:fps=${fps},setsar=1,format=yuv420p`;
}

// Shared by the spine and picture-only overlays. Convert original pixel
// coordinates to fractions so the identical crop applies to a smaller proxy.
export function previewFraming(clip: Clip, s: number, e: number, out: { w: number; h: number },
  input: string, output: string, energy: Energy = "subtle", beat?: EnergyBeat, fps = clip.meta?.fps ?? 25, grade?: string, planned?: CutFraming): string[] {
  const { w, h } = out;
  const plan = planned ?? energyFraming(clip, s, e, out, energy, beat), crop = plan.crop;
  if (plan.rects) return [`[${input}]${motionFramingFilter(clip, plan.rects, out, fps, grade)}[${output}]`];
  if (planned?.match && crop) return [`[${input}]${matchedFramingFilter(clip, planned, out, fps, grade)}[${output}]`];
  if (crop) {
    const width = clip.meta!.width, height = clip.meta!.height;
    const x = crop.keyframes ? `iw*(${cropXExpression(crop)})/${width}` : `iw*${crop.x / width}`;
    const resize = plan.scale > 1 || plan.push > 0 ? energyZoomFilter(plan, out, fps) : `scale=${w}:${h}`;
    // YUV -> RGB must precede the crop to preserve chroma at its edges. The
    // pointwise LUTs can then run on only the retained pixels. Keep resize after
    // the nonlinear LUTs: scale-first exceeded the 2/255 frame tolerance.
    const lut = grade?.indexOf("lut3d=") ?? -1;
    const beforeCrop = grade ? lut < 0 ? `${grade},` : grade.slice(0, lut) : "";
    const afterCrop = lut < 0 ? "" : `${grade!.slice(lut)},`;
    return [`[${input}]${beforeCrop}crop=w=iw*${crop.w / width}:h=ih*${crop.h / height}:x='${x}':y=ih*${crop.y / height}:exact=1,${afterCrop}${resize},setsar=1,format=yuv420p[${output}]`];
  }
  return [`[${input}]${grade ? `${grade},` : ""}scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p[${output}]`];
}

// Negative offsets mean the recorder started later. Preserve that initial
// silence rather than shifting later speech forward or mixing in the camera.
export function voiceAudioSource(clip: Clip, s: number): { file: string; startS: number; delayS: number } {
  const start = (clip.sound?.offsetS ?? 0) + s;
  if (!Number.isFinite(start)) throw new Error(`Invalid sound offset for ${clip.id}.`);
  return { file: clip.sound?.file ?? clip.file, startS: Math.max(0, start), delayS: Math.max(0, -start) };
}

// Read a tiny tail beyond each internal jump cut. Acrossfade consumes that
// tail, keeping both the picture cuts and every later piece at their exact time.
export function cutAudioTail(cuts: CutItem[], i: number, fps: number): number {
  const cut = cuts[i], next = cuts[i + 1];
  return next && cut.piece !== undefined && cut.piece === next.piece && cut.seg && cut.seg.lineIndex !== null
    ? Math.min(.01, cut.durTimelineFrames / fps / 2, next.durTimelineFrames / fps / 2) : 0;
}

export function finishCutAudio(cuts: CutItem[], i: number, fps: number): string {
  const cut = cuts[i], duration = cut.durTimelineFrames / fps;
  const tail = cutAudioTail(cuts, i, fps), outputDuration = duration + tail;
  const sourceEnd = cut.outFrames / (cut.clipFpsR.num / cut.clipFpsR.den);
  let readDuration = outputDuration;
  // A tight word boundary may leave less than 10 ms of guard. Never bring the
  // filler back in the crossfade tail; fade the available sound into padding.
  if (tail) for (const other of cuts) {
    if (other.piece !== cut.piece) continue;
    for (const filler of other.removed ?? []) {
      if (filler.kind !== "pause" && filler.e > sourceEnd) {
        readDuration = Math.min(readDuration, duration + Math.max(0, filler.s - sourceEnd));
      }
    }
  }
  const fade = Math.min(.005, readDuration);
  return `apad,atrim=duration=${readDuration},` +
    (readDuration < outputDuration - 1e-7 ? `afade=t=out:st=${readDuration - fade}:d=${fade},apad,atrim=duration=${outputDuration},` : "");
}

export function joinCutAudio(cuts: CutItem[], fps: number, filters: string[], prefix: string, output: string): void {
  filters.push(`[${prefix}0]anull[${prefix}join0]`);
  for (let i = 1; i < cuts.length; i++) {
    const fade = cutAudioTail(cuts, i - 1, fps);
    filters.push(`[${prefix}join${i - 1}][${prefix}${i}]` +
      (fade ? `acrossfade=d=${fade}:c1=tri:c2=tri` : "concat=n=2:v=0:a=1") + `[${prefix}join${i}]`);
  }
  filters.push(`[${prefix}join${cuts.length - 1}]anull[${output}]`);
}

function encode(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = currentActivity()?.signal;
    signal?.throwIfAborted();
    const child = spawn(tool("ffmpeg"), args, { stdio: ["ignore", "ignore", "pipe"] });
    const abort = () => { child.kill("SIGKILL"); };
    signal?.addEventListener("abort", abort, { once: true });
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-6000); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 120_000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code) => {
      cleanup();
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg preview exited ${code}: ${stderr}`));
    });
  });
}

// Only drafts get this listening level. Copy the finished picture and measure
// the complete audio mix, then apply the measured loudnorm second pass.
export async function normalisePreviewAudio(file: string): Promise<void> {
  const target = "loudnorm=I=-16:TP=-1.5:LRA=11";
  const { stderr } = await promisify(execFile)(tool("ffmpeg"), ["-hide_banner", "-nostats", "-i", file,
    "-map", "0:a:0", "-vn", "-af", `${target}:print_format=json`, "-f", "null", "-"],
  { timeout: 120_000, maxBuffer: 1024 * 1024, signal: currentActivity()?.signal, killSignal: "SIGKILL" });
  const report = JSON.parse(stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1)) as Record<string, string>;
  // Silence has no LUFS target. Sending it through loudnorm again can produce
  // NaN samples in ffmpeg; keep the already encoded silent audio instead.
  if (!Number.isFinite(Number(report.input_i))) return;
  const keys = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"];
  const measurable = keys.every((key) => Number.isFinite(Number(report[key])));
  const filter = measurable ? `${target}:measured_I=${report.input_i}:measured_TP=${report.input_tp}` +
    `:measured_LRA=${report.input_lra}:measured_thresh=${report.input_thresh}:offset=${report.target_offset}:linear=true` : target;
  const temporary = `${file}.${process.pid}.loudness.mp4`;
  try {
    await encode(["-hide_banner", "-loglevel", "error", "-y", "-i", file,
      "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-af", filter,
      "-ar", "48000", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", temporary]);
    currentActivity()?.signal.throwIfAborted();
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function renderPreview(root: string, cutList: CutItem[], opts: PreviewOptions): Promise<string> {
  cutList = cutList.map(c => c.seg ? { ...c, seg: { ...c.seg, clip: displayedClip(c.seg.clip) } } : c);
  if (!cutList.length) throw new Error("The preview cut list is empty.");
  if (!opts.name || path.basename(opts.name) !== opts.name) throw new Error("Invalid preview name.");
  const { width, height, fps } = opts.template;
  if (![width, height, fps].every((v) => Number.isFinite(v) && v > 0)) throw new Error("Invalid preview template.");
  const w = 960, h = Math.round((w * height / width) / 2) * 2;
  const lengthS = cutList.reduce((sum, item) => sum + item.durTimelineFrames / fps, 0);
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-filter_complex_threads", String(threads(4))];
  const filters: string[] = [];
  let input = 0;
  const beats = energyBeats(cutList, fps), plans = cutFraming(cutList, fps, { w, h }, opts.energy);
  const defaultGrade = gradeForLook("unknown", (await getPreferences()).look);
  const gradeCache = path.join(root, ".sidething", "finish-cache");
  await fs.mkdir(gradeCache, { recursive: true });
  for (const [i, item] of cutList.entries()) {
    const duration = item.durTimelineFrames / fps;
    const audioDuration = duration + cutAudioTail(cutList, i, fps);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Invalid preview duration.");
    if (!item.seg) {
      args.push("-f", "lavfi", "-t", `${duration}`, "-i", `color=c=black:s=${w}x${h}:r=${fps}`);
      filters.push(`[${input++}:v]setpts=PTS-STARTPTS,setsar=1[v${i}]`);
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[a${i}]`);
      continue;
    }
    const clip = item.seg.clip;
    const picture = path.resolve(root, clip.file);
    const sourceFps = item.clipFpsR.num / item.clipFpsR.den;
    const start = item.inFrames / sourceFps;
    const videoInput = input++;
    args.push("-threads", String(threads(4)), ...(canVideoToolboxDecode(clip.meta?.codec) ? ["-hwaccel", "videotoolbox"] : []), "-ss", `${start}`, "-t", `${audioDuration}`, "-i", picture);
    const grade = await pieceGradeFilter(clip, defaultGrade, gradeCache, { root, s: start, e: start + duration, neighbours: cutList.flatMap(c => c.seg ? [{ clipId: c.seg.clip.id, s: c.inFrames / (c.clipFpsR.num / c.clipFpsR.den), e: c.inFrames / (c.clipFpsR.num / c.clipFpsR.den) + c.durTimelineFrames / fps }] : []) });
    filters.push(`[${videoInput}:v]${clipRotationFilter(clip)}trim=duration=${duration},setpts=PTS-STARTPTS,fps=${fps}[picture${i}]`);
    filters.push(...previewFraming(clip, start, start + duration, { w, h }, `picture${i}`, `v${i}`, opts.energy, beats[i], fps, grade, plans[i]));
    const mic = item.seg.lineIndex !== null && clip.sound ? voiceAudioSource(clip, start) : null;
    const route = item.seg.lineIndex !== null && (mic || (clip.meta?.audioChannels ?? 0) > 0) ?
      (await measureSourceAudio(root, path.resolve(root, mic?.file ?? clip.file))).filter : "";
    if (mic && mic.delayS < audioDuration) {
      args.push("-ss", `${mic.startS}`, "-t", `${audioDuration - mic.delayS}`, "-i", path.resolve(root, mic.file));
      filters.push(`[${input++}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${route ? route + "," : ""}adelay=${mic.delayS * 1000}:all=1,${finishCutAudio(cutList, i, fps)}anull[a${i}]`);
    } else if (!mic && (clip.meta?.audioChannels ?? 0) > 0) {
      filters.push(`[${videoInput}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${route ? route + "," : ""}${finishCutAudio(cutList, i, fps)}anull[a${i}]`);
    } else {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${audioDuration}[a${i}]`);
    }
  }
  filters.push(cutList.map((_, i) => `[v${i}]`).join("") + `concat=n=${cutList.length}:v=1:a=0,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[v]`);
  joinCutAudio(cutList, fps, filters, "a", "camera");
  if (opts.music) {
    const { startS, gainDb } = opts.music;
    if (!Number.isFinite(startS) || startS < 0 || !Number.isFinite(gainDb)) throw new Error("Invalid music options.");
    args.push("-ss", `${startS}`, "-t", `${lengthS}`, "-i", path.resolve(root, opts.music.file));
    const fade = Math.min(1.5, lengthS);
    filters.push(`[${input}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${gainDb}dB,apad,atrim=duration=${lengthS},afade=t=out:st=${lengthS - fade}:d=${fade}[music]`);
    filters.push("[camera][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:latency=1[a]");
  } else filters.push("[camera]anull[a]");
  const dir = path.join(root, ".sidething", "precuts");
  await fs.mkdir(dir, { recursive: true });
  const name = `${opts.name}.mp4`;
  const output = path.join(dir, name);
  const temporary = path.join(dir, `${opts.name}.${process.pid}.${Date.now()}.tmp.mp4`);
  await mapSourceAudioGraph(args, filters);
  args.push("-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]", "-t", `${lengthS}`,
    "-c:v", "h264_videotoolbox", "-b:v", "4M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-movflags", "+faststart+write_colr", temporary);
  try {
    await encode(args);
    await normalisePreviewAudio(temporary);
    currentActivity()?.signal.throwIfAborted();
    await fs.rename(temporary, output);
    return name;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export interface FinishingPreviewOptions {
  name: string;
  template: Pick<Template, "width" | "height" | "fps">;
  version: Pick<CutVersion, "clipSoundMuted" | "clipSoundDefaultOn" | "laneLevels" | "laneMuted" | "voiceover" | "titles" | "grade" | "audio" | "energy" | "faceMatch" | "music" | "framing" | "pieceFx" | "transition" | "joins" | "overlays" | "sfx" | "bigLines" | "bleeps" | "lowerThirds" | "layouts" | "angleCuts"> & { assembly?: import('./sidekick').StoredVersion['assembly'] };
  reel?: ReelAssembly;
  full?: boolean;
  still?: { t: number }; // N9: one finished picture, no sound
  /** PRO2b: a draft's output frames from..to (end exclusive) on the edit's frame clock, picture only. Cuts that reach
   * none of them stand in as black for their frames (joinFxVideo holds each piece to its frames on the edit's grid) and
   * nothing after them renders, so each frame in the window is the frame the whole draft has there. The file holds
   * just those frames, from zero. */
  window?: { from: number; to: number };
  /** VO7-11: the whole edit a partial render belongs to. Exposure matching reads its neighbours, so a span
   * rendered alone (the held last shot) grades exactly as it does inside the edit. */
  exposureCuts?: CutItem[];
}

// Existing progress channel and Stage contract; the clip id identifies the cut.
export function finishingProgress(root: string, cutId: string, pct: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      try { win.webContents.send("api:progress", { root, clipId: cutId, stage: "proxy", pct }); } catch { /* closed */ }
    }
  }
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function nonempty(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).size > 0; } catch { return false; }
}
async function fingerprint(file: string) {
  const stat = await fs.stat(file);
  return { file: await fs.realpath(file), size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs };
}
async function resource(relative: string): Promise<string> {
  for (const base of [process.cwd(), app.getAppPath(), process.resourcesPath ?? "", checkoutFile(".")]) {
    const file = path.join(base, relative);
    try { await fs.access(file); return file; } catch { /* next */ }
  }
  throw new Error(`Could not find ${relative}. Reinstall precut.`);
}

// Run local tools with bounded stderr and streaming progress. No fixed two-minute
// limit: full-resolution title frames and accurate Vision mattes can take longer.
function finishProcess(command: string, args: string[], progress?: (line: string) => void,
  streams: (() => AsyncGenerator<Buffer>)[] = [], also?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    // EXP2: `also` stops one part of a parted export when another part fails.
    const signal = also ? AbortSignal.any([currentActivity()?.signal, also].filter((s): s is AbortSignal => !!s)) : currentActivity()?.signal;
    signal?.throwIfAborted();
    if (process.env.PRECUT_FFMPEG_LOG) console.error(`[ffmpeg] ${command} ${args.join(" ")}`); // EXP2: opt-in profiling only
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe", ...streams.map(() => "pipe" as const)] });
    let streamError: unknown;
    const readers = streams.map(stream => Readable.from(stream()));
    const pumps = readers.map((reader, i) => pipeline(reader, child.stdio[i + 3] as Writable).catch(error => {
      // VO7-9: ffmpeg closes an input once the output reaches -t (a caption running to the picture's last,
      // partial frame). That input is no longer needed: let ffmpeg finish, and its exit code decide.
      if ((error as NodeJS.ErrnoException)?.code === 'EPIPE') return;
      streamError ??= error; child.kill('SIGKILL');
    }));
    const abort = () => { child.kill("SIGKILL"); };
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", abort);
    let stderr = "", pending = "";
    child.stderr!.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-8000); });
    child.stdout!.on("data", (data: Buffer) => {
      pending += data.toString();
      const lines = pending.split(/\r?\n/); pending = lines.pop()!;
      for (const line of lines) progress?.(line);
    });
    child.once("error", error => { streamError ??= error; readers.forEach(r => r.destroy()); });
    child.once("close", async code => {
      cleanup();
      readers.forEach(r => r.destroy());
      await Promise.all(pumps);
      if (signal?.aborted) reject(signal.reason);
      else if (streamError) reject(new Error(`${command} input failed: ${streamError}\n${stderr}`));
      else if (code === 0) resolve(stderr);
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

/** Camera conversion is shared with finishing and measurement in grade.ts. */
export async function clipGradeFilter(clip: Clip, grade: Grade, cacheDir: string): Promise<string> {
  return `${await cameraConversionFilter(clip, cacheDir)},${await gradeFilter({ ...grade, input: "rec709" }, { cacheDir })}`;
}

// PAR1: `delivered` also receives the master stage this file was given (gain on the premix, limiter ceiling), so the
// live mix plays the edit at the export's own level (live-sound.ts reads it from the manifest).
type MasterReceipt = { value?: LoudnessMeasurement | null; gainDb?: number; ceiling?: number; dynamic?: boolean };
/** AV6: the master stage normaliseFinished gives a premix measured as `measured` (its `reference` when the faders
 * keep a baseline's level): gain on the premix, limiter ceiling, and whether loudnorm runs dynamic. A sound design
 * mix with Audio Auto and no baseline starts here and is corrected after its encode (within 0.8 LU of the target). */
export function masterStage(targetLUFS: number, measured: LoudnessMeasurement, auto: boolean, reference: boolean, soundDesign: boolean): { gainDb: number; ceiling: number; dynamic: boolean } {
  if (soundDesign && auto && !reference) return { gainDb: targetLUFS - measured.input_i, ceiling: 10 ** (-2 / 20), dynamic: false };
  const linear = auto && !reference, gainDb = linear ? targetLUFS - measured.input_i : targetLUFS - measured.input_i + measured.target_offset;
  return { gainDb, ceiling: 0.841395, dynamic: linear && measured.input_tp + gainDb > -1.5 };
}
async function normaliseFinished(file: string, targetLUFS: number, bitrate: string, duration: number, progress: () => void, audioOnly = false, reference?: LoudnessMeasurement, auto = false, delivered?: MasterReceipt, soundDesign = false): Promise<LoudnessMeasurement | undefined> {
  // Keep the first loudness pass on the same abortable process path as encoding.
  const stderr = reference ? "" : await finishProcess(tool("ffmpeg"), ["-hide_banner", "-nostdin", "-nostats", "-i", file,
    "-map", "0:a:0", "-vn", "-af", `loudnorm=I=${targetLUFS}:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-"]);
  const report = reference ? {} : JSON.parse(stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1)) as Record<string, string>;
  if (report.input_i === "-inf") return; // silent mix
  const measured = reference ?? Object.fromEntries(["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]
    .map(key => [key, report[key] === undefined ? NaN : Number(report[key])])) as unknown as LoudnessMeasurement;
  progress();
  if (!Object.values(measured).every(Number.isFinite)) throw new Error("Invalid mix loudness measurement.");
  if (soundDesign && auto && !reference) {
    // Always encode from the lossless premix. Repeated AAC correction encodes
    // can introduce fresh impulses and progressively damage the voice.
    const candidate = `${file}.${randomUUID()}.master.m4a`;
    let correctionDb = 0, ceilingDb = -2;
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        const filter = `volume=${targetLUFS - measured.input_i + correctionDb}dB,aresample=192000,` +
          `alimiter=limit=${10 ** (ceilingDb / 20)}:level=false:latency=true,aresample=48000`;
        await finishProcess(tool("ffmpeg"), ["-v", "error", "-y", "-i", file, "-vn", "-map", "0:a:0", "-af", filter,
          "-ar", "48000", "-c:a", "aac", "-aac_coder", "fast", "-b:a", bitrate, "-t", `${duration}`, candidate]);
        const decoded = await measureLoudness(candidate, { ...DEFAULT_AUDIO_FINISH, loudnessLUFS: targetLUFS });
        if (!decoded || (decoded.input_tp <= -1 && Math.abs(decoded.input_i - targetLUFS) <= .8)) {
          currentActivity()?.signal.throwIfAborted();
          if (delivered) Object.assign(delivered, { value: decoded, gainDb: targetLUFS - measured.input_i + correctionDb, ceiling: 10 ** (ceilingDb / 20) });
          await fs.rename(candidate, file); return measured;
        }
        correctionDb += targetLUFS - decoded.input_i;
        if (decoded.input_tp > -1) ceilingDb = Math.max(-18, ceilingDb - (decoded.input_tp + 1) - .35);
      }
      throw new Error("Could not reach the sound design listening level and peak ceiling. Try rendering again.");
    } finally { await fs.rm(candidate, { force: true }); }
  }
  const filter = auto ? (reference ? `volume=${targetLUFS - measured.input_i + measured.target_offset}dB` : loudnessFilter(measured, { ...DEFAULT_AUDIO_FINISH, loudnessLUFS: targetLUFS })) +
    ",aresample=192000,alimiter=limit=0.841395:level=false:latency=true,aresample=48000" :
    `volume=${targetLUFS - measured.input_i + measured.target_offset}dB,alimiter=limit=0.841395:level=false:latency=true`; // Fixed master gain preserves clip volume, including short edits.
  const temporary = `${file}.${randomUUID()}.loudness.${audioOnly ? "m4a" : "mp4"}`;
  try {
    await finishProcess(tool("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", "-i", file,
      ...(audioOnly ? ["-vn", "-map", "0:a:0"] : ["-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy"]), "-af", filter, "-ar", "48000",
      "-c:a", "aac", "-b:a", bitrate, "-t", `${duration}`, "-movflags", "+faststart", temporary]);
    // loudnorm's linear pass is the gain target - measured (dynamic only when that gain would pass the peak target).
    const stage = masterStage(targetLUFS, measured, auto, !!reference, false), gainDb = stage.gainDb;
    if (delivered) Object.assign(delivered, stage);
    if (auto) {
      const safety = { db: 0 };
      const decoded = await verifyEncodedPeaks(temporary, targetLUFS, bitrate, duration, audioOnly, safety);
      if (delivered) { delivered.value = decoded; delivered.gainDb = gainDb + safety.db; }
    }
    currentActivity()?.signal.throwIfAborted();
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
  return measured;
}

// Check the decoded delivery codec, including the final MP4 encode. Never
// publish an overshoot, even if a particular AAC encoder needs another margin.
async function verifyEncodedPeaks(file: string, targetLUFS: number, bitrate: string, duration: number, audioOnly: boolean, safety?: { db: number }): Promise<LoudnessMeasurement | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const decoded = await measureLoudness(file, { ...DEFAULT_AUDIO_FINISH, loudnessLUFS: targetLUFS });
    if (!decoded || decoded.input_tp <= -1) return decoded;
    if (attempt === 3) throw new Error("Could not keep the encoded sound below its peak ceiling. Try exporting again.");
    const safe = `${file}.${randomUUID()}.safe.${audioOnly ? "m4a" : "mp4"}`;
    try {
      await finishProcess(tool("ffmpeg"), ["-v", "error", "-y", "-i", file,
        ...(audioOnly ? ["-vn"] : ["-map", "0:v:0", "-c:v", "copy"]), "-map", "0:a:0", "-af", `volume=${-1.5 - decoded.input_tp}dB`,
        // The default AAC coder can introduce new impulses on a correction
        // encode. Use its conservative coder for these measured safety retries.
        "-ar", "48000", "-c:a", "aac", "-aac_coder", "fast", "-b:a", bitrate, "-t", `${duration}`, "-movflags", "+faststart", safe]);
      if (safety) safety.db += -1.5 - decoded.input_tp;
      await fs.rename(safe, file);
    } finally { await fs.rm(safe, { force: true }); }
  }
  throw new Error("Could not measure the encoded sound.");
}

function finishingMusic(root: string, opts: FinishingPreviewOptions): CutVersion["music"] | undefined {
  const chosen = opts.version.music !== undefined ? opts.version.music : opts.reel?.music;
  const music = chosen ? playableMusic(root, chosen) : chosen;  // ONB1b: a missing file is left out, as live does
  return music ? { ...music, gainDb: music.gainDb ?? opts.reel?.music?.gainDb ?? -18 } : music;
}

type SoundInput = (file: string, start: number, length: number, camera?: boolean, whole?: boolean) => number;
// Both live sound and the finished renderer use these exact source/cleanup,
// tail/crossfade and music graphs. B-roll never supplies the voice track.
export function appendCutSound(root: string, cuts: CutItem[], i: number, fps: number,
  audio: NonNullable<CutVersion["audio"]>, filters: string[], input: SoundInput, fx?: FxItem, prepared?: PreparedVoice): void {
  const cut = cuts[i], length = fx ? fx.endS - fx.startS : cut.durTimelineFrames / fps;
  const audioLength = length + (fx?.audio ? 0 : cutAudioTail(cuts, i, fps));
  if (!(length > 0) || !Number.isFinite(length)) throw new Error("Invalid finishing piece length.");
  if (fx?.reverse || fx?.muted) { filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${audioLength}[a${i}]`); return; }
  const clip = cut.seg?.clip;
  const mappedSegments = fx ? fxAudioSegments(fx) : [];
  const segments = mappedSegments.some(s => Math.abs(s.speed - 1) > 1e-7) ? mappedSegments : null;
  if (segments && clip && (cut.seg!.lineIndex !== null || fx?.soundEnabled) && (clip.sound || (clip.meta?.audioChannels ?? 0) > 0)) {
    segments.forEach((span, n) => {
      const source = voiceAudioSource(clip, span.sourceS), duration = span.sourceE - span.sourceS;
      const label = `a${i}segment${n}`, cleanup = prepared?.filter ?? voiceFilter(audio);
      if (source.delayS >= duration) filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration / span.speed}[${label}]`);
      else {
        const a = input(prepared?.file ?? path.resolve(root, source.file), source.startS - (prepared?.sourceStart ?? 0), duration - source.delayS, !clip.sound);
        const tempo = tempoChain(span.speed);
        filters.push(`[${a}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${cleanup ? cleanup + "," : ""}adelay=${source.delayS * 1000}:all=1,apad,atrim=duration=${duration},${tempo},apad,atrim=duration=${duration / span.speed}[${label}]`);
      }
    });
    filters.push(segments.map((_, n) => `[a${i}segment${n}]`).join("") + `concat=n=${segments.length}:v=0:a=1,volume=${fx!.gainDb}dB,apad,atrim=duration=${audioLength}[a${i}]`);
    return;
  }
  const start = fx?.audio ? fx.timeMap[0].s : clip ? cut.inFrames / (cut.clipFpsR.num / cut.clipFpsR.den) : 0;
  const source = clip ? voiceAudioSource(clip, start) : null;
  if (clip && (cut.seg!.lineIndex !== null || fx?.soundEnabled) && source && source.delayS < audioLength && (clip.sound || (clip.meta?.audioChannels ?? 0) > 0)) {
    const a = input(prepared?.file ?? path.resolve(root, source.file), source.startS - (prepared?.sourceStart ?? 0), audioLength - source.delayS, !clip.sound);
    const cleanup = prepared?.filter ?? voiceFilter(audio);
    filters.push(`[${a}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
      `${cleanup ? cleanup + "," : ""}adelay=${source.delayS * 1000}:all=1,${fx?.audio ? `apad,atrim=duration=${audioLength},` : finishCutAudio(cuts, i, fps)}volume=${fx?.gainDb ?? 0}dB,anull[a${i}]`);
  } else filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${audioLength}[a${i}]`);
}
export function appendSoundMix(root: string, cuts: CutItem[], fps: number, duration: number,
  music: CutVersion["music"] | undefined, filters: string[], input: SoundInput, plan?: FxPlan,
  effects: PreparedEffect[] = [],
  auto?: { speechPeakDb: number | null }, bleeps: { s: number; e: number; sound: "beep" | "mute"; levelDb?: number }[] = [], voiceover?: CutVersion['voiceover'], narration: Awaited<ReturnType<typeof voiceoverAudio>> = [], narrationEq = '', attached: {cut:CutItem;item:FxItem;prepared?:PreparedVoice}[] = [], lanes: Pick<CutVersion,'laneLevels'|'laneMuted'> = {}, stems?: import('../shared/schema').MusicStems): void {
  if (plan?.items.some(p => p.audio)) joinAudioMix(plan, filters, `voiceJoin${cuts.length - 1}`);
  else {
  filters.push('[a0]anull[voiceJoin0]');
  for (let i = 1; i < cuts.length; i++) {
    const overlap = plan?.items[i].overlap ?? 0, fade = overlap || cutAudioTail(cuts, i - 1, fps);
    filters.push(`[voiceJoin${i - 1}][a${i}]${fade ? `acrossfade=d=${fade}:c1=tri:c2=tri` : 'concat=n=2:v=0:a=1'}[voiceJoin${i}]`);
  }
  }
  if (bleeps.length) appendBleeps(filters, `voiceJoin${cuts.length - 1}`, bleeps);
  let voiceBus = `voiceJoin${cuts.length - 1}`;
  const recorded = voiceover?.lines.filter(l => l.take) ?? [];
  if (recorded.length) {
    // Camera sound defaults to muted under narration. Explicit clip choices
    // can add it back, without changing the independent voiceover lane.
    // VO7 Fades: the same 5 ms linear join fades every exporter uses; untouched seams play continuously.
    const joinFades = voiceJoinFades(recorded);
    recorded.forEach((line, n) => {
      const take = line.take!, d = take.e - take.s, fade = joinFades.get(line.id) ?? { fadeInS: JOIN_FADE_S, fadeOutS: JOIN_FADE_S }, prepared = narration.find(p => p.line.id === line.id), source = input(prepared?.file ?? path.resolve(root, take.file), prepared?.start ?? take.s, d);
      filters.push(`[${source}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,${narrationEq ? narrationEq + ',' : ''}volume=${laneMuted(lanes,'voice') ? 0 : 10**(laneDb(lanes,'voice')/20)},${fade.fadeInS ? `afade=t=in:d=${fade.fadeInS},` : ''}${fade.fadeOutS ? `afade=t=out:st=${Math.max(0,d-fade.fadeOutS)}:d=${fade.fadeOutS},` : ''}adelay=${Math.round(line.s*48000)}S:all=1,apad,atrim=duration=${duration}[vo${n}]`);
    });
    filters.push(`[${voiceBus}]` + recorded.map((_, n) => `[vo${n}]`).join('') + `amix=inputs=${recorded.length+1}:normalize=0:duration=longest[placedVoice]`);
    voiceBus = 'placedVoice';
  }
  const audible=attached.filter(p=>!p.item.muted && p.item.soundEnabled);
  audible.forEach((p,n)=>{
    const index=cuts.length+n;
    const graph:string[]=[];appendCutSound(root,[p.cut],0,fps,DEFAULT_AUDIO_FINISH,graph,input,p.item,p.prepared);
    filters.push(...graph.map(line=>line.replaceAll('[a0]',`[a${index}]`)),`[a${index}]adelay=${Math.round(p.item.startS*48000)}S:all=1,apad,atrim=duration=${duration}[attached${n}]`);
  });
  if (audible.length) {filters.push(`[${voiceBus}]${audible.map((_,n)=>`[attached${n}]`).join('')}amix=inputs=${audible.length+1}:normalize=0:duration=longest[clipVoice]`);voiceBus='clipVoice';}
  filters.push(`[${voiceBus}]apad,atrim=duration=${duration},asetnsamples=n=1024:p=1,asettb=1/48000[dryVoice]`);

  effects.forEach((event, n) => {
    const a = input(event.file, 0, event.lengthS ?? (event.sound ? soundDuration[event.sound] : duration), false, true);
    const loop = event.loopSamples ? `aloop=loop=-1:size=${event.loopSamples},` : "";
    filters.push(`[${a}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,${loop}${event.lengthS ? `atrim=duration=${event.lengthS},` : ""}volume=${(event.gainDb ?? -12) + (event.normalizeDb ?? 0)}dB,adelay=${Math.round(event.atS * 48000)}S:all=1,apad,atrim=duration=${duration},asetnsamples=n=1024:p=1,asettb=1/48000[sfx${n}]`);
  });
  if (auto && effects.length) {
    const ceiling = auto.speechPeakDb === null ? 10 ** (-18 / 20) : Math.min(.8, 10 ** ((auto.speechPeakDb - 6) / 20));
    filters.push(effects.map((_, n) => `[sfx${n}]`).join("") + `amix=inputs=${effects.length}:duration=longest:normalize=0,aresample=192000,alimiter=limit=${Math.max(.0625, ceiling)}:level=false:latency=true,volume=${ceiling < .0625 ? ceiling / .0625 : 1},aresample=48000[effects]`,
      "[dryVoice]asplit=2[voiceForEffects][effectsKey]",
      `[effects][effectsKey]${duckingFilter('effects')},volume=${laneMuted(lanes,'effects') ? 0 : 10**(laneDb(lanes,'effects')/20)}[duckedEffects]`,
      "[voiceForEffects][duckedEffects]amix=inputs=2:duration=first:normalize=0[voice]");
  } else {
    effects.forEach((_, n) => filters.push(`[sfx${n}]volume=${laneMuted(lanes,'effects') ? 0 : 10**(laneDb(lanes,'effects')/20)}[laneSfx${n}]`));
    effects.forEach((_, n) => filters.push(`[${n ? `sfxMix${n - 1}` : 'dryVoice'}][laneSfx${n}]amix=inputs=2:duration=first:normalize=0,asettb=1/48000[sfxMix${n}]`));
    filters.push(`[${effects.length ? `sfxMix${effects.length - 1}` : 'dryVoice'}]anull[voice]`);
  }
  if (music) {
    if (!Number.isFinite(music.gainDb) || !Number.isFinite(music.startS) || music.startS < 0) throw new Error("Invalid finishing music.");
    const musicEnd = Math.min(duration,music.endS ?? duration);
    const names = stems ? STEM_NAMES : ['mix'] as const, fade = Math.min(music.fit || music.followStory ? .012 : 1.5,musicEnd);
    const fallback = plan ?? planFx(cuts,fps,{});
    // PRO3c: the music shape is the director's, not the duck's: with "dip under voice" off it still applies, alone.
    const shapeOnly = music.duck === false, flat = shapeOnly && !music.shape?.length;
    const keys = shapeOnly ? musicDuckKeys([],fallback.durationS,undefined,music.shape) : cutMusicKeys(cuts,fallback,{music,voiceover,laneMuted:lanes.laneMuted},attached);
    for (const name of names) {
      const i = input(stems && name !== 'mix' ? stems[name] : path.resolve(root,music.file),stems ? 0 : music.startS,duration);
      const envelope = flat ? '' : musicDuckFilter(name === 'mix' ? keys : stemDuckKeys(keys,name))+',';
      filters.push(`[${i}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${laneMuted(lanes,'music') ? '0' : `${music.gainDb!+laneDb(lanes,'music')}dB`},apad,atrim=duration=${musicEnd},${envelope}afade=t=out:st=${musicEnd-fade}:d=${fade},apad,atrim=duration=${duration}[music${name}]`);
    }
    filters.push(`[voice]${names.map(name=>`[music${name}]`).join('')}amix=inputs=${names.length+1}:duration=first:normalize=0,alimiter=limit=0.95:latency=1[mix]`);
  } else filters.push("[voice]anull[mix]");
}
let soundEncoder: Promise<string> | undefined;
/** Read only the receipt for the delivered AAC, never its pre-normalisation pass. */
export async function draftSoundLoudness(file: string): Promise<DraftTimeline["loudness"]> {
  try {
    const receipt = JSON.parse(await fs.readFile(`${file}.json`, "utf8"));
    if (JSON.stringify(receipt.output) !== JSON.stringify(await fingerprint(file))) return null;
    const value = receipt.loudness;
    return value && [value.lufs, value.truePeakDb, value.target].every(Number.isFinite) ? value : null;
  } catch { return null; }
}
/** Audio-only cache: visual edits and new version numbers reuse the same file. */
export async function renderDraftSound(root: string, cuts: CutItem[], opts: FinishingPreviewOptions, voiceOnly = false): Promise<string> {
  return voiceOnly ? prepareDraftSound(root, cuts, opts, true) : cachedDraftSound(root, cuts, opts);
}

/** The request cache is checked before voice cleanup, channel probes and sound
 * synthesis. Its identity excludes visual settings and immutable version IDs. */
export async function cachedDraftSound(root: string, cuts: CutItem[], opts: FinishingPreviewOptions, wait?: true): Promise<string>;
export async function cachedDraftSound(root: string, cuts: CutItem[], opts: FinishingPreviewOptions, wait: false): Promise<string | null>;
export async function cachedDraftSound(root: string, cuts: CutItem[], opts: FinishingPreviewOptions, wait = true): Promise<string | null> {
  const files = new Set<string>();
  const fx = planFx(cuts, opts.template.fps, opts.version);
  for (const [i, cut] of cuts.entries()) {
    const clip = cut.seg?.clip;
    if (!fx.items[i].reverse && clip && fx.items[i].soundEnabled && (clip.sound || (clip.meta?.audioChannels ?? 0) > 0)) files.add(path.resolve(root, voiceAudioSource(clip, 0).file));
  }
  for (const p of attachedClipSounds(opts.reel?.broll ?? opts.version.assembly?.reel.broll ?? [],fx,opts.version,opts.template.fps)) if (p.cut.seg) files.add(path.resolve(root,voiceAudioSource(p.cut.seg.clip,0).file));
  for (const line of opts.version.voiceover?.lines ?? []) if (line.take) files.add(path.resolve(root, line.take.file));
  const music = finishingMusic(root, opts);
  if (music) files.add(path.resolve(root, music.file));
  for (const item of opts.version.sfx ?? []) if (!item.file.startsWith('lib:')) files.add(path.resolve(root, item.file));
  if (typeof __filename === "string") files.add(__filename);
  if (opts.version.audio?.clean) files.add(await resource("pipeline/models/sh.rnnn"));
  for (const item of opts.version.sfx ?? []) if (item.file.startsWith('lib:') && !item.file.startsWith('lib:synth-')) {
    const manifest = JSON.parse(await fs.readFile(await resource('resources/sfx/manifest.json'), 'utf8'));
    const sound = manifest.sounds.find((s: { id: string }) => s.id === item.file);
    if (sound) files.add(await resource(`resources/sfx/${sound.file}`));
  }
  files.add(tool('ffmpeg'));
  const arrangeRecord={music:opts.version.music,assembly:opts.version.assembly ?? {cutList:cuts,reel:opts.reel ?? {cuts:[],why:''}}};
  const arrangementKey=music?.fit || music?.followStory ? await (await import('./music-arrange')).musicArrangementKey(root,arrangeRecord,fx) : null;
  // The sound used an arrangement made without the model's story decision: whoever asked (an export) says so.
  const noteArrangement = async (file: string) => {
    const notes = renderNotes.getStore();
    if (notes && arrangementKey) { const note = (await (await import('./music-arrange')).readMusicArrangement(root,arrangeRecord,fx))?.storyNote; if (note) notes.add(note); }
    return file;
  };
  const key = digest({ revision: 5, arrangementKey, clipSoundDefaultOn:opts.version.clipSoundDefaultOn,laneLevels:opts.version.laneLevels,laneMuted:opts.version.laneMuted,clipSoundMuted:opts.version.clipSoundMuted,pieceFx:opts.version.pieceFx,attached:opts.reel?.broll, voiceover: opts.version.voiceover, audio: opts.version.audio, music, sfx: opts.version.sfx, bleeps: opts.version.bleeps,
    items: fx.items, joins: fx.joins.map(j => ({ atS: j.atS, sound: j.choice.sound })), duration: fx.durationS,
    cuts: cuts.map(c => ({ in: c.inFrames, out: c.outFrames, fps: c.clipFpsR, length: c.durTimelineFrames,
      seg: c.seg && { line: c.seg.lineIndex, words: c.seg.speechWords, file: c.seg.clip.file, sound: c.seg.clip.sound, meta: c.seg.clip.meta, transcript: c.seg.clip.transcript } })),
    files: await Promise.all([...files].sort().map(fingerprint)) });
  const receipt = path.join(root, '.sidething/finish-cache', `sound-request-${key}.json`);
  try {
    const saved = JSON.parse(await fs.readFile(receipt, 'utf8'));
    if (path.dirname(saved.file) === path.dirname(receipt) && JSON.stringify(saved.output) === JSON.stringify(await fingerprint(saved.file)) && await nonempty(saved.file)) return await noteArrangement(saved.file);
  } catch { /* Prepare only on the background worker or an explicit export. */ }
  if (!wait) return null;
  const file = await prepareDraftSound(root, cuts, opts);
  const temp = `${receipt}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify({ file, output: await fingerprint(file) }));
    currentActivity()?.signal.throwIfAborted();
    await fs.rename(temp, receipt);
  } finally { await fs.rm(temp, { force: true }); }
  return noteArrangement(file);
}

/** AV6: a measuring pass of the export's sound (`prepareDraftSound` with `measure`): the same request, sources and
 * graph, measured instead of written. `stage` is the master stage the export of this sound gives it (masterStage). */
type SoundMeasure = { measured?: LoudnessMeasurement | null; stage?: NonNullable<import('../shared/schema').LiveSound['master']> | null };
/** AV6: the master stage the export of this sound will give it, before any export: the export's own request and graph,
 * its premix (or, with faders, its baseline) measured and never written. Null for a silent mix. */
export async function draftSoundMaster(root: string, cuts: CutItem[], opts: FinishingPreviewOptions): Promise<SoundMeasure['stage']> {
  const measure: SoundMeasure = {};
  await prepareDraftSound(root, cuts, opts, false, false, measure);
  return measure.stage ?? null;
}
async function prepareDraftSound(root: string, cuts: CutItem[], opts: FinishingPreviewOptions, voiceOnly = false, referencePass = false, measure?: SoundMeasure): Promise<string> {
  currentActivity()?.signal.throwIfAborted();
  const fps = opts.template.fps, fx = planFx(cuts, fps, opts.version), duration = fx.durationS;
  const effects = voiceOnly ? [] : await prepareDesignSounds(root, fx, opts.version);
  let reference: LoudnessMeasurement | undefined;
  const chosenMusic = voiceOnly ? null : finishingMusic(root, opts);
  const musicFader = chosenMusic && chosenMusic.gainDb !== -18;
  if (!referencePass && (Object.values(opts.version.laneLevels ?? {}).some(Boolean) || Object.values(opts.version.laneMuted ?? {}).some(Boolean) || musicFader || opts.version.bleeps?.length || opts.version.clipSoundMuted || opts.version.pieceFx?.some(p => p && (p.gainDb || p.muted!==undefined || p.overlaySound?.gainDb || p.overlaySound?.muted!==undefined)))) {
    // Faders are applied after the baseline listening level. Keep its master
    // gain so normalization cannot cancel a music or clip volume change.
    const baselineOpts = {...opts,version:{...opts.version,bleeps:[],clipSoundMuted:false,laneLevels:{},laneMuted:{},
      ...(chosenMusic ? {music:{...chosenMusic,gainDb:-18}} : {}),
      pieceFx:opts.version.pieceFx?.map(p=>p ? {...p,...(p.gainDb===undefined ? {} : {gainDb:0}),muted:undefined,overlaySound:p.overlaySound ? {...p.overlaySound,...(p.overlaySound.gainDb===undefined ? {} : {gainDb:0}),muted:undefined} : undefined} : p)}};
    // AV6: measuring, the baseline is measured too (never written): the same numbers the export's baseline file holds.
    const measuredRef = async (o: FinishingPreviewOptions) => { const m: SoundMeasure = {}; await prepareDraftSound(root,cuts,o,voiceOnly,true,m); return m.measured ?? undefined; };
    const baseline=measure ? '' : await prepareDraftSound(root,cuts,baselineOpts,voiceOnly,true);
    reference=measure ? await measuredRef(baselineOpts) : JSON.parse(await fs.readFile(`${baseline}.json`,"utf8")).measurement;
    if (!reference || reference.input_i<=-60) {
      // A b-roll-only edit can default to silence. Its audible sources provide
      // one stable calibration, independent of which clips the person mutes.
      const count=Math.max(baselineOpts.version.pieceFx?.length ?? 0,...cuts.map((c,i)=>(c.piece ?? i)+1));
      const calibrationOpts={...baselineOpts,version:{...baselineOpts.version,
        pieceFx:Array.from({length:count},(_,i)=>({...baselineOpts.version.pieceFx?.[i],muted:false,overlaySound:{...baselineOpts.version.pieceFx?.[i]?.overlaySound,muted:false}}))}};
      if (measure) reference=await measuredRef(calibrationOpts);
      else {
      const calibration=await prepareDraftSound(root,cuts,calibrationOpts,voiceOnly,true);
      reference=JSON.parse(await fs.readFile(`${calibration}.json`,"utf8")).measurement;
      }
    }
  }
  if (!cuts.length || !(fps > 0) || !Number.isFinite(fps) || !(duration > 0) || !Number.isFinite(duration)) throw new Error("Invalid draft sound duration.");
  const audio = normalizeAudio({ ...DEFAULT_AUDIO_FINISH, ...(opts.version.audio?.auto === false ? { loudnessLUFS: -16 } : {}), ...opts.version.audio });
  // AV6: with a baseline, the export's master stage is the baseline's (normaliseFinished with `reference`): nothing to render.
  if (measure && reference) { measure.measured = reference; measure.stage = masterStage(audio.loudnessLUFS, reference, audio.auto !== false, true, !!opts.version.sfx?.length); return ''; }
  const prepared = new Map<number, PreparedVoice>();
  for (const [i, cut] of cuts.entries()) {
    const clip = cut.seg?.clip;
    if (fx.items[i].reverse || !clip || !fx.items[i].soundEnabled || (!clip.sound && !(clip.meta?.audioChannels ?? 0))) continue;
    const span = audioSpan(fx.items[i]);
    const start = span.timeMap[0].s, source = voiceAudioSource(clip, start);
    const length = span.timeMap.at(-1)!.s - start + (fx.items.some(p => p.audio) ? 0 : cutAudioTail(cuts, i, fps));
    if (source.delayS < length) {
      const settings = pieceSoundSettings(audio,opts.version.pieceFx?.[fx.items[i].piece],clipDuckDb(cut,fx.items[i])===10);
      prepared.set(i, await prepareVoicePiece(root, path.resolve(root, source.file), settings.audio, source.startS, length - source.delayS, settings.clean));
    }
  }
  const attached: {cut:CutItem;item:FxItem;prepared?:PreparedVoice}[]=attachedClipSounds(opts.reel?.broll ?? opts.version.assembly?.reel.broll ?? [],fx,opts.version,fps);
  for (const p of attached) if (!p.item.muted && p.cut.seg) {
    const source=voiceAudioSource(p.cut.seg.clip,p.item.timeMap[0].s), file=path.resolve(root,source.file), length=p.item.endS-p.item.startS;
    if (!await sourceAudio(file)) {p.item.muted=true;continue;}
    if(source.delayS<length) {
      const settings=pieceSoundSettings(audio,opts.version.pieceFx?.[p.item.piece],clipDuckDb(p.cut,p.item)===10,1);
      p.prepared=await prepareVoicePiece(root,file,settings.audio,source.startS,length-source.delayS,settings.clean);
    }
  }
  // Cache music's channel measurements too, but preserve its stereo image.
  const arranged = voiceOnly ? null : await (await import('./music-space')).musicForEdit(root,{music:opts.version.music,assembly:opts.version.assembly ?? {cutList:cuts,reel:opts.reel ?? {cuts:[],why:''}}},fx,true,(await import('./music-arrange')).arrangedMusic);
  const music = arranged?.arrangement ? arranged.music : voiceOnly ? null : finishingMusic(root, opts);
  if (music) await measureSourceAudio(root, path.resolve(root, music.file));
  const stems = music && music.duck !== false && music.stemDucking !== false ? (arranged?.arrangement ? arranged.arrangement.stems : await musicStems(root,path.resolve(root,music.file),true,{s:music.startS,e:music.startS+duration})) : undefined;
  for (const effect of effects) await measureSourceAudio(root, effect.file);
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-filter_complex_threads", String(threads(2))], filters: string[] = [];
  const sources: { file: string; start: number; length: number }[] = [];
  const input: SoundInput = (file, start, length, _camera, whole) => {
    const index = sources.length;
    sources.push({ file, start, length });
    args.push("-threads", String(threads(2)), ...(whole ? [] : ["-ss", `${start}`, "-t", `${length}`]), "-i", file);
    return index;
  };
  cuts.forEach((_, i) => {
    const item = audioSpan(fx.items[i]);
    // Absolute placement replaces legacy tiny tail concatenation for J/L edits.
    if (fx.items.some(p => p.audio)) item.audio ??= { leadS: 0, trailS: 0, fadeInS: 0, fadeOutS: 0 };
    appendCutSound(root, cuts, i, fps, audio, filters, input, item, prepared.get(i));
  });
  // Replace the assembled voice before room tone, music and effects are mixed.
  // Applying source spans through planFx also covers speed ramps and J/L joins.
  const bleepLevels = new Map<number, number>();
  for (const [i, cut] of cuts.entries()) {
    if (!opts.version.bleeps?.some(b => b.piece === fx.items[i].piece && b.sound === 'beep') || !prepared.has(i)) continue;
    const span = audioSpan(fx.items[i]), start = span.timeMap[0].s;
    const source = voiceAudioSource(cut.seg!.clip, start);
    bleepLevels.set(i, await bleepVoiceLevel(root, prepared.get(i)!, source.startS, span.timeMap.at(-1)!.s - start));
  }
  const narration = await voiceoverAudio(root, opts.version.voiceover, audio);
  const narrationEq = narration.length ? voiceFilter({ ...audio, clean: false }) : '';
  const peaks = [...prepared].flatMap(([i, p]) => p.peakDb === null ? [] : [p.peakDb + fx.items[i].gainDb]);
  appendSoundMix(root, cuts, fps, duration, music, filters, input, fx, effects,
    audio.auto !== false ? { speechPeakDb: peaks.length ? Math.max(...peaks) : null } : undefined,
    audibleClipBleeps(opts.version,cuts,fps,fx).map(b => {
      const i = fx.items.findIndex(p => b.s >= p.startS - 1e-7 && b.s < p.endS);
      const voice = prepared.get(i);
      return { ...b, levelDb: (bleepLevels.get(i) ?? (voice?.speechLUFS ?? -20) + (voice?.gainDb ?? 0)) + (fx.items[i]?.gainDb ?? 0) };
    }), opts.version.voiceover, narration, narrationEq, attached, opts.version, stems);
  await mapSourceAudioGraph(args, filters);
  const files = new Set(sources.map(s => s.file));
  if (audio.clean) files.add(await resource("pipeline/models/sh.rnnn"));
  const encoder = await (soundEncoder ??= promisify(execFile)(tool("ffmpeg"), ["-version"], { timeout: 10_000 }).then(r => r.stdout).catch(error => { soundEncoder = undefined; throw error; }));
  const key = digest({ revision: audio.auto === false ? 3 : 4, loudnessRevision: 2, soundDesignRevision: opts.version.sfx ? 2 : 0, reference, sources, filters, duration, audio, encoder, files: await Promise.all([...files].sort().map(fingerprint)) });
  const cache = path.join(root, ".sidething", "finish-cache"), output = path.join(cache, `sound-${key}.m4a`), manifest = `${output}.json`;
  await fs.mkdir(cache, { recursive: true });
  const cached = async () => {
    try {
      const saved = JSON.parse(await fs.readFile(manifest, "utf8"));
      return Object.hasOwn(saved, "loudness") && JSON.stringify(saved.output) === JSON.stringify(await fingerprint(output)) && await nonempty(output);
    } catch { return false; } // missing, partial or replaced audio
  };
  if (measure) {
    // AV6: the premix measured (the loudness pass normaliseFinished starts with), into its own receipt beside the
    // export's cache: nothing the export reads or writes is touched, so an export running alongside is never disturbed.
    const receipt = path.join(cache, `sound-measure-${key}.json`);
    let measured: LoudnessMeasurement | null | undefined;
    try { measured = JSON.parse(await fs.readFile(receipt, "utf8")).measured; } catch { /* measure it */ }
    if (measured === undefined) {
      // The graph's arguments ask for errors only; loudnorm prints its measurement at info level (normaliseFinished's pass).
      const stderr = await finishProcess(tool("ffmpeg"), [...args, "-loglevel", "info", "-nostats", "-filter_complex", `${filters.join(";")};[mix]atrim=duration=${duration},loudnorm=I=${audio.loudnessLUFS}:TP=-1.5:LRA=11:print_format=json[measured]`,
        "-vn", "-map", "[measured]", "-ar", "48000", "-f", "null", "-"]);
      const report = JSON.parse(stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1)) as Record<string, string>;
      measured = report.input_i === "-inf" ? null : Object.fromEntries(["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"].map(k => [k, Number(report[k])])) as unknown as LoudnessMeasurement;
      if (measured && !Object.values(measured).every(Number.isFinite)) throw new Error("Invalid mix loudness measurement.");
      const temporary = `${receipt}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify({ measured })); await fs.rename(temporary, receipt); } finally { await fs.rm(temporary, { force: true }); }
    }
    measure.measured = measured;
    measure.stage = measured ? masterStage(audio.loudnessLUFS, measured, audio.auto !== false, false, !!opts.version.sfx?.length) : null;
    return '';
  }
  if (await cached()) return output;
  return runActivity({ kind: "render", root, target: null, label: "Preparing sound", cancelable: true }, async () => {
    // Another caller may have built this key while we waited for the media slot.
    if (await cached()) return output;
    const designed = !!opts.version.sfx?.length;
    const temporary = path.join(cache, `sound-${key}.${randomUUID()}.tmp.${designed ? "wav" : "m4a"}`);
    try {
      await finishProcess(tool("ffmpeg"), [...args, "-filter_complex", filters.join(";"), "-vn", "-map", "[mix]", "-t", `${duration}`,
        "-ar", "48000", "-c:a", ...(designed ? ["pcm_f32le"] : ["aac", "-b:a", "128k", "-movflags", "+faststart"]), temporary]);
      const deliveredReceipt: MasterReceipt = {};
      const measurement = await normaliseFinished(temporary, audio.loudnessLUFS, "128k", duration, () => {}, true, reference, audio.auto !== false, deliveredReceipt, !!opts.version.sfx?.length);
      // Measure the final decoded mix once per sound render. Visual edits reuse
      // this receipt; clip gain and manual/auto mixing both report actual output.
      const delivered = deliveredReceipt.value === undefined ? await measureLoudness(temporary, audio) : deliveredReceipt.value;
      const loudness = delivered ? { lufs: delivered.input_i, truePeakDb: delivered.input_tp, target: audio.loudnessLUFS } : null;
      currentActivity()?.signal.throwIfAborted();
      await fs.rename(temporary, output);
      const tempManifest = `${manifest}.${randomUUID()}.tmp`;
      try { await fs.writeFile(tempManifest, JSON.stringify({ output: await fingerprint(output), measurement, loudness,
        master: Number.isFinite(deliveredReceipt.gainDb) ? { gainDb: deliveredReceipt.gainDb, ceiling: deliveredReceipt.ceiling, dynamic: !!deliveredReceipt.dynamic } : null })); await fs.rename(tempManifest, manifest); }
      finally { await fs.rm(tempManifest, { force: true }); }
      return output;
    } finally { await fs.rm(temporary, { force: true }); }
  }, { renderLane: voiceOnly ? "finished" : "draft" });
}

/** Cached voice stem and its measured envelope, sampled on the master timeline. */
const voices = new Map<string, Promise<void>>();
export async function draftVoice(root: string, cuts: CutItem[], opts: FinishingPreviewOptions, master: string): Promise<{ url: string | null; peaks: number[] } | null> {
  let identity: Awaited<ReturnType<typeof fingerprint>>;
  try { identity = await fingerprint(master); } catch { return null; }
  const receipt = `${master}.voice.json`, key = JSON.stringify(identity);
  try {
    const saved = JSON.parse(await fs.readFile(receipt, "utf8"));
    if (JSON.stringify(saved.master) === key && JSON.stringify(saved.output) === JSON.stringify(await fingerprint(saved.file))) {
      return { url: `st-media://local/${encodeURIComponent(root)}/finish-cache/${encodeURIComponent(path.basename(saved.file))}`, peaks: saved.peaks };
    }
  } catch { /* Missing or replaced source, stem or envelope: rebuild at low priority. */ }
  if (!voices.has(key)) {
    const work = runActivity({ kind: "render", root, target: null, label: "Preparing voice waveform", cancelable: true }, async () => {
      const file = await renderDraftSound(root, cuts, opts, true);
      const { stdout } = await promisify(execFile)(tool("ffmpeg"), ["-hide_banner", "-loglevel", "error", ...await sourceAudioInput(file), "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024, signal: currentActivity()?.signal });
      const peaks: number[] = [];
      for (let start = 0; start < stdout.length; start += 160) {
        let peak = 0;
        for (let i = start; i + 1 < Math.min(start + 160, stdout.length); i += 2) peak = Math.max(peak, Math.abs(stdout.readInt16LE(i)) / 32768);
        peaks.push(peak);
      }
      const duration = planFx(cuts, opts.template.fps, opts.version).durationS;
      peaks.length = Math.min(peaks.length, Math.ceil(duration * 100));
      const temp = `${receipt}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify({ master: identity, file, output: await fingerprint(file), peaks })); currentActivity()?.signal.throwIfAborted(); await fs.rename(temp, receipt); }
      finally { await fs.rm(temp, { force: true }); }
      // The next timeline read can now pick up the finished envelope.
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("api:sidekick-changed", root);
    }, { renderLane: "finished" }).then(() => {}, () => {}).finally(() => voices.delete(key));
    voices.set(key, work);
  }
  return null;
}

/** Shared temporal video assembly, including shortened dissolve overlaps. */
/** AV6: every piece is held to exactly its frames on the edit's grid (shared/frame-rate.ts cutFrame: from its start's
 * frame to its end's), so each cut lands on the frame nearest its time, where its sound is. A piece used to run to the
 * end of its last source frame, and the cuts after it drifted by up to two frames (26.7 ms of picture after sound).
 * `base` is where the plan's clock starts on the edit's (an EXP2 part's items are on its own clock from zero). */
export function joinFxVideo(plan: FxPlan, filters: string[], prefix: string, output: string, fps: number, base = 0): void {
  const first = cutFrame((plan.items[0]?.startS ?? 0) + base, fps, plan.durationS), at = (t: number) => cutFrame(t + base, fps, plan.durationS) - first;
  // A piece short of its frames repeats its last one (tpad), then all of them are cut to length (trim).
  const exact = (i: number) => { const item = plan.items[i], frames = Math.max(1, at(item.endS) - at(item.startS));
    return `settb=AVTB,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=${frames},trim=end_frame=${frames},setpts=PTS-STARTPTS`; };
  filters.push(`[${prefix}0]${exact(0)}[${prefix}join0]`);
  for (let i = 1; i < plan.items.length; i++) {
    const item = plan.items[i];
    filters.push(`[${prefix}${i}]${exact(i)}[${prefix}next${i}]`);
    // A dissolve starts on its start's frame and lasts the frames the outgoing piece runs past it.
    const overlap = (at(plan.items[i - 1].endS) - at(item.startS)) / fps;
    filters.push(`[${prefix}join${i - 1}][${prefix}next${i}]${item.overlap && overlap > 0 ? `xfade=transition=fade:duration=${overlap}:offset=${at(item.startS) / fps}` : 'concat=n=2:v=1:a=0'}[${prefix}join${i}]`);
  }
  filters.push(`[${prefix}join${plan.items.length - 1}]null[${output}]`);
}
/** EXP2: where a finished export splits into parts that render at once. A part starts at a hard cut (no dissolve
 * into it) that no B-roll crosses; parts come out about equal in length, at most `count` of them and none shorter
 * than `minS`. A part with a dissolve or B-roll inside needs its start on the frame clock: it waits for the parts
 * before it (`needsBase`). Fewer than two parts means one process, as before. */
export function exportPartPlan(fx: Pick<FxPlan, "items" | "durationS">, spans: { s: number; e: number }[], count: number, minS = 2): { first: number; last: number; needsBase: boolean }[] {
  const n = fx.items.length, total = fx.durationS;
  const parts = Math.min(count, Math.floor(total / minS));
  if (parts < 2 || n < 2) return [];
  const cuttable = (i: number) => !(fx.items[i].overlap > 0) && !spans.some(o => o.s < fx.items[i].startS - 1e-6 && o.e > fx.items[i].startS + 1e-6);
  const starts = [0];
  for (let k = 1; k < parts; k++) {
    const ideal = total * k / parts, previous = fx.items[starts.at(-1)!].startS;
    let best = -1;
    for (let i = starts.at(-1)! + 1; i < n; i++) {
      const at = fx.items[i].startS;
      if (!cuttable(i) || at - previous < minS - 1e-6 || total - at < minS - 1e-6) continue;
      if (best < 0 || Math.abs(at - ideal) < Math.abs(fx.items[best].startS - ideal)) best = i;
    }
    if (best > 0 && Math.abs(fx.items[best].startS - ideal) < total / parts / 2) starts.push(best);
  }
  if (starts.length < 2) return [];
  return starts.map((first, k) => {
    const last = (starts[k + 1] ?? n) - 1, s = fx.items[first].startS, e = fx.items[last].endS;
    return { first, last, needsBase: fx.items.slice(first + 1, last + 1).some(item => item.overlap > 0) || spans.some(o => o.s >= s - 1e-6 && o.s < e - 1e-6) };
  });
}
export function renderFxPictures(cuts: CutItem[], fps: number, plans: (CutFraming | undefined)[], fx: FxPlan) {
  const pictures: import('../shared/schema').DraftPiece[] = cuts.map((cut, i) => {
    const clip = cut.seg?.clip, startS = cut.offsetFrames / fps, length = cut.durTimelineFrames / fps, inS = cut.inFrames / (cut.clipFpsR.num / cut.clipFpsR.den);
    const plan = plans[i], moving = plan?.rects || plan?.match || plan?.crop?.keyframes?.length || plan?.push;
    const times = moving ? [...Array.from({ length: Math.ceil(length * fps) }, (_, n) => n / fps), length] : [0, length];
    const frame = clip && plan && framingRectAt(plan, 0) ? times.map(t => {
      const r = framingRectAt(plan, t)!; return { t: startS + t, x: r.x / clip.meta!.width, y: r.y / clip.meta!.height, w: r.w / clip.meta!.width, h: r.h / clip.meta!.height };
    }) : null;
    return { startS, endS: startS + length, inS, layer: 0, clipId: clip?.id ?? '', proxy: '', lut: '', piece: cut.piece ?? i, frame };
  });
  return fxPictures(pictures, cuts, fps, fx);
}
/** AV4: the export's spine, written to NUT (which keeps no colour tags), in one known coding. See renderParts. */
export const SPINE_CODING = "scale=out_color_matrix=bt601:out_range=full";
/** AV4: the viewers blur with nine even taps across +-amount/2 of the picture width (shared/layer-glsl.ts), a spread
 * (standard deviation) of amount * sqrt(60/576); dblur's two-sided exponential spreads sqrt(2) * radius. The radius
 * that gives the viewers' spread, so the export's whip and zoom blur match what he sees. */
export const DBLUR_RADIUS_PER_AMOUNT = Math.sqrt(60 / 576) / Math.SQRT2;
export function fxBlurFilter(keys: NonNullable<import('../shared/schema').DraftPiece['blur']>, startS: number, width: number, name: string): string {
  const radius = (amount: number) => amount * width * DBLUR_RADIUS_PER_AMOUNT;
  const commands = keys.map(k => `${Math.max(0, k.t - startS).toFixed(8)} dblur@${name} radius ${radius(k.amount).toFixed(6)}, dblur@${name} angle ${(k.angle * 180 / Math.PI).toFixed(6)}`).join(';');
  return `sendcmd=c='${commands}',dblur@${name}=radius=${radius(keys[0].amount)}:angle=${keys[0].angle * 180 / Math.PI}`;
}

/** PRO3b: a piece's exposure keys as ffmpeg: one lut1d per level (shared/look-scalar.ts exposureKey sampled to a .cube),
 * each enabled on exactly its frames of the piece's clock (t = 0 at the piece's start). Frames outside pass untouched. */
export async function exposureFilter(keys: { t: number; k: number }[], startS: number, fps: number, cacheDir: string): Promise<string> {
  const { exposureCube } = await import('../shared/look-scalar');
  const spans = new Map<number, string[]>();
  keys.forEach((key, i) => {
    if (key.k === 1) return;
    const from = Math.round((key.t - startS) * fps), to = i + 1 < keys.length ? Math.round((keys[i + 1].t - startS) * fps) : from + 1;
    spans.set(key.k, [...spans.get(key.k) ?? [], `between(t,${((from - .5) / fps).toFixed(6)},${((to - .5) / fps).toFixed(6)})`]);
  });
  const filters: string[] = [];
  for (const [k, windows] of spans) {
    const file = path.join(cacheDir, `exposure-${k.toFixed(4)}.cube`);
    if (!await fs.stat(file).then(s => s.size > 0, () => false)) { const temporary = `${file}.${randomUUID()}.tmp`; await fs.writeFile(temporary, exposureCube(k)); await fs.rename(temporary, file); }
    // Escaped for ffmpeg's option parser, then its filtergraph parser (as grade.ts filterValue does).
    const value = file.replace(/[\\':]/g, "\\$&").replace(/[\\'[\],;]/g, "\\$&");
    filters.push(`lut1d=file=${value}:interp=linear:enable='${windows.join('+')}'`);
  }
  return filters.join(',');
}
/** Shared draft/full compositor. All picture edits remain frame-exact. */
export async function renderFinishingPreview(root: string, cuts: CutItem[], opts: FinishingPreviewOptions): Promise<string> {
  cuts = cuts.map(c => c.seg ? { ...c, seg: { ...c.seg, clip: displayedClip(c.seg.clip) } } : c);
  const started = performance.now(), profile: Record<string, number> = {};
  let phase = started;
  const mark = (name: string) => { const now = performance.now(); profile[name] = now-phase; phase = now; };
  currentActivity()?.signal.throwIfAborted();
  if (!cuts.length || !opts.name || path.basename(opts.name) !== opts.name) throw new Error("Invalid finishing cut or output name.");
  const { width, height, fps } = opts.template;
  if (opts.version.titles || opts.version.bleeps?.length || opts.version.lowerThirds?.length || opts.version.layouts?.some(l => l?.kind === 'title')) opts = { ...opts, version: { ...opts.version, titles: presentTitles(opts.version, cuts, fps) } };
  if (![width, height, fps].every(n => Number.isFinite(n) && n > 0)) throw new Error("Invalid finishing frame shape.");
  // Full size follows Settings > Output (1080 means 1080x1920 for 9:16), never above the template.
  // A 4K vertical from 4K landscape would need a 1.8x upscale, which makes the crop fall back to bars.
  const shortSide = opts.full ? Math.min(Math.min(width, height), (await getPreferences()).output.height) : 0;
  const fullScale = shortSide / Math.min(width, height);
  const w = opts.full ? Math.round(width * fullScale / 2) * 2 : 960;
  const h = opts.full ? Math.round(height * fullScale / 2) * 2 : Math.round(w * height / width / 2) * 2;
  const fx = planFx(cuts, fps, opts.version), out = { w, h }, duration = fx.durationS;
  // EXP2: a still needs one frame. Render real picture only for the piece holding it
  // and the piece before (a dissolve into it), stand in black for earlier pieces and
  // stop after it. The frame itself, its grade, framing and joins are unchanged.
  const stillFound = opts.still ? fx.items.findIndex(item => opts.still!.t < item.endS - 1e-9) : -1;
  const stillIdx = opts.still ? (stillFound < 0 ? fx.items.length - 1 : stillFound) : -1;
  if (!opts.still) currentActivity()?.stage?.("sound", 0);  // EXP1: an export names its stage
  // EXP2: the sound mix and the picture preparation are independent. Start the mix now
  // and let framing, measurement and LUT building run alongside it; the encode still
  // waits for both. Stages keep their order (sound is named first).
  // PRO2b: a draft window (opts.window), as seconds on the edit's clock; the last cut that reaches it.
  const windowS = opts.window && !opts.full && !opts.still && opts.window.to > opts.window.from ? { s: opts.window.from / fps, e: opts.window.to / fps } : null;
  const reachesWindow = (i: number) => !!windowS && i >= 0 && i < fx.items.length && fx.items[i].startS < windowS.e - 1e-9 && fx.items[i].endS > windowS.s + 1e-9;
  const windowLast = windowS ? fx.items.reduce((last, item, i) => item.startS < windowS.e - 1e-9 ? i : last, 0) : -1;
  const soundPromise: Promise<string> | null = opts.still || windowS ? null : renderDraftSound(root, cuts, opts);
  if (soundPromise) soundPromise.catch(() => { /* surfaced where it is awaited */ });
  mark("soundMs");
  if (!opts.still) currentActivity()?.stage?.("picture", 0, { doneS: 0, lengthS: duration });
  const reference = framingReference(opts.template, (await getPreferences()).output.height);
  const motions = await framingMotion(root, [...cuts, ...(opts.reel?.broll ?? []).map(o => ({ piece: o.voiceIndex, seg: o.seg }))], opts.version);
  const energy = opts.version.energy ?? "subtle", beats = energyBeats(cuts, fps), plans = joinFraming(cuts, fps, opts.version.layouts?.some(Boolean) ? reference : out, energy, opts.version, motions, reference);
  const fxPictures = renderFxPictures(cuts, fps, plans, fx);
  const angleFrames = opts.version.angleCuts?.length && opts.version.assembly ? anglePictures(fxPictures, { ...opts.version, assembly: opts.version.assembly }, motions, reference) : [];
  const layoutFrames = opts.version.layouts?.some(Boolean) ? splitLayoutTransitions(layoutPictures(angleFrames.length ? angleFrames : fxPictures, {
    layouts: opts.version.layouts, titles: opts.version.titles, pieceFx: opts.version.pieceFx, assembly: opts.version.assembly ?? { shoot: { root, clips: cuts.flatMap(c => c.seg ? [c.seg.clip] : []) } as import('../shared/schema').Shoot, template: opts.template as Template } as import('./sidekick').StoredVersion['assembly']
  })) : [];
  const fxPlans = plans.map((plan, i) => {
    const picture = fxPictures[i], clip = cuts[i].seg?.clip;
    const moving = !!fx.craft?.motions?.some(m => m.item === i);   // PRO3b: an authored punch on this cut
    const changed = fx.items[i].reverse || picture.blur || fx.craft?.scales[i] !== 1 || fx.craft?.punches.length || moving || Math.abs(picture.endS - picture.startS - cuts[i].durTimelineFrames / fps) > 1e-7;
    // A clip that fills the frame as shot has no framing plan; its punch still needs the rects, from a whole-frame plan.
    if (!plan && moving && clip?.meta && picture.frame) plan = { scale: 1, push: 0, x: .5, y: .5, elapsed: 0, duration: picture.endS - picture.startS, crop: null } as CutFraming;
    return plan && clip && picture.frame && changed ? { ...plan, rects: picture.frame.map(k => ({ t: k.t - picture.startS, x: k.x * clip.meta!.width, y: k.y * clip.meta!.height, w: k.w * clip.meta!.width, h: k.h * clip.meta!.height })) } : plan;
  });
  const audio = normalizeAudio({ ...DEFAULT_AUDIO_FINISH, ...opts.version.audio });
  const grade = opts.version.grade ?? gradeForLook("unknown", (await getPreferences()).look);
  const cache = path.join(root, ".sidething", "finish-cache");
  const directory = path.join(root, ".sidething", opts.full ? "finished" : "precuts");
  await fs.mkdir(cache, { recursive: true }); await fs.mkdir(directory, { recursive: true });
  // EXP2: measure each camera file's neutral base now, four at a time, while the sound mixes. The graphs then find
  // it ready (the same cached measurement) instead of measuring their cuts one after another.
  if (opts.full && !opts.still) {
    const { measureSetupBase } = await import("./grade");
    const clips = [...new Map(cuts.flatMap(c => c.seg ? [[c.seg.clip.id, c.seg.clip] as const] : [])).values()];
    let next = 0;
    const lane = async () => { while (next < clips.length) await measureSetupBase(structuredClone(displayedClip(clips[next++])), cache, root).catch(() => undefined); };
    void Promise.all(Array.from({ length: 4 }, lane));
  }
  const output = opts.still ? path.join(cache, `${opts.name}.jpg`) : path.join(directory, `${opts.name}.mp4`);
  const files = new Set<string>();
  // EXP2: the sound mixes while the picture renders; its file joins the cache key once it is ready (keyOf).
  const sound = async () => soundPromise ? await soundPromise : null;
  // Model bytes and executable renderer changes invalidate local renders too.
  if (typeof __filename === "string") files.add(__filename);
  if (audio.clean) files.add(await resource("pipeline/models/sh.rnnn"));
  const original = true; // Clean conversion always reads camera originals, including drafts.
  const pictureFile = (clip: Clip) => {
    if (original) return path.resolve(root, clip.file);
    if (!clip.proxy) throw new Error(`No proxy for ${clip.id}; generate proxies first.`);
    const file = path.resolve(root, ".sidething/proxies", clip.proxy);
    if (!file.startsWith(path.resolve(root, ".sidething/proxies") + path.sep)) throw new Error("Proxy outside cache.");
    return file;
  };
  for (const [i, cut] of cuts.entries()) if (cut.seg) {
    files.add(pictureFile(cut.seg.clip));
    if (!opts.still && !fx.items[i].reverse && fx.items[i].soundEnabled) files.add(path.resolve(root, voiceAudioSource(cut.seg.clip, 0).file));
  }
  const overlays = (opts.reel?.broll ?? []).filter(o => !opts.version.layouts?.[o.voiceIndex] || ['face','placeholder'].includes(opts.version.layouts[o.voiceIndex]!.kind));
  for (const p of [...angleFrames,...layoutFrames]) {
    const clip = opts.version.assembly?.shoot.clips.find(c => c.id === p.clipId);
    if (clip) files.add(pictureFile(clip));
  }
  overlays.forEach(o => files.add(pictureFile(o.seg.clip)));
  for (const [i, cut] of cuts.entries()) {
    const background = activeBackground(opts.version.pieceFx?.[cut.piece ?? i]?.background);
    if (background && cut.seg) files.add(await (await import('./backgrounds')).prepareBackground(root, cut.seg.clip, background, { s: cut.inFrames / (cut.clipFpsR.num / cut.clipFpsR.den), e: cut.outFrames / (cut.clipFpsR.num / cut.clipFpsR.den) }));
  }
  for (const overlay of overlays) {
    const background = opts.version.pieceFx?.[overlay.voiceIndex]?.background;
    if (background) files.add(path.resolve(root, overlay.seg.clip.file));
  }
  const music = finishingMusic(root, opts);
  if (music) files.add(path.resolve(root, music.file));
  const behindCues = opts.version.titles?.cues.filter(c => c.layer === "behind") ?? [];
  const behindGraphics = (opts.version.overlays ?? []).filter(o => o.graphic?.layer === "behind");  // GFX1
  const preparedKinetic = !!(opts.version.titles as import("./titles/captions").CaptionTrack | undefined)?.personMattes?.length && !behindGraphics.length && behindCues.every(c => c.id.startsWith("kinetic-"));
  const titleMedia = new Set<string>();
  if (preparedKinetic) for (const matte of (opts.version.titles as import('./titles/captions').CaptionTrack).personMattes ?? []) {
    for (const url of matte.frames) {
      if (!url.startsWith('st-media://local/')) continue; // Embedded bytes are already part of the design key.
      const parts = new URL(url).pathname.split('/').slice(1).map(decodeURIComponent);
      const base = path.resolve(root, '.sidething', 'finish-cache');
      const file = path.resolve(base, ...parts.slice(2));
      if (path.resolve(parts[0]) !== path.resolve(root) || parts[1] !== 'finish-cache' || !file.startsWith(base + path.sep)) throw new Error('Title matte outside cache.');
      const real = await fs.realpath(file);
      if (!real.startsWith(await fs.realpath(base) + path.sep)) throw new Error('Title matte outside cache.');
      files.add(real); titleMedia.add(real);
    }
  }
  const behind = !preparedKinetic && (behindGraphics.length > 0 || behindCues.some(c => {
    const first = Math.max(0, Math.floor(c.s * fps));
    return [first, first + 1].some(frame => frame < Math.ceil(duration * fps - 1e-9) && frame / fps >= c.s && frame / fps < c.e);
  }));
  if (behind) {
    for (const cut of cuts) if (cut.seg) files.add(path.resolve(root, cut.seg.clip.file));
    overlays.forEach(o => files.add(path.resolve(root, o.seg.clip.file)));
    files.add(await resource("pipeline/matte.py")); files.add(await resource("pipeline/matte.swift"));
  }
  for (const item of opts.version.overlays ?? []) files.add((await import("./overlays")).overlayPath(root, item.file));
  if (opts.version.titles?.cues.length || opts.version.overlays?.length) {
    files.add(bundledFile("titles/template.html"));
    // Font/template files are copied by the build. Include nested font files.
    const addTree = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await addTree(file); else files.add(file);
      }
    };
    await addTree(bundledFile("titles"));
  }
  // Source metadata, subject paths, matched mic offsets, source stats, frame
  // shape, layers and the renderer revision all participate in invalidation.
  const { stdout: encoder } = await promisify(execFile)(tool("ffmpeg"), ["-version"],
    { timeout: 10_000, signal: currentActivity()?.signal, killSignal: "SIGKILL" });
  const inputs = { revision: audio.auto === false ? 12 : 13, pictureDecodeRevision: 2, postGradeRevision: 3, ...(opts.version.pieceFx?.some(fx=>fx?.transform)?{transformRevision:2}:{}), fx, fxPlans, plans, framing: opts.version.framing, pieceFx: opts.version.pieceFx, motions: [...motions], energy, faceMatch: opts.version.faceMatch ?? "ease", music, encoder, platform: process.platform, arch: process.arch,
    ...(grade.detail?.diffusion || opts.version.pieceFx?.some(fx => fx?.look?.diffusion) ? { diffusionRevision: 2 } : {}),
    cuts, template: opts.template, output: out, full: !!opts.full, still: opts.still, reel: opts.reel,
    angleCuts: opts.version.angleCuts ?? [], angleFrames, layouts: opts.version.layouts ?? [], layoutRevision: 7, layoutFrames, overlays: opts.version.overlays ?? [], titles: opts.version.titles ?? null, grade, audio, files: await Promise.all([...files].sort().map(fingerprint)),
    // VO7-11: titles and images are now laid on in bt709 (renders made before are 1.7 levels darker).
    ...(opts.version.titles?.cues.length || opts.version.overlays?.length ? { titleColourRevision: 2 } : {}),
    ...(opts.exposureCuts ? { exposureCuts: opts.exposureCuts.map(c => [c.piece, c.seg?.clip.id, c.inFrames, c.durTimelineFrames, c.offsetFrames]) } : {}),
    ...(windowS ? { window: opts.window, windowRevision: 1 } : {}) };
  const keyOf = async () => {
    const soundFile = await sound();
    return digest(soundFile ? { ...inputs, files: await Promise.all([...files, soundFile].sort().map(fingerprint)) } : inputs);
  };
  const manifest = `${output}.finish.json`;
  let progressPct = 0;
  const reportProgress = (pct: number) => {
    if (Number.isFinite(pct)) progressPct = Math.max(progressPct, Math.min(100, pct));
    finishingProgress(root, opts.name.replace(/-v\d+$/, ""), progressPct);
    currentActivity()?.progress(progressPct);  // feeds the activity capsule, stage and notification
  };
  try {
    const saved = JSON.parse(await fs.readFile(manifest, "utf8"));
    if (saved.key === await keyOf() && JSON.stringify(saved.output) === JSON.stringify(await fingerprint(output))) {
      reportProgress(100);
      return opts.full || opts.still ? output : path.basename(output);
    }
  } catch { /* not cached */ }
  // EXP2: a finished export renders in parts at once (exportPartPlan); stills, drafts and short edits stay one process.
  const exportParts = { plan: [] as ReturnType<typeof exportPartPlan>, workers: 1, threads: 12 };
  if (opts.full && !opts.still && process.env.PRECUT_EXPORT_PARTS !== "0") {
    const cores = os.cpus().length, workers = Math.max(2, Math.min(8, Math.round(cores * .4)));
    const spans = overlays.flatMap(o => {
      const piece = cuts.filter((c, index) => (c.piece ?? index) === o.voiceIndex);
      return piece.length ? [{ s: fx.items[cuts.indexOf(piece[0])].startS, e: fx.items[cuts.indexOf(piece.at(-1)!)].endS }] : [];
    });
    const plan = exportPartPlan(fx, spans, workers * 2, 4);
    // The spines wait on disk as plain frames until their finish runs: keep the Mac's free space safe.
    const bytes = w * h * 1.5 * fps * duration * (behind ? 5 / 3 : 1);
    const free = await fs.statfs(os.tmpdir()).then(s => s.bavail * s.bsize, () => 0);
    if (plan.length >= 2 && free > bytes * 1.1 + 4e9) Object.assign(exportParts, { plan, workers, threads: Math.max(2, Math.ceil(cores / workers)) });
  }
  currentActivity()?.signal.throwIfAborted();
  reportProgress(0);
  const pulse = setInterval(() => reportProgress(progressPct), 15_000);
  const temporary = path.join(directory, `${opts.name}.${randomUUID()}.tmp.${opts.still ? "jpg" : "mp4"}`);
  const head = () => ["-hide_banner", "-loglevel", "error", "-y", "-filter_complex_threads", String(threads(exportParts.threads)), "-progress", "pipe:1"];
  const layoutInputs=layoutDecodeGroups(layoutFrames);
  /** The spine: every cut graded and framed, joined, with B-roll laid on. EXP2: a part builds only its own cuts,
   * on its own clock from zero; `base` is where that clock starts on the edit's (needed for dissolves and B-roll). */
  const buildSpine = async (args: string[], filters: string[], part?: { first: number; last: number; base: number }) => {
    let input = 0;
    let hardwareInputs = 0;
    const videoInput = (file: string, start: number, length: number, camera = false) => {
      // EXP2: a part decodes in software. Six parts at once would ask VideoToolbox for up to 24 sessions, and a
      // part has no second try; one process keeps its four hardware sessions and its software retry.
      camera = camera && !part && hardwareInputs++ < 4;
      const i = input++; args.push("-threads", String(threads(4)), ...(camera ? ["-hwaccel", "videotoolbox"] : []), "-ss", `${start}`, "-t", `${length}`, "-i", file); return i;
    };
    const sharedPictures = new Map<string, { index: number; labels: string[] }>();
    const frame = async (clip: Clip, start: number, length: number, outputLabel: string, beat?: EnergyBeat, planned?: CutFraming, timing?: FxItem, blur?: import("../shared/schema").DraftPiece["blur"], piece = timing?.piece, region?: LayoutPicture, applyClipTransform = true, timingOnly = false) => {
      clip = displayedClip(clip);
      const screenRegion=region?.layoutScene?!isLayoutCamera(region.layoutScene,region.layoutSlot):region?.layoutScreen;
      const background = piece === undefined || screenRegion ? null : activeBackground(opts.version.pieceFx?.[piece]?.background);
      const prepared = background ? await (await import('./backgrounds')).prepareBackground(root, clip, background, { s: start, e: start + length }) : null;
      const file = prepared ?? pictureFile(clip), sourceStart = prepared ? 0 : start;
      const transform=!applyClipTransform||piece===undefined?undefined:opts.version.pieceFx?.[piece]?.transform;
      const finalLabel=outputLabel;
      if(transform)outputLabel+="untransformed";
      const finishTransform=(shape:{w:number;h:number},aspects?:number[])=>{if(aspects)aspects=transformAspects(aspects,shape.w/shape.h);if(transform)filters.push(...(transform.rotate&&aspects?.some(a=>Math.abs(a-aspects[0])>1e-7)?clipTransformMorphGraph(outputLabel,finalLabel,transform,aspects):clipTransformGraph(outputLabel,finalLabel,transform,shape.w,shape.h,fps,timing?timing.endS-timing.startS:length)));};
      const group=region?.layoutScene&&!prepared?layoutInputs.find(g=>g.clipId===clip.id&&Math.abs(g.offset-(start-region.startS))<1e-6&&start>=g.s-1e-6&&start+length<=g.e+1e-6):undefined;
      const decodeStart=group?.s??sourceStart,decodeLength=group?group.e-group.s:length;
      const sourceKey = JSON.stringify([file,decodeStart,decodeLength,group?'layout-clock':region?.startS ?? timing?.startS ?? outputLabel]);
      let shared = sharedPictures.get(sourceKey);
      if (!shared) {
        // VideoToolbox can report decode errors but still return exit 0 with
        // corrupted AVC 4:2:2/10-bit frames. Camera originals use software here.
        const hardware = !original || !!prepared || canVideoToolboxDecode(clip.meta?.codec);
        shared = { index: videoInput(file,decodeStart,decodeLength,hardware), labels: [] };
        sharedPictures.set(sourceKey, shared);
      }
      const index = shared.index, sourceLabel = `${outputLabel}decoded`;
      shared.labels.push(sourceLabel);
      if (timingOnly) {
        // EXP2: a still's earlier cuts only have to arrive with the same frames at the same times: the same trim,
        // retime and frame rate as below, then a plain picture instead of the grade and framing.
        filters.push(`[${sourceLabel}]trim=${group?`start=${Math.max(0,sourceStart-decodeStart)}:`:''}duration=${length},setpts=PTS-STARTPTS,${reverseVideoFilter(timing)}${timing ? fxSetpts(timing) + "," : ""}fps=${fps},scale=64:64,format=yuv420p,scale=${w}:${h},setsar=1[${outputLabel}]`);
        return index;
      }
      const settingsPiece = piece === undefined ? undefined : opts.version.assembly && opts.version.angleCuts?.length ? angleFxPiece({...opts.version,assembly:opts.version.assembly},clip.id,piece) : piece;
      const pieceGrade = gradeForPiece(grade ?? neutralGrade("unknown"), settingsPiece === undefined ? null : balancedLook(opts.version,clip.id,settingsPiece));
      // Probing fills colour/gradeDetection on its argument. Keep those derived
      // fields out of the saved cuts and the next export's immutable cache key.
      const gradingClip = structuredClone(clip);
      const colourOptions={root,s:start,e:start+length,neighbours:(await import('./grade')).exposureSpans(opts.exposureCuts ?? cuts,overlays,fps)};
      const layoutColour=region?.layoutScene?await layoutGradeFilters(gradingClip,pieceGrade,cache,colourOptions):undefined;
      let filter=layoutColour?`${layoutColour.conversion},${layoutColour.colour}`:await (await import('./grade')).pieceGradeFilter(gradingClip,pieceGrade,cache,colourOptions);
      // PRO3b: exposure keys act on the graded picture, before it is framed, on the piece's own frame clock.
      const exposure = timing?.exposure?.length ? await exposureFilter(timing.exposure, timing.startS, fps, cache) : '';
      if (exposure) filter += `,${exposure}`;
      // Cached backgrounds are already camera-converted Rec.709; keep the same
      // neutral base and editable piece LUT as live, without converting twice.
      const conversion=await cameraConversionFilter(gradingClip,cache),cachedConversion='scale=in_color_matrix=bt709:out_range=full,format=gbrp16le';
      if (prepared) filter = `${cachedConversion},${filter.slice(conversion.length+1)}`;
      let sceneConversion=prepared?cachedConversion:conversion,sceneColour='';
      if(region?.layoutScene){
        sceneColour=filter.slice(sceneConversion.length+1);
        if(prepared||['rec709','srgb','unknown'].includes((await import('./grade')).gradeInputFor(gradingClip)))sceneConversion=sceneConversion.split(',lut3d=')[0];
      }
      const sourceClock = timing?.timeMap ?? [];
      const sourceRates = sourceClock.slice(1).map((key, i) => Math.abs((key.s - sourceClock[i].s) / (key.t - sourceClock[i].t)));
      // Duplicating 25 fps originals to 60 before the pointwise camera/look LUTs
      // grades identical pixels more than twice. Keep that conversion immediately
      // before animated framing instead; temporal crops retain the old ordering.
      const lateRate = !region && !prepared && !timing?.reverse && !planned?.match && !planned?.crop?.keyframes?.length && !timing?.exposure?.length
        && !!clip.meta?.fps && clip.meta.fps * Math.max(1, ...sourceRates) < fps - .01;
      filters.push(`[${sourceLabel}]trim=${group?`start=${Math.max(0,sourceStart-decodeStart)}:`:''}duration=${length},setpts=PTS-STARTPTS,${prepared || !original ? "" : clipRotationFilter(clip)}${prepared ? `scale=${clip.meta!.width}:${clip.meta!.height},` : ""}${reverseVideoFilter(timing)}${timing ? fxSetpts(timing) + "," : ""}${lateRate ? 'null' : `fps=${fps}`}[${outputLabel}picture]`);
      const morph=region?.layoutScene&&(region.layoutRegionKeys?.some(k=>['x','y','w','h'].some(key=>Math.abs(k[key as 'x']-region.layoutRegionKeys![0][key as 'x'])>1e-7))||region.layoutShapeKeys?.some(k=>Math.abs(k.radius-region.layoutShapeKeys![0].radius)>1e-7||Math.abs(k.opacity-region.layoutShapeKeys![0].opacity)>1e-7));
      if(morph&&region){
        // Crop each output frame before a fixed-size scale. Only the source crop
        // changes dimensions; everything downstream keeps a stable raster.
        region.layoutRaster={w:Math.max(1,...region.layoutRegionKeys!.map(k=>Math.round(k.w*w))),h:Math.max(1,...region.layoutRegionKeys!.map(k=>Math.round(k.h*h))),cropped:true};
        const steps=Math.ceil((region.endS-region.startS)*fps-1e-7);
        const cropOn=(n:number,{width:mw,height:mh}:{width:number;height:number})=>{
          const c=motionRectAt(region.frame!,Math.min(region.endS,region.startS+n/fps));
          const cw=Math.max(1,Math.min(mw,Math.round(c.w*mw))),ch=Math.max(1,Math.min(mh,Math.round(c.h*mh)));
          return {w:cw,h:ch,x:Math.max(0,Math.min(mw-cw,Math.round(c.x*mw))),y:Math.max(0,Math.min(mh-ch,Math.round(c.y*mh)))};
        };
        // EXP4 B: crop, then the camera LUT (pointwise, so after the crop is the same pixels), then the fixed-size
        // scale, then the look. The conversion ahead of the crop runs on a source raster bounded by the smallest crop.
        const raster=prepared?{clip,scale:1}:morphRaster(clip,Array.from({length:Math.max(1,steps)},(_,n)=>cropOn(n,clip.meta!)),region.layoutRaster);
        const cropAt=(n:number)=>cropOn(n,raster.clip.meta!),lut=sceneConversion.indexOf(',lut3d=');
        const beforeCrop=rasterFilter(lut<0?sceneConversion:sceneConversion.slice(0,lut),raster),afterCrop=lut<0?'':`${sceneConversion.slice(lut+1)},`;
        const cropName=`crop@${outputLabel}layout`,first=cropAt(0),commands=Array.from({length:steps},(_,n)=>Object.entries(cropAt(n)).map(([key,value])=>`${Number((n/fps).toFixed(9))} ${cropName} ${key} ${value}`).join(';')).join(';');
        filters.push(`[${outputLabel}picture]${beforeCrop},sendcmd=commands='${commands}',${cropName}=w=${first.w}:h=${first.h}:x=${first.x}:y=${first.y}:exact=1,${afterCrop}scale=${region.layoutRaster.w}:${region.layoutRaster.h}:flags=lanczos,setsar=1,${sceneColour},format=rgba[${outputLabel}]`);
        finishTransform(region.layoutRaster,Array.from({length:Math.ceil((region.endS-region.startS)*fps)},(_,n)=>{const box=motionRectAt(region.layoutRegionKeys!,region.startS+n/fps);return box.w*w/(box.h*h);}));
        return index;
      }
      const shape = region?.layoutRegion ? { w: Math.round(w*region.layoutRegion.w), h: Math.round(h*region.layoutRegion.h) } : out;
      if (region) planned = regionFraming(clip, region, length, planned);
      const localDiffusion = !region?.layoutRegion && opts.version.pieceFx?.some(fx => fx?.look?.diffusion !== undefined) ? pieceGrade.detail?.diffusion ?? 0 : 0;
      const framedLabel = localDiffusion ? `${outputLabel}undiffused` : outputLabel;
      const cropLabel=blur?`${outputLabel}sharp`:framedLabel,geometryLabel=region?.layoutScene?`${cropLabel}ungraded`:cropLabel;
      // EXP4 B: layout pieces too take only the raster their region needs (its shape, not the whole output).
      const raster = !prepared ? finishingRaster(clip, planned, shape) : { clip, plan: planned, scale: 1 };
      // Fuse resize with YCbCr conversion, before the pointwise LUTs, just as
      // previews do. Detail, grain and transforms still run at output resolution.
      let framed=previewFraming(raster.clip,start,start+length,shape,`${outputLabel}picture`,geometryLabel,energy,beat,fps,rasterFilter(region?.layoutScene?sceneConversion:filter,raster),raster.plan);
      if (lateRate) framed = framed.map(f => f.includes('zoompan=') ? f.replace('zoompan=', `fps=${fps},zoompan=`) : f.replace(/\[([^\]]+)\]$/, `,fps=${fps}[$1]`));
      filters.push(...(region?.layoutScene?framed.map(f=>f.replace(/format=yuv420p(?=\[)/g,'format=gbrp16le')):framed));
      if(region?.layoutScene)filters.push(`[${geometryLabel}]${sceneColour},format=rgba[${cropLabel}]`);
      if (blur && timing) filters.push(`[${outputLabel}sharp]${fxBlurFilter(blur, timing.startS, w, outputLabel)}[${framedLabel}]`);
      if (localDiffusion) filters.push(...detailGraph(framedLabel,outputLabel,{...NO_DETAIL,diffusion:localDiffusion},`${outputLabel}diffusion`));
      finishTransform(shape);
      return index;
    };
    const matte = async (clip: Clip, start: number, length: number, label: string, beat?: EnergyBeat, planned?: CutFraming, timing?: FxItem) => {
      const plan = planned ?? energyFraming(clip, start, start + length, out, energy, beat), crop = plan.crop;
      const matched = !!planned?.match || !!planned?.rects;
      const zoom = plan.scale > 1 || plan.push > 0;
      const fit = Math.min(w / clip.meta!.width, h / clip.meta!.height);
      const mw = matched ? clip.meta!.width : crop ? zoom ? Math.floor(crop.w) : w : Math.max(2, Math.floor(clip.meta!.width * fit / 2) * 2);
      const mh = matched ? clip.meta!.height : crop ? zoom ? Math.floor(crop.h) : h : Math.max(2, Math.floor(clip.meta!.height * fit / 2) * 2);
      const extraTurn = clipRotationFilter(clip), native = clipFileDimensions(clip);
      const nativeScale = Math.min(1, 1280 / Math.max(native.width, native.height));
      const maskW = extraTurn ? Math.max(2, Math.round(native.width * nativeScale / 2) * 2) : mw;
      const maskH = extraTurn ? Math.max(2, Math.round(native.height * nativeScale / 2) * 2) : mh;
      const matteKey = digest({ source: await fingerprint(path.resolve(root, clip.file)), rotation: clipRotation(clip), start, length, fps, out, mw, mh, crop, match: planned?.match,
        tool: inputs.files.filter(f => /matte\.(py|swift)$/.test(f.file)) });
      const file = path.join(root, ".sidething/mattes", `finish-${matteKey}.mkv`);
      // matte.py owns its integrity-checked cache. Always let it validate inputs.
      await finishProcess(tool("python3"), ["-I", await resource("pipeline/matte.py"), root, "--clip", clip.id,
        "--s", `${start}`, "--e", `${start + length}`, "--fps", `${fps}`, "--size", `${maskW}x${maskH}`,
        ...(crop && !matched && !extraTurn ? ["--crop-path", JSON.stringify(crop)] : []), "--out", file], line => {
        try { const p = JSON.parse(line); reportProgress(5 + p.pct * .2); } catch { /* diagnostic */ }
      });
      const i = videoInput(file, 0, length);
      if (extraTurn) {
        filters.push(`[${i}:v]${extraTurn}setpts=PTS-STARTPTS,${reverseVideoFilter(timing)}${timing ? fxSetpts(timing) + "," : ""}fps=${fps}[${label}source]`,
          ...previewFraming(clip, start, start + length, out, `${label}source`, `${label}framed`, energy, beat, fps, undefined, planned), `[${label}framed]format=gray[${label}]`);
        return;
      }
      if (matched) {
        filters.push(`[${i}:v]setpts=PTS-STARTPTS,${reverseVideoFilter(timing)}${timing ? fxSetpts(timing) + "," : ""}fps=${fps}[${label}source]`, ...previewFraming(clip, start, start + length, out, `${label}source`, `${label}framed`, energy, beat, fps, undefined, planned), `[${label}framed]format=gray[${label}]`);
        return;
      }
      filters.push(`[${i}:v]setpts=PTS-STARTPTS,${reverseVideoFilter(timing)}${timing ? fxSetpts(timing) + "," : ""}fps=${fps},format=gray${zoom ? `,${energyZoomFilter(plan, out, fps)},format=gray` : ""}${crop ? "" : `,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`}[${label}]`);
    };
    let at = 0;
    for (const [i, cut] of cuts.entries()) {
      if (part && (i < part.first || i > part.last)) continue; // EXP2: another part renders this cut
      if (opts.still && i > stillIdx) break; // EXP2: nothing after the still's piece can reach its frame
      if (windowS && i > windowLast) break; // PRO2b: nor after a window's last cut
      const length = fx.items[i].endS - fx.items[i].startS;
      const sourceLength = (cut.outFrames - cut.inFrames) / (cut.clipFpsR.num / cut.clipFpsR.den);
      at = fx.items[i].startS;
      if (!(length > 0) || !Number.isFinite(length)) throw new Error("Invalid finishing piece length.");
      if (windowS && !reachesWindow(i) && !reachesWindow(i + 1)) {
        // PRO2b: a cut no frame of the window needs stands in as black for its frames on the edit's grid (joinFxVideo
        // holds every piece to exactly those), so nothing is decoded or graded for it and later frames land as they do.
        const frames = Math.max(1, cutFrame(fx.items[i].endS, fps, fx.durationS) - cutFrame(fx.items[i].startS, fps, fx.durationS));
        filters.push(`color=c=black:s=${w}x${h}:r=${fps},trim=end_frame=${frames},setsar=1,format=yuv420p[v${i}]`);
        if (behind) filters.push(`color=c=black:s=${w}x${h}:r=${fps},trim=end_frame=${frames},format=gray[m${i}]`);
        // Its camera input would have taken one of the four hardware decoders, as in the whole draft: the window's own
        // cuts decode on the same decoder (hardware or software) they do there, so their pixels match.
        if (cut.seg && canVideoToolboxDecode(displayedClip(cut.seg.clip).meta?.codec)) hardwareInputs++;
        continue;
      }
      if (opts.still && i < stillIdx - 1 && cut.seg && !angleFrames.length && !opts.version.layouts?.some(Boolean) && !activeBackground(opts.version.pieceFx?.[cut.piece ?? i]?.background) && !opts.version.pieceFx?.[fx.items[i].piece]?.transform) {
        // EXP2: a still needs real picture only from the cut holding it and the one before (a dissolve into it).
        // Earlier cuts decode for their timing alone, so every later frame lands where it does in the edit.
        await frame(cut.seg.clip, cut.inFrames / (cut.clipFpsR.num / cut.clipFpsR.den), sourceLength, `v${i}`, undefined, undefined, fx.items[i], undefined, undefined, undefined, false, true);
        if (behind) filters.push(`color=c=black:s=${w}x${h}:r=${fps},trim=duration=${length},format=gray[m${i}]`);
      } else if (opts.version.layouts?.[fx.items[i].piece]?.kind === 'title') {
        filters.push(`color=c=${titleCardColour(opts.version.titles?.captionStyle?.accent)}:s=${w}x${h}:r=${fps},trim=duration=${length},setsar=1,format=yuv420p[v${i}]`);
      } else if (!cut.seg) {
        args.push("-f", "lavfi", "-t", `${length}`, "-i", `color=c=black:s=${w}x${h}:r=${fps}`);
        filters.push(`[${input++}:v]setpts=PTS-STARTPTS[v${i}]`);
      } else {
        const clip = cut.seg.clip, start = cut.inFrames / (cut.clipFpsR.num / cut.clipFpsR.den);
        const layout = opts.version.layouts?.[fx.items[i].piece];
        if (opts.version.layouts?.some(l=>l?.kind==='scene') || layout && ['screen','bubble','split'].includes(layout.kind)) {
          const parts = layoutFrames.filter(p => p.piece === fx.items[i].piece && p.startS>=at-1e-6 && p.endS<=at+length+1e-6);
          const starts = [...new Set(parts.map(p=>p.startS))].sort((a,b)=>a-b);
          if (!starts.length) throw new Error('A layout source is missing.');
          for (const [scene,sceneStart] of starts.entries()) {
            const layers=parts.filter(p=>p.startS===sceneStart).sort((a,b)=>a.layer-b.layer),duration=layers[0].endS-sceneStart,prefix=`l${i}s${scene}`;
            const backdrop=layers.find(p=>p.layoutBackground),bg=backdrop?.layoutBackground;
            if(backdrop&&bg?.kind==='screen'){
              const source=opts.version.assembly?.shoot.clips.find(c=>c.id===backdrop.clipId)??clip;
              const ar=source.meta!.width/source.meta!.height,r=out.w/out.h,h=Math.min(1,ar/r),w=h*r/ar;
              await frame(source,backdrop.inS,duration,`${prefix}backdrop`,undefined,undefined,undefined,undefined,fx.items[i].piece,{...backdrop,layoutRegionKeys:undefined,layoutShapeKeys:undefined,layoutRegion:{x:0,y:0,w:1,h:1},frame:[{t:backdrop.startS,x:(1-w)/2,y:(1-h)/2,w,h}]},false);
            }else if(bg?.kind==='image'){
              args.push('-loop','1','-i',(await import('./overlays')).overlayPath(root,bg.image!));
              filters.push(`[${input++}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},trim=duration=${duration},setpts=PTS-STARTPTS[${prefix}backdrop]`);
            }
            for (const [n,p] of layers.entries()) {
              const source = opts.version.assembly?.shoot.clips.find(c => c.id === p.clipId) ?? (clip.id === p.clipId ? clip : undefined);
              if (!source) throw new Error('Reconnect the screen recording used by this layout.');
              const screen=p.layoutScene?!p.timeMap:p.layoutScreen,sourceEnd=p.timeMap?.at(-1)?.s ?? p.inS+duration;
              const timing=screen ? undefined : {...fx.items[i],...(p.layoutScene?{reverse:false}:{}),startS:p.startS,endS:p.endS,timeMap:p.timeMap ?? [{t:p.startS,s:p.inS},{t:p.endS,s:sourceEnd}]};
              await frame(source,screen ? p.inS : Math.min(p.inS,sourceEnd),screen ? duration : Math.abs(sourceEnd-p.inS),`${prefix}part${n}`,undefined,undefined,timing,timing?p.blur:undefined,fx.items[i].piece,p); // AV4: whip and zoom blur, as live
            }
            // Diffuse the complete scene, as live does, so highlights can cross
            // screen/face boundaries at the same output-pixel radius.
            const diffusion = opts.version.pieceFx?.some(p => p?.look?.diffusion !== undefined)
              ? gradeForPiece(grade,opts.version.pieceFx?.[fx.items[i].piece]?.look).detail?.diffusion ?? 0 : 0;
            const sceneLabel = `l${i}scene${scene}`;
            appendLayoutComposite(filters,layers,w,h,fps,duration,prefix,diffusion ? `${sceneLabel}plain` : sceneLabel);
            if (diffusion) filters.push(...detailGraph(`${sceneLabel}plain`,sceneLabel,{...NO_DETAIL,diffusion},`${prefix}diffusion`));
          }
          filters.push(`${starts.map((_,n)=>`[l${i}scene${n}]`).join('')}concat=n=${starts.length}:v=1:a=0[v${i}]`);
        } else if (angleFrames.length) {
          const parts = angleFrames.filter(p => p.layer===0 && p.piece===fx.items[i].piece && p.startS>=at-1e-6 && p.endS<=at+length+1e-6);
          for (const [n,p] of parts.entries()) {
            const source = opts.version.assembly!.shoot.clips.find(c => c.id===p.clipId)!;
            const sourceEnd = p.timeMap?.at(-1)?.s ?? p.inS+p.endS-p.startS;
            const timing = {...fx.items[i],startS:p.startS,endS:p.endS,timeMap:p.timeMap ?? [{t:p.startS,s:p.inS},{t:p.endS,s:sourceEnd}]};
            await frame(source,Math.min(p.inS,sourceEnd),Math.abs(sourceEnd-p.inS),`a${i}span${n}`,undefined,undefined,timing,p.blur,fx.items[i].piece,p);
          }
          if (!parts.length) throw new Error('The camera picture is missing.');
          filters.push(`${parts.map((_,n) => `[a${i}span${n}]`).join('')}concat=n=${parts.length}:v=1:a=0[v${i}${layout?.kind === 'title' ? 'titleBase' : ''}]`);
        } else {
          await frame(clip, start, sourceLength, layout?.kind === 'title' ? `v${i}titleBase` : `v${i}`, beats[i], fxPlans[i], fx.items[i], fxPictures[i].blur);
        }
        // A zero matte outside behind-cue spans avoids Vision work there.
        const needed = opts.version.titles?.cues.some(c => c.layer === "behind" && c.s < at + length && c.e > at);
        if (behind && needed) await matte(clip, start, sourceLength, `m${i}`, beats[i], fxPlans[i], fx.items[i]);
        else if (behind) filters.push(`color=c=black:s=${w}x${h}:r=${fps},trim=duration=${length},format=gray[m${i}]`);
      }
      if (behind && !cut.seg) filters.push(`color=c=black:s=${w}x${h}:r=${fps},trim=duration=${length},format=gray[m${i}]`);
      at += length;
    }
    // EXP2: a part joins only its own cuts (parts start at hard cuts), renumbered from zero.
    const joinPlan = part ? { ...fx, items: fx.items.slice(part.first, part.last + 1).map(item => ({ ...item, startS: item.startS - part.base, endS: item.endS - part.base })) }
      : opts.still ? { ...fx, items: fx.items.slice(0, stillIdx + 1) } : windowS ? { ...fx, items: fx.items.slice(0, windowLast + 1) } : fx; // EXP2: truncated still spine
    const [pv, pm] = part ? ["pv", "pm"] : ["v", "m"];
    if (part) for (let i = part.first; i <= part.last; i++) filters.push(`[v${i}]null[pv${i - part.first}]`, ...(behind ? [`[m${i}]null[pm${i - part.first}]`] : []));
    joinFxVideo(joinPlan, filters, pv, "spine", fps, part?.base ?? 0);
    if (behind) joinFxVideo(joinPlan, filters, pm, "matteSpine", fps, part?.base ?? 0);
    let picture = "spine", mask = "matteSpine";
    for (const [i, overlay] of overlays.entries()) {
      // Cuts saved before sub-items existed carry no piece index: their position is the piece.
      const piece = cuts.filter((c, index) => (c.piece ?? index) === overlay.voiceIndex);
      if (!piece.length) throw new Error(`Missing picture piece for overlay ${overlay.id}.`);
      const offset = fx.items[cuts.indexOf(piece[0])].startS, sourceFps = overlay.seg.clip.meta!.fps;
      const start = Math.ceil(overlay.seg.s * sourceFps) / sourceFps;
      const length = Math.min(Math.floor(overlay.seg.e * sourceFps) / sourceFps - start, fx.items[cuts.indexOf(piece.at(-1)!)].endS - offset);
      if (opts.still && (opts.still.t < offset || opts.still.t >= offset + length)) continue; // EXP2: cannot reach the still's frame
      if (windowS && (offset >= windowS.e - 1e-9 || offset + length <= windowS.s + 1e-9)) continue; // PRO2b: nor the window's
      // EXP2: a part lays on only the B-roll that starts in it (parts never split one), on the part's clock.
      if (part && (cuts.indexOf(piece[0]) < part.first || cuts.indexOf(piece[0]) > part.last)) continue;
      const placed = offset - (part?.base ?? 0);
      if (length <= 0) throw new Error("An overlay has no whole frame.");
      const overlayCut: CutItem = { ...piece[0], seg: overlay.seg, inFrames: start * sourceFps,
        clipFpsR: { num: sourceFps, den: 1 }, durTimelineFrames: length * fps };
      const plan = framingPlans({ plan: cutFraming, at: framingRectAt }, [overlayCut], fps, out, energy, "off", opts.version, motions, reference)[0];
      await frame(overlay.seg.clip, start, length, `b${i}`, undefined, plan, undefined, undefined, overlay.voiceIndex);
      filters.push(`[b${i}]setpts=PTS+${placed}/TB[bt${i}]`,
        `[${picture}][bt${i}]overlay=eof_action=pass:enable='gte(t,${placed})*lt(t,${placed + length})'[over${i}]`);
      picture = `over${i}`;
      if (behind) {
        const needed = opts.version.titles?.cues.some(c => c.layer === "behind" && c.s < offset + length && c.e > offset);
        if (needed) await matte(overlay.seg.clip, start, length, `bm${i}`, undefined, plan);
        else filters.push(`color=c=black:s=${w}x${h}:r=${fps},trim=duration=${length},format=gray[bm${i}]`);
        filters.push(`[bm${i}]setpts=PTS+${placed}/TB[bmt${i}]`,
          `[${mask}][bmt${i}]overlay=eof_action=pass:enable='gte(t,${placed})*lt(t,${placed + length})',format=gray[mo${i}]`);
        mask = `mo${i}`;
      }
    }
    // Decoded sources shared by several cuts split once, at the front of the graph.
    const splits = () => { for (const { index, labels } of sharedPictures.values()) {
      filters.unshift(`[${index}:v]${labels.length > 1 ? `split=${labels.length}` : 'null'}${labels.map(l => `[${l}]`).join('')}`);
    } };
    return { input, picture, mask, splits };
  };
  /** One output-frame pass after the spine: detail and texture, then titles and images. EXP2: a part (output frames
   * from..to) keeps the edit's frame clock, so its grain and title samples are the ones the whole edit uses there. */
  const buildFinish = async (args: string[], filters: string[], input: number, picture: string, mask: string, range?: { from: number; to: number }) => {
    const titleStreams: ReturnType<typeof titleStream>[] = [];
    const clock = range?.from ? `(N+${range.from})` : "N";
    // One output-frame pass, after grades, joins and B-roll, before titles.
    const globalDetail = opts.version.pieceFx?.some(fx => fx?.look?.diffusion !== undefined) && grade.detail ? {...grade.detail,diffusion:0} : grade.detail;
    if (detailActive(globalDetail)) {
      filters.push(...detailGraph(picture, "detailedPicture", globalDetail));
      picture = "detailedPicture";
    }
    if (grade.grain?.amount || grade.vignette?.amount) {
      const platePath = await prepareGrainPlate(root, grade.grain, width, height);
      filters.push(...grainGraph(picture, "texturedPicture", grade.grain, grade.vignette, { width: w, height: h, fps, canonicalWidth: width, canonicalHeight: height, platePath, frameOffset: range?.from }));
      picture = "texturedPicture";
    }
    if (!range) mark("picturePreparationMs");
    for (const layer of ["behind", "front"] as const) {
      // VO7-11: the finished picture and the titles layer, each in the export's own colour (bt709, limited
      // range), so laying titles and images on never runs two different conversions.
      const TITLE_BASE = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";
      const TITLE_LAYER = "scale=out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=yuva420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";
      const overlays = opts.version.overlays?.length ? (await import("./overlays")).overlayMedia(root, opts.version.overlays) : [];
      // GFX1: a graphic placed behind the person rides the behind pass; every other overlay stays in front.
      if (!opts.version.titles?.cues.some(c => c.layer === layer) && !overlays.some(o => (o.graphic?.layer === "behind" ? "behind" : "front") === layer)) continue;
      const base = opts.version.titles ?? { font: "Outfit" as const, cues: [], prompt: null, skillIds: [] };
      const track = base;
      const assets = inputs.files.filter(f => f.file.includes(`${path.sep}titles${path.sep}`) || f.file.includes(`${path.sep}overlays${path.sep}`) || titleMedia.has(f.file));
      if (!opts.still) {
        const stream = titleStream(track, { width: w, height: h, fps, durationS: duration, layer, out: path.join(cache, 'stream.mov'), overlays }, path.join(cache, 'titles'), assets, range);
        if (!stream.frames && !(range && titleStream(track, { width: w, height: h, fps, durationS: duration, layer, out: path.join(cache, 'stream.mov'), overlays }, path.join(cache, 'titles'), assets).frames)) continue;
        const i = input++, pipe = titleStreams.length + 3;
        // EXP2: a part with none of this layer's samples still runs the layer's chain (as the whole edit does
        // there), with one transparent sample the overlay never shows.
        if (stream.frames) { titleStreams.push(stream); args.push('-thread_queue_size', '2', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', `${w}x${h}`, '-framerate', String(fps), '-i', `pipe:${pipe}`); }
        else args.push('-f', 'lavfi', '-i', `color=c=black@0:s=${w}x${h}:r=${fps}:d=${1 / fps},format=rgba`);
        const label = `${layer}Alpha`;
        // VO7: the picture is restamped by frame number with the title stream's own arithmetic, so frame k
        // always meets title sample k (see titleStream's setpts).
        filters.push(`[${i}:v]settb=AVTB,setpts='${stream.frames ? stream.setpts : `${clock}/${fps}/TB`}'[${label}]`, `[${picture}]settb=AVTB,setpts=${clock}/${fps}/TB[${layer}Clock]`);
        picture = `${layer}Clock`;
        const overlay = `overlay=eof_action=pass:repeatlast=0:enable='${stream.enable}'`;
        if (layer === 'behind' && !preparedKinetic) {
          filters.push(`[${mask}]settb=AVTB,setpts=${clock}/${fps}/TB[behindMaskClock]`, `[${picture}]split=2[background][personSource]`, `[personSource][behindMaskClock]alphamerge[person]`,
            `[background][${label}]${overlay}[behindTitles]`, `[behindTitles][person]overlay=shortest=1[behindPerson]`);
          picture = 'behindPerson';
        } else {
          // VO7-11: both sides go to bt709 limited range explicitly before the front layer is laid on. Left to
          // overlay's own conversion, the untagged RGBA layer and the picture took different matrices, so
          // images on it (a held last frame) came out about 3 levels darker and shifted in colour.
          filters.push(`[${picture}]${TITLE_BASE}[${layer}TitleBase]`, `[${label}]${TITLE_LAYER}[${label}Yuv]`,
            `[${layer}TitleBase][${label}Yuv]${overlay}[${layer}TitlesOver]`); picture = `${layer}TitlesOver`;
        }
        continue;
      }
      const titleKey = digest({ track, overlays, w, h, fps, duration, layer, assets });
      const file = path.join(cache, `titles-${titleKey}.mov`);
      if (!await nonempty(file)) await renderTitleTrack(track, { width: w, height: h, fps, durationS: duration, layer, out: file, overlays });
      const i = input++; args.push("-threads", String(threads(2)), "-ss", "0", "-t", `${duration}`, "-i", file);
      if (layer === "behind" && !preparedKinetic) {
        filters.push(`[${picture}]split=2[background][personSource]`, `[personSource][${mask}]alphamerge[person]`,
          `[background][${i}:v]overlay=shortest=1[behindTitles]`, `[behindTitles][person]overlay=shortest=1[behindPerson]`);
        picture = "behindPerson";
      } else { filters.push(`[${picture}]${TITLE_BASE}[${layer}TitleBase]`, `[${i}:v]${TITLE_LAYER}[${layer}TitleYuv]`, `[${layer}TitleBase][${layer}TitleYuv]overlay=shortest=1[${layer}TitlesOver]`); picture = `${layer}TitlesOver`; }
    }
    return { input, picture, titleStreams };
  };
  const titleProfiles: ReturnType<typeof titleStream>[] = [];
  /** EXP2: the export in parts, `workers` at a time. Each part's spine goes to a plain-frame file; once every part
   * before it has its frame count, its finish runs on the edit's frame clock from there and encodes its own H.264
   * at the same setting. The parts and the finished sound then join without re-encoding. */
  const renderParts = async () => {
    mark("picturePreparationMs");
    const plan = exportParts.plan, n = plan.length, abort = new AbortController();
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "precut-export-"));
    // EXP3: whose frames these are. A crash or a kill never reaches the finally below; the next launch removes the folder
    // once this process is gone (cleanupStaleExportScratch), and never while it runs.
    await fs.writeFile(path.join(scratch, "owner.pid"), String(process.pid));
    const file = (kind: "spine" | "mask" | "part", k: number) => path.join(scratch, `${kind}-${k}.${kind === "part" ? "mp4" : "nut"}`);
    const counts: number[] = [], spineDone: boolean[] = [];
    const before = (k: number) => counts.slice(0, k).reduce((sum, count) => sum + count, 0);
    const doneThrough = (k: number) => { for (let j = 0; j <= k; j++) if (!spineDone[j]) return false; return true; };
    // Progress: the spines are about seven tenths of the work, the finishes the rest (measured on a real shoot).
    const lengthOf = (k: number) => fx.items[plan[k].last].endS - fx.items[plan[k].first].startS;
    const doneS = { spine: plan.map(() => 0), finish: plan.map(() => 0) };
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    const advance = (kind: "spine" | "finish", k: number) => (line: string) => {
      const match = /^out_time_us=(\d+)/.exec(line);
      if (!match) return;
      doneS[kind][k] = Math.min(lengthOf(k), Number(match[1]) / 1e6);
      const f = Math.min(1, (.7 * sum(doneS.spine) + .3 * sum(doneS.finish)) / duration);
      currentActivity()?.stage?.("picture", f, { doneS: f * duration, lengthS: duration });
      reportProgress(30 + f * 55);
    };
    const frameCount = async (source: string) => {
      const { stdout } = await promisify(execFile)(tool("ffprobe"), ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", source],
        { signal: abort.signal, killSignal: "SIGKILL" });
      const count = Number(stdout.trim());
      if (!Number.isInteger(count) || count < 1) throw new Error("A part of the export came out empty. Try exporting again.");
      return count;
    };
    const spineJob = async (k: number) => {
      const part = plan[k], args = head(), filters: string[] = [];
      const spine = await buildSpine(args, filters, { first: part.first, last: part.last, base: part.needsBase ? before(k) / fps : fx.items[part.first].startS });
      spine.splits();
      // AV4: NUT keeps no colour tags, so a spine is written in one known coding (full range, BT.601 matrix: what
      // the graded cuts already are, so they pass untouched) and read back as that in its finish. Without it a
      // full-range spine came back as limited range (16% more contrast) and a BT.709 one in the wrong matrix.
      filters.push(`[${spine.picture}]${SPINE_CODING}[spineOut]`, ...(behind ? [`[${spine.mask}]${SPINE_CODING}[maskOut]`] : []));
      args.push("-filter_complex", filters.join(";"), "-map", "[spineOut]", "-c:v", "rawvideo", "-f", "nut", file("spine", k));
      if (behind) args.push("-map", "[maskOut]", "-c:v", "rawvideo", "-f", "nut", file("mask", k));
      await finishProcess(tool("ffmpeg"), args, advance("spine", k), [], abort.signal);
      counts[k] = await frameCount(file("spine", k));
      spineDone[k] = true;
    };
    const finishJob = async (k: number) => {
      const from = before(k), args = head(), filters: string[] = [];
      // The spine file comes back in the coding it was written in (SPINE_CODING: full range, the matrix left at its
      // BT.601 default); its frames go back on the edit's clock before the finish.
      // Eight copies of the last frame follow, cut again before the encode: the grain blend waits on its coarser
      // clock and would drop the last frames of a part at its end, where the whole edit carries straight on.
      args.push("-i", file("spine", k));
      filters.push(`[0:v]setparams=range=pc,settb=AVTB,setpts=(N+${from})/${fps}/TB,tpad=stop=8:stop_mode=clone[partSpine]`);
      if (behind) { args.push("-i", file("mask", k)); filters.push(`[1:v]setparams=range=pc,settb=AVTB,setpts=(N+${from})/${fps}/TB,tpad=stop=8:stop_mode=clone[partMask]`); }
      const finished = await buildFinish(args, filters, behind ? 2 : 1, "partSpine", "partMask", { from, to: from + counts[k] });
      titleProfiles.push(...finished.titleStreams);
      filters.push(`[${finished.picture}]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,trim=end_frame=${counts[k]},setpts=PTS-STARTPTS[finishedPicture]`);
      args.push("-filter_complex", filters.join(";"), "-map", "[finishedPicture]", ...videoEncodeArgs(true), "-pix_fmt", "yuv420p",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-an", "-movflags", "+write_colr", file("part", k));
      await finishProcess(tool("ffmpeg"), args, advance("finish", k), finished.titleStreams.map(s => s.pixels), abort.signal);
      await Promise.all([fs.rm(file("spine", k), { force: true }), fs.rm(file("mask", k), { force: true })]);
    };
    try {
      await new Promise<void>((resolve, reject) => {
        let running = 0, nextSpine = 0, nextFinish = 0, failed = false;
        const fail = (error: unknown) => { if (!failed) { failed = true; abort.abort(error); reject(error); } };
        const pump = () => {
          if (failed) return;
          if (currentActivity()?.signal.aborted) { fail(currentActivity()!.signal.reason); return; }
          if (nextFinish === n && running === 0) { resolve(); return; }
          // A ready finish goes first (it frees its spine file); then the next spine in edit order.
          while (running < exportParts.workers) {
            let job: (() => Promise<void>) | undefined;
            if (nextFinish < n && doneThrough(nextFinish)) { const k = nextFinish++; job = () => finishJob(k); }
            else if (nextSpine < n && (!plan[nextSpine].needsBase || nextSpine === 0 || doneThrough(nextSpine - 1))) { const k = nextSpine++; job = () => spineJob(k); }
            if (!job) break;
            running++;
            job().then(() => { running--; pump(); }, fail);
          }
        };
        pump();
      });
      mark("partsMs");
      const list = path.join(scratch, "parts.txt");
      await fs.writeFile(list, plan.map((_, k) => `file '${file("part", k).replace(/'/g, "'\\''")}'`).join("\n"));
      // Same audio rule as one process: the finished AAC master's packets, copied, never seeked.
      const soundFile = await sound();
      await finishProcess(tool("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, ...(soundFile ? ["-i", soundFile] : []),
        "-map", "0:v:0", ...(soundFile ? ["-map", "1:a:0"] : []), "-t", `${duration}`, "-c", "copy", "-movflags", "+faststart+write_colr", temporary]);
      Object.assign(profile, { parts: n, partWorkers: exportParts.workers, partThreads: exportParts.threads });
    } catch (error) {
      throw await withFullDrive(error, [scratch, directory]);
    } finally {
      abort.abort();
      // EXP3: parts killed a moment ago may still be closing their files; a folder that will not go is the next launch's.
      await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }
  };
  try {
    if (!exportParts.plan.length) {
      const args = head(), filters: string[] = [];
      const spine = await buildSpine(args, filters);
      // EXP2: a still drops the frames more than a second before its moment ahead of detail and grain. Both work
      // frame by frame (grain keeps its own sample count and timestamps), so the kept frame is the same.
      if (opts.still && !behind) filters.push(`[${spine.picture}]trim=start=${Math.max(0, opts.still.t - 1)}[stillWindow]`);
      // PRO2b: a window's frames go on to the finish on the edit's frame clock, as an export part's do (renderParts).
      const windowed = (label: string, out: string) => `[${label}]trim=start_frame=${opts.window!.from}:end_frame=${opts.window!.to},setpts=PTS-STARTPTS,settb=AVTB,setpts=(N+${opts.window!.from})/${fps}/TB,tpad=stop=8:stop_mode=clone[${out}]`;
      if (windowS) filters.push(windowed(spine.picture, "windowPicture"), ...(behind ? [windowed(spine.mask, "windowMask")] : []));
      const finished = windowS ? await buildFinish(args, filters, spine.input, "windowPicture", behind ? "windowMask" : spine.mask, { from: opts.window!.from, to: opts.window!.to })
        : await buildFinish(args, filters, spine.input, opts.still && !behind ? "stillWindow" : spine.picture, spine.mask);
      const titleStreams = finished.titleStreams;
      titleProfiles.push(...titleStreams);
      let input = finished.input, picture = finished.picture;
      mark("titlesMs");
      spine.splits();
      const soundFile = await sound();
      // The player already listens to this finished AAC master. Copy its packets
      // so export cannot add codec clicks, another peak correction, or level drift.
      // Do not seek even to zero: that drops AAC's negative-PTS priming packet
      // and changes the first decoded samples despite copying every later packet.
      const audioInput = soundFile ? input++ : null;
      if (soundFile) args.push("-i", soundFile);
      filters.push(`[${picture}]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv${windowS ? `,trim=end_frame=${opts.window!.to - opts.window!.from},setpts=PTS-STARTPTS` : ""}[finishedPicture]`);
      // A window is a few seconds read for stills: the finished export's constant quality, not the draft's bit rate.
      if (windowS) args.push("-filter_complex", filters.join(";"), "-map", "[finishedPicture]", ...videoEncodeArgs(true), "-pix_fmt", "yuv420p",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-an", "-movflags", "+faststart+write_colr", temporary);
      else if (opts.still) args.push("-filter_complex", filters.join(";"), "-map", "[finishedPicture]", "-ss", `${opts.still.t}`, "-frames:v", "1", "-an", "-q:v", "2", temporary);
      else args.push("-filter_complex", filters.join(";"), "-map", "[finishedPicture]", "-map", `${audioInput}:a:0`, "-t", `${duration}`,
        ...videoEncodeArgs(!!opts.full), "-pix_fmt", "yuv420p",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-ar", "48000",
        "-c:a", "copy", "-movflags", "+faststart+write_colr", temporary);
      const progress = (line: string) => {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (!match) return;
        const doneS = Math.min(duration, Number(match[1]) / 1e6);  // EXP1: the picture's own progress, for the export's stage
        currentActivity()?.stage?.("picture", doneS / duration, { doneS, lengthS: duration });
        reportProgress(30 + doneS / duration * 55);
      };
      try { await finishProcess(tool("ffmpeg"), args, progress, titleStreams.map(s => s.pixels)); }
      catch (error) {
        currentActivity()?.signal.throwIfAborted();
        if (!args.includes("-hwaccel") || !/hardware accelerator|hwaccel|videotoolbox|failed to decode|decoder.*failed/i.test(String(error))) throw error;
        // Retry the same graph once. Keep timestamps, filters and audio identical.
        // -y replaces a partial temporary; nothing is published until success.
        const software = args.filter((arg, i) => arg !== "-hwaccel" && args[i - 1] !== "-hwaccel");
        currentActivity()?.progress(null, "Retrying with software decoding");
        await finishProcess(tool("ffmpeg"), software, progress, titleStreams.map(s => s.pixels));
      }
    } else {
      await renderParts();
    }
    mark("encodeMs");
    reportProgress(88);
    if (!opts.still && !windowS && audio.auto !== false) await verifyEncodedPeaks(temporary, audio.loudnessLUFS, opts.full ? "320k" : "128k", duration, false);
    currentActivity()?.signal.throwIfAborted();
    mark("verificationMs");
    await fs.rename(temporary, output);
    profile.wallMs = performance.now()-started;
    for (const [i, stream] of titleProfiles.entries()) for (const [name, value] of Object.entries(stream.profile)) profile[`title${exportParts.plan.length ? 's' : i}.${name}`] = (exportParts.plan.length ? profile[`titles.${name}`] ?? 0 : 0) + value;
    await fs.writeFile(`${output}.profile.json`, JSON.stringify(profile));
    const tempManifest = `${manifest}.${randomUUID()}.tmp`;
    try { await fs.writeFile(tempManifest, JSON.stringify({ key: await keyOf(), output: await fingerprint(output) })); await fs.rename(tempManifest, manifest); }
    finally { await fs.rm(tempManifest, { force: true }); }
    reportProgress(100);
    return opts.full || opts.still ? output : path.basename(output);
  } catch (error) {
    throw await withFullDrive(error, [directory]);
  } finally { clearInterval(pulse); await fs.rm(temporary, { force: true }); }
}

/**
 * EXP3: a render that stopped on a full drive says so by its code, as a file write does (ENOSPC with the folder), so
 * export can name the drive. ffmpeg's exit carries no code; the drive it wrote to is checked before its temp file goes.
 */
async function withFullDrive(error: unknown, folders: string[]): Promise<unknown> {
  if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code || error.name === "AbortError") return error;
  for (const folder of folders) {
    const free = await fs.statfs(folder).then(s => s.bavail * s.bsize, () => Infinity);
    if (free < 256e6) return Object.assign(error, { code: "ENOSPC", path: folder });
  }
  return error;
}

const runningPid = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};
/**
 * EXP3: remove `precut-export-*` frame folders an export left when its app was killed or crashed (up to about 10 GB of
 * plain frames each). As AV2's cleanupStaleApplePlans: only precut's own prefix, only folders, never one whose owner
 * still runs (this app's own export, or another precut on this Mac). A folder from before owners were written goes
 * once nothing has touched it for an hour. Returns what was removed.
 */
export async function cleanupStaleExportScratch(tmpDir: string = os.tmpdir(), now = Date.now()): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await fs.readdir(tmpDir).catch(() => [] as string[])) {
    if (!/^precut-export-[A-Za-z0-9]{6}$/.test(name)) continue;
    const target = path.join(tmpDir, name);
    try {
      const stat = await fs.lstat(target);
      if (!stat.isDirectory()) continue;
      const owner = await fs.readFile(path.join(target, "owner.pid"), "utf8").then(text => Number(text.trim()), () => null);
      if (owner !== null ? runningPid(owner) : now - stat.mtimeMs < 3600_000) continue;
      await fs.rm(target, { recursive: true, force: true });
      removed.push(target);
    } catch { /* still in use or already gone; the next launch looks again */ }
  }
  return removed;
}
