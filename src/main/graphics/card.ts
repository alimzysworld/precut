// PRO4 (docs/plans/produced/spike-v1.md, user story 5): a card for something on a screen. He talks about an app, a site
// or a number; his shoot has the real thing (a screen recording, a screenshot, a photo). A card is that picture as a
// motion piece: it tilts in and settles flat, holds, pushes slowly towards the part he names, and can carry one stamp in
// his own words. It is an ordinary graphic overlay (templates.ts "screen-card"), so it plays, scrubs and exports like
// any graphic, and a Produce pass can own it like any other move.
// The fixed steps here, all on this Mac and with no model call: the picture (sips for photos, one ffmpeg frame for a
// recording), upright and cropped in a hidden page, the words on it read by Vision (only when asked to find a part by a
// word), and the stamp checked against what he says. Judgement (which picture, which part, which words) is the
// caller's: Ask, the MCP caller or the director.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Clip, CutEdit, MotionGraphic, OverlayItem } from "../../shared/schema";
import { timedCaptionWords } from "../../shared/caption-words";
import { isScreenClip } from "../../shared/screen";
import { buildFromTemplate, cardBox, cardStamp, CARD_MOTION, CARD_TEMPLATE } from "./templates";
import { graphicTheme } from "./edit";
import type { StoredVersion } from "../sidekick";

const run = promisify(execFile);
export type Box = [number, number, number, number];
export interface CardRequest {
  clip: string;                                   // a clip of the shoot: a photo or screenshot (its original picture), or a recording
  atS?: number | null;                            // a recording: the frame, in source seconds
  span?: [number, number] | null;                 // a recording: a span in source seconds; the frame where `find` is on screen, or its middle
  region?: number[] | null;                       // x, y, w, h as fractions of the picture: the part to push towards
  find?: string | null;                           // or a word or phrase on the picture: precut finds it with on-device text recognition
  crop?: number[] | null;                         // the part of the picture the card shows (default: all of it)
  stamp?: string | null;                          // one short label or the key number, in words he says in this edit
  stampAtS?: number | null;                       // reel seconds the stamp lands (default: where he says it, inside the card)
  s: number; e: number;                           // reel seconds
  exit?: "ease" | "cut" | null;                   // default: cut when e is on a cut, else ease
  x?: number; y?: number; w?: number;
}
export interface CardMade {
  graphic: MotionGraphic; place: { x: number; y: number; w: number }; s: number; e: number;
  info: { clip: string; picture: "photo" | "frame"; atS: number | null; px: [number, number]; region: Box | null; found: string | null;
    stamp: string | null; stampAtS: number | null; exit: "ease" | "cut"; media: string; shown: [number, number]; bytes: number };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
/** Spoken and written words compared the same way: case, punctuation and digit grouping don't matter. */
export const normWord = (t: string) => t.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}']/gu, "").replace(/^'+|'+$/g, "");

// ---- The stamp: his words only, and never the words the caption is showing while the stamp is up.
// cueId (timedCaptionWords) says which caption line a word is shown in; words without one are not checked for repeats.
type Word = { text: string; s: number; e: number; cueId?: string };
/** Seconds into the card the stamp lands: as he says it, but never before the card has settled (0.25 s) or in its last
 * 0.3 s; else at the time asked for inside the card; else a little after the card arrives. */
function stampLand(hit: { atS: number; inside: boolean }, s: number, e: number, requestedS?: number | null): number {
  const d = e - s;
  return hit.inside && hit.atS - s <= d - 0.3 ? clamp(hit.atS - s, 0.25, d - 0.3)
    : typeof requestedS === "number" && requestedS >= s && requestedS < e ? requestedS - s : Math.min(d * 0.45, 1.1);
}
/** PRO4b: the caption on screen while the stamp is up (fromS to toS) when it already shows the stamp's words (in order,
 * across caption lines too), or null. A caption line is on screen from its first word to its last. */
