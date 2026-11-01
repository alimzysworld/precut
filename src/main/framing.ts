import { clipName } from "../shared/clip-name";
import type { Clip, SubjectSample, FramingChoice, CutVersion } from "../shared/schema";
import type { CutItem } from "./export";
import { shakeCorrections, type MotionAnalysis } from "./motion";
import type { CutFraming } from "./preview";

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
  if (keys.length === 1) return `${keys[0].x}`;
  const segment = (a: { t: number; x: number }, b: { t: number; x: number }) => {
    const u = `clip((t-${a.t})/${b.t - a.t},0,1)`;
    const eased = `if(lt(${u},${easeEnd}),${u}*${u}/${2 * easeEnd * (1 - easeEnd)},` +
      `if(gt(${u},${1 - easeEnd}),1-(1-${u})*(1-${u})/${2 * easeEnd * (1 - easeEnd)},` +
      `(${u}-${easeEnd / 2})/${1 - easeEnd}))`;
    return `${a.x}+(${b.x - a.x})*(${eased})`;
  };
  // Balanced lookup like rectExpression: a chain one level per keyframe passed FFmpeg's
  // expression limit on long phone clips ("Missing ')' or too many args"), failing the export.
  const tree = (low: number, high: number): string => {
    if (high - low <= 1) return segment(keys[low], keys[high]);
    const mid = Math.floor((low + high) / 2);
    return `if(lt(t,${keys[mid].t}),${tree(low, mid)},${tree(mid, high)})`;
  };
  return tree(0, keys.length - 1);
}

export type Energy = "off" | "subtle" | "punchy";
export interface EnergyBeat { punched: boolean; elapsed: number; duration: number }

/** Alternate at every visible voice edit, including filler sub-items. B-roll
 * breaks the run; an unsafe punch still consumes its rhythm slot. */
export function energyBeats(cuts: CutItem[], fps: number): (EnergyBeat | undefined)[] {
  let voiceIndex = 0;
  const elapsed = new Map<number, number>(), totals = new Map<number, number>();
  cuts.forEach((c, i) => totals.set(c.piece ?? i, (totals.get(c.piece ?? i) ?? 0) + c.durTimelineFrames / fps));
  return cuts.map((c, i) => {
    if (!c.seg || c.seg.lineIndex === null) { voiceIndex = 0; return undefined; }
    const piece = c.piece ?? i, before = elapsed.get(piece) ?? 0;
    elapsed.set(piece, before + c.durTimelineFrames / fps);
    return { punched: voiceIndex++ % 2 === 1, elapsed: before, duration: totals.get(piece)! };
  });
}

export interface EnergyFraming {
  crop: CropPath | null;
  scale: number; push: number; // scale relative to today's crop; push is additive
  x: number; y: number;       // fraction of the available zoom travel, 0..1
  elapsed: number; duration: number;
  rects?: RectKey[];          // N2a: final composed source rects, piece seconds
  skipReason?: string;
}

/** Conservative head envelope across the entire span, with a held boundary
 * sample on each side. Missing person measurements never authorize a zoom.
 * Face boxes get hair/headroom; body boxes use the upper 35% plus headroom.
 * All zooms are bounded against ORIGINAL pixels, independently of proxies. */
