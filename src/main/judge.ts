import { clipName } from "../shared/clip-name";
import { applyFootageStar } from "./footage-stars";
import { tool } from "./tools";
// The AI judge: one model call per shoot. Builds the shoot summary plus
// contact-sheet grids, validates the answer against the schema shape, and
// writes judgement/script/takes into .sidething/index.json. Re-judging is
// skipped when the input hash in .sidething/judge/input.sha is unchanged.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Judgement, Shoot, ShootNotice, SubjectSample, Take, TakeMeasures, Word } from "../shared/schema";
import { runModel, type Engine } from "./ai";
import { effectiveClip, stepsChanged } from "./steps";
import { getEngine, getPreferences } from "./settings";
import { clipTurn, displayedClip } from "../shared/media";
import { queueClipPictures } from "./rotation";
import { mergeLeftOut } from "./left-out-state";
import { measureModelWork } from "./model-pace";
import { filmedAt } from "./filmed-time";
import { ensureJudgeFrames, judgeFramePath } from "./judge-frames";

export type { Engine };

export interface JudgeProgress {
  root: string;
  clipId: string;
  stage: "judge" | "done";
  pct: number;
}

export interface JudgeResult {
  called: boolean;
  shoot: Shoot;
  rawAnswer?: string;
}

type ProgressFn = (e: JudgeProgress) => void;

const KINDS = new Set(["talking", "broll", "setup", "unknown"]);
const VERDICTS = new Set(["best", "alt", "maybe", "unusable"]);
const SHOTS = new Set(["wide", "medium", "close", "unknown"]);
const SCRIPT_SOURCES = new Set(["pasted", "inferred", "none"]);

function fmt(s: number): string {
  const tenths = Math.max(0, Math.round(s * 10));
  return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
}

function judgePromptPath(): string {
  const fromCwd = path.join(process.cwd(), "prompts", "judge.md");
  if (fs.existsSync(fromCwd)) return fromCwd;
  try {
    const candidates = [
      path.join(__dirname, "..", "..", "prompts", "judge.md"),
      path.join(__dirname, "..", "..", "..", "prompts", "judge.md"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  } catch {
    // __dirname unavailable (plain ESM): fall through
  }
  return fromCwd;
}

function indexPath(root: string): string {
  return path.join(root, ".sidething", "index.json");
}

async function readIndex(root: string): Promise<Shoot> {
  const raw = await fs.promises.readFile(indexPath(root), "utf8");
  return mergeLeftOut({ ...JSON.parse(raw), root } as Shoot);
}

async function writeIndex(root: string, shoot: Shoot): Promise<void> {
  shoot.updatedAt = new Date().toISOString();
  const dir = path.join(root, ".sidething");
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, "index.json.tmp");
  const library = (await import("./scenes")).withScenes(shoot);
  await fs.promises.writeFile(tmp, JSON.stringify(library, null, 1), "utf8");
  await fs.promises.rename(tmp, indexPath(root));
  stepsChanged(root);
}

// ------------------------------------------------------------ input build ----

// Measurements only, never a practice verdict. At 2 Hz each observation covers
// at most 0.5 s. Missing detections/angles and neutral samples break a run;
// do not bridge gaps beyond the expected cadence or keep sub-second flickers.
export function facePoseSpans(samples: readonly SubjectSample[], durationS = Infinity): {
  away: [number, number][]; down: [number, number][];
} {
  const ordered = samples.filter((s) => Number.isFinite(s.t) && s.t >= 0 && s.t < durationS)
    .slice().sort((a, b) => a.t - b.t);
  const spans = (matches: (s: SubjectSample) => boolean): [number, number][] => {
    const result: [number, number][] = [];
    let start: number | undefined, end = 0;
    const flush = () => {
      if (start !== undefined && end - start >= 1) result.push([start, end]);
      start = undefined;
    };
    ordered.forEach((sample, i) => {
      if (sample.kind !== "face" || !matches(sample)) { flush(); return; }
      if (start !== undefined && sample.t - end > 0.25) flush();
      start ??= sample.t;
      end = Math.min(sample.t + 0.5, ordered[i + 1]?.t ?? Infinity, durationS);
    });
    flush();
    return result;
  };
  // Head-down is measured from how this person holds their head when facing the lens
  // (the upper quarter of their pitch readings, kept near level), not from the lens axis:
  // reading a phone held at the chest is only 10 to 15 degrees down from that.
  const pitches = ordered.filter((s) => s.kind === "face" && Number.isFinite(s.pitch)).map((s) => s.pitch!).sort((x, y) => x - y);
  const upright = pitches.length ? Math.min(0.15, Math.max(-0.1, pitches[Math.floor(pitches.length * 0.75)])) : 0;
  return {
    away: spans((s) => Number.isFinite(s.yaw) && Math.abs(s.yaw!) >= 0.6),
    down: spans((s) => Number.isFinite(s.pitch) && s.pitch! <= upright - 0.12),
  };
}

function faceFacts(clip: Shoot["clips"][number]): string {
  const samples = clip.subject?.samples ?? [];
  if (!samples.some((s) => s.kind === "face" && (Number.isFinite(s.yaw) || Number.isFinite(s.pitch)))) {
    return "Face pose: not measured (no face angles available)";
  }
  const { away, down } = facePoseSpans(samples, clip.meta?.durationS);
  const describe = (label: string, spans: [number, number][]) => spans.length
    ? `${label} ${spans.map(([s, e]) => `${s.toFixed(1)}-${e.toFixed(1)} s`).join(", ")}` : "";
  const facts = [describe("face turned away", away), describe("head down", down)].filter(Boolean);
  return `Face pose: ${facts.join("; ") || "no sustained turned-away or head-down spans measured"}`;
}

export function qualityFacts(clip: Shoot["clips"][number]): string {
  if (!clip.quality) return "Quality: not measured";
  const names = { "soft-focus": "soft focus", "blown-highlights": "blown highlights",
    "too-dark": "too dark", clipping: "clipping", wind: "wind", rustle: "rustle",
    noisy: "noise floor", "no-mic": "mic silent or missing" };
  const spans = clip.quality.spans.map((span) => `${names[span.kind]} ${fmt(span.s)}-${fmt(span.e)}` +
    (span.kind === "noisy" ? ` (${span.value.toFixed(1)} dBFS)` : ""));
  return `Quality: ${spans.join("; ") || "no flagged spans measured"}`;
}

interface QualityReadings {
  samples: { t: number; faceQuality?: number }[];
  loudness: { t: number; db: number }[];
}

// The quality step runs before judging. Reuse its cached readings after the
// judge creates/snaps attempts, so the first judge reply gets measures too.
// Keep these definitions in step with pipeline/quality.py take_measures;
// qa/Q1 checks both implementations against the same aggregation fixtures.
export function applyTakeMeasures(shoot: Shoot): void {
  const cache = (shoot as Shoot & { _cache?: { quality?: Record<string, QualityReadings> } })._cache?.quality;
  const percentile = (values: number[], p: number): number | null => {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b), n = (sorted.length - 1) * p;
    return sorted[Math.floor(n)] + (sorted[Math.ceil(n)] - sorted[Math.floor(n)]) * (n - Math.floor(n));
  };
  for (const take of shoot.takes) for (const attempt of take.attempts) {
    const clip = shoot.clips.find((c) => c.id === attempt.clipId), raw = cache?.[attempt.clipId];
    if (!clip || !raw) continue;
    const { s, e } = attempt;
    const words = (clip.transcript ?? []).flatMap((seg) => seg.words ?? [])
      .filter((w) => Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s && w.w.trim() && w.e > s && w.s < e)
      .sort((a, b) => a.s - b.s || a.e - b.e);
    const intervals: [number, number][] = [];
    for (const word of words) {
      const a = Math.max(s, word.s), b = Math.min(e, word.e), last = intervals.at(-1);
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else intervals.push([a, b]);
    }
    const faces = (clip.subject?.samples ?? []).filter((row) => row.kind === "face");
    const pitches = faces.filter((row) => Number.isFinite(row.pitch)).map((row) => row.pitch!).sort((a, b) => a - b);
    const upright = pitches.length ? Math.min(0.15, Math.max(-0.1, pitches[Math.floor(pitches.length * 0.75)])) : 0;
    const poses = faces.filter((row) => row.t >= s && row.t < e && Number.isFinite(row.yaw) && Number.isFinite(row.pitch));
    const qualities = raw.samples.filter((row) => row.t >= s && row.t < e && Number.isFinite(row.faceQuality))
      .map((row) => row.faceQuality!);
    const levels = raw.loudness.filter((row) => row.t >= s && row.t < e).map((row) => row.db);
    const measures: TakeMeasures = {
      faceQuality: percentile(qualities, 0.5),
      eyeContact: poses.length ? poses.filter((row) => Math.abs(row.yaw!) < 0.35 && Math.abs(row.pitch! - upright) < 0.12).length / poses.length : null,
      wpm: words.length && e > s ? words.length * 60 / (e - s) : null,
      pauseS: words.length ? Math.max(0, e - s - intervals.reduce((sum, [a, b]) => sum + b - a, 0)) : null,
      energyDb: levels.length >= 2 ? percentile(levels, 0.9)! - percentile(levels, 0.1)! : null,
      flags: [...new Set((clip.quality?.spans ?? []).filter((span) => span.s < e && span.e > s).map((span) => span.kind))].sort(),
    };
    attempt.measures = measures;
  }
}

