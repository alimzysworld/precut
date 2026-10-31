import { DEFAULT_AUTOPILOT_CUT_COUNT } from "../shared/schema";
// App settings that main needs (the renderer keeps look-only prefs in localStorage).
// Stored at userData/settings.json.
import { normalizePostPlaces } from "./post-places";
import { normalizeBasic, validBasic } from "./basics";
import { isCaptionStyle } from "./titles/captions";
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { STEP_IDS, type Autopilot, type Engine, type EditorId, type Preferences } from "../shared/schema";
import { resolveBinary, runChild } from "./ai";
import { isLookPreset, type LookPreference } from "./grade";
export type LookPreferences = Omit<Preferences, "look"> & { look: LookPreference & { detail?: boolean } };

const file = () => path.join(app.getPath("userData"), "settings.json");

function read(): { engine?: Engine | "none"; models?: Partial<Record<Engine, string | null>>; editor?: EditorId; musicFolder?: string | null; starterMusic?: boolean; autopilot?: Autopilot; preferences?: unknown; applePlayerChosen?: boolean } {
  try {
    const value = JSON.parse(fs.readFileSync(file(), "utf8"));
    return isObject(value) ? value : {};
  } catch { return {}; }
}

function write(patch: Partial<ReturnType<typeof read>>): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ ...read(), ...patch }, null, 2));
}
type EngineStatus = { id: "claude" | "codex" | "muse"; installed: boolean; signedIn: boolean | null; version: string | null; apiKey?: boolean };
let engineCache: { until: number; pending: Promise<EngineStatus[]> } | null = null;
export async function listEngines(fresh = false): Promise<EngineStatus[]> {
  if (fresh) engineCache = null;
  if (!engineCache || engineCache.until <= Date.now()) {
    const pending = Promise.all((["claude", "codex", "muse"] as const).map(async (id): Promise<EngineStatus> => {
      let bin: string;
      try { bin = await resolveBinary(id); }
      catch { return { id, installed: false, signedIn: null, version: null }; }
      const status: EngineStatus = { id, installed: true, signedIn: null, version: null };
      // Run the engine CLIs from an empty folder of precut's own: from the home folder they look around it, and macOS
      // then asks him to let precut into Desktop (and Documents) on every launch.
      const probeDir = path.join(app.getPath("userData"), "engine-probe");
      fs.mkdirSync(probeDir, { recursive: true });
      const opts = { cwd: probeDir, env: { ...process.env }, timeoutMs: 5_000 };
      delete opts.env.OPENAI_API_KEY;
      delete opts.env.CODEX_API_KEY;
      delete opts.env.ANTHROPIC_API_KEY;
      delete opts.env.ANTHROPIC_AUTH_TOKEN;
      delete opts.env.ANTHROPIC_BASE_URL;
      await Promise.all([
        runChild(bin, ["--version"], opts).then((r) => { if (r.code === 0) status.version = r.stdout.trim() || null; }).catch(() => {}),
        (async () => {
          if (id === "muse") return; // This CLI has no free account-status command.
          const r = await runChild(bin, id === "claude" ? ["auth", "status"] : ["login", "status"], opts);
          if (id === "claude") {
            try {
              const auth = JSON.parse(r.stdout);
              if (typeof auth.loggedIn === "boolean") status.signedIn = auth.loggedIn && auth.authMethod === "claude.ai";
              // ONB2: signed in, but with an API key: precut uses the Claude subscription, so say why it isn't ready.
              if (auth.loggedIn === true && auth.authMethod !== "claude.ai") status.apiKey = true;
            } catch { /* Old CLIs without auth status remain unknown. */ }
          } else {
            const output = r.stdout + "\n" + r.stderr;
            if (/logged in using chatgpt/i.test(output)) status.signedIn = true;
            else if (/not logged in|not signed in|logged in using.*api key/i.test(output)) status.signedIn = false;
            if (/logged in using.*api key/i.test(output)) status.apiKey = true;
          }
        })().catch(() => {}),
      ]);
      return status;
    }));
    engineCache = { until: Date.now() + 60_000, pending };
  }
  return (await engineCache.pending).map((status) => ({ ...status }));
}

const editors = ["resolve", "premiere", "finalcut", "capcut"] as const;
export async function getEditor(): Promise<EditorId> {
  const editor = read().editor;
  return editor && editors.includes(editor) ? editor : "resolve";
}
export async function setEditor(editor: EditorId): Promise<void> {
  if (!editors.includes(editor)) throw new Error("Choose an editor from the list.");
  write({ editor });
}

/** AV5: the Apple player's default for anyone who never used its switch (see currentPreferences). AV6 (30 Oct): on,
 * after acceptance (qa/AV6/results: lip sync 8 of 8 within 7 ms of the export, no freezes or dropped pictures on his
 * edit and the five-join edit, parity 18 of 18, level within 0.2 dB). */
