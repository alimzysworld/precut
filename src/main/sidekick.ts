import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow } from "electron";
import type { Cut, CutVersion, PrecutResult, Shoot, SidekickContext, SidekickMessage, Template } from "../shared/schema";
import { runModel, SIDEKICK_READ_ONLY_TOOLS } from "./ai";
import { getEngine } from "./settings";
import { effectiveShoot, stepsChanged } from "./steps";
import { listSkills, skillTemplate } from "./skills";
import { assembleReel, reelCatalog, reelIds, resolveReelPieces, type ReelAssembly, type ReelResult } from "./reel";
import { exportCutList, listTemplates, saveTemplate, renderCutPreview, type CutItem } from "./export";
import { buildSidekickContext } from "./sidekick-context";
import { parseSidekick, ReplyShapeError } from "./sidekick-validation";

// Persist exact source spans and the source/template snapshot with each version.
// Exporting an old version never consults changed picks, templates or music analysis.
interface StoredVersion extends CutVersion {
  assembly: { shoot: Shoot; template: Template; cutList: CutItem[]; reel: ReelAssembly };
}
interface StoredCut extends Omit<Cut, "versions"> { versions: StoredVersion[] }
const folder = (root: string) => path.join(root, ".sidething", "sidekick");
const queues = new Map<string, Promise<unknown>>();
function serial<T>(root: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(root);
  const next = (queues.get(key) ?? Promise.resolve()).then(work);
  const settled = next.catch(() => {});
  queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return next;
}
async function atomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => {}); }
}
function changed(root: string): void {
  stepsChanged(root);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      try { win.webContents.send("api:sidekick-changed", root); } catch { /* window closed */ }
    }
  }
}
function cutFile(root: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("That cut id is invalid.");
  return path.join(folder(root), "cuts", `${id}.json`);
}
async function readCut(root: string, id: string): Promise<StoredCut> {
  try { return JSON.parse(await fs.readFile(cutFile(root, id), "utf8")); }
  catch { throw new Error("Could not read this cut. Check the drive is connected and try again."); }
}
function publicCut(cut: StoredCut): Cut {
  return { ...cut, versions: cut.versions.map(({ assembly, ...version }) => ({
    ...version,
    ...(assembly ? {
      pieces: version.pieces ?? resolveReelPieces(assembly.shoot, assembly.template, assembly.cutList, assembly.reel),
      music: version.music && assembly.reel.music ? { ...version.music, gainDb: assembly.reel.music.gainDb } : version.music,
    } : {}),
  })) };
}