// PF1b: measured, not guessed. Transcripts keep only words heard over measured speech
// (pipeline/process.py), so their span is the clip's speech; a vlog's voice over the
// scene has speech with no face in frame. The judge decides the kind from these.
export function speechFacts(clip: Shoot["clips"][number]): string {
  const spans = (clip.transcript ?? []).flatMap((seg) => seg.words?.length ? seg.words.map((w) => [w.s, w.e] as const) : [[seg.s, seg.e] as const])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s).sort((a, b) => a[0] - b[0]);
  let heard = 0, end = -Infinity;
  for (const [s, e] of spans) { if (e > end) { heard += e - Math.max(s, end); end = e; } }
  const dur = clip.meta?.durationS ?? 0;
  const samples = clip.subject?.samples ?? [];
  const face = samples.length ? `; face in frame in ${samples.filter((x) => x.kind === "face").length} of ${samples.length} samples` : "";
  return `Speech: ${heard > 0 ? `words heard for ${heard.toFixed(1)}s of ${dur.toFixed(1)}s` : "none measured"}${face}`;
}

export function steadyFacts(clip: Shoot["clips"][number]): string {
  const shake = clip.shake, duration = clip.meta?.durationS ?? 0;
  if (!shake?.measured) return "Steady windows: not measured";
  // Never call an unmeasured tail steady. The per-second readings delimit
  // coverage; shakySpans is the pipeline's existing measurement, not a verdict.
  const end = Math.min(duration, shake.perSecond?.length ?? duration);
  const spans = shake.shakySpans.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .slice().sort((a, b) => a[0] - b[0]);
  const windows: string[] = [];
  let cursor = 0;
  for (const [s, e] of spans) {
    if (Math.min(end, s) - cursor >= 1) windows.push(`${fmt(cursor)} to ${fmt(Math.min(end, s))}`);
    cursor = Math.max(cursor, e);
  }
  if (end - cursor >= 1) windows.push(`${fmt(cursor)} to ${fmt(end)}`);
  return `Steady windows: ${windows.length ? `steady ${windows.join(", ")}` : "no full second measured; inspect the frames and transcript"}`;
}

export function clipBlock(shoot: Shoot, clip: Shoot["clips"][number]): string {
  const manual = clip.byHand;
  clip = effectiveClip(clip);
  const m = clip.meta;
  const lines: string[] = [];
  const dur = m?.durationS ?? 0;
  if (clip.photo) {
    return [`Clip ${clip.id} | photo | still length ${dur.toFixed(1)}s | taken at ${clip.photo.takenAt ?? "unknown"}`,
      "Judge the photo itself, not motion from its generated slow push. No recorded speech or camera shake.",
      `Return kind broll and usableSpans [[0, ${dur}]]. Describe what the photo shows in summary.`,
      qualityFacts({ ...clip, quality: clip.quality ? { ...clip.quality, spans: clip.quality.spans.filter(s => ["soft-focus", "blown-highlights", "too-dark"].includes(s.kind)) } : clip.quality }),
    ].join("\n");
  }
  lines.push(
    `Clip ${clip.id} | length ${fmt(dur)} (${dur.toFixed(1)}s)` +
      (m
        ? ` | camera ${m.camera ?? "unknown"}, ${m.fps} fps, ` +
          `profile ${m.pictureProfile ?? "unknown"}, ISO ${m.iso ?? "unknown"}, ` +
          `shutter ${m.shutter ?? "unknown"}, aperture ${m.aperture ?? "unknown"}`
        : " | metadata unknown"),
  );
  if (manual?.kind !== undefined) lines.push(`Kind tagged by the person: ${manual.kind}. Keep this tag.`);
  if (!clip.shake || !clip.shake.measured) {
    lines.push("Shake: not measured, too dark");
  } else if (clip.shake.shakySpans.length === 0) {
    lines.push("Shake: no shaky spans");
  } else {
    const spans = clip.shake.shakySpans.map(([a, b]) => `${fmt(a)}-${fmt(b)}`).join(", ");
    lines.push(`Shake: shaky at ${spans}`);
  }
  lines.push(steadyFacts(clip));
  lines.push(faceFacts(clip));
  lines.push(qualityFacts(clip));
  lines.push(speechFacts(clip));
  const segs = clip.transcript ?? [];
  if (segs.length === 0) {
    lines.push("Transcript: (none)");
  } else {
    lines.push("Transcript:");
    for (const seg of segs) lines.push(`[${fmt(seg.s)}] ${seg.text}`);
  }
  return lines.join("\n");
}