export const APPLE_PLAYER_DEFAULT = true;
const DEFAULT_PREFERENCES: LookPreferences = {
  vocabulary: [],
  clipSoundNewEdits: {on:false,db:-20},
  output: { shapes: ["9:16", "16:9"], height: 1080, fps: null, exportFolder: null, targets: ["resolve"] },
  captions: { onByDefault: true, safeArea: "tiktok" },
  voice: { clean: true, denoise: 0.6, loudnessLUFS: -14, auto: true, breaths: true },
  aiSeesFrames: true,
  notifications: true,
  autoCorrectNewEdits: true,
  look: { preset: "clean", words: null, intensity: .7, detail: true },
  timeline: { snapping: true, closeGaps: true, audioScrub: true },
  // AV5/AV6: on for everyone who never chose (APPLE_PLAYER_DEFAULT, on since AV6's acceptance); a choice is kept.
  playback: { applePlayer: APPLE_PLAYER_DEFAULT },
};
const SHAPES = ["9:16", "16:9", "1:1", "4:5"] as const;
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

// Old/invalid stored fields fall back individually. IPC patches reject invalid
// types and choices before writing; continuous values are clamped to the UI range.
function mergePreferences(base: LookPreferences, value: unknown, strict = false): LookPreferences {
  const next: LookPreferences = { ...base, look: { ...base.look }, vocabulary: [...base.vocabulary],
    output: { ...base.output, shapes: [...base.output.shapes] }, captions: { ...base.captions }, voice: { ...base.voice }, timeline: { ...base.timeline }, playback: { ...base.playback } };
  const invalid = (field: string) => { if (strict) throw new Error(`Choose a valid ${field} preference.`); };
  if (!isObject(value)) { invalid("settings"); return next; }
  if (strict) {
    const allowed: Record<string, string[]> = {
      output: ["shapes", "height", "fps", "exportFolder", "targets", "posts"],
      captions: ["onByDefault", "safeArea", "style"],
      voice: ["clean", "denoise", "loudnessLUFS", "auto", "breaths", "eq"],
      look: ["preset", "words", "intensity", "basic", "detail"],
      clipSoundNewEdits: ["on", "db"],
      timeline: ["snapping", "closeGaps", "audioScrub"],
      playback: ["applePlayer"],
    };
    for (const key of Object.keys(value)) {
      if (!["vocabulary", "notifications", "aiSeesFrames", "improveFirstCuts", "autoCorrectNewEdits", "autoUpdates", ...Object.keys(allowed)].includes(key)) invalid(key);
      if (allowed[key] && isObject(value[key])) for (const field of Object.keys(value[key])) if (!allowed[key].includes(field)) invalid(`${key}.${field}`);
    }
  }
  function field<T extends object, K extends keyof T>(target: T, source: Record<string, unknown>, key: K,
    valid: (v: unknown) => boolean, convert: (v: unknown) => T[K] = (v) => v as T[K]) {
    if (!Object.hasOwn(source, key)) return;
    if (!valid(source[String(key)])) { invalid(String(key)); return; }
    target[key] = convert(source[String(key)]);
  }
  field(next, value, "vocabulary", (v) => Array.isArray(v) && v.every((word) => typeof word === "string"), (v) => {
    const seen = new Set<string>();
    return (v as string[]).map((word) => word.trim()).filter((word) => {
      const key = word.toLocaleLowerCase();
      if (!word || seen.has(key)) return false;
      seen.add(key); return true;
    });
  });
  field(next, value, "aiSeesFrames", (v) => typeof v === "boolean");
  field(next, value, "notifications", (v) => typeof v === "boolean");
  field(next, value, "improveFirstCuts", (v) => typeof v === "boolean");  // MB1
  field(next, value, "autoUpdates", (v) => typeof v === "boolean");  // REL2: Settings, General, Updates; absent = on
  for (const key of ["output", "captions", "voice", "look", "timeline", "playback"] as const) {
    if (Object.hasOwn(value, key) && !isObject(value[key])) invalid(key);
  }
  if (isObject(value.output)) {
    field(next.output, value.output, "shapes", (v) => Array.isArray(v) && v.length > 0 &&
      v.every((shape) => SHAPES.includes(shape)), (v) => [...new Set(v as Preferences["output"]["shapes"])]);
    field(next.output, value.output, "targets", v => Array.isArray(v) && v.length > 0 &&
      v.every(target => ["resolve", "finalcut", "premiere", "capcut", "mp4"].includes(target)),
      v => [...new Set(v as NonNullable<Preferences["output"]["targets"]>)]);
    field(next.output, value.output, "posts", v => Array.isArray(v) && v.length > 0 && v.every(place => ["vertical", "reels", "tiktok", "shorts", "youtube", "linkedin", "x"].includes(place)), v => normalizePostPlaces(v as string[]) as unknown as Preferences["output"]["posts"]);
    field(next.output, value.output, "height", (v) => v === 1080 || v === 1440 || v === 2160);
    field(next.output, value.output, "fps", (v) => v === null || v === 24 || v === 25 || v === 30 || v === 50 || v === 60);
    field(next.output, value.output, "exportFolder", (v) => v === null ||
      (typeof v === "string" && !v.includes("\0") && path.isAbsolute(v.trim())),
      (v) => v === null ? null : path.normalize((v as string).trim()));
  }
  field(next,value,"clipSoundNewEdits",v=>isObject(v) && typeof v.on === 'boolean' && finite(v.db),v=>({on:(v as {on:boolean}).on,db:Math.max(-60,Math.min(6,Math.round((v as {db:number}).db*2)/2))}));
  if (isObject(value.captions)) {
    field(next.captions, value.captions, "onByDefault", (v) => typeof v === "boolean");
    field(next.captions, value.captions, "style", isCaptionStyle, v => ({ ...v as NonNullable<Preferences["captions"]["style"]> }));
    field(next.captions, value.captions, "safeArea", (v) => ["tiktok", "reels", "shorts", "none"].includes(v as string));
  }
  if (isObject(value.voice)) {
    if (isObject(value.voice.eq)) {
      const eq = value.voice.eq;
      if ([eq.low, eq.mid, eq.high].every(v => typeof v === "number" && Number.isFinite(v))) next.voice.eq = { low: Math.max(-12, Math.min(12, eq.low as number)), mid: Math.max(-12, Math.min(12, eq.mid as number)), high: Math.max(-12, Math.min(12, eq.high as number)) };
    }
    field(next.voice, value.voice, "clean", (v) => typeof v === "boolean");
    field(next.voice, value.voice, "auto", (v) => typeof v === "boolean");
    field(next.voice, value.voice, "breaths", (v) => typeof v === "boolean");
    field(next.voice, value.voice, "denoise", finite, (v) => Math.max(0, Math.min(1, v as number)));
    field(next.voice, value.voice, "loudnessLUFS", finite, (v) => Math.max(-16, Math.min(-14, v as number)));
  }
  field(next, value, "autoCorrectNewEdits", v => typeof v === "boolean");
  if (isObject(value.timeline)) {  // VO7-13
    const timeline = next.timeline ??= {};
    field(timeline, value.timeline, "snapping", v => typeof v === "boolean");
    field(timeline, value.timeline, "closeGaps", v => typeof v === "boolean");
    field(timeline, value.timeline, "audioScrub", v => typeof v === "boolean");  // VO7-14
  }
  if (isObject(value.playback)) {  // AV1
    const playback = next.playback ??= {};
    field(playback, value.playback, "applePlayer", v => typeof v === "boolean");
  }
  if (isObject(value.look)) {
    field(next.look, value.look, "detail", v => typeof v === "boolean");
    field(next.look, value.look, "basic", validBasic, v => normalizeBasic(v as Preferences["look"]["basic"]));
    field(next.look, value.look, "preset", isLookPreset);
    field(next.look, value.look, "words", (v) => v === null || (typeof v === "string" && v.length <= 2000), (v) => typeof v === "string" ? v.trim() || null : null);
    field(next.look, value.look, "intensity", finite, (v) => Math.max(0, Math.min(1, v as number)));
  }
  if ((next.output.posts as string[] | undefined)?.[0] === "vertical") next.captions.safeArea = "tiktok";
  // REL2: the person's "AI sees frames" choice is respected (it was forced on before the first public release).
  return next;
}
function currentPreferences(): LookPreferences {
  const settings = read();
  // Preserve the person's former editor choice when consolidating defaults.
  const defaults = settings.editor && editors.includes(settings.editor)
    ? { ...DEFAULT_PREFERENCES, output: { ...DEFAULT_PREFERENCES.output, targets: [settings.editor] } } : DEFAULT_PREFERENCES;
  const merged = mergePreferences(defaults, settings.preferences);
  // AV5: every save writes the whole preferences, so a stored "applePlayer: false" was usually the old default carried
  // along by some other change, not a choice. Only a value the person set (the Settings switch or MCP, which mark
  // applePlayerChosen) is kept; otherwise the default applies. A stored true stays true either way.
  const playback = isObject(settings.preferences) && isObject(settings.preferences.playback) ? settings.preferences.playback : null;
  if (settings.applePlayerChosen !== true && playback?.applePlayer !== true) merged.playback = { ...merged.playback, applePlayer: APPLE_PLAYER_DEFAULT };
  return merged;
}
export async function getPreferences(): Promise<LookPreferences> { return currentPreferences(); }
export async function setPreferences(patch: Partial<Preferences>): Promise<Preferences> {
  // No await between reading and writing: concurrent IPC patches keep each
  // other's fields, as well as engine, editor, autopilot and music settings.
  const previous = currentPreferences();
  const preferences = mergePreferences(previous, patch, true);
  // AV5: a patch that sets the Apple player is the person's choice; it is kept from now on (see currentPreferences).
  const chosen = isObject(patch) && isObject((patch as Record<string, unknown>).playback) && typeof ((patch as Record<string, unknown>).playback as Record<string, unknown>).applePlayer === "boolean";
  write(chosen ? { preferences, applePlayerChosen: true } : { preferences });
  if (JSON.stringify(previous.vocabulary) !== JSON.stringify(preferences.vocabulary) && fs.existsSync(path.join(app.getPath("userData"), "shoots.json"))) {
    void import("./vocabulary").then(m => m.scheduleVocabulary(null)).catch(error => console.error("[vocabulary]", error));
  }
  return preferences;
}

