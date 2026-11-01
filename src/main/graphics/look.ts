// LOOK1 (docs/plans/produced/scene-look-spike.md): the parts of a scene's look that need the shoot. The values and the
// change itself are shared/look.ts and templates.ts setGraphicLook (pure, so the inspector previews while it changes);
// here they get their pictures and their dim:
//   - from the shot: the frame under the scene's start, cut into the shoot's cache like a scene's frames (SCN1b), with
//     its own colours for Shuffle;
//   - an image: a frame from his library (clip and time) or a file he drops, into the same cache; a library frame keeps
//     the face precut found there (clip.subject), so the words keep off it;
//   - a design: Claude's html and css, drawn and timed; one that takes longer than its budget to draw is drawn once into
//     a picture (pre-rasterised) and shown as that;
//   - the auto dim: the background under the words measured (as qa/LOOK0 did: the brightest part they cover, then every
//     pixel round every glyph) so each word reads at 4.5:1 or better, and said when it had to darken.
// One change is one version: the inspector sends the edit this returns; set_scene_look saves it.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CutEdit, MotionGraphic, OverlayItem } from "../../shared/schema";
import { autoDim, changeLook, clampLook, isHex, LOOK_CONTRAST, LOOK_FONTS, LOOK_KINDS, LOOK_LIMITS, LOOK_NEW, LOOK_NOTES, lookDim, luminance, paletteOf, sameLookAcrossScenes, type Look, type LookBox, type LookChange } from "../../shared/look";
import { graphicLook, NO_LOOK, withGraphicLook } from "./templates";
import type { StoredVersion } from "../sidekick";

const run = promisify(execFile);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const WORD_SCENES = ["scene-beat-words", "scene-title-slam"];
/** A design whose frames take this much longer to draw than the same scene on black (and at least twice as long) is
 *  drawn once into a picture. */
export const LOOK_DESIGN_BUDGET_MS = 150;
/** Picture scenes have no words to keep readable: auto dims the background so his frames stand out on it. */
const FRAMES_DIM = 0.45;

// ---- pictures from the shoot

