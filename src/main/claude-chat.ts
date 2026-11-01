// CH3: Claude's pane. The person's own, unmodified Claude Code as one long-lived process per window:
//   claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --session-id <uuid>
// with precut's MCP server added (their own servers still load: no --strict-mcp-config), Ask's rules, the model and
// permission mode, and precut's permission prompt tool. API keys are stripped (subscriptionEnv), never --bare, and the
// login is never read: Claude Code signs itself in. Esc is SIGINT (the turn ends, the process stays); a crash or a
// permission-mode switch comes back with --resume <id>. The renderer draws the events (shared/claude-chat.ts).
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { resolveBinary, subscriptionEnv, engineSignedIn, type Engine } from "./ai";
import { getEngine, getEngineModel } from "./settings";
import { createAskBridge, type AskBridge } from "./chat";
import { engineArguments, terminalSandbox } from "./terminal";
import { MCP_TOOLS } from "./mcp";
import type { AskScreenContext } from "./sidekick-context";
import { parseStreamLine, userLine, type ChatEvent, type ChatWire, type ChatProblem } from "../shared/claude-chat";

export type ChatRequest = { root: string; cutId?: string; version?: number; context?: AskScreenContext };
/** engine is not "claude": the pane keeps the terminal (Codex and Muse stay terminals for now). */
export type ChatSnapshot = { id: string; engine: Engine; sessionId: string; sequence: number; events: ChatWire[] };
export type SavedChat = { id: string; title: string; at: number };
type Waiting = { promise: Promise<unknown>; resolve: (answer: unknown) => void; input: Record<string, unknown>; answered?: boolean };
type Session = { id: string; owner: number; root: string; context: AskScreenContext; bridge: AskBridge; directory: string; config: string; profile: string;
  connection: { command: string; args: string[]; env: Record<string, string> }; binary: string | null; model: string | null; mode: string | null;
  sessionId: string; saved: boolean; child?: ChildProcess; alive: boolean; expectedExit: boolean; running: boolean; wantMode?: string;
  events: ChatWire[]; sequence: number; waiting: Map<string, Waiting>; stderr: string; title?: string; files?: { at: number; list: string[] } };

const sessions = new Map<number, Session>();
const queues = new Map<number, Promise<unknown>>();
let forward: (owner: number, event: ChatWire) => void = () => {};
export function setClaudeForwarder(fn: typeof forward): void { forward = fn; }
// A permission ask waits on the person; the bridge answers "still waiting" well inside fetch's five minute header timeout.
const PERMISSION_POLL_MS = Number(process.env.PRECUT_PERMISSION_POLL_MS) || 240_000;
const COMMANDS = /^\/(model|effort|fast)(\s|$)/;   // settings commands: Claude Code answers each in one line
// POLISH1: precut's own tools never ask. Every precut write is one saved, undoable version inside the shoot's .sidething
// (originals are never touched), so a permission prompt for each read or edit only got in the way, in any mode ("accept
// edits" covers file edits, not MCP calls). Installing or removing an extension (code from elsewhere) still asks, as do
// Claude Code's own tools (Bash, file writes) and every other MCP server.
const STILL_ASK = new Set(["install_extension", "remove_extension", "permission_prompt"]);
export const PRECUT_ALLOWED = MCP_TOOLS.map(tool => tool.name).filter(name => !STILL_ASK.has(name)).map(name => `mcp__precut__${name}`);
const preAllowed = new Set(PRECUT_ALLOWED);

