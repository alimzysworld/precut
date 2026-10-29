import { sourceAudioChannels } from './source-audio';
import { clipTransformXml, displayedClip, clipFileDimensions } from "../shared/media";
import { tool } from "./tools";
// S5: precut export (FCPXML + Resolve metadata CSV + mic sync) and
// template storage (userData/templates.json).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { effectiveShoot } from "./steps";
import { planSelects, type SelectsPlan } from "./selects";
import { listSkills, skillTemplate } from "./skills";
import { standardFrameRate } from "../shared/frame-rate";
import { renderPreview } from "./preview";
import { framingChoice, motionReadme } from "./framing";
import { renderNotes, captionExportNotes } from "./render-notes";
import { makeReel, reelCatalog, compositeReelPreview, type ReelAssembly } from "./reel";
import type { Clip, ClipFiller, PrecutKind, Shoot, Template, ReelOptions, PrecutResult, TakeAttempt, Word, CutVersion } from "../shared/schema";

export type ExportFinishing = Pick<CutVersion, "clipSoundMuted" | "clipSoundDefaultOn" | "laneLevels" | "laneMuted" | "voiceover" | "titles" | "grade" | "audio" | "finished" | "framing" | "pieceFx" | "transition" | "joins" | "faceMatch" | "overlays" | "cutToBeat" | "sfx" | "energy" | "bleeps" | "lowerThirds" | "angleCuts" | "layouts"> & Partial<Pick<CutVersion, "music">> & { jumpScales?: (number | null)[] };

/** Existing Sidekick callers identify their saved version by title/version and
 * preview. Read finishing from that exact saved assembly without changing it. */
export async function savedExportFinishing(root: string, cuts: CutItem[], opts: {
  folderName?: string; existingPreview?: string | null;
}): Promise<ExportFinishing | undefined> {
  if (!opts.folderName && !opts.existingPreview) return;
  const directory = path.join(root, ".sidething", "sidekick", "cuts");
  let files: string[];
  try { files = await fs.promises.readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const signature = (items: CutItem[]) => JSON.stringify(items.map(c => [c.piece, c.seg?.clip.id, c.inFrames,
    c.outFrames, c.offsetFrames, c.durTimelineFrames]));
  const wanted = signature(cuts), matches: ExportFinishing[] = [];
  for (const file of files.filter(f => f.endsWith(".json"))) {
    let stored: { versions?: (CutVersion & { assembly?: { cutList: CutItem[] } })[] };
    try { stored = await (await import("./cut-storage")).readCutDocument(path.join(directory, file)) as unknown as typeof stored; }  // ARCH2: head + log
    catch (error) { if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const version of stored.versions ?? []) {
      const named = opts.folderName === `${version.title} v${version.version}`;
      const preview = opts.existingPreview && version.preview && path.basename(opts.existingPreview) === path.basename(version.preview);
      if (!(named || preview) || !version.assembly || signature(version.assembly.cutList) !== wanted) continue;
      if (version.clipSoundDefaultOn || version.laneLevels || version.laneMuted || version.clipSoundMuted !== undefined || version.voiceover || version.angleCuts?.length || version.layouts?.some(Boolean) || version.titles || version.grade || version.audio || version.finished || version.framing || version.pieceFx || version.transition || version.joins || version.cutToBeat || version.music !== undefined || version.sfx?.length) matches.push({
        clipSoundDefaultOn:version.clipSoundDefaultOn,laneLevels:version.laneLevels,laneMuted:version.laneMuted,clipSoundMuted:version.clipSoundMuted, voiceover: version.voiceover, titles: version.titles, grade: version.grade, audio: version.audio, music: version.music, finished: version.finished, energy: version.energy, layouts: version.layouts, angleCuts: version.angleCuts,
        jumpScales: (version as ExportFinishing).jumpScales,
        transition: version.transition, joins: version.joins, faceMatch: version.faceMatch, cutToBeat: version.cutToBeat, overlays: version.overlays, sfx: version.sfx, bleeps: version.bleeps, lowerThirds: version.lowerThirds,
        ...(version.framing ? { framing: version.framing } : {}), ...(version.pieceFx ? { pieceFx: version.pieceFx } : {}),
      });
    }
  }
  if (matches.length > 1) throw new Error("More than one saved finishing version matches this export. Pass opts.finishing explicitly.");
  return matches[0];
}

// ---------------------------------------------------------------- templates
const SEED_TEMPLATES: Template[] = [
  { id: "youtube-16-9", name: "YouTube 16:9", width: 3840, height: 2160, fps: 25, drpPath: null, notes: "" },
  { id: "reel-9-16", name: "Reel 9:16", width: 2160, height: 3840, fps: 25, drpPath: null, notes: "" },
];

async function userDataDir(): Promise<string> {
  const override = process.env.SIDETHING_USER_DATA;
  if (override) return override;
  try {
    const mod = (await import("electron")) as unknown as {
      app?: { getPath(name: string): string };
      default?: { app?: { getPath(name: string): string } };
    };
    const app = mod.app ?? mod.default?.app;
    if (app && typeof app.getPath === "function") return app.getPath("userData");
  } catch {
    // not running under Electron (plain-node QA): fall through
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "precut");
  }
  return path.join(os.homedir(), ".config", "precut");
}

async function templatesPath(): Promise<string> {
  return path.join(await userDataDir(), "templates.json");
}

function isTemplate(v: unknown): v is Template {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Template;
  return typeof t.id === "string" && typeof t.name === "string" &&
    typeof t.width === "number" && typeof t.height === "number" &&
    typeof t.fps === "number" && (t.drpPath === null || typeof t.drpPath === "string") &&
    typeof t.notes === "string";
}

async function readTemplates(): Promise<Template[] | null> {
  try {
    const raw = await fs.promises.readFile(await templatesPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(isTemplate);
  } catch {
    return null;
  }
}

async function writeTemplates(list: Template[]): Promise<void> {
  const file = await templatesPath();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(list, null, 2) + "\n");
}

export async function listTemplates(): Promise<Template[]> {
  const existing = await readTemplates();
  if (existing === null || existing.length === 0) {
    const seeds = SEED_TEMPLATES.map((t) => ({ ...t }));
    await writeTemplates(seeds);
    return seeds;
  }
  return existing;
}

export async function saveTemplate(t: Template): Promise<void> {
  const list = await listTemplates();
  const idx = list.findIndex((x) => x.id === t.id);
  if (idx >= 0) list[idx] = { ...t };
  else list.push({ ...t });
  await writeTemplates(list);
}

// ------------------------------------------------------------------- helpers
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function csvField(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a), y = Math.abs(b);
  while (y) { const t = x % y; x = y; y = t; }
  return x || 1;
}

interface FpsRational { num: number; den: number } // fps = num/den

function fpsRational(fps: number): FpsRational {
  if (!fps || !Number.isFinite(fps) || fps <= 0) return { num: 25, den: 1 };
  const known: [number, number][] = [
    [24000, 1001], [30000, 1001], [60000, 1001],
    [24, 1], [25, 1], [30, 1], [48, 1], [50, 1], [60, 1],
  ];
  for (const [n, d] of known) {
    if (Math.abs(fps - n / d) < 0.002) return { num: n, den: d };
  }
  const scaled = Math.round(fps * 1000);
  const g = gcd(scaled, 1000);
  return { num: scaled / g, den: 1000 / g };
}

// A time as an FCPXML rational at the given frame rate: frames worth of
// time is frames*den/num seconds, written "n/d s" as in the spike file.
function timeAt(frames: number, r: FpsRational): string {
  // Usually whole frames. A word boundary with no silence may fall between
  // frames; preserve it rather than rounding into speech on either side.
  if (Math.abs(frames - Math.round(frames)) < 1e-7) {
    const n = Math.round(frames) * r.den;
    return n === 0 ? "0s" : `${n}/${r.num}s`;
  }
  // FCPXML denominators are 32-bit. Quantize subframes to microseconds,
  // rather than multiplying an NTSC denominator into an overflowing value.
  const n = Math.round(frames * r.den / r.num * 1e6);
  if (n === 0) return "0s";
  const divisor = gcd(n, 1e6);
  return `${n / divisor}/${1e6 / divisor}s`;
}

function frameDurationOf(r: FpsRational): string {
  return `${r.den}/${r.num}s`;
}

function tcToFrames(tc: string | null, fps: number): number {
  if (!tc) return 0;
  const parts = tc.replace(";", ":").split(":").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) return 0;
  const nominal = Math.round(fps) || 25;
  return ((parts[0] * 3600 + parts[1] * 60 + parts[2]) * nominal) + parts[3];
}

function firstWords(text: string, n = 6): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, n).join(" ");
}

function formatClock(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

function stampOf(d: Date): string {
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------- mic sync
function venvPython(): string {
  return path.join(os.homedir(), "Library", "Application Support", "precut", "venv", "bin", "python");
}

function syncScriptPath(): string | null {
  const candidates = [
    path.join(process.cwd(), "pipeline", "sync.py"),
    path.join(process.cwd(), "..", "pipeline", "sync.py"),
  ];
  try {
    // bundled main lives in out/main; pipeline sits at the repo root
    candidates.push(path.join(__dirname, "..", "..", "pipeline", "sync.py"));
    candidates.push(path.join(__dirname, "..", "..", "..", "pipeline", "sync.py"));
  } catch { /* __dirname unavailable */ }
  try {
    const electron = process as unknown as { resourcesPath?: string };
    if (electron.resourcesPath) {
      candidates.push(path.join(electron.resourcesPath, "pipeline", "sync.py"));
    }
  } catch { /* ignore */ }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

async function runMicSync(root: string): Promise<void> {
  const script = syncScriptPath();
  if (!script) return;
  const venv = venvPython();
  const python = tool("python3");
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const child = spawn(python, ["-I", script, root], { stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } done(); }, 15 * 60 * 1000);
      child.on("error", () => { clearTimeout(timer); done(); });
      child.on("close", () => { clearTimeout(timer); done(); });
      child.stdout?.resume();
      child.stderr?.resume();
    } catch {
      done();
    }
  });
}

// ------------------------------------------------------------- precut build
export interface Segment {
  clip: Clip;
  s: number;
  e: number;
  marker: string;
  lineIndex: number | null;
  speechWords?: Word[]; // take-local measurement, projected from the private cache
  energyMeasured?: boolean; // PCM silence can cross a smeared word timestamp
  outLimitS?: number;   // the next measured sound after this take: no edit (beat snap included) may pass it
  authoredBounds?: boolean; // model-chosen timing, retained after speech padding
}

interface AttemptMeasurement {
  key: { clipId: string; s: number; e: number;
    audio: { source: string; offsetS: number; durationS: number } };
  speechS: number; speechE: number; words: Word[];
  energy?: { frameS: number; noiseFloor: number; threshold: number };
}