/** The shot playing at the scene's start, and where in it. */
function shotAt(record: StoredVersion, at: number): { clip: string; atS: number } | null {
  const pieces = record.pieces ?? [], i = pieces.findIndex(p => p.timelineS - 1e-6 <= at && p.timelineS + p.lengthS > at + 1e-6);
  const p = pieces[i] ?? pieces.find(x => x.timelineS + x.lengthS > at) ?? pieces.at(-1);
  if (!p) return null;
  const speed = record.pieceFx?.[pieces.indexOf(p)]?.speed ?? 1;
  return { clip: p.clipId, atS: r3(Math.max(p.s, Math.min(p.e - 0.04, p.s + Math.max(0, at - p.timelineS) * speed))) };
}
async function cacheClipFrame(root: string, record: StoredVersion, clip: string, atS: number): Promise<string> {
  const [media] = await (await import("./scene-edit")).cacheSceneFrames(root, record, [{ clip, atS }]);
  if (!media) throw new Error("Couldn't read a frame for the background.");
  return media;
}
/** A file he dropped: made upright and at most 1280 px by macOS (any format it reads), then into the cache as webp. */
async function cacheFile(root: string, file: string): Promise<string> {
  if (!path.isAbsolute(file) || !/\.(jpe?g|png|heic|heif|webp|tiff?|gif|bmp)$/i.test(file)) throw new Error("Drop a picture: a JPEG, PNG, HEIC, WebP or TIFF.");
  if (!await fs.stat(file).then(s => s.isFile() && s.size > 0 && s.size < 200 * 1024 * 1024, () => false)) throw new Error("That picture couldn't be read.");
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "precut-look-"));
  try {
    const jpeg = path.join(work, "picture.jpg");
    await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "90", "-Z", "1280", file, "--out", jpeg], { timeout: 60_000 });
    const bytes = await encodeWebp(await fs.readFile(jpeg), "image/jpeg");
    return (await import("./card")).saveCardPicture(root, bytes);
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}
/** A picture as a webp (at most 1280 px), drawn by Chromium in a hidden page (graphics/card.ts withPage). */
async function encodeWebp(bytes: Buffer, mime: string, maxSide = 1280): Promise<Buffer> {
  const { withPage } = await import("./card");
  const url = await withPage(js => js<string | null>(`(async () => { const img = new Image(); img.src = ${JSON.stringify(`data:${mime};base64,${bytes.toString("base64")}`)}; await img.decode();
    const k = Math.min(1, ${maxSide} / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas'); c.width = Math.max(8, Math.round(img.naturalWidth * k)); c.height = Math.max(8, Math.round(img.naturalHeight * k));
    const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/webp', 0.9); return url.startsWith('data:image/webp;base64,') ? url : null; })()`));
  if (!url) throw new Error("Couldn't prepare that picture for the background.");
  return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
}
/** The picture's own colours (a 32 x 56 copy, k-means), for Shuffle. */
async function paletteOfMedia(root: string, media: string): Promise<string[]> {
  try {
    const bytes = await fs.readFile(path.join(root, ".sidething", "overlays", media));
    const { withPage } = await import("./card");
    const rgb = await withPage(js => js<number[]>(`(async () => { const img = new Image(); img.src = ${JSON.stringify(`data:image/webp;base64,${bytes.toString("base64")}`)}; await img.decode();
      const c = document.createElement('canvas'); c.width = 32; c.height = 56; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 32, 56);
      const d = g.getImageData(0, 0, 32, 56).data, out = []; for (let i = 0; i < d.length; i += 4) out.push(d[i], d[i + 1], d[i + 2]); return out; })()`));
    return paletteOf(rgb, 4);
  } catch { return []; }
}
/** The face precut found nearest this time in the clip (Apple Vision, clip.subject), as a box from the picture's top left. */
export function faceIn(record: StoredVersion, clip: string, atS: number): LookBox | undefined {
  const samples = record.assembly.shoot.clips.find(c => c.id === clip)?.subject?.samples ?? [];
  const face = samples.filter(p => p.kind === "face" && [p.t, p.x, p.y, p.w, p.h].every(Number.isFinite) && Math.abs(p.t - atS) <= 1.5).sort((a, b) => Math.abs(a.t - atS) - Math.abs(b.t - atS))[0];
  return face ? [r3(face.x - face.w / 2), r3(face.y - face.h / 2), r3(face.w), r3(face.h)] : undefined;
}
// Apple Vision through the system's JavaScript bridge (as graphics/card.ts reads text): on-device, nothing installed.
const FACES = `ObjC.import('Foundation'); ObjC.import('Vision');
function run(argv) {
  var req = $.VNDetectFaceRectanglesRequest.alloc.init, handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(argv[0]), $({}));
  handler.performRequestsError($([req]), null);
  var out = [], r = req.results; for (var i = 0; i < r.count; i++) { var b = r.objectAtIndex(i).boundingBox; out.push([b.origin.x, b.origin.y, b.size.width, b.size.height]); }
  return JSON.stringify(out);
}`;
/** The faces on an upright picture (the cached one), as one box from its top left round the main faces; none found, undefined. */
export async function faceOnPicture(file: string): Promise<LookBox | undefined> {
  try {
    const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", FACES, file], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const boxes = (JSON.parse(stdout.trim() || "[]") as number[][]).map(([x, y, w, h]) => [x, 1 - y - h, w, h]).filter(b => b.every(Number.isFinite) && b[2] > 0.01);
    if (!boxes.length) return undefined;
    const big = Math.max(...boxes.map(b => b[2] * b[3])), main = boxes.filter(b => b[2] * b[3] >= big * 0.25);
    const x0 = Math.min(...main.map(b => b[0])), y0 = Math.min(...main.map(b => b[1])), x1 = Math.max(...main.map(b => b[0] + b[2])), y1 = Math.max(...main.map(b => b[1] + b[3]));
    return [x0, y0, x1 - x0, y1 - y0].map(n => r3(Math.max(0, Math.min(1, n)))) as LookBox;
  } catch { return undefined; }
}
/** A library frame by its file name (clip.frames), as the clip and the time it shows. */
export function libraryFrame(record: StoredVersion, frame: string): { clip: string; atS: number } | null {
  for (const clip of record.assembly.shoot.clips) {
    const i = clip.frames.indexOf(frame);
    if (i < 0) continue;
    const stamped = /_t(\d+(?:\.\d+)?)\.jpg$/.exec(frame)?.[1];
    return { clip: clip.id, atS: r3(stamped !== undefined ? Number(stamped) : clip.meta ? (i + 0.5) * clip.meta.durationS / clip.frames.length : 0) };
  }
  return null;
}