export function captionRepeat(words: Word[], stamp: string, fromS: number, toS: number): string | null {
  const want = cardStamp(stamp).split(/\s+/).map(normWord).filter(Boolean);
  if (!want.length) return null;
  const spans = new Map<string, { s: number; e: number; words: string[] }>();
  for (const w of words) if (w.cueId) { const l = spans.get(w.cueId); if (l) { l.s = Math.min(l.s, w.s); l.e = Math.max(l.e, w.e); l.words.push(w.text); } else spans.set(w.cueId, { s: w.s, e: w.e, words: [w.text] }); }
  const said = words.map(w => normWord(w.text));
  for (let i = 0; i + want.length <= said.length; i++) {
    if (!want.every((t, j) => said[i + j] === t)) continue;
    const lines = [...new Set(words.slice(i, i + want.length).map(w => w.cueId))];
    if (lines.some(id => !id)) continue;
    const shown = lines.map(id => spans.get(id!)!);
    if (Math.min(...shown.map(l => l.s)) < toS && Math.max(...shown.map(l => l.e)) > fromS) return shown.flatMap(l => l.words).join(" ").replace(/\s+/g, " ").trim();
  }
  return null;
}
/** PRO4c: the one refusal a card can survive. A stamp that repeats the caption on screen with it is noise on an otherwise
 * right card, so the director's card lands without it; an explicit request (add_card, produce_apply) is still refused. */
export class StampRepeatsCaption extends Error {
  constructor(readonly stamp: string, readonly shown: string) {
    super(`The stamp “${stamp}” repeats the caption on screen with it (“${shown.length > 60 ? `${shown.slice(0, 59)}…` : shown}”). Leave the stamp out, or use a short label the person says elsewhere in this edit.`);
    this.name = "StampRepeatsCaption";
  }
}
/** Where the stamp's words are said in the edit, nearest the card, and when it lands; refuses words he never says, and
 * words the caption is showing while the stamp is up (the same words twice on screen is noise). landS: where it really
 * lands (a card already made); requestedS: the time asked for. */
export function stampInWords(words: Word[], stamp: string, s: number, e: number, options: { landS?: number | null; requestedS?: number | null } = {}): { text: string; atS: number; inside: boolean; landS: number } {
  const text = cardStamp(stamp), want = text.split(/\s+/).map(normWord).filter(Boolean);
  if (!text || !want.length) throw new Error("The stamp is empty. Leave it out, or give a short label or the key number in words you say.");
  if (stamp.trim().split(/\s+/).length > CARD_MOTION.stampWords || stamp.trim().length > CARD_MOTION.stampChars)
    throw new Error(`A stamp is one short label or the key number: at most ${CARD_MOTION.stampWords} words, ${CARD_MOTION.stampChars} characters.`);
  const spoken = words.map(w => normWord(w.text));
  const hits: number[] = [];
  for (let i = 0; i + want.length <= spoken.length; i++) if (want.every((t, j) => spoken[i + j] === t)) hits.push(i);
  if (!hits.length) throw new Error(`The stamp “${text}” isn't something said in this edit. A stamp uses the person's own words: a short label or the key number they say.`);
  const near = hits.map(i => ({ i, atS: words[i].s, inside: words[i].s >= s && words[i].s < e })).sort((a, b) => Number(b.inside) - Number(a.inside) || Math.abs(a.atS - s) - Math.abs(b.atS - s))[0];
  const landS = r3(typeof options.landS === "number" && Number.isFinite(options.landS) ? options.landS : s + stampLand(near, s, e, options.requestedS));
  const shown = captionRepeat(words, text, landS, e);
  if (shown) throw new StampRepeatsCaption(text, shown);
  return { text, atS: r3(near.atS), inside: near.inside, landS };
}

// ---- The picture.
function insideRoot(root: string, relative: string): string {
  const file = path.resolve(root, relative), base = path.resolve(root);
  if (!file.startsWith(base + path.sep)) throw new Error("That picture isn't inside this shoot.");
  return file;
}
async function exists(file: string) { return fs.stat(file).then(s => s.isFile() && s.size > 0, () => false); }
async function toolPath(name: string) { const { tool } = await import("../tools"); return tool(name); }

