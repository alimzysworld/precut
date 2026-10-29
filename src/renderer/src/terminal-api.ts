// Provisional A1 contract, intentionally outside Claude's shared schema.
export type AskScreenContext = { cutId?: string; version?: number; playheadS?: number;
  idea?: { id: string; messageId: string; index: number; title: string; concept: string; uses: string[]; missing: string[] };
  selectedPiece?: number | null; selectedJoin?: number | null; selectedCaption?: string | null;
  selectedOverlay?: string | null; panel?: string | null; editingPanel?: string | null; scope?: "edit" | "clip" };
export type TerminalRequest = { root: string; cutId?: string; version?: number; cols: number; rows: number; context?: AskScreenContext };
export type TerminalEvent = { id: string; sequence: number; data?: string; exitCode?: number };
export type TerminalSnapshot = { id: string; engine: "claude" | "codex" | "muse"; sequence: number; output: string; exitCode?: number };
export interface TerminalApi {
  terminalOpen(input: TerminalRequest): Promise<TerminalSnapshot>;
  terminalWrite(id: string, data: string): Promise<void>;
  terminalResize(id: string, cols: number, rows: number): Promise<void>;
  terminalContext(id: string, context: AskScreenContext): Promise<void>;
  terminalRestart(id: string, input: TerminalRequest): Promise<TerminalSnapshot>;
  onTerminal(callback: (event: TerminalEvent) => void): () => void;
}
export function terminalApi(): TerminalApi | undefined {
  return (window as unknown as { precutTerminal?: TerminalApi }).precutTerminal;
}
