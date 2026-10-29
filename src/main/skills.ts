// Skills are ordinary Markdown files. Keep ids stable when their names change.
import { app, BrowserWindow, shell } from "electron";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Grade, Skill, SkillFormat, Shoot, Template } from "../shared/schema";
import { standardFrameRate } from "../shared/frame-rate";
import { GRADE_BOUNDS, gradeFromLook, neutralGrade, type GradeInput, type LookOptions } from "./grade";

// Keep older, untyped video skills compatible with the shared UI contract.
export type TypedSkill = Skill & { type?: "video" | "titles"; look?: string; lookGrade?: Grade };
export const SEED_SKILLS: Omit<TypedSkill, "path">[] = [
  {
    id: "my-taste", name: "My taste", description: "My defaults for every reel.", global: true,
    format: { aspect: "9:16", width: 1080, height: 1920, fps: null },
    body: `sidething wrote this as a starting point. Make it yours.

# My taste

Get to the hook in the first second. No intro before the point.

Cut breaths, false starts and the pause before a line. Keep enough space that I still sound like me.

Clean cuts between my talking lines. A transition, zoom or sound only where it adds energy, like going into b-roll or a screenshot, never just to look busy.

Keep my face steady in the frame.

When captions arrive, make them large and centred. Keep them easy to read.

Music sits under the voice, never over it. If it fights the words, turn it down or leave it out.
`,
  },
  {
    id: "talking-head-reel", name: "Talking head reel", description: "Use when I am talking straight to camera.", global: false,
    format: { aspect: "9:16", width: 1080, height: 1920, fps: null },
    body: `sidething wrote this as a starting point. Make it yours.

# Talking head reel

Pick one idea I can say cleanly. Start with its strongest hook in the first second.

Use the take where I sound sure of the line, not just the take with no mistakes.

Cut breaths and false starts. Cut the waiting between lines. Keep the words in their natural order.

Stay on me while the point lands. A punch in on the line that matters is fine; nothing just to make it feel busy.

When captions arrive, keep them large and centred. Show a short phrase at a time.

If there is music, keep it under my voice and never over it. The words do the work.
`,
  },
  {
    id: "titles-bold-and-personal", name: "Titles: bold and personal", type: "titles",
    description: "Big, personal words around me, with yellow on the word that matters.", global: true,
    body: `# Titles: bold and personal

Make the words feel like part of my video. Bold italic sans. White for the thought, yellow for the word that matters.

Let a small phrase sit beside me, then go properly big when the idea earns it. At its biggest, one phrase fills the frame and its key word is yellow. Use that confidence, not the same layout on every line.

Put a big word behind me when I am in shot and it makes the moment better. Keep my face clear. If there is no person in frame, keep the words in front.

Land titles on the hook and the few ideas I want someone to remember. Leave room to hear me. Do not turn every word into a graphic.

If I ask for subtitles, let small yellow italic phrases carry the rest. Keep them readable on a phone and away from the platform buttons. Never stack two subtitle phrases on top of each other.

Use motion to land the words, then let them sit. No constant bouncing. If I give a different direction in the prompt, follow that.
`,
  },
];

