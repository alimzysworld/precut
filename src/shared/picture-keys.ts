// AV4: the picture keys of a draft piece over reel time (its source clock, dissolve opacity, motion blur, framing
// rect), one copy. The Chrome viewer (LivePlayer) draws with them and the Apple player's plan samples them
// (src/shared/apple-playback.ts), so both read the same numbers. Moved here unchanged from LivePlayer.tsx.
import type { DraftPiece } from "./schema";

/** Use the segment to the right at a knot, so a ramp changes rate on that frame. */
export function timeSegment<T extends { t: number }>(points: T[], time: number): [T, T, number] {
  const right = points.findIndex(point => point.t > time);
  const index = right < 0 ? points.length - 1 : Math.max(0, right - 1);
  const a = points[index], b = points[Math.min(index + 1, points.length - 1)];
  return [a, b, Math.max(0, Math.min(1, (time - a.t) / (b.t - a.t || 1)))];
}
export function sourceTime(piece: DraftPiece, time: number) {
  const at = Math.max(piece.startS, Math.min(time, piece.endS));
  if (!piece.timeMap?.length) return piece.inS + at - piece.startS;
  const [a, b, mix] = timeSegment(piece.timeMap, at);
  return a.s + (b.s - a.s) * mix;
}
export function sourceRate(piece: DraftPiece, time: number) {
  if (!piece.timeMap || piece.timeMap.length < 2) return 1;
  const at = Math.max(piece.startS, Math.min(time, piece.endS));
  const points = piece.timeMap;
  const right = points.findIndex(point => point.t > at);
  const index = right < 0 ? points.length - 2 : Math.max(0, right - 1);
  const a = points[index], b = points[index + 1];
  return (b.s - a.s) / (b.t - a.t || 1);
}
export function opacityAt(piece: DraftPiece, time: number) {
  if (!piece.opacity?.length) return 1;
  const [a, b, mix] = timeSegment(piece.opacity, time);
  return Math.max(0, Math.min(1, a.a + (b.a - a.a) * mix));
}
export function blurAt(piece: DraftPiece, time: number) {
  if (!piece.blur?.length) return { amount: 0, angle: 0 };
  const [a, b, mix] = timeSegment(piece.blur, time);
  return { amount: Math.max(0, a.amount + (b.amount - a.amount) * mix), angle: a.angle + (b.angle - a.angle) * mix };
}
export function frameAtTime(piece: DraftPiece, time: number) {
  const frames = piece.frame;
  if (!frames?.length) return null;
  const right = frames.findIndex(frame => frame.t > time);
  if (right === 0) return frames[0];
  if (right < 0) return frames[frames.length - 1];
  const a = frames[right - 1], b = frames[right], mix = (time - a.t) / (b.t - a.t || 1);
  return { x: a.x + (b.x - a.x) * mix, y: a.y + (b.y - a.y) * mix, w: a.w + (b.w - a.w) * mix, h: a.h + (b.h - a.h) * mix };
}
