import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { TerminalApi, TerminalEvent, TerminalRequest, TerminalSnapshot, AskScreenContext } from "../../terminal-api";
import "@xterm/xterm/css/xterm.css";
import "./ask-terminal.css";

type Cached = { id: string; terminal: Terminal; fit: FitAddon; element: HTMLDivElement; off: () => void;
  sequence: number; exitCode?: number; engine: TerminalSnapshot["engine"]; status?: (snapshot: TerminalSnapshot) => void };
let cached: Cached | undefined;
export type TerminalView = { clear(): void; restart(input: TerminalRequest): Promise<void>; context(context: AskScreenContext): Promise<void>; dispose(): void };
export function terminalTheme(style: CSSStyleDeclaration): ITheme {
  const token = (name: string) => style.getPropertyValue(name).trim();
  return { background: token("--surface"), foreground: token("--ink"), cursor: token("--accent-text"), cursorAccent: token("--surface"),
    selectionBackground: token("--selection-fill"), selectionForeground: token("--ink"),
    black: token("--muted"), brightBlack: token("--muted"), red: token("--danger"), brightRed: token("--danger"),
    green: token("--good"), brightGreen: token("--good"), yellow: token("--warn"), brightYellow: token("--warn"),
    blue: token("--accent-text"), brightBlue: token("--accent-text"), magenta: token("--badge-violet-ink"), brightMagenta: token("--badge-violet-ink"),
    cyan: token("--accent-text"), brightCyan: token("--accent-text"), white: token("--ink"), brightWhite: token("--ink") };
}
const state = (entry: Cached): TerminalSnapshot => ({ id: entry.id, engine: entry.engine, sequence: entry.sequence, output: "", exitCode: entry.exitCode });
function receive(entry: Cached, event: TerminalEvent): void {
  if (event.id !== entry.id || event.sequence <= entry.sequence) return;
  entry.sequence = event.sequence;
  if (event.data !== undefined) entry.terminal.write(event.data);
  if (event.exitCode !== undefined) { entry.exitCode = event.exitCode; entry.status?.(state(entry)); }
}
function disposeCache(): void { cached?.off(); cached?.terminal.dispose(); cached?.element.remove(); cached = undefined; }

/** Keep the xterm parser and scrollback alive when the sheet detaches its DOM. */
export async function mountTerminal(host: HTMLElement, api: TerminalApi, input: TerminalRequest,
  onState: (snapshot: TerminalSnapshot) => void, onError: (error: unknown) => void, { focus = true }: { focus?: boolean } = {}): Promise<TerminalView> {
  let pending: TerminalEvent[] = [];
  let entry: Cached | undefined;
  let off = api.onTerminal(event => { if (entry) receive(entry, event); else pending.push(event); });
  let first: TerminalSnapshot;
  try { first = await api.terminalOpen(input); }
  catch (error) { off(); throw error; }
  function connect(snapshot: TerminalSnapshot): void {
    if (cached?.id !== snapshot.id) {
      disposeCache();
      const terminal = new Terminal({ cols: input.cols, rows: input.rows, fontSize: 12, lineHeight: 1.25, scrollback: 3000,
        cursorBlink: false, allowProposedApi: false, allowTransparency: false, convertEol: false,
        theme: terminalTheme(getComputedStyle(document.documentElement)), fontFamily: '"SF Mono", Menlo, ui-monospace, monospace' });
      const fit = new FitAddon(); terminal.loadAddon(fit);
      const element = document.createElement("div"); element.className = "st-ask-terminal";
      host.appendChild(element); terminal.open(element);
      cached = { id: snapshot.id, terminal, fit, element, off, sequence: snapshot.sequence, exitCode: snapshot.exitCode, engine: snapshot.engine };
      const created = cached;
      terminal.onData(data => { void api.terminalWrite(created.id, data).catch(onError); });
      terminal.attachCustomKeyEventHandler(event => {
        // Native clipboard shortcuts: copy a selection and paste into xterm's
        // textarea, which handles bracketed paste and multiline CLI prompts.
        if (event.metaKey && !event.altKey && !event.ctrlKey && event.key.toLowerCase() === "c" && terminal.hasSelection()) {
          if (event.type === "keydown") void navigator.clipboard.writeText(terminal.getSelection()).catch(onError);
          return false;
        }
        return true;
      });
      terminal.write(snapshot.output);
    } else {
      // The cached terminal outlives the sheet: a theme switched while it was closed is picked up here.
      off(); off = () => {}; host.appendChild(cached.element);
      cached.terminal.options.theme = terminalTheme(getComputedStyle(document.documentElement));
    }
    entry = cached!;
    entry.status = onState;
    pending.forEach(event => receive(entry!, event)); pending = [];
    onState(state(entry));
  }
  connect(first);
  let live = true, frame = 0;
  const fit = () => {
    if (!live || !entry || host.clientWidth < 20 || host.clientHeight < 20) return;
    entry.fit.fit();
    void api.terminalResize(entry.id, entry.terminal.cols, entry.terminal.rows).catch(onError);
  };
  const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); });
  observer.observe(host);
  const theme = new MutationObserver(() => { if (entry) entry.terminal.options.theme = terminalTheme(getComputedStyle(document.documentElement)); });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
  // CH2: Claude's pane mounts with the Edits page, so it only takes the cursor when it is asked for.
  fit(); if (focus) entry!.terminal.focus();
  return {
    clear() { entry?.terminal.clear(); },
    async restart(request) {
      if (!entry) return;
      const events: TerminalEvent[] = [];
      const remove = api.onTerminal(event => events.push(event));
      try {
        const next = await api.terminalRestart(entry.id, request);
        if (!live) return;
        // The old subscription was scoped to the disposed entry. Give the new
        // parser its own stream before consuming the restart snapshot.
        off = api.onTerminal(event => { if (entry) receive(entry, event); });
        connect(next); events.forEach(event => receive(entry!, event)); fit(); entry!.terminal.focus();
      } finally { remove(); }
    },
    async context(context) { if (entry) await api.terminalContext(entry.id, context); },
    dispose() { live = false; observer.disconnect(); theme.disconnect(); cancelAnimationFrame(frame); if (entry?.status === onState) entry.status = undefined; if (entry?.element.parentElement === host) entry.element.remove(); },
  };
}