const folder = () => join(app.getPath("userData"), "skills");
function skillPath(id: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("Skill ids must be lowercase slugs.");
  return join(folder(), `${id}.md`);
}
const sortSkills = <T extends TypedSkill>(skills: T[]) => skills.sort((a, b) => Number(b.global) - Number(a.global) || Number(a.type === "titles") - Number(b.type === "titles") || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

function validLookGrade(value: unknown): value is Grade {
  if (!value || typeof value !== "object") return false;
  const grade = value as Grade;
  return ["slog3", "rec709", "hlg", "unknown"].includes(grade.input) && typeof grade.look === "string" &&
    (Object.keys(GRADE_BOUNDS) as (keyof typeof GRADE_BOUNDS)[]).every((key) =>
      Number.isFinite(grade[key]) && grade[key] >= GRADE_BOUNDS[key][0] && grade[key] <= GRADE_BOUNDS[key][1]);
}

// This frontmatter contract contains only scalars. Accept quoted strings,
// comments, and YAML block strings too, so ordinary editor changes round trip.
function scalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    const match = value.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
    if (!match) throw new Error("Unclosed string");
    return JSON.parse(match[1]) as string;
  }
  if (value.startsWith("'")) {
    const match = value.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
    if (!match) throw new Error("Unclosed string");
    return match[1].replace(/''/g, "'");
  }
  const plain = value.replace(/\s+#.*$/, "").trim();
  if (!plain || plain.startsWith("#") || /^(null|~)$/i.test(plain)) return "";
  if (/^[\[\]{}&*!>|`@]/.test(plain) || /:\s/.test(plain)) throw new Error("Invalid scalar");
  return plain;
}

function parse(id: string, path: string, contents: string): TypedSkill {
  const fallback: Skill = { id, path, name: id, description: id, global: false, body: contents };
  const opening = contents.match(/^\uFEFF?---\r?\n/);
  if (!opening) return fallback;
  const rest = contents.slice(opening[0].length);
  const closing = rest.match(/^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m);
  if (!closing || closing.index === undefined) return fallback;
  const metadata = rest.slice(0, closing.index);
  const body = rest.slice(closing.index + closing[0].length);
  try {
    const fields: Record<string, string> = {};
    const lines = metadata.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim() || lines[i].trimStart().startsWith("#")) continue;
      const field = lines[i].match(/^([\w-]+):(?:[ \t]+(.*)|[ \t]*)$/);
      if (!field || Object.hasOwn(fields, field[1])) throw new Error("Broken frontmatter");
      const raw = field[2] ?? "";
      if ((field[1] === "format" || field[1] === "lookGrade") && !raw.trim()) {
        const group = field[1];
        fields[group] = "true";
        while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1])) {
          const line = lines[++i];
          if (!line.trim() || line.trimStart().startsWith("#")) continue;
          const nested = line.match(/^\s+(\w+):\s*(.*)$/);
          const keys = group === "format" ? ["aspect", "width", "height", "fps"] : ["input", "exposure", "contrast", "saturation", "temperature", "tint", "look"];
          if (!nested || !keys.includes(nested[1]) || Object.hasOwn(fields, `${group}.${nested[1]}`)) throw new Error(`Invalid ${group}`);
          fields[`${group}.${nested[1]}`] = scalar(nested[2]);
        }
        continue;
      }
      if (/^[>|][+-]?(?:\s+#.*)?$/.test(raw.trim())) {
        const block: string[] = [];
        while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1])) block.push(lines[++i]);
        const indent = block.find((line) => line.trim())?.match(/^\s*/)?.[0].length ?? 0;
        fields[field[1]] = block.map((line) => line.slice(indent)).join(raw.trim().startsWith(">") ? " " : "\n").trim();
      } else fields[field[1]] = scalar(raw);
    }
    if (fields.global && !/^(true|false)$/i.test(fields.global)) throw new Error("Invalid global flag");
    if (fields.type && fields.type !== "video" && fields.type !== "titles") throw new Error("Invalid skill type");
    const lookGrade = fields.lookGrade ? {
      input: fields["lookGrade.input"], look: fields["lookGrade.look"],
      ...Object.fromEntries(Object.keys(GRADE_BOUNDS).map((key) => [key, fields[`lookGrade.${key}`] === undefined ? NaN : Number(fields[`lookGrade.${key}`])])),
    } : undefined;
    return {
      ...fallback, name: fields.name?.trim() || id,
      description: fields.description?.replace(/\s+/g, " ").trim() || id,
      global: fields.global?.toLowerCase() === "true", body,
      ...(fields.type ? { type: fields.type as TypedSkill["type"] } : {}),
      ...(fields.look?.trim() ? { look: fields.look.trim() } : {}),
      ...(validLookGrade(lookGrade) ? { lookGrade } : {}),
      ...(fields.format ? { format: validateFormat({
        aspect: fields["format.aspect"] as SkillFormat["aspect"],
        width: Number(fields["format.width"]), height: Number(fields["format.height"]),
        fps: fields["format.fps"] === "match" || !fields["format.fps"] ? null : Number(fields["format.fps"]),
      }) } : {}),
    };
  } catch { return fallback; }
}

function validateFormat(format: SkillFormat): SkillFormat {
  if (!format || !["9:16", "16:9", "1:1", "4:5"].includes(format.aspect) ||
      !Number.isInteger(format.width) || format.width <= 0 || !Number.isInteger(format.height) || format.height <= 0 ||
      (format.fps !== null && (!Number.isFinite(format.fps) || format.fps <= 0))) throw new Error("Choose a valid skill format.");
  return { aspect: format.aspect, width: format.width, height: format.height, fps: format.fps };
}

// Encode dimensions and resolved footage fps so old template callers can still
// look up the exact format. Each stored cut also keeps its template snapshot.
export function skillTemplate(skills: Skill[], ids: string[], shoot: Shoot, fallback: Template, defaultFps?: number | null): Template {
  const type = ids.map((id) => skills.find((s) => s.id === id && !s.global && (s as TypedSkill).type !== "titles")).find(Boolean);
  const format = type?.format ?? skills.find((s) => s.global && (s as TypedSkill).type !== "titles")?.format;
  if (!format) return defaultFps == null ? fallback : { ...fallback, id: `${fallback.id}-fps-${defaultFps}`, fps: defaultFps };
  // An explicit skill format wins; a matching-footage skill inherits Settings.
  // EXP3: a standard rate, so the export plays at the rate the sheet names (an iPhone's 59.89 average is a 60 clip).
  const fps = standardFrameRate(format.fps ?? defaultFps ?? shoot.clips.find((c) => c.meta && c.meta.fps > 0)?.meta?.fps ?? fallback.fps);
  return { id: `skill-${format.aspect.replace(":", "-")}-${format.width}x${format.height}-${fps}`,
    name: `${format.aspect} ${format.width}x${format.height} ${fps} fps`,
    width: format.width, height: format.height, fps, drpPath: null, notes: "Format from skills" };
}

function serialize(skill: Omit<TypedSkill, "path">): string {
  const f = skill.format ? validateFormat(skill.format) : null;
  const format = f ? `format:\n  aspect: "${f.aspect}"\n  width: ${f.width}\n  height: ${f.height}\n  fps: ${f.fps ?? "match"}\n` : "";
  if (skill.type !== undefined && skill.type !== "video" && skill.type !== "titles") throw new Error("Choose a valid skill type.");
  const look = skill.look?.trim();
  const grade = validLookGrade(skill.lookGrade) && skill.lookGrade.look === look ? skill.lookGrade : undefined;
  const lookFields = look ? `look: ${JSON.stringify(look)}\n` : "";
  const cache = grade ? `lookGrade:\n${Object.entries(grade).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}\n`).join("")}` : "";
  return `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\nglobal: ${skill.global}\n${skill.type ? `type: ${skill.type}\n` : ""}${format}${lookFields}${cache}---\n${skill.body}`;
}

async function atomicWrite(skill: Omit<TypedSkill, "path">, target = skillPath(skill.id)): Promise<void> {
  const temp = join(folder(), `.skill-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, serialize(skill), { flag: "wx" });
    await fs.rename(temp, target);
  } finally { await fs.unlink(temp).catch(() => {}); }
}

let watcher: FSWatcher | null = null;
let watchTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let lastFingerprint = "";
async function fingerprint(): Promise<string> {
  try {
    const entries = await fs.readdir(folder(), { withFileTypes: true });
    const files = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map(async (entry) => {
      const stat = await fs.stat(join(folder(), entry.name));
      return `${entry.name}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    }));
    return files.sort().join("\n");
  } catch { return "unavailable"; }
}
async function notifyChanges(): Promise<void> {
  const next = await fingerprint();
  if (next === lastFingerprint) return;
  lastFingerprint = next;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      try { window.webContents.send("api:skills-changed"); } catch { /* window closed during delivery */ }
    }
  }
}
function changed(): void {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => { void notifyChanges(); }, 180);
  watchTimer.unref();
}
async function startWatcher(): Promise<void> {
  if (!pollTimer) {
    lastFingerprint = await fingerprint();
    // fs.watch is the fast path. Poll metadata too for filesystems or sandboxed
    // hosts that silently omit directory events. Fingerprints prevent echoes.
    pollTimer = setInterval(() => { void notifyChanges(); }, 1000);
    pollTimer.unref();
  }
  if (watcher) return;
  try {
    watcher = watch(folder(), (_event, filename) => {
      if (!filename || filename.toString().endsWith(".md")) changed();
    });
    watcher.unref();
    watcher.on("error", () => { watcher?.close(); watcher = null; changed(); });
  } catch { /* metadata polling still picks up edits */ }
}
app.once("before-quit", () => { watcher?.close(); clearTimeout(watchTimer); clearInterval(pollTimer); });

