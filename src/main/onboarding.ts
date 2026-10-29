// ONB1: first-run help that never blocks. The person picks an engine, we point at the
// one missing step, and the Python tools and speech model download in the background.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AiStatus, Engine, FirstRunDownloads, ShootReadTime } from "../shared/schema";
import { supportDir, toolEnvironment } from "./tools";
// jobs, ai and electron load on first use so the first-run helpers stay light and testable alone.
const jobs = () => import("./jobs");

const SPEECH_REPO = "models--mlx-community--whisper-large-v3-turbo";
const INSTALL_PAGE: Record<Engine, string> = {
  claude: "https://code.claude.com/docs/en/setup",
  codex: "https://developers.openai.com/codex/cli",
  muse: "",
};
const LOGIN_COMMAND: Record<Engine, string> = { claude: "claude", codex: "codex login", muse: "muse login" };

function hasWeights(snapshots: string): boolean {
  try {
    return fs.readdirSync(snapshots).some(name => {
      const dir = path.join(snapshots, name);
      return fs.existsSync(path.join(dir, "config.json"))
        && (fs.existsSync(path.join(dir, "weights.safetensors")) || fs.existsSync(path.join(dir, "weights.npz")));
    });
  } catch { return false; }
}
export function speechModelReady(): boolean {
  return [path.join(supportDir(), "models/hub"), path.join(os.homedir(), ".cache/huggingface/hub")]
    .some(hub => hasWeights(path.join(hub, SPEECH_REPO, "snapshots")));
}
export function toolsReady(): boolean {
  return fs.existsSync(path.join(supportDir(), "venv/.precut-ready"));
}

import { DOWNLOAD_SIZES, TOOLS_OFFLINE_LINE, DOWNLOADS_PAUSED as PAUSED, DOWNLOAD_STALLED } from "../shared/first-run";
export { DOWNLOAD_SIZES, TOOLS_OFFLINE_LINE };
// Retry and stall timings; tests shorten them. A stall is a long time with no new bytes: the speech model is one
// large file that lands in lumps (REL1 saw 50 s without growth on a good line), so the bar is minutes, not seconds.
export const downloadTimings = { retryMs: 20_000, maxRetryMs: 120_000, stallMs: 240_000 };

let state: FirstRunDownloads = { state: "idle", what: null, pct: 0, etaS: null, message: "" };
let running: Promise<void> | undefined;
let tools: Promise<void> | undefined;
let resumes = 0;