/** The source picture as a JPEG on disk (orientation still in its tags; the page draws it upright). */
async function sourcePicture(root: string, clip: Clip, request: CardRequest, work: string): Promise<{ file: string; picture: "photo" | "frame"; atS: number | null }> {
  const out = path.join(work, "source.jpg");
  const original = clip.photo?.file ? insideRoot(root, clip.photo.file) : null;
  if (original && await exists(original)) {
    // PRO4b: full resolution (the card's picture is a file in the shoot cache, not inline); the page caps the side.
    await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "95", original, "--out", out], { timeout: 60_000 });
    return { file: out, picture: "photo", atS: null };
  }
  const video = insideRoot(root, clip.file);
  if (!await exists(video)) throw new Error(`The footage for that picture isn't on this Mac (${path.basename(clip.file)}).`);
  const length = clip.meta?.durationS ?? 0;
  let at: number;
  if (clip.photo) at = Math.min(0.5, length / 2);   // a photo whose original is gone: its still clip
  else if (typeof request.atS === "number") at = request.atS;
  else if (request.span) {
    const [a, b] = request.span, want = request.find ? normWord(request.find) : "";
    const seg = want ? (clip.screen?.segments ?? []).find(g => g.e > a && g.s < b && g.text.split(/\s+/).some(t => normWord(t).includes(want))) : undefined;
    at = seg ? (Math.max(a, seg.s) + Math.min(b, seg.e)) / 2 : (a + b) / 2;
  } else {
    const usable = clip.judgement?.usableSpans?.[0];
    at = usable ? (usable[0] + usable[1]) / 2 : length / 2;
  }
  if (!(at >= 0) || length && at > length) throw new Error(`That clip is ${length.toFixed(1)} s long. Choose a frame inside it.`);
  await run(await toolPath("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", at.toFixed(3), "-i", video, "-frames:v", "1",
    "-vf", `scale='min(iw,${CARD_MOTION.pictureSide}*iw/max(iw,ih))':-2`, "-q:v", "1", "-qmin", "1", out], { timeout: 60_000 });
  if (!await exists(out)) throw new Error("Couldn't read a frame from that clip.");
  return { file: out, picture: "frame", atS: r3(at) };
}

/** One hidden page (never shown, never focused) to draw the picture upright, crop it and encode it. */
export async function withPage<T>(work: (js: <R>(code: string) => Promise<R>) => Promise<T>): Promise<T> {
  const { app, BrowserWindow } = await import("electron");
  await app.whenReady();
  // Painting stays on while hidden: without it Chromium never decodes the picture.
  const window = new BrowserWindow({ show: false, width: 64, height: 64, focusable: false, skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false } });
  try {
    await window.loadURL("about:blank");
    const js = <R>(code: string) => Promise.race([window.webContents.executeJavaScript(code) as Promise<R>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Preparing the card's picture took too long.")), 60_000))]);
    return await work(js);
  } finally { if (!window.isDestroyed()) window.destroy(); }
}

// Vision through the system's JavaScript bridge: on-device text recognition with a box per word, no compiler, no network.
const OCR = `ObjC.import('Foundation'); ObjC.import('Vision');
function run(argv) {
  var req = $.VNRecognizeTextRequest.alloc.init; req.recognitionLevel = 0; req.usesLanguageCorrection = true;
  var handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(argv[0]), $({}));
  handler.performRequestsError($([req]), null);
  var out = [], results = req.results;
  for (var i = 0; i < results.count; i++) {
    var c = results.objectAtIndex(i).topCandidates(1).objectAtIndex(0), text = c.string.js, b = results.objectAtIndex(i).boundingBox, words = [], re = /\\S+/g, m;
    while ((m = re.exec(text))) { var r = c.boundingBoxForRangeError($.NSMakeRange(m.index, m[0].length), null); if (r && !r.isNil()) { var q = r.boundingBox; words.push([m[0], q.origin.x, q.origin.y, q.size.width, q.size.height]); } }
    out.push({ text: text, box: [b.origin.x, b.origin.y, b.size.width, b.size.height], words: words });
  }
  return JSON.stringify(out);
}`;
export type OcrLine = { text: string; box: Box; words: [string, number, number, number, number][] };
/** Words on an upright picture, boxes as fractions from its top left. */
export async function readPicture(file: string): Promise<OcrLine[]> {
  const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", OCR, file], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  const flip = ([x, y, w, h]: number[]): Box => [x, 1 - y - h, w, h].map(n => Math.round(n * 10000) / 10000) as Box;
  return (JSON.parse(stdout.trim() || "[]") as { text: string; box: number[]; words: (string | number)[][] }[])
    .map(l => ({ text: l.text, box: flip(l.box), words: l.words.map(w => [String(w[0]), ...flip(w.slice(1) as number[])] as OcrLine["words"][number]) }));
}
/** The most prominent place the phrase is written: whole words first, then inside a line. Padded a little. */
export function findOnPicture(lines: OcrLine[], phrase: string): { box: Box; text: string } | null {
  const want = phrase.split(/\s+/).map(normWord).filter(Boolean);
  if (!want.length) return null;
  const union = (boxes: Box[]): Box => { const x = Math.min(...boxes.map(b => b[0])), y = Math.min(...boxes.map(b => b[1])); return [x, y, Math.max(...boxes.map(b => b[0] + b[2])) - x, Math.max(...boxes.map(b => b[1] + b[3])) - y]; };
  const found: { box: Box; text: string }[] = [];
  for (const line of lines) {
    const ws = line.words.map(w => ({ t: normWord(w[0]), text: w[0], b: w.slice(1) as Box }));
    for (let i = 0; i + want.length <= ws.length; i++)
      if (want.every((t, j) => ws[i + j].t === t)) found.push({ box: union(ws.slice(i, i + want.length).map(w => w.b)), text: ws.slice(i, i + want.length).map(w => w.text).join(" ") });
  }
  if (!found.length) for (const line of lines) if (line.text.split(/\s+/).map(normWord).join(" ").includes(want.join(" "))) found.push({ box: line.box, text: line.text });
  if (!found.length) return null;
  const best = found.sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0], pad = Math.max(0.01, best.box[3] * 0.6);
  const x = clamp(best.box[0] - pad, 0, 1), y = clamp(best.box[1] - pad, 0, 1);
  return { box: [x, y, clamp(best.box[0] + best.box[2] + pad, 0, 1) - x, clamp(best.box[1] + best.box[3] + pad, 0, 1) - y].map(n => Math.round(n * 10000) / 10000) as Box, text: best.text };
}

