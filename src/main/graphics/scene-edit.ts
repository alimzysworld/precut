// SCN1b (docs/plans/produced/scenes-spike.md): a full-screen scene as one undoable change to an edit. add_scene (MCP and
// Ask, the same handler) takes a kind, a span (reel seconds, or a phrase he says), the mode (a cutaway keeps his voice
// playing under it; a pause stops his voice and adds the scene's length), his words or his frames, look params and
// motion, and saves the scene item, its one sound and (for a pause) the pause itself as ONE version through runBatch.
// The fixed steps are here because getting them wrong does damage (his words, his frames, his voice in sync):
//   - word scenes show only words he says in the span (or, for a pause, the phrase it follows), each element anchored to
//     his word so it follows his voice;
//   - picture scenes show his own frames, cut from his shoot into the shoot cache the PRO4b way (graphics/card.ts), never
//     inline, never the shots after the scene (they give the payoff away);
//   - in and out snap to a beat, a half beat or a word edge, never mid-word, on the frame grid; the snap is said;
//   - a pause splits the voice at the scene, grows the shot under it by exactly the scene's length on the frame grid
//     (a magnetic trim ripples the voice with it: the voice is never moved by hand), and holds the music: the fitted
//     arrangement stays note for note, its bed plays on under the pause (ducking as the edit's settings say), and the
//     rest of it follows his voice, so nothing is re-fitted to the longer edit.
// What to make, where and with which words or frames is the caller's judgement.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CutEdit, MotionGraphic, OverlayItem } from "../../shared/schema";
import { beatLength, beatPosition, beatTime, clampMotion, dedupeBeats, resolveMotion, withTimes, type Motion, type MotionElement } from "../../shared/motion";
import { buildFromTemplate, graphicSource } from "./templates";
import { SCENE_TEMPLATES, SCENE_FRAME } from "./scenes";
import { graphicTheme } from "./edit";
import type { StoredVersion } from "../sidekick";

const run = promisify(execFile);
const r4 = (n: number) => Math.round(n * 10000) / 10000, r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const norm = (t: string) => t.normalize("NFKC").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]/gu, "");
const quote = (t: string) => `“${t}”`;

export const SCENE_KINDS: Record<string, string> = { "beat words": "scene-beat-words", "title slam": "scene-title-slam", "frame wall": "scene-frame-wall", memories: "scene-memories" };
const WORD_SCENES = ["scene-beat-words", "scene-title-slam"];
export const SCENE_LENGTH = { min: 0.6, max: 4 } as const;
// One sound on the first landing (the knob table's default), from the bundled library.
const SCENE_SOUND: Record<string, { file: string; name: string; kind: "impact" | "hit" | "ui"; role: "hit" | "ui" }> = {
  "scene-beat-words": { file: "lib:v3-land", name: "soft landing", kind: "hit", role: "hit" },
  "scene-title-slam": { file: "lib:v3-slam", name: "slam", kind: "impact", role: "hit" },
  "scene-frame-wall": { file: "lib:v3-shutter", name: "camera shutter", kind: "ui", role: "ui" },
  "scene-memories": { file: "lib:v3-shutter", name: "camera shutter", kind: "ui", role: "ui" },
};

export interface SceneRequest {
  kind: string;
  span: { s: number; e: number } | string;            // reel seconds, or a phrase he says (the scene covers it)
  mode?: "cutaway" | "pause";
  words?: string[];                                    // word scenes: his words, one element each (title slam: up to two lines)
  frames?: "auto" | { clip: string; atS: number }[];   // picture scenes: from his shoot
  look?: Record<string, unknown>;
  motion?: Record<string, unknown>;
  sound?: string | null;                               // a library id; null = no sound
}

// LOOK1: look {bg, dim, type, finish} rides in add_scene's look beside the scene's own params (size, layout, ...).
const SCENE_LOOK_KEYS = ["bg", "dim", "type", "finish", "shuffle"];
const lookAsked = (look: unknown) => { const l = look && typeof look === "object" ? look as Record<string, unknown> : {}; const out = Object.fromEntries(SCENE_LOOK_KEYS.filter(k => l[k] !== undefined).map(k => [k, l[k]])); return Object.keys(out).length ? out : undefined; };

export function sceneTemplateId(kind: unknown): string {
  const k = typeof kind === "string" ? kind.trim().toLowerCase().replace(/[-_]+/g, " ") : "";
  const id = SCENE_KINDS[k] ?? SCENE_KINDS[k.replace(/^scene /, "")];
  if (!id) throw new Error(`Choose a scene kind: ${Object.keys(SCENE_KINDS).join(", ")}.`);
  return id;
}

// ---- his words on the edit clock, with ids that stay with him when his voice moves

export type SceneWord = { key: string; text: string; s: number; e: number };
/** A motion word anchor for a transcript word: short (motion keeps 64 characters) and the same every read. */
export function sceneWordKey(id: string, occurrence?: string): string {
  const tail = /#w(\d+)$/.exec(id)?.[1] ?? "";
  return `w${tail}-${createHash("sha256").update(`${id}\u0000${occurrence ?? ""}`).digest("hex").slice(0, 8)}`;
}
/** His words as the edit plays them: the voiceover transcript when there is one, else the caption words. */
export async function sceneWords(root: string, record: StoredVersion): Promise<SceneWord[]> {
  const lines = record.voiceover?.lines ?? [];
  if (lines.length) {
    const { voiceTranscript } = await import("../../shared/caption-words");
    const takes = await (await import("../voiceover-takes")).listVoiceovers(root);
    const takeOf = (file: string) => takes.find(t => t.file === file) as never;
    return voiceTranscript(lines, takeOf, record.titles).filter(w => !w.hidden && w.e > w.s)
      .map(w => ({ key: sceneWordKey(w.id, w.occurrence), text: w.text, s: w.s, e: w.e })).sort((a, b) => a.s - b.s);
  }
  const { timedCaptionWords } = await import("../../shared/caption-words");
  return timedCaptionWords(record.titles).map(w => ({ key: `c${w.index}`, text: w.text, s: w.s, e: w.e }));
}

