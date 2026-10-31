// PRO2 (docs/plans/produced/spike-v1.md, "After Codex round 1", point 3): what the Produce director and its critic see.
// Not source thumbnails: the finished edit, rendered by the same finishing compositor the export uses (look, captions,
// layouts, joins, sounds and music all in), at the draft size. Frames and mix levels are read with ffmpeg; nothing here
// draws a picture of its own.
// PRO2b: only the frames the packet shows are rendered. Each needed frame's stretch of the edit is a window
// (preview.ts `window`): cuts that reach none of its frames decode for their timing alone, so a frame in a window is the
// frame the whole draft has there. Windows render a few at once; the mix is the draft's own sound file, which the whole
// draft would have copied in untouched. Windows already rendered for a version are reused (the critic's BEFORE rows).
// Caps, so a long edit never sends a pile of pictures to the engine (each sheet is at most 1080 x 640, about 500
// image tokens; Claude and Codex both take a dozen comfortably in one turn):
// - before the pass: one overview sheet (12 frames) and at most 10 candidate strips (6 frames each) = 11 images;
// - after the pass: at most 6 sheets (BEFORE row over AFTER row at -6, -3, 0, +3, +6, +12 frames) = 6 images;
// - levels: the whole mix every 0.25 s, and per moment every 3 frames (before) or 2 frames (after), as numbers.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { StoredVersion } from "./sidekick";
import type { ActivityHandle } from "./activity";
import { tool } from "./tools";
import { timedCaptionWords } from "../shared/caption-words";
import { pieceName } from "../shared/clip-name";
import { displayedClip } from "../shared/media";