export function inputHash(shoot: Shoot, aiSeesFrames: boolean): string {
  shoot = { ...shoot, clips: shoot.clips.filter(c => !c.leftOut) };
  // Only the pasted script is an input; an inferred script is judge output,
  // so hashing it would make every re-run look changed and re-call forever.
  const payload = {
    practiceRules: 1,
    qualityRules: 2,
    rotationRules: 1,
    junkRules: 1,
    ...(shoot.clips.some(c => c.photo) ? { photoRules: 1 } : {}),
    aiSeesFrames,
    pastedScript: shoot.scriptSource === "pasted" ? shoot.script : null,
    // Facts can arrive after ideas. They enrich edits/Ask without buying a
    // second whole-shoot judgement. Explicit force handles a person's re-judge.
    clips: shoot.clips.map((c) => ({ id: c.id, file: c.file })).sort((a, b) => a.id.localeCompare(b.id)),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// ------------------------------------------------------------ grid images ----

function execFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool("ffmpeg"), args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${err.slice(-400)}`));
    });
  });
}

async function buildGrids(root: string, shoot: Shoot): Promise<{ file: string; clipIds: string[] }[]> {
  const judgeDir = path.join(root, ".sidething", "judge");
  await fs.promises.mkdir(judgeDir, { recursive: true });
  for (const clip of shoot.clips) await ensureJudgeFrames(root, clip);
  const clips = shoot.clips.filter(c => c.frames.some(f => fs.existsSync(judgeFramePath(root, f))));
  const perImage = 8;
  const grids: { file: string; clipIds: string[] }[] = [];
  for (let g = 0; g * perImage < clips.length; g++) {
    const group = clips.slice(g * perImage, (g + 1) * perImage);
    // ANA1: the rows of one sheet are separate small ffmpeg runs; make four at a time, keep their order.
    const rows: ({ rowPath: string; clipId: string } | null)[] = new Array(group.length).fill(null);
    let nextRow = 0;
    await Promise.all(Array.from({ length: Math.min(4, group.length) }, async () => { while (nextRow < group.length) { const r = nextRow++; rows[r] = await gridRow(r); } }));
    const rowFiles = rows.flatMap(row => row ? [row.rowPath] : []);
    const clipIds = rows.flatMap(row => row ? [row.clipId] : []);
    async function gridRow(r: number): Promise<{ rowPath: string; clipId: string } | null> {
      const clip = group[r];
      const available = clip.frames.map((name, index) => ({ name, index, file: judgeFramePath(root, name) }))
        .filter(frame => fs.existsSync(frame.file)).slice(0, 16);
      if (!available.length) return null;
      const frames = available.map(frame => frame.file);
      const rowPath = path.join(judgeDir, `_row-${g}-${r}.jpg`);
      const inputs: string[] = [];
      const filters: string[] = [];
      frames.forEach((f, i) => {
        inputs.push("-i", f);
        const timestamp = available[i].name.match(/_t(\d+(?:\.\d+)?)\.jpg$/)?.[1];
        const t = timestamp === undefined ? (available[i].index + .5) * (clip.meta?.durationS ?? 0) / clip.frames.length : Number(timestamp);
        const timeLabel = fmt(t).replace(/:/g, "\\:");
        filters.push(`[${i}:v]format=yuv444p,scale=240:135:force_original_aspect_ratio=decrease,pad=240:135:(ow-iw)/2:(oh-ih)/2,setsar=1,drawtext=text='${timeLabel}':x=5:y=5:fontsize=17:fontcolor=white:box=1:boxcolor=black[v${i}]`);
      });
      const labels = frames.map((_, i) => `[v${i}]`).join("");
      // One frame can't hstack, and rows must share a width to vstack: pad every row to 8 frames wide.
      filters.push(frames.length > 8 ? `${labels}xstack=inputs=${frames.length}:layout=${frames.map((_, i) => `${i % 8 * 240}_${Math.floor(i / 8) * 135}`).join("|")}:fill=black[row]`
        : frames.length > 1 ? `${labels}hstack=inputs=${frames.length}[row]` : `${labels}null[row]`);
      filters.push(
        `[row]pad=${240 * 8}:ih+30:0:30:black,drawtext=text='${clip.id}':x=8:y=7:fontsize=19:fontcolor=white[final]`,
      );
      try { await execFfmpeg([
        "-y", "-v", "error", ...inputs,
        "-filter_complex", filters.join(";"),
        "-map", "[final]", "-frames:v", "1", "-q:v", "3", rowPath,
      ]); } catch (error) {
        console.warn("[judge] Skipping unreadable clip pictures:", clip.id, error);
        await fs.promises.unlink(rowPath).catch(() => {});
        return null;
      }
      return { rowPath, clipId: clip.id };
    }
    if (!rowFiles.length) continue;
    const gridPath = path.join(judgeDir, `grid-${g + 1}.jpg`);
    const inputs: string[] = [];
    const filters: string[] = [];
    rowFiles.forEach((f, i) => {
      inputs.push("-i", f);
      filters.push(`[${i}:v]setsar=1[r${i}]`);
    });
    const labels = rowFiles.map((_, i) => `[r${i}]`).join("");
    filters.push(rowFiles.length > 1 ? `${labels}vstack=inputs=${rowFiles.length}[final]` : `${labels}null[final]`);
    await execFfmpeg([
      "-y", "-v", "error", ...inputs,
      "-filter_complex", filters.join(";"),
      "-map", "[final]", "-frames:v", "1", "-q:v", "3", gridPath,
    ]);
    for (const f of rowFiles) await fs.promises.unlink(f).catch(() => {});
    grids.push({ file: gridPath, clipIds });
  }
  return grids;
}

// ------------------------------------------------------- validate + apply ----

interface JudgeAnswer {
  clips: (Judgement & { id: string })[];
  script: string[];
  scriptSource: Shoot["scriptSource"];
  takes: Take[];
  noticed: ShootNotice[];
}

// WR4: what the judge noticed about the whole shoot, for the waiting room. Lenient: a bad
// item is dropped and the rest kept, and nothing here can fail the judging. Code only
// checks shape and length; what to tell is the model's call.
const MAX_NOTICES = 4;
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;
const undash = (s: string) => s.replace(/\s*[\u2013\u2014]\s*/g, ", ").replace(/\s+/g, " ").trim();
export function parseNoticed(raw: unknown, shoot: Pick<Shoot, "clips">): ShootNotice[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(shoot.clips.map((c) => c.id));
  const out: ShootNotice[] = [];
  for (const item of raw) {
    if (out.length >= MAX_NOTICES) break;
    if (typeof item !== "object" || item === null) continue;
    const n = item as Record<string, unknown>;
    if (typeof n.text !== "string") continue;
    const text = undash(n.text);
    // A headline, not a paragraph: about 7 words is asked for, 12 is the most kept.
    if (!text || wordCount(text) > 12 || text.length > 80) continue;
    let detail: string | null = null;
    if (typeof n.detail === "string" && n.detail.trim()) {
      detail = undash(n.detail);
      if (wordCount(detail) > 32 || detail.length > 200) continue;
    } else if (n.detail !== undefined && n.detail !== null && typeof n.detail !== "string") continue;
    const asked = Array.isArray(n.clipIds) ? n.clipIds.filter((id): id is string => typeof id === "string") : [];
    const clipIds = [...new Set(asked.filter((id) => known.has(id)))].slice(0, 6);
    // It named clips, none of which are in this shoot: it is about something that is not here.
    if (asked.length > 0 && clipIds.length === 0) continue;
    if (out.some((o) => o.text.toLowerCase() === text.toLowerCase())) continue;
    out.push({ text, detail, clipIds });
  }
  return out;
}

export function parseRotate(raw: unknown): Judgement["rotate"] {
  const value = typeof raw === "string" && /^(90|180|270)(?:\s*(?:°|degrees?))?$/i.test(raw.trim()) ? Number.parseInt(raw, 10) : raw;
  return value === 90 || value === 180 || value === 270 ? value : undefined;
}

function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in answer");
  return JSON.parse(t.slice(start, end + 1));
}

function isNumPair(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) && v.length === 2 &&
    typeof v[0] === "number" && typeof v[1] === "number" &&
    Number.isFinite(v[0]) && Number.isFinite(v[1])
  );
}

// Validates the shape and drops anything the index does not know about.
function validateAnswer(raw: unknown, shoot: Shoot): JudgeAnswer {
  if (typeof raw !== "object" || raw === null) throw new Error("answer is not an object");
  const a = raw as Record<string, unknown>;
  if (!Array.isArray(a.clips)) throw new Error("clips is not an array");
  if (!Array.isArray(a.script)) throw new Error("script is not an array");
  if (typeof a.scriptSource !== "string" || !SCRIPT_SOURCES.has(a.scriptSource)) {
    throw new Error("scriptSource is invalid");
  }
  if (!Array.isArray(a.takes)) throw new Error("takes is not an array");

  const byId = new Map(shoot.clips.map((c) => [c.id, c]));
  const clips: (Judgement & { id: string })[] = [];
  for (const entry of a.clips) {
    if (typeof entry !== "object" || entry === null) continue;
    const c = entry as Record<string, unknown>;
    if (typeof c.id !== "string" || !byId.has(c.id)) continue;
    if (typeof c.kind !== "string" || !KINDS.has(c.kind)) {
      throw new Error(`The footage type for ${clipName(byId.get(c.id))} could not be read. Try judging again.`);
    }
    if (typeof c.verdict !== "string" || !VERDICTS.has(c.verdict)) {
      throw new Error(`The verdict for ${clipName(byId.get(c.id))} could not be read. Try judging again.`);
    }
    if (typeof c.shot !== "string" || !SHOTS.has(c.shot)) {
      throw new Error(`The shot size for ${clipName(byId.get(c.id))} could not be read. Try judging again.`);
    }
    if (typeof c.summary !== "string") throw new Error(`The description for ${clipName(byId.get(c.id))} could not be read. Try judging again.`);
    if (!Array.isArray(c.usableSpans) || !c.usableSpans.every(isNumPair)) {
      throw new Error(`The usable seconds for ${clipName(byId.get(c.id))} could not be read. Try judging again.`);
    }
    const source = byId.get(c.id)!;
    if (source.photo && (c.kind !== "broll" || c.usableSpans.length !== 1 ||
      c.usableSpans[0][0] !== 0 || c.usableSpans[0][1] !== source.meta?.durationS)) {
      throw new Error(`photo ${c.id} must be broll with the whole still as usableSpans`);
    }
    clips.push({
      id: c.id,
      kind: c.kind as Judgement["kind"],
      verdict: c.verdict as Judgement["verdict"],
      shot: c.shot as Judgement["shot"],
      summary: c.summary,
      ...(typeof c.scene === "string" && c.scene.trim() ? { scene: undash(c.scene).slice(0, 120) } : {}),
      ...(typeof c.junk === "string" && c.junk.trim() ? { junk: undash(c.junk).slice(0, 240) } : {}),
      usableSpans: (c.usableSpans as [number, number][]).map(([s, e]) => [s, e]),
      ...(typeof c.peakS === 'number' && Number.isFinite(c.peakS) && (c.usableSpans as [number,number][]).some(([s,e])=>c.peakS as number >= s && (c.peakS as number) <= e) ? {peakS:c.peakS} : {}),
      model: "",
      ...(() => {
        const clip = byId.get(c.id)!;
        const baked = (clip as typeof clip & { _framesRotation?: number })._framesRotation;
        const existing = baked === undefined ? 0 : baked - (clip.meta?.rotation ?? 0);
        const turn = ((existing + (parseRotate(c.rotate) ?? 0)) % 360 + 360) % 360;
        return turn ? { rotate: turn as Judgement["rotate"] } : {};
      })(),
    });
  }

  const script = a.script.filter((l): l is string => typeof l === "string");

  const takes: Take[] = [];
  for (const entry of a.takes) {
    if (typeof entry !== "object" || entry === null) continue;
    const t = entry as Record<string, unknown>;
    if (typeof t.lineIndex !== "number" || !Number.isInteger(t.lineIndex) || t.lineIndex < 0) continue;
    if (!Array.isArray(t.attempts)) throw new Error("take attempts is not an array");
    if (typeof t.starred !== "number") throw new Error("take starred is not a number");
    if (typeof t.why !== "string") throw new Error("take why is not a string");
    const attempts = [];
    for (const att of t.attempts) {
      if (typeof att !== "object" || att === null) continue;
      const at = att as Record<string, unknown>;
      if (typeof at.clipId !== "string" || !byId.has(at.clipId)) continue;
      if (typeof at.s !== "number" || typeof at.e !== "number") continue;
      if (!Number.isFinite(at.s) || !Number.isFinite(at.e) || at.e <= at.s) continue;
      const clip = byId.get(at.clipId)!;
      const dur = clip.meta?.durationS ?? Number.POSITIVE_INFINITY;
      if (at.s < 0 || at.e > dur + 1) continue;
      if (at.practice !== undefined && typeof at.practice !== "boolean") {
        throw new Error("take attempt practice is not a boolean");
      }
      if (at.hook !== undefined && typeof at.hook !== "boolean") {
        throw new Error("take attempt hook is not a boolean");
      }
      if (at.soundbite !== undefined && at.soundbite !== null && typeof at.soundbite !== "string") {
        throw new Error("take attempt soundbite is not a string or null");
      }
      const text = typeof at.text === "string" ? at.text : "";
      if (typeof at.soundbite === "string" && (!at.soundbite.trim() || !text.includes(at.soundbite))) {
        throw new Error("take attempt soundbite must be a verbatim phrase from its text");
      }
      attempts.push({
        clipId: at.clipId,
        s: at.s,
        e: at.e,
        text,
        note: typeof at.note === "string" ? at.note : "",
        ...(typeof at.practice === "boolean" ? { practice: at.practice } : {}),
        ...(typeof at.hook === "boolean" ? { hook: at.hook } : {}),
        ...(at.soundbite === null || typeof at.soundbite === "string" ? { soundbite: at.soundbite } : {}),
      });
    }
    if (attempts.length === 0) continue;
    const starred = Math.min(Math.max(0, Math.trunc(t.starred)), attempts.length - 1);
    // The person already decided this product rule. Ask the judge to correct
    // an invalid pick rather than choosing another performance in code.
    if (attempts[starred].practice && attempts.some((at) => !at.practice)) {
      throw new Error("cannot star a practice attempt while a non-practice attempt exists");
    }
    takes.push({ lineIndex: t.lineIndex, attempts, starred, why: t.why });
  }
  takes.sort((x, y) => x.lineIndex - y.lineIndex);

  return { clips, script, scriptSource: a.scriptSource as Shoot["scriptSource"], takes, noticed: parseNoticed(a.noticed, shoot) };
}

// Hyphens split compound words because Whisper may time "start" and "-up"
// separately. Apostrophes/punctuation have no bearing on word identity.
export function takeTextTokens(text: string): string[] {
  const small = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const integerWords = (n: number): string[] => {
    if (n < 20) return [small[n]];
    if (n < 100) return [tens[Math.floor(n / 10)], ...(n % 10 ? integerWords(n % 10) : [])];
    for (const [size, name] of [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"], [1000, "thousand"], [100, "hundred"]] as const) {
      if (n >= size) return [...integerWords(Math.floor(n / size)), name, ...(n % size ? integerWords(n % size) : [])];
    }
    return [];
  };
  return text.toLowerCase().replace(/[-\u2010-\u2015]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/).filter(Boolean)
    .flatMap((token) => /^\d+$/.test(token) && Number.isSafeInteger(Number(token))
      ? integerWords(Number(token)) : [token]);
}

// Edit distance with an exact-match count for confidence and stable tie breaks.
function tokenDistance(target: string[], said: string[]): { edits: number; matched: number } {
  let row = Array.from({ length: said.length + 1 }, (_, edits) => ({ edits, matched: 0 }));
  for (let i = 1; i <= target.length; i += 1) {
    const next = [{ edits: i, matched: 0 }];
    for (let j = 1; j <= said.length; j += 1) {
      const equal = target[i - 1] === said[j - 1];
      const choices = [
        { edits: row[j - 1].edits + (equal ? 0 : 1), matched: row[j - 1].matched + (equal ? 1 : 0) },
        { edits: row[j].edits + 1, matched: row[j].matched },
        { edits: next[j - 1].edits + 1, matched: next[j - 1].matched },
      ];
      choices.sort((a, b) => a.edits - b.edits || b.matched - a.matched);
      next.push(choices[0]);
    }
    row = next;
  }
  return row[said.length];
}

// Whisper can split one spoken token across timed words ("20" + ",000"). Read a
// run as written: a word that starts with a space or a joining mark continues it.
function runText(words: Word[]): string {
  return words.reduce((text, word, i) => i === 0 || /^[\s,.'\u2019\u2010-\u2015-]/u.test(word.w) ? text + word.w : `${text} ${word.w}`, "");
}

// Remove only complete timed words belonging to a neighbouring line, never
// individual tokens within a timed word (e.g. a single timed "forty-five").
function trimNeighbourEdges(words: Word[], previous: string[], next: string[]): Word[] {
  let start = 0, end = words.length;
  for (let i = 1; i <= words.length; i += 1) {
    const tokens = takeTextTokens(runText(words.slice(0, i)));
    if (tokens.length && tokens.length <= previous.length &&
        tokens.every((t, j) => t === previous[previous.length - tokens.length + j])) start = i;
  }
  for (let i = start; i < words.length; i += 1) {
    const tokens = takeTextTokens(runText(words.slice(i)));
    if (tokens.length && tokens.length <= next.length && tokens.every((t, j) => t === next[j])) {
      end = i;
      break;
    }
  }
  return words.slice(start, end);
}

type SnapMatch = { start: number; end: number; cost: number; confidence: number; proximity: number };
const spansCross = (s: number, e: number, spans: [number, number][]) => spans.some(([a, b]) => s < b && a < e);

// The best contiguous timed-word run for what the attempt said, never using a
// word another attempt in the clip already holds. Undefined below the bar.
function snapMatch(attempt: Take["attempts"][number], words: Word[], held: [number, number][]): SnapMatch | undefined {
  const target = takeTextTokens(attempt.text);
  const own = words.map((w) => takeTextTokens(w.w));
  let best: SnapMatch | undefined;
  for (let start = 0; start < words.length && target.length; start += 1) {
    if (!own[start].length || spansCross(words[start].s, words[start].e, held)) continue;
    for (let end = start; end < words.length; end += 1) {
      if (spansCross(words[end].s, words[end].e, held)) break;
      if (!own[end].length || words[end].e <= words[start].s) continue;
      const said = takeTextTokens(runText(words.slice(start, end + 1)));
      const { edits, matched } = tokenDistance(target, said);
      const length = Math.max(target.length, said.length);
      const candidate = { start, end, cost: edits / length, confidence: matched / length,
        proximity: Math.abs(words[start].s - attempt.s) + Math.abs(words[end].e - attempt.e) };
      if (!best || candidate.cost < best.cost || (candidate.cost === best.cost &&
          (candidate.confidence > best.confidence || (candidate.confidence === best.confidence &&
            candidate.proximity < best.proximity)))) best = candidate;
    }
  }
  return best && best.confidence >= 0.6 && best.cost <= 0.4 ? best : undefined;
}

const CHECK_EDGES = /\bcheck edges\b/i;
const flagEdges = (attempt: Take["attempts"][number]) => {
  if (!CHECK_EDGES.test(attempt.note)) attempt.note = [attempt.note, "check edges"].filter(Boolean).join("; ");
};

// Align what was said to a contiguous timed-word run, without a model call.
// Mutates only attempt s/e and, for uncertain windows, the "check edges" note.
// BUG2: attempts used to snap one at a time, so two could land on the same words
// and the edit could not be put together. HL1: "20,000?" took 12.18 to 14.64 over
// "<a spoken line>" at 13.08 to 14.64. A real judge also gives
// one attempt a sentence that runs into the next line ("...start-up. We don't.")
// beside that line's own attempt ("We don't."). Now: repeats of one line never
// share words; an uncertain attempt takes only words no clear match holds; and
// where attempts of two lines still meet, each shared word goes to the line whose
// script it says.
export function snapTakes(shoot: Shoot): Shoot {
  const wordsByClip = new Map(shoot.clips.map((clip) => [
    clip.id,
    (clip.transcript ?? []).flatMap((seg) => seg.words)
      .filter((word) => Number.isFinite(word.s) && Number.isFinite(word.e) && word.e >= word.s)
      .sort((a, b) => a.s - b.s || a.e - b.e),
  ]));
  const placings = shoot.takes.flatMap((take) => take.attempts.map((attempt) => {
    const windowS = Math.max(0, attempt.s - 2), windowE = attempt.e + 2;
    const words = (wordsByClip.get(attempt.clipId) ?? []).filter((word) => word.s >= windowS && word.e <= windowE);
    return { take, attempt, words, best: snapMatch(attempt, words, []) };
  }));
  const held = new Map<string, [number, number][]>();
  const heldIn = (key: string) => held.get(key) ?? held.set(key, []).get(key)!;
  const order = placings.map((p, i) => ({ p, i })).sort((a, b) => {
    if (!a.p.best || !b.p.best) return Number(!a.p.best) - Number(!b.p.best) || a.i - b.i;
    return a.p.best.cost - b.p.best.cost || b.p.best.confidence - a.p.best.confidence ||
      a.p.best.proximity - b.p.best.proximity || a.i - b.i;
  }).map(({ p }) => p);
  const uncertain: typeof placings = [], clear: typeof placings = [];
  for (const p of order) {
    const match = p.best && snapMatch(p.attempt, p.words, heldIn(`${p.attempt.clipId}\0${p.take.lineIndex}`));
    if (!match) { uncertain.push(p); continue; }
    p.attempt.s = p.words[match.start].s;
    p.attempt.e = p.words[match.end].e;
    heldIn(`${p.attempt.clipId}\0${p.take.lineIndex}`).push([p.attempt.s, p.attempt.e]);
    heldIn(p.attempt.clipId).push([p.attempt.s, p.attempt.e]);
    clear.push(p);
  }
  const neighbourText = (lineIndex: number) => {
    const neighbour = shoot.takes.find((t) => t.lineIndex === lineIndex);
    return takeTextTokens(neighbour?.attempts[Math.min(neighbour.starred, neighbour.attempts.length - 1)]?.text
      || shoot.script[lineIndex] || "");
  };
  for (const { take, attempt, words } of uncertain.sort((a, b) => placings.indexOf(a) - placings.indexOf(b))) {
    const spans = heldIn(attempt.clipId);
    // Unclaimed runs of the window; keep the one that shares most time with the judge's span.
    const runs: Word[][] = [[]];
    for (const word of words) {
      if (spansCross(word.s, word.e, spans)) { if (runs.at(-1)!.length) runs.push([]); }
      else runs.at(-1)!.push(word);
    }
    const shared = (run: Word[]) => run.length ? Math.min(attempt.e, run.at(-1)!.e) - Math.max(attempt.s, run[0].s) : -Infinity;
    const run = runs.reduce((a, b) => shared(b) > shared(a) ? b : a);
    const trimmed = trimNeighbourEdges(run, neighbourText(take.lineIndex - 1), neighbourText(take.lineIndex + 1));
    // No usable words: preserve the judge's span and flag for review.
    if (trimmed.length && trimmed.at(-1)!.e > trimmed[0].s) {
      attempt.s = trimmed[0].s;
      attempt.e = trimmed.at(-1)!.e;
    }
    flagEdges(attempt);
    spans.push([attempt.s, attempt.e]);
  }
  // Clear matches of two lines that still meet: split at the word boundary where
  // each side best says its own script line. One wholly inside another keeps the
  // other's words; the outer one keeps whichever side of it says its own line.
  const lineTokens = (take: Take) => takeTextTokens(shoot.script[take.lineIndex] ?? "");
  const misfit = (take: Take, words: Word[]) => words.length ? tokenDistance(lineTokens(take), takeTextTokens(runText(words))).edits : Infinity;
  for (let pass = 0; pass < clear.length; pass += 1) {
    let moved = false;
    const sorted = clear.slice().sort((a, b) => a.attempt.s - b.attempt.s || b.attempt.e - a.attempt.e);
    for (let i = 0; i < sorted.length; i += 1) for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i], b = sorted[j];
      if (a.attempt.clipId !== b.attempt.clipId || a.take.lineIndex === b.take.lineIndex) continue;
      if (!(a.attempt.e > a.attempt.s && b.attempt.e > b.attempt.s && b.attempt.s < a.attempt.e)) continue;
      const union = (wordsByClip.get(a.attempt.clipId) ?? [])
        .filter((w) => w.s >= a.attempt.s && w.e <= Math.max(a.attempt.e, b.attempt.e));
      if (b.attempt.e <= a.attempt.e) {
        const head = union.filter((w) => w.e <= b.attempt.s), tail = union.filter((w) => w.s >= b.attempt.e);
        const keep = misfit(a.take, head) <= misfit(a.take, tail) ? head : tail;
        if (keep.length) { a.attempt.s = keep[0].s; a.attempt.e = keep.at(-1)!.e; }
        else a.attempt.e = a.attempt.s;
      } else {
        let best = { k: -1, cost: Infinity, off: Infinity };
        for (let k = 0; k + 1 < union.length; k += 1) {
          if (union[k].e > a.attempt.e || union[k + 1].s < a.attempt.s || union[k + 1].e > b.attempt.e) continue;
          const cost = misfit(a.take, union.slice(0, k + 1)) + misfit(b.take, union.slice(k + 1));
          const off = Math.abs(union[k + 1].s - b.attempt.s);
          if (cost < best.cost || (cost === best.cost && off < best.off)) best = { k, cost, off };
        }
        if (best.k < 0) continue;  // the guard below settles it
        a.attempt.e = union[best.k].e;
        b.attempt.s = union[best.k + 1].s;
      }
      moved = true;
    }
    if (!moved) break;
  }
  return shoot;
}

// BUG2 guard where take spans are finalised: two attempts in one clip never share
// time. Where they still would (a judge span with no usable words), the less
// certain one ("check edges", else the later) gives up the shared part, keeping its
// longer side; one wholly inside another keeps no time and is flagged.
export function separateTakes(shoot: Shoot): Shoot {
  const byClip = new Map<string, Take["attempts"]>();
  for (const take of shoot.takes) for (const attempt of take.attempts) {
    if (!byClip.has(attempt.clipId)) byClip.set(attempt.clipId, []);
    byClip.get(attempt.clipId)!.push(attempt);
  }
  for (const attempts of byClip.values()) {
    const placed: Take["attempts"] = [];
    const ranked = attempts.map((attempt, i) => ({ attempt, i }))
      .sort((a, b) => Number(CHECK_EDGES.test(a.attempt.note)) - Number(CHECK_EDGES.test(b.attempt.note)) ||
        a.attempt.s - b.attempt.s || a.i - b.i);
    for (const { attempt } of ranked) {
      for (const other of placed.slice().sort((a, b) => a.s - b.s)) {
        if (other.e <= other.s || !(attempt.s < other.e && other.s < attempt.e)) continue;
        const before = other.s - attempt.s, after = attempt.e - other.e;
        if (before <= 0 && after <= 0) attempt.s = attempt.e = Math.min(Math.max(attempt.s, other.s), other.e);
        else if (before >= after) attempt.e = other.s;
        else attempt.s = other.e;
        flagEdges(attempt);
      }
      placed.push(attempt);
    }
  }
  return shoot;
}

function applyAnswer(shoot: Shoot, answer: JudgeAnswer, engine: Engine): void {
  for (const jc of answer.clips) {
    const clip = shoot.clips.find((c) => c.id === jc.id);
    if (!clip) continue;
    const { id: _id, ...judgement } = jc;
    clip.judgement = { ...judgement, model: engine };
  }
  if (shoot.scriptSource === "pasted") {
    // The person's pasted lines win over whatever the model echoed back.
    answer.script = [...shoot.script];
    answer.scriptSource = "pasted";
  }
  const handPicks = new Map<number, { clipId: string; s: number; e: number } | null>();
  for (const take of shoot.takes) {
    if (take.starredByHand) {
      const picked = take.attempts[take.starred];
      if (picked) handPicks.set(take.lineIndex, picked);
      else handPicks.set(take.lineIndex, null);
    }
  }
  shoot.script = answer.script;
  shoot.scriptSource = answer.scriptSource;
  shoot.noticed = answer.noticed;  // WR4: each judging replaces what the last one noticed
  shoot.takes = answer.takes.map((take) => {
    const hand = handPicks.get(take.lineIndex);
    if (hand === undefined) return take;
    if (hand === null) return { ...take, starred: -1, starredByHand: true };
    const idx = take.attempts.findIndex(
      (at) =>
        at.clipId === hand.clipId &&
        Math.abs(at.s - hand.s) <= 1 &&
        Math.abs(at.e - hand.e) <= 1,
    );
    if (idx < 0) return { ...take, starred: -1, starredByHand: true };
    return { ...take, starred: idx, starredByHand: true };
  });
}

// ------------------------------------------------------------------ main ----

export async function resolveEngine(explicit?: Engine): Promise<Engine> {
  return explicit ?? getEngine();
}

export async function judgeShoot(
  root: string,
  opts: { engine?: Engine; onProgress?: ProgressFn; force?: boolean } = {},
): Promise<JudgeResult> {
  const resolved = path.resolve(root);
  const engine = await resolveEngine(opts.engine);
  // REL2: Settings, Privacy. Off: no contact sheets are made or sent; the judge works from transcripts and measurements.
  const aiSeesFrames = (await getPreferences()).aiSeesFrames !== false;
  const loaded = await readIndex(resolved);
  const shoot = { ...loaded, clips: loaded.clips.filter(c => !c.leftOut && c.stage !== "error") };
  const hash = inputHash(shoot, aiSeesFrames);
  const judgeDir = path.join(resolved, ".sidething", "judge");
  const shaPath = path.join(judgeDir, "input.sha");

  if (!opts.force) {
    try {
      const stored = (await fs.promises.readFile(shaPath, "utf8")).trim();
      if (stored === hash && shoot.clips.some((c) => c.judgement !== null)) {
        return { called: false, shoot };
      }
    } catch {
      // no stored hash yet: judge now
    }
  }

  for (const clip of shoot.clips) {
    opts.onProgress?.({ root: resolved, clipId: clip.id, stage: "judge", pct: 0 });
  }

  if (!shoot.clips.length) {
    loaded.takes = [];
    if (loaded.scriptSource !== "pasted") { loaded.script = []; loaded.scriptSource = "none"; }
    loaded.noticed = [];
    await writeIndex(resolved, loaded);
    await fs.promises.mkdir(judgeDir, { recursive: true });
    await fs.promises.writeFile(shaPath, hash, "utf8");
    return { called: false, shoot: loaded };
  }
  const promptTemplate = await fs.promises.readFile(judgePromptPath(), "utf8");
  const sheets = aiSeesFrames ? await buildGrids(resolved, shoot) : [];
  const grids = sheets.map(sheet => sheet.file);
  const blocks = shoot.clips.map((c) => `${clipBlock(shoot, c)}\nFilmed at: ${filmedAt(c) ?? "unknown"}`).join("\n\n");
  let data = `Shoot: ${shoot.name} (${shoot.clips.length} clips)\n\n${blocks}`;
  if (shoot.scriptSource === "pasted" && shoot.script.length > 0) {
    data += `\n\nPasted script:\n${shoot.script.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;
  }
  if (!aiSeesFrames) data += "\n\nNo pictures: the person turned off \"AI sees frames\". Judge from the transcripts, file details and measurements only; where a verdict needs the picture, say so in its reason.";
  if (grids.length > 0) {
    const names = sheets.map(sheet => `- ${path.basename(sheet.file)}: rows for ${sheet.clipIds.join(", ")}`);
    data += `\n\nContact sheets (up to 16 available timestamped frames per clip, labelled by clip):\n${names.join("\n")}`;
  }
  const brief = await fs.promises.readFile(path.join(resolved, ".sidething", "brief.json"), "utf8")
    .then(text => JSON.parse(text), error => { if (error.code === "ENOENT") return null; throw error; });
  data += `\n\nThis video's brief: ${JSON.stringify(brief)}`;
  const prompt = `${promptTemplate}\n\n--- SHOOT DATA ---\n${data}\n`;

  let answer: JudgeAnswer;
  let rawAnswer: string;
  try {
    rawAnswer = await measureModelWork("judge", shoot.clips.length, () => runModel({ engine, prompt, images: grids, cwd: resolved, timeoutMs: 15 * 60_000 }));
    answer = validateAnswer(extractJson(rawAnswer), shoot);
  } catch (firstErr) {
    const message = firstErr instanceof Error ? firstErr.message : String(firstErr);
    // Plain UI errors from the adapter are not shape failures: do not retry.
    if (
      message.includes("isn't signed in") ||
      message.includes("isn't installed") ||
      message.includes("couldn't finish") ||
      message.includes("timed out")
    ) {
      throw firstErr;
    }
    const retryPrompt =
      `${prompt}\nYour previous answer failed validation: ${message}. ` +
      `Reply with JSON only, matching exactly the shape described above.\n`;
    rawAnswer = await runModel({ engine, prompt: retryPrompt, images: grids, cwd: resolved, timeoutMs: 15 * 60_000 });
    try {
      answer = validateAnswer(extractJson(rawAnswer), shoot);
    } catch {
      throw new Error("the model's answer wasn't valid JSON");
    }
  }

  const fresh = await readIndex(resolved);
  if (fresh.clips.filter(c => !c.leftOut && c.stage !== "error").map(c => c.id).join("\0") !== shoot.clips.map(c => c.id).join("\0")) {
    // A choice changed during the call. Its queued rethink owns the next result.
    return { called: true, shoot: fresh, rawAnswer };
  }
  const previousTurns = new Map(fresh.clips.map(c => [c.id, clipTurn(c)]));
  applyAnswer(fresh, answer, engine);
  for (const clip of fresh.clips) clip.meta = displayedClip(clip).meta;
  snapTakes(fresh);
  separateTakes(fresh);
  applyTakeMeasures(fresh);
  await writeIndex(resolved, fresh);
  if (fresh.clips.some(c => previousTurns.get(c.id) !== clipTurn(c))) void queueClipPictures(resolved).catch(error => console.error("[rotation] Picture rebuild failed:", error));
  await fs.promises.mkdir(judgeDir, { recursive: true });
  await fs.promises.writeFile(shaPath, hash, "utf8");

  for (const clip of fresh.clips) {
    opts.onProgress?.({ root: resolved, clipId: clip.id, stage: "done", pct: 100 });
  }
  return { called: true, shoot: fresh, rawAnswer };
}

// ------------------------------------------------------------- ipc helpers ----

export async function setScript(
  root: string,
  lines: string[],
  opts: { engine?: Engine; onProgress?: ProgressFn } = {},
): Promise<Shoot> {
  const resolved = path.resolve(root);
  const shoot = await readIndex(resolved);
  shoot.script = lines;
  shoot.scriptSource = "pasted";
  await writeIndex(resolved, shoot);
  const result = await judgeShoot(resolved, {
    engine: opts.engine,
    onProgress: opts.onProgress,
    force: true,
  });
  return result.shoot;
}

const starSaves = new Map<string, Promise<Shoot>>();
export async function setFootageStar(root: string, key: string, starred: boolean): Promise<Shoot> {
  const resolved = path.resolve(root);
  const prior = starSaves.get(resolved);
  const save = (prior ? prior.catch(() => undefined) : Promise.resolve()).then(async () => {
    const shoot = (await import("./scenes")).withScenes(await readIndex(resolved));
    const next = applyFootageStar(shoot, key, starred);
    await writeIndex(resolved, next);
    return next;
  });
  starSaves.set(resolved, save);
  try { return await save; }
  finally { if (starSaves.get(resolved) === save) starSaves.delete(resolved); }
}

export async function starTake(
  root: string,
  lineIndex: number,
  attempt: number,
): Promise<Shoot> {
  const resolved = path.resolve(root);
  const shoot = await readIndex(resolved);
  const take = shoot.takes.find((t) => t.lineIndex === lineIndex);
  if (!take) throw new Error(`no take for line ${lineIndex}`);
  if (attempt < 0 || attempt >= take.attempts.length) {
    throw new Error(`no attempt ${attempt} for line ${lineIndex}`);
  }
  take.starred = attempt;
  take.starredByHand = true;
  await writeIndex(resolved, shoot);
  return shoot;
}

// The same atomic index writer used by starTake. Preserve the judge's tags.
export async function setClipTag(root: string, clipId: string, tag: Shoot["clips"][number]["byHand"] | null): Promise<Shoot> {
  const resolved = path.resolve(root);
  const shoot = await readIndex(resolved);
  const clip = shoot.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error("This clip no longer exists.");
  const previousTurn = clipTurn(clip);
  if (tag === null) clip.byHand = clip.byHand?.star === undefined ? undefined : { star: clip.byHand.star };
  else {
    if (!tag || (tag.kind !== undefined && !KINDS.has(tag.kind)) ||
        (tag.shaky !== undefined && typeof tag.shaky !== "boolean") ||
        (tag.rotate !== undefined && ![0, 90, 180, 270].includes(tag.rotate))) throw new Error("Choose a valid clip tag.");
    clip.byHand = { ...(clip.byHand?.star !== undefined ? { star: clip.byHand.star } : {}), ...(tag.kind !== undefined ? { kind: tag.kind } : {}), ...(tag.shaky !== undefined ? { shaky: tag.shaky } : {}), ...(tag.rotate !== undefined ? { rotate: tag.rotate } : {}) };
  }
  clip.meta = displayedClip(clip).meta;
  await writeIndex(resolved, shoot);
  if (previousTurn !== clipTurn(clip)) void queueClipPictures(resolved).catch(error => console.error("[rotation] Picture rebuild failed:", error));
  return shoot;
}
