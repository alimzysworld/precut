import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { app } from "electron";
import type { CutVersion, PrecutResult, ReelOptions, Shoot, Template } from "../shared/schema";
import { getMusicFolder } from "./settings";
import { buildCutList, type CutItem, type Segment } from "./export";
import { sidekickSend, exportSidekickCut } from "./sidekick";
import { normalisePreviewAudio, previewFraming, voiceAudioSource } from "./preview";

export interface MusicTrack {
  file: string; name: string; durationS: number; tempo: number;
  beats: number[]; loudnessDb: number[]; integratedLUFS: number;
  moments: { buildS: number | null; dropS: number | null }; energy: string;
}
export interface ReelAnswer {
  title: string; voice: { id: string }[]; broll: { id: string; over: string | null }[];
  music: { file: string; startS: number } | null; why: string; warnings: string[];
}
export interface ReelAssembly {
  title: string; why: string; warnings: string[]; model: ReelAnswer;
  missing?: string[];
  voiceLUFS: number | null;
  music?: { file: string; startS: number; gainDb: number; durationS: number; musicLUFS: number };
  broll: { id: string; over: string; voiceIndex: number; seg: Segment }[];
  cuts: { id: string; clipId: string; s: number; e: number; offsetS: number; beatDeltaS: number; beatS: number | null }[];
}
export type ReelResult = PrecutResult & { reel: ReelAssembly };

async function resource(relative: string): Promise<string> {
  const candidates = [path.join(process.cwd(), relative),
    path.join(app.getAppPath(), relative),
    path.join(process.resourcesPath ?? "", relative)];
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch { /* next */ }
  }
  throw new Error(`Could not find ${relative}.`);
}

export async function reelCatalog(): Promise<{ tracks: MusicTrack[]; warnings: string[] }> {
  const folder = await getMusicFolder();
  if (!folder) return { tracks: [], warnings: [] };
  const python = path.join(os.homedir(), "Library/Application Support/precut/venv/bin/python");
  const { stdout } = await promisify(execFile)(python, ["-I", await resource("pipeline/music.py"), folder,
    "--cache", path.join(app.getPath("userData"), "music-cache.json")],
  { timeout: 10 * 60_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NUMBA_CACHE_DIR: path.join(app.getPath("userData"), "numba-cache") } });
  return JSON.parse(stdout);
}

// Beats live in music source time. All movements are forward from the padded
// cut, quantized to the camera frame grid and contained in measured silence.
export function snapReelCuts(cuts: CutItem[], template: Template, track?: MusicTrack, startS = 0): { beatDeltaS: number; beatS: number | null }[] {
  let offsetS = 0;
  return cuts.map((cut, index) => {
    const clip = cut.seg?.clip;
    const fps = clip?.meta?.fps || template.fps;
    const end = cut.outFrames / fps;
    let delta = 0, beatS: number | null = null;
    if (track && clip && cut.seg) {
      const words = (clip.transcript ?? []).flatMap((part) => part.words)
        .filter((w) => Number.isFinite(w.s) && Number.isFinite(w.e)).sort((a, b) => a.s - b.s);
      const last = words.filter((w) => w.s < cut.seg!.e && w.e <= cut.seg!.e + 1e-6).at(-1);
      const next = words.find((w) => w.s >= cut.seg!.e - 1e-6 && w.e > cut.seg!.e + 1e-6);
      const nextCut = cuts[index + 1];
      let limit = Math.min(clip.meta!.durationS, next?.s ?? Infinity);
      if (nextCut?.seg?.clip.id === clip.id && nextCut.inFrames / fps >= end) limit = Math.min(limit, nextCut.inFrames / fps);
      // Unknown words, or a current cut already inside a word: do not guess.
      if (last && end >= last.e && !words.some((w) => w.s < end && w.e > end)) {
        const boundary = offsetS + cut.durTimelineFrames / template.fps;
        for (const beat of track.beats) {
          const proposed = beat - startS - boundary;
          if (proposed < -1e-7 || proposed > 0.25 + 1e-7) continue;
          const frames = Math.round((end + proposed) * fps);
          const movement = frames / fps - end;
          if (movement < -1e-7 || movement > 0.25 + 1e-7 || frames / fps > limit + 1e-7) continue;
          delta = Math.max(0, movement); beatS = beat;
          cut.outFrames = frames;
          cut.durTimelineFrames = (cut.outFrames - cut.inFrames) / fps * template.fps;
          break; // nearest eligible later beat
        }
      }
    }
    cut.offsetFrames = offsetS * template.fps;
    offsetS += cut.durTimelineFrames / template.fps;
    return { beatDeltaS: delta, beatS };
  });
}

