// AV1/AV1b: main side of the Apple player. Loads the in-process addon
// (build/tools/apple-player.node, from pipeline/apple-view.swift), which puts an
// AVPlayerLayer view inside precut's own window below the page, turns the open
// edit's DraftTimeline into files it can play, and forwards its clock back to the
// window that asked. Editing and mix rules stay in src/shared/apple-playback.ts
// and the live mix rules in src/shared/lane-levels.ts; nothing is decided twice. The last state,
// with the opening second and the per play hold histogram, is kept and saved so
// MCP can say which player is on and how smoothly it played.
import { app, BrowserWindow, type WebContents } from "electron";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { buildAppleManifest, appleManifestUrls, APPLE_BEEP_URL, APPLE_FILE_REASON, APPLE_UNAVAILABLE_REASON, type AppleLayerPlan, type AppleLookPayload, type AppleLookSegment, type AppleManifest, type AppleSegmentLook, type ApplePlaybackState, type AppleVoicePiece } from "../shared/apple-playback";
import type { DraftTimeline } from "../shared/schema";
import { liveGrade, liveLut } from "./grade";
import { lookParameters } from "../shared/grade-math";
import { normalizeBasic } from "./basics";
import { MIXER_HUES } from "./mixer";
import { APPLE_DETAIL_STEPS, appleShader } from "./apple-shader";

/** The first second of the last play: pictures shown of those due, and when sound started against the first picture. */
export interface AppleOpening {
  frames: number; expected: number; wallFrames?: number; fps: number; startS: number;
  firstPictureMs?: number; soundHeardMs?: number; soundOffsetMs?: number; silentHeadMs?: number; soundScheduledLeadMs?: number; lead?: number;
}
/** Every picture change of the last play, as holds between changes, bucketed by frame intervals. */
export interface AppleHolds {
  reason: string; frames: number; seconds: number; fromS: number; toS: number; maxHoldMs: number; maxHoldFrames: number;
  frameMs: number; vsyncMs: number; histogram: { upTo1: number; upTo2: number; over2: number }; skippedPictures: number;
}
export interface ApplePlaybackReport extends ApplePlaybackState {
  root?: string; cutId?: string; version?: number; timeS?: number; playing?: boolean;
  opening?: AppleOpening; holds?: AppleHolds; planMs?: number; planParts?: { filesMs?: number; lookMs?: number; restMs?: number; ipcMs?: number; writeMs?: number; loadMs?: number };
}

interface AppleAddon {
  onEvent(callback: (json: string) => void): void;
  attach(handle: Buffer): number;
  load(manifestPath: string, at: number, muted: boolean): void;
  play(at: number, rate: number): void;
  pause(): void;
  seek(at: number): void;
  setRect(x: number, y: number, w: number, h: number, frames: number): void;
  setVisible(visible: boolean): void;
  setMuted(muted: boolean): void;
  setLook?(lookJson: string): void;
  warm?(shaderJson: string): void;
  dispose(): void;
  capture(file: string, nominal: boolean): string;
  qaBelowDesktop(): number;
  state(): string;
  qaFrame?(file: string): string;
}

let lastState: ApplePlaybackReport = { player: "chrome", reason: "Apple player is off. Turn it on in Settings, Playback.", appleEnabled: false };
let addon: AppleAddon | null | undefined;
let ownerId: number | null = null;
let attachedWindow: number | null = null;
let viewerMuted = false;

function stateFile(): string { return path.join(app.getPath("userData"), "apple-playback.json"); }
export function recordAppleState(state: ApplePlaybackReport): ApplePlaybackReport {
  lastState = state;
  try { fs.mkdirSync(path.dirname(stateFile()), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(state)); } catch { /* the in memory copy still serves this process */ }
  return lastState;
}
export function getApplePlaybackState(): ApplePlaybackReport {
  if (lastState.cutId) return lastState;
  try { return { ...lastState, ...(JSON.parse(fs.readFileSync(stateFile(), "utf8")) as ApplePlaybackReport) }; } catch { return lastState; }
}

/** Where the addon lives: Resources/tools in the packaged app, build/tools in a checkout. */
export function appleAddonPath(resourcesPath: string | undefined = process.defaultApp ? undefined : process.resourcesPath): string {
  // A checkout runs from the app folder (build/tools beside out/); this module may be its own chunk, so not __dirname.
  return path.join(resourcesPath ? path.join(resourcesPath, "tools") : path.join(app.getAppPath(), "build/tools"), "apple-player.node");
}