// ---- the auto dim: the background under the words, measured

type Size = { width: number; height: number };
const measureSize = (frame: Size): Size => { const k = 270 / Math.min(frame.width, frame.height); return { width: Math.round(frame.width * k / 2) * 2, height: Math.round(frame.height * k / 2) * 2 }; };
const HIDE_WORDS = ".g{visibility:hidden!important}";
const HIDE_BACKGROUND = ".lk-bg,.lk-vig,.lk-dim,.lk-grain{visibility:hidden!important}.root,#gfx{background:transparent!important}";
const straight = (b: Buffer, i: number) => { const a = b[i + 3]; return a && a < 255 ? [b[i + 2] * 255 / a, b[i + 1] * 255 / a, b[i] * 255 / a] : [b[i + 2], b[i + 1], b[i]]; };   // BGRA premultiplied to RGB

/** What the words sit on: per type colour, the background pixels round its glyphs, and the brightest part (98th
 *  percentile of luminance) of the box the words cover. Exported for the QA harness. */
export function wordsOn(bg: Buffer, words: Buffer, size: Size, colours: string[]): { ring: { colour: string; pixels: number[][] }[]; bright: number; glyphs: number } {
  const { width: W, height: H } = size, cl = colours.map(c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)));
  const owner = new Int8Array(W * H).fill(-1);
  let glyphs = 0, x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let i = 0; i < W * H; i++) {
    const a = words[i * 4 + 3];
    if (a > 40) { const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (a < 230) continue;
    glyphs++;
    const px = straight(words, i * 4);
    let bi = 0, bd = Infinity;
    cl.forEach((q, j) => { const d = Math.abs(px[0] - q[0]) + Math.abs(px[1] - q[1]) + Math.abs(px[2] - q[2]); if (d < bd) { bd = d; bi = j; } });
    owner[i] = bi;
  }
  if (!glyphs) return { ring: colours.map(colour => ({ colour, pixels: [] })), bright: 0, glyphs };
  // a ring round each glyph (separable grow of the owner map), so the words' edges count as well as what is under them
  const R = Math.max(1, Math.round(0.008 * W)), tmp = new Int8Array(W * H).fill(-1), grown = new Int8Array(W * H).fill(-1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = owner[y * W + x]; if (o < 0) continue; for (let d = -R; d <= R; d++) { const xx = x + d; if (xx >= 0 && xx < W && tmp[y * W + xx] < 0) tmp[y * W + xx] = o; } }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = tmp[y * W + x]; if (o < 0) continue; for (let d = -R; d <= R; d++) { const yy = y + d; if (yy >= 0 && yy < H && grown[yy * W + x] < 0) grown[yy * W + x] = o; } }
  const ring = colours.map(colour => ({ colour, pixels: [] as number[][] }));
  for (let i = 0; i < W * H; i++) if (grown[i] >= 0) ring[grown[i]].pixels.push(straight(bg, i * 4));
  const pad = Math.round(0.03 * W), lums: number[] = [];
  for (let y = Math.max(0, y0 - pad); y <= Math.min(H - 1, y1 + pad); y++) for (let x = Math.max(0, x0 - pad); x <= Math.min(W - 1, x1 + pad); x++) lums.push(luminance(straight(bg, (y * W + x) * 4)));
  lums.sort((a, b) => a - b);
  return { ring, bright: lums[Math.floor(lums.length * 0.98)] ?? 0, glyphs };
}