function measuredAttempt(shoot: Shoot, seg: Segment): { attempt: TakeAttempt; words: Word[]; energy: boolean } | undefined {
  if (seg.lineIndex === null) return;
  const take = shoot.takes.find((t) => t.lineIndex === seg.lineIndex);
  const id = /^L\d+A(\d+):/.exec(seg.marker);
  const named = id ? take?.attempts[Number(id[1]) - 1] : undefined;
  const matches = (a: TakeAttempt) => a.clipId === seg.clip.id &&
    seg.s >= a.s - .75 && seg.e <= a.e + .75 && seg.e > a.s && seg.s < a.e;
  const identified = named && matches(named) ? named : undefined;
  const eligible = (take?.attempts ?? []).filter((a) => a.clipId === seg.clip.id &&
    (identified ? a === identified : matches(a)));
  eligible.sort((a, b) => (Math.abs(a.s - seg.s) + Math.abs(a.e - seg.e)) -
    (Math.abs(b.s - seg.s) + Math.abs(b.e - seg.e)));
  const attempt = eligible[0];
  if (!attempt) return;
  if (eligible[1] && !identified && Math.abs(Math.abs(attempt.s - seg.s) + Math.abs(attempt.e - seg.e) -
      Math.abs(eligible[1].s - seg.s) - Math.abs(eligible[1].e - seg.e)) < 1e-9 &&
      (attempt.speechS !== eligible[1].speechS || attempt.speechE !== eligible[1].speechE)) {
    throw new Error(`Ambiguous measured take for ${seg.marker}. Check its edges.`);
  }
  const cache = (shoot as Shoot & { _cache?: { fillerAttempts?: Record<string, AttemptMeasurement> } })._cache;
  const measurement = Object.values(cache?.fillerAttempts ?? {}).find(({ key, speechS, speechE }) =>
    key.clipId === attempt.clipId && key.s === attempt.s && key.e === attempt.e &&
    (attempt.speechS === undefined || speechS === attempt.speechS) && (attempt.speechE === undefined || speechE === attempt.speechE) &&
    key.audio.source.endsWith(path.sep + (seg.clip.sound?.file ?? seg.clip.file)) &&
    key.audio.offsetS === (seg.clip.sound?.offsetS ?? 0) && key.audio.durationS === seg.clip.meta?.durationS);
  return { attempt, words: measurement?.words ?? [], energy: !!measurement?.energy };
}

/** Prefer the take's measured words to the whole-clip transcript. */
function segmentWords(shoot: Shoot, seg: Segment, measured = measuredAttempt(shoot, seg)): Word[] {
  const words = measured?.words.length ? measured.words : seg.speechWords?.length ? seg.speechWords
    : (seg.clip.transcript ?? []).flatMap(part => part.words);
  return words.filter(word => Number.isFinite(word.s) && Number.isFinite(word.e) && word.e > word.s).sort((a, b) => a.s - b.s);
}

/** Keep a majority word whole, or omit it whole. Never borrow preceding speech. */
export function voiceStart(shoot: Shoot, seg: Segment, start: number, end = seg.e, words = segmentWords(shoot, seg)): number {
  const crossing = words.filter(w => w.s < start - 1e-6 && w.e > start + 1e-6);
  if (!crossing.length) return start;
  const low = Math.min(...crossing.map(w => w.s)), high = Math.max(...crossing.map(w => w.e));
  const previousSpeech = Math.max(0, ...shoot.takes.flatMap(t => t.attempts)
    .filter(a => a.clipId === seg.clip.id && a.e <= start && a.s < low)
    .map(a => a.speechE ?? a.e), ...words.filter(w => w.e <= start && w.s < low).map(w => w.e));
  return low >= previousSpeech && crossing.every(w => Math.min(end, w.e) - start > (w.e - w.s) / 2 + 1e-6) ? low : high;
}

export function sourceWords(shoot: Shoot, seg: Segment): Word[] {
  const measured = measuredAttempt(shoot, seg), words = segmentWords(shoot, seg, measured);
  const start = measured?.attempt.s ?? seg.s, end = measured?.attempt.e ?? seg.e;
  const snapped = voiceStart(shoot, seg, start, end, words);
  return words.filter(word => word.s >= snapped - 1e-6 && word.e <= end + .05);
}

function speechEdges(shoot: Shoot, seg: Segment, fps: number): { seg: Segment; start: number; end: number } | undefined {
  const measured = measuredAttempt(shoot, seg);
  if (!measured) return;
  const { attempt, words, energy } = measured;
  if (!Number.isFinite(attempt.speechS) || !Number.isFinite(attempt.speechE) || attempt.speechE! <= attempt.speechS!) return;
  // A noisy onset can belong to the preceding utterance. Local lexical words
  // identify the intended take even when PCM energy starts in its neighbour.
  const ownWords = sourceWords(shoot, seg);
  const previousWord = words.find(w => w.s < attempt.s && w.e > attempt.speechS! && w.e <= attempt.s);
  const s = energy && ownWords.length && (previousWord || ownWords[0].s < attempt.speechS!) ? ownWords[0].s : attempt.speechS!;
  const e = attempt.speechE!;
  let start = energy ? Math.max(0, s - .05) : Math.max(0, seg.s - .3, s - .05);
  // Head padding must obey the same lexical and preceding-speech guards.
  start = voiceStart(shoot, seg, start, e);
  let end = Math.min(seg.clip.meta!.durationS, e + .12);
  let limit = seg.clip.meta!.durationS; // the next measured sound after the take: nothing may extend past it
  if (energy && Number.isFinite(attempt.nextOnsetS)) {
    limit = Math.min(limit, attempt.nextOnsetS!);
    end = Math.min(end, limit - .03);
    if (end < e - 1e-9) throw new Error(`No safe tail before the next voice onset for ${seg.marker}. Check its edges.`);
  }
  // Take-local timestamps supersede the smeared whole-clip words in that slice.
  const guards = [...(seg.clip.transcript ?? []).flatMap((part) => part.words)
    .filter((w) => !words.length || w.e <= attempt.s - .35 || w.s >= attempt.e + .35),
    ...words, ...(seg.clip.fillers ?? [])];
  for (const guard of energy ? [] : guards) {
    if (![guard.s, guard.e].every(Number.isFinite)) continue;
    if (guard.s < s && guard.e <= s + 1e-9) start = Math.max(start, guard.e);
    if (guard.e > e && guard.s >= e - 1e-9) { end = Math.min(end, guard.s); limit = Math.min(limit, guard.s); }
    // Conflicting measurements must not silently put an edge inside a word
    // or filler. The check below reports a span with no safe edit.
    if (guard.s < s && guard.e > s) start = Math.max(start, guard.e);
    if (guard.s < e && guard.e > e) end = Math.min(end, guard.s);
  }
  // The whole-clip transcript and the take's own measurement disagree here: fall back to the
  // take's ordinary word-snapped edges rather than refusing the whole cut.
  if (start > s + 1e-9 || end < e - 1e-9) return;
  // Prefer inward whole frames, but retain an exact word boundary when no
  // whole-frame edit can both keep the word and exclude its neighbour.
  const inFrame = Math.ceil(start * fps - 1e-9) / fps;
  const outFrame = Math.floor(end * fps + 1e-9) / fps;
  return { seg: { ...seg, s, e, speechWords: words.length ? words : undefined, energyMeasured: energy, outLimitS: limit },
    start: inFrame <= s ? inFrame : start, end: outFrame >= e ? outFrame : end };
}

function buildSegments(shoot: Shoot, kind: PrecutKind): Segment[] | "reel" {
  shoot = effectiveShoot(shoot);
  if (kind === "reel") return "reel";
  const clipsById = new Map(shoot.clips.map((c) => [c.id, c]));
  if (kind === "talking") {
    return [...shoot.takes].sort((a, b) => a.lineIndex - b.lineIndex)
      .filter((t) => t.attempts.length > 0)
      .map((t) => {
        const a = t.attempts[t.starred];
        if (!a) throw new Error(`Line ${t.lineIndex + 1} has no starred take. Star a take before making a talking cut.`);
        if (a.practice) throw new Error(`Line ${t.lineIndex + 1}'s starred take is practice. Choose a recorded take first.`);
        const clip = clipsById.get(a.clipId);
        if (!clip) return null;
        const said = a.text.trim() || shoot.script[t.lineIndex] || "";
        return { clip, s: a.s, e: a.e, lineIndex: t.lineIndex,
                 marker: `line ${t.lineIndex + 1}: ${firstWords(said)}` } as Segment;
      })
      .filter((x): x is Segment => x !== null);
  }
  // broll: kind=broll clips in full or by usable span, plus the usable
  // spans of maybe-verdict clips whose summary calls them b-roll.
  const out: Segment[] = [];
  for (const clip of shoot.clips) {
    const j = clip.judgement;
    if (!j || !clip.meta) continue;
    if (j.kind === "broll") {
      const spans: [number, number][] = j.usableSpans.length > 0
        ? j.usableSpans : [[0, clip.meta.durationS]];
      for (const [s, e] of spans) {
        out.push({ clip, s, e, lineIndex: null,
                   marker: `b-roll ${clip.id}: ${firstWords(j.summary, 8)}` });
      }
    } else if (j.verdict === "maybe" && /b-?roll/i.test(j.summary)) {
      for (const [s, e] of j.usableSpans) {
        out.push({ clip, s, e, lineIndex: null,
                   marker: `b-roll ${clip.id}: ${firstWords(j.summary, 8)}` });
      }
    }
  }
  return out;
}

function cameraShort(camera: string | null): string {
  if (!camera) return "";
  if (/ILCE-7CM2/i.test(camera) || /7CM2/i.test(camera)) return "A7C II";
  return camera.replace(/^Sony\s+/i, "");
}

function resolveMetadataCsv(shoot: Shoot): string {
  shoot = effectiveShoot(shoot);
  const header = ["File Name", "Camera #", "Shot Type", "Description", "Keywords",
                  "Comments", "Good Take", "Day / Night", "Environment"];
  const lines = [header.join(",")];
  for (const clip of shoot.clips) {
    const j = clip.judgement;
    const shake = clip.shake;
    const shot = j && j.shot !== "unknown" ? j.shot : "";
    const keywords = [
      j && j.kind !== "unknown" ? j.kind : "",
      j ? j.verdict : "",
      shot,
      shake && shake.shakySpans.length > 0 ? "shaky" : "",
    ].filter(Boolean).join(", ");
    let comments = "";
    if (shake) {
      if (!shake.measured) comments = "too dark to judge";
      else if (shake.shakySpans.length > 0) {
        comments = `shaky ${shake.shakySpans.map(([a, b]) => `${formatClock(a)}-${formatClock(b)}`).join(", ")}`;
      } else comments = "steady";
    }
    let dayNight = "";
    if (clip.meta?.createdAt) {
      const m = /T(\d{2}):/.exec(clip.meta.createdAt);
      if (m) {
        const hour = Number(m[1]);
        dayNight = hour >= 6 && hour < 19 ? "Day" : "Night";
      }
    }
    const row = [
      path.basename(clip.file),
      cameraShort(clip.meta?.camera ?? null),
      shot,
      j?.summary ?? "",
      keywords,
      comments,
      j?.verdict === "best" ? "1" : "",
      dayNight,
      "", // Environment: the index records no interior/exterior data
    ];
    lines.push(row.map(csvField).join(","));
  }
  return lines.join("\n") + "\n";
}

export interface CutItem {
  handTrim?: boolean; // TL1: an explicit frame edge must survive legacy word-start repair
  piece: number; // stable input piece index; filler sub-items share it
  removed?: ClipFiller[]; // original filler timestamps, for keepFiller round trips
  seg: Segment | null; // null = gap
  inFrames: number;
  outFrames: number;
  clipFpsR: FpsRational;
  offsetFrames: number; // timeline, template fps
  durTimelineFrames: number;
}