// Measure the same voice source as the preview (recorder when matched), using
// the original camera audio otherwise to avoid proxy AAC losses.
export async function measureReelVoice(root: string, cuts: CutItem[], template: Template): Promise<number | null> {
  if (!cuts.length) return null;
  const args = ["-hide_banner", "-nostats", "-filter_complex_threads", "4"];
  const filters: string[] = [];
  let input = 0;
  for (const [i, cut] of cuts.entries()) {
    const duration = cut.durTimelineFrames / template.fps;
    const clip = cut.seg?.clip;
    const audio = clip && cut.seg!.lineIndex !== null && (clip.sound || (clip.meta?.audioChannels ?? 0) > 0)
      ? voiceAudioSource(clip, cut.inFrames / (clip.meta?.fps || template.fps)) : null;
    if (audio && audio.delayS < duration) {
      args.push("-ss", `${audio.startS}`, "-t", `${duration - audio.delayS}`, "-i", path.resolve(root, audio.file));
      filters.push(`[${input++}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${audio.delayS * 1000}:all=1,apad,atrim=duration=${duration}[voice${i}]`);
    } else filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[voice${i}]`);
  }
  filters.push(cuts.map((_, i) => `[voice${i}]`).join("") +
    `concat=n=${cuts.length}:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json[measured]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[measured]", "-vn", "-f", "null", "-");
  const { stderr } = await promisify(execFile)("ffmpeg", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const report = JSON.parse(stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1));
  const lufs = Number(report.input_i);
  return Number.isFinite(lufs) ? lufs : null;
}

// The catalog is shared by conversation context and every reel assembly.
export function reelIds(shoot: Shoot) {
  const voice = new Map<string, Segment>();
  const takes = shoot.takes.flatMap((take) => take.attempts.map((attempt, n) => {
    const id = `L${take.lineIndex + 1}A${n + 1}`;
    const clip = shoot.clips.find((c) => c.id === attempt.clipId);
    if (!clip?.meta || !Number.isFinite(attempt.s) || !Number.isFinite(attempt.e) || attempt.s < 0 || attempt.e > clip.meta.durationS || attempt.e <= attempt.s) return null;
    voice.set(id, { clip, s: attempt.s, e: attempt.e, lineIndex: take.lineIndex, marker: `${id}: ${attempt.text.split(/\s+/).slice(0, 7).join(" ")}` });
    return { id, clipId: clip.id, s: attempt.s, e: attempt.e, lineIndex: take.lineIndex, text: attempt.text, lengthS: attempt.e - attempt.s, note: attempt.note,
      starred: take.starred === n, why: take.why };
  })).filter((take): take is NonNullable<typeof take> => take !== null);
  const broll = new Map<string, Segment>();
  for (const clip of shoot.clips) {
    const j = clip.judgement;
    if (!j || !clip.meta || (j.kind !== "broll" && !(j.verdict === "maybe" && /b-?roll/i.test(j.summary)))) continue;
    const spans = j.usableSpans.length ? j.usableSpans : j.kind === "broll" ? [[0, clip.meta.durationS]] : [];
    for (const [s, e] of spans) {
      if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s || e > clip.meta.durationS) continue;
      const id = `B${broll.size + 1}`;
      broll.set(id, { clip, s, e, marker: j.summary.replace(/\s+/g, " "), lineIndex: null });
    }
  }
  return { voice, broll, takes };
}