// ---- where a scene may cut: beats, half beats and word edges, never inside a word

type Snap = { t: number; what: string };
function snapPoints(beats: number[], words: SceneWord[]): Snap[] {
  const out: Snap[] = beats.map(t => ({ t, what: "a beat" }));
  for (let i = 1; i < beats.length; i++) out.push({ t: (beats[i - 1] + beats[i]) / 2, what: "a half beat" });
  for (const w of words) out.push({ t: w.s, what: `the start of ${quote(w.text)}` }, { t: w.e, what: `the end of ${quote(w.text)}` });
  return out.map(p => ({ ...p, t: r4(p.t) }));
}
/** Inside a word by more than a frame from either edge. */
const midWord = (t: number, words: SceneWord[], F: number) => words.find(w => t > w.s + F && t < w.e - F);
function snap(t: number, points: Snap[], words: SceneWord[], fps: number, label: string, notes: string[]): number {
  const F = 1 / fps, onFrame = (x: number) => Math.round(x * fps) / fps;
  const prefer = (p: Snap) => p.what.startsWith(label === "start" ? "the start" : "the end") ? 0 : p.what.startsWith("a beat") ? 1 : 2;
  const best = points.filter(p => !midWord(p.t, words, F)).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t) || prefer(a) - prefer(b))[0];
  const to = best && Math.abs(best.t - t) <= 0.75 ? best : null;
  const inside = midWord(t, words, F);
  if (!to) {
    if (inside) { const edge = t - inside.s < inside.e - t ? inside.s : inside.e; notes.push(`Moved the ${label} from ${r2(t)} s to ${r2(edge)} s, the ${edge === inside.s ? "start" : "end"} of ${quote(inside.text)}, so it never cuts mid-word.`); return onFrame(edge); }
    return onFrame(t);
  }
  if (Math.abs(to.t - t) >= F) notes.push(`Moved the ${label} from ${r2(t)} s to ${r2(to.t)} s, on ${to.what}${inside ? `, so it doesn't cut ${quote(inside.text)} in half` : ""}.`);
  return onFrame(to.t);
}

// ---- his words: every element is words he says, in order, in the span (or the phrase a pause follows)

type Placed = { text: string; words: SceneWord[] };
function placeWords(asked: string[], pool: SceneWord[], where: string): Placed[] {
  const out: Placed[] = [];
  let from = 0;
  for (const raw of asked) {
    const text = String(raw ?? "").replace(/\s+/g, " ").trim(), tokens = text.split(" ").map(norm).filter(Boolean);
    if (!tokens.length) throw new Error("Give each element some of his words.");
    const at = (start: number) => { for (let i = start; i + tokens.length <= pool.length; i++) if (tokens.every((t, j) => norm(pool[i + j].text) === t)) return i; return -1; };
    let i = at(from); if (i < 0) i = at(0);
    if (i < 0) throw new Error(`He doesn't say ${quote(text)} ${where}. A scene shows only words he says there.`);
    out.push({ text, words: pool.slice(i, i + tokens.length) });
    from = i + tokens.length;
  }
  return out;
}

// ---- his frames: well exposed, varied, before the scene (never the payoff), cut into the shoot cache