async function ensureFolder(): Promise<void> {
  await fs.mkdir(folder(), { recursive: true });
  // Do not seed a folder containing other user files, even if none are Markdown.
  if ((await fs.readdir(folder())).length === 0) {
    for (const skill of SEED_SKILLS) await atomicWrite(skill);
  }
  await startWatcher();
}
async function readSkills(): Promise<TypedSkill[]> {
  const entries = await fs.readdir(folder(), { withFileTypes: true });
  const skills: TypedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(folder(), entry.name);
    try {
      const skill = parse(entry.name.slice(0, -3), path, await fs.readFile(path, "utf8"));
      if (skill.lookGrade && skill.lookGrade.look !== skill.look) {
        delete skill.lookGrade;
        await atomicWrite(skill, path);
      }
      skills.push(skill);
    }
    catch (error) {
      // An external editor may remove a file between readdir and readFile.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  sortSkills(skills);
  // Hand edits can leave zero or several flags. Resolve to one deterministically
  // without rewriting anyone's file just because the list was opened.
  const globals = [false, true].map((titles) => {
    const group = skills.filter((skill) => (skill.type === "titles") === titles);
    return (group.find((skill) => skill.global) ?? group.find((skill) => skill.id === "my-taste") ?? group[0])?.id;
  });
  return sortSkills(skills.map((skill) => ({ ...skill, global: globals.includes(skill.id) })));
}

// Serialize operations so two windows cannot race seed creation or promotion.
let queue: Promise<unknown> = Promise.resolve();
function run<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(async () => { await ensureFolder(); return operation(); });
  queue = result.catch(() => {});
  return result;
}
export function listSkills(): Promise<TypedSkill[]> { return run(readSkills); }
export function saveSkill(input: Omit<TypedSkill, "path">): Promise<TypedSkill> {
  return run(async () => {
    if (input.format) validateFormat(input.format);
    const path = skillPath(input.id);
    const skills = await readSkills();
    const previous = skills.find((skill) => skill.id === input.id);
    const skill: TypedSkill = {
      ...input, path, name: input.name.trim() || input.id,
      description: input.description.replace(/\s+/g, " ").trim() || input.id,
      global: Boolean(input.global) || Boolean(previous?.global && (previous.type === "titles") === (input.type === "titles")) || !skills.some((s) => (s.type === "titles") === (input.type === "titles")),
      look: input.look?.trim() || undefined,
      lookGrade: previous?.look === input.look?.trim() ? previous?.lookGrade : undefined,
    };
    if (skill.global) {
      // Read the raw flags too: a hand-edited second global may have been hidden
      // by the deterministic list resolution above.
      for (const other of skills) {
        if (other.id === skill.id || (other.type === "titles") !== (skill.type === "titles")) continue;
        const raw = parse(other.id, other.path, await fs.readFile(other.path, "utf8"));
        if (raw.global) await atomicWrite({ ...raw, global: false }, other.path);
      }
    }
    await atomicWrite(skill);
    changed();
    return skill;
  });
}
export function deleteSkill(id: string): Promise<void> {
  return run(async () => {
    const path = skillPath(id);
    const skill = (await readSkills()).find((item) => item.id === id);
    if (!skill) throw new Error("This skill no longer exists.");
    if (skill.global) throw new Error("Choose another global skill before deleting this one.");
    await shell.trashItem(path);
    changed();
  });
}
export function revealSkills(): Promise<void> {
  return run(async () => {
    const error = await shell.openPath(folder());
    if (error) throw new Error(error);
  });
}

// finishCut's look resolver. Listing/saving skills never spends credits. Only an
// explicit look request reaches this function; matching skills persist the result.
// The artistic numbers are shared across clip profiles, which render locally.
const pendingLooks = new Map<string, Promise<Grade>>();
export async function gradeFromSkillLook(look: string | null | undefined, input: GradeInput, options: LookOptions = {}): Promise<Grade> {
  const text = look?.trim();
  if (!text) return neutralGrade(input);
  const matches = (await listSkills()).filter((skill) => skill.look === text);
  const cached = matches.find((skill) => skill.lookGrade)?.lookGrade;
  if (cached) return { ...cached, input };
  let pending = pendingLooks.get(text);
  if (!pending) {
    pending = (async () => {
      const grade = await gradeFromLook(text, input, options);
      await run(async () => {
        // Re-read after judgement so editing a skill during the call wins.
        for (const skill of await readSkills()) {
          if (skill.look === text) await atomicWrite({ ...skill, lookGrade: { ...grade, look: text } }, skill.path);
        }
        changed();
      });
      return grade;
    })();
    pendingLooks.set(text, pending);
  }
  try { return { ...await pending, input }; }
  finally { if (pendingLooks.get(text) === pending) pendingLooks.delete(text); }
}
