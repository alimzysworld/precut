// Persistent interactive CLI sessions. Renderer input is always written verbatim.
import * as pty from "node-pty";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { resolveBinary, subscriptionEnv, type Engine } from "./ai";
import { getEngine, getEngineModel } from "./settings";
import { ASK_RULES, createAskBridge, type AskBridge } from "./chat";
import type { AskScreenContext } from "./sidekick-context";

export type TerminalRequest = { root: string; cutId?: string; version?: number; cols: number; rows: number; context?: AskScreenContext };
export type TerminalEvent = { id: string; sequence: number; data?: string; exitCode?: number };
export type TerminalSnapshot = { id: string; engine: Engine; sequence: number; output: string; exitCode?: number };
type Session = { id: string; owner: number; root: string; cutId?: string; engine: Engine; context: AskScreenContext;
  pty: pty.IPty; bridge: AskBridge; directory: string; output: string; sequence: number; exitCode?: number };
const sessions = new Map<number, Session>();
const queues = new Map<number, Promise<unknown>>();
let forward: (owner: number, event: TerminalEvent) => void = () => {};
export function setTerminalForwarder(fn: typeof forward): void { forward = fn; }
const snapshot = (s: Session): TerminalSnapshot => ({ id: s.id, engine: s.engine, sequence: s.sequence, output: s.output, exitCode: s.exitCode });
const toml = (value: unknown): string => typeof value === "object" && value !== null && !Array.isArray(value)
  ? `{ ${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)} = ${toml(entry)}`).join(", ")} }` : JSON.stringify(value);

export function engineArguments(engine: Engine, config: string, connection: { command: string; args: string[]; env: Record<string, string> }, model: string | null): string[] {
  const args = engine === "claude"
    ? ["--mcp-config", config, "--append-system-prompt", ASK_RULES]
    : engine === "codex"
      ? ["-c", `mcp_servers.precut=${toml(connection)}`, "-c", `developer_instructions=${toml(ASK_RULES)}`, "--sandbox", "read-only", "--ask-for-approval", "on-request"]
      : ["-c", `mcp_servers.precut=${JSON.stringify({ ...connection, transport: "stdio" })}`, "-c", `run.system_prompt=${JSON.stringify(ASK_RULES)}`];
  if (model) args.push("--model", model);
  return args;
}

// A second, OS-enforced boundary protects media even after a native CLI tool
// approval. MCP runs in the app process and remains the only writer to edits.
// `siblings` are files whose name starts with the path (an engine's atomic temp and lock files, e.g. ~/.claude.json.tmp.*).
export function terminalSandbox(root: string, writable: string[], siblings: string[] = []): string {
  const subpath = (value: string) => `(subpath ${JSON.stringify(value)})`;
  const sibling = (value: string) => `(regex ${JSON.stringify("^" + value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.[^/]*$")})`;
  return `(version 1) (allow default)\n(deny file-write* (require-all (require-not (require-any ${writable.map(subpath).join(" ")} ${siblings.map(sibling).join(" ")} (literal "/dev/tty") (literal "/dev/null") (subpath "/dev/fd"))) ))\n(deny file-write* ${subpath(root)})`;
}
function size(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 1000 || rows < 1 || rows > 500) throw new Error("Invalid terminal size.");
}
function owned(owner: number, id: string): Session {
  const session = sessions.get(owner);
  if (!session || session.id !== id) throw new Error("This Ask session has ended.");
  return session;
}
function serial<T>(owner: number, operation: () => Promise<T>): Promise<T> {
  const next = (queues.get(owner) ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(owner, next);
  void next.finally(() => { if (queues.get(owner) === next) queues.delete(owner); }).catch(() => {});
  return next;
}
async function stop(owner: number): Promise<void> {
  const session = sessions.get(owner);
  if (!session) return;
  sessions.delete(owner);
  session.bridge.close();
  try { process.kill(-session.pty.pid, "SIGKILL"); } catch { try { session.pty.kill("SIGKILL"); } catch { /* already exited */ } }
  await fs.rm(session.directory, { recursive: true, force: true });
}
async function open(owner: number, input: TerminalRequest): Promise<TerminalSnapshot> {
  size(input.cols, input.rows);
  const root = await fs.realpath(input.root);
  if (!(await fs.stat(root)).isDirectory()) throw new Error("Choose a shoot folder.");
  const current = sessions.get(owner);
  // Reattachment never re-runs CLI discovery, changes the model or spawns a pty.
  if (current?.root === root) {
    current.cutId = input.cutId;
    current.context = { ...input.context, cutId: input.cutId, version: input.version };
    if (current.exitCode === undefined) current.pty.resize(input.cols, input.rows);
    return snapshot(current);
  }
  await stop(owner);
  // ONB2: "Start without AI" opens no engine, Ask included.
  if (((await import("./settings")) as { aiOff?: () => boolean }).aiOff?.()) throw new Error("No AI chosen. Add one in Settings to use Ask.");
  const engine = await getEngine();
  if (!engine) throw new Error("Choose Claude Code, Codex or Muse in Settings.");
  if (process.platform !== "darwin") throw new Error("Ask needs this Mac's protected terminal.");
  const [binary, model] = await Promise.all([resolveBinary(engine), getEngineModel(engine)]);
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "precut-ask-"));
  let context = { ...input.context, cutId: input.cutId, version: input.version };
  let session: Session | undefined;
  let bridge: AskBridge | undefined;
  try {
    bridge = await createAskBridge(root, () => session?.context ?? context);
    const command = app.isPackaged ? path.join(process.resourcesPath, "precut") : path.join(app.getAppPath(), "build/precut");
    const connection = { command, args: ["--mcp"], env: { PRECUT_TERMINAL_BRIDGE: bridge.url, PRECUT_TERMINAL_TOKEN: bridge.token } };
    const config = path.join(directory, "mcp.json");
    await fs.writeFile(config, JSON.stringify({ mcpServers: { precut: connection } }), { mode: 0o600, flag: "wx" });
    const home = os.homedir();
    const writable = [directory, path.join(home, ".claude"), path.join(home, ".claude.json"), path.join(home, ".codex"), path.join(home, ".config/muse"), path.join(home, ".local/share/muse"), path.join(home, "Library/Caches")];
    const profile = path.join(directory, "media.sb");
    // Claude Code saves folder trust through ~/.claude.json.tmp.*; without it the trust question returns every session.
    await fs.writeFile(profile, terminalSandbox(root, writable, [path.join(home, ".claude.json")]), { mode: 0o600, flag: "wx" });
    const env: NodeJS.ProcessEnv = { ...subscriptionEnv(), TERM: "xterm-256color", COLORTERM: "truecolor", TMPDIR: directory + path.sep, PRECUT_ASK: "1" };
    // Never inherit the host's Electron mode or an unrelated Ask connection.
    delete env.ELECTRON_RUN_AS_NODE;
    const child = pty.spawn("/usr/bin/sandbox-exec", ["-f", profile, binary, ...engineArguments(engine, config, connection, model)], {
      cwd: root, env, name: "xterm-256color", cols: input.cols, rows: input.rows,
    });
    session = { id: randomUUID(), owner, root, cutId: input.cutId, engine, context, pty: child, bridge, directory, output: "", sequence: 0 };
    const running = session;
    sessions.set(owner, running);
    child.onData(data => {
      if (sessions.get(owner) !== running) return;
      running.output = (running.output + data).slice(-1024 * 1024);
      forward(owner, { id: running.id, sequence: ++running.sequence, data });
    });
    child.onExit(({ exitCode }) => {
      if (sessions.get(owner) !== running) return;
      running.exitCode = exitCode;
      running.bridge.close();
      forward(owner, { id: running.id, sequence: ++running.sequence, exitCode });
    });
    return snapshot(running);
  } catch (error) {
    bridge?.close();
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export const terminalOpen = (owner: number, input: TerminalRequest) => serial(owner, () => open(owner, input));
export const terminalRestart = (owner: number, id: string, input: TerminalRequest) => serial(owner, async () => { owned(owner, id); await stop(owner); return open(owner, input); });
export function terminalWrite(owner: number, id: string, data: string): void {
  if (typeof data !== "string" || data.length > 256 * 1024) throw new Error("Terminal input is too large.");
  const session = owned(owner, id);
  if (session.exitCode !== undefined) throw new Error("Restart Ask to continue.");
  session.pty.write(data);
}
export function terminalResize(owner: number, id: string, cols: number, rows: number): void { size(cols, rows); const session = owned(owner, id); if (session.exitCode === undefined) session.pty.resize(cols, rows); }
export function terminalContext(owner: number, id: string, context: AskScreenContext): void {
  const session = owned(owner, id);
  session.cutId = context.cutId;
  session.context = { ...context };
}
export const terminalClose = (owner: number) => serial(owner, () => stop(owner));
export function closeAllTerminals(): void { for (const owner of new Set([...sessions.keys(), ...queues.keys()])) void terminalClose(owner); }