export const CAPS = { candidates: 10, overviewFrames: 12, afterSheets: 6, tileW: 180, sheetW: 1080, stripTiles: 6 } as const;
export const CANDIDATE_OFFSETS_S = [-1, -0.5, 0, 0.3, 0.6, 1] as const;
export const MOVE_OFFSETS_FRAMES = [-6, -3, 0, 3, 6, 12] as const;
const r2 = (n: number) => Math.round(n * 100) / 100, r3 = (n: number) => Math.round(n * 1000) / 1000;
const clock = (t: number) => { const s = Math.max(0, Math.round(t)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

// ---- A version to watch: prepared as the export prepares it, rendered a window at a time.
/** A rendered window: its frames, its file, and what it cost (modelled, and wall seconds; a cache hit is near zero). */
export interface WatchWindow { from: number; to: number; file: string; costS: number; tookS: number }
export interface Watch {
  root: string; cutId: string;
  record: StoredVersion;        // the version as saved (or staged)
  prepared: StoredVersion;      // as the export renders it (export format, energy)
  fps: number; durationS: number; frames: number; name: string;
  cuts: { startS: number; endS: number }[];   // the compositor's cut spans on the edit's clock
  windows: WatchWindow[];
}
/** A version prepared for watching. Named by what is on screen, not the version number: the same edit again (an undo, a
 * redo, the pass staged then saved) is the same name, and the compositor's own cache key still decides what renders. */
export async function prepareWatch(root: string, cutId: string, source: StoredVersion): Promise<Watch> {
  const { exportFormat, exportAspect } = await import("./export");
  const { prepareEnergy } = await import("./finish");
  const { getPreferences } = await import("./settings");
  const { planFx } = await import("./edits-fx");
  const t = source.assembly.template;
  const record = await exportFormat(source, exportAspect(t.width, t.height));
  prepareEnergy(record, record.assembly, record.energy ?? "subtle", (await getPreferences()).output.height);
  const { version: _v, baseVersion: _b, createdAt: _c, feedback: _f, produce: _p, preview: _pv, previewRev: _pr, finished: _fi, ...content } = record as StoredVersion & Record<string, unknown>;
  const name = `produce-${cutId}-${createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 16)}`;
  const fps = record.assembly.template.fps, fx = planFx(record.assembly.cutList, fps, record);
  return { root, cutId, record: source, prepared: record, fps, durationS: fx.durationS, frames: Math.max(1, Math.ceil(fx.durationS * fps - 1e-6)), name,
    cuts: fx.items.map(i => ({ startS: i.startS, endS: i.endS })), windows: [] };
}
export async function watchVersion(root: string, cutId: string, version: number): Promise<Watch> {
  const { loadDraftVersion } = await import("./sidekick");
  return prepareWatch(root, cutId, await loadDraftVersion(root, cutId, version));
}
const finishingOptions = (w: Watch) => ({ name: w.name, template: w.prepared.assembly.template, version: w.prepared, reel: w.prepared.assembly.reel, full: false });

/** The frame `-ss t` shows on the whole draft (the first frame at or after t), kept inside the edit. */
export const frameAt = (w: Watch, t: number) => Math.min(w.frames - 1, Math.max(0, Math.ceil(Math.min(Math.max(0, t), Math.max(0, w.durationS - 0.02)) * w.fps - 1e-6)));
/** Where a frame of the edit is on disk: its window's file and the seek that lands on it (half a frame early). */
export function tileOf(w: Watch, t: number): { file: string; atS: number } {
  const k = frameAt(w, t), win = w.windows.find(x => k >= x.from && k < x.to);
  if (!win) throw new Error(`frame ${k} of the watched edit was not rendered`);
  return { file: win.file, atS: Math.max(0, (k - win.from - 0.5) / w.fps) };
}

// The cost of a window (seconds, measured on a real 50 s talking-head edit; a Mac's own pace is learned in model-pace.ts): starting
// the compositor, carrying the black stand-ins before it, grading the cuts it reaches (and the one before each, for a
// dissolve) and finishing its own frames.
const COST = { start: 5, decodeS: 0.02, gradeS: 4, finishS: 0.25 } as const;
type Plan = { from: number; to: number; first: number; last: number };
function graded(w: Watch, from: number, to: number) {
  const s = from / w.fps, e = to / w.fps;
  let first = -1, last = -1;
  w.cuts.forEach((c, i) => { if (c.startS < e - 1e-9 && c.endS > s + 1e-9) { if (first < 0) first = i; last = i; } });
  if (first < 0) { first = 0; last = 0; }
  return { first: Math.max(0, first - 1), last };
}
export function windowCost(w: Watch, p: Pick<Plan, "from" | "to">): number {
  const { first, last } = graded(w, p.from, p.to);
  let gradeS = 0; for (let i = first; i <= last; i++) gradeS += w.cuts[i].endS - w.cuts[i].startS;
  return COST.start + COST.decodeS * w.cuts[first].startS + COST.gradeS * gradeS + COST.finishS * (p.to - p.from) / w.fps;
}
/** How many windows render at once: the export's parts use four tenths of the cores; a watch leaves room for playback. */
export const watchWorkers = () => Math.max(2, Math.min(4, Math.round(os.cpus().length * 0.3)));
/** The windows that cover these frames and are not rendered yet. Frames whose graded cuts touch share a window (no
 * extra grading); then the cheapest merges until a few windows are left, and the dearest splits so they run at once. */
export function planWindows(w: Watch, frames: number[], workers = watchWorkers()): Plan[] {
  const need = [...new Set(frames)].filter(k => !w.windows.some(x => k >= x.from && k < x.to)).sort((a, b) => a - b);
  let plans: Plan[] = [];
  for (const k of need) {
    const g = graded(w, k, k + 1), last = plans.at(-1);
    if (last && g.first <= last.last + 1) { last.to = k + 1; last.last = Math.max(last.last, g.last); }
    else plans.push({ from: k, to: k + 1, ...g });
  }
  const merged = (a: Plan, b: Plan): Plan => ({ from: a.from, to: b.to, first: a.first, last: Math.max(a.last, b.last) });
  while (plans.length > workers * 2) {
    let best = 0, gain = Infinity;
    for (let i = 0; i + 1 < plans.length; i++) { const extra = windowCost(w, merged(plans[i], plans[i + 1])) - windowCost(w, plans[i]) - windowCost(w, plans[i + 1]); if (extra < gain) { gain = extra; best = i; } }
    plans.splice(best, 2, merged(plans[best], plans[best + 1]));
  }
  // One long window would hold the rest up: split the dearest between two of its frames, at the point that halves it
  // best, while it costs more than its share of the workers' time and the split still saves time.
  const share = () => plans.reduce((sum, p) => sum + windowCost(w, p), 0) / (workers * 2);
  for (let guard = 0; plans.length && plans.length < workers * 3 && guard < 24; guard++) {
    const i = plans.reduce((m, p, k) => windowCost(w, p) > windowCost(w, plans[m]) ? k : m, 0), p = plans[i], whole = windowCost(w, p);
    if (whole <= Math.max(share(), 2 * COST.start)) break;
    const inside = need.filter(k => k >= p.from && k < p.to);
    let cut: [Plan, Plan] | null = null, worst = whole;
    for (let n = 1; n < inside.length; n++) {
      const a = { from: p.from, to: inside[n - 1] + 1, ...graded(w, p.from, inside[n - 1] + 1) }, b = { from: inside[n], to: p.to, ...graded(w, inside[n], p.to) };
      const span = Math.max(windowCost(w, a), windowCost(w, b));
      if (span < worst - COST.start) { worst = span; cut = [a, b]; }
    }
    if (!cut) break;
    plans.splice(i, 1, ...cut);
  }
  return plans;
}

/** What a set of windows should take on the wall clock, `workers` at a time (modelled; model-pace learns the rest). */
export const plannedSeconds = (costs: number[], workers = watchWorkers()) => costs.length ? Math.max(Math.max(...costs), costs.reduce((a, b) => a + b, 0) / Math.min(workers, costs.length)) : 0;
/** Render the windows these edit times need, `workers` at a time, through the export's compositor. `onPlan` hears the
 * planned seconds before anything renders; `report` each window's real ffmpeg progress (finished frames, by cost). */
export async function renderTimes(w: Watch, times: number[], activity: ActivityHandle | undefined, report?: (done: number, total: number) => void,
  onPlan?: (seconds: number) => void, workers = watchWorkers()): Promise<void> {
  const plans = planWindows(w, times.map(t => frameAt(w, t)));
  onPlan?.(plannedSeconds(plans.map(p => windowCost(w, p))));
  if (!plans.length) { report?.(1, 1); return; }
  const { renderFinishingPreview } = await import("./preview");
  const { asActivity } = await import("./activity");
  const cuts = w.prepared.assembly.cutList;
  const costs = plans.map(p => windowCost(w, p)), total = costs.reduce((a, b) => a + b, 0), done = plans.map(() => 0);
  const tell = () => report?.(done.reduce((a, b) => a + b, 0), total);
  const order = plans.map((_, i) => i).sort((a, b) => costs[b] - costs[a]);   // dearest first: the last to finish is short
  let next = 0;
  const lane = async () => {
    while (next < order.length) {
      const i = order[next++], p = plans[i], frames = p.to - p.from;
      const own: ActivityHandle = { signal: activity?.signal ?? new AbortController().signal, progress: () => {}, update: () => {}, done: () => {}, fail: () => {},
        stage: (_stage, _f, detail) => { if (detail?.doneS != null) { done[i] = costs[i] * Math.min(0.95, detail.doneS * w.fps / frames); tell(); } } };
      const run = () => renderFinishingPreview(w.root, cuts, { ...finishingOptions(w), name: `${w.name}-w${p.from}-${p.to}`, window: { from: p.from, to: p.to } });
      const t0 = performance.now(), out = activity ? await asActivity(own, run) : await run();
      w.windows.push({ from: p.from, to: p.to, file: path.isAbsolute(out) ? out : path.join(w.root, ".sidething", "precuts", out), costS: costs[i], tookS: (performance.now() - t0) / 1000 });
      done[i] = costs[i]; tell();
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, plans.length) }, lane));
}
/** The draft's own mix (the AAC file a whole draft copies in), decoded for levels. */
export async function watchSound(w: Watch): Promise<Float32Array> {
  const { cachedDraftSound } = await import("./preview");
  const cuts = w.prepared.assembly.cutList.map(c => c.seg ? { ...c, seg: { ...c.seg, clip: displayedClip(c.seg.clip) } } : c);
  return mixSamples(await cachedDraftSound(w.root, cuts, finishingOptions(w)));
}