export async function getEngine(): Promise<Engine> {
  const e = read().engine ?? process.env.SIDETHING_JUDGE_ENGINE;
  return e === "muse" || e === "codex" ? e : "claude";
}
/** ONB2: "Start without AI" is a remembered choice. With it precut makes no model calls at all (ai.ts runModel refuses). */
export function aiOff(): boolean { return read().engine === "none"; }
export async function getEngineChoice(): Promise<Engine | "none"> { return aiOff() ? "none" : getEngine(); }

export async function setEngine(engine: Engine | "none"): Promise<void> {
  if (!["claude", "codex", "muse", "none"].includes(engine)) throw new Error("Choose Claude Code, Codex, Muse or no AI.");
  write({ engine });
}

export async function getEngineModel(engine: Engine): Promise<string | null> {
  const model = read().models?.[engine];
  if (engine === "claude") return model === "opus" || model === "sonnet" ? model : null;
  return engine === "codex" && typeof model === "string" && model.trim() ? model.trim() : null;
}
export async function setEngineModel(engine: Engine, model: string | null): Promise<void> {
  if (!["claude", "codex", "muse"].includes(engine)) throw new Error("Choose Claude Code, Codex or Muse.");
  const value = model?.trim() || null;
  if (engine === "claude" && value !== null && value !== "opus" && value !== "sonnet") throw new Error("Choose Opus, Sonnet or your Claude Code default.");
  if (engine === "muse" && value !== null) throw new Error("Muse uses your Muse default model.");
  write({ models: { ...read().models, [engine]: value } });
}

