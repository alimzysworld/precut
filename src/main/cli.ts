import { withShootWriter } from "./writer-lock";
import { mergeLeftOut } from "./left-out-state";
import { resolveStoryboard } from "../shared/storyboard";
import { existsSync } from "node:fs";
import { getPreferences } from "./settings";
// Terminal and MCP adapters. Editorial choices stay in the same main modules
// as the window app; only argument validation and presentation live here.
import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { format } from "node:util";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { addShoot, listShoots, loadShoot, relinkShoot, retryStage, setProgressForwarder, type ProgressEvent } from "./jobs";
import { shootSteps, trackProgress } from "./steps";
import { sidekickThread, sidekickSend, listCuts, listCutsLight, editCut, getShootFocus, setShootFocus } from "./sidekick";
import { newestListed, versionOr } from "./revisions";
import { shootProgress } from "./progress";
import { finishCut } from "./finish";
import { normalizeDetail } from "../renderer/src/components/finish/detailMath";
import { isLookPreset, LOOKS } from "./grade";
import { listTemplates, makePrecut, exportTo } from "./export";
import type { Cut, EditorId, OptionalCheckId, ProcessingStageId, ReelIdea, Shoot, ShootSummary, SidekickMessage, SkillFormat, VideoType } from "../shared/schema";

export type Progress = (line: string) => void;
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const editors: readonly EditorId[] = ["resolve", "premiere", "finalcut", "capcut"];
const stages: readonly (ProcessingStageId | OptionalCheckId)[] = ["index", "transcribe", "group", "judge", "ideas", "drafts", "framing", "quality", "fillers"];
const aspects: readonly SkillFormat["aspect"][] = ["9:16", "16:9", "1:1", "4:5"];
const videoTypes: readonly VideoType[] = ["talking", "voiceover", "montage", "tutorial", "vlog"];

// These schemas use the same argument names as runOperation and the CLI.
const shootArgument = { type: "string", minLength: 1, description: "Shoot folder path or a unique part of a registered shoot name." };
const cutArgument = { type: "string", minLength: 1, description: "Exact cutId returned by make_cut or list_cuts." };
const versionArgument = { type: "integer", minimum: 1, description: "Saved version number; omit for latest." };
function operationTool(name: string, description: string, properties: Record<string, object>, required: string[], readOnly = false): Tool {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: !readOnly } };
}
export const CLI_MCP_TOOLS: Tool[] = [
  // ONB1b: the same music folder choice as first run, Settings and the Sound panel.
  operationTool("list_music", "Read the music folder new edits pick tracks from and its tracks (name, length, bpm). No model call.", {}, [], true),
  operationTool("set_music_folder", "Choose the folder new edits pick music from (an existing folder of audio the person may post). Files are only referenced, never copied or changed. No model call.", { folder: { type: "string", description: "Absolute path of an existing folder." } }, ["folder"]),
  operationTool("shoot_status", "Read the app's ShootSummary for one registered shoot, including offline shoots, or every shoot when omitted. No model call.", { shoot: shootArgument }, [], true),
  operationTool("shoot_progress", "Read the shoot's six processing stages, measured stage progress and grounded findings. No model call.", { shoot: shootArgument }, ["shoot"], true),
  operationTool("get_focus", "Read the saved shoot direction without generating ideas or calling a model.", { shoot: shootArgument }, ["shoot"], true),
  operationTool("set_focus", "Save the legacy shoot direction and queue non-empty text as an additional request for ideas and a feasible edit. Empty text clears the direction without adding work.", { shoot: shootArgument, focus: { type: "string", description: "What to make, up to 10,000 characters. Empty text clears the saved direction." } }, ["shoot", "focus"]),
  operationTool("relink_shoot", "Relink a registered shoot, including an offline old path, to its moved folder. Uses the app's footage identity checks and preserves analysis and cut versions.", { shoot: shootArgument, folder: { ...shootArgument, description: "Existing new folder path containing the same footage." } }, ["shoot", "folder"]),
  operationTool("retry_stage", "Retry one processing stage through the app's guards, preserving finished stages. Waits for completion. Ideas, drafts and judging may call the configured AI engine.", { shoot: shootArgument, stage: { type: "string", enum: [...stages], description: "Processing stage to retry, or an optional check (framing, quality, fillers) that failed." } }, ["shoot", "stage"]),
  operationTool("set_format", "Reframe a saved cut through finishCut, creating a new version and preserving timing, originals and earlier versions. No model call.", { shoot: shootArgument, cut: cutArgument, aspect: { type: "string", enum: [...aspects], description: "Output aspect ratio." }, version: versionArgument }, ["shoot", "cut", "aspect"]),
  operationTool("set_look", "Set a gallery look, Fade or Diffusion in one undoable version. Optional piece applies only to that clip. No model call.", { shoot: shootArgument, cut: cutArgument, preset: { type: "string", enum: LOOKS.map(look => look.id) }, intensity: { type: "number", minimum: 0, maximum: 1 }, fade: { type: "number", minimum: 0, maximum: 100 }, diffusion: { type: "number", minimum: 0, maximum: 100 }, piece: { type: "integer", minimum: 0 }, version: versionArgument }, ["shoot", "cut"]),
];