type FramePick = { clip: string; atS: number; piece?: number };
async function exposure(file: string, atS: number): Promise<{ mean: number; clipped: number } | null> {
  const { tool } = await import("../tools");
  try {
    const { stdout } = await run(tool("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", atS.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=64:-2,format=gray", "-f", "rawvideo", "-"],
      { encoding: "buffer", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }) as unknown as { stdout: Buffer };
    if (!stdout.length) return null;
    let sum = 0, clipped = 0;
    for (const v of stdout) { sum += v; if (v < 6 || v > 250) clipped++; }
    return { mean: sum / stdout.length / 255, clipped: clipped / stdout.length };
  } catch { return null; }
}
const insideRoot = (root: string, rel: string) => { const f = path.resolve(root, rel); if (!f.startsWith(path.resolve(root) + path.sep)) throw new Error("That picture isn't inside this shoot."); return f; };
async function exists(file: string) { return fs.stat(file).then(s => s.isFile() && s.size > 0, () => false); }

/** The shots the edit has shown before the scene, one frame each, in story order: well exposed, one per clip. */
async function autoFrames(root: string, record: StoredVersion, sceneS: number, want: number): Promise<{ picks: FramePick[]; usable: number }> {
  const pieces = record.pieces ?? [], clips = new Map(record.assembly.shoot.clips.map(c => [c.id, c]));
  const last = pieces.length - 1, seen = new Set<string>(), candidates: FramePick[] = [];
  pieces.forEach((p, i) => {
    // Before the scene only: what comes after (and the last shot, the payoff) is never given away by the wall.
    if (i === last || p.timelineS + p.lengthS > sceneS + 1e-3 || seen.has(p.clipId)) return;
    const clip = clips.get(p.clipId);
    if (!clip?.meta || clip.missing || clip.meta.durationS <= 0 || !clip.meta.width) return;
    seen.add(p.clipId);
    const peak = clip.judgement?.peakS;
    candidates.push({ clip: p.clipId, atS: r4(peak !== undefined && peak > p.s && peak < p.e ? peak : (p.s + p.e) / 2), piece: i });
  });
  const measured: (FramePick & { score: number })[] = [];
  for (const c of candidates) {
    const clip = clips.get(c.clip)!, proxy = clip.proxy ? path.join(root, ".sidething", "proxies", clip.proxy) : null;
    const file = proxy && await exists(proxy) ? proxy : insideRoot(root, clip.file);
    const x = await exposure(file, c.atS);
    // Well exposed: not dark, not blown, not mostly clipped (a black frame, a flash-out, a sky).
    if (!x || x.mean < 0.12 || x.mean > 0.85 || x.clipped > 0.35) continue;
    measured.push({ ...c, score: 1 - Math.abs(x.mean - 0.45) });
  }
  if (measured.length <= want) return { picks: measured, usable: measured.length };
  // Varied: spread across the story, not the first `want` shots.
  const picks = Array.from({ length: want }, (_, k) => measured[Math.round(k * (measured.length - 1) / Math.max(1, want - 1))]);
  return { picks: [...new Map(picks.map(p => [p.clip, p])).values()], usable: measured.length };
}

/** One of his frames into the shoot's cache (graphics/card.ts saveCardPicture), drawn upright by Chromium. */
async function cacheFrame(root: string, record: StoredVersion, pick: FramePick, work: string, encode: (jpeg: Buffer) => Promise<Buffer>): Promise<string> {
  const clip = record.assembly.shoot.clips.find(c => c.id === pick.clip);
  if (!clip?.meta) throw new Error(`There is no clip called ${quote(pick.clip)} in this shoot.`);
  if (!(pick.atS >= 0) || pick.atS >= clip.meta.durationS) throw new Error(`${pick.clip} is ${clip.meta.durationS.toFixed(1)} s long. Choose a frame inside it.`);
  const { tool } = await import("../tools"), out = path.join(work, `${createHash("sha256").update(`${pick.clip}@${pick.atS}`).digest("hex").slice(0, 12)}.jpg`);
  const photo = clip.photo?.file ? insideRoot(root, clip.photo.file) : null;
  if (photo && await exists(photo)) await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "92", "-Z", "1280", photo, "--out", out], { timeout: 60_000 });
  else {
    const video = insideRoot(root, clip.file);
    if (!await exists(video)) throw new Error(`The footage for ${pick.clip} isn't on this Mac.`);
    await run(tool("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", pick.atS.toFixed(3), "-i", video, "-frames:v", "1",
      "-vf", "scale='min(iw,1280*iw/max(iw,ih))':-2", "-q:v", "2", out], { timeout: 60_000 });
  }
  if (!await exists(out)) throw new Error(`Couldn't read a frame from ${pick.clip}.`);
  const { saveCardPicture } = await import("./card");
  return saveCardPicture(root, await encode(await fs.readFile(out)));
}
/** Frames as handles, all encoded in one hidden page (card.ts withPage): upright from their tags, at most 960 px. */
async function cacheFrames(root: string, record: StoredVersion, picks: FramePick[]): Promise<string[]> {
  const { withPage } = await import("./card");
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "precut-scene-"));
  try {
    return await withPage(async js => {
      const encode = async (jpeg: Buffer) => {
        const url = await js<string | null>(`(async () => { const img = new Image(); img.src = ${JSON.stringify(`data:image/jpeg;base64,${jpeg.toString("base64")}`)}; await img.decode();
          const k = Math.min(1, 960 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas'); c.width = Math.max(8, Math.round(img.naturalWidth * k)); c.height = Math.max(8, Math.round(img.naturalHeight * k));
          const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height);
          const url = c.toDataURL('image/webp', 0.9); return url.startsWith('data:image/webp;base64,') ? url : null; })()`);
        if (!url) throw new Error("Couldn't prepare a frame for the scene.");
        return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
      };
      const out: string[] = [];
      for (const pick of picks) out.push(await cacheFrame(root, record, pick, work, encode));
      return [...new Set(out)];
    });
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}
/** How many frames a scene's look needs: the wall's grid; memories' default run. */
function framesNeeded(id: string, look: Record<string, unknown>): number {
  if (id === "scene-frame-wall") { const n = (k: string) => clamp(Math.round(typeof look[k] === "number" ? look[k] as number : 4), 2, 5); return n("cols") * n("rows"); }
  return clamp(Math.round(typeof look.count === "number" ? look.count as number : 14), 2, 32);
}

// ---- timing: element anchors (his words, the beat grid), resolved by shared/motion.ts

type Context = { fps: number; beats: number[]; words: SceneWord[] };
async function sceneContext(root: string, record: StoredVersion): Promise<Context> {
  // The frames the export draws (EXP3: a standard rate, 60 for a 59.89 average), so cuts and landings sit on them.
  const fps = (await import("../../shared/frame-rate")).standardFrameRate(record.assembly.template.fps);
  const { planFx } = await import("../edits-fx");
  const fx = planFx(record.assembly.cutList, fps, record);
  let grid = await (await import("../music-timeline")).timelineMusic(root, record, fx).catch(() => undefined);
  // A pause held in the music: until its audio is made, its grid is the base arrangement's with the pauses in it.
  const holds = record.music?.pinnedArrangement?.holds;
  if (!grid && holds?.length) {
    const base = await fs.readFile(path.join(root, ".sidething", "finish-cache", `arrange-${record.music!.pinnedArrangement!.key}.json`), "utf8").then(t => JSON.parse(t) as import("../music-arrange").MusicArrangement).catch(() => null);
    if (base) grid = (await import("../../shared/music-grid")).outputMusicGrid(base.measurements, fx.durationS, 0, (await import("../music-arrange")).heldParts(base.parts, holds, base.measurements.durationS));
  }
  return { fps, beats: dedupeBeats(grid?.beats ?? []), words: await motionKeyed(record, await sceneWords(root, record)) };
}
/** His words keyed by MOT1b's ids (graphics/mcp.ts motionWordsOf: the caption source's take-word ids), so a scene's word
 *  anchors are the ones get_motion, set_motion, the inspector and the ticks resolve. Matched on the edit clock: the
 *  word starting nearest it (within a frame or two), its spelling first; a word with no match keeps its own key. */
async function motionKeyed(record: StoredVersion, words: SceneWord[]): Promise<SceneWord[]> {
  const known = await (await import("./mcp")).motionWordsOf(record);
  if (!known.length) return words;
  const taken = new Set<string>();
  return words.map(w => {
    const near = known.filter(m => !taken.has(m.id) && Math.abs(m.s - w.s) < 0.05)
      .sort((a, b) => Number(norm(b.text) === norm(w.text)) - Number(norm(a.text) === norm(w.text)) || Math.abs(a.s - w.s) - Math.abs(b.s - w.s))[0];
    if (!near) return w;
    taken.add(near.id);
    return { ...w, key: near.id };
  });
}

/** Beat anchors for n landings from s, on the largest grid that leaves the hold before e (lines of a title on whole
 *  beats first, tiles and flashes on half beats first). */