function serial<T>(owner: number, operation: () => Promise<T>): Promise<T> {
  const next = (queues.get(owner) ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(owner, next);
  void next.finally(() => { if (queues.get(owner) === next) queues.delete(owner); }).catch(() => {});
  return next;
}
function owned(owner: number, id: string): Session {
  const session = sessions.get(owner);
  if (!session || session.id !== id) throw new Error("This chat has ended. Open Claude again.");
  return session;
}
const snapshot = (s: Session): ChatSnapshot => ({ id: s.id, engine: "claude", sessionId: s.sessionId, sequence: s.sequence, events: s.events.slice() });

function emit(session: Session, event: ChatEvent): void {
  const wire = { ...event, id: session.id, sequence: ++session.sequence } as ChatWire;
  // A finished block supersedes its streamed pieces, so a reattach replays the block, not every delta.
  if (event.kind === "text") session.events = session.events.filter(e => !(e.kind === "delta" && e.message === event.message));
  session.events.push(wire);
  if (session.events.length > 4000) session.events.splice(0, session.events.length - 4000);
  forward(session.owner, wire);
}

// ---------- Earlier chats, for /resume: precut's own list of the chats it started in this shoot. ----------
const store = () => path.join(app.getPath("userData"), "claude-chats");
async function readIndex(): Promise<Record<string, SavedChat[]>> {
  try { return JSON.parse(await fs.readFile(path.join(store(), "index.json"), "utf8")) as Record<string, SavedChat[]>; } catch { return {}; }
}
async function save(session: Session): Promise<void> {
  if (!session.saved || !session.title) return;
  try {
    await fs.mkdir(store(), { recursive: true });
    const index = await readIndex();
    const list = (index[session.root] ?? []).filter(chat => chat.id !== session.sessionId);
    index[session.root] = [{ id: session.sessionId, title: session.title, at: Date.now() }, ...list].slice(0, 30);
    const kept = session.events.filter(e => !["delta", "thinking", "tool-start", "problem", "exit", "retry"].includes(e.kind));
    await fs.writeFile(path.join(store(), `${session.sessionId}.json`), JSON.stringify(kept.slice(-1500)));
    await fs.writeFile(path.join(store(), "index.json"), JSON.stringify(index));
  } catch (error) { console.warn("[claude] couldn't save the chat:", error); }
}

// ---------- The process ----------
function release(session: Session, answer: unknown): void {
  for (const [request, waiting] of session.waiting) if (!waiting.answered) { waiting.answered = true; waiting.resolve(answer); emit(session, { kind: "answered", request, allow: false }); }
}
async function kill(session: Session): Promise<void> {
  const child = session.child;
  if (!child || !session.alive) return;
  session.expectedExit = true;
  release(session, { behavior: "deny", message: "The chat closed." });
  session.waiting.clear();
  const gone = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 2000);
  await gone; clearTimeout(timer);
}
async function problemOf(session: Session): Promise<ChatProblem | null> {
  try { session.binary = await resolveBinary("claude"); } catch { session.binary = null; return "not-installed"; }
  // The engine's own status command, from precut's empty folder (never the home folder): no model turn.
  const cwd = path.join(app.getPath("userData"), "engine-probe");
  await fs.mkdir(cwd, { recursive: true });
  return await engineSignedIn("claude", session.binary, cwd) === false ? "signed-out" : null;
}
function start(session: Session): void {
  const resume = session.saved;
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    ...(resume ? ["--resume", session.sessionId] : ["--session-id", session.sessionId]),
    ...engineArguments("claude", session.config, session.connection, session.model),
    "--allowedTools", PRECUT_ALLOWED.join(","),
    "--permission-prompt-tool", "mcp__precut__permission_prompt", ...(session.mode ? ["--permission-mode", session.mode] : [])];
  const env: NodeJS.ProcessEnv = { ...subscriptionEnv(), TMPDIR: session.directory + path.sep, PRECUT_ASK: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn("/usr/bin/sandbox-exec", ["-f", session.profile, session.binary!, ...args], { cwd: session.root, env, stdio: ["pipe", "pipe", "pipe"] });
  session.child = child; session.alive = true; session.expectedExit = false; session.stderr = "";
  child.stdin!.on("error", () => {});
  let buffer = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    if (session.child !== child) return;
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      for (const event of parseStreamLine(value)) receive(session, event);
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { session.stderr = (session.stderr + chunk).slice(-4096); });
  child.once("exit", (code, signal) => {
    if (session.child !== child) return;
    session.alive = false; session.child = undefined;
    release(session, { behavior: "deny", message: "Claude Code stopped." });
    session.waiting.clear();
    const expected = session.expectedExit;
    if (!expected && session.stderr.trim()) emit(session, { kind: "notice", text: session.stderr.trim().split("\n").filter(Boolean).at(-1)!.slice(0, 240), tone: "problem" });
    session.running = false;
    emit(session, { kind: "exit", code, signal, expected });
  });
  child.once("error", error => { if (session.child === child) emit(session, { kind: "notice", text: `Claude Code couldn't start: ${error.message}`, tone: "problem" }); });
  // The Agent SDK's opening request: Claude Code answers with its models and commands. Not seen live yet; without an
  // answer the pane falls back to Claude Code's model aliases and its documented commands.
  child.stdin!.write(JSON.stringify({ type: "control_request", request_id: `precut-${randomUUID()}`, request: { subtype: "initialize" } }) + "\n");
}
function receive(session: Session, event: ChatEvent): void {
  if (event.kind === "init") {
    if (event.sessionId) session.sessionId = event.sessionId;
    session.saved = true;
    if (event.model) session.model = event.model;
    session.mode = event.permissionMode || session.mode;
  }
  emit(session, event);
  if (event.kind === "result") {
    session.running = false;
    void save(session);
    if (session.wantMode && session.wantMode !== session.mode) void serial(session.owner, () => switchMode(session));
    else if (!event.ok && !event.interrupted) void problemOf(session).then(problem => { if (problem) emit(session, { kind: "problem", problem }); });
  }
}
async function switchMode(session: Session): Promise<void> {
  if (sessions.get(session.owner) !== session || !session.wantMode) return;
  session.mode = session.wantMode; session.wantMode = undefined;
  await kill(session);
  if (session.binary) start(session);
}