/** The addon, loaded once. Null when it cannot load here (then the Chrome viewer plays, with a plain line). */
export function appleAddon(): AppleAddon | null {
  if (addon !== undefined) return addon;
  try {
    const loaded = { exports: {} as AppleAddon };
    process.dlopen(loaded as unknown as NodeJS.Module, appleAddonPath());
    loaded.exports.onEvent(json => { try { onEvent(JSON.parse(json) as Record<string, unknown>); } catch { /* keep the stream moving */ } });
    addon = loaded.exports;
  } catch (error) {
    console.warn("[apple-player] could not load", String(error).slice(0, 300));
    addon = null;
  }
  return addon;
}

/** AV3: when the page sent the plan now being swapped in (its epoch ms), so a swap's picture is timed from the page. */
let lastSentAt: number | null = null;
/** AV3 QA: the plan file last handed to the player (the helper renders its frames to check a swapped picture). */
let lastPlanPath: string | null = null;
/** AV3: where main's part of the newest plan went (page to main, files, Looks, the write), for its swap's timing. */
let lastPlanParts: Record<string, number | undefined> | null = null;
function onEvent(event: Record<string, unknown>): void {
  // The player reached a piece whose tables are still on their way: read it next.
  if (event.type === "needLook" && typeof event.start === "number") { currentFiller?.urgent.push(event.start); return; }
  if ((event.type === "swapAsked" || event.type === "swapShown" || event.type === "swapped") && lastSentAt !== null) {
    event = { ...event, sentAt: lastSentAt, ...(typeof event.epochMs === "number" ? { fromPageMs: Math.round((event.epochMs - lastSentAt) * 10) / 10 } : {}), ...(event.type === "swapAsked" && lastPlanParts ? { main: lastPlanParts } : {}) };
  }
  if (typeof event.time === "number") lastState = { ...lastState, timeS: event.time as number, playing: !!event.playing };
  if (event.type === "opening" || event.type === "holds") {
    const { type, ...rest } = event;
    recordAppleState({ ...lastState, [type === "opening" ? "opening" : "holds"]: rest as unknown as AppleOpening & AppleHolds });
  }
  if (event.type === "failed") recordAppleState({ ...lastState, player: "chrome", reason: typeof event.message === "string" && event.message.startsWith("Apple player is off") ? event.message : APPLE_UNAVAILABLE_REASON, playing: false });
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    if (ownerId !== null && win.webContents.id !== ownerId) continue;
    try { win.webContents.send("api:apple-event", event); } catch { /* window closed */ }
  }
}

/** A media URL that names a file directly under the shoot cache, or null. */
export function directAppleFile(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").slice(1).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
    if (parts[0] === "music" && parts[1]) return path.resolve(parts[1]);
    if (parts.length !== 3) return null;
    const [root, kind, file] = parts;
    if (!["proxies", "finish-cache", "precuts", "overlays"].includes(kind)) return null;
    const target = path.resolve(root, ".sidething", kind, file);
    return target.startsWith(path.resolve(root, ".sidething") + path.sep) ? target : null;
  } catch { return null; }
}

/** Voice and clip sound URLs resolve the way the media protocol serves them: one read of the index and the takes per plan. */
function voiceResolver(root: string) {
  let index: Promise<{ clips?: { id: string }[] } | null> | null = null;
  let takes: Promise<{ file: string }[]> | null = null;
  return async (url: string): Promise<string | null> => {
    try {
      const parts = new URL(url).pathname.split("/").slice(1).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
      if (parts.length !== 3 || parts[1] !== "voice") return null;
      const fileRaw = parts[2];
      if (fileRaw.startsWith("voiceover:")) {
        takes ??= import("./voiceover-takes").then(m => m.listVoiceovers(root));
        const take = (await takes).find(t => t.file === fileRaw.slice("voiceover:".length));
        if (!take) return null;
        const target = path.resolve(root, take.file);
        return await (await import("./playback-audio")).playbackAudio(root, target).catch(() => target);
      }
      index ??= fs.promises.readFile(path.join(root, ".sidething", "index.json"), "utf8").then(text => JSON.parse(text) as { clips?: { id: string }[] }).catch(() => null);
      const clip = (await index)?.clips?.find(c => c.id === fileRaw) as never;
      if (!clip) return null;
      const source = (await import("./playback-source")).playbackSource(root, clip);
      return await (await import("./playback-audio")).playbackAudio(root, source.file).catch(() => source.file);
    } catch { return null; }
  };
}