const measured = new Map<string, { dim: number; worst: number; darkened: boolean }>();
/** The dim that keeps every word at 4.5:1 or better on this scene's background (null: it has no words). */
async function measureDim(root: string, graphic: MotionGraphic, frame: Size): Promise<{ dim: number; worst: number; darkened: boolean } | null> {
  const found = graphicLook(graphic);
  if (!found?.look || !WORD_SCENES.includes(found.source.template)) return null;
  const raw = withGraphicLook(graphic, { ...found.look, dim: 0, dimAuto: undefined, darkened: undefined });
  const theme = found.source.theme, colours = [found.look.type.colour, found.look.type.accent ?? (isHex(theme.accent) ? theme.accent : "#5b8cff")];
  const key = JSON.stringify([raw.html, raw.css, raw.js, raw.frames, frame.width, frame.height]);
  const known = measured.get(key);
  if (known) return known;
  const size = measureSize(frame), at = raw.motion?.elements.map(e => e.at) ?? [0];
  const times = [...new Set([Math.min(raw.durationS - 0.04, (at[0] ?? 0) + 0.1), Math.max(0, raw.durationS - 1 / 30)].map(r3))];
  const { renderGraphicBitmaps } = await import("./render");
  const bg = await renderGraphicBitmaps({ ...raw, css: raw.css + HIDE_WORDS }, times, size, root);
  const words = await renderGraphicBitmaps({ ...raw, css: raw.css + HIDE_BACKGROUND }, times, size, root);
  const ring = colours.map(colour => ({ colour, pixels: [] as number[][] }));
  let bright = 0;
  times.forEach((_, i) => {
    const on = wordsOn(bg.bitmaps[i], words.bitmaps[i], size, colours);
    on.ring.forEach((r, j) => ring[j].pixels.push(...r.pixels));
    bright = Math.max(bright, on.bright);
  });
  const result = autoDim(ring, bright);
  measured.set(key, result);
  while (measured.size > 64) measured.delete(measured.keys().next().value!);
  return result;
}

/** LOOK1: the designed background's render-cost check. Drawn at the edit's size, its frames are timed against the same
 *  scene on plain black; over the budget, one frame of it (the middle) is drawn once into a picture in the shoot's
 *  cache and the scene shows that instead (bg.raster). */
async function designCost(root: string, graphic: MotionGraphic, frame: Size): Promise<{ extraMs: number; raster?: string }> {
  const found = graphicLook(graphic);
  if (!found?.look || found.look.bg.kind !== "design" || found.look.bg.raster) return { extraMs: 0 };
  const size = { width: Math.min(frame.width, 1080), height: Math.round(frame.height * Math.min(frame.width, 1080) / frame.width / 2) * 2 };
  const times = [0.1, 0.35, 0.6, 0.85].map(k => r3(graphic.durationS * k));
  const { renderGraphicBitmaps } = await import("./render");
  const plain = withGraphicLook(graphic, { ...found.look, bg: { kind: "colour", value: "#0a0a0b" } });
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const base = median((await renderGraphicBitmaps(plain, times, size, root)).ms);
  const drawn = await renderGraphicBitmaps({ ...graphic, css: graphic.css + HIDE_WORDS }, times, size, root);
  // over budget: it adds more than the budget a frame AND at least doubles the scene's own draw time (a busy Mac slows
  // both, so the ratio keeps a light design live when everything is slow)
  const extraMs = Math.max(0, median(drawn.ms) - base);
  if (extraMs <= Math.max(LOOK_DESIGN_BUDGET_MS, base)) return { extraMs };
  const still = (await renderGraphicBitmaps({ ...withGraphicLook(graphic, { ...found.look, dim: 0, dimAuto: undefined, finish: { ...found.look.finish, grain: 0, vignette: 0, push: 0 } }), css: graphic.css + HIDE_WORDS },
    [r3(graphic.durationS / 2)], { width: frame.width, height: frame.height }, root)).bitmaps[0];
  const { framePng } = await import("../capture-frame");
  const png = await framePng(still, frame.width, frame.height);
  const raster = await (await import("./card")).saveCardPicture(root, await encodeWebp(png, "image/png", Math.max(frame.width, frame.height)));
  return { extraMs, raster };
}

// ---- a scene's look, made real for where it sits

export interface LookPlace { s: number; e: number }
export interface Resolved { graphic: MotionGraphic; look: Look; notes: string[] }
/** The look with its pictures (the shot under the scene, a library frame, a dropped file) and its dim, and the scene
 *  rebuilt with it. Nothing is saved. */