export function cutPieceGroups(cuts: CutItem[]): { piece: number; items: CutItem[] }[] {
  const groups = new Map<number, CutItem[]>();
  cuts.forEach((cut, i) => {
    const piece = cut.piece ?? i; // saved assemblies from before filler splitting
    const items = groups.get(piece) ?? [];
    items.push(cut);
    groups.set(piece, items);
  });
  return [...groups].map(([piece, items]) => ({ piece, items }));
}

/** Repair legacy starts against today's word timings, retaining filler holes. */
export function snapCutStarts(shoot: Shoot, cuts: CutItem[], fps: number, starts?: Map<string, number>): CutItem[] {
  let shift = 0, changed = false;
  const result = cuts.map((cut, index) => {
    const first = index === 0 || (cut.piece ?? index) !== (cuts[index - 1].piece ?? index - 1);
    const rate = cut.clipFpsR.num / cut.clipFpsR.den, start = cut.inFrames / rate;
    const voice = first && !cut.handTrim && cut.seg && cut.seg.lineIndex !== null;
    // Within one index read, many versions retain the identical source span.
    const key = voice && !cut.seg!.speechWords ? JSON.stringify([cut.seg!.clip.id, cut.seg!.lineIndex, cut.seg!.marker, cut.seg!.s, cut.seg!.e, start, cut.outFrames / rate]) : undefined;
    const cached = key ? starts?.get(key) : undefined;
    const words = voice && (cached === undefined || Math.abs(cached - start) > 1e-7) ? segmentWords(shoot, cut.seg!) : [];
    let snapped = cached ?? (voice ? voiceStart(shoot, cut.seg!, start, cut.outFrames / rate, words) : start);
    if (key) starts?.set(key, snapped);
    const previous = cuts[index - 1];
    if (previous?.seg && cut.seg && previous.seg.clip.id === cut.seg.clip.id && previous.inFrames / (previous.clipFpsR.num / previous.clipFpsR.den) < start) {
      const end = previous.outFrames / (previous.clipFpsR.num / previous.clipFpsR.den);
      if (snapped < end && end <= start) {
        snapped = Math.max(start, ...words.filter(w => w.s < start && w.e > start).map(w => w.e));
      }
    }
    if (snapped >= cut.outFrames / rate) return cut;
    const delta = (start - snapped) * fps;
    const offsetFrames = cut.offsetFrames + shift;
    shift += delta;
    if (Math.abs(delta) < 1e-7 && Math.abs(offsetFrames - cut.offsetFrames) < 1e-7) return cut;
    changed = true;
    return { ...cut, inFrames: snapped * rate, offsetFrames, durTimelineFrames: cut.durTimelineFrames + delta,
      seg: cut.seg && Math.abs(delta) > 1e-7 ? { ...cut.seg, s: snapped, speechWords: words } : cut.seg };
  });
  return changed ? result : cuts;
}

// Measure safe source edits only. The judge supplied the fillers; the product
// rule removes them. Keep original filler starts so putting one back is stable.
export function splitCutItem(item: CutItem, template: Pick<Template, "fps">, keptFillers: string[] = []): CutItem[] {
  const seg = item.seg;
  if (!seg || seg.lineIndex === null) return [item];
  const fps = item.clipFpsR.num / item.clipFpsR.den;
  const start = item.inFrames, end = item.outFrames;
  const words = (seg.speechWords ?? (seg.clip.transcript ?? []).flatMap((p) => p.words))
    .filter((w) => Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s);
  const ranges: { s: number; e: number }[] = [];
  const removed: ClipFiller[] = [];
  for (const filler of seg.clip.fillers ?? []) {
    if (!Number.isFinite(filler.s) || !Number.isFinite(filler.e) || filler.e <= filler.s ||
        filler.e <= start / fps || filler.s >= end / fps || keptFillers.includes(`${seg.clip.id}@${filler.s.toFixed(2)}`)) continue;
    if (filler.kind === "pause" && seg.energyMeasured && (filler.e <= seg.s || filler.s >= seg.e)) continue;
    let s: number, e: number;
    if (filler.kind === "pause") {
      const pauseS = Math.max(start, Math.ceil(filler.s * fps - 1e-7));
      const pauseE = Math.min(end, Math.floor(filler.e * fps + 1e-7));
      const retained = Math.max(1, Math.round(.18 * fps));
      if (pauseE - pauseS <= retained) continue;
      s = pauseS + Math.floor(retained / 2);
      e = pauseE - Math.ceil(retained / 2);
    } else {
      s = Math.max(start, Math.floor((filler.s - .04) * fps + 1e-7));
      e = Math.min(end, Math.ceil((filler.e + .04) * fps - 1e-7));
    }
    let safe = [{ s, e }];
    for (const word of words) {
      // A measured quiet span is authoritative even when Whisper stretches a
      // real word across it. Lexical/voiced removals still protect real words.
      if (filler.kind === "pause" && seg.energyMeasured) continue;
      // Only the transcribed filler itself may be removed with a word filler.
      if (filler.kind === "word" && word.s >= filler.s - 1e-6 && word.e <= filler.e + 1e-6 &&
          (!seg.speechWords || /^(?:u+m+|u+h+|e+r+m*|a+h+|h+m+|m{2,})$/i.test(word.w.replace(/[^a-z]/gi, "")))) continue;
      const a = Math.floor(word.s * fps + 1e-7), b = Math.ceil(word.e * fps - 1e-7);
      safe = safe.flatMap((r) => a >= r.e || b <= r.s ? [r] :
        [{ s: r.s, e: Math.min(r.e, a) }, { s: Math.max(r.s, b), e: r.e }].filter((r) => r.e > r.s));
    }
    // A neighbouring guard must not eat into a filler the user put back,
    // including voiced fillers that have no transcribed word to protect them.
    for (const kept of seg.clip.fillers ?? []) {
      if (!keptFillers.includes(`${seg.clip.id}@${kept.s.toFixed(2)}`)) continue;
      const a = Math.floor(kept.s * fps + 1e-7), b = Math.ceil(kept.e * fps - 1e-7);
      safe = safe.flatMap((r) => a >= r.e || b <= r.s ? [r] :
        [{ s: r.s, e: Math.min(r.e, a) }, { s: Math.max(r.s, b), e: r.e }].filter((r) => r.e > r.s));
    }
    safe = safe.filter((r) => r.e > r.s);
    if (safe.length) { ranges.push(...safe); removed.push({ ...filler }); }
  }
  if (!ranges.length) return [item];
  const merged: { s: number; e: number }[] = [];
  for (const range of ranges.sort((a, b) => a.s - b.s)) {
    const last = merged.at(-1);
    if (last && range.s <= last.e) last.e = Math.max(last.e, range.e);
    else merged.push({ ...range });
  }
  const spans: { s: number; e: number }[] = [];
  let cursor = start;
  for (const range of merged) {
    if (range.s > cursor) spans.push({ s: cursor, e: range.s });
    cursor = Math.max(cursor, range.e);
  }
  if (cursor < end) spans.push({ s: cursor, e: end });
  if (!spans.length) throw new Error(`No speech remains in ${seg.marker} after removing fillers.`);
  let offset = item.offsetFrames;
  return spans.map((span, i) => {
    const duration = (span.e - span.s) / fps * template.fps;
    const cut = { ...item, inFrames: span.s, outFrames: span.e, offsetFrames: offset,
      durTimelineFrames: duration, removed: i === 0 ? removed : undefined };
    offset += duration;
    return cut;
  });
}

// Shared by FCPXML, preview, and reel assembly: exact source frames and offsets.
export function buildCutList(shoot: Shoot, kind: PrecutKind, template: Template, orderedSegments?: Segment[], keptFillers: string[] = []): CutItem[] {
  if (kind === "selects" && !orderedSegments) throw new Error("Selects need an editorial plan. Use makePrecut to build one.");
  const segments = orderedSegments ?? buildSegments(shoot, kind);
  if (segments === "reel") throw new Error("Reel precuts need an ordered attempt list.");
  const templateFps = fpsRational(template.fps);
  const PAD = kind === "reel" ? 0 : 0.15;
  const wordsByClip = new Map(shoot.clips.map((clip) => [clip.id,
    (clip.transcript ?? []).flatMap((part) => part.words)
      .filter((word) => Number.isFinite(word.s) && Number.isFinite(word.e) && word.e >= word.s),
  ]));

  // Spine items in script order.
  const items: CutItem[] = [];
  let timelineFrames = 0;
  for (const [segmentIndex, originalSeg] of segments.entries()) {
    let seg = originalSeg;
    if (seg.lineIndex !== null) seg = { ...seg, s: voiceStart(shoot, seg, seg.s) };
    const meta = seg.clip.meta;
    if (!meta) continue;
    const fpsR = fpsRational(meta.fps || template.fps);
    const clipFps = fpsR.num / fpsR.den;
    const maxFrames = Math.max(1, Math.round(meta.durationS * clipFps));
    let paddedS = Math.max(0, seg.s - PAD);
    let paddedE = Math.min(meta.durationS, seg.e + PAD);
    if (seg.lineIndex !== null) {
      for (const word of wordsByClip.get(seg.clip.id) ?? []) {
        // Whisper sometimes gives a word zero duration. A word exactly on
        // the attempt edge belongs to that attempt, not its padding guard.
        const pointAtStart = word.s === word.e && Math.abs(word.s - seg.s) < 1e-9;
        const pointAtEnd = word.s === word.e && Math.abs(word.e - seg.e) < 1e-9;
        if (!pointAtStart && word.e <= seg.s + 1e-9) paddedS = Math.max(paddedS, word.e);
        if (!pointAtEnd && word.s >= seg.e - 1e-9) paddedE = Math.min(paddedE, word.s);
        // Unaligned/weak attempts may already cross a word. Do not add more
        // of that word through padding; its "check edges" note remains.
        if (word.s < seg.s && word.e > seg.s) paddedS = seg.s;
        if (word.s < seg.e && word.e > seg.e) paddedE = seg.e;
      }
    }
    // Whole frames only: editors (Resolve included) expect edits on frame
    // boundaries. Round padding inward so it stays <= PAD, but never cut into
    // this attempt's own words; when a neighbour's word touches within one
    // frame, up to 40 ms of it is kept rather than clipping our word.
    let inFrames = Math.min(Math.ceil(paddedS * clipFps - 1e-9), Math.floor(seg.s * clipFps + 1e-9));
    let outFrames = Math.max(Math.floor(paddedE * clipFps + 1e-9), Math.ceil(seg.e * clipFps - 1e-9));
    const measured = speechEdges(shoot, seg, clipFps);
    if (measured) {
      seg = measured.seg;
      inFrames = measured.start * clipFps;
      outFrames = measured.end * clipFps;
    }
    // Padding must not replay a neighbouring attempt's words.
    const previous = segments[segmentIndex - 1];
    const next = segments[segmentIndex + 1];
    const backToBack = (other: Segment | undefined) => other &&
      other.clip.id === seg.clip.id &&
      (kind !== "selects" || other.lineIndex === seg.lineIndex);
    if (!measured && backToBack(next) && seg.s < next.s) {
      outFrames = Math.min(outFrames, Math.max(Math.ceil(seg.e * clipFps - 1e-9), Math.floor(next.s * clipFps + 1e-9)));
    }
    const previousItem = items[items.length - 1];
    if (!measured && backToBack(previous) && previous.s < seg.s && previousItem?.seg) {
      // Use the previous emitted out point, which may itself have been
      // capped above when the word-snapped windows share boundary words.
      inFrames = Math.max(inFrames, previousItem.outFrames);
    }
    if (originalSeg.authoredBounds) {
      inFrames = Math.max(inFrames, Math.ceil(originalSeg.s * clipFps - 1e-9));
      outFrames = Math.min(outFrames, Math.floor(originalSeg.e * clipFps + 1e-9));
    }
    inFrames = Math.max(0, Math.min(inFrames, maxFrames));
    outFrames = Math.min(outFrames, maxFrames);
    if (outFrames <= inFrames) throw new Error(`No non-overlapping span for ${seg.marker}. Check its edges.`);
    // Keep offsets/durations consistent with precise source cuts, including
    // between-frame speech edges; otherwise neighbouring timeline clips overlap.
    const durTimeline = ((outFrames - inFrames) / clipFps) * template.fps;
    const subcuts = splitCutItem({ piece: segmentIndex, seg, inFrames, outFrames,
      clipFpsR: fpsR, offsetFrames: timelineFrames, durTimelineFrames: durTimeline }, template, keptFillers);
    items.push(...subcuts);
    timelineFrames += subcuts.reduce((sum, c) => sum + c.durTimelineFrames, 0);
  }

  return items;
}

