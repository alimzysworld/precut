import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Chat, SidebarRight } from "../icons";
import { FOCUS } from "../ui";
import { Tooltip } from "../ui/InfoTip";
import { PaneHandle } from "./ToolBar";
import { CLAUDE_MIN, CLAUDE_RESET, claudeMax, focusClaude, setClaudePresent, setClaudeWidth, toggleClaude, useClaudeLayout } from "./claudeLayout";
import "./shell.css";
import "./claude-chat.css";

const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties;
export { focusClaude, showClaude } from "./claudeLayout";

/** CH2: the right-sidebar toggle. The same button on the same pixel in both states: last in Claude's header while
 * Claude shows, at the top bar's end (the window's corner) while it is hidden. ⌘L does the same. */
export function ClaudeToggle() {
  const { open } = useClaudeLayout();
  const label = open ? "Hide Claude" : "Show Claude";
  return <Tooltip label={label} shortcut="⌘L"><button type="button" data-claude-toggle aria-label={label} aria-expanded={open} aria-controls="claude-pane"
    onClick={toggleClaude} style={noDrag}
    className={`flex size-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-ink/[0.06] hover:text-ink focus-visible:text-ink ${FOCUS}`}>
    <SidebarRight size={18} />
  </button></Tooltip>;
}

/** CH2: Claude is its own surface at the window's right edge, top to bottom, beside the editor's surface. POLISH1: split
 * from it by one hairline on the window's ground, which is also the resize handle (a 9 px strip over the line). Hidden, it slides out at the
 * edge and stays mounted, so the terminal and Claude Code keep running and come back exactly as they were.
 * CH2b: App holds the one pane for every page, so a page switch never remounts it. */
export function ClaudePane({ children }: { children: ReactNode }) {
  const layout = useClaudeLayout();
  const region = useRef<HTMLDivElement>(null), wasOpen = useRef(layout.open);
  useEffect(() => { setClaudePresent(true); return () => setClaudePresent(false); }, []);
  useEffect(() => {
    const element = region.current;
    if (!element) return;
    if (layout.open) element.removeAttribute("inert"); else element.setAttribute("inert", "");
    if (wasOpen.current === layout.open) return;
    wasOpen.current = layout.open;
    if (layout.open) { focusClaude(); return; }
    // Hidden with the cursor inside: it moves to the toggle, which is now in the window's corner.
    if (element.contains(document.activeElement)) requestAnimationFrame(() => document.querySelector<HTMLElement>("#edits-topbar-claude [data-claude-toggle]")?.focus());
  }, [layout.open]);
  return createPortal(<div ref={region} data-claude-region data-hidden={!layout.open || undefined} className="claude-region">
    <PaneHandle label="Resize Claude" title="Drag to resize" value={layout.width} onChange={setClaudeWidth} min={CLAUDE_MIN} max={claudeMax(layout.viewport)} reset={CLAUDE_RESET} reverse className="claude-gutter" />
    <aside id="claude-pane" aria-label="Claude" data-claude-pane className="claude-pane">
      <header className="claude-head">
        <h2 className="flex shrink-0 items-center gap-2 text-[14px] font-semibold"><Chat size={18} />Claude</h2>
        {/* CH3: the chat puts its model chip and menu here. */}
        <div id="claude-head-slot" className="relative flex min-w-0 flex-1 items-center gap-1" />
        <ClaudeToggle />
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </aside>
  </div>, document.body);
}

/** CH2b: Claude's pane with no shoot open (the shoots library): the chat belongs to a shoot. */
export function ClaudeEmpty() {
  return <div className="cc-root"><div className="cc-msgs"><div className="cc-first" data-claude-empty><p className="cc-title">Open a shoot to talk about it</p>
    <p className="cc-muted">Claude works on one shoot at a time: its footage, ideas and edits.</p></div></div></div>;
}
