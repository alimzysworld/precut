// CAP4: a clip's punches between the edit clock and its own source clock. A punch is stored on the source second it
// lands on (PiecePunch.sourceS), so it stays on the same frame of footage when the edit around it moves. The one
// mapping both ways, shared by MCP set_clip_punch (main/motion-edits.ts, on the fx plan's items) and the inspector's
// Punch row and timeline ticks (on the viewer's spans, the same clocks), so a punch made in either is the same record.
import type { PiecePunch } from "./schema";

/** A stretch of one clip on the edit clock: reel startS..endS showing source from inS (or along timeMap). */
export type PunchSpan = { piece?: number; startS: number; endS: number; inS?: number; timeMap?: { t: number; s: number }[]; reverse?: boolean; layer?: number };

function along(keys: { t: number; s: number }[], n: number, x: "t" | "s", y: "t" | "s"): number {
  if (n <= keys[0][x]) return keys[0][y];
  for (let i = 1; i < keys.length; i++) if (n <= keys[i][x]) {
    const a = keys[i - 1], b = keys[i];
    return a[y] + (b[y] - a[y]) * (n - a[x]) / (b[x] - a[x] || 1);
  }
  return keys[keys.length - 1][y];
}
const keysOf = (span: PunchSpan) => span.timeMap?.length ? span.timeMap : [{ t: span.startS, s: span.inS ?? 0 }, { t: span.endS, s: (span.inS ?? 0) + span.endS - span.startS }];
const spansOf = (spans: readonly PunchSpan[], piece: number) => spans.filter(s => s.piece === piece && (s.layer === undefined || s.layer === 0));

/** The source second the clip shows on the frame at reel second t (its own frame clock, as the export draws it),
 * rounded to a microsecond. Throws in plain words when the clip isn't on the picture there or plays backwards. */
export function punchSourceAt(spans: readonly PunchSpan[], piece: number, t: number, fps: number): number {
  const span = spansOf(spans, piece).find(s => t >= s.startS - 1e-6 && t < s.endS - 1e-6);
  if (!span) throw new Error(`That clip isn't on the picture at ${t.toFixed(2)} s.`);
  if (span.reverse) throw new Error("This clip plays backwards; punches and exposure keys need it forwards.");
  return Math.round(along(keysOf(span), span.startS + Math.round((t - span.startS) * fps) / fps, "t", "s") * 1e6) / 1e6;
}

/** The reel second a punch lands on (the frame showing its source second, on the clip's own frame clock), or null
 * when that frame is trimmed away. The same frame main/emphasis-framing.ts craftMotions draws it on. */
export function punchTimeOf(spans: readonly PunchSpan[], piece: number, sourceS: number, fps: number): number | null {
  for (const span of spansOf(spans, piece)) {
    if (span.reverse) continue;
    const keys = keysOf(span), first = keys[0].s, last = keys[keys.length - 1].s;
    if (!(sourceS >= first - 1e-6 && sourceS < last - 1e-6)) continue;
    const atS = span.startS + Math.max(0, Math.round((along(keys, sourceS, "s", "t") - span.startS) * fps)) / fps;
    if (atS < span.endS - 1e-6) return atS;
  }
  return null;
}

/** CAP4: the Punch row's defaults. A punch from the inspector lands at 1.15 and settles (a clear hit, not a slam); a
 * Drift on its own is a slow push from the clip's first frame (scale 1 with creep), the "never park" creep. */
export const PUNCH_ROW = { scale: 1.15, max: 1.6, creepMax: .005, drift: .0006 } as const;
export const sameStoredPunch = (a: PiecePunch, b: PiecePunch) => Math.abs(a.sourceS - b.sourceS) < 1e-6;
