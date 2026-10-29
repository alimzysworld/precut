import type { Activity } from "../shared/schema";

export function openEdit(url: string): { root: string; cutId: string; version?: number } | null {
  const [page, query = ""] = url.split("#")[1]?.replace(/^\//, "").split("?") ?? [];
  const params = new URLSearchParams(query), root = params.get("shoot"), cutId = params.get("cut");
  if (page !== "precuts" || !root || !cutId) return null;
  const version = Number(params.get("v"));
  return { root, cutId, ...(version > 0 && Number.isInteger(version) ? { version } : {}) };
}
// The explicit onboarding samples are independent of an edit's gallery.
export function isSetupPreview(url: string): boolean {
  const [page, query = ""] = url.split("#")[1]?.replace(/^\//, "").split("?") ?? [];
  const params = new URLSearchParams(query);
  return (!page || page === "shoots") && !params.has("shoot") && !params.has("cut");
}
export function staleLookWork(activity: Activity, urls: string[]): boolean {
  if (activity.state !== "running" || activity.kind !== "looks" || !activity.root ||
    !/^(Preparing look previews|Measuring clip colour)/.test(activity.label)) return false;
  return !urls.some(url => {
    if (!activity.target?.cutId && isSetupPreview(url)) return true;
    const edit = openEdit(url);
    return edit?.root === activity.root && edit?.cutId === activity.target?.cutId &&
      (!edit?.version || !activity.target?.version || edit.version === activity.target.version);
  });
}
