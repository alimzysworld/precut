// CH3: Claude's pane draws the person's own Claude Code as a chat. Claude Code runs as
//   claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
// and this file turns its stream into typed events (main) and the events into a transcript (renderer).
// Shapes are the ones recorded live on 31 Oct (qa/CH3/fixtures, Claude Code 2.1.316). No model call here.

export type ChatProblem = "not-installed" | "signed-out";
export type ModelOption = { value: string; label: string; description?: string };
export type CommandOption = { name: string; description: string; argumentHint?: string };
export type ChatEvent =
  | { kind: "init"; sessionId: string; model: string; permissionMode: string; version?: string; apiKeySource?: string }
  | { kind: "ask"; text: string; command?: boolean }                               // the person's turn, as sent
  | { kind: "delta"; message: string; index: number; text: string }                // streamed reply text
  | { kind: "text"; message: string; text: string }                                // a whole reply block
  | { kind: "thinking"; message: string }
  | { kind: "tool-start"; use: string; name: string }                               // a tool call is being written
  | { kind: "tool"; use: string; name: string; input: Record<string, unknown>; parent?: string | null }
  | { kind: "tool-result"; use: string; ok: boolean; text: string }
  | { kind: "permission"; request: string; tool: string; input: Record<string, unknown>; toolUseId?: string }
  | { kind: "answered"; request: string; allow: boolean }
  | { kind: "result"; ok: boolean; subtype: string; interrupted: boolean; text?: string; cost?: number }
  | { kind: "retry"; attempt?: number; error?: string }
  | { kind: "mode"; mode: string }                                                 // precut asked for a permission mode
  | { kind: "model"; model: string }                                               // precut asked for a model (the next init confirms it)
  | { kind: "effort"; level: string }
  | { kind: "options"; models?: ModelOption[]; commands?: CommandOption[] }
  | { kind: "default-model"; model: string; from: "settings" | "last" }                                     // POLISH1: what Claude Code will run before it says (its settings or last session); never a model call
  | { kind: "notice"; text: string; tone?: "quiet" | "problem" }
  | { kind: "problem"; problem: ChatProblem | null }
  | { kind: "clear" }                                                              // a fresh chat starts here
  | { kind: "exit"; code: number | null; signal: string | null; expected: boolean };
/** On the wire: the event, with its chat (precut's session id) and order. Tool events name their call `use`, so `id` stays the chat's. */
export type ChatWire = ChatEvent & { id: string; sequence: number };

const object = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(part => typeof part === "string" ? part : string(object(part)?.text) ?? "").join("");
  return "";
}