export function energyFraming(clip: Clip, s: number, e: number, out: { w: number; h: number },
  energy: Energy = "subtle", beat?: EnergyBeat): EnergyFraming {
  const crop = cropPathFor(clip, s, e, out);
  const result: EnergyFraming = { crop, scale: 1, push: 0, x: .5, y: .5, elapsed: beat?.elapsed ?? 0, duration: beat?.duration ?? e - s };
  const skipped = (skipReason:string) => ({...result,skipReason});
  if (!crop) return skipped("source too small for this punch");
  if (energy === "off" || !beat) return result;
  const width = clip.meta!.width, height = clip.meta!.height;
  const track = (clip.subject?.samples ?? []).filter(p => (p.kind === "face" || p.kind === "body") &&
    [p.t, p.x, p.y, p.w, p.h].every(Number.isFinite) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 &&
    p.w > 0 && p.w <= 1 && p.h > 0 && p.h <= 1).sort((a, b) => a.t - b.t);
  const samples = [...track.filter(p => p.t >= s && p.t <= e)];
  const before = track.filter(p => p.t < s).at(-1), after = track.find(p => p.t > e);
  if (before) samples.push(before);
  if (after) samples.push(after);
  if (!samples.length) return skipped("no face tracked");
  const xs = crop.keyframes?.map(k => k.x) ?? [crop.x];
  const left = Math.min(...samples.map(p => Math.max(0, (p.x - p.w * (p.kind === "face" ? .65 : .5)) * width))) - Math.max(...xs);
  const right = Math.max(...samples.map(p => Math.min(width, (p.x + p.w * (p.kind === "face" ? .65 : .5)) * width))) - Math.min(...xs);
  const top = Math.min(...samples.map(p => Math.max(0, (p.y - p.h * (p.kind === "face" ? 1 : .55)) * height))) - crop.y;
  const bottom = Math.max(...samples.map(p => Math.min(height, (p.y + p.h * (p.kind === "face" ? .65 : -.15)) * height))) - crop.y;
  // ceil for odd crop geometry: zoompan works on integer source pixels.
  const pixelLimit = Math.min(Math.floor(crop.w) / out.w, Math.floor(crop.h) / out.h);
  const headLimit = Math.min(crop.w / Math.max(1, right - left), crop.h / Math.max(1, bottom - top));
  const limit = Math.min(pixelLimit, headLimit);
  if (left < 0 || top < 0 || right > crop.w || bottom > crop.h) return skipped("tracked head would be cropped");
  if (pixelLimit <= 1) return skipped(width === out.w && height === out.h ? "already at full frame" : "source too small for this punch");
  if (headLimit <= 1) return skipped("tracked head needs the full frame");
  const scale = beat.punched && limit >= 1.15 ? Math.min(energy === "punchy" ? 1.25 : 1.15, limit) : 1;
  const push = beat.duration > 4 ? Math.max(0, Math.min(.06, limit / scale - 1)) : 0;
  const maximum = scale * (1 + push), cw = crop.w / maximum, ch = crop.h / maximum;
  const lowX = Math.max(0, right - cw), highX = Math.min(crop.w - cw, left);
  const lowY = Math.max(0, bottom - ch), highY = Math.min(crop.h - ch, top);
  if (lowX > highX || lowY > highY) return skipped("tracked head would be cropped");
  const faceX = median(samples.map(p => p.x)) * width - median(xs);
  const faceY = median(samples.map(p => p.kind === "body" ? p.y - p.h * .35 : p.y)) * height - crop.y;
  return { ...result, scale, push, ...(beat.punched && scale === 1 ? {skipReason:pixelLimit < 1.15 ? "source too small for this punch" : "tracked head needs more room"} : {}),
    x: crop.w > cw ? clamp(faceX - cw / 2, lowX, highX) / (crop.w - cw) : .5,
    y: crop.h > ch ? clamp(faceY - ch / 3, lowY, highY) / (crop.h - ch) : .5 };
}

export function energyScaleAt(plan: EnergyFraming, t: number): number {
  const u = clamp((t + plan.elapsed) / plan.duration, 0, 1);
  return plan.scale * (1 + plan.push * u * u * (3 - 2 * u));
}