function shootPath(value: string): string {
  return path.resolve(value === "~" ? app.getPath("home") : value.startsWith("~/") ? path.join(app.getPath("home"), value.slice(2)) : value);
}

// Library reads and relinking must also work when the old drive is offline.
async function registeredShoot(value: string): Promise<ShootSummary> {
  const shoots = await listShoots();
  const candidate = shootPath(value);
  const stored = shoots.find(shoot => path.resolve(shoot.root) === candidate);
  if (stored) return stored;
  const canonical = await fs.realpath(candidate).catch((error: NodeJS.ErrnoException) => {
    if (["ENOENT", "ENOTDIR"].includes(error.code ?? "")) return candidate;
    throw error;
  });
  const exact = shoots.find(shoot => path.resolve(shoot.root) === candidate || path.resolve(shoot.root) === canonical);
  if (exact) return exact;
  const matches = value.includes(path.sep) || path.isAbsolute(value) ? []
    : shoots.filter(shoot => shoot.name.toLocaleLowerCase().includes(value.toLocaleLowerCase()));
  if (matches.length !== 1) throw new Error(matches.length
    ? `Shoot name is ambiguous. Use a folder path:\n${matches.map(shoot => shoot.root).join("\n")}` : `Shoot not found in your library: ${value}`);
  return matches[0];
}

export async function resolveShoot(value: string): Promise<string> {
  if (!value.trim()) throw new Error("Give a shoot folder or a unique part of its name.");
  const candidate = shootPath(value);
  try {
    if (!(await fs.stat(candidate)).isDirectory()) throw new Error(`Not a shoot folder: ${candidate}`);
    return await fs.realpath(candidate);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  if (value.includes(path.sep) || path.isAbsolute(value)) throw new Error(`Shoot folder not found: ${value}`);
  const matches = (await listShoots()).filter((shoot) => shoot.name.toLocaleLowerCase().includes(value.toLocaleLowerCase()));
  if (matches.length !== 1) throw new Error(matches.length ? `Shoot name is ambiguous. Use a folder path:\n${matches.map((s) => s.root).join("\n")}` : `Shoot not found: ${value}`);
  if (!matches[0].online) throw new Error(`Shoot is offline: ${matches[0].root}`);
  return fs.realpath(matches[0].root);
}

function positive(value: unknown, name: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a positive ${integer ? "integer" : "number"}.`);
  }
  return value;
}
function textArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Give ${name}.`);
  return value;
}

// jobs.addShoot deliberately returns immediately to the UI. Its detached queue
// has no completion API. Drain promises started in this async context, including
// the existing processQueue promise, rather than copying the processing pipeline
// or guessing completion from a partially written index. Polling is outside the
// context so the drain never counts its own promises. Cached judging works too.
const processingContext = new AsyncLocalStorage<{ pending: Set<number>; failures: string[] }>();
let adding: Promise<unknown> = Promise.resolve();
async function processShoot(root: string, progress: Progress): Promise<unknown> {
  const work = adding.catch(() => {}).then(async () => {
    const state = { pending: new Set<number>(), failures: [] as string[] };
    const shoot = await loadShoot(root);
    const hook = createHook({
      init(id, type) { if (type === "PROMISE" && processingContext.getStore() === state) state.pending.add(id); },
      promiseResolve(id) { state.pending.delete(id); },
    });
    const previousError = console.error;
    console.error = (...args: unknown[]) => {
      // HL1: keep the reason in plain words; the stack stays in the log on stderr.
      if (processingContext.getStore() === state && /^\[jobs\] (processing|judging) failed/.test(String(args[0]))) state.failures.push(args.slice(1).map(a => a instanceof Error ? a.message : format(a)).join(" ").trim() || "Processing stopped.");
      previousError(...args);
    };
    hook.enable();
    const completed = new Map<string, Set<string>>();
    const labels: Partial<Record<ProgressEvent["stage"], string>> = {
      probe: "reading metadata", audio: "preparing sound", transcript: "transcribing", shake: "checking shake", frames: "reading frames", proxy: "making proxies", judge: "judging",
    };
    let last = "";
    setProgressForwarder((event) => {
      trackProgress(event);
      if (event.root !== root) return;
      const seen = completed.get(event.stage) ?? new Set<string>();
      if (event.clipId) seen.add(event.clipId);
      completed.set(event.stage, seen);
      const line = event.note ?? (labels[event.stage] ? `${labels[event.stage]} ${seen.size} of ${shoot?.clips.length ?? "?"}` : event.stage === "error" ? `error: ${event.clipId}` : "");
      if (line && line !== last) { last = line; progress(line); }
    });
    try {
      await processingContext.run(state, () => addShoot(root));
      while (state.pending.size) await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const result = await loadShoot(root);
      if (state.failures.length && (!result || !result.clips.length)) throw new Error(`Processing stopped: ${state.failures.join(" ")}`);
      if (!result || !result.clips.length) throw new Error("No video clips found in this folder.");
      const failed = result.clips.filter((clip) => clip.stage === "error");
      if (failed.length) throw new Error(`${failed.length} clips failed: ${failed.map((clip) => `${clip.id}: ${clip.error ?? "processing failed"}`).join("; ")}`);
      if (state.failures.length) {
        // HL1: the footage is read and only a later step (judging, ideas, first edits) stopped. Say what, and keep the
        // read footage usable, instead of failing the whole add. Unread footage still fails above.
        const stages = (await shootProgress(root)).stages;
        if (!["index", "transcribe"].every(id => ["done", "skipped"].includes(stages.find(stage => stage.id === id)?.state ?? ""))) throw new Error(`Processing stopped: ${state.failures.join(" ")}`);
        return { root, name: result.name, clips: result.clips.length, steps: await shootSteps(root),
          unfinished: stages.filter(stage => stage.state === "failed").map(stage => ({ stage: stage.id, label: stage.label, detail: stage.detail })),
          note: "The footage is read. Retry an unfinished stage with retry_stage, or make an edit with make_cut." };
      }
      return { root, name: result.name, clips: result.clips.length, steps: await shootSteps(root) };
    } finally {
      hook.disable();
      console.error = previousError;
      setProgressForwarder(trackProgress);
    }
  });
  adding = work;
  return work;
}