// Resolve from the saved assembly, never from a renderer-built id catalog.
// This also lets older versions use the new contract without re-cutting them.
export function resolveReelPieces(shoot: Shoot, template: Template, cuts: CutItem[], reel: ReelAssembly): NonNullable<CutVersion["pieces"]> {
  return cuts.flatMap((cut, index) => {
    if (!cut.seg) return [];
    const { clip, lineIndex } = cut.seg;
    const fps = clip.meta!.fps || template.fps;
    const id = reel.cuts[index].id;
    const match = /^L(\d+)A(\d+)$/.exec(id);
    const attempt = match ? shoot.takes.find((t) => t.lineIndex === Number(match[1]) - 1)?.attempts[Number(match[2]) - 1] : undefined;
    const overlay = reel.broll.find((b) => b.voiceIndex === index);
    const overlayFps = overlay?.seg.clip.meta!.fps || template.fps;
    const overlayS = overlay ? Math.ceil(overlay.seg.s * overlayFps) / overlayFps : 0;
    const overlayLength = overlay ? Math.min(Math.floor(overlay.seg.e * overlayFps) / overlayFps - overlayS, cut.durTimelineFrames / template.fps) : 0;
    return [{
      id, kind: lineIndex === null ? "broll" as const : "voice" as const,
      clipId: clip.id, s: cut.inFrames / fps, e: cut.outFrames / fps,
      timelineS: cut.offsetFrames / template.fps, lengthS: cut.durTimelineFrames / template.fps,
      ...(lineIndex === null ? { description: cut.seg.marker } : { words: attempt?.text ?? cut.seg.marker }),
      overlay: overlay && overlayLength > 0 ? {
        id: overlay.id, clipId: overlay.seg.clip.id, s: overlayS, e: overlayS + overlayLength, description: overlay.seg.marker,
      } : null,
      beatSnapS: reel.cuts[index].beatDeltaS,
    }];
  });
}

