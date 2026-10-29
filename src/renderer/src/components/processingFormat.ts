import type { ShootProgress } from '../../../shared/schema';

export function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0)))}%`;
}
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  return seconds < 60 ? `${Math.max(1, Math.ceil(seconds))} s` : `${Math.max(1, Math.ceil(seconds / 60))} min`;
}
/** One ETA vocabulary across cards, waiting rooms, status and popovers. */
export function formatEta(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  return `Approx ${seconds < 60 ? `${Math.max(1,Math.ceil(seconds/5)*5)} s` : `${Math.max(1,Math.round(seconds/60))} min`}`;
}
export function formatTimeLeft(seconds: number | null, _plain = false): string {
  return formatEta(seconds) ?? 'Working out how long this takes';
}
// Additive bridge until the owner folds overall progress into the shared contract.
export type OverallProcessing = { pct: number; etaS: number | null; running: boolean; complete: boolean; failed?: boolean; ideaCount: number; editCount: number;
  stages: { label: string; state: string; pct: number }[] };
export function processingOverall(progress: ShootProgress | null | undefined): OverallProcessing | undefined {
  return (progress as (ShootProgress & { overall?: OverallProcessing }) | null | undefined)?.overall;
}

/** A tab's dot lights when more results exist than the person has seen. `true` is how older versions stored "seen". */
export const hasNewResults = (count: number | undefined, seen: number | boolean | undefined) => (count ?? 0) > (seen === true ? Infinity : seen || 0);