function ideasIn(thread: SidekickMessage[]): { idea: ReelIdea; messageId: string; index: number }[] {
  return thread.flatMap((message) => (message.ideas ?? []).map((idea, index) => ({ idea, messageId: message.id, index })));
}
function checkedReply(message: SidekickMessage): SidekickMessage {
  if (message.error) throw new Error(message.error);
  return message;
}
/** ARCH2: list_cuts (and precut cuts) answer with a short summary per edit: its current version with the source pieces
 * and take ids, how many versions it has and when it last changed. History is list_versions; detail is read_edit.
 * The whole history here was 37.6 MB for his 569-version edit and closed the MCP client (TEST1 finding 6). */
async function cutsSummary(root: string) {
  return Promise.all((await listCutsLight(root)).map(async cut => {
    const newest = newestListed(cut), current = await versionOr(root, cut.cutId, undefined, newest).catch(() => newest);
    const shown = cut.versions.find(v => v.version === current && !v.light) ?? cut.versions.filter(v => !v.light).at(-1);  // at(-1): no current readable
    return { cutId: cut.cutId, title: cut.title ?? shown?.title ?? cut.concept, concept: cut.concept, ...(cut.starred ? { starred: true } : {}),
      versionCount: cut.versions.length, currentVersion: current ?? null, newestVersion: newest ?? null,
      updatedAt: cut.versions.at(-1)?.createdAt ?? null,  // at(-1): when anything was last saved to it
      exported: cut.exported,
      versions: shown ? [{ version: shown.version, createdAt: shown.createdAt, title: shown.title, feedback: shown.feedback, lengthS: shown.lengthS,
        ...(shown.videoType ? { videoType: shown.videoType } : {}), warnings: shown.warnings, pieces: shown.pieces ?? [] }] : [] };
  }));
}
async function findCut(root: string, id: string): Promise<Cut> {
  const cut = (await listCuts(root)).find((cut) => cut.cutId === id);
  if (!cut) throw new Error(`Edit not found: ${id}. Use list_cuts to find its id.`);
  return cut;
}
/** VO7-2: an omitted version is the current revision (what is on screen after any undo), not the newest snapshot. */
async function cutVersion(root: string, cut: Cut, value: unknown): Promise<number> {
  const version = value === undefined ? await versionOr(root, cut.cutId, undefined, newestListed(cut)) : positive(value, "version", true);
  if (!version || !cut.versions.some(v => v.version === version)) throw new Error("That edit version does not exist.");
  return version;
}