/** One line of Claude Code's stream as zero or more events. Unknown lines are dropped, never guessed at. */
export function parseStreamLine(line: unknown): ChatEvent[] {
  const value = object(line);
  if (!value) return [];
  const type = value.type, subtype = value.subtype;
  if (type === "system" && subtype === "init")
    return [{ kind: "init", sessionId: string(value.session_id) ?? "", model: string(value.model) ?? "", permissionMode: string(value.permissionMode) ?? "default",
      version: string(value.claude_code_version), apiKeySource: string(value.apiKeySource) }];
  if (type === "system" && subtype === "api_retry") return [{ kind: "retry", attempt: typeof value.attempt === "number" ? value.attempt : undefined, error: string(value.error) }];
  if (type === "stream_event") {
    const event = object(value.event), message = string(value.api_message_id) ?? "";
    if (!event) return [];
    if (event.type === "content_block_start") {
      const block = object(event.content_block);
      if (block?.type === "tool_use" && typeof block.id === "string") return [{ kind: "tool-start", use: block.id, name: string(block.name) ?? "" }];
      if (block?.type === "thinking") return [{ kind: "thinking", message }];
      return [];
    }
    if (event.type === "content_block_delta") {
      const delta = object(event.delta);
      if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) return [{ kind: "delta", message, index: Number(event.index) || 0, text: delta.text }];
    }
    return [];
  }
  if (type === "assistant") {
    const message = object(value.message), id = string(message?.id) ?? string(value.uuid) ?? "";
    const parent = string(value.parent_tool_use_id) ?? null;
    const out: ChatEvent[] = [];
    for (const part of Array.isArray(message?.content) ? message!.content as unknown[] : []) {
      const block = object(part);
      if (block?.type === "text" && typeof block.text === "string" && !parent) out.push({ kind: "text", message: id, text: block.text });
      if (block?.type === "tool_use" && typeof block.id === "string") out.push({ kind: "tool", use: block.id, name: string(block.name) ?? "", input: object(block.input) ?? {}, parent });
    }
    return out;
  }
  if (type === "user") {
    const message = object(value.message), out: ChatEvent[] = [];
    for (const part of Array.isArray(message?.content) ? message!.content as unknown[] : []) {
      const block = object(part);
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") out.push({ kind: "tool-result", use: block.tool_use_id, ok: block.is_error !== true, text: textOf(block.content).slice(0, 4000) });
    }
    return out;
  }
  if (type === "result") {
    const interrupted = value.terminal_reason === "aborted_streaming" || subtype === "error_during_execution";
    return [{ kind: "result", ok: value.is_error !== true && subtype === "success", subtype: string(subtype) ?? "", interrupted, text: string(value.result),
      cost: typeof value.total_cost_usd === "number" ? value.total_cost_usd : undefined }];
  }
  if (type === "control_response") {
    // The Agent SDK's initialize answer (models and commands), when this Claude Code gives one. Not seen live yet.
    const response = object(object(value.response)?.response);
    if (!response) return [];
    const models = Array.isArray(response.models) ? (response.models as unknown[]).map(object).filter(Boolean).map(m => ({ value: string(m!.value) ?? "", label: string(m!.displayName) ?? string(m!.value) ?? "", description: string(m!.description) })).filter(m => m.value) : undefined;
    const commands = Array.isArray(response.commands) ? (response.commands as unknown[]).map(object).filter(Boolean).map(c => ({ name: string(c!.name) ?? "", description: string(c!.description) ?? "", argumentHint: string(c!.argumentHint) })).filter(c => c.name) : undefined;
    return models?.length || commands?.length ? [{ kind: "options", models, commands }] : [];
  }
  return [];
}

/** The person's message on stdin, as the spike recorded it. */
export const userLine = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }) + "\n";

// ---------- Labels: plain words for what Claude Code reports. ----------