// the user's own music folder (tracks he has rights to), used for reels.
export async function getMusicFolder(): Promise<string | null> {
  return read().musicFolder ?? null;
}

export async function setMusicFolder(folder: string | null): Promise<void> {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ ...read(), musicFolder: folder }, null, 2));
}

// ONB2: the bundled starter tracks (build/music, CC0 or CC BY). On unless the person turns them off.
export function starterMusicOn(): boolean { return read().starterMusic !== false; }
export async function setStarterMusic(on: boolean): Promise<void> {
  if (typeof on !== "boolean") throw new Error("Choose on or off.");
  write({ starterMusic: on });
}

export async function pickMusicFolder(): Promise<string | null> {
  const { BrowserWindow, dialog } = await import("electron");
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const opts = { properties: ["openDirectory" as const], buttonLabel: "Use this folder" };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths[0]) return null;
  await setMusicFolder(r.filePaths[0]);
  return r.filePaths[0];
}

const defaultAutopilot: Autopilot = { stopAt: [], cutCount: DEFAULT_AUTOPILOT_CUT_COUNT };
function validateAutopilot(a: Autopilot): Autopilot {
  if (!a || !Array.isArray(a.stopAt) || a.stopAt.some((step) => !STEP_IDS.includes(step)) ||
      !Number.isInteger(a.cutCount) || a.cutCount < 1) throw new Error("Choose valid stop steps and a positive cut count.");
  return { stopAt: [...new Set(a.stopAt)], cutCount: a.cutCount };
}
export async function getAutopilot(root?: string): Promise<Autopilot> {
  if (root) {
    try { return validateAutopilot(JSON.parse(await fs.promises.readFile(path.join(path.resolve(root), ".sidething/autopilot.json"), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return validateAutopilot(read().autopilot ?? defaultAutopilot);
}
export async function setAutopilot(a: Autopilot, root?: string): Promise<void> {
  const autopilot = validateAutopilot(a);
  const target = root ? path.join(path.resolve(root), ".sidething/autopilot.json") : file();
  // Synchronous read/rename also keeps updates to other default settings together.
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(root ? autopilot : { ...read(), autopilot }, null, 2) + "\n");
    fs.renameSync(temp, target);
  } finally { try { fs.unlinkSync(temp); } catch { /* renamed */ } }
}
