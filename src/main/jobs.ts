// Job runner: queues shoots, runs pipeline/setup.py then pipeline/process.py
// (venv python, -I), one shoot at a time, forwards progress to the renderer.
import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Shoot, Stage } from "../shared/schema";
import { judgeShoot } from "./judge";

export interface ProgressEvent {
  root: string;
  clipId: string;
  stage: Stage;
  pct: number;
  note?: string;
}

type ProgressForwarder = (e: ProgressEvent) => void;
let forwarder: ProgressForwarder = () => {};
export function setProgressForwarder(fn: ProgressForwarder): void {
  forwarder = fn;
}

const CLIP_EXTS = new Set([".mp4", ".mov", ".mxf", ".mts", ".m4v"]);

function venvDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "precut", "venv");
}
function venvPython(): string {
  return path.join(venvDir(), "bin", "python");
}

function pipelineFile(name: string): string {
  const candidates = [
    path.join(app.getAppPath(), "pipeline", name),
    path.join(__dirname, "..", "..", "pipeline", name),
    path.join(process.cwd(), "pipeline", name),
  ];
  if (process.resourcesPath) {
    candidates.splice(1, 0, path.join(process.resourcesPath, "pipeline", name));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function shootsStorePath(): string {
  return path.join(app.getPath("userData"), "shoots.json");
}

interface StoredShoot {
  root: string;
  name: string;
}

function readStore(): StoredShoot[] {
  try {
    const raw = fs.readFileSync(shootsStorePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is StoredShoot =>
        typeof e === "object" && e !== null &&
        typeof (e as StoredShoot).root === "string" &&
        typeof (e as StoredShoot).name === "string",
    );
  } catch {
    return [];
  }
}

function writeStore(entries: StoredShoot[]): void {
  fs.mkdirSync(path.dirname(shootsStorePath()), { recursive: true });
  fs.writeFileSync(shootsStorePath(), JSON.stringify(entries, null, 1));
}

function rememberShoot(root: string): void {
  const entries = readStore();
  if (!entries.some((e) => e.root === root)) {
    entries.push({ root, name: path.basename(root) });
    writeStore(entries);
  }
}

function stubShoot(root: string): Shoot {
  const clips: Shoot["clips"] = [];
  const walk = (dir: string): void => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (item.name !== ".sidething") walk(full);
      } else if (CLIP_EXTS.has(path.extname(item.name).toLowerCase())) {
        clips.push({
          id: path.basename(item.name, path.extname(item.name)),
          file: path.relative(root, full),
          stage: "probe",
          meta: null,
          transcript: null,
          shake: null,
          frames: [],
          proxy: null,
          judgement: null,
        });
      }
    }
  };
  walk(root);
  clips.sort((a, b) => a.file.localeCompare(b.file));
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    name: path.basename(root),
    root,
    createdAt: now,
    updatedAt: now,
    script: [],
    scriptSource: "none",
    clips,
    audio: [],
    takes: [],
  };
}

export async function loadShoot(root: string): Promise<Shoot | null> {
  const resolved = path.resolve(root);
  const indexPath = path.join(resolved, ".sidething", "index.json");
  try {
    const raw = await fs.promises.readFile(indexPath, "utf8");
    return JSON.parse(raw) as Shoot;
  } catch {
    if (fs.existsSync(resolved)) return stubShoot(resolved);
    return null;
  }
}

export async function listShoots(): Promise<{ root: string; name: string; online: boolean }[]> {
  return readStore().map((e) => ({
    root: e.root,
    name: e.name,
    online: fs.existsSync(e.root),
  }));
}

export async function pickFolder(): Promise<string | null> {
  // Attached to the window, so macOS shows it as a sheet, not a separate window.
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const opts = { properties: ["openDirectory" as const], buttonLabel: "Add shoot" };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

export async function revealInFinder(target: string): Promise<void> {
  const resolved = path.resolve(target);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      await shell.openPath(resolved);
      return;
    }
  } catch {
    // fall through to showItemInFolder for files and missing paths
  }
  shell.showItemInFolder(resolved);
}

// ---------------------------------------------------------------- queue ----
const queue: string[] = [];
const active = new Set<string>();
let running = false;

export function enqueueShoot(root: string): void {
  const resolved = path.resolve(root);
  if (active.has(resolved) || queue.includes(resolved)) return;
  queue.push(resolved);
  void processQueue();
}

async function processQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const root = queue.shift() as string;
      active.add(root);
      try {
        await runShoot(root);
      } catch (err) {
        console.error(`[jobs] processing failed for ${root}:`, err);
      } finally {
        active.delete(root);
      }
    }
  } finally {
    running = false;
  }
}

function runProcess(
  command: string,
  args: string[],
  onLine?: (line: string) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    if (onLine && child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", onLine);
    } else {
      child.stdout?.resume();
    }
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function ensureVenv(): Promise<void> {
  if (fs.existsSync(venvPython())) return;
  const setup = pipelineFile("setup.py");
  const code = await runProcess("python3", [setup]);
  if (code !== 0 || !fs.existsSync(venvPython())) {
    throw new Error("pipeline setup failed; run pipeline/setup.py for details");
  }
}

async function runShoot(root: string): Promise<void> {
  await ensureVenv();
  const stages: { file: string; stage?: Stage; note?: string }[] = [
    { file: "process.py" },
    { file: "sync.py", stage: "audio", note: "lining up sound" },
    ...(fs.existsSync(pipelineFile("subject.py"))
      ? [{ file: "subject.py", stage: "frames" as const, note: "framing" }] : []),
  ];
  for (const task of stages) {
    if (task.stage) forwarder({ root, clipId: "", stage: task.stage, pct: 0, note: task.note });
    const code = await runProcess(venvPython(), ["-I", pipelineFile(task.file), root], (line) => {
      try {
        const event = JSON.parse(line) as { clipId?: string; stage?: string; pct?: number };
        if (typeof event.clipId === "string" && typeof event.stage === "string") {
          forwarder({
            root,
            clipId: event.clipId,
            // Subject's CLI uses "subject"; keep the shared Stage contract.
            stage: task.stage ?? event.stage as Stage,
            pct: typeof event.pct === "number" ? event.pct : 0,
            ...(task.note ? { note: task.note } : {}),
          });
        }
      } catch {
        // Non-JSON tool output is not a progress event.
      }
    });
    if (task.stage) forwarder({ root, clipId: "", stage: "done", pct: 100 });
    if (code !== 0) throw new Error(`${task.file} exited with code ${code} for ${root}`);
  }
  try {
    await judgeShoot(root, {
      onProgress: (e) => forwarder({ root: e.root, clipId: e.clipId, stage: e.stage, pct: e.pct }),
    });
  } catch (err) {
    // Clips are already processed; a judge failure must not fail the shoot.
    console.error(`[jobs] judging failed for ${root}:`, err);
  }
}

export async function addShoot(root: string): Promise<Shoot> {
  const resolved = path.resolve(root);
  rememberShoot(resolved);
  enqueueShoot(resolved);
  const existing = await loadShoot(resolved);
  return existing ?? stubShoot(resolved);
}