/** "claude-haiku-5-5" -> "Haiku 5.5"; aliases keep their name. */
export function modelLabel(model: string | null | undefined): string {
  // POLISH1: before the first turn with nothing known, still never a bare "Default".
  if (!model) return "Claude Code default";
  const clean = model.replace(/\[[^\]]*\]$/, "");
  const match = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(clean);
  if (match) return `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
  if (/^default$/i.test(clean)) return "Claude Code default";
  return clean.length <= 18 ? clean.charAt(0).toUpperCase() + clean.slice(1) : clean.slice(0, 17) + "…";
}
/** POLISH1: the chip before Claude Code's first turn. Its settings win; then the default it reports for this plan (the
 * initialize answer, e.g. "Opus 5.5 for your plan"); then the model of the last session; never a bare "Default". */
export function chipModelLabel(t: Pick<Transcript, "pendingModel" | "model" | "defaultModel" | "defaultFrom" | "models">): string {
  const known = t.pendingModel ?? t.model;
  if (known) return modelLabel(known);
  if (t.defaultModel && t.defaultFrom === "settings") return modelLabel(t.defaultModel);
  const option = t.models?.find(m => m.value === "default");
  const plan = /\b(opus|sonnet|haiku|fable)\s+\d+(?:\.\d+)?/i.exec(`${option?.description ?? ""} ${option?.label ?? ""}`)?.[0];
  if (plan) return plan.replace(/^./, c => c.toUpperCase());
  return modelLabel(t.defaultModel);
}
export const MODE_LABEL: Record<string, string> = { default: "asks before changes", acceptEdits: "accept edits on", plan: "plan mode on", auto: "auto mode on", bypassPermissions: "bypass permissions on", dontAsk: "don't ask mode on" };
export const modeLabel = (mode: string | null | undefined) => mode ? MODE_LABEL[mode] ?? `${mode} mode` : "permission mode";
/** ⇧⇥ order, as the terminal cycles. Auto and bypass are offered only when Claude Code already reported them for this person. */
export function modeCycle(seen: Iterable<string>): string[] {
  const known = new Set(seen);
  return ["default", "acceptEdits", "plan", ...(known.has("auto") ? ["auto"] : []), ...(known.has("bypassPermissions") ? ["bypassPermissions"] : [])];
}
export const EFFORTS = [["low", "Low"], ["medium", "Med"], ["high", "High"], ["xhigh", "X-high"], ["max", "Max"]] as const;

const base = (file: unknown) => typeof file === "string" ? file.split("/").filter(Boolean).at(-1) ?? file : "a file";
const clip = (value: unknown, n = 60) => { const text = String(value ?? "").replace(/\s+/g, " ").trim(); return text.length > n ? text.slice(0, n - 1) + "…" : text; };
const words = (name: string) => { const text = name.replace(/[_-]+/g, " ").trim(); return text.charAt(0).toUpperCase() + text.slice(1); };
const PRECUT_STEPS: Record<string, string> = {
  produce_edit: "Added finishing touches", produce_apply: "Added finishing touches", produce_less: "Reduced the finishing touches", produce_more: "Added more finishing touches", produce_remove: "Took the finishing touches out", produce_status: "Read the finishing touches",
  precut_context: "Read the screen", read_edit: "Read the edit", read_transcript: "Read the transcript", read_captions: "Read the captions", list_takes: "Looked at the takes",
  look_at: "Looked at the picture", search_footage: "Searched the footage", find_words: "Found the words", list_clips: "Looked through the clips", get_clip: "Read a clip",
  list_cuts: "Looked through the edits", list_shoots: "Looked through the shoots", list_versions: "Read the versions", batch_edit: "Changed the edit", undo: "Undid a change", redo: "Redid a change",
  list_graphic_templates: "Looked through the graphics", preview_graphic: "Previewed a graphic", add_graphic: "Added a graphic", add_card: "Added a card", export_cut: "Exported the edit", open_version: "Opened a version",
};
/** One quiet line for a tool call: what Claude did, in the past tense. */
export function stepLabel(name: string, input: Record<string, unknown> = {}): string {
  const precut = /^mcp__precut__(.+)$/.exec(name);
  if (precut) return PRECUT_STEPS[precut[1]] ?? (precut[1] === "batch_edit" ? "Changed the edit" : words(precut[1]));
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (mcp) return `${words(mcp[1])}: ${words(mcp[2]).toLowerCase()}`;
  switch (name) {
    case "Read": return `Read ${base(input.file_path)}`;
    case "Write": return `Wrote ${base(input.file_path)}`;
    case "Edit": case "MultiEdit": case "NotebookEdit": return `Edited ${base(input.file_path ?? input.notebook_path)}`;
    // Claude Code's own description is already a plain line ("Read the saved edit summary"); a bare command is "Ran ...".
    case "Bash": return typeof input.description === "string" && input.description.trim() ? clip(input.description, 60) : `Ran ${clip(input.command, 48)}`;
    case "Glob": return `Looked for ${clip(input.pattern, 40)}`;
    case "Grep": return `Searched for ${clip(input.pattern, 40)}`;
    case "WebFetch": { try { return `Read ${new URL(String(input.url)).host}`; } catch { return "Read a web page"; } }
    case "WebSearch": return `Searched the web for ${clip(input.query, 40)}`;
    case "Task": case "Agent": return `Asked a subagent to ${clip(input.description, 40).replace(/^./, c => c.toLowerCase())}`;
    case "TodoWrite": return "Updated the plan";
    case "Skill": return `Used the ${clip(input.skill ?? input.name, 30)} skill`;
    default: return words(name);
  }
}
const ONGOING: Record<string, string> = { Wrote: "Writing", Read: "Reading", Edited: "Editing", Ran: "Running", Searched: "Searching", Looked: "Looking", Changed: "Changing", Added: "Adding",
  Set: "Setting", Used: "Using", Asked: "Asking", Updated: "Updating", Found: "Finding", Exported: "Exporting", Opened: "Opening", Previewed: "Previewing", Undid: "Undoing", Redid: "Redoing" };
/** The same line while the tool is still running: "Writing hello.txt", not "Wrote". */
export const ongoingLabel = (label: string) => label.replace(/^(\w+)/, word => ONGOING[word] ?? word);
const PRESENT: Record<string, string> = { Wrote: "Write", Edited: "Edit", Ran: "Run", Searched: "Search", Looked: "Look", Changed: "Change", Added: "Add", Used: "Use", Asked: "Ask",
  Updated: "Update", Found: "Find", Exported: "Export", Opened: "Open", Previewed: "Preview", Undid: "Undo", Redid: "Redo" };
/** "Looked at the takes" as an ask: "Look at the takes". */
export const presentLabel = (label: string) => label.replace(/^(\w+)/, word => PRESENT[word] ?? word);
/** POLISH1: steps that are Claude Code's own plumbing, never shown (it looking up which tools it has). */
export const quietStep = (name: string) => name === "ToolSearch" || name === "ListMcpResourcesTool" || name === "ReadMcpResourceTool";
/** The question on a permission ask: what Claude wants to do, then a quieter why. Always a plain sentence: the raw
 * input stays behind "Show details" (permissionDetails). */
export function permissionText(tool: string, input: Record<string, unknown>): { title: string; detail: string } {
  const file = typeof input.file_path === "string" ? input.file_path : undefined;
  if (/^mcp__/.test(tool)) {
    const precut = /^mcp__precut__/.test(tool);
    return { title: `${presentLabel(stepLabel(tool, input))}?`, detail: precut ? "In precut. Every change is one undo step." : `With ${words(tool.replace(/^mcp__/, "").split("__")[0])}, one of your own tools.` };
  }
  switch (tool) {
    case "Write": return { title: `Create ${base(file)}?`, detail: file ? `Claude wants to write ${file}.` : "Claude wants to write a file." };
    case "Edit": case "MultiEdit": return { title: `Edit ${base(file)}?`, detail: file ? `Claude wants to change ${file}.` : "Claude wants to change a file." };
    case "Read": return { title: `Read ${base(file)}?`, detail: file ? `Claude wants to read ${file}.` : "Claude wants to read a file." };
    case "Bash": return { title: typeof input.description === "string" && input.description.trim() ? `${clip(input.description, 80).replace(/[.?]$/, "")}?` : "Run a command?", detail: "Claude wants to run a command on this Mac." };
    case "WebFetch": return { title: "Open a web page?", detail: clip(input.url, 200) };
    case "WebSearch": return { title: "Search the web?", detail: clip(input.query, 200) };
    default: return { title: `${presentLabel(stepLabel(tool, input))}?`, detail: "Claude wants to use one of Claude Code's tools." };
  }
}
/** What "Show details" reveals: the command for Bash, else the input as Claude Code sent it. */
export function permissionDetails(tool: string, input: Record<string, unknown>): string {
  if (tool === "Bash" && typeof input.command === "string") return input.command;
  try { return JSON.stringify(input, null, 2); } catch { return ""; }
}

// ---------- The transcript the pane draws. ----------

export type Receipt = { cutId: string; version: number; label: string; createdVersion?: true };
export type Step = { id: string; name: string; label: string; done: boolean; ok: boolean; receipt?: Receipt };
export type Item =
  | { type: "ask"; key: string; text: string }
  | { type: "steps"; key: string; steps: Step[] }
  | { type: "reply"; key: string; message: string; index: number; text: string; done: boolean }
  | { type: "permission"; key: string; request: string; tool: string; input: Record<string, unknown>; answer?: "allow" | "deny"; toolUseId?: string }
  | { type: "notice"; key: string; text: string; tone: "quiet" | "problem" };
export type Transcript = {
  items: Item[]; running: boolean; command: boolean; sessionId: string | null; model: string | null; pendingModel: string | null; mode: string | null; effort: string | null;
  modesSeen: string[]; models: ModelOption[] | null; commands: CommandOption[] | null; problem: ChatProblem | null; ended: boolean; version: string | null;
  /** POLISH1: the model Claude Code will run, known before its first turn (its settings or the last session). */
  defaultModel?: string | null; defaultFrom?: "settings" | "last" | null;
};
export const emptyTranscript = (): Transcript => ({ items: [], running: false, command: false, sessionId: null, model: null, pendingModel: null, mode: null, effort: null, modesSeen: [], models: null, commands: null, problem: null, ended: false, version: null });

function receiptOf(name: string, text: string): Receipt | undefined {
  if (!name.startsWith("mcp__precut__")) return undefined;
  try {
    const value = object(JSON.parse(text));
    if (value?.createdVersion !== true || typeof value.cutId !== "string" || !Number.isInteger(value.version)) return undefined;
    const snapshot = object(value.snapshot);
    const label = string(snapshot?.feedback) ?? string(value.label) ?? stepLabel(name);
    return { cutId: value.cutId, version: value.version as number, label: label.length > 80 ? label.slice(0, 79) + "…" : label, createdVersion:true };
  } catch { return undefined; }
}
const keyed = (t: Transcript, prefix: string) => `${prefix}${t.items.length}`;

/** Pure: the next transcript after one event. Deltas stream into the open reply; the whole block replaces it. */
export function reduceChat(previous: Transcript, event: ChatEvent): Transcript {
  const t: Transcript = { ...previous, items: previous.items.slice() };
  const last = t.items.at(-1);
  const steps = (): Step[] => {
    if (last?.type === "steps") { const copy = { ...last, steps: last.steps.slice() }; t.items[t.items.length - 1] = copy; return copy.steps; }
    const fresh: Item = { type: "steps", key: keyed(t, "s"), steps: [] }; t.items.push(fresh); return fresh.steps;
  };
  const findStep = (id: string): [number, number] | null => {
    for (let i = t.items.length - 1; i >= 0; i--) { const item = t.items[i]; if (item.type === "steps") { const j = item.steps.findIndex(s => s.id === id); if (j >= 0) return [i, j]; } }
    return null;
  };
  const putStep = (at: [number, number], change: Partial<Step>) => {
    const item = t.items[at[0]] as Extract<Item, { type: "steps" }>;
    const copy = { ...item, steps: item.steps.slice() }; copy.steps[at[1]] = { ...copy.steps[at[1]], ...change }; t.items[at[0]] = copy;
  };
  switch (event.kind) {
    case "init":
      t.sessionId = event.sessionId || t.sessionId; t.model = event.model || t.model; t.mode = event.permissionMode; t.version = event.version ?? t.version;
      if (!t.modesSeen.includes(event.permissionMode)) t.modesSeen = [...t.modesSeen, event.permissionMode];
      t.problem = null;
      return t;
    case "ask":
      t.running = true; t.command = !!event.command; t.ended = false;
      t.items.push(event.command ? { type: "notice", key: keyed(t, "n"), text: event.text, tone: "quiet" } : { type: "ask", key: keyed(t, "a"), text: event.text });
      return t;
    case "delta": {
      const open = [...t.items].reverse().find((item): item is Extract<Item, { type: "reply" }> => item.type === "reply" && item.message === event.message && item.index === event.index && !item.done);
      if (open && t.items.at(-1) === open) { t.items[t.items.length - 1] = { ...open, text: open.text + event.text }; return t; }
      t.items.push({ type: "reply", key: keyed(t, "r"), message: event.message, index: event.index, text: event.text, done: false });
      return t;
    }
    case "text": {
      // A command's own answer ("Set model to ...") is a quiet line, as the terminal prints it.
      if (t.command) {
        // A model the plan doesn't allow is answered in Claude Code's own words: the chip stays where it was.
        const set = /^Set model to `?([^`\n]+?)`?(?: for| \(|$)/.exec(event.text);
        if (set) t.model = set[1];
        const refused = t.pendingModel !== null && !set;
        t.items.push({ type: "notice", key: keyed(t, "n"), text: event.text.replace(/`/g, ""), tone: refused ? "problem" : "quiet" }); return t;
      }
      const index = t.items.findIndex(item => item.type === "reply" && item.message === event.message && !item.done);
      if (index >= 0) { t.items[index] = { ...(t.items[index] as Extract<Item, { type: "reply" }>), text: event.text, done: true }; return t; }
      t.items.push({ type: "reply", key: keyed(t, "r"), message: event.message, index: 0, text: event.text, done: true });
      return t;
    }
    case "tool-start": {
      if (findStep(event.use)) return t;
      steps().push({ id: event.use, name: event.name, label: stepLabel(event.name), done: false, ok: true });
      return t;
    }
    case "tool": {
      if (event.parent) return t;   // a subagent's own tools stay inside its one step
      const at = findStep(event.use);
      if (at) { putStep(at, { name: event.name, label: stepLabel(event.name, event.input) }); return t; }
      steps().push({ id: event.use, name: event.name, label: stepLabel(event.name, event.input), done: false, ok: true });
      return t;
    }
    case "tool-result": {
      const at = findStep(event.use);
      if (!at) return t;
      const step = (t.items[at[0]] as Extract<Item, { type: "steps" }>).steps[at[1]];
      putStep(at, { done: true, ok: event.ok, receipt: event.ok ? receiptOf(step.name, event.text) : undefined });
      return t;
    }
    case "permission":
      t.items.push({ type: "permission", key: keyed(t, "p"), request: event.request, tool: event.tool, input: event.input, ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}) });
      return t;
    case "answered": {
      const index = t.items.findIndex(item => item.type === "permission" && item.request === event.request);
      if (index >= 0) t.items[index] = { ...(t.items[index] as Extract<Item, { type: "permission" }>), answer: event.allow ? "allow" : "deny" };
      return t;
    }
    case "result": {
      t.running = false; t.command = false; t.pendingModel = null;
      // Steps still open when a turn ends were cut short.
      t.items = t.items.map(item => item.type === "steps" && item.steps.some(s => !s.done) ? { ...item, steps: item.steps.map(s => s.done ? s : { ...s, done: true, ok: false }) } : item.type === "reply" && !item.done ? { ...item, done: true } : item);
      if (event.interrupted) t.items.push({ type: "notice", key: keyed(t, "n"), text: "Stopped.", tone: "quiet" });
      else if (!event.ok) t.items.push({ type: "notice", key: keyed(t, "n"), text: event.text?.trim() || "Claude Code couldn't finish that. Try again.", tone: "problem" });
      return t;
    }
    case "retry":
      if (last?.type === "notice" && last.text.startsWith("Claude Code is retrying")) return t;
      t.items.push({ type: "notice", key: keyed(t, "n"), text: "Claude Code is retrying the connection.", tone: "quiet" });
      return t;
    case "mode":
      t.mode = event.mode; if (!t.modesSeen.includes(event.mode)) t.modesSeen = [...t.modesSeen, event.mode];
      return t;
    case "model": t.pendingModel = event.model; return t;
    case "effort": t.effort = event.level; return t;
    case "default-model": t.defaultModel = event.model; t.defaultFrom = event.from; return t;
    case "options": if (event.models?.length) t.models = event.models; if (event.commands?.length) t.commands = event.commands; return t;
    case "notice": t.items.push({ type: "notice", key: keyed(t, "n"), text: event.text, tone: event.tone ?? "quiet" }); return t;
    case "problem": t.problem = event.problem; return t;
    case "clear": return { ...emptyTranscript(), defaultModel: t.defaultModel, defaultFrom: t.defaultFrom, model: t.model, mode: t.mode, effort: t.effort, modesSeen: t.modesSeen, models: t.models, commands: t.commands, version: t.version };
    case "exit":
      t.ended = true;
      if (t.running) {
        t.running = false; t.command = false; t.pendingModel = null;
        t.items = t.items.map(item => item.type === "steps" && item.steps.some(s => !s.done) ? { ...item, steps: item.steps.map(s => s.done ? s : { ...s, done: true, ok: false }) } : item.type === "reply" && !item.done ? { ...item, done: true } : item);
      }
      if (!event.expected) t.items.push({ type: "notice", key: keyed(t, "n"), text: "Claude Code stopped. Your next message picks the chat up again.", tone: "problem" });
      return t;
  }
  return t;
}
export const replay = (events: ChatEvent[], from: Transcript = emptyTranscript()) => events.reduce(reduceChat, from);
/** The pending permission ask, if Claude is waiting on the person. */
export const pendingAsk = (t: Transcript) => [...t.items].reverse().find((item): item is Extract<Item, { type: "permission" }> => item.type === "permission" && !item.answer);
