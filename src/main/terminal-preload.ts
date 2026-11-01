// A1 additive entry: the contract owner's existing preload remains untouched.
import "../preload/index";
import { contextBridge, ipcRenderer } from "electron";
import type { TerminalRequest, TerminalSnapshot, TerminalEvent } from "./terminal";
import type { AskScreenContext } from "./sidekick-context";
interface TerminalApi {
  terminalOpen(input: TerminalRequest): Promise<TerminalSnapshot>;
  terminalWrite(id: string, data: string): Promise<void>;
  terminalResize(id: string, cols: number, rows: number): Promise<void>;
  terminalContext(id: string, context: AskScreenContext): Promise<void>;
  terminalRestart(id: string, input: TerminalRequest): Promise<TerminalSnapshot>;
  onTerminal(callback: (event: TerminalEvent) => void): () => void;
}
const terminal: TerminalApi = {
  terminalOpen: input => ipcRenderer.invoke("terminal:open", input),
  terminalWrite: (id, data) => ipcRenderer.invoke("terminal:write", id, data),
  terminalResize: (id, cols, rows) => ipcRenderer.invoke("terminal:resize", id, cols, rows),
  terminalContext: (id, context) => ipcRenderer.invoke("terminal:context", id, context),
  terminalRestart: (id, input) => ipcRenderer.invoke("terminal:restart", id, input),
  onTerminal: callback => {
    const listener = (_event: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data);
    ipcRenderer.on("terminal:data", listener);
    return () => { ipcRenderer.removeListener("terminal:data", listener); };
  },
};
if (process.contextIsolated) contextBridge.exposeInMainWorld("precutTerminal", terminal);
else (globalThis as unknown as { precutTerminal: TerminalApi }).precutTerminal = terminal;

// CH3: Claude's pane (Claude Code's streaming JSON as a chat), beside the terminal.
import type { ChatRequest, ChatSnapshot, SavedChat } from "./claude-chat";
import type { ChatWire } from "../shared/claude-chat";
interface ClaudeApi {
  open(input: ChatRequest): Promise<ChatSnapshot>;
  send(id: string, text: string, context?: AskScreenContext): Promise<void>;
  interrupt(id: string): Promise<void>;
  answer(id: string, request: string, allow: boolean, message?: string): Promise<void>;
  mode(id: string, mode: string): Promise<void>;
  clear(id: string): Promise<void>;
  resume(id: string, chat: string): Promise<void>;
  restart(id: string): Promise<ChatSnapshot>;
  sessions(id: string): Promise<SavedChat[]>;
  files(id: string, query: string): Promise<string[]>;
  context(id: string, context: AskScreenContext): Promise<void>;
  onEvent(callback: (event: ChatWire) => void): () => void;
}
const claude: ClaudeApi = {
  open: input => ipcRenderer.invoke("claude:open", input),
  send: (id, text, context) => ipcRenderer.invoke("claude:send", id, text, context),
  interrupt: id => ipcRenderer.invoke("claude:interrupt", id),
  answer: (id, request, allow, message) => ipcRenderer.invoke("claude:answer", id, request, allow, message),
  mode: (id, mode) => ipcRenderer.invoke("claude:mode", id, mode),
  clear: id => ipcRenderer.invoke("claude:clear", id),
  resume: (id, chat) => ipcRenderer.invoke("claude:resume", id, chat),
  restart: id => ipcRenderer.invoke("claude:restart", id),
  sessions: id => ipcRenderer.invoke("claude:sessions", id),
  files: (id, query) => ipcRenderer.invoke("claude:files", id, query),
  context: (id, context) => ipcRenderer.invoke("claude:context", id, context),
  onEvent: callback => {
    const listener = (_event: Electron.IpcRendererEvent, data: ChatWire) => callback(data);
    ipcRenderer.on("claude:event", listener);
    return () => { ipcRenderer.removeListener("claude:event", listener); };
  },
};
if (process.contextIsolated) contextBridge.exposeInMainWorld("precutClaude", claude);
else (globalThis as unknown as { precutClaude: ClaudeApi }).precutClaude = claude;
