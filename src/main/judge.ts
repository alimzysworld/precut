// The AI judge: one model call per shoot. Builds the shoot summary plus
// contact-sheet grids, validates the answer against the schema shape, and
// writes judgement/script/takes into .sidething/index.json. Re-judging is
// skipped when the input hash in .sidething/judge/input.sha is unchanged.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Judgement, Shoot, Take, Word } from "../shared/schema";
import { runModel, type Engine } from "./ai";
import { effectiveClip, stepsChanged } from "./steps";
import { getEngine } from "./settings";

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
  return JSON.parse(raw) as Shoot;
}

async function writeIndex(root: string, shoot: Shoot): Promise<void> {
  shoot.updatedAt = new Date().toISOString();
  const dir = path.join(root, ".sidething");
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, "index.json.tmp");
  await fs.promises.writeFile(tmp, JSON.stringify(shoot, null, 1), "utf8");
  await fs.promises.rename(tmp, indexPath(root));
  stepsChanged(root);
}

// ------------------------------------------------------------ input build ----

function clipBlock(shoot: Shoot, clip: Shoot["clips"][number]): string {
  const manual = clip.byHand;
  clip = effectiveClip(clip);
  const m = clip.meta;
  const lines: string[] = [];
  const dur = m?.durationS ?? 0;
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
  const segs = clip.transcript ?? [];
  if (segs.length === 0) {
    lines.push("Transcript: (none)");
  } else {
    lines.push("Transcript:");
    for (const seg of segs) lines.push(`[${fmt(seg.s)}] ${seg.text}`);
  }
  return lines.join("\n");
}