// Selects has its own editorial planner. Rebuild only measured take groups
// here so the timeline, alternate bins and previews share the export edge rule.
export function applySelectSpeechEdges(shoot: Shoot, plan: SelectsPlan, template: Template): SelectsPlan {
  let offset = 0;
  const lines = plan.lines.map((line) => {
    const rebuild = (group: CutItem[]) => {
      const first = group[0];
      if (!first?.seg || !measuredAttempt(shoot, first.seg)) return group.map((c) => ({ ...c,
        offsetFrames: offset + c.offsetFrames - first.offsetFrames }));
      const rebuilt = buildCutList(shoot, "selects", template, [first.seg]);
      return rebuilt.map((c) => ({ ...c, piece: line.piece, offsetFrames: offset + c.offsetFrames }));
    };
    const main = rebuild(line.main), alternates = line.alternates.map(rebuild);
    offset += main.reduce((sum, c) => sum + c.durTimelineFrames, 0);
    return { ...line, main, alternates };
  });
  return { ...plan, lines, cuts: lines.flatMap((line) => line.main) };
}

// QA can redirect output and skip sync to keep the input index read-only.
export async function makePrecut(root: string, kind: PrecutKind, templateId: string, opts: { reel?: ReelOptions; outputFolder?: string; skipMicSync?: boolean; reelCatalog?: boolean } = {}): Promise<PrecutResult> {
  // Temporary bridge until the shared API gains listMusicTracks (R2 scope).
  if (opts.reelCatalog) return Object.assign({ folder: "", preview: null, lengthS: 0 }, { catalog: await reelCatalog() });
  if (kind === "reel") {
    if (!opts.reel) throw new Error("Add the concept and length for this reel.");
    if (!opts.skipMicSync) await runMicSync(root);
    return makeReel(root, templateId, opts.reel, opts);
  }

  // Mic sync first (cached in the index by pipeline/sync.py), then reload.
  if (!opts.skipMicSync) await runMicSync(root);
  const indexFile = path.join(root, ".sidething", "index.json");
  let shoot: Shoot;
  try {
    shoot = JSON.parse(await fs.promises.readFile(indexFile, "utf8")) as Shoot;
  } catch {
    throw new Error("Could not read this shoot. Check the drive is connected and try again.");
  }

  const templates = await listTemplates();
  const fallback = templates.find((t) => t.id === templateId || t.name === templateId);
  if (!fallback) throw new Error(`Template not found: ${templateId}`);
  const template = skillTemplate(await listSkills(), [], shoot, fallback);
  if (template.id !== fallback.id) await saveTemplate(template);
  if (!template) throw new Error(`Template not found: ${templateId}`);

  if (kind === "selects") return exportCutList(root, shoot, kind, sourceTemplate(shoot, template), [], { outputFolder: opts.outputFolder, ...(opts.outputFolder ? { existingPreview: null } : {}) });
  const segments = buildSegments(shoot, kind);
  if (segments === "reel") throw new Error("Reels need an ordered attempt list.");
  if (segments.length === 0) throw new Error("Nothing to put in this precut yet.");

  return exportCutList(root, shoot, kind, template, buildCutList(shoot, kind, template), { outputFolder: opts.outputFolder, ...(opts.outputFolder ? { existingPreview: null } : {}) });
}

