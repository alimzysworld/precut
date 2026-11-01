// Navigation contract shared by every page. Location lives in the hash:
// #/clips?shoot=<root>&clip=<id>&t=<seconds>&tab=takes
// Pages read params with useNav() and move with nav.go(). Nothing else routes.
import { useContext,useEffect,useState } from "react";
import { PageSession } from "./hooks/usePageActivity";

export type PageId = "shoots" | "clips" | "ideas" | "precuts" | "wait";
export const PAGE_IDS: PageId[] = ["shoots", "clips", "ideas", "precuts", "wait"];
// WR2: the waiting room (#/wait) is where a processing shoot lives; it is never a remembered tab.
export type WorkspacePage = Exclude<PageId, "shoots" | "wait">;
const sessionTabs = new Map<string, WorkspacePage>();
const TAB_KEY = "st-footage.last-tab:";
const CUT_KEY = "st-footage.last-cut:";

export function lastShootTab(root: string): WorkspacePage | undefined {
  const session = sessionTabs.get(root);
  if (session) return session;
  try {
    const value = window.localStorage.getItem(TAB_KEY + root);
    if (value === "ideas" || value === "clips" || value === "precuts") return value;
  } catch { /* Session memory still works when storage is unavailable. */ }
  return undefined;
}

export function rememberShootTab(root: string, page: WorkspacePage): void {
  sessionTabs.set(root, page);
  try { window.localStorage.setItem(TAB_KEY + root, page); } catch { /* Keep the session choice. */ }
}

/** The edit last open on Edits, so reopening a shoot picks up where the person left off. */
export function lastShootCut(root: string): string | undefined {
  try { return window.localStorage.getItem(CUT_KEY + root) ?? undefined; } catch { return undefined; }
}

export function rememberShootCut(root: string, cutId: string): void {
  try { window.localStorage.setItem(CUT_KEY + root, cutId); } catch { /* The shoot still opens on its newest edit. */ }
}

// Opening a shoot is different from explicitly choosing a workspace tab.
// The shell resolves auto after reading real processing and idea state (shootLanding).
export function openShoot(root: string): void {
  go("wait", { shoot: root, view: "auto" });
}

/** WR2: where opening a shoot lands. Still processing: the waiting room. POLISH1: a shoot with edits opens on Edits
 * (its most recent edit: Precuts opens the one last worked on), whatever tab it was left on; Ideas is only where a shoot
 * with no edits yet opens (Footage when it has no ideas either, or the tab it was left on). */
export function shootLanding(progress: { running: boolean; waiting?: { ideasReady: number } } | undefined, ideaCount: number | undefined, remembered?: WorkspacePage, cutCount = 0): Exclude<PageId, "shoots"> {
  if (cutCount > 0) return "precuts";
  if (!progress) return remembered ?? "clips";
  if (progress.running) return "wait";
  if (remembered && remembered !== "precuts") return remembered;
  return (ideaCount ?? progress.waiting?.ideasReady ?? 0) > 0 ? "ideas" : "clips";
}

export interface NavParams {
  shoot?: string;          // shoot root
  view?: "auto"; // temporary workspace state, never a global tab
  clip?: string;           // clip id to open in the drawer
  t?: string;              // seconds into that clip
  tab?: "clips" | "takes" | "script" | "audio";
  q?: string;              // search query
  precut?: string;         // precut prefill, JSON: { kind, attempts: [{clipId,s,e}] }
  control?: string;
  cut?: string;
  v?: string;
  settings?: "general" | "vocabulary" | "output" | "skills" | "ai";
  idea?: string;           // WR2: open this idea on Ideas
}

export interface NavState { page: PageId; params: NavParams }

export function readHash(): NavState {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const page = (PAGE_IDS as string[]).includes(path) ? (path as PageId) : "shoots";
  const params = Object.fromEntries(new URLSearchParams(query)) as NavParams;
  if (path === "skills" || path === "templates") params.settings = "skills";
  return { page, params };
}

export function go(page: PageId, params: NavParams = {}): void {
  const current = readHash();
  const next = { shoot: page === "shoots" ? undefined : current.params.shoot, ...params };
  if (page !== "shoots" && page !== "wait" && next.shoot && !next.view) rememberShootTab(next.shoot, page);
  const q = new URLSearchParams(Object.entries(next).filter(([, v]) => v != null && v !== "") as [string, string][]).toString();
  window.location.hash = `/${page}${q ? `?${q}` : ""}`;
}

export function useNav(): NavState & { go: typeof go } {
  const session = useContext(PageSession);
  const [state, setState] = useState<NavState>(() => readHash());
  useEffect(() => {
    if (session) return;
    const on = () => {
      const next = readHash();
      if (/^#\/?(skills|templates)(\?|$)/.test(window.location.hash)) {
        const query = new URLSearchParams(Object.entries(next.params) as [string, string][]);
        window.history.replaceState(null, "", `#/shoots?${query}`);
      }
      setState(next);
    };
    window.addEventListener("hashchange", on);
    on();
    return () => window.removeEventListener("hashchange", on);
  }, [!!session]);
  return { ...(session?.navigation ?? state), go };
}