export type SourceRect = { x: number; y: number; w: number; h: number };
export type RectKey = SourceRect & { t: number };
export function framingChoice(version: Pick<CutVersion, "framing" | "pieceFx">, piece: number): FramingChoice {
  return version.pieceFx?.[piece]?.framing ?? version.framing ?? { mode: "off" };
}
export function framingReference(template: { width: number; height: number }, outputHeight = 1080): { w: number; h: number } {
  const ratio = Math.min(outputHeight, template.width, template.height) / Math.min(template.width, template.height);
  return { w: Math.round(template.width * ratio / 2) * 2, h: Math.round(template.height * ratio / 2) * 2 };
}
function joinFace(clip: Clip, t: number): SubjectSample | undefined {
  const valid = (clip.subject?.samples ?? []).filter(p => (p.kind === "face" || p.kind === "body") &&
    [p.t, p.x, p.y, p.w, p.h].every(Number.isFinite) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 && p.w > 0 && p.h > 0);
  const kind = valid.some(p => p.kind === "face") ? "face" : "body", track = valid.filter(p => p.kind === kind).sort((a, b) => a.t - b.t);
  if (!track.length) return;
  const i = track.findIndex(p => p.t >= t);
  let p = track[i < 0 ? track.length - 1 : i];
  if (i > 0) {
    const a = track[i - 1], u = clamp((t - a.t) / (p.t - a.t), 0, 1);
    p = { ...p, x: a.x + (p.x - a.x) * u, y: a.y + (p.y - a.y) * u, h: a.h + (p.h - a.h) * u };
  }
  return kind === "body" ? { ...p, y: p.y - p.h * .35, h: p.h * .32 } : p;
}
export function framingPlans(legacy: { plan: typeof import("./preview").cutFraming; at: typeof import("./preview").framingRectAt },
  cuts: CutItem[], fps: number, out: { w: number; h: number }, energy: Energy,
  faceMatch: CutVersion["faceMatch"], version: Pick<CutVersion, "framing" | "pieceFx"> = {}, motions = new Map<string, MotionAnalysis>(), referenceOut = out): (CutFraming | undefined)[] {
  const plans = legacy.plan(cuts, fps, out, energy, faceMatch);
  const active = cuts.some((c, i) => framingChoice(version, c.piece ?? i).mode !== "off");
  const referencePlans = active && referenceOut !== out ? legacy.plan(cuts, fps, referenceOut, energy, faceMatch) : plans;
  cuts.forEach((cut, i) => {
    const choice = framingChoice(version, cut.piece ?? i);
    const plan = referencePlans[i];
    if (!cut.seg || !plan) return;
    const s = cut.inFrames / (cut.clipFpsR.num / cut.clipFpsR.den), length = cut.durTimelineFrames / fps;
    const previous = cuts[i - 1], oldPlan = plans[i - 1];
    if (choice.mode !== "off" && plan.match && plan.crop && previous?.seg && oldPlan?.crop) {
      const oldS = previous.inFrames / (previous.clipFpsR.num / previous.clipFpsR.den), end = Math.max(0, (previous.durTimelineFrames - 1) / fps);
      const a = joinFace(previous.seg.clip, oldS + end), b = joinFace(cut.seg.clip, s);
      const old = oldPlan.rects ? motionRectAt(oldPlan.rects, end) : legacy.at(oldPlan, end);
      if (a && b && old) {
        const meta = cut.seg.clip.meta!, before = previous.seg.clip.meta!;
        const h = clamp(b.h * meta.height / (a.h * before.height / old.h), referenceOut.h / 1.5, plan.crop.h), w = h * referenceOut.w / referenceOut.h;
        plan.match = { ...plan.match, from: {
          x: clamp(b.x * meta.width - (a.x * before.width - old.x) / old.w * w, 0, meta.width - w),
          y: clamp(b.y * meta.height - (a.y * before.height - old.y) / old.h * h, 0, meta.height - h), w, h } };
      }
    }
    const unchanged = { ...plan };
    motionFraming(cut.seg.clip, s, s + length, referenceOut, fps, choice, plan,
      t => legacy.at(unchanged, t), motions.get(cut.seg.clip.id));
    if (plan.rects) plans[i] = plan;
  });
  return plans;
}
export function validFraming(choice: FramingChoice): boolean {
  return !!choice && ["off", "steady", "face"].includes(choice.mode) &&
    (choice.tight === undefined || Number.isFinite(choice.tight) && choice.tight >= 0 && choice.tight <= 1);
}
export function motionRectAt(keys: RectKey[], t: number): SourceRect {
  let low = 0, high = keys.length - 1;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (keys[mid].t < t) low = mid + 1; else high = mid; }
  const b = keys[low], a = keys[Math.max(0, low - 1)], u = a === b ? 0 : clamp((t - a.t) / (b.t - a.t), 0, 1);
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u,
    w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u };
}

/** Compose once, then share these exact rects between the player and encoder.
 * The caller supplies today's sampler, preserving Off without any arithmetic. */