// Selects are a source library, not a reel: their timeline keeps the camera's
// own frame (the most common size and rate among the talking clips), never a
// skill's delivery format.
function sourceTemplate(shoot: Shoot, fallback: Template): Template {
  const metas = shoot.clips.filter((c) => c.meta && c.meta.width > 0).map((c) => c.meta!);
  const counts = new Map<string, number>();
  for (const m of metas) { const k = `${m.width}x${m.height}@${m.fps}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!top) return fallback;
  const [size, fps] = top.split("@");
  const [width, height] = size.split("x").map(Number);
  return { id: `source-${size}-${fps}`, name: `source ${size} ${fps} fps`, width, height, fps: Number(fps), drpPath: fallback.drpPath, notes: "The camera's own format" };
}

export async function exportCutList(root: string, shoot: Shoot, kind: PrecutKind, template: Template,
  cutList: CutItem[], opts: { outputFolder?: string; folderName?: string; reel?: ReelAssembly; existingPreview?: string | null; finishing?: ExportFinishing; skipFinishing?: boolean; selects?: SelectsPlan } = {}): Promise<PrecutResult> {
  shoot = { ...shoot, clips: shoot.clips.map(displayedClip) };
  cutList = cutList.map(c => c.seg ? { ...c, seg: { ...c.seg, clip: displayedClip(c.seg.clip) } } : c);
  const finishing = opts.skipFinishing ? undefined : opts.finishing ?? await savedExportFinishing(root, cutList, opts);
  if (finishing) {
    const { exportForEditor } = await import("./editors");
    return exportForEditor("resolve", { root, shoot, kind, template, cutList, opts: { ...opts, finishing },
      previewPath: opts.existingPreview ?? null });
  }
  const selects = opts.selects ?? (kind === "selects" ? applySelectSpeechEdges(shoot,
    await planSelects(root, shoot, template, opts.outputFolder), template) : undefined);
  cutList = selects?.cuts ?? cutList;
  const allCuts = [...cutList, ...(selects?.lines.flatMap((l) => l.alternates.flat()) ?? []), ...(selects?.broll ?? [])];
  if (!cutList.length) throw new Error([...(selects?.warnings ?? []), "Nothing to put in this precut yet."].join(" "));
  const segments = allCuts.flatMap((cut) => cut.seg ? [cut.seg] : []);
  const templateFps = fpsRational(template.fps);

  // Assets and source formats, in first-use order.
  const assetIdByClip = new Map<string, string>();
  const assets: { id: string; clip: Clip; startFrames: number; fpsR: FpsRational; formatId: string }[] = [];
  const formatIdByKey = new Map<string, string>();
  let formatCount = 1; // r1 is the template (sequence) format
  const sourceFormatId = (clip: Clip): string => {
    const meta = { ...clip.meta!, ...clipFileDimensions(clip) };
    const r = fpsRational(meta.fps || template.fps);
    const key = `${meta.width}x${meta.height}@${r.num}/${r.den}`;
    let id = formatIdByKey.get(key);
    if (!id) {
      if (meta.width === template.width && meta.height === template.height &&
          r.num === templateFps.num && r.den === templateFps.den) {
        id = "r1";
      } else {
        formatCount += 1;
        id = `r${formatCount}`;
      }
      formatIdByKey.set(key, id);
    }
    return id;
  };
  const ensureAsset = (clip: Clip): string => {
    let id = assetIdByClip.get(clip.id);
    if (id) return id;
    id = `a${assets.length + 1}`;
    assetIdByClip.set(clip.id, id);
    const fpsR = fpsRational(clip.meta?.fps || template.fps);
    assets.push({ id, clip, startFrames: tcToFrames(clip.meta?.startTimecode ?? null, clip.meta?.fps || template.fps), fpsR, formatId: sourceFormatId(clip) });
    return id;
  };

  // Clip.sound is camera t=0's position INSIDE the recorder (add it).
  // Legacy syncedTo has the opposite sign and is intentionally not consulted.
  const micByClip = new Map<string, { file: string; offsetS: number; durationS: number; channels: number; assetId: string }>();
  const micByFile = new Map<string, { file: string; durationS: number; channels: number; assetId: string }>();
  for (const seg of segments) {
    const sound = seg.clip.sound;
    if (!sound || micByClip.has(seg.clip.id)) continue;
    const entry = shoot.audio.find((a) => a.file === sound.file);
    if (!entry || !Number.isFinite(entry.durationS) || entry.durationS <= 0 || !Number.isFinite(sound.offsetS)) {
      throw new Error(`Cannot export mic sound for ${seg.clip.id}: recorder metadata is missing or invalid.`);
    }
    let mic = micByFile.get(sound.file);
    if (!mic) {
      mic = { ...entry, assetId: `m${micByFile.size + 1}` };
      micByFile.set(sound.file, mic);
    }
    micByClip.set(seg.clip.id, { ...mic, offsetS: sound.offsetS });
  }

  const items = cutList.map((item) => ({ ...item, assetId: item.seg ? ensureAsset(item.seg.clip) : "" }));
  for (const item of allCuts) if (item.seg) ensureAsset(item.seg.clip);
  for (const overlay of opts.reel?.broll ?? []) ensureAsset(overlay.seg.clip);
  const timelineFrames = items.reduce((sum, item) => sum + item.durTimelineFrames, 0);

  // Formats block: r1 (template) plus any distinct source formats.
  const formatLines: string[] = [
    `<format id="r1" name="${xmlEscape(`${template.width}x${template.height}p${template.fps}`)}" frameDuration="${frameDurationOf(templateFps)}" width="${template.width}" height="${template.height}"/>`,
  ];
  const seenFormats = new Set<string>(["r1"]);
  for (const a of assets) {
    if (seenFormats.has(a.formatId)) continue;
    seenFormats.add(a.formatId);
    const meta = { ...a.clip.meta!, ...clipFileDimensions(a.clip) };
    formatLines.push(`<format id="${a.formatId}" name="${xmlEscape(`${meta.width}x${meta.height}p${meta.fps}`)}" frameDuration="${frameDurationOf(a.fpsR)}" width="${meta.width}" height="${meta.height}"/>`);
  }

  const assetLines: string[] = [];
  const sourceChannels = new Map<string, string>();
  for (const a of assets) {
    const meta = { ...a.clip.meta!, ...clipFileDimensions(a.clip) };
    const durFrames = Math.max(1, Math.round(meta.durationS * (meta.fps || template.fps)));
    const abs = path.isAbsolute(a.clip.file) ? a.clip.file : path.join(root, a.clip.file);
    const src = pathToFileURL(fs.realpathSync(abs)).href;
    const inventory = await sourceAudioChannels(abs);
    sourceChannels.set(a.id, Array.from({ length: Math.min(2, inventory.stream?.channels ?? 0) }, (_, n) =>
      `<audio-channel-source srcCh="${inventory.firstChannel + n}" role="dialogue.cam-${n + 1}" active="1"/>`).join(''));
    assetLines.push(
      `<asset id="${a.id}" name="${xmlEscape(a.clip.id)}" start="${timeAt(a.startFrames, a.fpsR)}" duration="${timeAt(durFrames, a.fpsR)}" hasVideo="1" hasAudio="${inventory.stream ? 1 : 0}" format="${a.formatId}" audioSources="${inventory.sources}" audioChannels="${inventory.stream ? inventory.channels : 0}" audioRate="${meta.sampleRate || 48000}"><media-rep kind="original-media" src="${xmlEscape(src)}"/></asset>`,
    );
  }
  for (const mic of micByFile.values()) {
    const abs = path.isAbsolute(mic.file) ? mic.file : path.join(root, mic.file);
    const src = pathToFileURL(fs.realpathSync(abs)).href;
    const inventory = await sourceAudioChannels(abs);
    assetLines.push(
      `<asset id="${mic.assetId}" name="${xmlEscape(path.basename(mic.file))}" start="0s" duration="${Math.round(mic.durationS * 1000)}/1000s" hasVideo="0" hasAudio="1" audioSources="${inventory.sources}" audioChannels="${inventory.stream ? inventory.channels : 0}"><media-rep kind="original-media" src="${xmlEscape(src)}"/></asset>`,
    );
  }

  const music = opts.reel?.music;
  if (music) assetLines.push(`<asset id="reel-music" name="${xmlEscape(path.basename(music.file))}" start="0s" duration="${Math.round(music.durationS * 1000)}/1000s" hasVideo="0" hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"><media-rep kind="original-media" src="${xmlEscape(pathToFileURL(music.file).href)}"/></asset>`);

  // Resolve imports synchronized A/V as compounds (Resolve 20 manual,
  // ch.55). Keep the sound inside a referenced take, and attach alternates to
  // the reference OUTSIDE that compound, so they become editable video lanes.
  const mediaLines: string[] = [];
  const mediaByCut = new Map<string, string>();
  const channelRouting = new Map<string, string>(sourceChannels);
  const { editorChannelSources } = await import("./voice-isolation");
  for (const asset of assets) if (asset.clip.meta!.audioChannels > 0 && segments.some(seg => seg.clip.id === asset.clip.id && seg.lineIndex !== null)) channelRouting.set(asset.id,
    await editorChannelSources(root, path.resolve(root, asset.clip.file), "cam"));
  for (const mic of micByFile.values()) channelRouting.set(mic.assetId,
    await editorChannelSources(root, path.resolve(root, mic.file), "mic"));
  const seconds = (s: number) => timeAt(s * template.fps, templateFps);
  const clipXml = (item: CutItem, offset: string, anchors: string[] = [], lane?: number, disabled = false): string => {
    const seg = item.seg!;
    const asset = assets.find((a) => a.clip.id === seg.clip.id)!;
    const sourceStart = timeAt(asset.startFrames + item.inFrames, asset.fpsR);
    const duration = seconds(item.durTimelineFrames / template.fps);
    const attrs = `name="${xmlEscape(seg.marker)}" offset="${offset}" duration="${duration}"${lane === undefined ? "" : ` lane="${lane}"`}${disabled ? ' enabled="0"' : ""}`;
    const rotation = clipTransformXml(seg.clip);
    const mic = micByClip.get(seg.clip.id);
    const channels = channelRouting.get(asset.id) ?? Array.from({ length: Math.min(2, seg.clip.meta!.audioChannels) }, (_, n) =>
      `<audio-channel-source srcCh="${n + 1}" role="dialogue.cam-${n + 1}" active="1"/>`).join("");
    if (mic || selects) {
      const key = `${asset.id}:${item.inFrames}:${item.outFrames}`;
      let id = mediaByCut.get(key);
      if (!id) {
        id = `take${mediaByCut.size + 1}`;
        mediaByCut.set(key, id);
        const sourceS = item.inFrames / (asset.fpsR.num / asset.fpsR.den);
        const lengthS = item.durTimelineFrames / template.fps;
        let content: string;
        if (mic) {
          const recorderS = sourceS + mic.offsetS;
          const delay = Math.max(0, -recorderS);
          const micStart = Math.max(0, recorderS);
          const micLength = Math.min(lengthS - delay, mic.durationS - micStart);
          if (!(micLength > 0)) throw new Error(`Mic does not cover ${seg.marker}. Check its sound offset.`);
          content = `<sync-clip name="${xmlEscape(seg.marker)}" offset="0s" start="0s" duration="${duration}" format="r1"><asset-clip ref="${asset.id}" offset="0s" start="${sourceStart}" duration="${duration}" srcEnable="video">${rotation}</asset-clip><asset-clip ref="${mic.assetId}" lane="-1" offset="${seconds(delay)}" start="${seconds(micStart)}" duration="${seconds(micLength)}" audioRole="dialogue.mic">${channelRouting.get(mic.assetId) ?? ""}</asset-clip></sync-clip>`;
        } else {
          // Distinct trimmed resources preserve the named bin entries even
          // when several subclips refer to the same camera original.
          content = `<asset-clip ref="${asset.id}" name="${xmlEscape(seg.marker)}" offset="0s" start="${sourceStart}" duration="${duration}">${rotation}<marker start="${sourceStart}" duration="${frameDurationOf(asset.fpsR)}" value="${xmlEscape(seg.marker)}"/>${channels}</asset-clip>`;
        }
        mediaLines.push(`<media id="${id}" name="${xmlEscape(seg.marker)}"><sequence format="r1" duration="${duration}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>${content}</spine></sequence></media>`);
      }
      return `<ref-clip ref="${id}" ${attrs} start="0s">${anchors.join("")}<marker start="0s" duration="${frameDurationOf(templateFps)}" value="${xmlEscape(seg.marker)}"/></ref-clip>`;
    }
    return `<asset-clip ref="${asset.id}" ${attrs} start="${sourceStart}">${anchors.join("")}${rotation}<marker start="${sourceStart}" duration="${frameDurationOf(asset.fpsR)}" value="${xmlEscape(seg.marker)}"/>${channels}</asset-clip>`;
  };
  // An alternate is one editable take containing honest jump cuts. Keeping
  // its sub-items inside a named sequence makes enabling it switch all of them.
  const groupMedia = new Map<string, string>();
  const groupXml = (group: CutItem[], offset: string, lane?: number, disabled = false): string => {
    if (group.length === 1) return clipXml(group[0], offset, [], lane, disabled);
    const key = group.map((c) => `${c.seg!.clip.id}:${c.inFrames}:${c.outFrames}`).join("|");
    let id = groupMedia.get(key);
    const duration = seconds(group.reduce((s, c) => s + c.durTimelineFrames / template.fps, 0));
    const name = xmlEscape(group[0].seg!.marker);
    if (!id) {
      id = `selects-group${groupMedia.size + 1}`;
      groupMedia.set(key, id);
      let offsetS = 0;
      const content = group.map((c) => {
        const xml = clipXml(c, seconds(offsetS));
        offsetS += c.durTimelineFrames / template.fps;
        return xml;
      }).join("");
      mediaLines.push(`<media id="${id}" name="${name}"><sequence format="r1" duration="${duration}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>${content}</spine></sequence></media>`);
    }
    return `<ref-clip ref="${id}" name="${name}" offset="${offset}" start="0s" duration="${duration}"${lane === undefined ? "" : ` lane="${lane}"`}${disabled ? ' enabled="0"' : ""}><marker start="0s" duration="${frameDurationOf(templateFps)}" value="${name}"/></ref-clip>`;
  };
  const spineLines: string[] = [];
  const laneEnds = new Map<number, number>();
  for (const [itemIndex, item] of items.entries()) {
    if (!item.seg) {
      spineLines.push(`<gap name="Gap" offset="${timeAt(item.offsetFrames, templateFps)}" start="0s" duration="${timeAt(item.durTimelineFrames, templateFps)}"/>`);
      continue;
    }
    const asset = assets.find((a) => a.id === item.assetId)!;
    // Connected offsets are in their parent's source coordinate system.
    const parentStart = selects || micByClip.has(item.seg.clip.id) ? "0s" : timeAt(asset.startFrames + item.inFrames, asset.fpsR);
    const anchors: string[] = [];
    let lane = 1;
    const line = selects?.lines.find((l) => l.piece === item.piece);
    if (line?.main[0] === cutList[itemIndex]) for (const alt of line.alternates) {
      while ((laneEnds.get(lane) ?? 0) > item.offsetFrames + 1e-7) lane++;
      anchors.push(groupXml(alt, parentStart, lane, true));
      laneEnds.set(lane, item.offsetFrames + alt.reduce((s, c) => s + c.durTimelineFrames, 0));
      lane++;
    }
    const pieceStart = items.find((c) => c.piece === item.piece)!.offsetFrames;
    const pieceElapsedS = (item.offsetFrames - pieceStart) / template.fps;
    for (const overlay of opts.reel?.broll.filter((b) => b.voiceIndex === item.piece) ?? []) {
      const bAsset = assets.find((a) => a.clip.id === overlay.seg.clip.id)!;
      const bFps = overlay.seg.clip.meta!.fps || template.fps;
      const bIn = Math.ceil(overlay.seg.s * bFps) + pieceElapsedS * bFps;
      const durationS = Math.min((Math.floor(overlay.seg.e * bFps) - bIn) / bFps, item.durTimelineFrames / template.fps);
      if (durationS <= 0) continue;
      anchors.push(`<asset-clip ref="${bAsset.id}" lane="1" name="${xmlEscape(overlay.id + ": " + overlay.seg.marker)}" offset="${parentStart}" start="${timeAt(bAsset.startFrames + bIn, bAsset.fpsR)}" duration="${seconds(durationS)}" srcEnable="video">${clipTransformXml(overlay.seg.clip)}</asset-clip>`);
    }
    if (music && itemIndex === 0) {
      const musicDuration = Math.min(timelineFrames / template.fps, music.endS ?? Infinity, music.durationS - music.startS);
      anchors.push(`<asset-clip ref="reel-music" lane="-2" name="${xmlEscape(path.basename(music.file))}" offset="${parentStart}" start="${seconds(music.startS)}" duration="${seconds(musicDuration)}" audioRole="music"><adjust-volume amount="${music.gainDb}dB"><param name="amount" value="${music.gainDb}dB"><fadeOut type="linear" duration="${Math.min(1, musicDuration)}s"/></param></adjust-volume></asset-clip>`);
    }
    // Standalone reel B-roll remains picture-only.
    const xml = clipXml(item, timeAt(item.offsetFrames, templateFps), anchors);
    spineLines.push(opts.reel && item.seg.lineIndex === null
      ? xml.replace(/<(asset-clip|ref-clip) /, '<$1 srcEnable="video" ') : xml);
  }
  const binEvents = selects ? [
    `<event name="Lines">${selects.lines.flatMap((l) => [l.main, ...l.alternates]).filter((g) => g.length).map((g) => groupXml(g, "0s")).join("\n")}</event>`,
    `<event name="B-roll">${selects.broll.map((c) => clipXml(c, "0s")).join("\n")}</event>`,
  ] : [];
  const totalSeconds = timelineFrames / template.fps;

  const shootName = shoot.name || path.basename(root);
  const projectName = opts.reel?.title ?? `${shootName} - ${kind}`;
  const fcpxml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE fcpxml>`,
    `<fcpxml version="1.9"><resources>`,
    ...formatLines,
    ...assetLines,
    ...mediaLines,
    `</resources><library><event name="${xmlEscape(shootName)}"><project name="${xmlEscape(projectName)}">`,
    `<sequence format="r1" duration="${timeAt(timelineFrames, templateFps)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>`,
    ...spineLines,
    `</spine></sequence></project></event>`,
    ...binEvents,
    `</library></fcpxml>`,
    ``,
  ].join("\n");

  // Sidekick exports use their title/version; ordinary precuts retain timestamps.
  // Keep model titles inside one visible folder on both macOS and Windows.
  const baseName = opts.folderName?.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 180) || `${kind} ${stampOf(new Date())}`;
  const precutsDir = opts.outputFolder ? path.resolve(opts.outputFolder) : path.join(root, "sidething precuts");
  let folder = path.join(precutsDir, baseName);
  for (let n = 2; fs.existsSync(folder); n += 1) {
    folder = path.join(precutsDir, `${baseName} (${n})`);
  }
  await fs.promises.mkdir(folder, { recursive: true });

  const clipCount = items.filter((i) => i.seg !== null).length;
  const fcpName = `${shootName} - ${kind}.fcpxml`;
  const vertical = template.height > template.width;
  const readme = [
    `sidething precut: ${kind} from "${shootName}" - ${clipCount} clips, about ${Math.round(totalSeconds)} seconds, one timeline at ${template.width}x${template.height} ${template.fps}p (${fcpName}).`,
    `Export folder: ${folder}`,
    `To import: open your template project in Resolve, then File › Import › Timeline and pick ${fcpName}.`,
    `Then File › Import › Metadata, pick resolve-metadata.csv and match by file name so descriptions and good-take flags land on your clips.`,
    `Audio: Clip.sound uses the original recorder at camera source time + offsetS; camera audio is off inside that synchronized compound. Without Clip.sound, camera channels are dialogue.cam-1/cam-2.`,
    `Breath, mouth click and plosive cleanup is included in the finished video and prepared editor voice WAVs when enabled. This cuts-only Resolve timeline uses original sound and does not carry that cleanup.`,
    `Placed sound effects, room tone and ambience are included in the finished video when enabled. This cuts-only timeline does not carry sound design; recreate it in Resolve using the finished MP4 as the reference.`,
    ...(selects ? [
      ...selects.warnings.map((w) => `Warning: ${w}`),
      `Selects: starred takes play once in script order. Disabled takes sit above each line, next best lowest; their full trimmed lengths are retained. Longer alternates may overlap the next line and need a ripple/trim when chosen.`,
      `Swap a take: keep Linked Selection on; disable the current take (right-click > Enable Clip), then enable one alternate above its line. Its mic is inside the same compound, so sound switches with picture. Adjust the following edit for a longer or shorter take.`,
      `Bins: named Lines and B-roll events contain independent trimmed resources referencing originals. Resolve event-to-bin preservation is not verified; if those bins do not appear, create them in the Media Pool and move the numbered take compounds into Lines. For B-roll, use the original and the source in/out below to Make Subclip in B-roll. The inventory is below.`,
      ...selects.lines.flatMap((l) => [...l.main, ...l.alternates.flat()]).concat(selects.broll).map((c) => {
        const fps = c.clipFpsR.num / c.clipFpsR.den;
        return `${c.seg!.lineIndex === null ? "B-roll" : "Lines"}: ${c.seg!.marker} | ${c.seg!.clip.file} | source seconds ${(c.inFrames / fps).toFixed(3)}–${(c.outFrames / fps).toFixed(3)} | ${c.seg!.clip.sound ? `mic ${c.seg!.clip.sound.file}` : "camera sound"}`;
      }),
    ] : []),
    ...allCuts.flatMap((c) => (c.removed ?? []).map((f) =>
      `Removed ${f.kind}${f.text ? ` "${f.text}"` : ""} from ${c.seg!.marker}: ${f.s.toFixed(3)}–${f.e.toFixed(3)} s (restore ${c.seg!.clip.id}@${f.s.toFixed(2)}).`)),
    vertical
      ? `Vertical: no transform is baked in - Resolve's project setting decides fit or fill for how these sources sit in the ${template.width}x${template.height} frame.`
      : `Fit/fill: no transform is baked in - if a source differs from ${template.width}x${template.height}, Resolve's project setting decides fit or fill.`,
    ...(allCuts.some((c, i) => framingChoice(opts.finishing ?? finishing ?? {}, c.piece ?? i).mode !== "off") ? [motionReadme] : []),
    ...(opts.reel ? [``, opts.reel.title, opts.reel.why, ...opts.reel.warnings.map((w) => `Warning: ${w}`), ...(opts.reel.missing ?? []).map((m) => `Missing: ${m}`),
      ...(music ? [`Music: ${path.basename(music.file)} from ${music.startS.toFixed(2)} s, ${music.gainDb} dB, music role on lane -2, final 1 s fade.`] : [])] : []),
    ``,
  ].join("\n");

  await fs.promises.writeFile(path.join(folder, fcpName), fcpxml);
  await fs.promises.writeFile(path.join(folder, "resolve-metadata.csv"), resolveMetadataCsv(shoot));
  await fs.promises.writeFile(path.join(folder, "README.txt"), readme);
  const lengthS = timelineFrames / template.fps;
  const preview = opts.existingPreview !== undefined ? opts.existingPreview :
    await renderCutPreview(root, cutList, template, path.basename(folder), opts.reel);
  // Persist marker offsets next to the timeline; playback needs the padded cuts,
  // not the raw take windows. Kept outside the shared IPC contract for now.
  const metadata = JSON.stringify({
    kind, preview, lengthS, createdAt: new Date().toISOString(), templateName: template.name,
    ...(opts.reel ? { reel: opts.reel } : {}),
    warnings: selects?.warnings ?? opts.reel?.warnings ?? [],
    removed: allCuts.flatMap((c) => (c.removed ?? []).map((f) => ({ piece: c.piece, clipId: c.seg!.clip.id, ...f }))),
    markers: cutList.flatMap((item) => item.seg ? [{
      label: item.seg.marker, s: item.offsetFrames / template.fps,
    }] : []),
  }, null, 2) + "\n";
  try { await fs.promises.writeFile(path.join(folder, "precut.json"), metadata); }
  catch (error) { console.warn("Could not save precut history metadata:", error); }
  if (opts.reel) await fs.promises.writeFile(path.join(folder, "reel.json"), JSON.stringify(opts.reel, null, 2) + "\n");
  if (preview || opts.reel) {
    await fs.promises.mkdir(path.join(root, ".sidething", "precuts"), { recursive: true });
    try { await fs.promises.writeFile(path.join(root, ".sidething", "precuts", `${path.basename(folder)}.json`), metadata); }
    catch (error) { console.warn("Could not save preview markers:", error); }
  }
  return { folder, preview, lengthS };
}