/** PRO4b: a card's picture in the shoot's own cache, named by its bytes (graphics/sanitize.ts CARD_MEDIA). */
export async function saveCardPicture(root: string, bytes: Buffer): Promise<string> {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") throw new Error("Couldn't prepare that picture for a card.");
  const media = `card-${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.webp`;
  const destination = path.join(root, ".sidething", "overlays", media);
  if (await fs.stat(destination).then(st => st.isFile() && st.size === bytes.length, () => false)) return media;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, bytes); await fs.rename(temporary, destination); } finally { await fs.rm(temporary, { force: true }); }
  return media;
}

// ---- The card.
const exitOn = (joins: number[], e: number, fps: number) => joins.find(t => Math.abs(t - e) <= 2 / fps + 1e-6);
/** Everything a card needs, checked and drawn; nothing saved. Throws plain words. */
export async function prepareCard(root: string, record: StoredVersion, request: CardRequest): Promise<CardMade> {
  const clips = record.assembly.shoot.clips, clip = clips.find(c => c.id === request.clip);
  if (!clip) throw new Error(`There is no clip “${String(request.clip).slice(0, 60)}” in this shoot.`);
  const fps = record.assembly.template.fps, lengthS = record.lengthS ?? 0;
  if (!(Number.isFinite(request.s) && Number.isFinite(request.e) && request.s >= 0 && request.e > request.s)) throw new Error("Give the card a start and an end in edit seconds (e after s).");
  if (request.s >= lengthS) throw new Error(`The edit is ${lengthS.toFixed(1)} seconds long. Choose a time inside it.`);
  const { planFx } = await import("../edits-fx");
  const joins = planFx(record.assembly.cutList, fps, record).joins.map(j => j.atS);
  let s = r3(request.s), e = r3(Math.min(request.e, lengthS));
  const onCut = exitOn(joins, e, fps);
  const exit = request.exit === "cut" || request.exit === "ease" ? request.exit : onCut !== undefined ? "cut" : "ease";
  if (exit === "cut" && onCut !== undefined) e = r3(onCut);
  if (e - s < 1 || e - s > 12) throw new Error("A card is on screen for 1 to 12 seconds.");
  const words = timedCaptionWords(record.titles);
  const stamp = request.stamp?.trim() ? stampInWords(words, request.stamp, s, e, { requestedS: request.stampAtS }) : null;
  const crop = request.crop ? cardBox(request.crop) : [0, 0, 1, 1] as Box;
  if (!crop) throw new Error("Give crop as x, y, w, h fractions of the picture.");
  if (request.region && !cardBox(request.region)) throw new Error("Give region as x, y, w, h fractions of the picture.");

  const work = await fs.mkdtemp(path.join(os.tmpdir(), "precut-card-"));
  try {
    const source = await sourcePicture(root, clip, request, work);
    const bytes = await fs.readFile(source.file);
    return await withPage(async js => {
      const size = await js<[number, number]>(`(async () => { const img = new Image(); img.src = ${JSON.stringify(`data:image/jpeg;base64,${bytes.toString("base64")}`)}; await img.decode(); window.__card = img; return [img.naturalWidth, img.naturalHeight]; })()`);
      let region = request.region ? cardBox(request.region) : null, found: string | null = null;
      if (!region && request.find?.trim()) {
        const upright = await js<string>(`(() => { const img = window.__card, c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); return c.toDataURL('image/jpeg', 0.92); })()`);
        const file = path.join(work, "upright.jpg");
        await fs.writeFile(file, Buffer.from(upright.slice(upright.indexOf(",") + 1), "base64"));
        const hit = findOnPicture(await readPicture(file), request.find);
        if (!hit) throw new Error(`Couldn't find “${request.find.trim().slice(0, 60)}” written on that picture. Give the region as x, y, w, h fractions instead.`);
        region = hit.box; found = hit.text;
      }
      // The region as fractions of what the card shows (the crop).
      let inCard: Box | null = null;
      if (region) {
        const [cx, cy, cw, ch] = crop, x0 = clamp((region[0] - cx) / cw, 0, 1), y0 = clamp((region[1] - cy) / ch, 0, 1);
        const x1 = clamp((region[0] + region[2] - cx) / cw, 0, 1), y1 = clamp((region[1] + region[3] - cy) / ch, 0, 1);
        if (x1 - x0 < 0.005 || y1 - y0 < 0.005) throw new Error("That part of the picture is outside the crop.");
        inCard = cardBox([x0, y0, x1 - x0, y1 - y0]);
      }
      // PRO4b: the part the card shows at full resolution (up to pictureSide), saved once in the shoot's own cache under
      // a name made from its bytes. The card names that file; the title page draws it in, so small screen text stays sharp.
      const encoded = await js<{ url: string; w: number; h: number } | null>(`(() => {
        const img = window.__card, W = img.naturalWidth, H = img.naturalHeight, crop = ${JSON.stringify(crop)}, side = ${CARD_MOTION.pictureSide};
        const sx = crop[0] * W, sy = crop[1] * H, sw = Math.max(8, crop[2] * W), sh = Math.max(8, crop[3] * H), c = document.createElement('canvas'), g = c.getContext('2d');
        const k = Math.min(1, side / Math.max(sw, sh)); c.width = Math.max(8, Math.round(sw * k)); c.height = Math.max(8, Math.round(sh * k));
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
        const url = c.toDataURL('image/webp', 0.94);
        return url.startsWith('data:image/webp;base64,') ? { url, w: c.width, h: c.height } : null; })()`);
      if (!encoded) throw new Error("Couldn't prepare that picture for a card.");
      const picture = Buffer.from(encoded.url.slice(encoded.url.indexOf(",") + 1), "base64");
      const media = await saveCardPicture(root, picture);
      const durationS = r3(e - s), theme = graphicTheme(record.titles);
      const stampAt = stamp ? r3(stamp.landS - s) : null;
      const graphic = buildFromTemplate(CARD_TEMPLATE, { media, px: [encoded.w, encoded.h], region: inCard, stamp: stamp?.text ?? "", ...(stampAt !== null ? { stampAtS: r3(stampAt) } : {}), exit },
        theme, { durationS, ...(stamp?.inside ? { words: [{ text: stamp.text, atS: stamp.atS }] } : {}) });   // it stays on his words when the cut changes
      // Placement: as large as reads, clear of the caption band, never wider than the frame allows.
      const frame = record.assembly.template, aspect = graphic.widthPx / graphic.heightPx;
      const w = typeof request.w === "number" ? clamp(request.w, 0.1, 1) : clamp(Math.min(0.8, 0.58 * frame.height * aspect / frame.width), 0.2, 0.8);
      return { graphic, s, e, place: { x: typeof request.x === "number" ? clamp(request.x, 0, 1) : 0.5, y: typeof request.y === "number" ? clamp(request.y, 0, 1) : 0.45, w },
        info: { clip: clip.id, picture: source.picture, atS: source.atS, px: [size[0], size[1]], region: inCard, found, stamp: stamp?.text ?? null,
          stampAtS: stampAt !== null ? r3(s + stampAt) : null, exit, media, shown: [encoded.w, encoded.h], bytes: picture.length } };
    });
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}

/** The overlay a card is: what add_card saves and a Produce move adds. */
export function cardOverlay(made: CardMade): Omit<OverlayItem, "id" | "file"> {
  return { graphic: made.graphic, s: made.s, e: made.e, ...made.place, corner: "square", enter: "none", exit: "none", sound: null };
}

/** MCP add_card: one undoable version. */
export async function addCard(root: string, cutId: string, version: number, input: Record<string, unknown>) {
  const { loadDraftVersion, editCut } = await import("../sidekick");
  const record = await loadDraftVersion(root, cutId, version);
  const media = (input.media ?? {}) as Record<string, unknown>;
  const request: CardRequest = { clip: String(media.clip ?? ""), atS: typeof media.atS === "number" ? media.atS : null,
    span: typeof media.s === "number" && typeof media.e === "number" ? [media.s, media.e] : null,
    region: Array.isArray(input.region) ? input.region as number[] : null, find: typeof input.find === "string" ? input.find : null,
    crop: Array.isArray(input.crop) ? input.crop as number[] : null, stamp: typeof input.stamp === "string" ? input.stamp : null,
    stampAtS: typeof input.stampAtS === "number" ? input.stampAtS : null, s: input.s as number, e: input.e as number,
    exit: input.exit === "cut" || input.exit === "ease" ? input.exit : null,
    ...(["x", "y", "w"] as const).reduce((o, k) => typeof input[k] === "number" ? { ...o, [k]: input[k] } : o, {}) };
  const made = await prepareCard(root, record, request);
  const result = await editCut(root, cutId, version, { kind: "overlay", op: "add", source: "", item: cardOverlay(made) } as CutEdit);
  const saved = (await loadDraftVersion(root, cutId, result.version)).overlays?.filter(o => o.graphic?.template === CARD_TEMPLATE).at(-1);
  return { ...result, id: saved?.id, card: { s: made.s, e: made.e, ...made.info },
    note: "Check it with look_at or preview_graphic. Change its time or place with update_graphic; take it out with remove_graphic or undo." };
}

// ---- What the director may show: pictures the shoot has whose content is known (what a screen says, what a photo shows).
export interface CardMedia { id: string; clip: string; kind: "screen recording" | "screenshot" | "photo"; shows: string | null; text: string | null; lengthS: number | null }
export async function cardMedia(root: string, record: StoredVersion, limit = 10): Promise<CardMedia[]> {
  const clips = record.assembly.shoot.clips, out: Omit<CardMedia, "id">[] = [];
  const say = (t: string | null | undefined, n = 300) => t ? t.replace(/\s+/g, " ").trim().slice(0, n) || null : null;
  for (const c of clips) if (!c.photo && isScreenClip(c)) out.push({ clip: c.id, kind: "screen recording", shows: say(c.screen?.segments?.map(g => g.line).filter(Boolean).join("; ") || c.judgement?.summary),
    text: say(c.screen?.segments?.map(g => g.text).join(" ")), lengthS: c.meta?.durationS ?? null });
  let read = 0;
  // A screenshot is a photo whose original is a PNG (what phones and Macs save); what it says is read on this Mac.
  const screenshot = (c: Clip) => !!c.photo && /\.png$/i.test(c.photo.file);
  for (const c of clips) if (screenshot(c) && read < 6) {
    let text: string | null = null;
    try {
      const work = await fs.mkdtemp(path.join(os.tmpdir(), "precut-card-"));
      try { const source = await sourcePicture(root, c, { clip: c.id, s: 0, e: 1 }, work); read++; text = say((await readPicture(source.file)).map(l => l.text).join(" · ")); }
      finally { await fs.rm(work, { recursive: true, force: true }); }
    } catch { text = null; }
    if (text || c.judgement?.summary) out.push({ clip: c.id, kind: "screenshot", shows: say(c.judgement?.summary), text, lengthS: null });
  }
  for (const c of clips) if (c.photo && !screenshot(c) && c.judgement?.summary) out.push({ clip: c.id, kind: "photo", shows: say(c.judgement.summary), text: null, lengthS: null });
  return out.slice(0, limit).map((m, i) => ({ id: `m${i + 1}`, ...m }));
}
