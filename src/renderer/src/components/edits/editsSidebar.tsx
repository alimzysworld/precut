import { useEffect, useSyncExternalStore, type CSSProperties } from "react";
import { SidebarLeft } from "../icons";
import { FOCUS } from "../ui";
import { Tooltip } from "../ui/InfoTip";
import { getApi } from "../../data";
import { readPane, savePane } from "./ToolBar";

/** POLISH1: the edits sidebar has three states: open, collapsed (thumbnails) and hidden (no strip at all). Hidden is
 * one remembered switch for the window, shared by the top-left toggle by the traffic lights, View > Show or hide edits
 * (main's menu) and ⌃⌘S. Collapse and Expand stay on the list itself. */
let hidden = readPane<boolean>("edits-hidden", false) === true;
const listeners = new Set<() => void>();
export function setEditsHidden(next: boolean) {
  if (next === hidden) return;
  hidden = next; savePane("edits-hidden", next);
  listeners.forEach(listener => listener());
}
export const toggleEditsHidden = () => setEditsHidden(!hidden);
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

// The menu's item reaches the window once, whichever page is showing.
let menuWired = false;
function wireMenu() {
  if (menuWired) return;
  const off = getApi().onMenu?.(command => { if (command === "toggle-edits-sidebar") toggleEditsHidden(); });
  menuWired = !!off;
}

/** ⌃⌘S, read by its physical key: with Control held the Mac can report a control character as the key. */
export const isSidebarKey = (event: KeyboardEvent) => event.ctrlKey && event.metaKey && !event.altKey && !event.shiftKey && (event.code === "KeyS" || event.key.toLowerCase() === "s");

export function useEditsSidebar(active: boolean) {
  const value = useSyncExternalStore(subscribe, () => hidden);
  useEffect(() => { if (active) wireMenu(); }, [active]);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => { if (!event.defaultPrevented && !event.repeat && isSidebarKey(event)) { event.preventDefault(); toggleEditsHidden(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);
  return { hidden: value, toggle: toggleEditsHidden };
}

export function EditsSidebarToggle({ hidden: isHidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  const label = isHidden ? "Show edits" : "Hide edits";
  return <Tooltip label={label} shortcut="⌃⌘S" below><button type="button" data-edits-sidebar-toggle aria-label={label} aria-pressed={!isHidden}
    onClick={onToggle} style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
    className={`flex size-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-ink/[0.06] hover:text-ink focus-visible:text-ink ${isHidden ? "" : "text-ink/80"} ${FOCUS}`}>
    <SidebarLeft size={18} />
  </button></Tooltip>;
}
