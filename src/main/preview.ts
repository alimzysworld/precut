// Draft pictures decode lifted proxies; matched voice uses the recorder WAV.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Clip, Template } from "../shared/schema";
import type { CutItem } from "./export";
import { cropPathFor, cropXExpression } from "./framing";

export interface PreviewOptions {
  name: string; // precut folder basename, without the video extension
  template: Pick<Template, "width" | "height" | "fps">;
  music?: { file: string; startS: number; gainDb: number };
}

// Shared by the spine and picture-only overlays. Convert original pixel
// coordinates to fractions so the identical crop applies to a smaller proxy.
export function previewFraming(clip: Clip, s: number, e: number, out: { w: number; h: number },
  input: string, output: string): string[] {
  const { w, h } = out;
  const crop = cropPathFor(clip, s, e, out);
  if (crop) {
    const width = clip.meta!.width, height = clip.meta!.height;
    const x = crop.keyframes ? `iw*(${cropXExpression(crop)})/${width}` : `iw*${crop.x / width}`;
    return [`[${input}]crop=w=iw*${crop.w / width}:h=ih*${crop.h / height}:x='${x}':y=ih*${crop.y / height}:exact=1,scale=${w}:${h},setsar=1,format=yuv420p[${output}]`];
  }
  const bgW = 96, bgH = Math.round(h / 10 / 2) * 2;
  return [
    `[${input}]split=2[${output}fg][${output}bg]`,
    `[${output}bg]scale=${bgW}:${bgH}:force_original_aspect_ratio=increase,crop=${bgW}:${bgH},boxblur=6:1,scale=${w}:${h}:flags=fast_bilinear,setsar=1[${output}fill]`,
    `[${output}fg]scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[${output}fit]`,
    `[${output}fill][${output}fit]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p[${output}]`,
  ];
}

// Negative offsets mean the recorder started later. Preserve that initial
// silence rather than shifting later speech forward or mixing in the camera.
export function voiceAudioSource(clip: Clip, s: number): { file: string; startS: number; delayS: number } {
  const start = (clip.sound?.offsetS ?? 0) + s;
  if (!Number.isFinite(start)) throw new Error(`Invalid sound offset for ${clip.id}.`);
  return { file: clip.sound?.file ?? clip.file, startS: Math.max(0, start), delayS: Math.max(0, -start) };
}

function encode(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-6000); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 120_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg preview exited ${code}: ${stderr}`));
    });
  });
}

// Only drafts get this listening level. Copy the finished picture and measure
// the complete audio mix, then apply the measured loudnorm second pass.
export async function normalisePreviewAudio(file: string): Promise<void> {
  const target = "loudnorm=I=-16:TP=-1.5:LRA=11";
  const { stderr } = await promisify(execFile)("ffmpeg", ["-hide_banner", "-nostats", "-i", file,
    "-map", "0:a:0", "-vn", "-af", `${target}:print_format=json`, "-f", "null", "-"],
  { timeout: 120_000, maxBuffer: 1024 * 1024 });
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
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function renderPreview(root: string, cutList: CutItem[], opts: PreviewOptions): Promise<string> {
  if (!cutList.length) throw new Error("The preview cut list is empty.");
  if (!opts.name || path.basename(opts.name) !== opts.name) throw new Error("Invalid preview name.");
  const { width, height, fps } = opts.template;
  if (![width, height, fps].every((v) => Number.isFinite(v) && v > 0)) throw new Error("Invalid preview template.");
  const w = 960, h = Math.round((w * height / width) / 2) * 2;
  const lengthS = cutList.reduce((sum, item) => sum + item.durTimelineFrames / fps, 0);
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-filter_complex_threads", "4"];
  const filters: string[] = [];
  let input = 0;
  const proxies = await fs.realpath(path.join(root, ".sidething", "proxies"));
  for (const [i, item] of cutList.entries()) {
    const duration = item.durTimelineFrames / fps;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Invalid preview duration.");
    if (!item.seg) {
      args.push("-f", "lavfi", "-t", `${duration}`, "-i", `color=c=black:s=${w}x${h}:r=${fps}`);
      filters.push(`[${input++}:v]setpts=PTS-STARTPTS,setsar=1[v${i}]`);
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[a${i}]`);
      continue;
    }
    const clip = item.seg.clip;
    if (!clip.proxy) throw new Error(`No proxy for ${clip.id}; generate proxies first.`);
    const proxy = await fs.realpath(path.resolve(proxies, clip.proxy));
    if (!proxy.startsWith(proxies + path.sep)) throw new Error(`Proxy outside cache: ${clip.id}`);
    const sourceFps = clip.meta?.fps || fps;
    const start = item.inFrames / sourceFps;
    const videoInput = input++;
    args.push("-threads", "2", "-ss", `${start}`, "-t", `${duration}`, "-i", proxy);
    filters.push(`[${videoInput}:v]setpts=PTS-STARTPTS,fps=${fps}[picture${i}]`);
    filters.push(...previewFraming(clip, start, start + duration, { w, h }, `picture${i}`, `v${i}`));
    const mic = item.seg.lineIndex !== null && clip.sound ? voiceAudioSource(clip, start) : null;
    if (mic && mic.delayS < duration) {
      args.push("-ss", `${mic.startS}`, "-t", `${duration - mic.delayS}`, "-i", path.resolve(root, mic.file));
      filters.push(`[${input++}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${mic.delayS * 1000}:all=1,apad,atrim=duration=${duration}[a${i}]`);
    } else if (!mic && (clip.meta?.audioChannels ?? 0) > 0) {
      filters.push(`[${videoInput}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${duration}[a${i}]`);
    } else {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[a${i}]`);
    }
  }
  filters.push(cutList.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${cutList.length}:v=1:a=1[v][camera]`);
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
  args.push("-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]", "-t", `${lengthS}`,
    "-c:v", "h264_videotoolbox", "-b:v", "4M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart", temporary);
  try {
    await encode(args);
    await normalisePreviewAudio(temporary);
    await fs.rename(temporary, output);
    return name;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