export function motionFraming(clip: Clip, s: number, e: number, out: { w: number; h: number }, fps: number,
  choice: FramingChoice, plan: EnergyFraming & { match?: { from: SourceRect; duration: number } },
  sampleLegacy: (t: number) => SourceRect | null, motion?: MotionAnalysis): void {
  if (choice.mode === "off" || !plan.crop || choice.mode === "steady" && !motion) return;
  const width = clip.meta!.width, height = clip.meta!.height, aspect = out.w / out.h;
  const minH = Math.max(out.h / 1.5, out.w / 1.5 / aspect), maxH = Math.min(height, width / aspect);
  if (minH > maxH) return;
  const boundedRect = (cx: number, cy: number, h: number): SourceRect => {
    h = clamp(h, minH, maxH); const w = h * aspect;
    return { x: clamp(cx - w / 2, 0, width - w), y: clamp(cy - h / 2, 0, height - h), w, h };
  };
  const times = [...Array.from({ length: Math.ceil((e - s) * fps) }, (_, i) => i / fps), e - s];
  let rects: RectKey[];
  if (choice.mode === "steady" && motion) {
    const corrections = shakeCorrections(motion.samples).map(p => ({ t: p.t, x: p.x * width / motion.width, y: p.y * height / motion.height, w: 0, h: 0 }));
    const desired = times.map(t => {
      const base = sampleLegacy(t)!, delta = motionRectAt(corrections, s + t);
      return { t, ...base, x: base.x + delta.x, y: base.y + delta.y };
    });
    // One minimal constant inset for the span hides every translated border.
    // If resolution limits prevent that inset, bounds take priority over shake.
    const inset = Math.max(0, ...desired.map(r => Math.max(-r.x / aspect, -r.y,
      (r.x + r.w - width) / aspect, r.y + r.h - height)));
    rects = desired.map(r => ({ t: r.t, ...boundedRect(r.x + r.w / 2, r.y + r.h / 2, r.h - 2 * inset) }));
  } else {
    const measured = (clip.subject?.samples ?? []).filter(p => (p.kind === "face" || p.kind === "body") &&
      [p.t, p.x, p.y, p.w, p.h].every(Number.isFinite)).sort((a, b) => a.t - b.t);
    const good = (p: SubjectSample) => p.x - p.w / 2 >= 0 && p.x + p.w / 2 <= 1 &&
      p.y - p.h / 2 >= 0 && p.y + p.h / 2 <= 1 && p.w > 0 && p.h > 0;
    const kind = measured.some(p => p.kind === "face" && good(p)) ? "face" : "body";
    const track = measured.filter(p => p.kind === kind).filter((p, i, all) => !i || p.t !== all[i - 1].t);
    if (!track.some(good)) return;
    const positions: (SubjectSample & { lost?: boolean; heldAt?: number })[] = [];
    let last: SubjectSample | undefined;
    for (const p of track) {
      if (good(p)) { last = kind === "body" ? { ...p, y: p.y - p.h * .35, h: p.h * .32, w: p.w * .6 } : p; positions.push(last); }
      else if (last) positions.push({ ...last, t: p.t, lost: true, heldAt: last.t });
    }
    const at = (t: number) => {
      const i = positions.findIndex(p => p.t >= t);
      if (i <= 0) return positions[i < 0 ? positions.length - 1 : 0];
      const a = positions[i - 1], b = positions[i];
      if (b.lost) return { ...a, lost: true, heldAt: a.heldAt ?? a.t };
      let u = clamp((t - a.t) / (b.t - a.t), 0, 1);
      // Sparse detections ease in and out; dense detections remain continuous.
      if (b.t - a.t > .5 || a.lost) u = u * u * (3 - 2 * u);
      return { ...a, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u,
        h: a.h + (b.h - a.h) * u };
    };
    const target = .16 + .32 * (choice.tight ?? .4);
    rects = times.map(t => {
      const face = at(s + t), scale = energyScaleAt(plan, face.lost ? Math.max(0, (face.heldAt ?? face.t) - s) : t);
      const h = clamp(face.h * height / target / scale, minH, maxH);
      return { t, ...boundedRect(face.x * width, face.y * height + h / 6, h) };
    });
    // Face match remains an entry treatment; the lock then takes over.
    if (plan.match) for (const r of rects) {
      const u = plan.match.duration ? clamp(r.t / plan.match.duration, 0, 1) : r.t > 0 ? 1 : 0, ease = u * u * (3 - 2 * u);
      for (const k of ["x", "y", "w", "h"] as const) r[k] = plan.match.from[k] + (r[k] - plan.match.from[k]) * ease;
    }
  }
  const first = rects[0];
  plan.rects = rects.every(r => ["x", "y", "w", "h"].every(k => Math.abs(r[k as keyof SourceRect] - first[k as keyof SourceRect]) < 1e-8))
    ? [first, { ...first, t: e - s }] : rects;
}