export interface AppleSetEditPayload {
  root: string; cutId: string; version: number;
  state: ApplePlaybackState;
  timeline: DraftTimeline | null;
  rotations?: Record<string, number>;
  voice?: AppleVoicePiece[];
  at?: number;
  /** AV2: the Look the viewer shows (tables by id, the numbers its shader takes, the finish). */
  look?: AppleLookPayload;
  /** AV3: when the page sent this plan (epoch ms), for timing an edit from the page to the picture. */
  sentAt?: number;
  /** AV4: each picture piece's layer plan as the viewer draws it, by piece index. */
  layers?: (AppleLayerPlan | null)[];
}

/** Basic values in the shader's order (finish/basicsMath BASIC_KEYS). */
export const APPLE_BASIC_KEYS = ["exposure", "contrast", "highlights", "shadows", "whites", "blacks", "temperature", "tint", "vibrance", "saturation"] as const;
export function appleBasicValues(basic: import("../shared/schema").BasicAdjust | undefined): number[] {
  const value = normalizeBasic(basic);
  return APPLE_BASIC_KEYS.map(key => value[key]);
}
/** Mixer values in the shader's order (main/mixer MIXER_HUES, then hue, sat, lum). */
export function appleMixerValues(mixer: import("../shared/schema").Grade["mixer"]): number[] {
  return Object.keys(MIXER_HUES).flatMap(key => {
    const band = mixer?.[key as keyof typeof MIXER_HUES];
    return [band?.hue ?? 0, band?.sat ?? 0, band?.lum ?? 0];
  });
}
/** Per channel exposure gains, clamped as the Chrome viewer clamps them. */
export function appleExposureGains(exposure: { stops: number; matched?: boolean; gains?: [number, number, number] }): [number, number, number] {
  const stops = Math.min(exposure.matched ? 0.7 : 0, Math.max(-1, exposure.stops || 0));
  return [0, 1, 2].map(ch => 2 ** stops * (exposure.gains?.[ch as 0 | 1 | 2] ?? 1)) as [number, number, number];
}

/** Plans already written, by content: reopening an edit (or a tab coming back) reuses its files and manifest. */
const plans = new Map<string, string>();
/** One folder of plans per run of the app, removed on quit. */
let plansDir: string | null = null;
const manifestDir = () => {
  if (!plansDir) {
    plansDir = fs.mkdtempSync(path.join(os.tmpdir(), "precut-apple-"));
    // Who owns it: another precut (a developer's own, beside a QA run) keeps its folder while it runs.
    try { fs.writeFileSync(path.join(plansDir, "owner.pid"), String(process.pid)); } catch { /* the folder still serves this run */ }
  }
  return plansDir;
};
/** LUT tables already written in this run, by content, so pieces sharing a base write it once. */
const lutFiles = new Map<string, string>();

/** A process id that is still running (signal 0 only asks). */
function running(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
/** A folder made before owners were written (AV1b) counts as stale once it is a day old. */
const UNOWNED_STALE_MS = 24 * 3600 * 1000;

/**
 * AV2: delete `precut-apple-*` plan folders left by earlier runs (a crash or a kill never reaches before-quit).
 * Only precut's own prefix, only folders, never this run's own, and never one whose owner is still running (another
 * precut on this Mac, such as a developer's own beside a QA run). Returns what was removed, for tests.
 */
export function cleanupStaleApplePlans(tmpDir: string = os.tmpdir(), keep: string | null = plansDir, now = Date.now()): string[] {
  const removed: string[] = [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(tmpDir); } catch { return removed; }
  for (const name of entries) {
    if (!/^precut-apple-[A-Za-z0-9]{6}$/.test(name)) continue;
    const target = path.join(tmpDir, name);
    if (keep && path.resolve(target) === path.resolve(keep)) continue;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isDirectory()) continue;
      let owner: number | null = null;
      try { owner = Number(fs.readFileSync(path.join(target, "owner.pid"), "utf8").trim()); } catch { /* an AV1b folder: no owner written */ }
      if (owner !== null ? running(owner) : now - stat.mtimeMs < UNOWNED_STALE_MS) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } catch { /* another run may be using it; the next launch tries again */ }
  }
  return removed;
}

/** Write one LUT table (from `liveLut`) as raw Float32 beside the manifest. Same bytes the Chrome viewer uploads. */
async function writeAppleLut(data: number[]): Promise<{ file: string; size: number }> {
  const size = Math.round(Math.cbrt(data.length / 3));
  const hash = createHash("sha256").update(Buffer.from(new Float32Array(data).buffer)).digest("hex").slice(0, 16);
  const known = lutFiles.get(hash);
  if (known && fs.existsSync(known)) return { file: known, size };
  const file = path.join(manifestDir(), `lut-${hash}.bin`);
  await fs.promises.writeFile(file, Buffer.from(new Float32Array(data).buffer));
  lutFiles.set(hash, file);
  return { file, size };
}