function beatAnchors(n: number, s: number, e: number, beats: number[], holdBeats: number, F: number, grids: readonly (1 | 0.5 | 0.25)[] = [0.5, 0.25]): { beat: number[]; grid: 1 | 0.5 | 0.25 } | null {
  if (beats.length < 2 || n < 1) return null;
  const fps = 1 / F, limit = Math.floor((e - holdBeats * beatLength(beats, e)) * fps + 1e-6) / fps;
  for (const g of grids) {
    const first = Math.ceil((beatPosition(beats, s) - 0.02) / g) * g;
    const beat = Array.from({ length: n }, (_, k) => r4(first + k * g));
    if (Math.round(beatTime(beats, beat[n - 1]) * fps - 1e-6) / fps <= limit + 1e-6) return { beat, grid: g };
  }
  return null;
}

// ---- the request

type Built = { id: string; graphic: MotionGraphic; s: number; e: number; mode: "cutaway" | "pause"; notes: string[]; frames: FramePick[]; anchors: MotionElement[] };
async function buildScene(root: string, record: StoredVersion, request: SceneRequest, ctx: Context): Promise<Built> {
  const id = sceneTemplateId(request.kind), mode = request.mode === "pause" ? "pause" : "cutaway", notes: string[] = [];
  const { fps, beats, words } = ctx, F = 1 / fps, length = record.lengthS ?? 0;
  const look = { ...(request.look && typeof request.look === "object" ? request.look : {}) } as Record<string, unknown>;
  for (const k of ["words", "line1", "line2", "frames", "motion", "mode", ...SCENE_LOOK_KEYS]) delete look[k];
  // The span: reel seconds, or a phrase he says (from its first word to its last).
  let s0: number, e0: number;
  if (typeof request.span === "string") {
    const [hit] = placeWords([request.span], words, "in this edit");
    s0 = hit.words[0].s; e0 = hit.words.at(-1)!.e;
  } else if (request.span && Number.isFinite(request.span.s) && Number.isFinite(request.span.e) && request.span.e > request.span.s) ({ s: s0, e: e0 } = request.span);
  else throw new Error("Give the scene a span: {s, e} in reel seconds, or a phrase he says.");
  if (s0 < 0 || s0 >= length) throw new Error(`The edit is ${length.toFixed(1)} seconds long. Choose a time inside it.`);
  const points = snapPoints(beats, words);
  // A pause splits his voice in the gap before its start, so it never starts on the start of his next word (a tie or a
  // nearer word start was snapped there and then refused as "between his words").
  let s = snap(s0, mode === "pause" ? points.filter(p => !p.what.startsWith("the start of")) : points, words, fps, "start", notes), e: number;
  if (mode === "pause") {
    // The pause's length, on the beat grid near it (half beats), then the frame grid.
    const beat = beatLength(beats, s), asked = clamp(e0 - s0, SCENE_LENGTH.min, SCENE_LENGTH.max);
    const onGrid = beats.length >= 2 ? Math.max(1, Math.round(asked / (beat / 2))) * beat / 2 : asked;
    // Whole frames of the shot under it, so the time the trim adds is exactly the scene's length.
    const rate = shotUnder(record, s)?.rate ?? fps, P = Math.max(Math.ceil(SCENE_LENGTH.min * rate), Math.round(onGrid * rate)) / rate;
    if (Math.abs(P - (e0 - s0)) >= F) notes.push(`The pause is ${r2(P)} s (${r2(P / beat)} beats), on the music's grid and whole frames.`);
    e = s + P;
  } else {
    e = snap(Math.min(e0, length), points, words, fps, "end", notes);
    if (e - s < SCENE_LENGTH.min - 1e-6 || e - s > SCENE_LENGTH.max + 1e-6) throw new Error(`A scene runs ${SCENE_LENGTH.min} to ${SCENE_LENGTH.max} seconds; this one would be ${r2(e - s)} s.`);
    if (e > length + 1e-6) e = Math.floor(length * fps) / fps;
  }
  // s and e stay exact frame times: rounded to 0.1 ms they could fall just after their frame and cut a frame late.
  const theme = graphicTheme(record.titles), durationS = r4(e - s), params: Record<string, unknown> = { ...look, mode };
  let anchors: MotionElement[] = [], frames: FramePick[] = [];
  const holdDefault = id === "scene-title-slam" ? 1 : 0.5;
  const motionIn = request.motion && typeof request.motion === "object" ? request.motion : {};
  if (WORD_SCENES.includes(id)) {
    // His words: in the span for a cutaway; for a pause, the phrase it follows (the 8 s before it) or the next line.
    const pool = mode === "pause" ? words.filter(w => w.s >= s - 8 && w.s < s + 2) : words.filter(w => w.s >= s - F && w.e <= e + 2 * F);
    const where = mode === "pause" ? `in the phrase before the pause (${r2(Math.max(0, s - 8))} to ${r2(s)} s)` : `here (${r2(s)} to ${r2(e)} s)`;
    let asked = Array.isArray(request.words) ? request.words.map(String) : [];
    if (!asked.length) {
      if (mode === "pause") throw new Error("Give the words for the scene: his own, from the phrase the pause follows.");
      asked = pool.slice(0, 8).map(w => w.text);
    }
    const placed = placeWords(id === "scene-title-slam" && asked.length > 2 ? [asked.slice(0, -1).join(" "), asked.at(-1)!] : asked, pool, where);
    // Shown big, a word keeps only the punctuation that ends his sentence: "match," slams as "match".
    const shown = placed.map((p, i) => p.text.replace(i === placed.length - 1 ? /[,;:\u2013\u2014-]+$/ : /[,;:.\u2013\u2014-]+$/, ""));
    if (id === "scene-beat-words") {
      params.words = shown;
      // One accent: the word the captions already accent in the span, else the last.
      if (params.accent === undefined) {
        const { timedCaptionWords } = await import("../../shared/caption-words");
        const accented = timedCaptionWords(record.titles).filter(w => w.accent && w.s < e && w.e > s);
        const k = placed.findIndex(p => accented.some(a => a.s < p.words.at(-1)!.e && a.e > p.words[0].s));
        params.accent = k >= 0 ? k + 1 : 0;
      }
    } else { params.line1 = shown[0]; params.line2 = shown[1] ?? ""; if (!placed[1]) { params.line2 = shown[0]; params.line1 = ""; } }
    // Cutaway: each element lands on the frame he starts saying it. Pause: his voice is stopped, so on the beat grid.
    if (mode === "cutaway") anchors = placed.map((p, i) => ({ id: id === "scene-beat-words" ? `w${i}` : `l${placed.length === 1 ? 2 : i + 1}`, at: r4(Math.max(0, p.words[0].s - s)), word: p.words[0].key }));
  } else {
    const need = framesNeeded(id, look);
    if (Array.isArray(request.frames) && request.frames.length) {
      frames = request.frames.map(f => ({ clip: String(f?.clip ?? ""), atS: Number(f?.atS) }));
      if (frames.length < (id === "scene-frame-wall" ? 4 : 2)) throw new Error(id === "scene-frame-wall" ? "Not enough shots for a wall here. A wall needs at least 4 of his frames; try beat words." : "Not enough shots for memories here. They need at least 2 of his frames; try beat words.");
    } else {
      const { picks, usable } = await autoFrames(root, record, s, need);
      if (picks.length < need) {
        const kind = id === "scene-frame-wall" ? "a wall" : "memories";
        throw new Error(`Not enough shots for ${kind} here. ${id === "scene-frame-wall" ? `A ${look.cols ?? 4} by ${look.rows ?? 4} wall` : "This"} needs ${need} of his frames, and the edit shows ${usable} usable shots before ${r2(s)} s. Try a smaller grid, or beat words.`);
      }
      frames = picks;
    }
    params.frames = await cacheFrames(root, record, frames);
  }
  // Build once to learn the elements (a wall's landings come from its grid and pattern), then time them.
  const draft = buildFromTemplate(id, params, theme, { durationS, ...(Object.keys(motionIn).length ? { motion: motionIn as unknown as Motion } : {}) });
  const base = draft.motion!;
  const holdBeats = typeof motionIn.holdBeats === "number" ? clamp(motionIn.holdBeats, 0, 4) : base.holdBeats ?? holdDefault;
  const grids = id === "scene-title-slam" ? [1, 0.5, 0.25] as const : [0.5, 0.25] as const;
  if (!anchors.length) {
    const n = base.elements.length, a = beatAnchors(n, s, e, beats, holdBeats, F, grids);
    if (a) anchors = base.elements.map((el, i) => ({ id: el.id, at: r4(beatTime(beats, a.beat[i]) - s), beat: a.beat[i] }));
    else {
      // No music beats (or no room on the grid): his word onsets in the span, else evenly through the first 70%.
      const onsets = words.filter(w => w.s >= s && w.s < e - 0.2).map(w => w.s - s);
      anchors = base.elements.map((el, i) => ({ id: el.id, at: r4(onsets.length >= n ? onsets[Math.round(i * (onsets.length - 1) / Math.max(1, n - 1))] : i * durationS * 0.7 / Math.max(1, n)) }));
      notes.push(beats.length < 2 ? "There are no music beats here, so it is timed to his words." : "The landings don't fit on the beat grid here, so they are spread through the scene.");
    }
  }
  const grid = beats.length >= 2 ? (beatAnchors(anchors.length, s, e, beats, holdBeats, F, grids)?.grid ?? 0.5) : 0.5;
  // A word lands on the frame he starts saying it; when the scene ends too soon after the last one for the whole hold,
  // the hold is what's left (never a word pulled early).
  let hold = holdBeats;
  const lastWord = anchors.filter(a => a.word).at(-1);
  if (lastWord) {
    const w = words.find(x => x.key === lastWord.word), room = w ? Math.floor(((e - Math.round(w.s * fps) / fps) / beatLength(beats, e) + 1e-6) * 4) / 4 : hold;
    if (room < hold) { notes.push(`It holds ${room} beat${room === 1 ? "" : "s"} after the last word: there isn't room for ${hold} before the scene ends.`); hold = Math.max(0, room); }
  }
  const motion: Motion = clampMotion({ ...base, ...motionIn, holdBeats: hold, grid: motionIn.grid ?? grid, elements: anchors.map(a => {
    const given = (Array.isArray(motionIn.elements) ? motionIn.elements as MotionElement[] : []).find(x => x?.id === a.id);
    return { ...a, ...(given ?? {}) };
  }) });
  const resolved = resolveMotion(motion, { itemS: s, itemE: e, words: words.map(w => ({ id: w.key, s: w.s, e: w.e })), beats, fps });
  notes.push(...resolved.notes);
  if (resolved.moved.length) notes.push(`${resolved.moved.length === 1 ? "One landing was" : `${resolved.moved.length} landings were`} moved to keep the order and the hold at the end.`);
  const graphic = buildFromTemplate(id, params, theme, { durationS, motion: withTimes(motion, resolved.at),
    // The first word at his own time, unrounded: a recut re-times word graphics to where the word is now
    // (edit.ts retimeToWords), and a rounded time would slide the scene off its frame on every recut.
    ...(mode === "cutaway" && WORD_SCENES.includes(id) ? { words: words.filter(w => w.key === anchors[0]?.word).slice(0, 1).map(w => ({ text: w.text, atS: w.s })) } : {}) });
  return { id, graphic, s, e, mode, notes, frames, anchors: motion.elements };
}

