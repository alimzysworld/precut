// Engine adapter: one AI call through the person's logged-in CLI.
// Claude Code: stream-json image blocks, with Read as the older-CLI fallback
// and optional read-only reference tools. Muse: `muse exec --json` with a
// prompt file and native --image attachments. Codex: `codex exec --json` in a
// read-only sandbox, using ChatGPT login. API keys are removed from child envs.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getEngineModel, getPreferences } from "./settings";
import * as appSettings from "./settings";
import { currentActivity } from "./activity";
import { engineProblemOf, NO_ENGINE_MESSAGE, type EngineProblem } from "../shared/engine-problem";
export { engineProblemOf, type EngineProblem };

export type Engine = "claude" | "codex" | "muse";

// Never grant a whole MCP server: it may also expose writes or messages.
export const SIDEKICK_READ_ONLY_TOOLS = [
  "WebFetch",
  "mcp__claude_ai_Notion__notion-fetch",
  "mcp__claude_ai_Notion__notion-search",
  "mcp__notion__notion-fetch",
  "mcp__notion__notion-search",
  "mcp__notion__fetch",
  "mcp__notion__search",
] as const;
type ReadOnlyTool = typeof SIDEKICK_READ_ONLY_TOOLS[number];

// Named reads only. The authenticated Ask bridge enforces this independently
// of each CLI's approvals and hides all other tools from these sessions.
export const LIBRARY_READ_TOOLS = ["list_clips", "get_clip", "list_places", "list_moments", "read_shot", "get_similar", "search_transcript_words",
  "read_transcript", "list_takes", "search_footage", "match_screen", "list_screen_recordings", "list_layouts", "look_at", "read_edit", "get_brief", "list_questions"] as const;
type LibraryConnection = { config: string; connection: { command: string; args: string[]; env: Record<string, string> } };
const toml = (value: unknown): string => typeof value === "object" && value !== null && !Array.isArray(value)
  ? `{ ${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)} = ${toml(entry)}`).join(", ")} }` : JSON.stringify(value);

export interface RunModelInput {
  engine: Engine;
  prompt: string;
  images: string[];
  cwd: string;
  extraReadOnlyTools?: readonly ReadOnlyTool[];
  libraryTools?: boolean;
  model?: string | null;
  timeoutMs?: number;              // a whole-shoot judge reads every frame grid and needs longer than a chat turn
  signal?: AbortSignal;
}
type ModelInput = RunModelInput & { libraryConnection?: LibraryConnection };

const TIMEOUT_MS = 5 * 60 * 1000;

export const ENGINE_ERRORS = {
  claudeNotInstalled: "Claude Code isn't installed",
  claudeNotSignedIn: "Claude Code isn't signed in. In Terminal run: claude login",
  codexNotInstalled: "Codex isn't installed",
  codexNotSignedIn: "Codex isn't signed in. In Terminal run: codex login",
  museNotInstalled: "Muse isn't installed",
  museNotSignedIn: "Muse isn't signed in. In Terminal run: muse login",
  invalidJson: "the model's answer wasn't valid JSON",
  noEngine: NO_ENGINE_MESSAGE,  // ONB2: "Start without AI"
} as const;

let lastProblem: { engine: Engine; problem: EngineProblem; message: string; at: number } | null = null;
/** The last access problem a real call hit, until a later call works. */
export function lastEngineProblem() { return lastProblem ? { ...lastProblem } : null; }

const ENGINE_LABELS: Record<Engine, string> = { claude: "Claude Code", codex: "Codex", muse: "Muse" };

// FIX3: whether the engine is signed in, asked of the engine itself (no model turn).
// null when it can't say (no network, an older CLI): never a guess from an exit code.
async function signedIn(engine: Engine, bin: string, cwd: string): Promise<boolean | null> {
  try {
    if (engine === "claude") {
      const result = await runChild(bin, ["auth", "status"], { cwd, env: subscriptionEnv(), timeoutMs: 10_000 });
      const auth = JSON.parse(result.stdout) as { loggedIn?: unknown; authMethod?: unknown };
      // Same rule as Settings: precut turns run on the subscription login.
      return typeof auth.loggedIn === "boolean" ? auth.loggedIn && auth.authMethod === "claude.ai" : null;
    }
    if (engine === "codex") {
      const result = await runChild(bin, ["login", "status"], { cwd, env: subscriptionEnv(), timeoutMs: 10_000 });
      const said = `${result.stdout}\n${result.stderr}`;
      if (/logged in using chatgpt/i.test(said)) return true;
      return /not logged in|logged in using.*api key/i.test(said) ? false : null;
    }
    // Muse has no status command; `usage` reads the account without a model turn and says when nobody is logged in.
    const env = { ...process.env };
    delete env.META_API_KEY;
    const result = await runChild(bin, ["usage", "--json"], { cwd, env, timeoutMs: 10_000 });
    if (result.code === 0) return true;
    return /not logged in/i.test(`${result.stdout}\n${result.stderr}`) ? false : null;
  } catch {
    return null;
  }
}

/** CH3: the same question for Claude's pane before it starts a chat (the engine's own status command, no model turn). */
export const engineSignedIn = (engine: Engine, bin: string, cwd: string) => signedIn(engine, bin, cwd);

/** A turn that ended without an answer. "Not signed in" only when the engine says so when asked;
 * otherwise its own last words, plainly. Keeps "couldn't finish" so callers don't spend a second turn. */
async function engineStopped(engine: Engine, bin: string, cwd: string, said: string): Promise<Error> {
  if (await signedIn(engine, bin, cwd) === false) return new Error(ENGINE_ERRORS[`${engine}NotSignedIn`]);
  const last = said.split("\n").map(line => line.trim()).filter(Boolean).at(-1)?.replace(/[.\s]+$/, "") ?? "";
  const words = last && last.length <= 160 && !/^[[{]/.test(last) ? `: ${last}` : "";
  return new Error(`${ENGINE_LABELS[engine]} couldn't finish this answer${words}. Try again.`);
}

function resolveOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function loginShell(command: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("/bin/zsh", ["-lc", command], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(""); }, 5_000);
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", () => { clearTimeout(timer); resolve(""); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
  });
}

// Prefer the login-shell PATH: GUI apps often inherit a different process PATH.
async function resolveViaLoginShell(name: string): Promise<string | null> {
  const found = (await loginShell(`command -v ${name}`)).trim().split("\n")[0]?.trim();
  if (found && path.isAbsolute(found)) {
    try {
      fs.accessSync(found, fs.constants.X_OK);
      return found;
    } catch {
      // fall through to the PATH search below
    }
  }
  const loginPath = await loginShell(`printf %s "$PATH"`);
  for (const dir of loginPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

const binCache = new Map<string, { binary: string; until: number }>();
export async function resolveBinary(name: Engine): Promise<string> {
  const cached = binCache.get(name);
  if (cached && cached.until > Date.now()) return cached.binary;
  const found = (await resolveViaLoginShell(name)) ?? resolveOnPath(name);
  if (!found) {
    throw new Error(ENGINE_ERRORS[`${name}NotInstalled`]);
  }
  binCache.set(name, { binary: found, until: Date.now() + 60_000 });
  return found;
}

// REL2: one-shot turns leave no history behind (Claude Code: --no-session-persistence; Codex: --ephemeral), so
// transcripts and contact sheets don't pile up in ~/.claude/projects or ~/.codex/sessions. Older CLIs without the flag
// still run, without it: the flag is read once from each binary's own help.
const flagSupport = new Map<string, Promise<boolean>>();
export function cliSupports(bin: string, help: string[], flag: string): Promise<boolean> {
  const key = `${bin}\0${help.join(" ")}\0${flag}`;
  let known = flagSupport.get(key);
  if (!known) {
    known = runChild(bin, help, { cwd: os.tmpdir(), env: subscriptionEnv(), timeoutMs: 15_000 })
      .then(r => `${r.stdout}\n${r.stderr}`.includes(flag), () => false);
    flagSupport.set(key, known);
  }
  return known;
}

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runChild(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdinText?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    opts.signal?.throwIfAborted();
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: opts.signal,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`The model timed out after ${timeoutMs / 60_000} minutes. Try again.`));
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    // A missing binary or an early CLI failure can close stdin immediately.
    child.stdin?.on("error", () => {});
    if (opts.stdinText !== undefined) {
      child.stdin?.write(opts.stdinText);
    }
    child.stdin?.end();
  });
}

// Shared subscription-only environment for one-shot and interactive agents.
export function subscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "META_API_KEY", "CLAUDECODE"]) delete env[key];
  return env;
}