/** The numbers a piece's recipe gives when the viewer has not sent its own (it has not read that recipe yet). */
function recipeNumbers(recipe: NonNullable<Awaited<ReturnType<typeof liveGrade>>>) {
  return { params: lookParameters(recipe.grade), basic: appleBasicValues(recipe.grade.basic), mixer: appleMixerValues(recipe.grade.mixer), exposure: appleExposureGains(recipe.exposure) };
}
/** A piece's colour table: with a live recipe (`liveGrade`), its base table (`base:` + baseId, shared by every
 * piece over the same neutral base, and unchanged by a slider or a new version of the same Look); without one, its
 * whole composed table (`full:` + its id). The numbers ride separately. */
async function tableKey(lutId: string): Promise<{ key: string; recipe: Awaited<ReturnType<typeof liveGrade>> }> {
  const recipe = await liveGrade(lutId);
  return { key: recipe ? `base:${recipe.baseId}` : `full:${lutId}`, recipe };
}
/** Tables written in this run, by table key: each is read (`liveLut`) and written once. */
const tableFiles = new Map<string, Promise<{ file: string; size: number }>>();
function tableFile(key: string): Promise<{ file: string; size: number }> {
  let made = tableFiles.get(key);
  if (!made) {
    made = liveLut(key.slice(5)).then(table => writeAppleLut(table.data));
    made.catch(() => tableFiles.delete(key));
    tableFiles.set(key, made);
  }
  return made;
}
/** One piece's colour from the one source the Chrome viewer and the export read: its table and the numbers its
 * shader takes (the viewer's own when it sent them, else its recipe's). */
async function segmentLook(lutId: string, given: AppleLookSegment | undefined): Promise<AppleSegmentLook | null> {
  const { key, recipe } = await tableKey(lutId);
  const written = await tableFile(key);
  if (recipe) {
    const numbers = given?.params?.length === 18 ? { params: given.params, basic: given.basic ?? [], mixer: given.mixer ?? [], exposure: (given.exposure ?? [1, 1, 1]) as [number, number, number] } : recipeNumbers(recipe);
    return { mode: "uniform", lutFile: written.file, lutSize: written.size, ...numbers, diffusion: given ? given.diffusion ?? undefined : recipe.pieceLook?.diffusion };
  }
  return { mode: "full", lutFile: written.file, lutSize: written.size, diffusion: given?.diffusion ?? undefined };
}
/** The viewer's entry for the segment starting at `start` on lane `layer` (pieces are named by where they sit, as in
 * the plan; AV4: a layout's pictures start together on two lanes). */
const lookFor = (look: AppleLookPayload | undefined, start: number, layer = 0) => look?.segments.find(s => Math.abs(s.start - start) < 0.0005 && (s.layer ?? 0) === layer);
/** A segment's name in the maps below: where it starts and its lane. */
const segKey = (start: number, layer = 0) => `${start}|${layer}`;
/** Raised by every plan loaded, so a later fill of an older plan never lands on a newer one. */
let planGeneration = 0;
/** A plan whose far pieces are still reading their tables: which are pending, which the player has reached (read
 * those first), which are read, and how the current load receives each. By plan file. */
interface Filler { urgent: number[]; pending: Set<string>; filled: AppleManifest["video"]; deliver: ((segment: AppleManifest["video"][number]) => void) | null }
const fillers = new Map<string, Filler>();
let currentFiller: Filler | null = null;
/** Each segment's table as loaded, by start: its piece id and table key, so a Look change resolves only what changed. */
const loadedTables = new Map<string, { lutId: string; key: string }>();

/**
 * AV2: give every picture segment its Look, as the viewer shows it (its payload), from the one source of tables and
 * numbers, plus the edit's finish and the shader (the viewer's GLSL in Metal). Tables resolve in parallel. Look off
 * (Shift+D) plays the plain picture. No grade maths here.
 */