export async function assembleReel(root: string, shoot: Shoot, template: Template, answer: ReelAnswer,
  opts: { lengthS: number; musicFile?: string | null }, candidates: MusicTrack[], catalogWarnings: string[] = []) {
  const { voice, broll } = reelIds(shoot);
  const warnings = [...answer.warnings, ...catalogWarnings];
  const ids = answer.voice.map((v) => v.id).filter((id) => {
    if (voice.has(id) || broll.has(id)) return true;
    warnings.push(`Dropped unknown footage id ${id}.`); return false;
  });
  const spineIds = ids;
  if (!spineIds.length) throw new Error("The cut contained no known footage ids. Try again.");
  const segments = ids.map((id) => (voice.get(id) ?? broll.get(id))!);
  const cutList = buildCutList(shoot, "reel", template, segments);
  let track = answer.music ? candidates.find((t) => t.file === answer.music!.file || t.name === answer.music!.file) : undefined;
  if (answer.music && !track) warnings.push("Dropped an unknown or unrequested music track.");
  if (typeof opts.musicFile === "string") track = candidates[0];
  const requestedStart = answer.music?.startS ?? 0;
  const initialLength = cutList.reduce((s, c) => s + c.durTimelineFrames / template.fps, 0);
  const startS = track ? Math.min(requestedStart, Math.max(0, track.durationS - initialLength)) : 0;
  if (track && startS !== requestedStart) warnings.push(`Moved music start to ${startS.toFixed(2)} s to keep the track under the whole reel.`);
  const snaps = snapReelCuts(cutList, template, track, startS);
  const voiceLUFS = await measureReelVoice(root, cutList.filter((c) => c.seg?.lineIndex !== null), template);
  const hasVoice = ids.some((id) => voice.has(id));
  if (track && ((voiceLUFS === null && hasVoice) || !Number.isFinite(track.integratedLUFS))) {
    warnings.push("Omitted music because the voice or track has no measurable integrated loudness.");
    track = undefined;
  }
  if (track && !hasVoice) warnings.push("No voice in this cut; music uses a quiet -31 LUFS reference level.");
  const requestedGain = track ? (voiceLUFS ?? -16) - 15 - track.integratedLUFS : 0;
  const gainDb = Math.round(requestedGain * 100) / 100;
  const lengthS = cutList.reduce((s, c) => s + c.durTimelineFrames / template.fps, 0);
  if (Math.abs(lengthS - opts.lengthS) > opts.lengthS * 0.1) warnings.push(lengthS < opts.lengthS
    ? `Best clean cut is ${lengthS.toFixed(2)} s for the ${opts.lengthS} s target. No padding added.`
    : `The clean takes run ${lengthS.toFixed(2)} s for the ${opts.lengthS} s target.`);
  if (track && track.durationS - startS < lengthS) warnings.push("The music ends before the voice; the remaining reel is voice only.");
  const overlays: ReelAssembly["broll"] = [];
  for (const overlay of answer.broll) {
    const seg = broll.get(overlay.id), voiceIndex = overlay.over === null ? -1 : spineIds.indexOf(overlay.over);
    if (!seg || overlay.over === null || !voice.has(overlay.over) || voiceIndex < 0) {
      warnings.push(`Dropped b-roll ${overlay.id} over ${overlay.over}: overlay must name a voice id in this cut.`); continue;
    }
    const fps = seg.clip.meta!.fps || template.fps;
    if (Math.floor(seg.e * fps) <= Math.ceil(seg.s * fps)) {
      warnings.push(`Dropped b-roll ${overlay.id}: no whole source frame in its usable span.`); continue;
    }
    if (overlays.some((b) => b.voiceIndex === voiceIndex)) { warnings.push(`Dropped overlapping b-roll ${overlay.id} over ${overlay.over}.`); continue; }
    overlays.push({ id: overlay.id, over: overlay.over, voiceIndex, seg });
  }
  const reel: ReelAssembly = { title: answer.title, why: answer.why, warnings, model: answer, voiceLUFS,
    music: track ? { file: track.file, startS, gainDb, durationS: track.durationS, musicLUFS: track.integratedLUFS } : undefined,
    broll: overlays, cuts: cutList.map((cut, i) => ({ id: spineIds[i], clipId: cut.seg!.clip.id,
      s: cut.inFrames / (cut.seg!.clip.meta!.fps || template.fps),
      e: cut.outFrames / (cut.seg!.clip.meta!.fps || template.fps), offsetS: cut.offsetFrames / template.fps, ...snaps[i] })) };
  return { cutList, reel, lengthS };
}

// Legacy reel form uses exactly the same prompt, thread, ids and assembly.
export async function makeReel(root: string, templateId: string, opts: ReelOptions,
  output: { outputFolder?: string; skipMicSync?: boolean } = {}): Promise<ReelResult> {
  if (!opts?.concept?.trim() || !Number.isFinite(opts.lengthS) || opts.lengthS <= 0 || !Array.isArray(opts.skillIds)) {
    throw new Error("Add a concept and a target length for your reel.");
  }
  const message = await sidekickSend(root, `Cut a reel with this concept: ${opts.concept}`, { ...opts, templateId });
  if (!message.cut) throw new Error(message.error ?? message.text);
  return exportSidekickCut(root, message.cut.cutId, message.cut.version, output.outputFolder);
}