/** Balanced lookup avoids FFmpeg's expression recursion limit on long clips. */
export function rectExpression(keys: RectKey[], axis: "x" | "y" | "w", time = "in_time"): string {
  const tree = (low: number, high: number): string => {
    if (high - low <= 1) {
      const a = keys[low], b = keys[high];
      return a[axis] === b[axis] ? `${a[axis]}` : `(${a[axis]}+${b[axis] - a[axis]}*clip((${time}-${a.t})/${b.t - a.t},0,1))`;
    }
    const mid = Math.floor((low + high) / 2);
    return `if(lt(${time},${keys[mid].t}),${tree(low, mid)},${tree(mid, high)})`;
  };
  return tree(0, keys.length - 1);
}

export function motionFramingFilter(clip: Clip, keys: RectKey[], out: { w: number; h: number }, fps: number, grade?: string): string {
  const { width, height } = clip.meta!;
  // Pad to output aspect so zoompan's x/y/w imply exactly the planned height.
  // Use the planned aspect, including when a 960 px preview rounded its height.
  const aspect = keys[0].w / keys[0].h;
  let unitW = out.w, unitH = out.h;
  for (let h = 1; h <= 8192; h++) {
    const w = Math.round(aspect * h);
    if (w > 0 && Math.abs(w / h - aspect) < 1e-10) { unitW = w; unitH = h; break; }
  }
  const multiple = Math.ceil(Math.max(width / unitW, height / unitH) / 2) * 2;
  const padW = unitW * multiple, padH = unitH * multiple, padX = (padW - width) / 2, padY = (padH - height) / 2;
  return `${grade ? `${grade},` : ""}scale=${width}:${height},format=gbrp,pad=${padW}:${padH}:${padX}:${padY},` +
    `zoompan=z='${padW}/(${rectExpression(keys, "w")})':x='${padX}+${rectExpression(keys, "x")}':y='${padY}+${rectExpression(keys, "y")}':d=1:s=${out.w}x${out.h}:fps=${fps},setsar=1,format=yuv420p`;
}

export const motionReadme = "Steady / face lock is in the finished video, not the Resolve timeline";

/** zoompan consumes one input frame per output frame; no duplicated frames.
 * in_time is piece-relative because the caller resets PTS before framing. */
export function energyZoomFilter(plan: EnergyFraming, out: { w: number; h: number }, fps: number): string {
  const u = `clip((in_time+${plan.elapsed})/${plan.duration},0,1)`;
  const z = `${plan.scale}*(1+${plan.push}*(${u})*(${u})*(3-2*(${u})))`;
  return `zoompan=z='${z}':x='${plan.x}*(iw-iw/zoom)':y='${plan.y}*(ih-ih/zoom)':d=1:s=${out.w}x${out.h}:fps=${fps}`;
}

/** Measured pauses only. Re-intersect existing kept spans with a 120 ms
 * silence budget, protecting every measured word and explicitly kept filler.
 * Idempotent: already removed source time is never put back. */