/** Processing calls this before Python starts: waits only for the small tools install. */
export function ensureTools(): Promise<void> {
  if (toolsReady()) return Promise.resolve();
  return tools ??= jobs().then(m => m.preparePython()).finally(() => { tools = undefined; });
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** ONB2: reading a shoot waits for the tools instead of failing offline, says so in one plain line, and carries on by itself. */
export async function ensureToolsWhenOnline(onWait: (line: string) => void): Promise<void> {
  for (let delay = downloadTimings.retryMs; ; delay = Math.min(downloadTimings.maxRetryMs, delay * 1.5)) {
    try { await ensureTools(); return; }
    catch { onWait(TOOLS_OFFLINE_LINE); await sleep(delay); }
  }
}

async function downloadModel(): Promise<"ok" | "failed" | "stalled"> {
  const { venvPython, pipelineFile } = await jobs();
  return new Promise(resolve => {
    const child = spawn(venvPython(), ["-I", pipelineFile("model.py")], { env: toolEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let finished = false, grewAt = Date.now(), last = -1;
    const end = (result: "ok" | "failed" | "stalled") => { if (!finished) { finished = true; clearInterval(watch); resolve(result); } };
    // No new bytes for the stall time: stop it and start again (Hugging Face resumes what already landed).
    const watch = setInterval(() => {
      if (Date.now() - grewAt < downloadTimings.stallMs) return;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      end("stalled");
    }, Math.min(5_000, downloadTimings.stallMs / 2));
    createInterface({ input: child.stdout! }).on("line", line => {
      let event: { bytes?: number; total?: number; error?: string; done?: boolean };
      try { event = JSON.parse(line); } catch { return; }
      if (typeof event.bytes !== "number" || !event.total) return;
      if (event.bytes > last) { last = event.bytes; grewAt = Date.now(); }
      // Progress only goes forward, across restarts too.
      const pct = Math.max(state.what === "speech" ? state.pct : 0, Math.min(99, Math.floor(100 * event.bytes / event.total)));
      // ONB2: no time left is shown. The model arrives in lumps (REL1 showed "Approx 86222 min" for a 3 minute
      // download), so no rate measured here is honest. Percent and size only.
      state = { state: "working", what: "speech", pct, etaS: null, message: "Getting speech ready", ...(resumes ? { resumed: resumes } : {}) };
    });
    child.stderr?.on("data", () => {});
    child.on("error", () => end("failed"));
    child.on("close", code => end(code === 0 ? "ok" : "failed"));
  });
}

export function startFirstRunDownloads(): Promise<void> {
  if (running) return running;
  if (toolsReady() && speechModelReady()) { state = { state: "ready", what: null, pct: 100, etaS: null, message: "" }; return Promise.resolve(); }
  running = (async () => {
    for (let delay = downloadTimings.retryMs; ; delay = Math.min(downloadTimings.maxRetryMs, delay * 1.5)) {
      try {
        if (!toolsReady()) {
          state = { state: "working", what: "tools", pct: 0, etaS: null, message: "Getting tools ready" };
          await ensureTools();
        }
        while (!speechModelReady()) {
          if (state.what !== "speech" || state.state !== "working") state = { state: "working", what: "speech", pct: state.what === "speech" ? state.pct : 0, etaS: null, message: "Getting speech ready" };
          const result = await downloadModel();
          if (result === "ok") break;
          if (result === "failed") throw new Error("download");
          // Stalled: say so, and pick it up again straight away.
          resumes++;
          state = { ...state, state: "working", message: DOWNLOAD_STALLED, resumed: resumes };
        }
        state = { state: "ready", what: null, pct: 100, etaS: null, message: "" };
        return;
      } catch {
        resumes++;
        state = { state: "error", what: state.what, pct: state.pct, etaS: null, message: PAUSED, resumed: resumes };
        await sleep(delay);
      }
    }
  })().finally(() => { running = undefined; });
  return running;
}
export async function firstRunDownloads(): Promise<FirstRunDownloads> {
  if (state.state === "idle" && toolsReady() && speechModelReady()) return { state: "ready", what: null, pct: 100, etaS: null, message: "" };
  return { ...state };
}

function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

export async function openEngineHelp(engine: Engine, action: "signin" | "install"): Promise<void> {
  if (!(engine in LOGIN_COMMAND)) throw new Error("Choose Claude Code, Codex or Muse.");
  if (action === "install") {
    if (!INSTALL_PAGE[engine]) throw new Error("Install Muse from where you got it, then come back.");
    await (await import("electron")).shell.openExternal(INSTALL_PAGE[engine]);
    return;
  }
  // QA launches never take the front (briefs/_VO7-COMMON.md): Terminal stays shut and the card offers the command to copy.
  if (process.env.PRECUT_QA_BACKGROUND === "1") throw new Error("Could not open Terminal. Allow precut to control Terminal in System Settings, then try again.");
  const binary = await (await import("./ai")).resolveBinary(engine).catch(() => engine);
  const [, ...rest] = LOGIN_COMMAND[engine].split(" ");
  const command = ["cd", quote(os.homedir()) + ";", quote(binary), ...rest].join(" ");
  const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(command)}\nend tell`;
  const ok = await new Promise<boolean>(resolve => {
    const child = spawn("/usr/bin/osascript", ["-e", script], { stdio: "ignore" });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(false); }, 10_000);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", code => { clearTimeout(timer); resolve(code === 0); });
  });
  if (!ok) throw new Error("Could not open Terminal. Allow precut to control Terminal in System Settings, then try again.");
}

/** One tiny real call. The result is plain words, never a stack. */
export async function testEngine(engine: Engine): Promise<{ ok: boolean; text: string }> {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "precut-engine-test-"));
  try {
    const answer = await (await import("./ai")).runModel({ engine, prompt: "Reply with the single word: ready", images: [], cwd, timeoutMs: 90_000 });
    return answer.trim() ? { ok: true, text: "Works. Your engine answered." } : { ok: false, text: "The engine answered with nothing. Try again." };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/ENOENT/.test(message)) return { ok: false, text: `${{ claude: "Claude Code", codex: "Codex", muse: "Muse" }[engine]} isn't installed` };
    return { ok: false, text: message.length > 0 && message.length < 140 && !/\n/.test(message) ? message : "The engine did not answer. Try again." };
  } finally {
    await fs.promises.rm(cwd, { recursive: true, force: true });
  }
}

/** ONB2: the one read behind the shared "Needs your AI" card: which AI, and the one thing in its way. No model call. */
export async function aiStatus(fresh = false): Promise<AiStatus> {
  const settings = await import("./settings");
  const labels: Record<Engine, string> = { claude: "Claude Code", codex: "Codex", muse: "Muse" };
  if (settings.aiOff()) return { choice: "none", engine: null, label: null, state: "none", signInCommand: null, installUrl: null, apiKey: false, detail: null };
  const engine = await settings.getEngine();
  const found = (await settings.listEngines(fresh)).find(item => item.id === engine);
  const base = { choice: engine, engine, label: labels[engine], signInCommand: LOGIN_COMMAND[engine], installUrl: INSTALL_PAGE[engine] || null, apiKey: !!found?.apiKey, detail: null };
  if (!found?.installed) return { ...base, state: "not-installed" };
  if (engine !== "muse" && found.signedIn === false) return { ...base, state: "signed-out" };
  const problem = (await import("./ai")).lastEngineProblem();
  if (problem?.engine === engine && (problem.problem === "allowance" || problem.problem === "offline") && Date.now() - problem.at < 30 * 60_000)
    return { ...base, state: problem.problem, detail: problem.message.length < 200 ? problem.message : null };
  if (engine !== "muse" && found.signedIn === null) return { ...base, state: "unknown" };
  return { ...base, state: "ready" };
}

/** ONB2: how much footage this shoot's reading covered and how long it took, measured by jobs.ts at the end of the read. */
export async function shootReadTime(root: string): Promise<ShootReadTime | null> {
  if (typeof root !== "string" || !root) return null;
  try {
    const value = JSON.parse(await fs.promises.readFile(path.join(path.resolve(root), ".sidething/read-time.json"), "utf8"));
    return Number.isFinite(value.footageS) && Number.isFinite(value.tookS) && value.footageS > 0 && value.tookS > 0
      ? { footageS: value.footageS, tookS: value.tookS, clips: Number(value.clips) || 0 } : null;
  } catch { return null; }
}