// Tolerate older exports and an interrupted/malformed metadata file per folder.
export async function listPrecuts(root: string): Promise<{ name: string; folder: string; kind: PrecutKind | null; preview: string | null; lengthS: number | null; createdAt: string }[]> {
  const dir = path.join(root, "sidething precuts");
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const folder = path.join(dir, entry.name);
    const stat = await fs.promises.stat(folder);
    let metadata: { preview?: unknown; lengthS?: unknown; kind?: unknown; createdAt?: unknown; reel?: ReelAssembly } = {};
    try { metadata = JSON.parse(await fs.promises.readFile(path.join(folder, "precut.json"), "utf8")) ?? {}; } catch { /* older export */ }
    const candidate = typeof metadata.preview === "string" ? metadata.preview : `${entry.name}.mp4`;
    const preview = path.basename(candidate) === candidate && candidate.endsWith(".mp4") &&
      fs.existsSync(path.join(root, ".sidething", "precuts", candidate)) ? candidate : null;
    const kind = ["talking", "selects", "broll", "reel"].find((k) => k === metadata.kind || entry.name.startsWith(`${k} `)) as PrecutKind | undefined;
    let lengthS = typeof metadata.lengthS === "number" && Number.isFinite(metadata.lengthS) ? metadata.lengthS : null;
    if (lengthS === null) {
      const files = await fs.promises.readdir(folder);
      const xmlName = files.find((file) => file.endsWith(".fcpxml"));
      if (xmlName) {
        const xml = await fs.promises.readFile(path.join(folder, xmlName), "utf8");
        const duration = /<sequence\b[^>]*\bduration="([\d.]+)(?:\/([\d.]+))?s"/.exec(xml);
        if (duration) lengthS = Number(duration[1]) / Number(duration[2] ?? 1);
      }
    }
    return { name: entry.name, folder, kind: kind ?? null, preview, lengthS, ...(metadata.reel ? { reel: metadata.reel } : {}),
      createdAt: typeof metadata.createdAt === "string" ? metadata.createdAt : stat.birthtime.toISOString() };
  }));
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
}

// Sidekick versions render here too, without creating a Resolve export folder.
export async function renderCutPreview(root: string, cuts: CutItem[], template: Template,
  name: string, reel?: ReelAssembly): Promise<string | null> {
  let preview: string | null = null;
  try {
    // Standalone b-roll is picture only; keep its location audio off the spine.
    const previewCuts = reel ? cuts.map((c) => c.seg?.lineIndex === null ? {
      ...c, seg: { ...c.seg, clip: { ...c.seg.clip, meta: { ...c.seg.clip.meta!, audioChannels: 0 } } },
    } : c) : cuts;
    preview = await renderPreview(root, previewCuts, { name, template, music: reel?.music });
    if (reel && (reel.broll.length || reel.music)) {
      await compositeReelPreview(root, preview, cuts, template, reel.broll, reel.music);
    }
    return preview;
  } catch (error) {
    if (preview) await fs.promises.rm(path.join(root, ".sidething", "precuts", preview), { force: true }).catch(() => undefined);
    console.warn(`Could not render precut preview for ${name}:`, error);
    return null;
  }
}