/** The scene's item: full frame, no enter or exit (it cuts in and out), its own sound none (the sound is on the lane). */
const sceneItem = (graphic: MotionGraphic, s: number, e: number): Omit<OverlayItem, "id" | "file"> => ({ graphic, s, e, x: 0.5, y: 0.5, w: 1, corner: "square", enter: "none", exit: "none", sound: null });

/** What a scene's elements are and when they land, in seconds and beats, for the answer. */
function elementRows(b: Built, ctx: Context, at: number) {
  const g = b.graphic, src = graphicSource(g)?.params ?? {}, m = g.motion!;
  const labels = b.id === "scene-beat-words" ? (src.words as string[]) : b.id === "scene-title-slam" ? [src.line1, src.line2].filter(Boolean) as string[] : null;
  const groups = g.js ? JSON.parse(/GR=(\[[^\]]*\])/.exec(g.js)?.[1] ?? "[]") as number[] : [];
  return m.elements.map((el, i) => {
    const t = r4(at + el.at);
    return { id: el.id, ...(labels ? { text: labels[b.id === "scene-title-slam" && labels.length === 1 ? 0 : i] } : { frames: groups.filter(k => k === i).length }),
      atS: t, intoSceneS: el.at, beat: ctx.beats.length >= 2 ? r2(beatPosition(ctx.beats, t)) : null, ...(el.word ? { word: el.word } : {}) };
  });
}