export function tightenEnergyPauses(cuts: CutItem[], fps: number, kept: string[] = []): CutItem[] {
  let offset = 0;
  const result = cuts.flatMap(cut => {
    if (!cut.seg || cut.seg.lineIndex === null) {
      const next = { ...cut, offsetFrames: offset }; offset += cut.durTimelineFrames; return [next];
    }
    const seg = cut.seg, sourceFps = cut.clipFpsR.num / cut.clipFpsR.den;
    let spans = [{ s: cut.inFrames, e: cut.outFrames }];
    const words = (seg.speechWords ?? (seg.clip.transcript ?? []).flatMap(p => p.words));
    const removed = [...cut.removed ?? []];
    for (const pause of seg.clip.fillers ?? []) {
      if (pause.kind !== "pause" || !Number.isFinite(pause.s) || !Number.isFinite(pause.e) || pause.e <= pause.s ||
        kept.includes(`${seg.clip.id}@${pause.s.toFixed(2)}`)) continue;
      const a = Math.ceil(pause.s * sourceFps - 1e-7), b = Math.floor(pause.e * sourceFps + 1e-7);
      const retained = Math.max(1, Math.round(.12 * sourceFps));
      const start = a + Math.floor(retained / 2), end = b - Math.ceil(retained / 2);
      if (end <= start) continue;
      let ranges = [{ s: start, e: end }];
      const protectedSpans = [...words, ...(seg.clip.fillers ?? []).filter(f => kept.includes(`${seg.clip.id}@${f.s.toFixed(2)}`))];
      for (const word of protectedSpans) {
        if (![word.s, word.e].every(Number.isFinite)) continue;
        const ws = Math.floor(word.s * sourceFps + 1e-7), we = Math.ceil(word.e * sourceFps - 1e-7);
        ranges = ranges.flatMap(r => ws >= r.e || we <= r.s ? [r] :
          [{ s: r.s, e: Math.min(r.e, ws) }, { s: Math.max(r.s, we), e: r.e }].filter(r => r.e > r.s));
      }
      for (const r of ranges) {
        if (!spans.some(p => p.s < r.e && p.e > r.s)) continue;
        if (!removed.some(f => f.kind === "pause" && f.s === pause.s)) removed.push({ ...pause });
        spans = spans.flatMap(p => r.s >= p.e || r.e <= p.s ? [p] :
          [{ s: p.s, e: Math.min(p.e, r.s) }, { s: Math.max(p.s, r.e), e: p.e }].filter(p => p.e > p.s));
      }
    }
    return spans.map((p, i) => {
      const duration = (p.e - p.s) / sourceFps * fps;
      const next = { ...cut, inFrames: p.s, outFrames: p.e, offsetFrames: offset, durTimelineFrames: duration,
        removed: i === 0 && removed.length ? removed : undefined };
      offset += duration; return next;
    });
  });
  // A pause can straddle two existing sub-items. Store its restore marker
  // once, on the first surviving sub-item of the piece, as the splitter does.
  const first = new Map<number, CutItem>();
  result.forEach((c, i) => {
    const piece = c.piece ?? i, anchor = first.get(piece);
    if (!anchor) { first.set(piece, c); return; }
    for (const filler of c.removed ?? []) {
      if (!(anchor.removed ?? []).some(f => f.kind === filler.kind && f.s === filler.s && f.e === filler.e)) {
        anchor.removed = [...anchor.removed ?? [], filler];
      }
    }
    c.removed = undefined;
  });
  return result;
}

export function energyReadme(cuts: CutItem[], fps: number, out: { w: number; h: number }, energy: Energy): string {
  const beats = energyBeats(cuts, fps);
  return [`Energy framing (${energy}), ${out.w}x${out.h}. Scale is relative to the wide crop; positions are source-pixel top-left crop origins. Times are timeline seconds. Push uses smoothstep easing. Recreate these transforms in the editor; FCPXML transforms are pending.`,
    ...cuts.flatMap((c, i) => {
      if (!c.seg || !beats[i]) return [];
      const s = c.inFrames / (c.clipFpsR.num / c.clipFpsR.den), length = c.durTimelineFrames / fps;
      const plan = energyFraming(c.seg.clip, s, s + length, out, energy, beats[i]);
      if (!plan.crop) return [`${clipName(c.seg.clip, { marker: c.seg.marker, s, lengthS: length, timelineS: c.offsetFrames / fps })}: wide fit (${plan.skipReason}).`];
      const crop = plan.crop, keys = crop.keyframes ?? [{ t: 0, x: crop.x }, { t: length, x: crop.x }];
      return keys.map(k => {
        const scale = energyScaleAt(plan, k.t), w = crop.w / scale, h = crop.h / scale;
        return `${clipName(c.seg!.clip, { marker: c.seg!.marker, s, lengthS: length, timelineS: c.offsetFrames / fps })}, source ${(s + k.t).toFixed(3)} s: t=${(c.offsetFrames / fps + k.t).toFixed(3)}, scale=${scale.toFixed(6)}, position=(${(k.x + plan.x * (crop.w - w)).toFixed(3)}, ${(crop.y + plan.y * (crop.h - h)).toFixed(3)}), crop=${w.toFixed(3)}x${h.toFixed(3)}${beats[i]!.punched && plan.scale === 1 && energy !== "off" && plan.skipReason ? ` (punch skipped: ${plan.skipReason})` : ""}.`;
      });
    })].join("\n");
}
