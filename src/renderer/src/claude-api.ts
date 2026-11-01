// CH3: Claude's pane over IPC (main/claude-chat.ts, exposed by terminal-preload.ts beside the terminal).
import type { AskScreenContext } from "./terminal-api";
import type { ChatWire } from "@shared/claude-chat";
export type ChatRequest = { root: string; cutId?: string; version?: number; context?: AskScreenContext };
/** engine other than "claude": the pane keeps the terminal. */
export type ChatSnapshot = { id: string; engine: "claude" | "codex" | "muse"; sessionId: string; sequence: number; events: ChatWire[] };
export type SavedChat = { id: string; title: string; at: number };
export interface ClaudeApi {
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
export function claudeApi(): ClaudeApi | undefined {
  return (window as unknown as { precutClaude?: ClaudeApi }).precutClaude;
}
