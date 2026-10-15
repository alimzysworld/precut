import type { Clip, SubjectSample } from "../shared/schema";

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));

/** A locked source-pixel rectangle, shared by drafts and future Resolve exports.
 * `s..e` is source time; `out` is the actual output resolution. No IO or mutation.
 * Wide sources retain their full height (and existing headroom). Narrow sources
 * retain their full width; a face, or the head end of a body box, sits a third
 * of the way down that vertical crop where source bounds allow it.
 * A median-sized box must fit at EVERY measured position in the span. If a
 * locked crop cannot hold that movement, return null for the wider fit-over-blur
 * treatment. This also avoids enlarging source pixels more than 1.5 times.
 * Equal aspects return null: fit is already the full frame.
 */
export function cropFor(clip: Clip, s: number, e: number, out: { w: number; h: number }):
  { x: number; y: number; w: number; h: number } | null {
  const width = clip.meta?.width ?? 0, height = clip.meta?.height ?? 0;
  if (![width, height, out.w, out.h].every((n) => Number.isFinite(n) && n > 0) ||
      !Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
  const aspect = out.w / out.h;
  if (Math.abs(width / height - aspect) < 1e-6) return null;
  const w = Math.min(width, height * aspect), h = Math.min(height, width / aspect);
  if (Math.max(out.w / w, out.h / h) > 1.5) return null;

  const valid = (clip.subject?.samples ?? []).filter((p) =>
    [p.t, p.x, p.y, p.w, p.h].every(Number.isFinite) && p.x >= 0 && p.x <= 1 &&
    p.y >= 0 && p.y <= 1 && p.w > 0 && p.w <= 1 && p.h > 0 && p.h <= 1);
  let samples = valid.filter((p) => p.t >= s && p.t <= e);
  // Sub-sample spans still use the closest measured position, never t=0.
  if (!samples.length && valid.length) {
    samples = [valid.reduce((a, b) => Math.abs(a.t - (s + e) / 2) <= Math.abs(b.t - (s + e) / 2) ? a : b)];
  }
  let x = (width - w) / 2, y = (height - h) / 2;
  if (samples.length) {
    const boxW = median(samples.map((p) => p.w)) * width;
    const boxH = median(samples.map((p) => p.h)) * height;
    if (boxW > w + 1e-6 || boxH > h + 1e-6) return null;
    const left = Math.max(0, Math.min(...samples.map((p) => p.x * width - boxW / 2)));
    const right = Math.min(width, Math.max(...samples.map((p) => p.x * width + boxW / 2)));
    const top = Math.max(0, Math.min(...samples.map((p) => p.y * height - boxH / 2)));
    const bottom = Math.min(height, Math.max(...samples.map((p) => p.y * height + boxH / 2)));
    const minX = Math.max(0, right - w), maxX = Math.min(width - w, left);
    const minY = Math.max(0, bottom - h), maxY = Math.min(height - h, top);
    if (minX > maxX + 1e-6 || minY > maxY + 1e-6) return null;
    x = clamp(median(samples.map((p) => p.x)) * width - w / 2, minX, maxX);
    const people = samples.filter((p) => p.kind === "face" || p.kind === "body");
    const headY = (p: SubjectSample) => p.kind === "body" ? p.y - p.h / 2 + p.h * 0.15 : p.y;
    y = clamp(people.length ? median(people.map(headY)) * height - h / 3 :
      median(samples.map((p) => p.y)) * height - h / 2, minY, maxY);
  }
  return { x, y, w, h };
}

export interface CropPath {
  x: number; y: number; w: number; h: number;
  keyframes?: { t: number; x: number }[];
}

// Linear travel with gentle quadratic easing over the first/last 15%. Joins
// have zero velocity; planning and rendering use precisely the same curve.
const easeEnd = 0.15, peak = 1 / (1 - easeEnd);
const ease = (u: number) => u < easeEnd ? u * u / (2 * easeEnd * (1 - easeEnd)) :
  u > 1 - easeEnd ? 1 - (1 - u) ** 2 / (2 * easeEnd * (1 - easeEnd)) :
    (u - easeEnd / 2) / (1 - easeEnd);

/** Measured framing only: no IO, clip classification, or changes to picks.
 * Preserve a locked crop whenever it contains the measured boxes. Otherwise
 * plan a gentle horizontal pan, in source pixels and piece-relative seconds.
 * Boxes are linearly interpolated between detections, including cut boundaries;
 * outside the track we hold the nearest detection. No unmeasured motion is
 * invented. Missing tracks use a centre crop. Only insufficient resolution
 * falls back to blur (invalid geometry is rejected rather than rendered).
 * Physically impossible tracks (oversized boxes or motion beyond the speed
 * limit) receive a bounded best-effort pan, never a switch to blur.
 */
export function cropPathFor(clip: Clip, s: number, e: number, out: { w: number; h: number }): CropPath | null {
  const width = clip.meta?.width ?? 0, height = clip.meta?.height ?? 0;
  if (![width, height, out.w, out.h].every((n) => Number.isFinite(n) && n > 0) ||
      !Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw new Error("Invalid crop geometry or span.");
  const w = Math.min(width, height * out.w / out.h), h = Math.min(height, width * out.h / out.w);
  if (Math.max(out.w / w, out.h / h) > 1.5) return null;
  const valid = (clip.subject?.samples ?? []).filter((p) =>
    [p.t, p.x, p.y, p.w, p.h].every(Number.isFinite) && p.x >= 0 && p.x <= 1 &&
    p.y >= 0 && p.y <= 1 && p.w > 0 && p.w <= 1 && p.h > 0 && p.h <= 1)
    .sort((a, b) => a.t - b.t).filter((p, i, all) => !i || p.t !== all[i - 1].t);
  const still = cropFor(clip, s, e, out);
  if (!valid.length) return still ?? { x: (width - w) / 2, y: (height - h) / 2, w, h };
  const at = (t: number): SubjectSample => {
    const index = valid.findIndex((p) => p.t >= t);
    if (index <= 0) return valid[index === -1 ? valid.length - 1 : 0];
    const a = valid[index - 1], b = valid[index], u = (t - a.t) / (b.t - a.t);
    return { ...a, t, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u,
      w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u };
  };
  const samples = [at(s), ...valid.filter((p) => p.t > s && p.t < e), at(e)];
  const limits = (p: SubjectSample) => {
    const left = Math.max(0, (p.x - p.w / 2) * width);
    const right = Math.min(width, (p.x + p.w / 2) * width);
    const low = Math.max(0, right - w), high = Math.min(width - w, left);
    // An oversized detection cannot fit, but its centre can still be followed.
    const centre = clamp(p.x * width - w / 2, 0, width - w);
    return low <= high ? { low, high } : { low: centre, high: centre };
  };
  const low = Math.max(...samples.map((p) => limits(p).low));
  const high = Math.min(...samples.map((p) => limits(p).high));
  const top = Math.max(0, Math.min(...samples.map((p) => (p.y - p.h / 2) * height)));
  const bottom = Math.min(height, Math.max(...samples.map((p) => (p.y + p.h / 2) * height)));
  const minY = Math.max(0, bottom - h), maxY = Math.min(height - h, top);
  const y = clamp(still?.y ?? median(samples.map((p) => p.y)) * height - h / 3,
    minY <= maxY ? minY : 0, minY <= maxY ? maxY : height - h);
  if (low <= high) return { x: clamp(still?.x ?? median(samples.map((p) => p.x)) * width - w / 2, low, high), y, w, h };

  const speed = w / 3, step = 0.05;
  // Dense planning knots allow anticipation of movement. Reachable intervals
  // propagate future constraints backwards, avoiding a lagging causal tracker.
  const times = [...new Set([0, e - s, ...valid.filter((p) => p.t > s && p.t < e).map((p) => p.t - s),
    ...Array.from({ length: Math.ceil((e - s) / step) }, (_, i) => i * step)])].sort((a, b) => a - b);
  const nodes = times.map((t) => {
    const p = at(s + t), bounds = limits(p);
    // Covers easing's departure from a straight line between dense knots.
    const margin = Math.min(speed * step * 0.1, (bounds.high - bounds.low) / 2);
    return { t, low: bounds.low + margin, high: bounds.high - margin, target: p.x * width - w / 2 };
  });
  const reachable = nodes.map((p) => ({ low: p.low, high: p.high }));
  let feasible = true;
  for (let i = nodes.length - 2; i >= 0; i--) {
    const travel = speed / peak * (nodes[i + 1].t - nodes[i].t);
    reachable[i].low = Math.max(reachable[i].low, reachable[i + 1].low - travel);
    reachable[i].high = Math.min(reachable[i].high, reachable[i + 1].high + travel);
    if (reachable[i].low > reachable[i].high) { feasible = false; break; }
  }
  const keys = nodes.map((p, i) => ({ t: p.t, x: clamp(median(nodes.slice(Math.max(0, i - 5), i + 6).map((n) => n.target)),
    feasible ? reachable[i].low : 0, feasible ? reachable[i].high : width - w) }));
  for (let i = 1; i < keys.length; i++) {
    const travel = speed / peak * (keys[i].t - keys[i - 1].t);
    keys[i].x = clamp(keys[i].x, Math.max(feasible ? reachable[i].low : 0, keys[i - 1].x - travel),
      Math.min(feasible ? reachable[i].high : width - w, keys[i - 1].x + travel));
  }

  // Test the entire interpolated box, not only the detection instants. The
  // difference between eased x and each linear box edge is quadratic at the
  // ends and linear in between. Check each endpoint and derivative root.
  const holds = (a: { t: number; x: number }, b: { t: number; x: number }) => {
    const dt = b.t - a.t, dx = b.x - a.x;
    if (Math.abs(dx) * peak / dt > speed + 1e-7) return false;
    if (!feasible) return true;
    const stops = [a.t, ...times.filter((t) => t > a.t && t < b.t),
      a.t + easeEnd * dt, b.t - easeEnd * dt, b.t].sort((a, b) => a - b)
      .filter((t, i, all) => !i || t !== all[i - 1]);
    for (let i = 1; i < stops.length; i++) {
      const t0 = stops[i - 1], t1 = stops[i];
      const l0 = limits(at(s + t0)), l1 = limits(at(s + t1));
      const probes = [t0, t1];
      for (const edge of ["low", "high"] as const) {
        const slope = (l1[edge] - l0[edge]) / (t1 - t0);
        const root = dx ? slope * dt * easeEnd * (1 - easeEnd) / dx : -1;
        for (const u of [root, 1 - root]) {
          const t = a.t + u * dt;
          if (root >= 0 && root <= easeEnd && t > t0 && t < t1) probes.push(t);
        }
      }
      if (probes.some((t) => {
        const x = a.x + dx * ease((t - a.t) / dt), bounds = limits(at(s + t));
        return x < bounds.low - 1e-6 || x > bounds.high + 1e-6;
      })) return false;
    }
    return true;
  };
  // Furthest valid endpoint first: discard planning knots while preserving
  // containment and the actual eased velocity bound, including at cut ends.
  const keyframes = [keys[0]];
  for (let i = 0; i < keys.length - 1;) {
    let next = i + 1;
    for (let j = keys.length - 1; j > i + 1; j--) if (holds(keys[i], keys[j])) { next = j; break; }
    keyframes.push(keys[next]); i = next;
  }
  return { x: keyframes[0].x, y, w, h, keyframes };
}

/** FFmpeg expression in original source pixels. Caller scales onto its proxy. */
export function cropXExpression(crop: CropPath): string {
  const keys = crop.keyframes;
  if (!keys?.length) return `${crop.x}`;
  let expression = `${keys[keys.length - 1].x}`;
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i], b = keys[i + 1];
    const u = `clip((t-${a.t})/${b.t - a.t},0,1)`;
    const eased = `if(lt(${u},${easeEnd}),${u}*${u}/${2 * easeEnd * (1 - easeEnd)},` +
      `if(gt(${u},${1 - easeEnd}),1-(1-${u})*(1-${u})/${2 * easeEnd * (1 - easeEnd)},` +
      `(${u}-${easeEnd / 2})/${1 - easeEnd}))`;
    expression = `if(lt(t,${b.t}),${a.x}+(${b.x - a.x})*(${eased}),${expression})`;
  }
  return expression;
}