// ---- the pause: split the voice, grow the shot under it on the frame grid, hold the music

type PauseStep = (version: number) => Promise<{ version: number }>;
/** The shot playing at a reel time, and its source frame rate. */
function shotUnder(record: StoredVersion, at: number) {
  const pieces = record.pieces ?? [], idx = pieces.findIndex(p => p.timelineS - 1e-6 <= at && p.timelineS + p.lengthS > at + 1e-6);
  if (idx < 0) return null;
  const item = record.assembly.cutList.find(c => (c.piece ?? -1) === idx);
  return { idx, piece: pieces[idx], rate: item ? item.clipFpsR.num / item.clipFpsR.den : record.assembly.template.fps };
}
type PauseParts = { picture: PauseStep[]; voice: (final: StoredVersion) => Promise<string | null>; split: number;
  grows: { piece: number; tail: boolean; splits: boolean } };   // SCN2: the shot the time is added to (its index after the split, picture[1] when it splits), and whether its tail grows
async function pauseSteps(root: string, cutId: string, record: StoredVersion, at: number, P: number, notes: string[]): Promise<PauseParts> {
  const { editCut, loadDraftVersion } = await import("../sidekick");
  if (!record.voiceover?.lines?.length) throw new Error("A pause stops his voice for the scene, and this edit has no voiceover lane. Use a cutaway here.");
  const fps = (await import("../../shared/frame-rate")).standardFrameRate(record.assembly.template.fps), F = 1 / fps, pieces = record.pieces ?? [];
  const under = shotUnder(record, at);
  if (!under) throw new Error("There is no shot at that time to hold under the pause.");
  const { idx, piece, rate } = under, speed = record.pieceFx?.[idx]?.speed ?? 1;
  if (speed !== 1) throw new Error("The shot under the pause plays at another speed. Set it to 1x first, or pause on another shot.");
  const clip = record.assembly.shoot.clips.find(c => c.id === piece.clipId), clipLength = clip?.meta?.durationS ?? piece.e;
  // The time is added at `split`, at or just after the scene's start (within a source frame, so no frame of the shot
  // after it shows before the scene cuts in), and the added length is exactly P on the source's frame grid.
  const split0 = piece.s + (at - piece.timelineS), frame = 1 / rate;
  let srcAt = Math.ceil(split0 * rate - 1e-6) / rate;
  let trim: CutEdit, splitEdit: CutEdit | null = null, nextOld = idx + 1, nextNew = idx + 2;
  if (srcAt - piece.s < frame / 2) {
    // On the shot's first frame: no split, the shot itself starts P earlier.
    srcAt = piece.s; nextNew = idx + 1;
    if (piece.s - P < -1e-9) throw new Error("There isn't enough of the shot under the pause to hold it. Pause on another shot, or use a cutaway.");
    trim = { kind: "trim", piece: idx, s: r4(piece.s - P), e: piece.e, magnetic: true } as CutEdit;
  } else if (piece.e - srcAt < frame / 2) {
    // On its last frame: the next shot starts P earlier.
    const next = pieces[idx + 1];
    if (!next || next.s - P < -1e-9) throw new Error("There isn't enough of the next shot to hold under the pause. Pause on another shot, or use a cutaway.");
    srcAt = piece.e; nextOld = idx + 2; nextNew = idx + 2;
    trim = { kind: "trim", piece: idx + 1, s: r4(next.s - P), e: next.e, magnetic: true } as CutEdit;
  } else {
    splitEdit = { kind: "split", piece: idx, at: r4(srcAt) } as CutEdit;
    if (srcAt - P >= -1e-9) trim = { kind: "trim", piece: idx + 1, s: r4(srcAt - P), e: piece.e, magnetic: true } as CutEdit;
    else if (srcAt + P <= clipLength + 1e-6) trim = { kind: "trim", piece: idx, s: piece.s, e: r4(srcAt + P), magnetic: true } as CutEdit;
    else throw new Error("There isn't enough of the shot under the pause to hold it. Pause on another shot, or use a cutaway.");
  }
  const splitReel = r4(piece.timelineS + (srcAt - piece.s));
  if (splitReel - at > 1 / rate + 1e-6 || splitReel < at - 1e-6) throw new Error("Couldn't line the pause up with the shot's frames here. Try a frame either side.");
  // His voice is split in the silence just after the picture's split, so the ripple takes all of it after the pause.
  const nextWord = (await sceneWords(root, record)).find(w => w.e > splitReel - 1e-6);
  if (nextWord && nextWord.s < splitReel + F / 4) throw new Error("A pause goes between his words. Choose a time in a gap, or a cutaway.");
  const voiceAt = r4(Math.min(splitReel + F / 2, nextWord ? (splitReel + nextWord.s) / 2 : splitReel + F / 2));
  const voiceLine = record.voiceover.lines.find(l => l.s < voiceAt - 1e-6 && l.e > voiceAt + 1e-6);
  const firstAfter = record.voiceover.lines.filter(l => l.s >= voiceAt - 1e-6).sort((a, b) => a.s - b.s)[0];
  const voiceWas = voiceLine ? voiceAt : firstAfter?.s ?? null;
  const picture: PauseStep[] = [];
  // The shot under it: split, then grown by P with a magnetic trim, which carries the captions, sounds, graphics and
  // every later shot along by exactly P.
  if (splitEdit) { const edit = splitEdit; picture.push(v => editCut(root, cutId, v, edit)); }
  picture.push(v => editCut(root, cutId, v, trim));
  // The music: the arrangement it had, its bed playing on under the pause; nothing re-fitted.
  const music = record.music;
  if (music?.pinnedArrangement && (music.fit || music.followStory)) {
    const was = music.pinnedArrangement, holds = [...(was.holds ?? []), { atS: r4(splitReel), s: r4(P) }];
    picture.push(v => import("../finish").then(m => m.finishCut(root, cutId, v, { music: { ...music, gainDb: music.gainDb ?? -18, duck: music.duck ?? true, pinnedArrangement: { ...was, holds } } })));
    notes.push("The music keeps its arrangement: its bed plays on under the pause, then carries on with his voice as before.");
  } else if (music) notes.push("The music plays on under the pause.");
  // His voice: split in the gap, then rippled onto the finished picture by the same re-timing a saved picture edit
  // gives it (voiceover-retime.ts retimeScript: each piece follows the picture under it), applied once to the draft
  // before it is saved. Inside one version the save would re-time the voice from before the split, so this version
  // owns its voice; nobody moves it by hand (SCN0: a hand move on top of the ripple moved it twice).
  const voice = async (final: StoredVersion): Promise<string | null> => {
    const { applyVoiceEdit } = await import("../../shared/voice-edit"), { retimeScript } = await import("../voiceover-retime"), { planFx } = await import("../edits-fx");
    const takes = await (await import("../voiceover-takes")).listVoiceovers(root);
    const takeOf = (file: string) => { const t = takes.find(x => x.file === file); return t && { file: t.file, durationS: t.durationS, words: (t.transcript ?? []).flatMap(g => g.words).filter(w => w.e > w.s).sort((x, y) => x.s - y.s) }; };
    const script = record.voiceover!;
    const lines = voiceLine ? applyVoiceEdit(script.lines, { kind: "voiceover", op: "split", line: voiceLine.id, at: voiceAt } as never, takeOf, () => `vo-${createHash("sha256").update(`${voiceLine.id}@${voiceAt}`).digest("hex").slice(0, 8)}`) : script.lines;
    const split = { ...script, lines, version: record.version };
    const rippled = retimeScript(split, record, final, { before: planFx(record.assembly.cutList, record.assembly.template.fps, record), after: planFx(final.assembly.cutList, final.assembly.template.fps, final) });
    final.voiceover = { ...rippled, version: final.version };
    // As a save does after re-timing the voice: the captions follow it.
    if (final.titles) await (await import("../caption-realign")).followCaptionsToVoice(root, final);
    // Check: his voice after the pause, the next shot and the edit's length all moved by exactly P (else nothing saves).
    const shifts: [string, number][] = [["the edit", (final.lengthS ?? 0) - (record.lengthS ?? 0)]];
    if (voiceWas !== null) {
      const moved = final.voiceover.lines.map(l => l.s).sort((x, y) => Math.abs(x - voiceWas - P) - Math.abs(y - voiceWas - P))[0];
      shifts.push(["his voice", moved === undefined ? NaN : moved - voiceWas]);
    }
    const before = final.voiceover.lines.filter(l => l.s < voiceAt - 1e-6), was = script.lines.filter(l => l.s < voiceAt - 1e-6);
    if (before.some((l, i) => Math.abs(l.s - (was[i]?.s ?? NaN)) > 1e-4)) shifts.push(["his voice before the pause", NaN]);
    if (pieces[nextOld] && final.pieces?.[nextNew]) shifts.push(["the next shot", final.pieces[nextNew].timelineS - pieces[nextOld].timelineS]);
    const bad = shifts.find(([what, d]) => !Number.isFinite(d) ? true : what !== "his voice before the pause" && Math.abs(d - P) > F / 4);
    return bad ? `The pause moved ${bad[0]} by ${Number.isFinite(bad[1]) ? `${r2(bad[1])} s` : "the wrong amount"} instead of ${r2(P)} s, so nothing was changed.` : null;
  };
  const grown = (trim as { piece: number }).piece;
  return { picture, voice, split: splitReel, grows: { piece: grown, tail: !!splitEdit && grown === idx, splits: !!splitEdit } };
}