async function runClaude(input: ModelInput): Promise<string> {
  const bin = await resolveBinary("claude");
  // Preserve subscription auth and the user's default model, but don't load
  // their plugins, skills, connectors or MCP servers into app-owned turns.
  // --safe-mode also drops --mcp-config servers, so library turns rely on
  // --strict-mcp-config alone to keep precut as the only server.
  const isolation = ["--strict-mcp-config", "--disable-slash-commands", ...(input.libraryConnection ? [] : ["--safe-mode"]),
    ...(await cliSupports(bin, ["--help"], "--no-session-persistence") ? ["--no-session-persistence"] : [])];
  if (input.images.length) {
    const content: Record<string, unknown>[] = [{ type: "text", text: input.prompt }];
    for (const file of input.images) {
      const extension = path.extname(file).toLowerCase();
      const mediaType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
      content.push({ type: "image", source: { type: "base64", media_type: mediaType,
        data: (await fs.promises.readFile(path.resolve(input.cwd, file))).toString("base64") } });
    }
    const extraTools = [...new Set((input.extraReadOnlyTools ?? []).filter(tool => SIDEKICK_READ_ONLY_TOOLS.includes(tool)))];
    const args = ["-p", ...isolation, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--allowedTools", ["Read", ...extraTools, ...(input.libraryConnection ? LIBRARY_READ_TOOLS.map(name => `mcp__precut__${name}`) : [])].join(","), "--tools", extraTools.includes("WebFetch") ? "Read,WebFetch" : "Read",
      "--permission-mode", "dontAsk", "--add-dir", path.join(input.cwd, ".sidething")];
    if (input.libraryConnection) args.push("--mcp-config", input.libraryConnection.config);
    if (input.model) args.push("--model", input.model);
    const invoke = async (parts: Record<string, unknown>[][]) => {
      const stdinText = parts.map(part => JSON.stringify({ type: "user", message: { role: "user", content: part } })).join("\n") + "\n";
      console.info(`[ai] Claude images: direct (${input.images.length} sheets, ${parts.length} message, ${Buffer.byteLength(stdinText)} bytes)`);
      const result = await runChild(bin, args, { cwd: input.cwd, env: subscriptionEnv(), stdinText,
        signal: input.signal, timeoutMs: input.timeoutMs });
      const events = result.stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const final = events.filter(event => event.type === "result").at(-1);
      return { ...result, final, error: `${result.stderr}\n${result.stdout}` };
    };
    let result = await invoke([content]);
    // Retry transport rejection only. A model error/auth/timeout is never a reason
    // to silently spend another whole-shoot turn through a different transport.
    const tooLarge = (text: string) => /(?:message|request|payload|image).{0,60}(?:too large|size limit)|too many images|maximum.{0,30}images|413/i.test(text);
    if ((result.code !== 0 || result.final?.is_error) && tooLarge(result.error) && input.images.length > 1) {
      const middle = 1 + Math.ceil(input.images.length / 2);
      // The full judging instructions belong to the final batch, so the first
      // half cannot accidentally become a partial whole-shoot judgement.
      result = await invoke([
        [{ type: "text", text: "Contact sheets, part 1 of 2. Wait for the remaining images and instructions before judging." }, ...content.slice(1, middle)],
        [content[0], ...content.slice(middle)],
      ]);
    }
    if (result.code === 0 && result.final?.is_error !== true && typeof result.final?.result === "string") return result.final.result;
    if (!/(?:unknown|unrecognized|invalid|unsupported).{0,80}(?:input-format|stream-json|image|media_type)|(?:image|stream-json).{0,80}(?:not supported|rejected)|requires.{0,50}stream-json/i.test(result.error) && !tooLarge(result.error)) {
      throw await engineStopped("claude", bin, input.cwd, typeof result.final?.result === "string" ? result.final.result : result.stderr);
    }
    console.warn("[ai] Claude images: Read fallback (CLI rejected direct images)");
  } else {
    console.info("[ai] Claude images: text only");
  }
  let prompt = input.prompt;
  if (input.images.length > 0) {
    const list = input.images.map((p) => `- ${p}`).join("\n");
    prompt +=
      `\n\nContact-sheet images are saved on disk. Read every one of them ` +
      `with the Read tool before answering:\n${list}\n`;
  }
  const env = subscriptionEnv();
  const addDir = path.join(input.cwd, ".sidething");
  // Filter at runtime too, so an untyped caller cannot grant a writing tool.
  const extraTools = [...new Set((input.extraReadOnlyTools ?? []).filter((tool) =>
    SIDEKICK_READ_ONLY_TOOLS.includes(tool)))];
  const allowedTools = ["Read", ...extraTools, ...(input.libraryConnection ? LIBRARY_READ_TOOLS.map(name => `mcp__precut__${name}`) : [])];
  const args = ["-p", ...isolation, "--output-format", "json", "--allowedTools", allowedTools.join(","), "--add-dir", addDir];
  if (input.model) args.push("--model", input.model);
  if (input.libraryConnection) args.push("--mcp-config", input.libraryConnection.config);
  if (extraTools.length || input.libraryConnection) {
    // Keep command and editing tools unavailable, including with local approvals.
    args.push("--tools", extraTools.includes("WebFetch") ? "Read,WebFetch" : "Read", "--permission-mode", "dontAsk");
  }
  const { code, stdout, stderr } = await runChild(
    bin,
    args,
    { cwd: input.cwd, env, stdinText: prompt, signal: input.signal, timeoutMs: input.timeoutMs ?? (extraTools.length ? TIMEOUT_MS + 2 * 60_000 : TIMEOUT_MS) },
  );
  let parsed: { result?: unknown; is_error?: unknown } | null = null;
  try {
    parsed = JSON.parse(stdout) as { result?: unknown; is_error?: unknown };
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed.result !== "string") {
    if (code !== 0) throw await engineStopped("claude", bin, input.cwd, stderr);
    throw new Error(ENGINE_ERRORS.invalidJson);
  }
  if (parsed.is_error === true || code !== 0) throw await engineStopped("claude", bin, input.cwd, parsed.result || stderr);
  return parsed.result;
}

