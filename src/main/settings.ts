// App settings that main needs (the renderer keeps look-only prefs in localStorage).
// Stored at userData/settings.json.
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { STEP_IDS, type Autopilot, type Engine } from "../shared/schema";

const file = () => path.join(app.getPath("userData"), "settings.json");

function read(): { engine?: Engine; musicFolder?: string | null; autopilot?: Autopilot } {
  try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch { return {}; }
}

// Claude Code by default: it judged the real shoot better (qa/S3/REPORT.md).
export async function getEngine(): Promise<Engine> {
  const e = read().engine ?? process.env.SIDETHING_JUDGE_ENGINE;
  return e === "muse" ? "muse" : "claude";
}

export async function setEngine(engine: Engine): Promise<void> {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ ...read(), engine }, null, 2));
}

// the user's own music folder (tracks he has rights to), used for reels.
export async function getMusicFolder(): Promise<string | null> {
  return read().musicFolder ?? null;
}

export async function setMusicFolder(folder: string | null): Promise<void> {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ ...read(), musicFolder: folder }, null, 2));
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

const defaultAutopilot: Autopilot = { stopAt: [], cutCount: 3 };
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