export async function resolveLook(root: string, record: StoredVersion, graphic: MotionGraphic, place: LookPlace, input: Look, options: { file?: string } = {}): Promise<Resolved> {
  let look = clampLook(input);
  const notes: string[] = [], frame = { width: record.assembly.template.width, height: record.assembly.template.height };
  const bg = look.bg;
  if (bg.kind === "shot") {
    const shot = shotAt(record, place.s);
    if (shot && (!bg.media || bg.clip !== shot.clip || Math.abs((bg.atS ?? -1) - shot.atS) > 0.05)) {
      const media = await cacheClipFrame(root, record, shot.clip, shot.atS);
      look = clampLook({ ...look, bg: { ...bg, media, clip: shot.clip, atS: shot.atS }, palette: await paletteOfMedia(root, media) });
    } else if (!shot && !bg.media) notes.push(LOOK_NOTES.noPicture);
  } else if (bg.kind === "image") {
    if (options.file) {
      const media = await cacheFile(root, options.file), face = await faceOnPicture(path.join(root, ".sidething", "overlays", media));
      look = clampLook({ ...look, bg: { kind: "image", blur: bg.blur, media, name: path.basename(options.file), ...(face ? { face } : {}) }, palette: await paletteOfMedia(root, media) });
    } else if (bg.clip !== undefined && bg.atS !== undefined && !bg.media) {
      const clip = record.assembly.shoot.clips.find(c => c.id === bg.clip);
      if (!clip) throw new Error(`There is no clip called “${bg.clip}” in this shoot.`);
      const media = await cacheClipFrame(root, record, bg.clip, bg.atS);
      const face = await faceOnPicture(path.join(root, ".sidething", "overlays", media)) ?? faceIn(record, bg.clip, bg.atS);
      look = clampLook({ ...look, bg: { kind: "image", blur: bg.blur, media, clip: bg.clip, atS: bg.atS, name: bg.name ?? `${bg.clip} at ${bg.atS.toFixed(1)} s`, ...(face ? { face } : {}) }, palette: await paletteOfMedia(root, media) });
    } else if (!bg.media) notes.push(LOOK_NOTES.noPicture);
  }
  // a picture that is no longer in this shoot's cache falls back to black, said
  const media = look.bg.kind === "shot" || look.bg.kind === "image" ? look.bg.media : undefined;
  if (media && !await fs.stat(path.join(root, ".sidething", "overlays", media)).then(s => s.isFile() && s.size > 0, () => false)) throw new Error("That background picture isn't in this shoot any more. Pick it again.");
  let built = withGraphicLook(graphic, look);
  if (look.bg.kind === "design") {
    if (!look.bg.html.trim() && !look.bg.css.trim()) throw new Error("A designed background needs its html or css. Ask Claude to design one.");
    const { sanitizeGraphic } = await import("./sanitize");
    sanitizeGraphic(built);   // the design's html and css pass the same checks as any graphic, before it is timed
    const cost = await designCost(root, built, frame);
    if (cost.raster) {
      look = clampLook({ ...look, bg: { ...look.bg, raster: cost.raster } });
      built = withGraphicLook(graphic, look);
      notes.push(`The design took ${Math.round(cost.extraMs)} ms a frame to draw, so it is kept as a still picture that moves with the scene.`);
    }
  }
  if (look.dim === "auto") {
    const m = await measureDim(root, built, frame);
    const dimAuto = m ? m.dim : FRAMES_DIM, darkened = !!m?.darkened && look.bg.kind !== "colour";
    look = clampLook({ ...look, dimAuto, darkened });
    built = withGraphicLook(graphic, look);
    if (m?.darkened) notes.push(LOOK_NOTES.darkened);
    if (m && m.worst < LOOK_CONTRAST && m.dim < 0.9 && !m.darkened && m.worst < 99) notes.push(LOOK_NOTES.darkWords);
  }
  return { graphic: built, look, notes };
}

/** The edit's look for a new scene (SCN1b add_scene, SCN2 Produce): the one its scenes share (or the newest scene's)
 *  when any has one, else LOOK_NEW, from the shot. */