async function open(owner: number, input: ChatRequest): Promise<ChatSnapshot> {
  const root = await fs.realpath(input.root);
  if (!(await fs.stat(root)).isDirectory()) throw new Error("Choose a shoot folder.");
  const current = sessions.get(owner);
  const context = { ...input.context, cutId: input.cutId, version: input.version };
  // Reattaching (Claude hidden and shown, a page switch, another edit in the same shoot) keeps the process and the chat.
  if (current?.root === root) { current.context = context; return snapshot(current); }
  await close(owner);
  if (((await import("./settings")) as { aiOff?: () => boolean }).aiOff?.()) throw new Error("Choose Claude Code or Codex in Settings to use Claude.");
  const engine = await getEngine();
  if (engine !== "claude") return { id: "", engine, sessionId: "", sequence: 0, events: [] };
  if (process.platform !== "darwin") throw new Error("Claude needs this Mac's protected sandbox.");
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "precut-claude-"));
  let session: Session | undefined, bridge: AskBridge | undefined;
  try {
    bridge = await createAskBridge(root, () => session?.context ?? context, undefined, args => permission(session!, args));
    const command = app.isPackaged ? path.join(process.resourcesPath, "precut") : path.join(app.getAppPath(), "build/precut");
    const connection = { command, args: ["--mcp"], env: { PRECUT_TERMINAL_BRIDGE: bridge.url, PRECUT_TERMINAL_TOKEN: bridge.token } };
    const config = path.join(directory, "mcp.json"), profile = path.join(directory, "media.sb");
    await fs.writeFile(config, JSON.stringify({ mcpServers: { precut: connection } }), { mode: 0o600, flag: "wx" });
    const home = os.homedir();
    const writable = [directory, path.join(home, ".claude"), path.join(home, ".claude.json"), path.join(home, "Library/Caches")];
    // The same media boundary as the terminal: Claude Code may write its own state, never the shoot.
    await fs.writeFile(profile, terminalSandbox(root, writable, [path.join(home, ".claude.json")]), { mode: 0o600, flag: "wx" });
    session = { id: randomUUID(), owner, root, context, bridge, directory, config, profile, connection, binary: null, model: await getEngineModel("claude"), mode: null,
      sessionId: randomUUID(), saved: false, alive: false, expectedExit: false, running: false, events: [], sequence: 0, waiting: new Map(), stderr: "" };
    sessions.set(owner, session);
    // POLISH1: the model chip names a model before the first turn (read from files only, never a model call).
    const opened = session;
    void defaultModel(opened.model).then(known => { if (known && sessions.get(owner) === opened) emit(opened, { kind: "default-model", ...known }); });
    const problem = await problemOf(session);
    if (problem) emit(session, { kind: "problem", problem }); else start(session);
    return snapshot(session);
  } catch (error) {
    if (session && sessions.get(owner) === session) sessions.delete(owner);
    bridge?.close();
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
/** What Claude Code will run before it says: precut's own model setting, then Claude Code's settings ("model"), then the
 * model of the newest session it saved. Files only, never a model call; null when none says. */
export async function defaultModel(own: string | null, home = app.getPath("home")): Promise<{ model: string; from: "settings" | "last" } | null> {
  if (own) return { model: own, from: "settings" };
  for (const file of ["settings.json", "settings.local.json"]) {
    try {
      const value = (JSON.parse(await fs.readFile(path.join(home, ".claude", file), "utf8")) as { model?: unknown }).model;
      if (typeof value === "string" && value.trim()) return { model: value.trim(), from: "settings" };
    } catch { /* no settings, or not this key */ }
  }
  try {
    const projects = path.join(home, ".claude", "projects");
    const newest = async (dir: string, pick: (name: string, dirent: import("node:fs").Dirent) => boolean) => {
      const entries = (await fs.readdir(dir, { withFileTypes: true })).filter(entry => pick(entry.name, entry));
      const dated = await Promise.all(entries.map(async entry => ({ file: path.join(dir, entry.name), at: (await fs.stat(path.join(dir, entry.name)).catch(() => null))?.mtimeMs ?? 0 })));
      return dated.sort((a, b) => b.at - a.at);
    };
    for (const folder of (await newest(projects, (_, entry) => entry.isDirectory())).slice(0, 4)) {
      for (const log of (await newest(folder.file, name => name.endsWith(".jsonl"))).slice(0, 2)) {
        const handle = await fs.open(log.file, "r");
        try {
          const { size } = await handle.stat(), length = Math.min(size, 256 * 1024), bytes = Buffer.alloc(length);
          await handle.read(bytes, 0, length, size - length);
          const found = [...bytes.toString("utf8").matchAll(/"model"\s*:\s*"(claude-[a-z0-9.\-[\]]+)"/gi)].at(-1)?.[1];
          if (found) return { model: found, from: "last" };
        } finally { await handle.close(); }
      }
    }
  } catch { /* no saved sessions */ }
  return null;
}
async function close(owner: number): Promise<void> {
  const session = sessions.get(owner);
  if (!session) return;
  sessions.delete(owner);
  await kill(session);
  session.bridge.close();
  await fs.rm(session.directory, { recursive: true, force: true });
}

/** Claude Code's permission prompt tool: {tool_name, input, tool_use_id} in, allow with the input or deny out. */
function permission(session: Session, args: Record<string, unknown>): Promise<unknown> {
  // Pre-allowed already (--allowedTools); if Claude Code asks anyway, a precut tool goes ahead without a prompt.
  if (typeof args.wait !== "string" && preAllowed.has(String(args.tool_name ?? ""))) return Promise.resolve({ behavior: "allow", updatedInput: typeof args.input === "object" && args.input !== null ? args.input : {} });
  let request = typeof args.wait === "string" ? args.wait : "";
  let waiting = session.waiting.get(request);
  if (!waiting) {
    if (request) return Promise.resolve({ behavior: "deny", message: "This question has ended." });
    const input = typeof args.input === "object" && args.input !== null ? args.input as Record<string, unknown> : {};
    let resolve!: (answer: unknown) => void;
    const promise = new Promise<unknown>(done => { resolve = done; });
    request = randomUUID();
    waiting = { promise, resolve, input };
    session.waiting.set(request, waiting);
    emit(session, { kind: "permission", request, tool: String(args.tool_name ?? ""), input, toolUseId: typeof args.tool_use_id === "string" ? args.tool_use_id : undefined });
  }
  const key = request;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The answer is kept until it is handed over: it may land between two of the tool's polls.
  return Promise.race([waiting.promise.then(answer => { session.waiting.delete(key); return answer; }), new Promise(resolve => { timer = setTimeout(() => resolve({ wait: key }), PERMISSION_POLL_MS); })])
    .finally(() => clearTimeout(timer));
}

/** Bring Claude Code back if it is not running: the first-run state shows in the pane when it can't start. */
async function revive(session: Session): Promise<ChatProblem | null> {
  if (session.alive) return null;
  const problem = await problemOf(session);
  emit(session, { kind: "problem", problem });
  if (!problem) start(session);
  return problem;
}
async function send(owner: number, id: string, text: string, context?: AskScreenContext): Promise<void> {
  if (typeof text !== "string" || !text.trim() || text.length > 100_000) throw new Error("Type a message for Claude.");
  const session = owned(owner, id);
  if (context) session.context = { ...context };
  if (text.trim() === "/clear") return clear(session);
  const problem = await revive(session);
  if (problem) throw new Error(problem === "not-installed" ? "Claude Code isn't installed on this Mac." : "Claude Code isn't signed in. Open Terminal and run claude.");
  const command = COMMANDS.test(text.trim());
  if (!command && !session.title) session.title = text.trim().replace(/\s+/g, " ").slice(0, 80);
  const model = /^\/model\s+(\S+)/.exec(text.trim()), effort = /^\/effort\s+(\S+)/.exec(text.trim());
  emit(session, { kind: "ask", text: text.trim(), command });
  if (model) emit(session, { kind: "model", model: model[1] });
  if (effort) emit(session, { kind: "effort", level: effort[1] });
  session.running = true;
  session.child!.stdin!.write(userLine(text.trim()));
}
async function clear(session: Session): Promise<void> {
  await kill(session);
  await save(session);
  Object.assign(session, { sessionId: randomUUID(), saved: false, title: undefined, running: false, wantMode: undefined, events: [] });
  emit(session, { kind: "clear" });
  await revive(session);
}
async function resume(session: Session, chat: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(chat)) throw new Error("Choose an earlier chat.");
  const saved = (await readIndex())[session.root]?.find(entry => entry.id === chat);
  if (!saved) throw new Error("That chat isn't in this shoot.");
  await kill(session);
  await save(session);
  const before = await fs.readFile(path.join(store(), `${chat}.json`), "utf8").then(text => JSON.parse(text) as ChatWire[]).catch(() => [] as ChatWire[]);
  Object.assign(session, { sessionId: chat, saved: true, title: saved.title, running: false, wantMode: undefined, events: [] });
  emit(session, { kind: "clear" });
  for (const { id: _id, sequence: _sequence, ...event } of before) emit(session, event as ChatEvent);
  emit(session, { kind: "notice", text: "Picked up this chat where it left off.", tone: "quiet" });
  await revive(session);
}