export async function enrichAppleLooks(manifest: AppleManifest, look?: AppleLookPayload, near?: { at: number; seconds: number }): Promise<{ pending: AppleManifest["video"]; fill: (segment: AppleManifest["video"][number]) => Promise<void> }> {
  const { source, hash } = appleShader();
  manifest.shader = { source, hash, detailSteps: APPLE_DETAIL_STEPS };
  manifest.finish = look?.bypass ? null : look?.finish ?? null;
  const fill = async (segment: AppleManifest["video"][number]) => {
    const given = lookFor(look, segment.timelineStart, segment.layer);
    const lutId = given?.lutId ?? segment.lutId;
    if (look?.bypass || !lutId) { segment.look = null; return; }
    // Assigned only once read: a pending piece stays pending in the plan until its tables are here.
    let made: AppleSegmentLook | null = null;
    try { made = await segmentLook(lutId, given); } catch { made = null; }
    segment.look = made;
  };
  // With `near`, only the pieces around the play point read their tables now (each a colour worker job, about 30 ms);
  // the rest are marked pending (the player holds its picture rather than show one without its Look) and fill in
  // after, in play order (`pending`, each filled by `fill`; see the filler in appleSetEdit).
  const soon = (v: AppleManifest["video"][number]) => !near || (v.timelineEnd > near.at - 0.5 && v.timelineStart < near.at + near.seconds);
  await Promise.all(manifest.video.filter(soon).map(fill));
  const later = manifest.video.filter(v => !soon(v)).sort((a, b) => ((a.timelineStart - (near?.at ?? 0) + 1e6) % 1e6) - ((b.timelineStart - (near?.at ?? 0) + 1e6) % 1e6));
  for (const v of later) v.look = { mode: "pending", lutFile: "", lutSize: 0 };
  return { pending: later, fill };
}

/** AV3: files already resolved in this run, by root and URL. An edit while playing re-plans the whole edit; only its
 * new pieces need resolving (a voice line through the playback helpers is the slow part). A file that has gone is
 * resolved again. */
const resolvedFiles = new Map<string, string>();
/** AV4: the bleep tone's file: one second of 1 kHz at full scale, 48 kHz float, a whole number of cycles (it loops
 * without a seam, as liveMix's beep buffer does). Written once per run beside the plans. */
export function appleBeepFile(dir: string = manifestDir()): string {
  const file = path.join(dir, "beep-1k.wav");
  if (fs.existsSync(file)) return file;
  const rate = 48000, samples = new Float32Array(rate);
  for (let n = 0; n < rate; n++) samples[n] = Math.sin(2 * Math.PI * 1000 * n / rate);
  const header = Buffer.alloc(44), data = Buffer.from(samples.buffer);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8); header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(32, 34); header.write("data", 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(`${file}.part`, Buffer.concat([header, data])); fs.renameSync(`${file}.part`, file);
  return file;
}
/** Every file the plan reads, resolved at once (in parallel), or null for a URL that is not ready. */
export async function resolveAppleFiles(root: string, urls: string[]): Promise<Map<string, string | null>> {
  const voice = voiceResolver(root);
  const entries = await Promise.all(urls.map(async url => {
    if (url === APPLE_BEEP_URL) { try { return [url, appleBeepFile()] as const; } catch { return [url, null] as const; } }
    const known = resolvedFiles.get(`${root}\n${url}`);
    if (known && fs.existsSync(known)) return [url, known] as const;
    const direct = directAppleFile(url);
    const file = direct ? await fs.promises.stat(direct).then(s => (s.isFile() ? direct : null)).catch(() => null) : await voice(url);
    if (file) { resolvedFiles.set(`${root}\n${url}`, file); if (resolvedFiles.size > 4000) resolvedFiles.clear(); }
    return [url, file] as const;
  }));
  return new Map(entries);
}

