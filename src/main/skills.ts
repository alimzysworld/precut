// Skills are ordinary Markdown files. Keep ids stable when their names change.
import { app, BrowserWindow, shell } from "electron";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Skill, SkillFormat, Shoot, Template } from "../shared/schema";

export const SEED_SKILLS: Omit<Skill, "path">[] = [
  {
    id: "my-taste", name: "My taste", description: "My defaults for every reel.", global: true,
    format: { aspect: "9:16", width: 1080, height: 1920, fps: null },
    body: `sidething wrote this as a starting point. Make it yours.

# My taste

Get to the hook in the first second. No intro before the point.

Cut breaths, false starts and the pause before a line. Keep enough space that I still sound like me.

One idea per reel. If a line does not help that idea, leave it out.

End on the line that lands. No recap or extra sign off.

No zooms. No transitions. A clean cut is enough.

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

Stay on me while the point lands. No zooms or transitions to make it feel busy.

End on the line that lands. Do not add another sentence just to fill the length.

When captions arrive, keep them large and centred. Show a short phrase at a time.

If there is music, keep it under my voice and never over it. The words do the work.
`,
  },
];

const folder = () => join(app.getPath("userData"), "skills");
function skillPath(id: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("Skill ids must be lowercase slugs.");
  return join(folder(), `${id}.md`);
}
const sortSkills = (skills: Skill[]) => skills.sort((a, b) => Number(b.global) - Number(a.global) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

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

function parse(id: string, path: string, contents: string): Skill {
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
      if (field[1] === "format" && !raw.trim()) {
        fields.format = "true";
        while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1])) {
          const line = lines[++i];
          if (!line.trim() || line.trimStart().startsWith("#")) continue;
          const nested = line.match(/^\s+(aspect|width|height|fps):\s*(.*)$/);
          if (!nested || Object.hasOwn(fields, `format.${nested[1]}`)) throw new Error("Invalid format");
          fields[`format.${nested[1]}`] = scalar(nested[2]);
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
    return {
      ...fallback, name: fields.name?.trim() || id,
      description: fields.description?.replace(/\s+/g, " ").trim() || id,
      global: fields.global?.toLowerCase() === "true", body,
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
export function skillTemplate(skills: Skill[], ids: string[], shoot: Shoot, fallback: Template): Template {
  const type = ids.map((id) => skills.find((s) => s.id === id && !s.global)).find(Boolean);
  const format = type?.format ?? skills.find((s) => s.global)?.format;
  if (!format) return fallback;
  const fps = format.fps ?? shoot.clips.find((c) => c.meta && c.meta.fps > 0)?.meta?.fps ?? fallback.fps;
  return { id: `skill-${format.aspect.replace(":", "-")}-${format.width}x${format.height}-${fps}`,
    name: `${format.aspect} ${format.width}x${format.height} ${fps} fps`,
    width: format.width, height: format.height, fps, drpPath: null, notes: "Format from skills" };
}

function serialize(skill: Omit<Skill, "path">): string {
  const f = skill.format ? validateFormat(skill.format) : null;
  const format = f ? `format:\n  aspect: "${f.aspect}"\n  width: ${f.width}\n  height: ${f.height}\n  fps: ${f.fps ?? "match"}\n` : "";
  return `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\nglobal: ${skill.global}\n${format}---\n${skill.body}`;
}

async function atomicWrite(skill: Omit<Skill, "path">, target = skillPath(skill.id)): Promise<void> {
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
async function readSkills(): Promise<Skill[]> {
  const entries = await fs.readdir(folder(), { withFileTypes: true });
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(folder(), entry.name);
    try { skills.push(parse(entry.name.slice(0, -3), path, await fs.readFile(path, "utf8"))); }
    catch (error) {
      // An external editor may remove a file between readdir and readFile.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  sortSkills(skills);
  // Hand edits can leave zero or several flags. Resolve to one deterministically
  // without rewriting anyone's file just because the list was opened.
  const global = skills.find((skill) => skill.global) ?? skills.find((skill) => skill.id === "my-taste") ?? skills[0];
  return sortSkills(skills.map((skill) => ({ ...skill, global: skill.id === global?.id })));
}

// Serialize operations so two windows cannot race seed creation or promotion.
let queue: Promise<unknown> = Promise.resolve();
function run<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(async () => { await ensureFolder(); return operation(); });
  queue = result.catch(() => {});
  return result;
}
export function listSkills(): Promise<Skill[]> { return run(readSkills); }
export function saveSkill(input: Omit<Skill, "path">): Promise<Skill> {
  return run(async () => {
    if (input.format) validateFormat(input.format);
    const path = skillPath(input.id);
    const skills = await readSkills();
    const previous = skills.find((skill) => skill.id === input.id);
    const skill: Skill = {
      ...input, path, name: input.name.trim() || input.id,
      description: input.description.replace(/\s+/g, " ").trim() || input.id,
      global: Boolean(input.global) || Boolean(previous?.global) || skills.length === 0,
    };
    if (skill.global) {
      // Read the raw flags too: a hand-edited second global may have been hidden
      // by the deterministic list resolution above.
      for (const other of skills) {
        if (other.id === skill.id) continue;
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