async function listFiles(session: Session, query: string): Promise<string[]> {
  if (!session.files || Date.now() - session.files.at > 30_000) {
    const list: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > 4 || list.length >= 5000) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.isFile()) list.push(path.relative(session.root, full));
        if (list.length >= 5000) return;
      }
    };
    await walk(session.root, 0);
    session.files = { at: Date.now(), list };
  }
  const needle = query.toLowerCase();
  return session.files.list.filter(file => file.toLowerCase().includes(needle)).sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 30);
}

export const claudeOpen = (owner: number, input: ChatRequest) => serial(owner, () => open(owner, input));
export const claudeSend = (owner: number, id: string, text: string, context?: AskScreenContext) => serial(owner, () => send(owner, id, text, context));
export function claudeInterrupt(owner: number, id: string): void {
  const session = owned(owner, id);
  if (!session.alive || !session.running) return;
  release(session, { behavior: "deny", message: "The person stopped this turn." });
  // SIGINT ends the turn; Claude Code stays up for the next one (SIGTERM would end it).
  session.child!.kill("SIGINT");
}
export function claudeAnswer(owner: number, id: string, request: string, allow: boolean, message?: string): void {
  const session = owned(owner, id);
  const waiting = session.waiting.get(request);
  if (!waiting || waiting.answered) return;
  waiting.answered = true;
  waiting.resolve(allow ? { behavior: "allow", updatedInput: waiting.input }
    : { behavior: "deny", message: message?.trim() || "The person said no. Stop and wait for what they say next." });
  emit(session, { kind: "answered", request, allow });
}
/** Permission modes have no documented live switch in this mode: the process comes back with --resume and the new mode. */
export const claudeMode = (owner: number, id: string, mode: string) => serial(owner, async () => {
  const session = owned(owner, id);
  if (!["default", "acceptEdits", "plan", "auto", "bypassPermissions", "dontAsk"].includes(mode)) throw new Error("Choose a permission mode.");
  if (mode === session.mode && !session.wantMode) return;
  session.wantMode = mode;
  emit(session, { kind: "mode", mode });
  if (!session.running) await switchMode(session);
});
export const claudeClear = (owner: number, id: string) => serial(owner, () => clear(owned(owner, id)));
export const claudeResume = (owner: number, id: string, chat: string) => serial(owner, () => resume(owned(owner, id), chat));
/** Restart, or "Check again" from the first-run states: the state is shown in the pane, never thrown. */
export const claudeRestart = (owner: number, id: string) => serial(owner, async () => {
  const session = owned(owner, id);
  await kill(session);
  await revive(session);
  return snapshot(session);
});
export async function claudeSessions(owner: number, id: string): Promise<SavedChat[]> {
  const session = owned(owner, id);
  return ((await readIndex())[session.root] ?? []).filter(chat => chat.id !== session.sessionId);
}
export const claudeFiles = (owner: number, id: string, query: string) => listFiles(owned(owner, id), String(query ?? "").slice(0, 200));
export function claudeContext(owner: number, id: string, context: AskScreenContext): void { owned(owner, id).context = { ...context }; }
export const claudeClose = (owner: number) => serial(owner, () => close(owner));
export function closeAllClaude(): void { for (const owner of new Set([...sessions.keys(), ...queues.keys()])) void claudeClose(owner); }
/** The window's open shoot, so a new shoot (not a new edit) ends the chat. */
export const claudeRoot = (owner: number) => sessions.get(owner)?.root;