export async function appleSetEdit(sender: WebContents, payload: AppleSetEditPayload): Promise<ApplePlaybackReport> {
  ownerId = sender.id;
  lastSentAt = typeof payload.sentAt === "number" ? payload.sentAt : null;
  const base = { root: payload.root, cutId: payload.cutId, version: payload.version, playing: false };
  const quiet = () => { if (addon) { addon.dispose(); } };
  if (payload.state.player !== "apple" || !payload.timeline) {
    quiet();
    return recordAppleState({ ...payload.state, ...base });
  }
  const native = appleAddon();
  const win = BrowserWindow.fromWebContents(sender);
  if (!native || !win || win.isDestroyed()) return recordAppleState({ player: "chrome", reason: APPLE_UNAVAILABLE_REASON, appleEnabled: true, ...base });
  const started = performance.now();
  // AV3: from the page to here (the plan's IPC), for timing an edit end to end.
  const ipcMs = typeof payload.sentAt === "number" ? Date.now() - payload.sentAt : undefined;
  // The shader compiles on the addon's own queue while the plan's files and tables resolve here.
  try { const { source, hash } = appleShader(); native.warm?.(JSON.stringify({ source, hash, detailSteps: APPLE_DETAIL_STEPS })); } catch { /* the load compiles it */ }
  const timeline = payload.timeline;
  const parts: { filesMs?: number; lookMs?: number; restMs?: number; ipcMs?: number; writeMs?: number; loadMs?: number } = { ipcMs };
  let filling: { pending: AppleManifest["video"]; fill: (segment: AppleManifest["video"][number]) => Promise<void>; plan: AppleManifest } | null = null;
  const rotations = payload.rotations ?? {};
  // The plan's picture and sound, not its Look: a Look change reaches a loaded plan as numbers (appleUpdateLook).
  const key = createHash("sha256").update(JSON.stringify([payload.root, timeline.pieces.map(p => ({ ...p, lut: undefined, liveLook: undefined })), timeline.liveSound, timeline.durationS, timeline.width, timeline.height, timeline.fps, rotations, payload.voice ?? null, payload.layers ?? null])).digest("hex");
  let manifestPath = plans.get(key);
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    const files = await resolveAppleFiles(payload.root, appleManifestUrls(timeline, payload.voice, payload.layers));
    parts.filesMs = Math.round(performance.now() - started);
    const manifest: AppleManifest | null = buildAppleManifest(timeline, url => files.get(url) ?? null, piece => rotations[piece.clipId] ?? 0, payload.voice, payload.layers);
    if (!manifest) { quiet(); return recordAppleState({ player: "chrome", reason: APPLE_FILE_REASON, appleEnabled: true, ...base }); }
    filling = { ...(await enrichAppleLooks(manifest, payload.look, { at: payload.at ?? 0, seconds: 4 })), plan: manifest };
    parts.lookMs = Math.round(performance.now() - started) - parts.filesMs;
    manifestPath = path.join(manifestDir(), `${key.slice(0, 16)}.json`);
    const writing = performance.now();
    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest));
    parts.writeMs = Math.round(performance.now() - writing);
    plans.set(key, manifestPath);
    while (plans.size > 8) { const oldest = plans.keys().next().value!; fs.rmSync(plans.get(oldest)!, { force: true }); plans.delete(oldest); }
  }
  if (win.isDestroyed()) return recordAppleState({ player: "chrome", reason: APPLE_UNAVAILABLE_REASON, appleEnabled: true, ...base });
  // A reused plan was written with the Look of its time: the viewer's Look now follows as an update.
  const loaded = filling?.plan ?? JSON.parse(await fs.promises.readFile(manifestPath, "utf8")) as AppleManifest;
  loadedTables.clear();
  await Promise.all(loaded.video.map(async segment => {
    const lutId = lookFor(payload.look, segment.timelineStart, segment.layer)?.lutId ?? segment.lutId;
    if (lutId && segment.look && segment.look.mode !== "pending") loadedTables.set(segKey(segment.timelineStart, segment.layer), { lutId, key: (await tableKey(lutId)).key });
  }));
  lastPlanPath = manifestPath;
  const windowNumber = native.attach(win.getNativeWindowHandle());
  attachedWindow = windowNumber;
  // A muted launch (every QA run passes --mute-audio) plays the whole sound path and is heard by nobody.
  lastPlanParts = { ...parts, mainMs: Math.round(performance.now() - started) };
  const loading = performance.now();
  native.load(manifestPath, payload.at ?? 0, viewerMuted || app.commandLine.hasSwitch("mute-audio"));
  parts.loadMs = Math.round(performance.now() - loading);
  if (payload.look) void appleUpdateLook(JSON.stringify(payload.look));
  // The pieces further away read their tables now, one at a time in play order, a piece the player has reached first
  // (`needLook`), and each reaches the player as it is read. The plan file is rewritten whole at the end, so reopening
  // it needs none of this. Whichever load of the plan is current when a piece arrives gets it.
  if (filling && filling.pending.length) {
    const { pending, fill, plan } = filling, file = manifestPath, filler: Filler = { urgent: [], pending: new Set(pending.map(v => segKey(v.timelineStart, v.layer))), filled: [], deliver: null };
    fillers.set(file, filler);
    void (async () => {
      const queue = [...pending];
      while (queue.length) {
        const urgent = filler.urgent.shift();
        const at = urgent === undefined ? 0 : queue.findIndex(v => Math.abs(v.timelineStart - urgent) < 0.0005);
        const [segment] = queue.splice(Math.max(0, at), 1);
        await fill(segment);
        filler.pending.delete(segKey(segment.timelineStart, segment.layer));
        filler.filled.push(segment);
        filler.deliver?.(segment);
      }
      parts.restMs = Math.round(performance.now() - started);
      // Written aside and moved into place: a reader never sees half a plan.
      await fs.promises.writeFile(`${file}.part`, JSON.stringify(plan)).then(() => fs.promises.rename(`${file}.part`, file)).catch(() => {});
      fillers.delete(file);
      if (currentFiller === filler) currentFiller = null;
    })().catch(() => {});
  }
  const generation = ++planGeneration, filler = fillers.get(manifestPath) ?? null;
  currentFiller = filler;
  if (filler) {
    filler.deliver = segment => {
      if (generation !== planGeneration || !addon?.setLook || !segment.look || segment.look.mode === "pending") return;
      const id = lookFor(payload.look, segment.timelineStart, segment.layer)?.lutId ?? segment.lutId ?? "";
      // The viewer's newest numbers for it (a slider may have moved while it was read); a new Look meanwhile is
      // resolved the ordinary way, now that the piece is no longer pending.
      const latest = lookFor(lastLook ?? payload.look, segment.timelineStart, segment.layer);
      if (latest?.lutId && latest.lutId !== id) { if (lastLook) void appleUpdateLook(JSON.stringify(lastLook)); return; }
      void tableKey(id).then(({ key }) => { if (generation === planGeneration) loadedTables.set(segKey(segment.timelineStart, segment.layer), { lutId: id, key }); }).catch(() => {});
      const v = segment.look, numbers = latest?.params?.length === 18 ? latest : v;
      addon.setLook(JSON.stringify({ segments: [{ start: segment.timelineStart, layer: segment.layer ?? 0, mode: v.mode, lutFile: v.lutFile, lutSize: v.lutSize, params: numbers.params, basic: numbers.basic, mixer: numbers.mixer, exposure: numbers.exposure, diffusion: latest ? latest.diffusion ?? null : v.diffusion ?? null }] }));
    };
    // A reopen while it fills: the pieces read before it was loaded go now.
    for (const segment of filler.filled) filler.deliver(segment);
  }
  const { opening: _opening, holds: _holds, ...previous } = lastState;
  void _opening; void _holds;
  return recordAppleState({ ...previous, ...payload.state, ...base, planMs: Math.round(performance.now() - started), planParts: parts });
}