// ---- add_scene, and Produce's scene move (SCN2), on the same checks

const sceneRequest = (input: Record<string, unknown>): SceneRequest => ({ kind: String(input.kind ?? ""), span: (typeof input.span === "string" || Array.isArray(input.span) ? [input.span].flat().join(" ") : input.span) as SceneRequest["span"],
  mode: input.mode === "pause" ? "pause" : "cutaway", words: Array.isArray(input.words) ? input.words.map(String) : undefined,
  frames: Array.isArray(input.frames) ? input.frames as { clip: string; atS: number }[] : "auto", look: input.look as Record<string, unknown> | undefined,
  motion: input.motion as Record<string, unknown> | undefined, sound: input.sound === null ? null : typeof input.sound === "string" ? input.sound : undefined });

/** A scene made for this version and not saved: its item (full frame, cut in and out), its one sound on the first
 * landing, and what it shows. add_scene saves it; Produce's director (SCN2) checks and places it inside its pass, so a
 * scene the pass makes obeys every check here (his words, his frames, the snap, the pause's grid). */
export async function prepareScene(root: string, record: StoredVersion, input: Record<string, unknown>) {
  const request = sceneRequest(input);
  const ctx = await sceneContext(root, record);
  const built = await buildScene(root, record, request, ctx);
  if ((record.overlays ?? []).some(o => o.graphic?.frame === "full" && o.s < built.e && o.e > built.s)) throw new Error("There is already a full-screen scene or graphic here. Move or remove it first.");
  // LOOK1: a new scene sits on his own shot (or the look the edit's scenes already have), its words kept readable.
  const dressed = await (await import("./look")).lookForNewScene(root, record, built.graphic, { s: built.s, e: built.e }, lookAsked(request.look));
  built.graphic = dressed.graphic; built.notes.push(...dressed.notes);
  const sound = request.sound === null ? null : request.sound ? { file: request.sound, name: "scene sound", kind: "hit" as const, role: "hit" as const } : SCENE_SOUND[built.id];
  const first = r4(built.s + (built.graphic.motion?.elements[0]?.at ?? 0));
  const name = Object.entries(SCENE_KINDS).find(([, v]) => v === built.id)![0];
  const params = graphicSource(built.graphic)?.params ?? {};
  // What it shows, in his words (word scenes) or as his frames.
  const shown = built.id === "scene-beat-words" ? (params.words as string[] | undefined) ?? [] : built.id === "scene-title-slam" ? [params.line1, params.line2].filter(x => typeof x === "string" && x) as string[] : [];
  const onBeat = ctx.beats.length >= 2 && ctx.beats.some(b => Math.abs(b - built.s) < 1.5 / ctx.fps);
  return { request, ctx, built, name, shown, onBeat, item: sceneItem(built.graphic, built.s, built.e), sound: sound ? { ...sound, landAtS: first } : null };
}

