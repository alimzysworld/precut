// Navigation contract shared by every page. Location lives in the hash:
// #/clips?shoot=<root>&clip=<id>&t=<seconds>&tab=takes
// Pages read params with useNav() and move with nav.go(). Nothing else routes.
import { useEffect, useState } from "react";

export type PageId = "shoots" | "clips" | "ideas" | "precuts";
export const PAGE_IDS: PageId[] = ["shoots", "clips", "ideas", "precuts"];

export interface NavParams {
  shoot?: string;          // shoot root
  clip?: string;           // clip id to open in the drawer
  t?: string;              // seconds into that clip
  tab?: "clips" | "takes" | "script" | "audio";
  q?: string;              // search query
  precut?: string;         // precut prefill, JSON: { kind, attempts: [{clipId,s,e}] }
  cut?: string;
  v?: string;
  settings?: "general" | "autopilot" | "skills" | "music" | "ai" | "processing";
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
  // Opening a shoot starts at Ideas, including the Clips page's no-shoot fallback.
  // A clip deep link still opens the requested clip.
  if (page === "clips" && params.shoot && params.shoot !== current.params.shoot && !params.clip) page = "ideas";
  const next = { shoot: page === "shoots" ? undefined : current.params.shoot, ...params };
  const q = new URLSearchParams(Object.entries(next).filter(([, v]) => v != null && v !== "") as [string, string][]).toString();
  window.location.hash = `/${page}${q ? `?${q}` : ""}`;
}

export function useNav(): NavState & { go: typeof go } {
  const [state, setState] = useState<NavState>(() => readHash());
  useEffect(() => {
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
  }, []);
  return { ...state, go };
}
