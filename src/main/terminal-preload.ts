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