// N9: shared by the finished video and each editor export folder.
export async function writeExportCover(root: string, cutId: string, record: import("./sidekick").StoredVersion, folder: string, finishedVideo?: string): Promise<string> {
  const source = await (await import("./cover")).renderCover(root, cutId, record, finishedVideo);
  const output = path.join(folder, "cover.jpg");
  await fs.promises.copyFile(source, output);
  const readme = path.join(folder, "README.txt");
  try {
    const text = await fs.promises.readFile(readme, "utf8");
    const note = "Cover: cover.jpg is the finished, graded still with its cover title. The editor timeline keeps original ungraded picture; the cover title is a separate image, not a timeline effect.";
    if (!text.includes(note)) await fs.promises.appendFile(readme, `\n${note}\n`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return output;
}

/** Compatibility names for local tooling. There is only one timeline writer;
 * Resolve uses the same layered FCPXML projection as Final Cut. */
export async function fxResolveXml(input: import('./editors').EditorInput): Promise<string> {
  return (await import('./editors')).writeFinalCutXml(input, false).then(xml =>
    xml.replace('<fcpxml version="1.10">', '<fcpxml version="1.9">'));
}
export async function exportFxResolve(input: import('./editors').EditorInput): Promise<PrecutResult> {
  return (await import('./editors')).exportForEditor('resolve', input);
}

// D6: one immutable snapshot, one media lane and one cancelable activity.
// This path only projects saved decisions; it never asks a model to finish a cut.
type ExportAspect = import('../shared/schema').SkillFormat['aspect'];
type BatchExport = Awaited<ReturnType<import('../shared/schema').Api['exportTo']>>;
const exportAspects: ExportAspect[] = ['9:16', '16:9', '1:1', '4:5'];
export function exportAspect(width: number, height: number): ExportAspect {
  const aspect = exportAspects.find(value => {
    const [w, h] = value.split(':').map(Number);
    return Math.abs(width / height - w / h) < .01;
  });
  if (!aspect) throw new Error('This edit has an unsupported format.');
  return aspect;
}

/** Format-specific layout on a clone. Shared cuts, music and look stay intact. */
export async function exportFormat(source: import('./sidekick').StoredVersion, aspect: ExportAspect) {
  const record = structuredClone(source), assembly = record.assembly;
  // EXP3: the file plays at a standard rate. Edits made before kept a phone's average (59.89 for an iPhone 60): every
  // frame count on the timeline scales by one factor, so each piece starts and lasts the same in seconds.
  const rate = standardFrameRate(assembly.template.fps);
  if (rate !== assembly.template.fps && Number.isFinite(rate) && rate > 0) {
    const k = rate / assembly.template.fps;
    assembly.template = { ...assembly.template, fps: rate };
    assembly.cutList = assembly.cutList.map(cut => ({ ...cut, offsetFrames: cut.offsetFrames * k, durTimelineFrames: cut.durTimelineFrames * k }));
  }
  const base = exportAspect(assembly.template.width, assembly.template.height);
  const variant = record.formats?.find(format => format.aspect === aspect);
  if (aspect !== base && !variant) throw new Error(`This edit does not have a ${aspect} format.`);
  if (variant) {
    if (![variant.width, variant.height].every(n => Number.isFinite(n) && n > 0 && n % 2 === 0) || exportAspect(variant.width, variant.height) !== aspect) {
      throw new Error(`Invalid dimensions for ${aspect}.`);
    }
    assembly.template = { ...assembly.template, width: variant.width, height: variant.height, drpPath: null };
    record.framing = variant.framing ?? record.framing;
    if (variant.pieceFraming) record.pieceFx = Array.from({ length: Math.max(record.pieces?.length ?? 0, variant.pieceFraming.length) }, (_, index) => ({ ...record.pieceFx?.[index], framing: variant.pieceFraming?.[index] ?? record.framing }));
    record.overlays = record.overlays?.map(item => ({ ...item, ...variant.overlays?.[item.id] }));
    if (variant.cover !== undefined) record.cover = variant.cover;
    if (variant.captions && record.titles) {
      const { buildCaptionTrack, captionWordsForVersion, captionSafeArea, DEFAULT_CAPTION_STYLE } = await import('./titles/captions');
      record.titles = buildCaptionTrack(captionWordsForVersion(assembly.shoot, record), record.titles,
        { ...(record.titles.captionStyle ?? DEFAULT_CAPTION_STYLE), ...variant.captions }, captionSafeArea());
    }
  }
  // Never reuse a cached video from another layout.
  if (aspect !== base || variant) { record.preview = null; record.finished = null; }
  return record;
}

// EXP3: an export that fails says why in plain words, mapped from the error's code where the code knows the cause and
// from what is on disk where it does not (a renderer's exit carries no code). It never shows a code or a path.
type ExportRecord = import('./sidekick').StoredVersion;
const nameOf = (file: string) => path.basename(file);
/** Camera originals the edit's pictures come from (its pieces and B-roll) that are gone from the shoot folder. */
function missingOriginals(root: string, record: ExportRecord, also?: string): Clip[] {
  const used = new Map<string, Clip>();
  for (const cut of record.assembly.cutList) if (cut.seg) used.set(cut.seg.clip.id, cut.seg.clip);
  for (const overlay of record.assembly.reel?.broll ?? []) used.set(overlay.seg.clip.id, overlay.seg.clip);
  if (also) for (const clip of record.assembly.shoot.clips) if (path.resolve(root, clip.photo?.file ?? clip.file) === path.resolve(also)) used.set(clip.id, clip);
  return [...used.values()].filter(clip => !fs.existsSync(path.resolve(root, clip.photo?.file ?? clip.file)));
}
function missingMessage(clips: Clip[]): string {
  const names = [...new Set(clips.map(clip => nameOf(clip.photo?.file ?? clip.file)))];
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return `${names.length === 1 ? "A clip this edit uses is" : `${names.length} clips this edit uses are`} missing from the shoot folder: ${list}. Put ${names.length === 1 ? "it" : "them"} back or relink, then export again.`;
}
/** Roughly what an export writes: the finished H.264 (about 0.3 bits a pixel, measured 0.21 on a real shoot) and its sound. */
function exportBytes(record: ExportRecord): number {
  const { width, height, fps } = record.assembly.template;
  return Math.max(50e6, (record.lengthS || 60) * (width * height * fps * .3 + 320e3) / 8);
}
const nearestFolder = (file: string): string => { let dir = file; while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir); return dir; };
const deviceOf = (file: string): number | null => { try { return fs.statSync(nearestFolder(file)).dev; } catch { return null; } };
const freeOn = async (file: string): Promise<number> => fs.promises.statfs(nearestFolder(file)).then(s => s.bavail * s.bsize, () => Infinity);
function amount(bytes: number): string {
  if (bytes < 1e9) return `${Math.max(100, Math.ceil(bytes / 1e8) * 100)} MB`;
  return `${bytes < 10e9 ? Math.ceil(bytes / 1e8) / 10 : Math.ceil(bytes / 1e9)} GB`;
}
/** Which drive is short and by about how much. With the error's own path (ENOSPC carries one) it is that drive; without, the one with less free than this export needs. */
async function fullDrive(root: string, folder: string, record: ExportRecord | undefined, at?: string): Promise<string | null> {
  const out = record ? exportBytes(record) : 300e6, home = deviceOf(os.homedir());
  const places = [
    { file: os.tmpdir(), need: 2e9, name: "this Mac" },
    { file: path.join(root, ".sidething"), need: out * 1.2, name: "the shoot's drive" },
    { file: folder || path.join(root, "sidething precuts"), need: out * 1.2, name: "the drive your exports go to" },
  ].map(place => ({ ...place, dev: deviceOf(place.file) }));
  // One drive holding several of these needs their sum. It is named for the person: their Mac, else the shoot's drive.
  const drives = new Map<number | null, { need: number; names: string[]; file: string }>();
  for (const place of places) {
    const drive = drives.get(place.dev) ?? { need: 0, names: [], file: place.file };
    drive.need += place.need; drive.names.push(place.name); drives.set(place.dev, drive);
  }
  const atDev = at ? deviceOf(at) : undefined;
  let short: { need: number; name: string; free: number } | null = null;
  for (const [dev, drive] of drives) {
    const free = await freeOn(drive.file);
    const name = dev !== null && dev === home ? "this Mac" : drive.names.includes("the shoot's drive") ? "the shoot's drive" : drive.names[0];
    if (atDev !== undefined ? dev === atDev : free < drive.need && (!short || free / drive.need < short.free / short.need)) short = { need: drive.need, name, free };
  }
  if (!short) return null;
  return `The drive is full. Free about ${amount(Math.max(250e6, short.need - Math.min(short.free, short.need)))} on ${short.name}, then export again.`;
}
/** EXP3: the shoot folder the export started from, by identity. A drive that went away can leave its old path behind, made again (empty, or with a stray status file): that is a different folder. */
type ShootId = { dev: number; ino: number } | null;
const shootId = (root: string): ShootId => { const stat = fs.statSync(root, { throwIfNoEntry: false }); return stat ? { dev: stat.dev, ino: stat.ino } : null; };
const shootThere = (root: string, id: ShootId): boolean => { const now = shootId(root); return !!now && (!id || now.dev === id.dev && now.ino === id.ino); };
/** EXP3: make the export's folder, never a stand-in for a drive that went away (mkdir -p would recreate its old path). */
async function makeExportFolder(root: string, id: ShootId, batch: string, dir = batch): Promise<void> {
  // The exports folder (by default "sidething precuts" in the shoot) may be made; whatever holds it must already be there.
  if (!shootThere(root, id) || !fs.existsSync(path.dirname(path.dirname(batch)))) throw new Error("Missing footage.");
  await fs.promises.mkdir(dir, { recursive: true });
}
/** EXP3: the drive went with the export's (empty) folder on it. When the same shoot folder is back, that folder goes, only if still empty. */
function removeWhenBack(root: string, id: ShootId, folder: string): void {
  const started = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - started > 6 * 3600_000) { clearInterval(timer); return; }
    if (!shootThere(root, id)) return;
    clearInterval(timer);
    void fs.promises.rmdir(folder).catch(() => { /* not empty, or already gone: leave it */ });
  }, 5000);
  timer.unref?.();
}
async function plainExportFailure(error: unknown, ctx: { root: string; id: ShootId; folder: string; record?: ExportRecord }): Promise<{ message: string; missing?: string[] }> {
  const e = (error && typeof error === "object" ? error : {}) as NodeJS.ErrnoException & { dest?: string };
  const code = typeof e.code === "string" ? e.code : undefined;
  if (!shootThere(ctx.root, ctx.id)) return { message: "The shoot's drive isn't connected any more. Connect it, then export again." };
  const exportsRoot = path.dirname(ctx.folder || path.join(ctx.root, "sidething precuts", "x"));
  if (!fs.existsSync(path.dirname(exportsRoot))) return { message: "The drive your exports go to isn't connected any more. Connect it, then export again." };
  const gone = ctx.record ? missingOriginals(ctx.root, ctx.record, code === "ENOENT" ? e.path : undefined) : [];
  if (gone.length) return { message: missingMessage(gone), missing: gone.map(clip => nameOf(clip.photo?.file ?? clip.file)) };
  if (code === "ENOSPC" || code === "EDQUOT" || !code) {
    const full = await fullDrive(ctx.root, ctx.folder, ctx.record, code ? e.dest ?? e.path : undefined);
    if (full) return { message: full };
  }
  if (code === "EROFS" || code === "EACCES" || code === "EPERM") return { message: "precut can't write there. Check the drive isn't locked or read-only, then export again." };
  if (code === "ENOENT" && e.path && path.resolve(e.path).startsWith(path.resolve(ctx.root) + path.sep)) {
    return { message: `A file this edit uses is missing from the shoot folder: ${nameOf(e.path)}. Put it back, then export again.` };
  }
  if (code) return { message: "Could not export this video. Try again." };
  // precut's own messages are already plain; a tool's output is not (it names files and folders).
  const text = error instanceof Error ? error.message : "";
  const leaks = !text || [ctx.root, os.tmpdir(), os.homedir()].some(place => text.includes(place)) || /(^|[\s'"(])\/[^\s'"]+\//.test(text);
  return { message: leaks ? "Could not export this video. Try again." : text };
}

export async function exportTo(root: string, cutId: string, version: number,
  targets: import('../shared/schema').ExportTarget[], aspects?: ExportAspect[]): Promise<BatchExport> {
  const allowed = ['resolve', 'finalcut', 'premiere', 'capcut', 'mp4'];
  if (!Array.isArray(targets) || !targets.length || targets.some(target => !allowed.includes(target))) throw new Error('Choose at least one export target.');
  if (aspects && (!Array.isArray(aspects) || !aspects.length || aspects.some(aspect => !exportAspects.includes(aspect)))) throw new Error('Choose an existing format of this edit.');
  root = path.resolve(root);
  const startedIn = shootId(root);
  const { loadDraftVersion, recordCutExport } = await import('./sidekick');
  const { waitForLiveSaves } = await import('./look-saves');
  const { getPreferences } = await import('./settings');
  const { runActivity, withRenderSlot } = await import('./activity');
  const { randomUUID } = await import('node:crypto');
  const { exportForEditor } = await import('./editors');
  const selectedTargets = [...new Set(targets)];
  const safe = (value: string) => value.replace(/[^\p{L}\p{N} ._-]/gu, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100) || 'edit';
  // EXP1: the export shows its stage from the first moment. Shares of the time, measured on a real shoot (54 s, 9:16):
  // the finished picture is most of it; editor timelines are mostly writing files.
  const stages = selectedTargets.includes('mp4') ? EXPORT_STAGES : EDITOR_STAGES;
  let folder = '', pairs: { target: import('../shared/schema').ExportTarget; aspect: ExportAspect }[] = [];
  const response: BatchExport = { folder, results: [] };
  let canceled = false, pairFolder: string | undefined;
  try {
    await runActivity({ kind: 'export', root, target: { cutId, version }, label: 'Exporting your video', cancelable: true }, async activity => {
      // VO7-2: the export is pinned to this revision before rendering: one read, never the newest snapshot later.
      const pinned = await waitForLiveSaves(root, cutId, version);
      if (pinned !== version) { version = pinned; activity.update({ target: { cutId, version } }); }
      const source = await loadDraftVersion(root, cutId, version);
      const preferences = await getPreferences();
      const selectedAspects = [...new Set(aspects ?? [exportAspect(source.assembly.template.width, source.assembly.template.height), ...(source.formats?.map(format => format.aspect) ?? [])])];
      pairs = selectedTargets.flatMap(target => selectedAspects.map(aspect => ({ target, aspect })));
      folder = response.folder = path.join(preferences.output.exportFolder ?? path.join(root, 'sidething precuts'), `${safe(source.title)} v${version} ${randomUUID().slice(0, 8)}`);
      activity.signal.throwIfAborted();
      await fs.promises.mkdir(folder, { recursive: true });
      await withRenderSlot(activity, async () => {
        for (const pair of pairs) {
          if (activity.signal.aborted) { canceled = true; break; }
          activity.progress(null, `Exporting ${pair.target} ${pair.aspect}`);
          activity.stage?.('preparing', 0, { part: [pairs.indexOf(pair), pairs.length], doneS: 0, lengthS: source.lengthS });
          let destination: string | undefined;
          // An export never fails because a model can't answer: it renders with what is saved and says what is plain.
          const plain = new Set<string>();
          let shown: ExportRecord | undefined;
          try {
            const record = shown = await exportFormat(source, pair.aspect);
            // EXP3: a clip gone from the folder stops the export before it starts, naming every one (the catch says how).
            if (!shootThere(root, startedIn) || missingOriginals(root, record).length) throw new Error('Missing footage.');
            for (const note of captionExportNotes(record.titles as { warnings?: string[] } | null | undefined)) plain.add(note);
            const { shoot, template, cutList, reel } = record.assembly;
            const name = `${safe(source.title)} v${version} ${pair.aspect.replace(':', 'x')} ${pair.target}`;
            const targetFolder = pairFolder = path.join(folder, name);
            let deliveryFolder = targetFolder;
            if (pair.target === 'mp4') {
              // Use the same full compositor and energy preparation as renderFinished,
              // with saved grading only. Export must never trigger a paid look call.
              const { prepareEnergy } = await import('./finish');
              const { renderFinishingPreview } = await import('./preview');
              prepareEnergy(record, record.assembly, record.energy ?? 'subtle', preferences.output.height);
              const file = await renderNotes.run(plain, () => renderFinishingPreview(root, record.assembly.cutList, {
                name: `export-${randomUUID()}`, template, version: record, reel: record.assembly.reel, full: true,
              }));
              activity.signal.throwIfAborted();
              activity.stage?.('saving', 0, { doneS: source.lengthS, lengthS: source.lengthS });
              // EXP1: the file is named for what it is (the folder already says mp4).
              await makeExportFolder(root, startedIn, folder, targetFolder);
              destination = path.join(targetFolder, `${safe(source.title)} v${version} ${pair.aspect.replace(':', 'x')}.mp4`);
              await fs.promises.copyFile(file, destination);
              activity.stage?.('saving', .5);
              await writeExportCover(root, cutId, record, targetFolder, file);
            } else {
              const editor = pair.target;
              await makeExportFolder(root, startedIn, folder);
              const result = await renderNotes.run(plain, () => exportForEditor(editor, { root, shoot, kind: 'reel', template, cutList,
                opts: { outputFolder: folder, folderName: name, reel, existingPreview: record.preview, finishing: record },
                finishing: record, previewPath: record.preview, activityTarget: { cutId, version } }));
              // The cover is a finished still. EXP2: reuse the finished video's frame when
              // one is on disk instead of rendering the whole edit again for one frame.
              activity.stage?.('picture', 0);
              const finishedVideo = record.finished
                ? await fs.promises.stat(record.finished).then(s => s.isFile() ? record.finished! : undefined, () => undefined) : undefined;
              await writeExportCover(root, cutId, record, result.folder, finishedVideo);
              activity.stage?.('saving', 0);
              deliveryFolder = pairFolder = result.folder;
              const files = await fs.promises.readdir(result.folder);
              const timeline = files.find(file => file.endsWith(pair.target === 'premiere' ? '.xml' : '.fcpxml'));
              destination = timeline ? path.join(result.folder, timeline) : result.folder;
              const notes = pair.target === 'capcut'
                ? 'CapCut receives numbered clips and a reference video, not a native CapCut project. Finishing is not editable as separate tracks. Read README.txt for import instructions.'
                : 'This is an XML interchange timeline, not a native editor project. Original footage is referenced read-only. Editor support for finishing varies. Read README.txt before importing; the finished MP4 is the visual reference.';
              const limits = pair.target === 'premiere' || pair.target === 'finalcut'
                ? 'Clip speed changes, ramps, joins, transition sounds, per-clip gain, framing, face matching, image overlays and colour are not carried by this timeline writer. Reapply them in the editor or use Finished video (MP4).'
                : pair.target === 'resolve'
                ? 'Framing, face matching, image overlays, per-clip gain, transition sounds and colour are finishing effects. Check the notes above for titles, music, retimes and dissolve support; they depend on the export path. Use Finished video (MP4) for the composed result.' : '';
              await fs.promises.appendFile(path.join(result.folder, 'README.txt'), `\n${notes}\n${limits}\n`);
            }
            await (await import('./translate')).writeDeliveryText(root, record, deliveryFolder, name);
            // ONB2: a starter track (CC BY) travels with its credit, ready to paste into the post.
            const credit = await (await import('./music')).starterCredit(record.music?.file ? path.resolve(root, record.music.file) : null).catch(() => null);
            if (credit) await fs.promises.writeFile(path.join(deliveryFolder, 'Music credit.txt'), `Music in this video: ${credit}\nPut this line in your post's description.\n`);
            await (await import('./layouts')).writeLayoutDelivery(deliveryFolder,root,record.layouts,record.assembly.shoot.clips);
            await (await import('./angles')).writeAngleDelivery(deliveryFolder,record.angleCuts,record.assembly.shoot);
            activity.signal.throwIfAborted();
            activity.stage?.('saving', 1);
            response.results.push({ ...pair, ok: true, path: destination, ...(plain.size ? { warnings: [...plain] } : {}) });
            pairFolder = undefined;
          } catch (error) {
            if (activity.signal.aborted) { canceled = true; break; }
            const failure = await plainExportFailure(error, { root, id: startedIn, folder, record: shown });
            if (failure.message !== (error as Error)?.message) console.error('[export] failed:', error);
            const result: BatchExport['results'][number] = { ...pair, ok: false, error: failure.message };
            // The sheet names the missing clips and offers Relink from this (additive; the shared type carries error only).
            if (failure.missing) Object.assign(result, { missing: failure.missing });
            response.results.push(result);
            // EXP3: a failed format leaves nothing half made, as a cancelled one does.
            if (pairFolder && pairFolder.startsWith(folder + path.sep)) await fs.promises.rm(pairFolder, { recursive: true, force: true }).catch(() => {});
            pairFolder = undefined;
          }
        }
        if (!activity.signal.aborted) {
          const succeeded = response.results.filter(result => result.ok).length;
          const failed = response.results.length - succeeded;
          const note = `${succeeded} exported${failed ? `, ${failed} failed. See export results.` : ''}`;
          // Nothing exported: the notification says why, in the same words as the sheet.
          if (!succeeded && failed) activity.fail(response.results.find(result => !result.ok)?.error ?? note); else activity.done(note);
        }
      });
    }, { groupChildren: true, stages });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') canceled = true;
    else {
      // EXP3: before or around the formats (the edit unreadable, the drive gone): the same plain words, nothing left behind.
      const failure = await plainExportFailure(error, { root, id: startedIn, folder });
      if (folder && !response.results.some(item => item.ok)) await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => {});
      if (failure.message !== (error as Error)?.message) console.error('[export] failed:', error);
      throw new Error(failure.message);
    }
  }
  if (canceled) {
    for (const pair of pairs.slice(response.results.length)) response.results.push({ ...pair, ok: false, error: 'Canceled' });
    // EXP1: a cancel leaves nothing half made. The unfinished format goes; with nothing finished, so does the export folder.
    if (pairFolder && folder && pairFolder.startsWith(folder + path.sep)) await fs.promises.rm(pairFolder, { recursive: true, force: true });
    if (folder && !response.results.some(item => item.ok)) { await fs.promises.rm(folder, { recursive: true, force: true }); return response; }
  }
  // EXP3: nothing exported leaves no folder behind; the sheet and the notification already say why.
  if (!response.results.some(item => item.ok)) {
    if (folder && shootThere(root, startedIn)) await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => {});
    else if (folder) removeWhenBack(root, startedIn, folder);
    return response;
  }
  try {
    // Preserve successes and exact failures across app restarts.
    await fs.promises.writeFile(path.join(folder, 'export-results.json'), JSON.stringify(response, null, 2));
    // On success the export is recorded, and recording it makes it an export milestone (revisions.ts noteExports).
    await recordCutExport(root, cutId, version, folder);
  } catch (error) {
    // The drive went away as the last format finished: say so, never a raw ENOENT with its path.
    const failure = await plainExportFailure(error, { root, id: startedIn, folder });
    if (failure.message !== (error as Error)?.message) console.error('[export] failed:', error);
    throw new Error(failure.message);
  }
  return response;
}

/** EXP1: rough shares of an export's time, for its percent and time left (a real shoot, 54 s, measured 27 Oct). */
// Measured: sound 33 s, picture 449 s (its own preparation, then the encode), saving 4 s of a 486 s export.
export const EXPORT_STAGES = [['preparing', 1], ['sound', 7], ['picture', 90], ['saving', 2]] as const;
// Editor timelines: Resolve and CapCut render a finished reference video; Final Cut and Premiere mostly write files.
export const EDITOR_STAGES = [['preparing', 10], ['sound', 5], ['picture', 75], ['saving', 10]] as const;