export function editLook(record: StoredVersion): Look {
  const looks = (record.overlays ?? []).filter(o => o.graphic?.look && graphicLook(o.graphic)).map(o => clampLook(o.graphic!.look));
  if (!looks.length) return LOOK_NEW;
  const shared = looks.every(l => sameLookAcrossScenes(l, looks[0])) ? looks[0] : looks.at(-1)!;
  return clampLook({ ...shared, bg: shared.bg.kind === "shot" ? { kind: "shot", blur: shared.bg.blur } : shared.bg, dimAuto: undefined, darkened: undefined, palette: undefined });
}
/** A new scene's graphic dressed in the edit's look (its own shot under it). */
export async function lookForNewScene(root: string, record: StoredVersion, graphic: MotionGraphic, place: LookPlace, asked?: unknown): Promise<Resolved> {
  const base = editLook(record), look = asked && typeof asked === "object" ? changeLook(base, asked as LookChange).look : base;
  return resolveLook(root, record, graphic, place, look);
}

// ---- the one change: the inspector's Look section, Ask and the MCP

const brandOf = (record: StoredVersion) => [record.titles?.captionStyle?.accent, record.titles?.captionStyle?.primary].filter(isHex);
export interface LookUpdate { edit: CutEdit | null; changed: string[]; notes: string[]; look: Look | null; items: string[] }
/** Apply a change to one scene's look, or (all) make every scene in the edit look like it. Returns the edit to save. */
export async function lookUpdate(root: string, record: StoredVersion, input: { itemId: string; all?: boolean; change?: LookChange; file?: string }): Promise<LookUpdate> {
  const item = record.overlays?.find(o => o.id === input.itemId);
  if (!item?.graphic) throw new Error("That scene is not in this version.");
  const found = graphicLook(item.graphic);
  if (!found) throw new Error(NO_LOOK);
  const change: LookChange = { ...input.change ?? {}, ...(input.change?.bg ? { bg: { ...input.change.bg } } : {}) };
  if (change.type?.font && !(LOOK_FONTS as readonly string[]).includes(change.type.font)) throw new Error(`Choose a bundled font: ${LOOK_FONTS.join(", ")}.`);
  if (change.bg?.kind && !LOOK_KINDS.includes(change.bg.kind)) throw new Error(`Choose a background: ${LOOK_KINDS.join(", ")}.`);
  if (change.bg?.kind === "design" && typeof change.bg.html === "string" && change.bg.html.length > LOOK_LIMITS.designHtml) throw new Error(`Keep a design's html under ${LOOK_LIMITS.designHtml / 1000} KB.`);
  if (change.bg?.kind === "design" && typeof change.bg.css === "string" && change.bg.css.length > LOOK_LIMITS.designCss) throw new Error(`Keep a design's css under ${LOOK_LIMITS.designCss / 1000} KB.`);
  // a library frame named by its file (the Look section's strip) is its clip and time
  if (typeof change.bg?.frame === "string") {
    const at = libraryFrame(record, change.bg.frame);
    if (!at) throw new Error("That frame isn't in this shoot's library.");
    const { frame: _f, ...rest } = change.bg;
    change.bg = { ...rest, kind: "image", ...at, name: undefined };
  }
  // a new picture (a library frame or a dropped file) is made again, never the last one's
  const asked: LookChange = change.bg && (change.bg.clip !== undefined || input.file) ? { ...change, bg: { ...change.bg, media: undefined, face: undefined } } : change;
  const { look: next, changed } = changeLook(found.look, asked, brandOf(record));
  const first = await resolveLook(root, record, item.graphic, item, next, { file: input.file });
  const notes = [...first.notes], edits: CutEdit[] = [];
  const same = (g: MotionGraphic, h: MotionGraphic) => g.html === h.html && g.css === h.css && g.js === h.js && JSON.stringify(g.frames ?? []) === JSON.stringify(h.frames ?? []) && JSON.stringify(g.look ?? null) === JSON.stringify(h.look ?? null);
  if (!same(item.graphic, first.graphic)) edits.push({ kind: "overlay", op: "update", id: item.id, patch: { graphic: first.graphic } });
  const items = [item.id];
  if (input.all) {
    for (const other of record.overlays ?? []) {
      if (other.id === item.id || !other.graphic || !graphicLook(other.graphic)) continue;
      const theirs = clampLook({ ...first.look, bg: first.look.bg.kind === "shot" ? { kind: "shot", blur: first.look.bg.blur } : first.look.bg, dimAuto: undefined, darkened: undefined, palette: first.look.bg.kind === "shot" ? undefined : first.look.palette });
      const made = await resolveLook(root, record, other.graphic, other, theirs);
      notes.push(...made.notes.filter(n => !notes.includes(n)));
      if (!same(other.graphic, made.graphic)) edits.push({ kind: "overlay", op: "update", id: other.id, patch: { graphic: made.graphic } });
      items.push(other.id);
    }
    if (items.length > 1) changed.push(`the same look on all ${items.length} scenes`);
  }
  const edit: CutEdit | null = !edits.length ? null : edits.length === 1 ? edits[0] : { kind: "batch", edits, label: "Same look on every scene" };
  return { edit, changed: edits.length ? changed.length ? changed : ["the look"] : [], notes, look: first.look, items };
}

