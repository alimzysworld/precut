import { useModelAccess, ModelSignIn } from "../ModelAccess";
import { useEffect, useRef, useState } from "react";
import { InlineError, Row } from "../ui";
import { Redo } from "../icons";
import { useShortcuts } from "../../hooks/useShortcuts";
import { terminalApi, type TerminalRequest, type TerminalSnapshot } from "../../terminal-api";
import type { TerminalView } from "./ask-terminal-view";
export type { AskScreenContext } from "../../terminal-api";
import type { AskScreenContext } from "../../terminal-api";
import { usePageActive } from "../../hooks/usePageActivity";
import { useNav } from "../../nav";
import { useAskWorkspace } from "./askWorkspace";

export function AskPanel({ root, cutId, version, screenContext, autoFocus = true }: { root: string; cutId?: string; version: number; screenContext?: AskScreenContext;
  /** CH2: false in Claude's pane, which is open with the page rather than opened to type. */ autoFocus?: boolean }) {
  const modelReady = useModelAccess();
  const active = usePageActive();
  const { page } = useNav();
  const workspace = useAskWorkspace(root);
  const idea = screenContext?.idea ?? workspace.idea;
  const host = useRef<HTMLDivElement>(null), view = useRef<TerminalView>();
  const latest = useRef<TerminalRequest>({ root, cutId, version, cols: 40, rows: 24 });
  latest.current = { root, cutId, version, cols: 40, rows: 24, context: { ...screenContext, idea, cutId, version } };
  const [session, setSession] = useState<TerminalSnapshot>();
  const [error, setError] = useState<string | null>(null), [restarting, setRestarting] = useState(false);
  const showError = (error: unknown) => setError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*/i, "").replace(/^Error:\s*/i, ""));
  const scope = page === "ideas" ? "ideas" : "precuts";
  useShortcuts(scope, [{ id: "terminal-clear", keys: ["Cmd+k"], label: "Clear Ask terminal", scope, handler: () => view.current?.clear() }], active);
  useEffect(() => {
    if (!modelReady || !active) return;
    let live = true;
    setSession(undefined); setError(null);
    const api = terminalApi();
    if (!api) { setError("Open the desktop app to use Ask."); return; }
    if (!host.current) return;
    const element = host.current;
    void import("./ask-terminal-view").then(module => module.mountTerminal(element, api, latest.current,
      snapshot => { if (live) setSession(snapshot); }, error => { if (live) showError(error); }, { focus: autoFocus }))
      .then(mounted => { if (live) view.current = mounted; else mounted.dispose(); })
      .catch(error => { if (live) showError(error); });
    return () => { live = false; view.current?.dispose(); view.current = undefined; };
  }, [root, cutId, modelReady, active]);
  // Keep the newest playhead/selection without sending 60 IPC calls a second.
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => { void view.current?.context(latest.current.context!).catch(showError); }, 120);
    return () => window.clearTimeout(timer);
  }, [version, screenContext, idea, session?.id, active]);
  const restart = async () => {
    if (!view.current || restarting) return;
    setRestarting(true); setError(null);
    try { await view.current.restart(latest.current); }
    catch (error) { showError(error); }
    finally { setRestarting(false); }
  };
  const label = session?.engine === "claude" ? "Claude Code" : session?.engine === "codex" ? "Codex" : session?.engine === "muse" ? "Muse" : "Ask";
  if (!modelReady) return <ModelSignIn feature="ask" />;
  return <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col text-small" aria-label="Ask" data-editor-widget data-ask-terminal onKeyDown={event => event.stopPropagation()}>
    {idea && <p data-talking-about className="shrink-0 py-2 text-small">Talking about: {idea.title}</p>}
    <Row className="h-9 shrink-0 text-muted">
      <span>{label}{session?.exitCode !== undefined ? " · Ended" : ""}</span>
      {session ? <button type="button" aria-label="Restart Ask" title="Restart Ask" onClick={() => void restart()} disabled={restarting} className="st-icon-button rounded-lg p-2 disabled:opacity-40"><Redo size={15} /></button> : null}
    </Row>
    {error ? <InlineError className="mb-2">{error}</InlineError> : null}
    <div ref={host} className="min-h-0 min-w-0 flex-1 overflow-hidden" aria-label="Ask terminal" />
    {error ? <button type="button" className="self-start py-2 text-muted underline" onClick={() => { void import("../SettingsSheet").then(({ openSettings }) => openSettings("ai")); }}>Settings</button> : null}
  </div>;
}