/** The newest Look not yet handed over, and the hand over in progress: a slow table never lets an older Look land last. */
let lookWaiting: AppleLookPayload | null = null;
/** The viewer's newest Look, for a piece whose tables arrive after it. */
let lastLook: AppleLookPayload | null = null;
let lookBusy: Promise<void> | null = null;
/**
 * AV2: a Look slider, a balance, a clip look or a new Look moved. Only the compositor's numbers (and, for a new
 * Look, its tables) change: no reload, no black picture, no restart of sound. Tables that changed resolve first.
 */
export function appleUpdateLook(lookJson: string): Promise<void> {
  let look: AppleLookPayload;
  try { look = JSON.parse(lookJson) as AppleLookPayload; } catch { return Promise.resolve(); }
  if (!Array.isArray(look?.segments)) return Promise.resolve();
  if (typeof look.version === "number" && look.version !== lastState.version && lastState.cutId) lastState = { ...lastState, version: look.version };
  lookWaiting = look;
  lastLook = look;
  lookBusy ??= (async () => {
    try {
      while (lookWaiting) {
        const next = lookWaiting; lookWaiting = null;
        await sendLook(next);
      }
    } finally { lookBusy = null; }
  })();
  return lookBusy;
}
async function sendLook(look: AppleLookPayload): Promise<void> {
  if (!addon?.setLook) return;
  // A piece whose id is new may still draw through the same table (a slider saved as a new version keeps its base):
  // only a new table is read and sent; the numbers always go. With no new ids (a slider step), nothing waits.
  // A piece still pending in the plan is the filler's to read (one job at a time, the reached piece first).
  const filling = (entry: AppleLookSegment) => !!currentFiller?.pending.has(segKey(entry.start, entry.layer));
  const fresh = look.segments.filter(entry => entry.lutId && !filling(entry) && loadedTables.get(segKey(entry.start, entry.layer))?.lutId !== entry.lutId);
  const keys = new Map<string, string>();
  if (fresh.length) await Promise.all(fresh.map(async entry => { try { keys.set(segKey(entry.start, entry.layer), (await tableKey(entry.lutId!)).key); } catch { /* keeps its table */ } }));
  const segments = await Promise.all(look.segments.filter(entry => !filling(entry)).map(async (entry): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = { start: entry.start, layer: entry.layer ?? 0, diffusion: entry.diffusion ?? null };
    // AV3: the clip transform as the viewer draws it (null clears it), riding with the Look.
    if (entry.transform !== undefined) out.transform = entry.transform;
    const name = segKey(entry.start, entry.layer), key = keys.get(name), loaded = loadedTables.get(name);
    if (key !== undefined && key !== loaded?.key) {
      try {
        const resolved = await segmentLook(entry.lutId!, entry);
        if (resolved) { Object.assign(out, { mode: resolved.mode, lutFile: resolved.lutFile, lutSize: resolved.lutSize, params: resolved.params, basic: resolved.basic, mixer: resolved.mixer, exposure: resolved.exposure }); loadedTables.set(name, { lutId: entry.lutId!, key }); }
      } catch { /* that piece keeps the Look it has */ }
      return out;
    }
    if (key !== undefined && loaded) loadedTables.set(name, { lutId: entry.lutId!, key });
    if (entry.params?.length === 18) Object.assign(out, { params: entry.params, basic: entry.basic, mixer: entry.mixer, exposure: entry.exposure });
    return out;
  }));
  try { addon.setLook(JSON.stringify({ segments, finish: look.bypass ? { grain: null, vignette: null, detail: null, scoped: false } : look.finish ?? null, bypass: !!look.bypass, sentAt: look.sentAt ?? null, mainAt: Date.now() })); }
  catch { /* an older addon keeps the loaded Look */ }
}
export function applePlay(at: number, rate: number): void { addon?.play(at, rate); }
export function applePause(): void { addon?.pause(); }
export function appleSeek(at: number): void { addon?.seek(at); }
export function appleSetVisible(visible: boolean): void { addon?.setVisible(visible); }
/** The viewer's mute button. A launch with --mute-audio (every QA run) stays muted whatever the button says. */
export function appleSetMuted(muted: boolean): void { viewerMuted = muted; addon?.setMuted(muted || app.commandLine.hasSwitch("mute-audio")); }
/** The viewer's picture rect in the page (CSS pixels, top left), placed in the window's content view. */
export function appleSetRect(sender: WebContents, rect: { x: number; y: number; w: number; h: number; frames?: number }): void {
  if (!addon || sender.isDestroyed()) return;
  const zoom = sender.getZoomFactor() || 1;
  addon.setRect(rect.x * zoom, rect.y * zoom, rect.w * zoom, rect.h * zoom, Math.max(0, Math.min(8, Math.round(rect.frames ?? 0))));
}
/** QA and diagnostics: where the picture view sits, and the last opening and holds the addon measured. */
export function appleNativeState(): Record<string, unknown> | null {
  if (!addon) return null;
  try { return { window: attachedWindow, ...(JSON.parse(addon.state()) as Record<string, unknown>) }; } catch { return null; }
}
/** QA: one image of precut's whole window, the Apple picture and the page together. */
export function appleCapture(file: string, nominal = false): Record<string, unknown> {
  if (!addon) return { ok: false, error: "Apple player not loaded" };
  return JSON.parse(addon.capture(file, nominal)) as Record<string, unknown>;
}
/** QA only (AV2): the picture on screen, full size, with its Look, as a PNG (the addon draws it again with the same renderer). */
export function appleQaFrame(file: string): Record<string, unknown> {
  if (process.env["PRECUT_QA_BACKGROUND"] !== "1" || !addon?.qaFrame) return { ok: false, error: "QA only" };
  return JSON.parse(addon.qaFrame(file)) as Record<string, unknown>;
}
/** QA only (PRECUT_QA_BACKGROUND=1): the invisible QA window goes under the desktop picture so it can be captured opaque. */
export function appleQaBelowDesktop(): number { return process.env["PRECUT_QA_BACKGROUND"] === "1" && addon ? addon.qaBelowDesktop() : 0; }
/** QA only: load the addon and attach it to precut's window without playing, so a Chrome viewer run captures the same way. */
export function appleQaAttach(): number {
  if (process.env["PRECUT_QA_BACKGROUND"] !== "1") return -1;
  const native = appleAddon(), win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
  if (!native || !win) return -1;
  attachedWindow = native.attach(win.getNativeWindowHandle());
  return attachedWindow;
}
export function stopApplePlayer(): void {
  try { addon?.dispose(); } catch { /* already gone */ }
  if (plansDir) { try { fs.rmSync(plansDir, { recursive: true, force: true }); } catch { /* the OS clears temp */ } plansDir = null; plans.clear(); lutFiles.clear(); tableFiles.clear(); loadedTables.clear(); fillers.clear(); currentFiller = null; }
}
app.on("before-quit", stopApplePlayer);
// QA reaches the bridge from main without an import path of its own.
if (process.env["PRECUT_QA_BACKGROUND"] === "1") (globalThis as { __precutApple?: unknown }).__precutApple = { appleNativeState, appleCapture, appleQaBelowDesktop, appleQaAttach, getApplePlaybackState, appleAddonPath, appleQaFrame, appleLastPlan: () => lastPlanPath };