export async function runOperation(name: string, args: Record<string, unknown> = {}, progress: Progress = () => {}): Promise<unknown> {
  const value = name === "add_shoot" || name === "relink_shoot" ? args.folder : args.shoot;
  const readOnly = ["list_shoots", "list_music", "shoot_status", "shoot_progress", "get_focus", "list_ideas", "list_cuts"].includes(name);
  const run = () => runOperationOwned(name, args, progress);
  return typeof value === "string" && !readOnly ? withShootWriter(await resolveShoot(value), run) : run();
}
// FIX3: a shoot whose footage is read is not "failed" because a model step (takes, ideas, first edits) stopped.
// It keeps the status of what it has and names the steps that didn't finish. Unread footage stays "failed".
type PlainSummary = ShootSummary & { unfinished?: { stage: ProcessingStageId; label: string; detail: string | null }[] };
async function plainStatus(shoot: ShootSummary): Promise<PlainSummary> {
  if (shoot.status !== "failed" || !shoot.online) return shoot;
  const stages = (await shootProgress(shoot.root).catch(() => null))?.stages;
  if (!stages) return shoot;
  const failed = stages.filter(stage => stage.state === "failed");
  if (failed.some(stage => stage.id === "index" || stage.id === "transcribe")) return shoot;
  return { ...shoot, status: shoot.cutCount ? "edits" : shoot.ideaCount ? "ideas" : "new",
    unfinished: failed.map(stage => ({ stage: stage.id, label: stage.label, detail: stage.detail })) };
}
const unfinishedWords: Partial<Record<ProcessingStageId, string>> = { group: "checking takes", judge: "checking takes", ideas: "finding ideas", drafts: "making first edits" };

