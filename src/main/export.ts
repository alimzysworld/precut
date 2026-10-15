// S5: precut export (FCPXML + Resolve metadata CSV + mic sync) and
// template storage (userData/templates.json).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { effectiveShoot } from "./steps";
import { planSelects } from "./selects";
import { listSkills, skillTemplate } from "./skills";
import { renderPreview } from "./preview";
import { makeReel, reelCatalog, compositeReelPreview, type ReelAssembly } from "./reel";
import type { Clip, PrecutKind, Shoot, Template, ReelOptions, PrecutResult } from "../shared/schema";

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
  const python = fs.existsSync(venv) ? venv : "python3";
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
}

function buildSegments(shoot: Shoot, kind: PrecutKind): Segment[] | "reel" {
  shoot = effectiveShoot(shoot);
  if (kind === "reel") return "reel";
  const clipsById = new Map(shoot.clips.map((c) => [c.id, c]));
  if (kind === "talking") {
    return [...shoot.takes].sort((a, b) => a.lineIndex - b.lineIndex)
      .filter((t) => t.attempts.length > 0)
      .map((t) => {
        const a = t.attempts[Math.min(t.starred, t.attempts.length - 1)];
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
  seg: Segment | null; // null = gap
  inFrames: number;
  outFrames: number;
  clipFpsR: FpsRational;
  offsetFrames: number; // timeline, template fps
  durTimelineFrames: number;
}

// Shared by FCPXML, preview, and reel assembly: exact source frames and offsets.
export function buildCutList(shoot: Shoot, kind: PrecutKind, template: Template, orderedSegments?: Segment[]): CutItem[] {
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
  for (const [segmentIndex, seg] of segments.entries()) {
    const meta = seg.clip.meta;
    if (!meta) continue;
    const clipFps = meta.fps || template.fps;
    const fpsR = fpsRational(clipFps);
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
    // Padding must not replay a neighbouring attempt's words.
    const previous = segments[segmentIndex - 1];
    const next = segments[segmentIndex + 1];
    const backToBack = (other: Segment | undefined) => other &&
      other.clip.id === seg.clip.id &&
      (kind !== "selects" || other.lineIndex === seg.lineIndex);
    if (backToBack(next) && seg.s < next.s) {
      outFrames = Math.min(outFrames, Math.max(Math.ceil(seg.e * clipFps - 1e-9), Math.floor(next.s * clipFps + 1e-9)));
    }
    const previousItem = items[items.length - 1];
    if (backToBack(previous) && previous.s < seg.s && previousItem?.seg) {
      // Use the previous emitted out point, which may itself have been
      // capped above when the word-snapped windows share boundary words.
      inFrames = Math.max(inFrames, previousItem.outFrames);
    }
    inFrames = Math.max(0, Math.min(inFrames, maxFrames));
    outFrames = Math.min(outFrames, maxFrames);
    if (outFrames <= inFrames) throw new Error(`No non-overlapping span for ${seg.marker}. Check its edges.`);
    // Keep offsets/durations consistent with precise source cuts, including
    // between-frame speech edges; otherwise neighbouring timeline clips overlap.
    const durTimeline = ((outFrames - inFrames) / clipFps) * template.fps;
    items.push({ seg, inFrames, outFrames,
                 clipFpsR: fpsR, offsetFrames: timelineFrames, durTimelineFrames: durTimeline });
    timelineFrames += durTimeline;
  }

  return items;
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
  cutList: CutItem[], opts: { outputFolder?: string; folderName?: string; reel?: ReelAssembly; existingPreview?: string | null } = {}): Promise<PrecutResult> {
  const selects = kind === "selects" ? await planSelects(root, shoot, template, opts.outputFolder) : undefined;
  cutList = selects?.cuts ?? cutList;
  const allCuts = [...cutList, ...(selects?.lines.flatMap((l) => l.alternates) ?? []), ...(selects?.broll ?? [])];
  const segments = allCuts.flatMap((cut) => cut.seg ? [cut.seg] : []);
  const templateFps = fpsRational(template.fps);

  // Assets and source formats, in first-use order.
  const assetIdByClip = new Map<string, string>();
  const assets: { id: string; clip: Clip; startFrames: number; fpsR: FpsRational; formatId: string }[] = [];
  const formatIdByKey = new Map<string, string>();
  let formatCount = 1; // r1 is the template (sequence) format
  const sourceFormatId = (clip: Clip): string => {
    const meta = clip.meta!;
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
    const meta = a.clip.meta!;
    formatLines.push(`<format id="${a.formatId}" name="${xmlEscape(`${meta.width}x${meta.height}p${meta.fps}`)}" frameDuration="${frameDurationOf(a.fpsR)}" width="${meta.width}" height="${meta.height}"/>`);
  }

  const assetLines: string[] = [];
  for (const a of assets) {
    const meta = a.clip.meta!;
    const durFrames = Math.max(1, Math.round(meta.durationS * (meta.fps || template.fps)));
    const abs = path.isAbsolute(a.clip.file) ? a.clip.file : path.join(root, a.clip.file);
    const src = pathToFileURL(fs.realpathSync(abs)).href;
    assetLines.push(
      `<asset id="${a.id}" name="${xmlEscape(a.clip.id)}" start="${timeAt(a.startFrames, a.fpsR)}" duration="${timeAt(durFrames, a.fpsR)}" hasVideo="1" hasAudio="${meta.audioChannels > 0 ? 1 : 0}" format="${a.formatId}" audioSources="1" audioChannels="${meta.audioChannels}" audioRate="${meta.sampleRate || 48000}"><media-rep kind="original-media" src="${xmlEscape(src)}"/></asset>`,
    );
  }
  for (const mic of micByFile.values()) {
    const abs = path.isAbsolute(mic.file) ? mic.file : path.join(root, mic.file);
    const src = pathToFileURL(fs.realpathSync(abs)).href;
    assetLines.push(
      `<asset id="${mic.assetId}" name="${xmlEscape(path.basename(mic.file))}" start="0s" duration="${Math.round(mic.durationS * 1000)}/1000s" hasVideo="0" hasAudio="1" audioSources="1" audioChannels="${mic.channels}"><media-rep kind="original-media" src="${xmlEscape(src)}"/></asset>`,
    );
  }

  const music = opts.reel?.music;
  if (music) assetLines.push(`<asset id="reel-music" name="${xmlEscape(path.basename(music.file))}" start="0s" duration="${Math.round(music.durationS * 1000)}/1000s" hasVideo="0" hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"><media-rep kind="original-media" src="${xmlEscape(pathToFileURL(music.file).href)}"/></asset>`);

  // Resolve imports synchronized A/V as compounds (Resolve 20 manual,
  // ch.55). Keep the sound inside a referenced take, and attach alternates to
  // the reference OUTSIDE that compound, so they become editable video lanes.
  const mediaLines: string[] = [];
  const mediaByCut = new Map<string, string>();
  const seconds = (s: number) => timeAt(s * template.fps, templateFps);
  const clipXml = (item: CutItem, offset: string, anchors: string[] = [], lane?: number, disabled = false): string => {
    const seg = item.seg!;
    const asset = assets.find((a) => a.clip.id === seg.clip.id)!;
    const sourceStart = timeAt(asset.startFrames + item.inFrames, asset.fpsR);
    const duration = seconds(item.durTimelineFrames / template.fps);
    const attrs = `name="${xmlEscape(seg.marker)}" offset="${offset}" duration="${duration}"${lane === undefined ? "" : ` lane="${lane}"`}${disabled ? ' enabled="0"' : ""}`;
    const mic = micByClip.get(seg.clip.id);
    const channels = Array.from({ length: Math.min(2, seg.clip.meta!.audioChannels) }, (_, n) =>
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
          content = `<sync-clip name="${xmlEscape(seg.marker)}" offset="0s" start="0s" duration="${duration}" format="r1"><asset-clip ref="${asset.id}" offset="0s" start="${sourceStart}" duration="${duration}" srcEnable="video"/><asset-clip ref="${mic.assetId}" lane="-1" offset="${seconds(delay)}" start="${seconds(micStart)}" duration="${seconds(micLength)}" audioRole="dialogue.mic"/></sync-clip>`;
        } else {
          // Distinct trimmed resources preserve the named bin entries even
          // when several subclips refer to the same camera original.
          content = `<asset-clip ref="${asset.id}" name="${xmlEscape(seg.marker)}" offset="0s" start="${sourceStart}" duration="${duration}"><marker start="${sourceStart}" duration="${frameDurationOf(asset.fpsR)}" value="${xmlEscape(seg.marker)}"/>${channels}</asset-clip>`;
        }
        mediaLines.push(`<media id="${id}" name="${xmlEscape(seg.marker)}"><sequence format="r1" duration="${duration}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>${content}</spine></sequence></media>`);
      }
      return `<ref-clip ref="${id}" ${attrs} start="0s">${anchors.join("")}<marker start="0s" duration="${frameDurationOf(templateFps)}" value="${xmlEscape(seg.marker)}"/></ref-clip>`;
    }
    return `<asset-clip ref="${asset.id}" ${attrs} start="${sourceStart}">${anchors.join("")}<marker start="${sourceStart}" duration="${frameDurationOf(asset.fpsR)}" value="${xmlEscape(seg.marker)}"/>${channels}</asset-clip>`;
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
    for (const alt of selects?.lines[itemIndex]?.alternates ?? []) {
      while ((laneEnds.get(lane) ?? 0) > item.offsetFrames + 1e-7) lane++;
      anchors.push(clipXml(alt, parentStart, [], lane, true));
      laneEnds.set(lane, item.offsetFrames + alt.durTimelineFrames);
      lane++;
    }
    for (const overlay of opts.reel?.broll.filter((b) => b.voiceIndex === itemIndex) ?? []) {
      const bAsset = assets.find((a) => a.clip.id === overlay.seg.clip.id)!;
      const bFps = overlay.seg.clip.meta!.fps || template.fps;
      const bIn = Math.ceil(overlay.seg.s * bFps);
      const durationS = Math.min((Math.floor(overlay.seg.e * bFps) - bIn) / bFps, item.durTimelineFrames / template.fps);
      if (durationS <= 0) continue;
      anchors.push(`<asset-clip ref="${bAsset.id}" lane="1" name="${xmlEscape(overlay.id + ": " + overlay.seg.marker)}" offset="${parentStart}" start="${timeAt(bAsset.startFrames + bIn, bAsset.fpsR)}" duration="${seconds(durationS)}" srcEnable="video"/>`);
    }
    if (music && itemIndex === 0) {
      const musicDuration = Math.min(timelineFrames / template.fps, music.durationS - music.startS);
      anchors.push(`<asset-clip ref="reel-music" lane="-2" name="${xmlEscape(path.basename(music.file))}" offset="${parentStart}" start="${seconds(music.startS)}" duration="${seconds(musicDuration)}" audioRole="music"><adjust-volume amount="${music.gainDb}dB"><param name="amount" value="${music.gainDb}dB"><fadeOut type="linear" duration="${Math.min(1, musicDuration)}s"/></param></adjust-volume></asset-clip>`);
    }
    // Standalone reel B-roll remains picture-only.
    const xml = clipXml(item, timeAt(item.offsetFrames, templateFps), anchors);
    spineLines.push(opts.reel && item.seg.lineIndex === null
      ? xml.replace(/<(asset-clip|ref-clip) /, '<$1 srcEnable="video" ') : xml);
  }
  const binEvents = selects ? [
    `<event name="Lines">${selects.lines.flatMap((l) => [l.main, ...l.alternates]).map((c) => clipXml(c, "0s")).join("\n")}</event>`,
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
    ...(selects ? [
      `Selects: starred takes play once in script order. Disabled takes sit above each line, next best lowest; their full trimmed lengths are retained. Longer alternates may overlap the next line and need a ripple/trim when chosen.`,
      `Swap a take: keep Linked Selection on; disable the current take (right-click > Enable Clip), then enable one alternate above its line. Its mic is inside the same compound, so sound switches with picture. Adjust the following edit for a longer or shorter take.`,
      `Bins: named Lines and B-roll events contain independent trimmed resources referencing originals. Resolve event-to-bin preservation is not verified; if those bins do not appear, create them in the Media Pool and move the numbered take compounds into Lines. For B-roll, use the original and the source in/out below to Make Subclip in B-roll. The inventory is below.`,
      ...selects.lines.flatMap((l) => [l.main, ...l.alternates]).concat(selects.broll).map((c) => {
        const fps = c.clipFpsR.num / c.clipFpsR.den;
        return `${c.seg!.lineIndex === null ? "B-roll" : "Lines"}: ${c.seg!.marker} | ${c.seg!.clip.file} | source seconds ${(c.inFrames / fps).toFixed(3)}–${(c.outFrames / fps).toFixed(3)} | ${c.seg!.clip.sound ? `mic ${c.seg!.clip.sound.file}` : "camera sound"}`;
      }),
    ] : []),
    vertical
      ? `Vertical: no transform is baked in - Resolve's project setting decides fit or fill for how these sources sit in the ${template.width}x${template.height} frame.`
      : `Fit/fill: no transform is baked in - if a source differs from ${template.width}x${template.height}, Resolve's project setting decides fit or fill.`,
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
