// Engine adapter: one AI call through the person's logged-in CLI.
// Claude Code: `claude -p --output-format json`, prompt on stdin, Read by
// default, with optional read-only reference tools. Muse: `muse exec --json` with a
// prompt file and native --image attachments. No API keys are ever set or read.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Engine = "claude" | "muse";

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

export interface RunModelInput {
  engine: Engine;
  prompt: string;
  images: string[];
  cwd: string;
  extraReadOnlyTools?: readonly ReadOnlyTool[];
}

const TIMEOUT_MS = 5 * 60 * 1000;

const ERR = {
  claudeNotInstalled: "Claude Code isn't installed",
  claudeNotSignedIn: "Claude Code isn't signed in. In Terminal run: claude login",
  museNotInstalled: "Muse isn't installed",
  museNotSignedIn: "Muse isn't signed in",
  invalidJson: "the model's answer wasn't valid JSON",
} as const;

function looksLikeAuthProblem(text: string): boolean {
  return /not (logged|signed) in|please (log|sign) in|run:?\s*claude login|unauthori[sz]ed|authentication|auth required|sign in/i.test(text);
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
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out));
  });
}

// Electron apps do not inherit the terminal PATH, so after the process PATH
// search, ask the login shell: first `command -v`, then its own $PATH dirs.
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

const binCache = new Map<string, string>();
async function resolveBinary(name: "claude" | "muse"): Promise<string> {
  const cached = binCache.get(name);
  if (cached) return cached;
  const found = resolveOnPath(name) ?? (await resolveViaLoginShell(name));
  if (!found) {
    throw new Error(name === "claude" ? ERR.claudeNotInstalled : ERR.museNotInstalled);
  }
  binCache.set(name, found);
  return found;
}

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runChild(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdinText?: string; timeoutMs?: number },
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
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
    if (opts.stdinText !== undefined) {
      child.stdin?.write(opts.stdinText);
    }
    child.stdin?.end();
  });
}

async function runClaude(input: RunModelInput): Promise<string> {
  const bin = await resolveBinary("claude");
  let prompt = input.prompt;
  if (input.images.length > 0) {
    const list = input.images.map((p) => `- ${p}`).join("\n");
    prompt +=
      `\n\nContact-sheet images are saved on disk. Read every one of them ` +
      `with the Read tool before answering:\n${list}\n`;
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_BASE_URL;
  const addDir = path.join(input.cwd, ".sidething");
  // Filter at runtime too, so an untyped caller cannot grant a writing tool.
  const extraTools = [...new Set((input.extraReadOnlyTools ?? []).filter((tool) =>
    SIDEKICK_READ_ONLY_TOOLS.includes(tool)))];
  const allowedTools = ["Read", ...extraTools];
  const args = ["-p", "--output-format", "json", "--allowedTools", allowedTools.join(","), "--add-dir", addDir];
  if (extraTools.length) {
    // Keep command and editing tools unavailable, including with local approvals.
    args.push("--tools", extraTools.includes("WebFetch") ? "Read,WebFetch" : "Read", "--permission-mode", "dontAsk");
  }
  const { code, stdout, stderr } = await runChild(
    bin,
    args,
    { cwd: input.cwd, env, stdinText: prompt, timeoutMs: extraTools.length ? TIMEOUT_MS + 2 * 60_000 : TIMEOUT_MS },
  );
  let parsed: { result?: unknown; is_error?: unknown } | null = null;
  try {
    parsed = JSON.parse(stdout) as { result?: unknown; is_error?: unknown };
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed.result !== "string") {
    if (looksLikeAuthProblem(stdout + "\n" + stderr)) {
      throw new Error(ERR.claudeNotSignedIn);
    }
    if (code !== 0) throw new Error(ERR.claudeNotSignedIn);
    throw new Error(ERR.invalidJson);
  }
  if (parsed.is_error === true || code !== 0) {
    if (looksLikeAuthProblem(parsed.result + "\n" + stderr)) {
      throw new Error(ERR.claudeNotSignedIn);
    }
    throw new Error(ERR.claudeNotSignedIn);
  }
  return parsed.result;
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

async function runMuse(input: RunModelInput): Promise<string> {
  const bin = await resolveBinary("muse");
  const tmp = path.join(
    os.tmpdir(),
    `sidething-judge-${process.pid}-${Date.now()}.txt`,
  );
  await fs.promises.writeFile(tmp, input.prompt, "utf8");
  try {
    const args = ["exec", "--json", "--prompt-file", tmp];
    for (const image of input.images) args.push("--image", image);
    const { code, stdout, stderr } = await runChild(bin, args, {
      cwd: input.cwd,
      env: { ...process.env },
    });
    const text = museFinalText(stdout);
    if (text === null) {
      if (looksLikeAuthProblem(stdout + "\n" + stderr)) {
        throw new Error(ERR.museNotSignedIn);
      }
      if (code !== 0) throw new Error(ERR.museNotSignedIn);
      throw new Error(ERR.invalidJson);
    }
    if (code !== 0 && looksLikeAuthProblem(text + "\n" + stderr)) {
      throw new Error(ERR.museNotSignedIn);
    }
    return text;
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

export async function runModel(input: RunModelInput): Promise<string> {
  return input.engine === "claude" ? runClaude(input) : runMuse(input);
}
