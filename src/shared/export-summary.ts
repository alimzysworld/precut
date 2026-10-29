// EXP1: what the export sheet's Done state says, shared with the MCP export tool so both say the same thing.
import type { ExportTarget, SkillFormat } from "./schema";

type Result = { target: ExportTarget; aspect: SkillFormat["aspect"]; ok: boolean; path?: string; error?: string; warnings?: string[] };
export type ExportBatch = { folder: string; results: Result[] };

const parts = (file: string) => file.split(/[\\/]+/).filter(Boolean);
const base = (file: string) => parts(file).at(-1) ?? file;

/** Where exports land, in two plain folder names: "my shoot › sidething precuts". */
export function exportPlace(root: string, exportsFolder: string): string {
  const rootParts = parts(root), folderParts = parts(exportsFolder);
  const inside = rootParts.length > 0 && rootParts.every((part, i) => folderParts[i] === part) && folderParts.length > rootParts.length;
  const shown = inside ? [rootParts.at(-1)!, ...folderParts.slice(rootParts.length)] : folderParts.slice(-2);
  return shown.length > 2 ? `${shown[0]} › … › ${shown.at(-1)}` : shown.join(" › ");
}

/** The folder new exports are made in, from Settings > Output (default: next to the footage). */
export function exportsFolder(root: string, exportFolder: string | null | undefined): string {
  return exportFolder || `${root.replace(/[\\/]+$/, "")}/sidething precuts`;
}

/** Whether a batch was stopped by Cancel, with nothing finished. */
export function exportCanceled(batch: ExportBatch | null | undefined): boolean {
  return !!batch && !batch.results.some(item => item.ok) && (batch.results.length === 0 || batch.results.every(item => item.error === "Canceled"));
}

/** One plain line and the file Show in Finder reveals. */
export function exportSummary(root: string, batch: ExportBatch) {
  const done = batch.results.filter(item => item.ok && item.path);
  const failed = batch.results.filter(item => !item.ok && item.error !== "Canceled");
  // The batch folder sits inside the exports folder; the place names the exports folder.
  const exportsDir = batch.folder ? parts(batch.folder).slice(0, -1).join("/") : "";
  const place = exportPlace(root, (batch.folder.startsWith("/") ? "/" : "") + exportsDir);
  const file = done[0]?.path ?? null;
  const name = file ? base(file) : null;
  const more = done.length > 1 ? ` and ${done.length - 1} more` : "";
  const failures = failed.map(item => `${item.aspect} ${item.target === "mp4" ? "video" : "timeline"} did not export: ${item.error ?? "Try again."}`);
  const line = name ? `Exported ${name}${more}, in ${place}.${failures.length ? ` ${failures.join(" ")}` : ""}`
    : failures.length ? failures.join(" ") : "Nothing was exported.";
  return { ok: done.length > 0, file, name, more: done.length - 1, place, failures, line, warnings: [...new Set(done.flatMap(item => item.warnings ?? []))] };
}