async function runOperationOwned(name: string, args: Record<string, unknown>, progress: Progress): Promise<unknown> {
  if (name === "list_shoots") return Promise.all((await listShoots()).map(async (shoot) => ({
    ...await plainStatus(shoot), steps: shoot.online ? await shootSteps(shoot.root) : null,
  })));
  if (name === "list_music") {
    const [{ listMusic }, { getMusicFolder }] = await Promise.all([import("./music"), import("./settings")]);
    return { folder: await getMusicFolder(), tracks: await listMusic() };
  }
  if (name === "set_music_folder") {
    const folder = path.resolve(textArg(args, "folder"));
    if (!(await fs.stat(folder).catch(() => null))?.isDirectory()) throw new Error(`Not a folder: ${folder}`);
    const { setMusicFolder } = await import("./settings");
    await setMusicFolder(folder);
    const { listMusic } = await import("./music");
    return { folder, tracks: await listMusic() };
  }
  if (name === "shoot_status") return args.shoot === undefined ? Promise.all((await listShoots()).map(plainStatus)) : plainStatus(await registeredShoot(textArg(args, "shoot")));
  if (name === "relink_shoot") {
    const shoot = await registeredShoot(textArg(args, "shoot"));
    const folder = textArg(args, "folder");
    const target = shootPath(folder);
    if (!(await fs.stat(target)).isDirectory()) throw new Error(`Not a shoot folder: ${target}`);
    return relinkShoot(shoot.root, await fs.realpath(target));
  }
  const root = await resolveShoot(textArg(args, name === "add_shoot" ? "folder" : "shoot"));
  switch (name) {
    case "add_shoot": progress(`processing ${root}`); return processShoot(root, progress);
    case "shoot_progress": return shootProgress(root);
    case "get_focus": return { root, focus: await getShootFocus(root) };
    case "set_focus": {
      if (typeof args.focus !== "string") throw new Error("focus must be text (use an empty string to clear it).");
      return { root, ...await setShootFocus(root, args.focus), focus: await getShootFocus(root) };
    }
    case "retry_stage": {
      if (!stages.includes(args.stage as ProcessingStageId)) throw new Error(`stage must be ${stages.join(", ")}.`);
      progress(`retrying ${args.stage}`);
      await retryStage(root, args.stage as ProcessingStageId | OptionalCheckId);
      return shootProgress(root);
    }
    case "set_format":
    case "set_look": {
      const options: NonNullable<Parameters<typeof finishCut>[3]> = {};
      if (name === "set_format") {
        if (!aspects.includes(args.aspect as SkillFormat["aspect"])) throw new Error(`aspect must be ${aspects.join(", ")}.`);
        options.aspect = args.aspect as SkillFormat["aspect"];
      } else {
        if (args.preset !== undefined && !isLookPreset(args.preset)) throw new Error(`preset must be ${LOOKS.map(look => look.id).join(", ")}.`);
        if (typeof args.preset === "string") options.preset = args.preset;
        for (const key of ["fade", "diffusion"] as const) if (args[key] !== undefined && (typeof args[key] !== "number" || !Number.isFinite(args[key]) || args[key] < 0 || args[key] > 100)) throw new Error(`${key} must be a number from 0 to 100.`);
        if (args.fade !== undefined) options.filmFade = args.fade as number;
        if (!["preset", "intensity", "fade", "diffusion"].some(key => args[key] !== undefined)) throw new Error("Choose a look, Fade or Diffusion.");
        if (args.intensity !== undefined) {
          if (typeof args.intensity !== "number" || !Number.isFinite(args.intensity) || args.intensity < 0 || args.intensity > 1) throw new Error("intensity must be a number from 0 to 1.");
          if (args.preset === undefined && args.piece === undefined) throw new Error("Choose a gallery preset when changing its intensity.");
          options.intensity = args.intensity;
        }
      }
      const cut = await findCut(root, textArg(args, "cut"));
      const version = await cutVersion(root, cut, args.version);
      if (name === "set_look") {
        const saved = cut.versions.find(v => v.version === version)!;
        if (args.piece !== undefined) {
          if (typeof args.piece !== "number" || !Number.isInteger(args.piece) || args.piece < 0 || args.piece >= (saved.pieces?.length ?? 0)) throw new Error("Choose a clip in this edit.");
          const fx = saved.pieceFx?.[args.piece];
          return editCut(root,cut.cutId,version,{kind:"pieceFx",piece:args.piece,fx:{...fx,look:{...fx?.look,
            ...(options.preset === undefined ? {} : {preset:options.preset}), ...(options.intensity === undefined ? {} : {intensity:options.intensity}),
            ...(options.filmFade === undefined ? {} : {filmFade:options.filmFade}), ...(args.diffusion === undefined ? {} : {diffusion:args.diffusion as number})}}});
        }
        if (args.diffusion !== undefined) options.detail = normalizeDetail({diffusion:args.diffusion as number},saved.grade?.detail);
      }
      progress(name === "set_format" ? "setting format" : "setting look");
      return finishCut(root, cut.cutId, version, options);
    }
    case "list_ideas": {
      // A cached reader must not schedule previews, migrations or a pending Rethink.
      const raw = await fs.readFile(path.join(root, ".sidething/index.json"), "utf8").catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      const shoot = raw ? await mergeLeftOut({ ...JSON.parse(raw), root } as Shoot) : null;
      if (shoot) shoot.clips = shoot.clips.map(clip => ({ ...clip,
        missing: !!clip.missing || !existsSync(path.join(root, clip.photo?.file ?? clip.file)),
      }));
      return ideasIn(await sidekickThread(root)).map(({ idea }) => ({ ...idea,
        storyboard: shoot ? resolveStoryboard(shoot, idea.uses, frame => existsSync(path.join(root, ".sidething", frame))) : [],
      }));
    }
    case "add_ideas": {
      if (args.prompt !== undefined && typeof args.prompt !== "string") throw new Error("prompt must be text.");
      if (args.ideaId !== undefined && (typeof args.ideaId !== "string" || !args.ideaId.trim())) throw new Error("ideaId must be text.");
      progress("finding ideas");
      const reply = checkedReply(await sidekickSend(root, typeof args.prompt === "string" && args.prompt.trim() ? args.prompt : "Find more reel ideas from this shoot.", args.ideaId ? { ideaId: args.ideaId as string } : { addIdeas: true }));
      return { ideas: ideasIn(await sidekickThread(root)).map(({ idea }) => idea), message: reply.text };
    }
    case "make_cut": {
      const concept = textArg(args, "concept");
      const lengthS = args.length === undefined ? undefined : positive(args.length, "length");
      if (args.type !== undefined && !videoTypes.includes(args.type as VideoType)) throw new Error(`type must be ${videoTypes.join(", ")}.`);
      const source = ideasIn(await sidekickThread(root)).find(({ idea }) => idea.id === concept);
      progress("making cut");
      const reply = checkedReply(await sidekickSend(root, source ? `Cut this idea: ${source.idea.concept}` : `Make a cut from this concept: ${concept}`, {
        ...(lengthS === undefined ? {} : { lengthS }),
        templateId: "reel-9-16",
        ...(source ? { fromIdea: { messageId: source.messageId, index: source.index } } : {}),
        ...(args.type === undefined ? {} : { videoType: args.type as VideoType }),
      }));
      if (!reply.cut) throw new Error(reply.text || "No cut was made. Give a more specific concept.");
      const cut = await findCut(root, reply.cut.cutId);
      const version = cut.versions.find((version) => version.version === reply.cut!.version);
      return { cutId: cut.cutId, version: reply.cut.version, title: version?.title, lengthS: version?.lengthS, type: version?.videoType ?? null, warnings: version?.warnings };
    }
    case "set_video_type": {
      const type = args.type as VideoType;
      if (!videoTypes.includes(type)) throw new Error(`type must be ${videoTypes.join(", ")}.`);
      const cut = await findCut(root, textArg(args, "cut"));
      progress(`re-cutting as ${type}`);
      const reply = checkedReply(await sidekickSend(root, `Re-cut this edit as a ${type === "talking" ? "talking video" : type}.`, { cutId: cut.cutId, videoType: type }));
      if (!reply.cut) throw new Error(reply.text || "No new version was made.");
      const saved = (await findCut(root, cut.cutId)).versions.find(v => v.version === reply.cut!.version);
      return { cutId: cut.cutId, version: reply.cut.version, title: saved?.title, lengthS: saved?.lengthS, type: saved?.videoType ?? null, warnings: saved?.warnings };
    }
    case "list_cuts": return cutsSummary(root);
    case "swap_take":
    case "remove_piece": {
      const cut = await findCut(root, textArg(args, "cut"));
      const version = cut.versions.length ? await versionOr(root, cut.cutId, undefined, newestListed(cut)) : undefined;
      if (!version) throw new Error("This edit has no versions.");
      if (typeof args.piece !== "number" || !Number.isInteger(args.piece) || args.piece < 0) throw new Error("piece must be a zero-based integer index.");
      progress(name === "swap_take" ? "swapping take" : "removing piece");
      return editCut(root, cut.cutId, version, name === "swap_take" ? { kind: "swap", piece: args.piece, take: textArg(args, "take") } : { kind: "remove", piece: args.piece });
    }
    case "export_cut": {
      const cut = await findCut(root, textArg(args, "cut"));
      const version = await cutVersion(root, cut, args.version);
      if (args.to !== undefined && ![...editors, "mp4"].includes(args.to as EditorId)) throw new Error(`to must be ${[...editors, "mp4"].join(", ")}.`);
      progress("exporting edit");
      const targets = args.to ? [args.to as import("../shared/schema").ExportTarget] : (await getPreferences()).output.targets ?? ["resolve"];
      return exportTo(root, cut.cutId, version, targets);

    }
    case "make_selects": {
      progress("making selects");
      const templates = await listTemplates();
      if (!templates.length) throw new Error("No export template available.");
      return makePrecut(root, "selects", templates[0].id);
    }
    default: throw new Error(`Unknown operation: ${name}`);
  }
}