/** SCN2: the pause as steps on a draft (split, grow the shot under it, hold the music) and the voice hook that ripples
 * his voice once the draft is finished, for Produce's pass to run inside its own batch. */
export const scenePauseSteps = (root: string, cutId: string, record: StoredVersion, at: number, P: number, notes: string[]) => pauseSteps(root, cutId, record, at, P, notes);

export async function addScene(root: string, cutId: string, version: number, input: Record<string, unknown>) {
  const { loadDraftVersion, runBatch } = await import("../sidekick");
  const record = await loadDraftVersion(root, cutId, version);
  const { ctx, built, name, item, sound } = await prepareScene(root, record, input), notes = [...built.notes];
  const steps: Parameters<typeof runBatch>[4] = [];
  const at = built.s, end = built.e;
  const pause = built.mode === "pause" ? await pauseSteps(root, cutId, record, built.s, r4(built.e - built.s), notes) : null;
  if (pause) steps.push(...pause.picture);
  steps.push({ kind: "overlay", op: "add", source: "", item } as CutEdit);
  const first = sound?.landAtS ?? r4(at + (built.graphic.motion?.elements[0]?.at ?? 0));
  if (sound) steps.push({ kind: "sfx", op: "add", item: { file: sound.file, name: sound.name, kind: sound.kind, role: sound.role, gainDb: 0, landAtS: first, reason: "The scene's first landing" } } as CutEdit);
  // One version through the revisions commit, as every hand edit saves (editCut's path), then the voice sidecar.
  let refused: string | null = null;
  const { commitEdit } = await import("../revisions");
  const result = await commitEdit(root, cutId, version, { strict: true }, async base => {
    if (base !== version) throw new Error("The edit changed while the scene was being made. Try again.");
    const saved = await runBatch(root, cutId, base, built.mode === "pause" ? `Added a ${name} pause` : `Added a ${name} scene`, steps,
      pause ? async final => !(refused = await pause.voice(final)) : undefined);
    if (!saved) throw new Error(refused ?? "The scene wasn't saved.");
    return { ...saved, baseVersion: base };
  });
  if (pause) await (await import("../voiceover-script")).syncVoiceoverSidecar(root, cutId, { voice: true }).catch(error => console.warn("[voiceover]", error));
  const saved = await loadDraftVersion(root, cutId, result.version);
  const made = (saved.overlays ?? []).filter(o => o.graphic?.template === built.id && Math.abs(o.s - at) < 1e-3).at(-1);
  return {
    ...result, id: made?.id,
    scene: { kind: name, mode: built.mode, s: at, e: end, lengthS: r4(end - at), beats: ctx.beats.length >= 2 ? { s: r2(beatPosition(ctx.beats, at)), e: r2(beatPosition(ctx.beats, end)) } : null,
      captions: (graphicSource(built.graphic)?.params.captions as string | undefined) ?? "step aside",
      ...(built.id === "scene-beat-words" ? { accent: (graphicSource(built.graphic)?.params.words as string[] | undefined)?.[((graphicSource(built.graphic)?.params.accent as number) || (graphicSource(built.graphic)?.params.words as string[]).length) - 1] ?? null } : {}), ...(built.mode === "pause" ? { addedS: r4(end - at), editLengthS: saved.lengthS } : {}) },
    elements: elementRows(built, ctx, at),
    ...(built.frames.length ? { frames: built.frames.map((f, i) => ({ clip: f.clip, atS: f.atS, media: built.graphic.frames?.[i] ?? null })) } : {}),
    sound: sound ? { file: sound.file, atS: first } : null,
    notes,
    note: "Check it with preview_graphic (id, atS) or look_at. Change its look with update_graphic params; take it out with remove_graphic, or undo to take out the whole change.",
  };
}

/** update_graphic on a scene: new words must still be words he says in its span. */
export async function checkSceneParams(root: string, record: StoredVersion, item: OverlayItem, params: Record<string, unknown>): Promise<void> {
  const id = item.graphic?.template;
  if (!id || !WORD_SCENES.includes(id) || !["words", "line1", "line2"].some(k => k in params)) return;
  const words = await sceneWords(root, record), F = 1 / record.assembly.template.fps;
  const pause = graphicSource(item.graphic!)?.params.mode === "pause";
  const pool = pause ? words.filter(w => w.s >= item.s - 8 && w.s < item.s + 2) : words.filter(w => w.s >= item.s - F && w.e <= item.e + 2 * F);
  const asked = id === "scene-beat-words" ? (Array.isArray(params.words) ? params.words.map(String) : []) : [params.line1, params.line2].filter(x => typeof x === "string" && x.trim()) as string[];
  placeWords(asked, pool, pause ? "in the phrase before the pause" : `here (${r2(item.s)} to ${r2(item.e)} s)`);
}

export const isSceneGraphic = (g: MotionGraphic | null | undefined) => !!g && SCENE_TEMPLATES.some(t => t.id === g.template);
export { SCENE_FRAME };

// LOOK1: the look's pictures are cut into the cache the same way (graphics/look.ts).
export { cacheFrames as cacheSceneFrames };