// Retain the old envelope validator, then read the quiet composer's fields.
// B-roll-led pieces use the same catalog as assembly, without changing its ids.
type ParsedReply = Omit<ReturnType<typeof parseSidekick>, "reply"> & {
  reply: Omit<ReturnType<typeof parseSidekick>["reply"], "cut"> & {
    cut: (NonNullable<ReturnType<typeof parseSidekick>["reply"]["cut"]> & { targetS?: number; skills?: string[] }) | null;
  };
};
function parseReply(raw: string, shoot: Shoot): ParsedReply {
  let value: { cut?: { voice?: unknown; targetS?: unknown; skills?: unknown }; ideas?: { pick?: unknown }[] } | null;
  try { value = JSON.parse(raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw.trim()); }
  catch { return parseSidekick(raw, shoot); }
  const ids = value?.cut?.voice;
  const { broll } = reelIds(shoot);
  let parsed: ParsedReply;
  if (Array.isArray(ids) && ids.every((id): id is string => typeof id === "string") && ids.some((id) => broll.has(id))) {
    parsed = parseSidekick(JSON.stringify({ ...value, cut: { ...value!.cut, voice: ids.filter((id) => !broll.has(id)) } }), shoot);
    if (parsed.reply.cut) {
      const validTakes = new Set(parsed.reply.cut.voice.map((v) => v.id));
      parsed.reply.cut.voice = ids.filter((id) => broll.has(id) || validTakes.has(id)).map((id) => ({ id }));
    }
  } else parsed = parseSidekick(raw, shoot);
  if (parsed.reply.cut && value?.cut) {
    const { targetS, skills } = value.cut;
    if (targetS !== undefined) {
      if (typeof targetS !== "number" || !Number.isFinite(targetS) || targetS <= 0) throw new ReplyShapeError("cut.targetS must be positive seconds.");
      parsed.reply.cut.targetS = targetS;
    }
    if (skills !== undefined) {
      if (!Array.isArray(skills) || !skills.every((id): id is string => typeof id === "string")) throw new ReplyShapeError("cut.skills must be skill ids.");
      parsed.reply.cut.skills = skills;
    }
  }
  parsed.reply.ideas?.forEach((idea, index) => {
    const pick = value?.ideas?.[index]?.pick;
    if (pick !== undefined && typeof pick !== "boolean") throw new ReplyShapeError("ideas.pick must be a boolean.");
    if (typeof pick === "boolean") idea.pick = pick;
  });
  return parsed;
}
export async function sidekickThread(root: string): Promise<SidekickMessage[]> {
  try {
    const thread: unknown = JSON.parse(await fs.readFile(path.join(folder(root), "thread.json"), "utf8"));
    if (!Array.isArray(thread)) throw new Error("Invalid thread");
    return thread as SidekickMessage[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Could not read the sidekick conversation. Your saved thread has been kept.");
  }
}
async function saveThread(root: string, thread: SidekickMessage[]): Promise<void> {
  await atomic(path.join(folder(root), "thread.json"), thread);
  changed(root);
}
async function promptTemplate(): Promise<string> {
  const candidates = [path.join(process.cwd(), "prompts/sidekick.md"), path.join(app.getAppPath(), "prompts/sidekick.md"),
    path.join(process.resourcesPath ?? "", "prompts/sidekick.md")];
  for (const file of candidates) { try { return await fs.readFile(file, "utf8"); } catch { /* next */ } }
  throw new Error("Could not find the sidekick prompt. Reinstall precut.");
}
function plainError(error: unknown): string {
  if (error instanceof ReplyShapeError) return "The sidekick could not format its answer after two tries. Please try again.";
  const message = error instanceof Error ? error.message : "";
  if (/Claude Code|Muse|timed out|unavailable|Could not|could not|too large|Template|known footage|positive|empty/i.test(message) && message.length < 400) return message;
  return "The sidekick could not finish this request. Check the shoot drive and your AI engine, then try again.";
}
export function sidekickSend(root: string, text: string, ctx: SidekickContext = {}): Promise<SidekickMessage> {
  root = path.resolve(root);
  return serial(root, async () => {
    const thread = await sidekickThread(root);
    const user: SidekickMessage = { id: randomUUID(), role: "user", text: text.trim(), at: new Date().toISOString() };
    await saveThread(root, [...thread, user]);
    const message: SidekickMessage = { id: randomUUID(), role: "sidekick", text: "", at: new Date().toISOString() };
    try {
      if (!user.text) throw new Error("Your message is empty. Ask about the shoot or describe a cut first.");
      let shoot: Shoot;
      try { shoot = effectiveShoot(JSON.parse(await fs.readFile(path.join(root, ".sidething/index.json"), "utf8"))); }
      catch { throw new Error("Could not read this shoot. Check the drive is connected and try again."); }
      const editing = ctx.cutId ? await readCut(root, ctx.cutId) : null;
      const previousRef = [...thread].reverse().find((m) => m.cut)?.cut;
      const reference = editing ?? (previousRef ? await readCut(root, previousRef.cutId) : null);
      const last = editing?.versions.at(-1);
      const sourceIdea = ctx.fromIdea ? thread.find((m) => m.id === ctx.fromIdea!.messageId)?.ideas?.[ctx.fromIdea.index] : undefined;
      if (ctx.fromIdea && (!Number.isInteger(ctx.fromIdea.index) || !sourceIdea)) throw new Error("Could not find that idea. Open the latest ideas and try again.");
      const skills = (await listSkills()).sort((a, b) => Number(b.global) - Number(a.global));
      const knownSkills = new Set(skills.map((s) => s.id));
      let skillIds = (editing?.skillIds ?? ctx.skillIds ?? []).filter((id) => knownSkills.has(id));
      let lengthS = ctx.lengthS ?? editing?.targetLengthS ?? sourceIdea?.lengthS ?? 30;
      if (!Number.isFinite(lengthS) || lengthS <= 0) throw new Error("Choose a positive target length in seconds.");
      const templateId = ctx.templateId ?? last?.templateId ?? "reel-9-16";
      const fallback = editing?.versions.at(-1)?.assembly.template ?? (await listTemplates()).find((t) => t.id === templateId || t.name === templateId);
      if (!fallback) throw new Error(`Template not found: ${templateId}`);
      const catalog = await reelCatalog();
      const candidates = typeof ctx.musicFile === "string" ? catalog.tracks.filter((t) => t.file === ctx.musicFile) : catalog.tracks.slice(0, 12);
      if (typeof ctx.musicFile === "string" && !candidates.length) throw new Error("That track is unavailable in your music folder. Choose another track.");
      const prompt = buildSidekickContext(await promptTemplate(), shoot,
        skills.map((s) => ({ id: s.id, name: s.name, description: s.description, global: s.global, format: s.format ?? null, markdown: s.body })),
        candidates, reference ? publicCut(reference) : null, thread,
        { text: user.text, targetLengthS: ctx.lengthS ?? editing?.targetLengthS ?? sourceIdea?.lengthS ?? null,
          template: skillTemplate(skills, skillIds, shoot, fallback), skillIds, fromIdea: sourceIdea ?? null,
          musicMode: typeof ctx.musicFile === "string" ? "fixed track" : ctx.musicFile === null ? "pick for me" : "decide from the words and skills; keep current music when revising unless asked otherwise",
          revisingCutId: ctx.cutId ?? null }, 55_000);
      const engine = await getEngine();
      // Explicit cut workflows (including the legacy reel form) stay Read only.
      // Ideas chat can read references without guessing intent from phrases.
      const extraReadOnlyTools = ctx.cutId || ctx.fromIdea || ctx.templateId ? undefined : SIDEKICK_READ_ONLY_TOOLS;
      let raw = await runModel({ engine, prompt, images: [], cwd: root, extraReadOnlyTools });
      let parsed: ParsedReply;
      try { parsed = parseReply(raw, shoot); }
      catch (error) {
        if (!(error instanceof ReplyShapeError)) throw error;
        raw = await runModel({ engine, images: [], cwd: root, extraReadOnlyTools,
          prompt: `${prompt}\nYour previous answer failed JSON shape validation: ${error.message}\nReturn a corrected JSON object only. Previous answer (may be truncated):\n${raw.slice(0, 3500)}` });
        parsed = parseReply(raw, shoot);
      }
      const { reply, warnings } = parsed;
      message.text = reply.text;
      message.clips = reply.clips;
      message.missing = reply.missing;
      if (reply.ideas) message.ideas = reply.ideas;
      if (warnings.length) message.text += ` ${warnings.join(" ")}`;
      if (reply.cut) {
        lengthS = reply.cut.targetS ?? lengthS;
        if (reply.cut.skills !== undefined) {
          skillIds = [...new Set(reply.cut.skills.filter((id) => knownSkills.has(id)))];
          for (const id of reply.cut.skills) if (!knownSkills.has(id)) warnings.push(`Dropped unknown skill ${id}.`);
        }
        const template = skillTemplate(skills, skillIds, shoot, fallback);
        if (template.id !== fallback.id) await saveTemplate(template);
        const assembled = await assembleReel(root, shoot, template, reply.cut, { lengthS, musicFile: ctx.musicFile }, candidates, catalog.warnings);
        assembled.reel.warnings.push(...warnings);
        assembled.reel.missing = reply.missing;
        const cut: StoredCut = editing ?? { cutId: randomUUID(), concept: reply.cut.concept, skillIds, targetLengthS: lengthS, versions: [], exported: [] };
        const version = (cut.versions.at(-1)?.version ?? 0) + 1;
        const preview = await renderCutPreview(root, assembled.cutList, template, `${cut.cutId}-v${version}`, assembled.reel);
        if (!preview) assembled.reel.warnings.push("The preview could not be rendered here. You can still export this version to Resolve.");
        const record: StoredVersion = {
          version, createdAt: new Date().toISOString(), title: reply.cut.title,
          voice: assembled.reel.cuts.map((c) => c.id),
          broll: assembled.reel.broll.map(({ id, over }) => ({ id, over })),
          music: assembled.reel.music ? { file: assembled.reel.music.file, startS: assembled.reel.music.startS, gainDb: assembled.reel.music.gainDb } : null,
          pieces: resolveReelPieces(shoot, template, assembled.cutList, assembled.reel),
          templateId: template.id, lengthS: assembled.lengthS, preview, why: reply.cut.why,
          warnings: assembled.reel.warnings, missing: reply.missing, feedback: editing ? user.text : null,
          assembly: { shoot, template, cutList: assembled.cutList, reel: assembled.reel },
        };
        cut.versions.push(record);
        cut.targetLengthS = lengthS;
        cut.skillIds = skillIds;
        await atomic(cutFile(root, cut.cutId), cut);
        message.cut = { cutId: cut.cutId, version };
        if (sourceIdea) sourceIdea.cutId = cut.cutId;
      }
    } catch (error) {
      message.error = plainError(error);
      message.text = message.text ? `${message.text} ${message.error}` : message.error;
    }
    await atomic(path.join(folder(root), "last-call.json"), { messageId: message.id,
      step: ctx.cutId || ctx.fromIdea || message.cut || /\b(?:cut|reel|re-cut)\b/i.test(user.text) && !/\b(?:ideas|suggest|could|what)\b/i.test(user.text) ? "precut" : "ideas" });
    message.at = new Date().toISOString();
    await saveThread(root, [...thread, user, message]);
    return message;
  });
}
export function passIdea(root: string, messageId: string, index: number, passed: boolean): Promise<void> {
  root = path.resolve(root);
  return serial(root, async () => {
    const thread = await sidekickThread(root);
    const idea = thread.find((m) => m.id === messageId)?.ideas?.[index];
    if (!Number.isInteger(index) || !idea || typeof passed !== "boolean") throw new Error("Could not find that idea. Open the latest ideas and try again.");
    idea.passed = passed;
    await saveThread(root, thread);
  });
}
export async function listCuts(root: string): Promise<Cut[]> {
  let entries: string[];
  try { entries = await fs.readdir(path.join(folder(root), "cuts")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const cuts = await Promise.all(entries.filter((f) => f.endsWith(".json")).map(async (f) => publicCut(await readCut(root, f.slice(0, -5)))));
  void healPreviews(root, cuts);
  return cuts.sort((a, b) => (b.versions.at(-1)?.createdAt ?? "").localeCompare(a.versions.at(-1)?.createdAt ?? "") || b.cutId.localeCompare(a.cutId));
}
// A version whose preview failed to render (encoder busy, drive asleep) gets one
// background retry per session from its saved assembly; the screen refreshes when it lands.
const healing = new Set<string>();
async function healPreviews(root: string, cuts: Cut[]): Promise<void> {
  for (const cut of cuts) for (const v of cut.versions) {
    const key = `${path.resolve(root)}|${cut.cutId}|${v.version}`;
    if (v.preview || healing.has(key)) continue;
    healing.add(key);
    try {
      await serial(root, async () => {
        const stored = await readCut(root, cut.cutId);
        const record = stored.versions.find((x) => x.version === v.version);
        if (!record?.assembly || record.preview) return;
        const { cutList, template, reel } = record.assembly;
        const preview = await renderCutPreview(root, cutList, template, `${cut.cutId}-v${v.version}`, reel);
        if (!preview) return;
        record.preview = preview;
        record.warnings = record.warnings.filter((w) => !w.startsWith("The preview could not be rendered"));
        await atomic(cutFile(root, cut.cutId), stored);
        changed(root);
      });
    } catch { /* keep the version exportable; the next session retries */ }
  }
}

export function exportSidekickCut(root: string, cutId: string, version: number, outputFolder?: string): Promise<ReelResult> {
  root = path.resolve(root);
  return serial(root, async () => {
    const cut = await readCut(root, cutId);
    const record = cut.versions.find((v) => v.version === version);
    if (!record) throw new Error("That cut version does not exist.");
    const { shoot, template, cutList, reel } = record.assembly;
    const result = await exportCutList(root, shoot, "reel", template, cutList,
      { reel, outputFolder: outputFolder ?? path.join(root, "sidething precuts"),
        folderName: `${record.title} v${record.version}`, existingPreview: record.preview });
    cut.exported.push({ version, folder: result.folder, at: new Date().toISOString() });
    await atomic(cutFile(root, cutId), cut);
    changed(root);
    return { ...result, reel };
  });
}
export async function exportCut(root: string, cutId: string, version: number): Promise<PrecutResult> {
  const { folder, preview, lengthS } = await exportSidekickCut(root, cutId, version);
  return { folder, preview, lengthS };
}
