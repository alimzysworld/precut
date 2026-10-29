import { clipStarred } from "./footage-stars";
import { canVideoToolboxDecode } from './video-decode';
import { sourceAudioInput, mapSourceAudioGraph } from './source-audio';
import { runActivity, threads } from "./activity";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { musicReferences } from "./music";
import { tool } from "./tools";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { app } from "electron";
import type { CutVersion, PrecutResult, ReelOptions, Shoot, Template } from "../shared/schema";
import { getMusicFolder } from "./settings";
import { buildCutList, cutPieceGroups, type CutItem, type Segment } from "./export";
import { sidekickSend, exportSidekickCut } from "./sidekick";
import { normalisePreviewAudio, previewFraming, voiceAudioSource, cutAudioTail, joinCutAudio, finishCutAudio } from "./preview";

export interface MusicTrack {
  file: string; name: string; durationS: number; tempo: number;
  beats: number[]; loudnessDb: number[]; integratedLUFS: number;
  moments: { buildS: number | null; dropS: number | null }; energy: string;
}
export interface ReelAnswer {
  shotOrderReason?: string; // V47: explicit editorial exception, also saved in why
  title: string; voice: { id: string }[]; broll: { id: string; over: string | null }[];
  photoSpans?: { id: string; s: number; e: number }[];
  spans?: { id: string; s: number; e: number }[];
  music: { file: string; startS: number } | null; why: string; warnings: string[];
}
export interface ReelAssembly {
  title: string; why: string; warnings: string[]; model: ReelAnswer;
  missing?: string[];
  voiceLUFS: number | null;
  music?: { file: string; startS: number; endS?: number; gainDb: number; durationS: number; musicLUFS: number; fit?: boolean; followStory?: boolean };
  broll: { id: string; over: string; voiceIndex: number; seg: Segment }[];
  cuts: { id: string; clipId: string; s: number; e: number; offsetS: number; lengthS?: number; beatDeltaS: number; beatS: number | null }[];
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

// PS4: one measurement per state of the music library. The key is every audio file in the folder and every added
// track (path, size, time) plus the measuring script, so nothing starts Python while none of them changed.
const MUSIC_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".aiff", ".aif", ".flac", ".ogg", ".opus", ".mp4"]);
let catalogMemo: { key: string; result: Promise<{ tracks: MusicTrack[]; warnings: string[] }> } | null = null;
async function musicLibraryKey(folder: string | null, references: string[], script: string): Promise<string> {
  const files: string[] = [];
  if (folder) {
    let names: string[] = [];
    try { names = (await fs.readdir(folder, { recursive: true })).map(String); } catch { /* a missing folder lists nothing, as music.py does */ }
    for (const name of names) if (MUSIC_EXTENSIONS.has(path.extname(name).toLowerCase())) files.push(path.join(folder, name));
  }
  files.push(...references.map(file => path.resolve(file)), script);
  const stats = await Promise.all(files.map(file => fs.stat(file).then(s => [file, s.isFile() ? s.size : -1, s.mtimeMs] as const, () => [file, -1, -1] as const)));
  return JSON.stringify([folder, references, stats.sort((a, b) => a[0].localeCompare(b[0]))]);
}

export async function reelCatalog(): Promise<{ tracks: MusicTrack[]; warnings: string[] }> {
  const folder = await getMusicFolder();
  const references = await musicReferences();
  if (!folder && !references.length) return { tracks: [], warnings: [] };
  const python = path.join(os.homedir(), "Library/Application Support/precut/venv/bin/python");
  const script = await resource("pipeline/music.py");
  const key = await musicLibraryKey(folder, references, script);
  if (catalogMemo?.key !== key) {
    // Optional measuring: background lane, so it never holds up work the person is waiting for.
    const result = runActivity({ kind: "render", root: null, target: null, label: "Measuring music", cancelable: true }, async activity => {
      const { stdout } = await promisify(execFile)(python, ["-I", script, ...(folder ? [folder] : []), "--files", ...references,
        "--cache", path.join(app.getPath("userData"), "music-cache.json")],
      { signal: activity.signal, timeout: 10 * 60_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NUMBA_CACHE_DIR: path.join(app.getPath("userData"), "numba-cache") } });
      return JSON.parse(stdout) as { tracks: MusicTrack[]; warnings: string[] };
    }, { renderLane: "background" });
    const memo = { key, result };
    catalogMemo = memo;
    result.catch(() => { if (catalogMemo === memo) catalogMemo = null; });
  }
  // Callers may adjust what they get back; the memo stays as measured.
  return structuredClone(await catalogMemo!.result);
}