export const CLI_HELP = `precut — a pre-editor for reels

precut shoots
precut add <folder>
precut status [<shoot>]
precut progress <shoot>
precut focus <shoot> ["direction" | ""]
precut relink <shoot> <folder>
precut retry <shoot> <stage>
precut format <shoot> <cut> <9:16|16:9|1:1|4:5> [--version n]
precut look <shoot> <cut> <preset> [--intensity 0..1] [--version n]
precut ideas <shoot> [--more] ["a line or a link"]
precut cut <shoot> <idea-id | "a concept"> [--length 20] [--type vlog]
precut cuts <shoot>
precut swap <shoot> <cut> <piece> <take>
precut remove <shoot> <cut> <piece>
precut clips <shoot>
precut export <shoot> <cut> [--version n] [--to mp4|resolve|premiere|finalcut|capcut]
precut selects <shoot>
precut tools
precut tool <name> ['{"shoot":"My shoot"}']
precut setup claude|codex
precut --mcp

Add --json to any command. A shoot is a folder path or a unique part of its name.
A failure prints one plain line; add --verbose to see the log behind it.
Piece indexes start at 0; cuts/list_cuts includes their source take ids.
status returns library summaries (including offline shoots); progress reads stages and findings.
focus reads unless direction is supplied; "" clears it without a model call.
Retry stages: ${stages.join(", ")}. Format and look preserve previous versions.
Look presets: ${LOOKS.map(look => look.id).join(", ")}.
export makes an MP4 unless --to names an editor; it prints the same Done line and file as the app's export sheet.
tools lists every tool precut's MCP server offers; tool runs one with its JSON arguments, exactly as Claude Code would.
While the precut app has a shoot open, changes to that shoot from here are refused until you close it; reads still work.
`;