/** Keep the windows of the three newest watched edits (and those this run reads); older ones are cache. */
export async function pruneWatches(root: string, cutId: string, keep: string[]): Promise<void> {
  const dir = path.join(root, ".sidething", "precuts"), prefix = `produce-${cutId}-`;
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter(n => n.startsWith(prefix) && n.endsWith(".mp4") && !n.includes(".tmp."));
  const dated = await Promise.all(names.map(async n => ({ n, edit: n.slice(prefix.length, prefix.length + 16), t: (await fs.stat(path.join(dir, n)).catch(() => null))?.mtimeMs ?? 0 })));
  const newest = new Map<string, number>();
  for (const d of dated) newest.set(d.edit, Math.max(newest.get(d.edit) ?? 0, d.t));
  const kept = new Set([...newest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([edit]) => edit));
  for (const { n, edit } of dated) {
    const file = path.join(dir, n);
    if (kept.has(edit) || keep.includes(file)) continue;
    for (const f of [file, `${file}.finish.json`, `${file}.profile.json`]) await fs.rm(f, { force: true });
  }
}

// ---- Frames and levels from the rendered file.
const run = promisify(execFile);
/** One sheet: rows of frames (each from its window's file), each tile CAPS.tileW wide, side by side, rows stacked. */
export async function sheet(rows: { file: string; atS: number }[][], out: string): Promise<string> {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"], parts: string[] = [];
  let n = 0;
  const rowLabels = rows.map(tiles => tiles.map(tile => {
    args.push("-ss", tile.atS.toFixed(4), "-i", tile.file);
    parts.push(`[${n}:v]scale=${CAPS.tileW}:-2,setsar=1,format=yuvj420p[t${n}]`);
    return `[t${n++}]`;
  }));
  const stacked = rowLabels.map((labels, k) => { parts.push(`${labels.join("")}hstack=inputs=${labels.length}[r${k}]`); return `[r${k}]`; });
  if (stacked.length > 1) parts.push(`${stacked.join("")}vstack=inputs=${stacked.length}[out]`);
  args.push("-filter_complex", parts.join(";"), "-map", stacked.length > 1 ? "[out]" : stacked[0], "-frames:v", "1", "-q:v", "5", out);
  await run(tool("ffmpeg"), args, { maxBuffer: 1 << 20 });
  return out;
}
/** The mix as mono 8 kHz samples (about 1.7 MB for a minute), decoded once per file. */
export async function mixSamples(video: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", video, "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let err = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) return reject(new Error(`Couldn't read the edit's sound: ${err.trim() || code}`));
      const all = Buffer.concat(chunks);
      resolve(new Float32Array(all.buffer, all.byteOffset, Math.floor(all.byteLength / 4)));
    });
  });
}
/** dBFS RMS per window from fromS, rounded to whole dB (silence -90). */
export function levels(samples: Float32Array, fromS: number, toS: number, stepS: number): number[] {
  const out: number[] = [];
  for (let t = fromS; t < toS - 1e-9; t += stepS) {
    const a = Math.max(0, Math.round(t * 8000)), b = Math.min(samples.length, Math.round((t + stepS) * 8000));
    let sum = 0; for (let i = a; i < b; i++) sum += samples[i] * samples[i];
    out.push(b > a ? Math.max(-90, Math.round(10 * Math.log10(sum / (b - a) + 1e-12))) : -90);
  }
  return out;
}