// Beats live in music source time. All movements are forward from the padded
// cut, quantized to the camera frame grid and contained in measured silence.
export function snapReelCuts(cuts: CutItem[], template: Template, track?: MusicTrack, startS = 0, options?: { nearest: boolean; speed?: (piece: number) => number; boundary?: (cuts: CutItem[], index: number) => number }): { beatDeltaS: number; beatS: number | null }[] {
  let offsetS = 0;
  const snaps: { beatDeltaS: number; beatS: number | null }[] = [];
  cuts.forEach((cut, index) => {
    const piece = cut.piece ?? index;
    const lastInPiece = index === cuts.length - 1 || (cuts[index + 1].piece ?? index + 1) !== piece;
    const clip = cut.seg?.clip;
    const fps = cut.clipFpsR.num / cut.clipFpsR.den;
    const end = cut.outFrames / fps;
    let delta = 0, beatS: number | null = null;
    if (lastInPiece && index < cuts.length - 1 && options?.nearest && track && clip && cut.seg) {
      const words = [...cut.seg.speechWords ?? [], ...clip.transcript?.flatMap(p => p.words) ?? []].filter(w => Number.isFinite(w.s) && Number.isFinite(w.e));
      const spoken = words.filter(w => w.s < end && w.e > cut.inFrames / fps);
      // Unknown voice edges are never guessed. B-roll has no spoken words.
      const known = cut.seg.lineIndex === null || spoken.length > 0;
      const lower = Math.max(cut.inFrames / fps + 1 / fps, ...spoken.map(w => w.e + .03));
      const nextWord = words.filter(w => w.s >= end).reduce((n, w) => Math.min(n, w.s - .03), Infinity);
      const filler = (clip.fillers ?? []).filter(f => f.e > end).reduce((n, f) => Math.min(n, Math.max(end, f.s)), Infinity);
      const upper = Math.min(clip.meta!.durationS, nextWord, filler, cut.seg.outLimitS === undefined ? Infinity : cut.seg.outLimitS - .03);
      const boundary = options.boundary?.(cuts, index) ?? offsetS + cut.durTimelineFrames / template.fps;
      const speed = options.speed?.(piece) ?? 1;
      if (known && !words.some(w => w.s < end && w.e > end)) {
        for (const beat of [...track.beats].sort((a, b) => Math.abs(a - startS - boundary) - Math.abs(b - startS - boundary) || a - b)) {
          const proposed = beat - startS - boundary;
          if (Math.abs(proposed) > .25 + 1e-7) continue;
          const frames = Math.round((end + proposed * speed) * fps), sourceEnd = frames / fps;
          if (sourceEnd < lower - 1e-7 || sourceEnd > upper + 1e-7) continue;
          const old = { ...cut };
          cut.outFrames = frames; cut.durTimelineFrames = (frames - cut.inFrames) / fps * template.fps;
          const actual = options.boundary?.(cuts, index) ?? boundary + (sourceEnd - end) / speed;
          if (Math.abs(actual - (beat - startS)) > 1 / template.fps + 1e-7) { Object.assign(cut, old); continue; }
          delta = sourceEnd - end; beatS = beat; break;
        }
      }
    } else if (!options?.nearest && lastInPiece && track && clip && cut.seg && end >= cut.seg.e - 1e-6) {
      const words = (clip.transcript ?? []).flatMap((part) => part.words)
        .filter((w) => Number.isFinite(w.s) && Number.isFinite(w.e)).sort((a, b) => a.s - b.s);
      const last = words.filter((w) => w.s < cut.seg!.e && w.e <= cut.seg!.e + 1e-6).at(-1);
      const next = words.find((w) => w.s >= cut.seg!.e - 1e-6 && w.e > cut.seg!.e + 1e-6);
      const nextCut = cuts[index + 1];
      const fillerStart = (clip.fillers ?? []).filter((f) => f.e > end).reduce((s, f) => Math.min(s, Math.max(end, f.s)), Infinity);
      let limit = Math.min(clip.meta!.durationS, cut.seg.energyMeasured ? Infinity : next?.s ?? Infinity, fillerStart);
      if (nextCut?.seg?.clip.id === clip.id && nextCut.inFrames / fps >= end) limit = Math.min(limit, nextCut.inFrames / fps);
      // Measured take edges know the next real sound better than the whole-clip transcript (X4).
      if (cut.seg.outLimitS !== undefined) limit = Math.min(limit, cut.seg.outLimitS - 0.03);
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
    if (lastInPiece) snaps[piece] = { beatDeltaS: delta, beatS };
  });
  return snaps;
}

// Measure the same voice source as the preview (recorder when matched), using
// the original camera audio otherwise to avoid proxy AAC losses.
// PS4: keyed by take span. Each voice span's K-weighted energy (BS.1770, 10 ms steps) is measured once and kept per
// span, on disk and in memory; the edit's integrated loudness is gated over the joined spans. A trim or swap decodes
// only the span that changed.
const VOICE_STEP = 480; // 10 ms at 48 kHz
const VOICE_ENERGY_REVISION = 1;
const voiceEnergies = new Map<string, Promise<Float32Array>>();
function kWeightedEnergy(samples: Float32Array): Float32Array {
  // BS.1770-4 pre-filter and RLB high-pass at 48 kHz, run per channel over interleaved stereo.
  const [b0, b1, b2, a1, a2] = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, .73248077421585];
  const [c1, c2] = [-1.99004745483398, .99007225036621];
  const frames = Math.floor(samples.length / 2), out = new Float64Array(Math.ceil(frames / VOICE_STEP));
  for (let ch = 0; ch < 2; ch++) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, v1 = 0, v2 = 0;
    for (let i = 0; i < frames; i++) {
      const x = samples[i * 2 + ch];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y;
      const v = y - 2 * u1 + u2 - c1 * v1 - c2 * v2; u2 = u1; u1 = y; v2 = v1; v1 = v;
      out[Math.floor(i / VOICE_STEP)] += v * v / VOICE_STEP;
    }
  }
  return Float32Array.from(out);
}
async function decodeVoiceSpan(file: string, startS: number, readS: number, filter: string, signal?: AbortSignal): Promise<Float32Array> {
  const audioInput = await sourceAudioInput(file);
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(tool("ffmpeg"), ["-hide_banner", "-nostats", "-v", "error", "-threads", String(threads(1)), "-ss", `${startS}`, "-t", `${readS}`, ...audioInput,
      "-af", filter, "-c:a", "pcm_f32le", "-ar", "48000", "-ac", "2", "-f", "f32le", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let stderr = "";
    const abort = () => child.kill("SIGKILL"), timer = setTimeout(abort, 120_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.once("error", error => { done(); reject(error); });
    child.once("close", code => {
      done();
      if (signal?.aborted) return reject(signal.reason);
      if (code !== 0) return reject(new Error(`Could not measure the voice: ${stderr.trim() || `ffmpeg exited ${code}`}`));
      const bytes = Buffer.concat(chunks);
      resolve(new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4)).slice());
    });
  });
}
async function voiceSpanEnergy(root: string, file: string, startS: number, readS: number, filter: string, signal?: AbortSignal): Promise<Float32Array> {
  const stat = await fs.stat(file);
  const key = createHash("sha256").update(JSON.stringify([VOICE_ENERGY_REVISION, file, stat.size, stat.mtimeMs, startS, readS, filter])).digest("hex");
  let work = voiceEnergies.get(key);
  if (!work) {
    const cached = path.join(root, ".sidething", "finish-cache", `voice-energy-${key}.f32`);
    work = (async () => {
      try { const bytes = await fs.readFile(cached); if (bytes.length % 4 === 0) return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4).slice(); }
      catch { /* not measured yet */ }
      const energy = kWeightedEnergy(await decodeVoiceSpan(file, startS, readS, filter, signal));
      try {
        await fs.mkdir(path.dirname(cached), { recursive: true });
        const temporary = `${cached}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        await fs.writeFile(temporary, Buffer.from(energy.buffer, energy.byteOffset, energy.byteLength)); await fs.rename(temporary, cached);
      } catch { /* a read-only shoot still measures, it just measures again next time */ }
      return energy;
    })();
    voiceEnergies.set(key, work);
    if (voiceEnergies.size > 1024) voiceEnergies.delete(voiceEnergies.keys().next().value!);
    work.catch(() => { if (voiceEnergies.get(key) === work) voiceEnergies.delete(key); });
  }
  return work;
}
/** BS.1770 integrated loudness of 10 ms K-weighted energies: 400 ms blocks every 100 ms, absolute then relative gate. */
export function gatedLoudness(energy: ArrayLike<number>): number | null {
  const blocks: number[] = [];
  for (let k = 0; k + 40 <= energy.length; k += 10) {
    let z = 0; for (let j = k; j < k + 40; j++) z += energy[j];
    blocks.push(z / 40);
  }
  const loud = (z: number) => -0.691 + 10 * Math.log10(z);
  const absolute = blocks.filter(z => z > 0 && loud(z) > -70);
  if (!absolute.length) return null;
  const gate = loud(absolute.reduce((a, b) => a + b, 0) / absolute.length) - 10;
  const kept = absolute.filter(z => loud(z) > gate);
  const lufs = kept.length ? loud(kept.reduce((a, b) => a + b, 0) / kept.length) : null;
  return lufs !== null && Number.isFinite(lufs) ? Math.round(lufs * 100) / 100 : null;
}
export async function measureReelVoice(root: string, cuts: CutItem[], template: Template, signal?: AbortSignal): Promise<number | null> {
  if (!cuts.length) return null;
  const spans = cuts.map((cut, i) => {
    const tail = cutAudioTail(cuts, i, template.fps), duration = cut.durTimelineFrames / template.fps + tail;
    const clip = cut.seg?.clip;
    const audio = clip && cut.seg!.lineIndex !== null && (clip.sound || (clip.meta?.audioChannels ?? 0) > 0)
      ? voiceAudioSource(clip, cut.inFrames / (cut.clipFpsR.num / cut.clipFpsR.den)) : null;
    // The acrossfade at a jump cut consumes the tail: the joined voice keeps each span minus its tail.
    const keep = Math.max(0, Math.round((duration - tail) * 100));
    if (!audio || audio.delayS >= duration) return { keep, energy: null };
    const filter = `asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${audio.delayS * 1000}:all=1,${finishCutAudio(cuts, i, template.fps)}anull`;
    return { keep, energy: () => voiceSpanEnergy(root, path.resolve(root, audio.file), audio.startS, duration - audio.delayS, filter, signal) };
  });
  // Unmeasured spans decode a few at a time; measured ones are read back at once.
  const energies: (Float32Array | null)[] = new Array(spans.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, spans.length) }, async () => {
    while (next < spans.length) { const i = next++; energies[i] = spans[i].energy ? await spans[i].energy!() : null; }
  }));
  const joined = new Float32Array(spans.reduce((n, s) => n + s.keep, 0));
  let at = 0;
  for (const [i, span] of spans.entries()) { const e = energies[i]; if (e) joined.set(e.subarray(0, span.keep), at); at += span.keep; }
  return gatedLoudness(joined);
}

// The catalog is shared by conversation context and every reel assembly.
export function reelIds(shoot: Shoot) {
  const voice = new Map<string, Segment>();
  const takes = shoot.takes.flatMap((take) => take.attempts.map((attempt, n) => {
    if (attempt.practice) return null;
    const id = `L${take.lineIndex + 1}A${n + 1}`;
    const clip = shoot.clips.find((c) => c.id === attempt.clipId);
    if (clip?.leftOut || !clip?.meta || !Number.isFinite(attempt.s) || !Number.isFinite(attempt.e) || attempt.s < 0 || attempt.e > clip.meta.durationS || attempt.e <= attempt.s) return null;
    voice.set(id, { clip, s: attempt.s, e: attempt.e, lineIndex: take.lineIndex, marker: `${id}: ${attempt.text.split(/\s+/).slice(0, 7).join(" ")}` });
    return { id, clipId: clip.id, s: attempt.s, e: attempt.e, lineIndex: take.lineIndex, text: attempt.text, lengthS: attempt.e - attempt.s, note: attempt.note,
      starred: take.starred === n, why: take.starredByHand ? "" : take.why };
  })).filter((take): take is NonNullable<typeof take> => take !== null);
  const broll = new Map<string, Segment>();
  for (const clip of shoot.clips) {
    const j = clip.judgement;
    if (clip.leftOut || !j || !clip.meta || (clip.photo && j.verdict === "unusable") || (j.kind !== "broll" && !(j.verdict === "maybe" && /b-?roll/i.test(j.summary)))) continue;
    const spans = j.usableSpans.length ? j.usableSpans : j.kind === "broll" ? [[0, clip.meta.durationS]] : [];
    for (const [s, e] of spans) {
      if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s || e > clip.meta.durationS) continue;
      const id = `B${broll.size + 1}`;
      broll.set(id, { clip, s, e, marker: j.summary.replace(/\s+/g, " "), lineIndex: null });
    }
  }
  const warnings = shoot.takes.filter((t) => t.attempts.length && t.attempts.every((a) => a.practice))
    .map((t) => `Line ${t.lineIndex + 1} has no takes: every attempt is practice.`);
  return { voice, broll, takes, warnings };
}

// Resolve from the saved assembly, never from a renderer-built id catalog.
// This also lets older versions use the new contract without re-cutting them.
export function resolveReelPieces(shoot: Shoot, template: Template, cuts: CutItem[], reel: ReelAssembly): NonNullable<CutVersion["pieces"]> {
  return cutPieceGroups(cuts).flatMap(({ piece, items }) => {
    const cut = items[0], last = items.at(-1)!;
    if (!cut.seg) return [];
    const lengthS = items.reduce((s, c) => s + c.durTimelineFrames / template.fps, 0);
    const { clip, lineIndex } = cut.seg;
    const fps = cut.clipFpsR.num / cut.clipFpsR.den;
    const id = reel.cuts[piece].id;
    const match = /^L(\d+)A(\d+)$/.exec(id);
    const attempt = match ? shoot.takes.find((t) => t.lineIndex === Number(match[1]) - 1)?.attempts[Number(match[2]) - 1] : undefined;
    const overlay = reel.broll.find((b) => b.voiceIndex === piece);
    const overlayFps = overlay?.seg.clip.meta!.fps || template.fps;
    const overlayS = overlay ? Math.ceil(overlay.seg.s * overlayFps) / overlayFps : 0;
    const overlayLength = overlay ? Math.min(Math.floor(overlay.seg.e * overlayFps) / overlayFps - overlayS, lengthS) : 0;
    return [{
      id, kind: lineIndex === null ? "broll" as const : "voice" as const,
      clipId: clip.id, s: cut.inFrames / fps, e: last.outFrames / fps,
      timelineS: cut.offsetFrames / template.fps, lengthS,
      removed: items.flatMap((c) => c.removed ?? []),
      ...(lineIndex === null ? { description: cut.seg.marker } : { words: attempt?.text ?? cut.seg.marker }),
      overlay: overlay && overlayLength > 0 ? {
        id: overlay.id, clipId: overlay.seg.clip.id, s: overlayS, e: overlayS + overlayLength, description: overlay.seg.marker,
      } : null,
      beatSnapS: reel.cuts[piece].beatDeltaS,
    }];
  });
}

export async function assembleReel(root: string, shoot: Shoot, template: Template, answer: ReelAnswer,
  opts: { lengthS: number; shotOrder?: boolean; handOrder?: string[]; musicFile?: string | null; keepFillers?: string[] }, candidates: MusicTrack[], catalogWarnings: string[] = []) {
  const { voice, broll, warnings: practiceWarnings } = reelIds(shoot);
  const warnings = [...answer.warnings, ...catalogWarnings, ...practiceWarnings];
  for (const span of answer.spans ?? []) {
    const catalog = voice.has(span.id) ? voice : broll;
    const seg = catalog.get(span.id);
    if (!seg || !Number.isFinite(span.s) || !Number.isFinite(span.e) || span.s < seg.s || span.e > seg.e || span.e <= span.s)
      throw new Error("Shot timing must stay inside its usable span.");
    catalog.set(span.id, { ...seg, s: span.s, e: span.e, outLimitS: span.e, authoredBounds: true });
  }
  // Timing comes from the model. Only source bounds are enforced here.
  for (const span of answer.photoSpans ?? []) {
    const seg = broll.get(span.id);
    if (!seg?.clip.photo || !Number.isFinite(span.s) || !Number.isFinite(span.e) ||
      span.s < seg.s || span.e > seg.e || span.e <= span.s) throw new Error("Photo timing must stay inside its usable span.");
    broll.set(span.id, { ...seg, s: span.s, e: span.e });
  }
  let ids = answer.voice.map((v) => v.id).filter((id) => {
    if (voice.has(id) || broll.has(id)) return true;
    warnings.push(`Dropped unknown footage id ${id}.`); return false;
  });
  if (opts.handOrder?.length) {
    const rank=(id:string)=>{const at=opts.handOrder!.indexOf(id);return at<0?Infinity:at;};
    ids=ids.map((id,i)=>({id,i})).sort((a,b)=>rank(a.id)-rank(b.id)||a.i-b.i).map(item=>item.id);
  }
  if (opts.shotOrder) {
    const { defaultShotIds } = await import('./shot-order');
    ids = defaultShotIds(ids.map(id=>({id})), item=>(voice.get(item.id) ?? broll.get(item.id))?.clip, answer.shotOrderReason).map(item=>item.id);
    if (answer.shotOrderReason?.trim() && !answer.why.includes(answer.shotOrderReason.trim())) answer.why += `\n${answer.shotOrderReason.trim()}`;
  }
  if(opts.shotOrder || opts.handOrder?.length)answer.voice = ids.map(id=>({id}));
  const spineIds = ids;
  if (!spineIds.length) throw new Error([...warnings, "The cut contained no known footage ids. Try again."].join(" "));
  const segments = ids.map((id) => (voice.get(id) ?? broll.get(id))!);
  const cutList = buildCutList(shoot, "reel", template, segments, opts.keepFillers);
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
  // V14 reports the final prepared duration after the one editorial repair.
  // An assembly warning here would survive even when type/finish timing fixes it.
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
    broll: overlays, cuts: cutPieceGroups(cutList).map(({ piece, items }) => {
      const cut = items[0], last = items.at(-1)!;
      const fps = cut.clipFpsR.num / cut.clipFpsR.den;
      return { id: spineIds[piece], clipId: cut.seg!.clip.id,
        s: cut.inFrames / fps, e: last.outFrames / fps, offsetS: cut.offsetFrames / template.fps,
        lengthS: items.reduce((sum, c) => sum + c.durTimelineFrames / template.fps, 0), ...snaps[piece] };
    }) };
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
  const args = ["-v", "error", "-y", "-filter_complex_threads", String(threads(4)), "-i", base];
  const filters: string[] = [];
  const proxies = await fs.realpath(path.join(root, ".sidething/proxies"));
  const w = 960, h = Math.round(w * template.height / template.width / 2) * 2;
  for (const [i, overlay] of overlays.entries()) {
    if (!overlay.seg.clip.proxy) throw new Error(`No b-roll proxy for ${overlay.id}.`);
    const proxy = await fs.realpath(path.resolve(proxies, overlay.seg.clip.proxy));
    if (!proxy.startsWith(proxies + path.sep)) throw new Error("B-roll proxy outside cache.");
    const pieceCuts = cutPieceGroups(cuts).find((g) => g.piece === overlay.voiceIndex)?.items;
    if (!pieceCuts?.length) throw new Error(`No voice piece for overlay ${overlay.id}.`);
    const cut = pieceCuts[0];
    const fps = overlay.seg.clip.meta!.fps || template.fps;
    const start = Math.ceil(overlay.seg.s * fps) / fps;
    const duration = Math.min(Math.floor(overlay.seg.e * fps) / fps - start, pieceCuts.reduce((s, c) => s + c.durTimelineFrames / template.fps, 0));
    const offset = cut.offsetFrames / template.fps;
    args.push("-hwaccel", "videotoolbox", "-ss", `${start}`, "-t", `${duration}`, "-i", proxy);
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
      const duration = cut.durTimelineFrames / template.fps + cutAudioTail(cuts, i, template.fps);
      const clip = cut.seg?.clip;
      const audio = clip && cut.seg!.lineIndex !== null && (clip.sound || (clip.meta?.audioChannels ?? 0) > 0)
        ? voiceAudioSource(clip, cut.inFrames / (cut.clipFpsR.num / cut.clipFpsR.den)) : null;
      if (audio && audio.delayS < duration) {
        let file = path.resolve(root, audio.file);
        if (!clip!.sound) {
          file = await fs.realpath(path.resolve(proxies, clip!.proxy!));
          if (!file.startsWith(proxies + path.sep)) throw new Error("Voice proxy outside cache.");
        }
        args.push("-threads", String(threads(4)), ...(clip!.sound || !canVideoToolboxDecode(clip!.meta?.codec) ? [] : ["-hwaccel", "videotoolbox"]), "-ss", `${audio.startS}`, "-t", `${duration - audio.delayS}`, "-i", file);
        filters.push(`[${input++}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${audio.delayS * 1000}:all=1,${finishCutAudio(cuts, i, template.fps)}anull[voice${i}]`);
      } else filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[voice${i}]`);
    }
    const length = cuts.reduce((sum, c) => sum + c.durTimelineFrames / template.fps, 0);
    joinCutAudio(cuts, template.fps, filters, "voice", "voice");
    args.push("-ss", `${music.startS}`, "-t", `${length}`, "-i", path.resolve(root, music.file));
    filters.push(`[${input}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${music.gainDb}dB,apad,atrim=duration=${length},afade=t=out:st=${Math.max(0, length - 1)}:d=${Math.min(1, length)}[music]`);
    filters.push("[voice][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:latency=1[reelAudio]");
  }
  await mapSourceAudioGraph(args, filters);
  if (filters.length) args.push("-filter_complex", filters.join(";"));
  args.push("-map", overlays.length ? `[v${overlays.length - 1}]` : "0:v", "-map", music ? "[reelAudio]" : "0:a");
  args.push("-c:a", music ? "aac" : "copy");
  if (music) args.push("-b:a", "128k");
  if (overlays.length) args.push("-c:v", "h264_videotoolbox", "-b:v", "4M", "-pix_fmt", "yuv420p");
  else args.push("-c:v", "copy");
  args.push("-movflags", "+faststart", temporary);
  try {
    await promisify(execFile)(tool("ffmpeg"), args, { timeout: 120_000, maxBuffer: 1024 * 1024 });
    if (music) await normalisePreviewAudio(temporary);
    await fs.rename(temporary, base);
  } finally { await fs.rm(temporary, { force: true }); }
}