async function runCodex(input: ModelInput): Promise<string> {
  const bin = await resolveBinary("codex");
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sidething-codex-"));
  const lastMessage = path.join(tmp, "last-message.txt");
  const cwd = path.join(path.resolve(input.cwd), ".sidething");
  const env = subscriptionEnv();
  // Force the subscription provider even if the CLI has an API provider configured.
  const args = ["exec", "--json", "-o", lastMessage, "-s", "read-only", "-C", cwd,
    ...(await cliSupports(bin, ["exec", "--help"], "--ephemeral") ? ["--ephemeral"] : []), "--skip-git-repo-check", "-c", 'model_provider="openai"', "-c", 'forced_login_method="chatgpt"',
    "-c", input.extraReadOnlyTools?.includes("WebFetch") ? 'web_search="live"' : 'web_search="disabled"'];
  if (input.model) args.push("--model", input.model);
  if (input.libraryConnection) args.push("-c", `mcp_servers.precut=${toml({ ...input.libraryConnection.connection, enabled_tools: LIBRARY_READ_TOOLS })}`);
  for (const image of input.images) args.push("-i", path.resolve(input.cwd, image));
  args.push("-");
  try {
    await fs.promises.mkdir(cwd, { recursive: true });
    const { code, stdout, stderr } = await runChild(bin, args, {
      cwd, env, stdinText: input.prompt, signal: input.signal,
      timeoutMs: input.timeoutMs ?? (input.extraReadOnlyTools?.includes("WebFetch") ? TIMEOUT_MS + 2 * 60_000 : TIMEOUT_MS),
    });
    if (code !== 0) throw await engineStopped("codex", bin, input.cwd, stderr);
    const text = await fs.promises.readFile(lastMessage, "utf8").catch(() => "");
    if (!text.trim()) throw new Error("Codex returned no answer. Try again.");
    return text;
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

// Muse JSONL shape (from a real `muse exec --json` run): one JSON object
// per line with payload_type/payload. The final assistant text is the `text`
// field of the `run.terminal.completed` event (payload.kind "run_terminal");
// `run.output.delta` events carry streamed chunks as a fallback.
function museFinalText(stdout: string): string | null {
  let terminal: string | null = null;
  const deltas: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: { payload_type?: string; payload?: { kind?: string; text?: string } };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const payload = event.payload ?? {};
    if (event.payload_type === "run.terminal.completed" && typeof payload.text === "string") {
      terminal = payload.text;
    } else if (event.payload_type === "run.output.delta" && typeof payload.text === "string") {
      deltas.push(payload.text);
    }
  }
  if (terminal !== null && terminal.trim() !== "") return terminal;
  if (deltas.length > 0) return deltas.join("");
  return null;
}

async function runMuse(input: ModelInput): Promise<string> {
  const bin = await resolveBinary("muse");
  const tmp = path.join(
    os.tmpdir(),
    `sidething-judge-${process.pid}-${Date.now()}.txt`,
  );
  await fs.promises.writeFile(tmp, input.prompt, "utf8");
  try {
    const args = ["exec", "--json", "--prompt-file", tmp];
    for (const image of input.images) args.push("--image", image);
    const env = { ...process.env };
    delete env.META_API_KEY;
    const { code, stdout, stderr } = await runChild(bin, args, {
      cwd: input.cwd,
      env,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });
    const text = museFinalText(stdout);
    if (text === null) {
      if (code !== 0) throw await engineStopped("muse", bin, input.cwd, stderr);
      throw new Error(ENGINE_ERRORS.invalidJson);
    }
    return text;
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

export async function runModel(input: RunModelInput): Promise<string> {
  // ONB2: "Start without AI" means no model call at all, from any feature, the CLI or MCP.
  if ((appSettings as { aiOff?: () => boolean }).aiOff?.()) {
    console.info("[ai] model call refused: no AI chosen");
    throw new Error(ENGINE_ERRORS.noEngine);
  }
  console.info(`[ai] model call: ${input.engine}`);
  try {
    const answer = await runModelNow(input);
    if (lastProblem?.engine === input.engine) lastProblem = null;
    return answer;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const problem = engineProblemOf(message);
    if (problem) lastProblem = { engine: input.engine, problem, message, at: Date.now() };
    throw error;
  }
}

async function runModelNow(input: RunModelInput): Promise<string> {
  const signal = input.signal ?? currentActivity()?.signal;
  signal?.throwIfAborted();
  const configured: ModelInput = { ...input, libraryConnection: undefined, signal, model: input.model === undefined ? await getEngineModel(input.engine) : input.model };
  // REL2: Settings, Privacy, "AI sees frames" off means no picture reaches the engine from any feature: attached stills
  // and contact sheets are withheld here, and look_at is left out of the library tools.
  const seesFrames = (await getPreferences().catch(() => null))?.aiSeesFrames !== false;
  if (!seesFrames) configured.images = [];
  const readTools = seesFrames ? LIBRARY_READ_TOOLS : LIBRARY_READ_TOOLS.filter(name => name !== "look_at");
  console.info(`[ai] pictures: ${configured.images.length}${seesFrames ? "" : ` (AI sees frames is off; ${input.images.length} withheld)`}`);
  let cleanup: (() => Promise<void>) | undefined;
  try {
    // Installed Muse rejects Ask's MCP server shape in config validation.
    // Callers retain their original context for it until native MCP is verified.
    if (input.libraryTools && input.engine !== "muse") {
      const { app } = await import("electron");
      const { createAskBridge } = await import("./chat");
      const bridge = await createAskBridge(input.cwd, () => ({}), readTools);
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "precut-model-tools-")).catch(error => { bridge.close(); throw error; });
      cleanup = async () => { bridge.close(); await fs.promises.rm(directory, { recursive: true, force: true }); };
      const command = app.isPackaged ? path.join(process.resourcesPath, "precut") : path.join(app.getAppPath(), "build/precut");
      const connection = { command, args: ["--mcp"], env: { PRECUT_TERMINAL_BRIDGE: bridge.url, PRECUT_TERMINAL_TOKEN: bridge.token, PRECUT_MODEL_TOOLS: JSON.stringify(readTools) } };
      const config = path.join(directory, "mcp.json");
      await fs.promises.writeFile(config, JSON.stringify({ mcpServers: { precut: connection } }), { mode: 0o600, flag: "wx" });
      configured.libraryConnection = { config, connection };
      signal?.throwIfAborted();
    }
    switch (input.engine) {
      case "claude": return await runClaude(configured);
      case "codex": return await runCodex(configured);
      case "muse": return await runMuse(configured);
      default: throw new Error("Choose Claude Code, Codex or Muse in Settings.");
    }
  } finally {
    await cleanup?.();
  }
}

// Models sometimes wrap JSON in a code fence or a sentence. One tolerant reader for
// every caller: a fenced block first, else the outermost {...}, else the raw text.
export function parseModelJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const text = (fenced ?? raw).trim();
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error("No JSON in the model's reply.");
}