// ---- The packet.
export interface Candidate { n: number; atS: number; why: string[]; before: string; after: string; sheet: string; tilesS: number[]; levels: { fromS: number; stepS: number; db: number[] } }
export interface ObservePacket {
  edit: { version: number; lengthS: number; fps: number; frame: { width: number; height: number } };
  pieces: { piece: number; kind: "voice" | "broll"; name: string; startS: number; endS: number; source: { s: number; e: number; clipLengthS: number | null }; speed: number;
    sound: { muted: boolean; gainDb: number }; punch: number | null; layout: string | null }[];
  joins: { join: number; atS: number; kind: string }[];
  words: [number, string, number, number, 0 | 1][];  // [index, text, s, e, accented]
  sentences: { from: number; to: number; s: number; e: number; text: string }[];
  music: { name: string; gainDb: number; sections: { s: number; e: number; section: number }[]; hits: number[]; shape: unknown[] } | null;
  sounds: { name: string; atS: number; role: string | null; kind: string }[];
  mix: { stepS: number; db: number[] };
  overview: { sheet: string; tilesS: number[] };
  candidates: Candidate[];
  library: { sound: string; name: string; kind: string; role: string | null; hitS: number; lengthS: number }[];
}

const SENTENCE_END = /[.!?…]["'’”)]?$/;
type Seed = { atS: number; score: number; why: string[] };
/** Moments worth a strip: sentence ends (the line that follows lands there), accented words, music section changes,
 * each scored up when a cut or a section change sits on it. Fixed and cheap: the director still reads every word. */
export function candidateMoments(words: { text: string; s: number; e: number; accent?: boolean }[], cuts: number[], sections: number[], lengthS: number): Seed[] {
  const near = (list: number[], t: number, within: number) => list.find(x => Math.abs(x - t) <= within);
  const seeds: Seed[] = [];
  words.forEach((w, i) => {
    const next = words[i + 1];
    if (SENTENCE_END.test(w.text) && next) {
      const t = next.s, why = [`the line after "${w.text}" starts`];
      let score = 2;
      const cut = near(cuts, t, 0.6); if (cut !== undefined) { score += 1; why.push(`a cut at ${r2(cut)} s`); }
      const sec = near(sections, t, 1); if (sec !== undefined) { score += 1; why.push(`the music changes section at ${r2(sec)} s`); }
      const gap = next.s - w.e; if (gap >= 0.25) { score += 1; why.push(`${r2(gap)} s pause before it`); }
      seeds.push({ atS: t, score, why });
    }
    if (w.accent) {
      const why = [`"${w.text}" is accented`]; let score = 1;
      const cut = near(cuts, w.s, 0.5); if (cut !== undefined) { score += 1; why.push(`a cut at ${r2(cut)} s`); }
      seeds.push({ atS: w.s, score, why });
    }
  });
  for (const s of sections) if (s > 0.5 && s < lengthS - 0.5) seeds.push({ atS: s, score: 1, why: ["the music changes section"] });
  // The last line always gets a look: endings carry payoffs more often than not.
  let last = 0;
  for (let i = 1; i < words.length; i++) if (SENTENCE_END.test(words[i - 1].text)) last = i;
  if (words[last]) seeds.push({ atS: words[last].s, score: 3, why: ["the last line starts"] });
  // Merge moments within a second of each other; the stronger one keeps its time.
  const merged: Seed[] = [];
  for (const seed of seeds.sort((a, b) => b.score - a.score || a.atS - b.atS)) {
    const same = merged.find(m => Math.abs(m.atS - seed.atS) < 1);
    if (same) { for (const w of seed.why) if (!same.why.includes(w)) same.why.push(w); same.score += 0.25; }
    else merged.push({ ...seed, why: [...seed.why] });
  }
  return merged.sort((a, b) => b.score - a.score || a.atS - b.atS).slice(0, CAPS.candidates).sort((a, b) => a.atS - b.atS);
}

/** Watch a version: render the frames the packet shows, make the overview and candidate strips, and measure the mix.
 * Files go in `dir`. `report` hears the render's real progress (frames finished, by cost). */
export async function observe(root: string, cutId: string, version: number, dir: string, activity?: ActivityHandle, report?: (done: number, total: number) => void,
  onPlan?: (seconds: number) => void):
  Promise<{ packet: ObservePacket; images: string[]; watch: Watch; samples: Float32Array; record: StoredVersion }> {
  await fs.mkdir(dir, { recursive: true });
  const watch = await watchVersion(root, cutId, version), { record, fps, durationS } = watch;
  const sound = watchSound(watch);
  sound.catch(() => { /* awaited below */ });
  const { planFx } = await import("./edits-fx");
  const fx = planFx(record.assembly.cutList, record.assembly.template.fps, record);
  const words = timedCaptionWords(record.titles);
  const pieces = record.pieces ?? [], clips = record.assembly.shoot.clips;
  const spans: { startS: number; endS: number }[] = [];
  for (const item of fx.items) { const at = spans[item.piece]; spans[item.piece] = at ? { startS: Math.min(at.startS, item.startS), endS: Math.max(at.endS, item.endS) } : { startS: item.startS, endS: item.endS }; }
  let grid: { sections: { s: number; e: number; section: number }[]; hits: number[] } | undefined;
  try { grid = await (await import("./music-timeline")).timelineMusic(root, record, fx); } catch { grid = undefined; }
  const music = record.music !== undefined ? record.music : record.assembly.reel.music;
  const sectionStarts = (grid?.sections ?? []).filter((s, i, all) => i === 0 || s.section !== all[i - 1].section).map(s => s.s);
  const cuts = fx.joins.map(j => j.atS);
  const seeds = candidateMoments(words, cuts, sectionStarts, durationS);
  const images: string[] = [];
  const overviewTimes = Array.from({ length: CAPS.overviewFrames }, (_, k) => r2((k + 0.5) * durationS / CAPS.overviewFrames));
  const seedTiles = seeds.map(seed => CANDIDATE_OFFSETS_S.map(o => r3(seed.atS + o + 0.5 / fps)));
  await renderTimes(watch, [...overviewTimes, ...seedTiles.flat()], activity, report, onPlan);
  const samples = await sound;
  images.push(await sheet([overviewTimes.slice(0, 6), overviewTimes.slice(6)].map(row => row.map(t => tileOf(watch, t))), path.join(dir, "overview.jpg")));
  const textAround = (t: number, dirn: -1 | 1) => {
    const list = dirn < 0 ? words.filter(w => w.e <= t + 0.05).slice(-10) : words.filter(w => w.s >= t - 0.05).slice(0, 10);
    return list.map(w => w.text).join(" ");
  };
  const candidates: Candidate[] = [];
  for (const [k, seed] of seeds.entries()) {
    const tiles = seedTiles[k];
    const name = `c${k + 1}.jpg`;
    images.push(await sheet([tiles.map(t => tileOf(watch, t))], path.join(dir, name)));
    candidates.push({ n: k + 1, atS: r2(seed.atS), why: seed.why, before: textAround(seed.atS, -1), after: textAround(seed.atS, 1), sheet: name,
      tilesS: tiles.map(r2), levels: { fromS: r2(seed.atS - 1), stepS: r3(3 / fps), db: levels(samples, Math.max(0, seed.atS - 1), Math.min(durationS, seed.atS + 1.5), 3 / fps) } });
  }
  const sentences: ObservePacket["sentences"] = [];
  let from = 0;
  words.forEach((w, i) => { if (SENTENCE_END.test(w.text) || i === words.length - 1) { sentences.push({ from, to: i, s: r2(words[from].s), e: r2(w.e), text: words.slice(from, i + 1).map(x => x.text).join(" ") }); from = i + 1; } });
  const library = await soundLibraryForDirector();
  const packet: ObservePacket = {
    edit: { version, lengthS: r2(durationS), fps, frame: { width: record.assembly.template.width, height: record.assembly.template.height } },
    pieces: pieces.map((p, i) => {
      const clip = clips.find(c => c.id === p.clipId), fxi = record.pieceFx?.[i] ?? null;
      const items = fx.items.filter(x => x.piece === i);
      return { piece: i, kind: p.kind, name: pieceName(record.assembly.shoot, record, i), startS: r2(spans[i]?.startS ?? p.timelineS), endS: r2(spans[i]?.endS ?? p.timelineS + p.lengthS),
        source: { s: r3(p.s), e: r3(p.e), clipLengthS: clip?.meta?.durationS ? r2(clip.meta.durationS) : null }, speed: Math.abs(fxi?.speed ?? 1) || 1,
        sound: { muted: items.every(x => x.muted || !x.soundEnabled), gainDb: fxi?.gainDb ?? 0 }, punch: record.jumpScales?.[i] ?? null, layout: record.layouts?.[i]?.kind ?? null };
    }),
    joins: fx.joins.map((j, k) => ({ join: k, atS: r2(j.atS), kind: j.choice.kind })),
    words: words.map(w => [w.index, w.text, r2(w.s), r2(w.e), w.accent ? 1 : 0]),
    sentences,
    music: music ? { name: path.basename(music.file).replace(/\.[^.]+$/, ""), gainDb: music.gainDb ?? -18, sections: (grid?.sections ?? []).map(s => ({ s: r2(s.s), e: r2(s.e), section: s.section })),
      hits: (grid?.hits ?? []).map(r2), shape: record.music?.shape ?? [] } : null,
    sounds: (record.sfx ?? []).map(s => ({ name: s.name, atS: r2(s.atS), role: s.role ?? null, kind: s.kind })),
    mix: { stepS: 0.25, db: levels(samples, 0, durationS, 0.25) },
    overview: { sheet: "overview.jpg", tilesS: overviewTimes },
    candidates, library,
  };
  return { packet, images, watch, samples, record };
}

/** The bundled sounds a director may place: the trailer set and the soft thuds, with their measured hits. */
export async function soundLibraryForDirector(): Promise<ObservePacket["library"]> {
  const { soundLibrary } = await import("./sound-design");
  const all = await soundLibrary();
  return all.filter(s => s.id.startsWith("lib:v3-") || /impactsoft-heavy-00[0-1]/.test(s.id)).map(s => {
    const x = s as unknown as { id: string; name: string; kind: string; role?: string; hitS?: number; lengthS?: number };
    return { sound: x.id.slice(4), name: x.name, kind: x.kind, role: x.role ?? null, hitS: x.hitS ?? 0, lengthS: x.lengthS ?? 0 };
  });
}

// ---- After the pass: each move's moment, BEFORE over AFTER.
export interface MoveMoment { group: string; label: string; atS: number }
export interface AfterSheet { groups: string[]; label: string; atS: number; sheet: string; offsetsFrames: number[]; levels: { fromS: number; stepS: number; before: number[]; after: number[] } }
export async function observeAfter(before: { watch: Watch; samples: Float32Array }, after: { watch: Watch; samples: Float32Array | Promise<Float32Array> },
  moments: MoveMoment[], fps: number, dir: string, activity?: ActivityHandle, report?: (done: number, total: number) => void, onPlan?: (seconds: number) => void): Promise<{ sheets: AfterSheet[]; images: string[] }> {
  await fs.mkdir(dir, { recursive: true });
  // At most two moments per group and CAPS.afterSheets in all, payoff groups first (the caller orders them by rank).
  // A moment two groups share (a cut and the sound that lands on it) is one sheet that names both.
  const picked: (MoveMoment & { groups: string[] })[] = [];
  for (const m of moments) {
    const same = picked.find(p => Math.abs(p.atS - m.atS) < 0.2);
    if (same) { if (!same.groups.includes(m.group)) same.groups.push(m.group); continue; }
    if (picked.length >= CAPS.afterSheets || picked.filter(p => p.groups.includes(m.group)).length >= 2) continue;
    picked.push({ ...m, groups: [m.group] });
  }
  const times = (m: MoveMoment, d: number) => MOVE_OFFSETS_FRAMES.map(o => r3(Math.min(d - 0.5 / fps, m.atS + (o + 0.5) / fps)));
  const beforeS = r2(before.watch.durationS);   // the packet's length, as the BEFORE rows have always been clamped to
  // BEFORE rows from the version produced on (windows its packet rendered are reused), AFTER rows from the pass: the
  // two render at once, each only where a moment is.
  const progress = [0, 0, 1, 1], tell = () => report?.(progress[0] + progress[1], progress[2] + progress[3]);
  // Both sides share the workers, so the plan is the two sides' windows together.
  const beforeFrames = picked.flatMap(m => times(m, beforeS)).map(t => frameAt(before.watch, t)), afterFrames = picked.flatMap(m => times(m, after.watch.durationS)).map(t => frameAt(after.watch, t));
  onPlan?.(plannedSeconds([...planWindows(before.watch, beforeFrames).map(p => windowCost(before.watch, p)), ...planWindows(after.watch, afterFrames).map(p => windowCost(after.watch, p))]));
  await Promise.all([
    renderTimes(before.watch, picked.flatMap(m => times(m, beforeS)), activity, (d, t) => { progress[0] = d; progress[2] = t; tell(); }, undefined, Math.ceil(watchWorkers() / 2)),
    renderTimes(after.watch, picked.flatMap(m => times(m, after.watch.durationS)), activity, (d, t) => { progress[1] = d; progress[3] = t; tell(); }, undefined, Math.ceil(watchWorkers() / 2))]);
  const sheets: AfterSheet[] = [], images: string[] = [], afterSamples = await after.samples;   // the pass's mix, made while the windows rendered
  for (const [k, m] of picked.entries()) {
    const name = `a${k + 1}.jpg`;
    // BEFORE row over AFTER row, same edit times.
    await sheet([times(m, beforeS).map(t => tileOf(before.watch, t)), times(m, after.watch.durationS).map(t => tileOf(after.watch, t))], path.join(dir, name));
    images.push(path.join(dir, name));
    const from = Math.max(0, m.atS - 0.5);
    sheets.push({ groups: m.groups, label: m.label, atS: r2(m.atS), sheet: name, offsetsFrames: [...MOVE_OFFSETS_FRAMES],
      levels: { fromS: r2(from), stepS: r3(2 / fps), before: levels(before.samples, from, Math.min(beforeS, m.atS + 1), 2 / fps), after: levels(afterSamples, from, Math.min(after.watch.durationS, m.atS + 1), 2 / fps) } });
  }
  return { sheets, images };
}
export { clock };