/** What get_scene_look answers: the look in the same names and units as set_scene_look and the Look section. */
export function describeLook(item: OverlayItem, record: StoredVersion) {
  const found = graphicLook(item.graphic!)!, look = found.look;
  const others = (record.overlays ?? []).filter(o => o.id !== item.id && o.graphic && graphicLook(o.graphic)).length;
  return {
    itemId: item.id, template: found.source.template, scene: { s: r3(item.s), e: r3(item.e) },
    look: look ?? { bg: { kind: "colour", value: "#0a0a0b" }, dim: 0, type: { ...LOOK_NEW.type }, finish: { grain: 0, vignette: 0, push: 0 } },
    onBlack: !look, dimNow: look ? lookDim(look) : 0, darkened: !!look?.darkened, ...(look?.darkened ? { darkenedNote: LOOK_NOTES.darkened } : {}),
    otherScenes: others,
    options: { bg: LOOK_KINDS, fonts: LOOK_FONTS, gradientTypes: ["linear", "radial", "mesh"], cases: ["lower", "as said", "upper"], brandColours: brandOf(record), shotColours: look?.palette ?? [] },
    units: "blur 0 to 100; dim 0 to 0.9 or \"auto\" (kept at 4.5:1 for the words); weight 400 to 900; scale 0.6 to 1.6 (times the scene's size); grain and vignette 0 to 1; push 0 to 10 (per cent the background grows); angle in degrees; colours #rrggbb.",
    howTo: "set_scene_look with itemId and only what changes: bg {kind, ...that kind's values}, dim, type {font, weight, case, colour, accent, scale}, finish {grain, vignette, push}; shuffle true for a new gradient from the shot's and the brand's colours; all true puts the result on every scene. An image is bg {kind: \"image\", clip, atS} (a frame of his footage) or file (a picture on this Mac). A design is bg {kind: \"design\", name, html, css}: html and css only (no script), classes starting lk-, sized in % or var(--u); CSS animations are driven by the scene's time.",
  };
}

/** MCP and Ask: get_scene_look and set_scene_look (one undoable version; nothing changed, no version). */
export async function lookEdit(root: string, cutId: string, versionNumber: number, name: "get_scene_look" | "set_scene_look", input: Record<string, unknown>) {
  const { loadDraftVersion, editCut } = await import("../sidekick");
  const record = await loadDraftVersion(root, cutId, versionNumber);
  const item = record.overlays?.find(o => o.id === input.itemId);
  if (!item?.graphic) throw new Error("That scene is not in this version.");
  if (!graphicLook(item.graphic)) throw new Error(NO_LOOK);
  if (name === "get_scene_look") return describeLook(item, record);
  const change: LookChange = {};
  for (const k of ["bg", "dim", "type", "finish", "shuffle"] as const) if (input[k] !== undefined) (change as Record<string, unknown>)[k] = input[k];
  const result = await lookUpdate(root, record, { itemId: item.id, all: input.all === true, change, file: typeof input.file === "string" ? input.file : undefined });
  if (!result.edit) return { version: versionNumber, changed: [], notes: result.notes, note: "Nothing changed, so there is no new version." };
  const saved = await editCut(root, cutId, versionNumber, result.edit);
  const after = (await loadDraftVersion(root, cutId, saved.version)).overlays?.find(o => o.id === item.id);
  return { ...saved, changed: result.changed, notes: result.notes, scenes: result.items, look: after ? describeLook(after, record).look : result.look };
}