// P1 handles the voice spine and music. Composite connected b-roll from the
// same lifted proxy cache; keep its audio untouched (b-roll is video only).
export async function compositeReelPreview(root: string, preview: string, cuts: CutItem[], template: Template,
  overlays: ReelAssembly["broll"], music?: ReelAssembly["music"]): Promise<void> {
  const base = path.join(root, ".sidething/precuts", preview);
  const temporary = base + `.${process.pid}.overlay.mp4`;
  const args = ["-v", "error", "-y", "-filter_complex_threads", "4", "-i", base];
  const filters: string[] = [];
  const proxies = await fs.realpath(path.join(root, ".sidething/proxies"));
  const w = 960, h = Math.round(w * template.height / template.width / 2) * 2;
  for (const [i, overlay] of overlays.entries()) {
    if (!overlay.seg.clip.proxy) throw new Error(`No b-roll proxy for ${overlay.id}.`);
    const proxy = await fs.realpath(path.resolve(proxies, overlay.seg.clip.proxy));
    if (!proxy.startsWith(proxies + path.sep)) throw new Error("B-roll proxy outside cache.");
    const cut = cuts[overlay.voiceIndex];
    const fps = overlay.seg.clip.meta!.fps || template.fps;
    const start = Math.ceil(overlay.seg.s * fps) / fps;
    const duration = Math.min(Math.floor(overlay.seg.e * fps) / fps - start, cut.durTimelineFrames / template.fps);
    const offset = cut.offsetFrames / template.fps;
    args.push("-ss", `${start}`, "-t", `${duration}`, "-i", proxy);
    // Framing paths use time relative to this piece, before timeline placement.
    filters.push(`[${i + 1}:v]setpts=PTS-STARTPTS,fps=${template.fps}[picture${i}]`);
    filters.push(...previewFraming(overlay.seg.clip, start, start + duration, { w, h }, `picture${i}`, `framed${i}`));
    filters.push(`[framed${i}]setpts=PTS-STARTPTS+${offset}/TB[b${i}]`);
    filters.push(`[${i === 0 ? "0:v" : `v${i - 1}`}][b${i}]overlay=eof_action=pass:enable='gte(t,${offset})*lt(t,${offset + duration})'[v${i}]`);
  }
  // P1's draft uses a 1.5 s fade. Rebuild reel audio from the matched recorder
  // or the camera proxy, according to the same selection as the first pass,
  // for the exact 1 s music fade used by the exported timeline, keeping voice up.
  if (music) {
    let input = overlays.length + 1;
    for (const [i, cut] of cuts.entries()) {
      const duration = cut.durTimelineFrames / template.fps;
      const clip = cut.seg?.clip;
      const audio = clip && cut.seg!.lineIndex !== null && (clip.sound || (clip.meta?.audioChannels ?? 0) > 0)
        ? voiceAudioSource(clip, cut.inFrames / (clip.meta?.fps || template.fps)) : null;
      if (audio && audio.delayS < duration) {
        let file = path.resolve(root, audio.file);
        if (!clip!.sound) {
          file = await fs.realpath(path.resolve(proxies, clip!.proxy!));
          if (!file.startsWith(proxies + path.sep)) throw new Error("Voice proxy outside cache.");
        }
        args.push("-ss", `${audio.startS}`, "-t", `${duration - audio.delayS}`, "-i", file);
        filters.push(`[${input++}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${audio.delayS * 1000}:all=1,apad,atrim=duration=${duration}[voice${i}]`);
      } else filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[voice${i}]`);
    }
    const length = cuts.reduce((sum, c) => sum + c.durTimelineFrames / template.fps, 0);
    filters.push(cuts.map((_, i) => `[voice${i}]`).join("") + `concat=n=${cuts.length}:v=0:a=1[voice]`);
    args.push("-ss", `${music.startS}`, "-t", `${length}`, "-i", path.resolve(root, music.file));
    filters.push(`[${input}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${music.gainDb}dB,apad,atrim=duration=${length},afade=t=out:st=${Math.max(0, length - 1)}:d=${Math.min(1, length)}[music]`);
    filters.push("[voice][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:latency=1[reelAudio]");
  }
  if (filters.length) args.push("-filter_complex", filters.join(";"));
  args.push("-map", overlays.length ? `[v${overlays.length - 1}]` : "0:v", "-map", music ? "[reelAudio]" : "0:a");
  args.push("-c:a", music ? "aac" : "copy");
  if (music) args.push("-b:a", "128k");
  if (overlays.length) args.push("-c:v", "h264_videotoolbox", "-b:v", "4M", "-pix_fmt", "yuv420p");
  else args.push("-c:v", "copy");
  args.push("-movflags", "+faststart", temporary);
  try {
    await promisify(execFile)("ffmpeg", args, { timeout: 120_000, maxBuffer: 1024 * 1024 });
    if (music) await normalisePreviewAudio(temporary);
    await fs.rename(temporary, base);
  } finally { await fs.rm(temporary, { force: true }); }
}