function printResult(value: unknown, json: boolean): void {
  if (json) { process.stdout.write(`${JSON.stringify(value)}\n`); return; }
  if (Array.isArray(value)) {
    if (!value.length) { process.stdout.write("None yet.\n"); return; }
    for (const item of value) {
      // at(-1) stays: a listing line shows the edit's newest title; nothing is acted on.
      if (item.cutId) process.stdout.write(`${item.cutId}  ${item.versions?.at(-1)?.title ?? item.concept}\n`);
      else if (item.title) process.stdout.write(`${item.id}  ${item.title}\n`);
      else if (typeof item.description === "string") process.stdout.write(`${item.name}  ${item.description.split(/(?<=\.)\s/)[0]}\n`);  // HL1: precut tools
      else {
        const stopped = [...new Set(((item.unfinished ?? []) as { stage: ProcessingStageId }[]).map(u => unfinishedWords[u.stage]).filter(Boolean))];
        process.stdout.write(`${item.name}  ${item.status ?? (item.online ? Object.entries(item.steps ?? {}).map(([key, step]) => `${key}: ${(step as { status: string }).status}`).join(", ") : "offline")}${stopped.length ? `, ${stopped.join(" and ")} didn't finish` : ""}  ${item.root}\n`);
      }
    }
  } else {
    const result = value as Record<string, unknown>;
    if (result.status && result.root) printResult([result], false);
    else if (Array.isArray(result.stages)) {
      process.stdout.write(`${result.root}\n`);
      for (const stage of result.stages as { label: string; state: string; detail?: string }[]) process.stdout.write(`${stage.label}: ${stage.state}${stage.detail ? ` — ${stage.detail}` : ""}\n`);
      for (const finding of (result.findings ?? []) as { text: string }[]) process.stdout.write(`${finding.text}\n`);
    }
    else if (typeof result.focus === "string") process.stdout.write(`${result.focus || "No focus set."}${result.appliesTo ? ` (${result.appliesTo})` : ""}\n`);
    else if (Array.isArray(result.ideas)) printResult(result.ideas, false);
    else if (typeof result.line === "string" && typeof result.path === "string") process.stdout.write(`${result.line}\n${result.path}\n`);
    else if (Array.isArray(result.clips) && !result.cutId) for (const clip of result.clips as { id: string; durationS: number | null; kind: string; summary: string | null }[]) process.stdout.write(`${clip.id}  ${clip.durationS ?? "?"}s  ${clip.kind}  ${clip.summary ?? ""}\n`);
    else if (result.folder) process.stdout.write(`${result.folder}\n`);
    else if (result.cutId) process.stdout.write(`${result.cutId}  version ${result.version}${result.lengthS === undefined ? "" : `  ${result.lengthS}s`}${result.title ? `  ${result.title}` : ""}\n`);
    else if (result.steps) {
      process.stdout.write(`${result.root}\n`);
      for (const [name, value] of Object.entries(result.steps as object)) {
        const step = value as { status: string; note?: string };
        process.stdout.write(`${name}: ${step.status}${step.note ? ` — ${step.note}` : ""}\n`);
      }
    } else process.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

export async function runCli(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  // FIX3: the terminal shows results and one plain line per failure. The log (stack traces included) only with --verbose.
  const levels = ["log", "info", "warn", "error", "debug"] as const, saved = levels.map(level => console[level]);
  if (!argv.includes("--verbose")) for (const level of levels) console[level] = () => {};
  try {
    const words: string[] = [];
    const flags: Record<string, string | boolean> = {};
    let positionalOnly = false;
    for (let i = 0; i < argv.length; i++) {
      const word = argv[i];
      if (word === "--" && !positionalOnly) { positionalOnly = true; continue; }
      if (!positionalOnly && word.startsWith("--")) {
        const [flag, ...inline] = word.slice(2).split("=");
        if (["json", "more", "help", "verbose"].includes(flag)) {
          if (inline.length) throw new Error(`--${flag} does not take a value.`);
          flags[flag] = true;
        } else if (["length", "version", "to", "intensity", "type"].includes(flag)) {
          const value = inline.length ? inline.join("=") : argv[++i];
          if (!value || value.startsWith("--")) throw new Error(`Give a value for --${flag}.`);
          flags[flag] = value;
        } else throw new Error(`Unknown option: --${flag}`);
      } else words.push(word);
    }
    if (!words.length || flags.help || words[0] === "help") { printResult(json ? { help: CLI_HELP } : { folder: CLI_HELP.trimEnd() }, json); return 0; }
    const [command, ...positionals] = words;
    // ONB2: precut setup claude|codex, the terminal step of the first run (command, MCP connection, skill, check).
    if (command === "setup") {
      const agent = positionals[0];
      if (positionals.length !== 1 || (agent !== "claude" && agent !== "codex")) throw new Error("Usage: precut setup claude|codex");
      const ok = await (await import("./terminal-setup")).setUpFromCli(agent, line => process.stdout.write(`${line}\n`));
      return ok ? 0 : 1;
    }
    const spec: Record<string, { op: string; names: string[]; min?: number; flags?: string[] }> = {
      shoots: { op: "list_shoots", names: [] }, add: { op: "add_shoot", names: ["folder"] },
      status: { op: "shoot_status", names: ["shoot"], min: 0 },
      progress: { op: "shoot_progress", names: ["shoot"] }, focus: { op: "get_focus", names: ["shoot", "focus"], min: 1 },
      relink: { op: "relink_shoot", names: ["shoot", "folder"] }, retry: { op: "retry_stage", names: ["shoot", "stage"] },
      format: { op: "set_format", names: ["shoot", "cut", "aspect"], flags: ["version"] },
      look: { op: "set_look", names: ["shoot", "cut", "preset"], flags: ["version", "intensity"] },
      ideas: { op: "list_ideas", names: ["shoot", "prompt"], min: 1, flags: ["more"] },
      cut: { op: "make_cut", names: ["shoot", "concept"], flags: ["length", "type"] }, cuts: { op: "list_cuts", names: ["shoot"] }, clips: { op: "list_clips", names: ["shoot"] },
      swap: { op: "swap_take", names: ["shoot", "cut", "piece", "take"] }, remove: { op: "remove_piece", names: ["shoot", "cut", "piece"] },
      export: { op: "export_cut", names: ["shoot", "cut"], flags: ["version", "to"] }, selects: { op: "make_selects", names: ["shoot"] },
    };
    // HL1: the terminal reaches every MCP tool through the same dispatcher, writer lock and plain errors as Claude Code.
    if (command === "tools" || command === "tool") {
      const mcp = await import("./mcp");
      for (const flag of Object.keys(flags)) if (flag !== "json" && flag !== "verbose") throw new Error(`--${flag} is not valid for ${command}.`);
      if (command === "tools") {
        if (positionals.length) throw new Error("Usage: precut tools");
        printResult(mcp.MCP_TOOLS.map(t => ({ name: t.name, readOnly: !!t.annotations?.readOnlyHint, description: t.description })), json);
        return 0;
      }
      const [name, raw, ...extra] = positionals;
      if (!name || extra.length) throw new Error(`Usage: precut tool <name> '{"shoot":"My shoot"}'`);
      if (!mcp.MCP_TOOLS.some(t => t.name === name)) throw new Error(`Unknown tool: ${name}. Run precut tools to list them.`);
      let toolArgs: unknown = {};
      if (raw !== undefined) try { toolArgs = JSON.parse(raw); } catch { throw new Error("Give the tool's arguments as one JSON object, in single quotes."); }
      if (!toolArgs || typeof toolArgs !== "object" || Array.isArray(toolArgs)) throw new Error("Give the tool's arguments as one JSON object.");
      printResult(await mcp.dispatchMcpTool(name, toolArgs as Record<string, unknown>), json);
      return 0;
    }
    const entry = spec[command];
    if (!entry) throw new Error(`Unknown command: ${command}. Run precut --help.`);
    if (positionals.length < (entry.min ?? entry.names.length) || positionals.length > entry.names.length) throw new Error(`Usage: ${CLI_HELP.split("\n").find((line) => line.startsWith(`precut ${command}`))}`);
    for (const flag of Object.keys(flags)) if (flag !== "json" && flag !== "verbose" && !entry.flags?.includes(flag)) throw new Error(`--${flag} is not valid for ${command}.`);
    const args: Record<string, unknown> = Object.fromEntries(positionals.map((value, index) => [entry.names[index], entry.names[index] === "piece" ? Number(value) : value]));
    for (const flag of entry.flags ?? []) if (flags[flag] !== undefined && flag !== "more") args[flag] = flag === "to" || flag === "type" ? flags[flag] : Number(flags[flag]);
    const progress: Progress = (line) => (json ? process.stderr : process.stdout).write(`${line}\n`);
    let result: unknown;
    if (command === "ideas") {
      const existing = await runOperation("list_ideas", args) as ReelIdea[];
      result = flags.more || args.prompt !== undefined || !existing.length ? await runOperation("add_ideas", args, progress) : existing;
    } else if (command === "export" || command === "clips") {
      // FIX3: an editor the terminal can't make is refused at once, in words, before anything renders.
      if (command === "export" && args.to !== undefined && ![...editors, "mp4"].includes(args.to as EditorId)) throw new Error(`precut can't export to ${args.to}. Use mp4, resolve, premiere, finalcut or capcut.`);
      // HL1: the same reader and exporter as MCP: an MP4 by default, with the export sheet's Done line and file (EXP1).
      result = await (await import("./mcp")).dispatchMcpTool(entry.op, args);
    } else result = await runOperation(command === "focus" && args.focus !== undefined ? "set_focus" : entry.op, args, progress);
    printResult(result, json);
    return 0;
  } catch (error) {
    if (json) process.stdout.write(`${JSON.stringify({ error: errorText(error) })}\n`);
    else process.stderr.write(`precut: ${errorText(error)}\n`);
    return 1;
  } finally { levels.forEach((level, index) => { console[level] = saved[index]; }); }
}

export async function installCommandLine(): Promise<{ path: string; onPath: boolean }> {
  const shim = app.isPackaged ? path.join(process.resourcesPath, "precut") : path.join(app.getAppPath(), "build/precut");
  await fs.access(shim, fs.constants.X_OK);
  const bin = path.join(app.getPath("home"), ".local/bin");
  const target = path.join(bin, "precut");
  await fs.mkdir(bin, { recursive: true });
  try {
    const stat = await fs.lstat(target);
    if (!stat.isSymbolicLink()) throw new Error(`${target} already exists and is not a symlink. Move it aside first.`);
    if (await fs.readlink(target) !== shim) {
      const previous = await fs.readlink(target);
      if (!previous.endsWith("/build/precut") && !previous.endsWith("/Contents/Resources/precut")) throw new Error(`${target} points to another tool. Move it aside first.`);
      await fs.unlink(target);
      await fs.symlink(shim, target);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.symlink(shim, target);
  }
  const onPath = (process.env.PRECUT_SHELL_PATH ?? process.env.PATH ?? "").split(path.delimiter).includes(bin);
  if (!onPath) process.stderr.write('precut is installed. Add ~/.local/bin to your PATH: export PATH="$HOME/.local/bin:$PATH"\n');
  return { path: target, onPath };
}