function inputHash(shoot: Shoot): string {
  // Only the pasted script is an input; an inferred script is judge output,
  // so hashing it would make every re-run look changed and re-call forever.
  const payload = {
    pastedScript: shoot.scriptSource === "pasted" ? shoot.script : null,
    clips: shoot.clips.map((c) => ({ id: c.id, transcript: c.transcript, shake: effectiveClip(c).shake, byHand: c.byHand })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// ------------------------------------------------------------ grid images ----

function execFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${err.slice(-400)}`));
    });
  });
}

function framePath(root: string, clip: Shoot["clips"][number], frame: string): string {
  const direct = path.join(root, ".sidething", frame);
  if (fs.existsSync(direct)) return direct;
  return path.join(root, ".sidething", "frames", path.basename(frame));
}

async function buildGrids(root: string, shoot: Shoot): Promise<string[]> {
  const judgeDir = path.join(root, ".sidething", "judge");
  await fs.promises.mkdir(judgeDir, { recursive: true });
  const clips = shoot.clips.filter((c) => c.frames.length > 0);
  const perImage = 8;
  const grids: string[] = [];
  for (let g = 0; g * perImage < clips.length; g++) {
    const group = clips.slice(g * perImage, (g + 1) * perImage);
    const rowFiles: string[] = [];
    for (let r = 0; r < group.length; r++) {
      const clip = group[r];
      const frames = clip.frames.slice(0, 8).map((f) => framePath(root, clip, f));
      const rowPath = path.join(judgeDir, `_row-${g}-${r}.jpg`);
      const inputs: string[] = [];
      const filters: string[] = [];
      frames.forEach((f, i) => {
        inputs.push("-i", f);
        filters.push(
          `[${i}:v]scale=240:135:force_original_aspect_ratio=increase,crop=240:135,setsar=1[v${i}]`,
        );
      });
      const labels = frames.map((_, i) => `[v${i}]`).join("");
      filters.push(`${labels}hstack=inputs=${frames.length}[row]`);
      filters.push(
        `[row]pad=iw:ih+30:0:30:black,drawtext=text='${clip.id}':x=8:y=7:fontsize=19:fontcolor=white[final]`,
      );
      await execFfmpeg([
        "-y", "-v", "error", ...inputs,
        "-filter_complex", filters.join(";"),
        "-map", "[final]", "-frames:v", "1", "-q:v", "3", rowPath,
      ]);
      rowFiles.push(rowPath);
    }
    const gridPath = path.join(judgeDir, `grid-${g + 1}.jpg`);
    const inputs: string[] = [];
    const filters: string[] = [];
    rowFiles.forEach((f, i) => {
      inputs.push("-i", f);
      filters.push(`[${i}:v]setsar=1[r${i}]`);
    });
    const labels = rowFiles.map((_, i) => `[r${i}]`).join("");
    filters.push(`${labels}vstack=inputs=${rowFiles.length}[final]`);
    await execFfmpeg([
      "-y", "-v", "error", ...inputs,
      "-filter_complex", filters.join(";"),
      "-map", "[final]", "-frames:v", "1", "-q:v", "3", gridPath,
    ]);
    for (const f of rowFiles) await fs.promises.unlink(f).catch(() => {});
    grids.push(gridPath);
  }
  return grids;
}

// ------------------------------------------------------- validate + apply ----

interface JudgeAnswer {
  clips: (Judgement & { id: string })[];
  script: string[];
  scriptSource: Shoot["scriptSource"];
  takes: Take[];
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
      throw new Error(`clip ${c.id} kind is invalid`);
    }
    if (typeof c.verdict !== "string" || !VERDICTS.has(c.verdict)) {
      throw new Error(`clip ${c.id} verdict is invalid`);
    }
    if (typeof c.shot !== "string" || !SHOTS.has(c.shot)) {
      throw new Error(`clip ${c.id} shot is invalid`);
    }
    if (typeof c.summary !== "string") throw new Error(`clip ${c.id} summary is invalid`);
    if (!Array.isArray(c.usableSpans) || !c.usableSpans.every(isNumPair)) {
      throw new Error(`clip ${c.id} usableSpans is invalid`);
    }
    clips.push({
      id: c.id,
      kind: c.kind as Judgement["kind"],
      verdict: c.verdict as Judgement["verdict"],
      shot: c.shot as Judgement["shot"],
      summary: c.summary,
      usableSpans: (c.usableSpans as [number, number][]).map(([s, e]) => [s, e]),
      model: "",
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
      attempts.push({
        clipId: at.clipId,
        s: at.s,
        e: at.e,
        text: typeof at.text === "string" ? at.text : "",
        note: typeof at.note === "string" ? at.note : "",
      });
    }
    if (attempts.length === 0) continue;
    const starred = Math.min(Math.max(0, Math.trunc(t.starred)), attempts.length - 1);
    takes.push({ lineIndex: t.lineIndex, attempts, starred, why: t.why });
  }
  takes.sort((x, y) => x.lineIndex - y.lineIndex);

  return { clips, script, scriptSource: a.scriptSource as Shoot["scriptSource"], takes };
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

// Remove only complete timed words belonging to a neighbouring line, never
// individual tokens within a timed word (e.g. a single timed "forty-five").
function trimNeighbourEdges(words: Word[], previous: string[], next: string[]): Word[] {
  let start = 0, end = words.length;
  for (let i = 1; i <= words.length; i += 1) {
    const tokens = takeTextTokens(words.slice(0, i).map((w) => w.w).join(" "));
    if (tokens.length && tokens.length <= previous.length &&
        tokens.every((t, j) => t === previous[previous.length - tokens.length + j])) start = i;
  }
  for (let i = start; i < words.length; i += 1) {
    const tokens = takeTextTokens(words.slice(i).map((w) => w.w).join(" "));
    if (tokens.length && tokens.length <= next.length && tokens.every((t, j) => t === next[j])) {
      end = i;
      break;
    }
  }
  return words.slice(start, end);
}

// Align what was said to a contiguous timed-word run, without a model call.
// Mutates only attempt s/e and, for uncertain windows, the "check edges" note.
export function snapTakes(shoot: Shoot): Shoot {
  const wordsByClip = new Map(shoot.clips.map((clip) => [
    clip.id,
    (clip.transcript ?? []).flatMap((seg) => seg.words)
      .filter((word) => Number.isFinite(word.s) && Number.isFinite(word.e) && word.e >= word.s)
      .sort((a, b) => a.s - b.s || a.e - b.e),
  ]));
  for (const take of shoot.takes) {
    for (const attempt of take.attempts) {
      const windowS = Math.max(0, attempt.s - 2), windowE = attempt.e + 2;
      const words = (wordsByClip.get(attempt.clipId) ?? [])
        .filter((word) => word.s >= windowS && word.e <= windowE);
      const target = takeTextTokens(attempt.text);
      const tokens = words.map((w) => takeTextTokens(w.w));
      let best: { start: number; end: number; cost: number; confidence: number; proximity: number } | undefined;
      for (let start = 0; start < words.length && target.length; start += 1) {
        if (!tokens[start].length) continue;
        const said: string[] = [];
        for (let end = start; end < words.length; end += 1) {
          said.push(...tokens[end]);
          if (!tokens[end].length || words[end].e <= words[start].s) continue;
          const { edits, matched } = tokenDistance(target, said);
          const length = Math.max(target.length, said.length);
          const candidate = { start, end, cost: edits / length, confidence: matched / length,
            proximity: Math.abs(words[start].s - attempt.s) + Math.abs(words[end].e - attempt.e) };
          if (!best || candidate.cost < best.cost || (candidate.cost === best.cost &&
              (candidate.confidence > best.confidence || (candidate.confidence === best.confidence &&
                candidate.proximity < best.proximity)))) best = candidate;
        }
      }
      if (best && best.confidence >= 0.6 && best.cost <= 0.4) {
        attempt.s = words[best.start].s;
        attempt.e = words[best.end].e;
      } else {
        const neighbourText = (lineIndex: number) => {
          const neighbour = shoot.takes.find((t) => t.lineIndex === lineIndex);
          return takeTextTokens(neighbour?.attempts[Math.min(neighbour.starred, neighbour.attempts.length - 1)]?.text
            || shoot.script[lineIndex] || "");
        };
        const trimmed = trimNeighbourEdges(words, neighbourText(take.lineIndex - 1), neighbourText(take.lineIndex + 1));
        // No usable words: preserve the judge's span and flag for review.
        if (trimmed.length && trimmed.at(-1)!.e > trimmed[0].s) {
          attempt.s = trimmed[0].s;
          attempt.e = trimmed.at(-1)!.e;
        }
        if (!/\bcheck edges\b/i.test(attempt.note)) {
          attempt.note = [attempt.note, "check edges"].filter(Boolean).join("; ");
        }
      }
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
  const handPicks = new Map<number, { clipId: string; s: number; e: number }>();
  for (const take of shoot.takes) {
    if (take.starredByHand) {
      const picked = take.attempts[take.starred];
      if (picked) handPicks.set(take.lineIndex, picked);
    }
  }
  shoot.script = answer.script;
  shoot.scriptSource = answer.scriptSource;
  shoot.takes = answer.takes.map((take) => {
    const hand = handPicks.get(take.lineIndex);
    if (!hand) return take;
    const idx = take.attempts.findIndex(
      (at) =>
        at.clipId === hand.clipId &&
        Math.abs(at.s - hand.s) <= 1 &&
        Math.abs(at.e - hand.e) <= 1,
    );
    if (idx < 0) return take;
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
  const shoot = await readIndex(resolved);
  const hash = inputHash(shoot);
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

  const promptTemplate = await fs.promises.readFile(judgePromptPath(), "utf8");
  const grids = await buildGrids(resolved, shoot);
  const blocks = shoot.clips.map((c) => clipBlock(shoot, c)).join("\n\n");
  let data = `Shoot: ${shoot.name} (${shoot.clips.length} clips)\n\n${blocks}`;
  if (shoot.scriptSource === "pasted" && shoot.script.length > 0) {
    data += `\n\nPasted script:\n${shoot.script.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;
  }
  if (grids.length > 0) {
    const names = grids.map((g, i) => {
      const group = shoot.clips
        .filter((c) => c.frames.length > 0)
        .slice(i * 8, (i + 1) * 8)
        .map((c) => c.id)
        .join(", ");
      return `- ${path.basename(g)}: rows for ${group}`;
    });
    data += `\n\nContact sheets (8 frames per clip, one labelled row per clip):\n${names.join("\n")}`;
  }
  const prompt = `${promptTemplate}\n\n--- SHOOT DATA ---\n${data}\n`;

  let answer: JudgeAnswer;
  let rawAnswer: string;
  try {
    rawAnswer = await runModel({ engine, prompt, images: grids, cwd: resolved });
    answer = validateAnswer(extractJson(rawAnswer), shoot);
  } catch (firstErr) {
    const message = firstErr instanceof Error ? firstErr.message : String(firstErr);
    // Plain UI errors from the adapter are not shape failures: do not retry.
    if (
      message.includes("isn't signed in") ||
      message.includes("isn't installed") ||
      message.includes("timed out")
    ) {
      throw firstErr;
    }
    const retryPrompt =
      `${prompt}\nYour previous answer failed validation: ${message}. ` +
      `Reply with JSON only, matching exactly the shape described above.\n`;
    rawAnswer = await runModel({ engine, prompt: retryPrompt, images: grids, cwd: resolved });
    try {
      answer = validateAnswer(extractJson(rawAnswer), shoot);
    } catch {
      throw new Error("the model's answer wasn't valid JSON");
    }
  }

  const fresh = await readIndex(resolved);
  applyAnswer(fresh, answer, engine);
  snapTakes(fresh);
  await writeIndex(resolved, fresh);
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
  if (tag === null) delete clip.byHand;
  else {
    if (!tag || (tag.kind !== undefined && !KINDS.has(tag.kind)) ||
        (tag.shaky !== undefined && typeof tag.shaky !== "boolean")) throw new Error("Choose a valid clip tag.");
    clip.byHand = { ...(tag.kind !== undefined ? { kind: tag.kind } : {}), ...(tag.shaky !== undefined ? { shaky: tag.shaky } : {}) };
  }
  await writeIndex(resolved, shoot);
  return shoot;
}
