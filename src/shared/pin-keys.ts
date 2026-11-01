// TRK1 (docs/plans/produced/tracking-spike.md): text locked to a thing in the shot. One sampler for the Chrome viewer,
// the Apple plan and the export title page, so all three place a pinned item on the same numbers. Pure: no node, no DOM.
// A pin lives in the clip's source space and time, so trims, speed and reframing never break it.
import type { DraftPiece } from "./schema";
import { sourceTime, sourceRate, frameAtTime } from "./picture-keys";
import { transformGeometry } from "./clip-transform";

export type TrackMode = "object" | "plane";
export type TrackLossWhy = "left" | "covered" | "fast" | "lost";
export interface TrackLoss { atS: number; why: TrackLossWhy }
/** A tracked frame: [source seconds, x, y, w, h, confidence], top-left box normalised to the oriented source picture.
 * Confidence -1 = the tracker gave up on that frame. */
export type TrackFrame = [number, number, number, number, number, number];
/** The raw track as cached at <shoot>/.sidething/tracks/<key>.json (src/main/tracking/track.ts). */
export interface TrackFile {
  version: string; key: string; clipId: string; mode: TrackMode;
  fps: number;                                  // the clip's frame rate
  width: number; height: number;                // the tracker's oriented decode size (long side 1920): smoothing works in these pixels
  s: number; e: number; pickS: number;          // source seconds
  frames: TrackFrame[];                         // ascending time, both directions from the pick
  corners?: number[][];                         // plane: per frame TL, TR, BR, BL as [x0, y0, ... x3, y3]
  area?: (number | null)[];                     // plane: area ratio to the frame tracked just before it
  lost?: TrackLoss;                             // lost after the pick: frames from atS on are not used
  lostBefore?: TrackLoss;                       // lost before the pick: frames up to atS are not used
  speed?: number;                               // frames tracked per second on this Mac
}
export interface TrackRef { clipId: string; mode: TrackMode; s: number; e: number; box?: { x: number; y: number; w: number; h: number }; corners?: number[][]; key?: string }
/** The knobs (spike's table). The item's own x, y, w (or size) stay its placement at the pick frame. */
export interface PinChoice {
  track: TrackRef;                              // enough to track again when the cache is cleared
  pickS: number;                                // source seconds of the pick frame
  surface: "object" | "flat";
  offset: { x: number; y: number };             // object units from the thing's centre, -2..2
  size: number;                                 // word width as a share of the object, 0.1..3
  followScale: number;                          // 0..1
  followRotation: boolean;
  steadiness: number;                           // 0..100 (2.0 to 0.2 Hz zero-phase)
  lead: number;                                 // frames, -3..3, + = earlier
  fade: number;                                 // frames, 0..12
  exit: "auto" | "hold" | "carry";
  behind: boolean;                              // behind hands (person matte)
  lost?: TrackLoss;
  thing?: string;                               // TRK1b: what it is in plain words ("cup"), for the loss line
}
export interface PinKey { x: number; y: number; scale: number; rotate: number; opacity: number; w: number; corners?: number[][] }

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
export const PIN_RANGES = { offset: [-2, 2], size: [0.1, 3], followScale: [0, 1], steadiness: [0, 100], lead: [-3, 3], fade: [0, 12] } as const;
const LOSS_WHY: TrackLossWhy[] = ["left", "covered", "fast", "lost"];

/** Clamps every knob to its range and fills what is missing with the surface's defaults; a wrong shape throws. */
export function sanitizePin(value: unknown): PinChoice | undefined {
  if (value == null) return undefined;
  const fail = (): never => { throw new Error("Choose a valid pin: a picked thing in the clip and knobs from the list."); };
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!object(value) || !object(value.track)) return fail();
  const v = value as Record<string, unknown>, t = value.track as Record<string, unknown>;
  if (typeof t.clipId !== "string" || !t.clipId || t.clipId.length > 200 || (t.mode !== "object" && t.mode !== "plane") ||
    !finite(t.s) || !finite(t.e) || t.s < 0 || t.e <= t.s || !finite(v.pickS)) return fail();
  const track: TrackRef = { clipId: t.clipId, mode: t.mode, s: t.s, e: t.e };
  if (t.corners !== undefined) {
    if (!Array.isArray(t.corners) || t.corners.length !== 4 || !t.corners.every(p => Array.isArray(p) && p.length === 2 && p.every(finite))) return fail();
    track.corners = (t.corners as number[][]).map(p => [clamp(p[0], 0, 1), clamp(p[1], 0, 1)]);
  } else if (object(t.box) && [t.box.x, t.box.y, t.box.w, t.box.h].every(finite)) {
    const b = t.box as { x: number; y: number; w: number; h: number }, x = clamp(b.x, 0, 1), y = clamp(b.y, 0, 1);
    track.box = { x, y, w: clamp(b.w, 0, 1 - x), h: clamp(b.h, 0, 1 - y) };
    if (track.box.w <= 0 || track.box.h <= 0) return fail();
  } else return fail();
  if (t.key !== undefined) { if (typeof t.key !== "string" || !/^[a-f0-9]{64}$/.test(t.key)) return fail(); track.key = t.key; }
  const surface = v.surface === undefined ? (track.mode === "plane" ? "flat" : "object") : v.surface;
  if (surface !== "object" && surface !== "flat") return fail();
  const flat = surface === "flat";
  const num = (n: unknown, [lo, hi]: readonly [number, number], fallback: number) => n === undefined ? fallback : finite(n) ? clamp(n, lo, hi) : fail();
  const bool = (n: unknown, fallback: boolean) => n === undefined ? fallback : typeof n === "boolean" ? n : fail();
  const offset = v.offset === undefined ? { x: 0, y: 0 } : object(v.offset) ? { x: num(v.offset.x, PIN_RANGES.offset, 0), y: num(v.offset.y, PIN_RANGES.offset, 0) } : fail();
  const exit = v.exit === undefined ? "auto" : v.exit;
  if (exit !== "auto" && exit !== "hold" && exit !== "carry") return fail();
  const pin: PinChoice = { track, pickS: clamp(v.pickS as number, track.s, track.e), surface, offset,
    size: num(v.size, PIN_RANGES.size, 0.6), followScale: num(v.followScale, PIN_RANGES.followScale, flat ? 1 : 0.5),
    followRotation: bool(v.followRotation, flat), steadiness: num(v.steadiness, PIN_RANGES.steadiness, 50),
    lead: num(v.lead, PIN_RANGES.lead, 0), fade: Math.round(num(v.fade, PIN_RANGES.fade, 4)), exit, behind: bool(v.behind, false) };
  if (object(v.lost) && finite(v.lost.atS) && LOSS_WHY.includes(v.lost.why as TrackLossWhy)) pin.lost = { atS: v.lost.atS, why: v.lost.why as TrackLossWhy };
  if (typeof v.thing === "string") { const thing = v.thing.replace(/[^\p{L}\p{N} '-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40); if (thing) pin.thing = thing; }
  return pin;
}

/** "Lost it at 0:02: the cup left the frame". atS on whatever clock the label shows (the item's reel time). */
export function lostText(loss: Pick<TrackLoss, "why">, atS: number, thing = "it") {
  const name = thing.trim().replace(/^the\s+/i, "") || "it", subject = name === "it" ? "it" : `the ${name}`;
  const s = Math.max(0, Math.floor(atS + 1e-6));
  const cause = loss.why === "left" ? "left the frame" : loss.why === "covered" ? "was covered" : loss.why === "fast" ? "moved too fast to follow" : "went out of view";
  return `Lost it at ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}: ${subject} ${cause}`;
}

// ---- smoothing: zero-phase one-euro (TRK0: forward then backward beats every causal and windowed filter)
/** steadiness 0 = 2.0 Hz, 50 = 0.7 Hz, 100 = 0.2 Hz, geometric in between. */
export function steadinessHz(steadiness: number) {
  const s = clamp(finite(steadiness) ? steadiness : 50, 0, 100);
  return s <= 50 ? 2 * (0.7 / 2) ** (s / 50) : 0.7 * (0.2 / 0.7) ** ((s - 50) / 50);
}
export function oneEuro(x: ArrayLike<number>, fps: number, minCutoff: number, beta = 0.02, dCutoff = 1): Float64Array {
  const alpha = (cut: number) => 1 / (1 + fps / (2 * Math.PI * cut));
  const y = Float64Array.from(x as ArrayLike<number>);
  let dx = 0;
  for (let i = 1; i < y.length; i++) {
    dx += alpha(dCutoff) * ((x[i] - y[i - 1]) * fps - dx);
    y[i] = y[i - 1] + alpha(minCutoff + beta * Math.abs(dx)) * (x[i] - y[i - 1]);
  }
  return y;
}
export function zeroPhase(x: ArrayLike<number>, fps: number, hz: number, beta = 0.02): Float64Array {
  return oneEuro(oneEuro(x, fps, hz, beta).reverse(), fps, hz, beta).reverse();
}

/** The good part of a track (between its losses), smoothed once per steadiness, in tracker pixels. */
export interface PinSeries {
  t: Float64Array; cx: Float64Array; cy: Float64Array; bw: Float64Array; bh: Float64Array; ang: Float64Array; qw: Float64Array;
  q: Float64Array[] | null; W: number; H: number; dt: number;
}
const seriesMemo = new WeakMap<TrackFile, Map<number, PinSeries | null>>();
export function goodRange(track: TrackFile): [number, number] {
  const f = track.frames;
  let a = 0, b = f.length - 1;
  if (track.lostBefore) while (a <= b && f[a][0] <= track.lostBefore.atS + 1e-6) a++;
  if (track.lost) while (b >= a && f[b][0] >= track.lost.atS - 1e-6) b--;
  return [a, b];
}
export function pinSeries(track: TrackFile, steadiness = 50): PinSeries | null {
  let memo = seriesMemo.get(track);
  if (!memo) seriesMemo.set(track, memo = new Map());
  if (memo.has(steadiness)) return memo.get(steadiness)!;
  const [a, b] = goodRange(track), W = track.width, H = track.height, fps = track.fps > 0 ? track.fps : 25;
  let result: PinSeries | null = null;
  if (b >= a) {
    const n = b - a + 1, hz = steadinessHz(steadiness), col = () => new Float64Array(n);
    const t = col(), cx = col(), cy = col(), bw = col(), bh = col(), ang = col(), qw = col(), corners = track.corners;
    const q = corners ? Array.from({ length: 8 }, col) : null;
    for (let i = 0; i < n; i++) {
      const [time, x, y, w, h] = track.frames[a + i];
      t[i] = time; bw[i] = w * W; bh[i] = h * H; cx[i] = (x + w / 2) * W; cy[i] = (y + h / 2) * H; qw[i] = bw[i];
      const c = corners?.[a + i];
      if (q && c) {
        for (let k = 0; k < 8; k++) q[k][i] = c[k] * (k % 2 ? H : W);
        cx[i] = (q[0][i] + q[2][i] + q[4][i] + q[6][i]) / 4; cy[i] = (q[1][i] + q[3][i] + q[5][i] + q[7][i]) / 4;
        const ex = (q[2][i] - q[0][i] + q[4][i] - q[6][i]) / 2, ey = (q[3][i] - q[1][i] + q[5][i] - q[7][i]) / 2;
        ang[i] = Math.atan2(ey, ex) * 180 / Math.PI; qw[i] = Math.hypot(ex, ey);
      }
    }
    // TRK1b: the speed term scales with the cutoff, so steadiness also calms a thing that keeps moving (at 50 it is TRK0's
    // 0.02; at 90 a quarter of that: smoother, and it floats more on a fast move).
    const sm = (v: Float64Array) => zeroPhase(v, fps, hz, 0.02 * hz / 0.7);
    result = { t, cx: sm(cx), cy: sm(cy), bw: sm(bw), bh: sm(bh), ang: q ? sm(unwrap(ang)) : ang, qw: sm(qw), q: q ? q.map(sm) : null, W, H, dt: 1 / fps };
  }
  memo.set(steadiness, result);
  return result;
}
function unwrap(a: Float64Array) {
  for (let i = 1; i < a.length; i++) while (Math.abs(a[i] - a[i - 1]) > 180) a[i] -= Math.sign(a[i] - a[i - 1]) * 360;
  return a;
}
/** Index i with t[i] <= time < t[i+1] (clamped), O(log n). */
function seek(t: Float64Array, time: number) {
  let lo = 0, hi = t.length - 1;
  if (time <= t[0]) return 0;
  if (time >= t[hi]) return hi;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= time) lo = mid; else hi = mid; }
  return lo;
}
function sample(series: PinSeries, time: number) {
  const { t } = series, i = seek(t, time), j = Math.min(i + 1, t.length - 1), u = j > i ? clamp((time - t[i]) / (t[j] - t[i]), 0, 1) : 0;
  const at = (v: Float64Array) => v[i] + (v[j] - v[i]) * u;
  return { cx: at(series.cx), cy: at(series.cy), bw: at(series.bw), bh: at(series.bh), ang: at(series.ang), qw: at(series.qw), q: series.q?.map(at) ?? null };
}

// ---- source space to the frame
/** The reel second at which a piece shows source second s (clamped to the piece). */
export function reelTime(piece: DraftPiece, s: number) {
  const map = piece.timeMap;
  if (!map?.length) return clamp(piece.startS + s - piece.inS, piece.startS, piece.endS);
  for (let i = 0; i + 1 < map.length; i++) {
    const a = map[i], b = map[i + 1], lo = Math.min(a.s, b.s), hi = Math.max(a.s, b.s);
    if (s >= lo - 1e-9 && s <= hi + 1e-9) return clamp(b.s === a.s ? a.t : a.t + (s - a.s) / (b.s - a.s) * (b.t - a.t), piece.startS, piece.endS);
  }
  return Math.abs(s - map[0].s) <= Math.abs(s - map[map.length - 1].s) ? piece.startS : piece.endS;
}
/** A point in the oriented, normalised source picture to the frame (fractions), as LivePlayer draws the piece at
 * reel time t: framing rect (or fitted), then the clip transform. */
export function sourceToFrame(piece: DraftPiece, t: number, x: number, y: number, sourceAspect: number, frameAspect?: number) {
  let rect = frameAtTime(piece, t);
  const out = frameAspect ?? (rect ? sourceAspect * rect.w / rect.h : sourceAspect);
  if (piece.frame?.length === 0) {
    const w = Math.min(1, out / sourceAspect), h = Math.min(1, sourceAspect / out);
    rect = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }
  let u: number, v: number;
  if (rect) { u = (x - rect.x) / rect.w; v = (y - rect.y) / rect.h; }
  else {
    const fx = sourceAspect > out ? 1 : sourceAspect / out, fy = sourceAspect > out ? out / sourceAspect : 1;
    u = (x - 0.5) * fx + 0.5; v = (y - 0.5) * fy + 0.5;
  }
  if (!piece.transform) return { x: u, y: v };
  // clip-transform.ts transformPoint, run forwards.
  const g = transformGeometry(piece.transform, out);
  if (g.flipH) u = 1 - u;
  if (g.flipV) v = 1 - v;
  const a = (u - 0.5) * g.aspect * g.scale, b = (v - 0.5) * g.scale;
  return { x: (g.c * a - g.s * b) / g.aspect + 0.5 + g.x, y: g.s * a + g.c * b + 0.5 + g.y };
}
/** How the picture shows a source point at reel time t: its frame position, the frame widths one source width
 * becomes there, and the turn (degrees) of the source's x axis. */
function shown(piece: DraftPiece, t: number, x: number, y: number, sourceAspect: number, frameAspect?: number) {
  const rect = frameAtTime(piece, t), out = frameAspect ?? (rect ? sourceAspect * rect.w / rect.h : sourceAspect);
  const p = sourceToFrame(piece, t, x, y, sourceAspect, out), d = 1e-3, q = sourceToFrame(piece, t, x + d, y, sourceAspect, out);
  const dx = q.x - p.x, dy = (q.y - p.y) / out;
  return { ...p, scale: Math.hypot(dx, dy) / d, turn: Math.atan2(dy, dx) * 180 / Math.PI };
}
/** Unit square (u, v) to a quad TL, TR, BR, BL (Heckbert's square-to-quad projective map). */
function quadPoint(q: number[], u: number, v: number) {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let a: number, b: number, c: number, d: number, e: number, f: number, g = 0, h = 0;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) { a = x1 - x0; b = x2 - x1; c = x0; d = y1 - y0; e = y2 - y1; f = y0; }
  else {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, den = dx1 * dy2 - dx2 * dy1 || 1e-12;
    g = (sx * dy2 - dx2 * sy) / den; h = (dx1 * sy - sx * dy1) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0; d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
    const w = g * u + h * v + 1;
    return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
  }
  // Affine (parallelogram): TL + u (TR - TL) + v (BR - TR).
  return [a * u + b * v + c, d * u + e * v + f];
}

/**
 * Where a pinned item sits at reel time reelT: its anchor (x, y, frame fractions), scale and turn relative to the pick
 * frame as this piece shows it (multiply the item's own w or size, add to its rotate), its pin opacity (the loss fade),
 * w (the item width the size knob asks for, frame fractions) and, on a flat surface, the surface's corners in the frame.
 * frame = the reel's size (needed only for a fitted picture: framing keys carry their own shape). Null without a pin.
 */
/** TRK1b: the source frame the picture shows at reel time t, when the reel runs at fps: a clip frame is shown from the
 * output frame nearest its own time (the encoder's rounding), so the pin steps with the picture instead of gliding
 * between the clip's frames (a 25 fps cup in a 60 fps edit holds each frame for two or three). */
export function shownSource(track: TrackFile, piece: DraftPiece, t: number, fps?: number) {
  return shownFrame(track, sourceTime(piece, t), sourceRate(piece, t), fps);
}
export function pinAt(item: { pin?: PinChoice | null }, piece: DraftPiece, reelT: number, track: TrackFile, frame?: { width: number; height: number; fps?: number }): PinKey | null {
  const pin = item.pin;
  if (!pin) return null;
  const series = pinSeries(track, pin.steadiness);
  if (!series) return null;
  const { t, W, H, dt } = series, n = t.length, aspect = W / H, out = frame ? frame.width / frame.height : undefined;
  const at = shownSource(track, piece, reelT, frame?.fps) + pin.lead * dt;
  // Each end of the good part: past it (k frames, negative inside) the stated exit plays when the track was lost there.
  const ending = (forward: boolean, loss: TrackLoss | undefined) => {
    const edge = forward ? n - 1 : 0, back = forward ? Math.max(0, n - 3) : Math.min(n - 1, 2), span = Math.abs(edge - back) || 1;
    const velocity = (v: Float64Array) => (v[edge] - v[back]) / span, k = (forward ? at - t[n - 1] : t[0] - at) / dt;
    // Heads for the edge: the box touched it before the loss, or its last velocity leaves the frame within the fade.
    const heading = !!loss && (loss.why === "left" || [0, 1].some(axis => {
      const c = axis ? series.cy : series.cx, half = (axis ? series.bh : series.bw)[edge] / 2, moved = c[edge] + velocity(c) * Math.max(1, pin.fade);
      return moved - half < 0 || moved + half > (axis ? H : W);
    }));
    const carry = pin.exit === "carry" || pin.exit === "auto" && heading, early = pin.exit === "auto" && heading ? 2 : 0;
    const opacity = !loss ? 1 : pin.fade > 0 ? clamp(1 - (k + early) / pin.fade, 0, 1) : k > 0 ? 0 : 1;
    return { velocity, k, carry: !!loss && carry && k > 0, opacity };
  };
  const ahead = ending(true, track.lost), behind = ending(false, track.lostBefore);
  const s = sample(series, at), past = ahead.k > 0 ? ahead : behind.k > 0 ? behind : null;
  if (past?.carry) {
    const move = (v: Float64Array) => past.velocity(v) * past.k;
    s.cx += move(series.cx); s.cy += move(series.cy);
    if (s.q && series.q) s.q = s.q.map((v, i) => v + move(series.q![i]));
  }
  const opacity = Math.min(ahead.opacity, behind.opacity);
  const p0 = sample(series, pin.pickS), fs = pin.followScale;
  const flat = pin.surface === "flat" && !!s.q && !!p0.q;
  let X: number, Y: number, follow: number, turn = 0, width: number;
  if (flat) {
    [X, Y] = quadPoint(s.q!, 0.5 + pin.offset.x, 0.5 + pin.offset.y);
    follow = (s.qw / p0.qw) ** fs; width = pin.size * p0.qw / W;
  } else {
    follow = (s.bw / p0.bw) ** fs; width = pin.size * p0.bw / W;
    X = s.cx + pin.offset.x * s.bw ** fs * p0.bw ** (1 - fs);
    Y = s.cy + pin.offset.y * s.bh ** fs * p0.bh ** (1 - fs);
  }
  if (pin.followRotation && s.q) turn = s.ang - p0.ang;
  const now = shown(piece, reelT, X / W, Y / H, aspect, out), pickT = reelTime(piece, pin.pickS);
  const ref = shown(piece, pickT, p0.cx / W, p0.cy / H, aspect, out);
  const key: PinKey = { x: now.x, y: now.y, scale: follow * now.scale / ref.scale, rotate: turn + now.turn - ref.turn, opacity, w: width * follow * now.scale };
  if (flat && s.q) key.corners = [0, 1, 2, 3].map(k => { const p = sourceToFrame(piece, reelT, s.q![2 * k] / W, s.q![2 * k + 1] / H, aspect, out); return [p.x, p.y]; });
  return key;
}

// ---- locked frame: the picture moves so the thing stays still
/** exact: hold every tracked frame as tracked (TRK2: a lock cancels the hand's shake, which smoothing would keep; the
 * size, for keep size, is still smoothed so the zoom never flickers). span: the source seconds the picture shows, so
 * the zoom pays only for what is seen. */
export interface LockChoice { anchor?: "picked" | "least"; scale?: boolean; maxZoom?: number; steadiness?: number; pickS?: number; exact?: boolean; span?: [number, number] }
export interface LockKey { scale: number; x: number; y: number; zoom: number; need: number; capped: boolean }
interface LockPlan { zoom: number; need: number; capped: boolean; ax: number; ay: number; w0: number; series: PinSeries }
const lockMemo = new WeakMap<TrackFile, Map<string, LockPlan | null>>();
/** The track's good part with its centres as tracked (no smoothing) and its sizes smoothed lightly. */
const exactMemo = new WeakMap<TrackFile, PinSeries | null>();
function exactSeries(track: TrackFile): PinSeries | null {
  if (exactMemo.has(track)) return exactMemo.get(track)!;
  const smooth = pinSeries(track, 0);
  let result: PinSeries | null = null;
  if (smooth) {
    const [a] = goodRange(track), n = smooth.t.length, cx = new Float64Array(n), cy = new Float64Array(n), { W, H } = smooth;
    for (let i = 0; i < n; i++) {
      const [, x, y, w, h] = track.frames[a + i], c = track.corners?.[a + i];
      if (c?.length === 8) { cx[i] = (c[0] + c[2] + c[4] + c[6]) / 4 * W; cy[i] = (c[1] + c[3] + c[5] + c[7]) / 4 * H; }
      else { cx[i] = (x + w / 2) * W; cy[i] = (y + h / 2) * H; }
    }
    result = { ...smooth, cx, cy };
  }
  exactMemo.set(track, result);
  return result;
}
function lockPlan(track: TrackFile, lock: LockChoice): LockPlan | null {
  const id = JSON.stringify([lock.anchor ?? "picked", !!lock.scale, lock.maxZoom ?? 1.25, lock.steadiness ?? 50, lock.pickS ?? track.pickS, !!lock.exact, lock.span ?? null]);
  let memo = lockMemo.get(track);
  if (!memo) lockMemo.set(track, memo = new Map());
  if (memo.has(id)) return memo.get(id)!;
  const series = lock.exact ? exactSeries(track) : pinSeries(track, lock.steadiness ?? 50);
  let plan: LockPlan | null = null;
  if (series) {
    const p = sample(series, lock.pickS ?? track.pickS), all = series.t.length;
    // Only the frames the picture shows count towards the zoom (all of them when the span misses the track).
    let from = 0, to = all - 1;
    if (lock.span) {
      const [s, e] = lock.span, first = series.t.findIndex(t => t >= s - 1e-6);
      let last = all - 1; while (last >= 0 && series.t[last] > e + 1e-6) last--;
      if (first >= 0 && last >= first) { from = first; to = last; }
    }
    const k = Array.from({ length: all }, (_, i) => lock.scale ? p.bw / series.bw[i] : 1);
    // Zoom so the moved picture still covers the frame: Z >= A / (k c) and Z >= (1 - A) / (k (1 - c)) every frame.
    const need = (c: Float64Array, size: number, a: number) => {
      let z = 1;
      for (let i = from; i <= to; i++) { const x = clamp(c[i] / size, 1e-6, 1 - 1e-6); z = Math.max(z, a / (k[i] * x), (1 - a) / (k[i] * (1 - x))); }
      return z;
    };
    const least = (c: Float64Array, size: number) => {
      let lo = 0, hi = 1;
      for (let i = 0; i < 80; i++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (need(c, size, m1) <= need(c, size, m2)) hi = m2; else lo = m1; }
      return (lo + hi) / 2;
    };
    const picked = lock.anchor !== "least";
    const ax = picked ? clamp(p.cx / series.W, 0, 1) : least(series.cx, series.W), ay = picked ? clamp(p.cy / series.H, 0, 1) : least(series.cy, series.H);
    const z = Math.max(need(series.cx, series.W, ax), need(series.cy, series.H, ay)), max = clamp(lock.maxZoom ?? 1.25, 1, 2);
    plan = { need: z, zoom: Math.min(z, max), capped: z > max + 1e-9, ax, ay, w0: p.bw, series };
  }
  memo.set(id, plan);
  return plan;
}
/** The locked frame at source second sourceS, in the normalised source picture: a point p shows at scale * p + (x, y).
 * zoom is what holding the anchor costs, capped at maxZoom (default 1.25); capped = it holds as far as that zoom allows,
 * and the picture still covers the frame every frame (no black edges). */
export function lockAt(track: TrackFile, lock: LockChoice, sourceS: number): LockKey | null {
  const plan = lockPlan(track, lock);
  if (!plan) return null;
  const s = sample(plan.series, sourceS), k = lock.scale ? plan.w0 / s.bw : 1;
  let scale = plan.zoom * k;
  if (plan.capped) scale = Math.max(1, scale);
  let x = plan.ax - scale * s.cx / plan.series.W, y = plan.ay - scale * s.cy / plan.series.H;
  if (plan.capped) { x = clamp(x, 1 - scale, 0); y = clamp(y, 1 - scale, 0); }
  return { scale, x, y, zoom: plan.zoom, need: plan.need, capped: plan.capped };
}
/** A framing rect (normalised source) as the locked picture shows it: the source rect under it. Inside the source
 * whenever the rect is inside the frame and the key covers it. */
export function lockRect<R extends { x: number; y: number; w: number; h: number }>(rect: R, key: Pick<LockKey, "scale" | "x" | "y">): R {
  return { ...rect, x: (rect.x - key.x) / key.scale, y: (rect.y - key.y) / key.scale, w: rect.w / key.scale, h: rect.h / key.scale };
}
/** The source frame a picture shows at a reel moment (see shownSource): source second s, playing at rate source seconds
 * per reel second, in a reel of fps. Without a frame rate, s itself. */
export function shownFrame(track: TrackFile, s: number, rate: number, fps?: number) {
  const f = track.frames;
  if (!(fps! > 0) || !f.length) return s;
  const half = 0.5 * Math.abs(rate) / fps! + 1e-6;
  if (s < f[0][0] - half || s > f[f.length - 1][0] + 1 / Math.max(1, track.fps) + half) return s;
  let lo = 0, hi = f.length - 1;
  if (rate >= 0) { while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (f[mid][0] <= s + half) lo = mid; else hi = mid - 1; } return f[lo][0]; }
  while (lo < hi) { const mid = (lo + hi) >> 1; if (f[mid][0] >= s - half) hi = mid; else lo = mid + 1; }
  return f[lo][0];
}

/** TRK2: a clip's locked frame as saved (PieceFx.lock): the picked thing, enough to track it again, and the knobs. */
export interface PieceLock {
  track: TrackRef;                              // the thing, in the clip's source space (box, or four corners on a flat thing)
  pickS: number;                                // source seconds of the pick frame
  anchor: "picked" | "least";                   // where it is held: where it was when picked, or wherever costs least zoom
  scale: boolean;                               // keep size: the thing also keeps its size (costs more zoom)
  maxZoom: number;                              // 1..2, default 1.25: it locks as far as this allows and says what a full lock needs
  thing?: string;
}
export const LOCK_DEFAULTS = { anchor: "least", scale: false, maxZoom: 1.25 } as const;
/** Clamps the knobs, fills the defaults; a wrong shape throws. */
export function sanitizeLock(value: unknown): PieceLock | undefined {
  if (value == null) return undefined;
  const fail = (): never => { throw new Error("Choose a valid lock: a picked thing in the clip and knobs from the list."); };
  const v = value as Record<string, unknown>;
  if (typeof v !== "object" || Array.isArray(v)) return fail();
  // The pin's own checks for the track and its pick.
  const pin = sanitizePin({ track: v.track, pickS: v.pickS })!;
  const anchor = v.anchor === undefined ? LOCK_DEFAULTS.anchor : v.anchor;
  if (anchor !== "picked" && anchor !== "least") return fail();
  if (v.scale !== undefined && typeof v.scale !== "boolean") return fail();
  if (v.maxZoom !== undefined && !finite(v.maxZoom)) return fail();
  const lock: PieceLock = { track: pin.track, pickS: pin.pickS, anchor, scale: (v.scale as boolean | undefined) ?? LOCK_DEFAULTS.scale,
    maxZoom: Math.round(clamp((v.maxZoom as number | undefined) ?? LOCK_DEFAULTS.maxZoom, 1, 2) * 100) / 100 };
  if (typeof v.thing === "string") { const thing = v.thing.replace(/[^\p{L}\p{N} '-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40); if (thing) lock.thing = thing; }
  return lock;
}
/** The sampler's choice for a saved lock over the source span its clip shows. */
export const lockChoice = (lock: PieceLock, span?: [number, number]): LockChoice =>
  ({ anchor: lock.anchor, scale: lock.scale, maxZoom: lock.maxZoom, pickS: lock.pickS, exact: true, ...(span ? { span } : {}) });
const zoomText = (n: number) => `${Number(n.toFixed(2))}x`;
/** What the lock costs, in plain words: "Locked at 1.16x zoom." or "Locked as far as 1.25x zoom allows; a full lock needs 1.51x." */
export function lockNote(key: Pick<LockKey, "zoom" | "need" | "capped">, maxZoom: number) {
  return key.capped ? `Locked as far as ${zoomText(maxZoom)} zoom allows; a full lock needs ${zoomText(key.need)}.` : `Locked at ${zoomText(key.zoom)} zoom.`;
}

// ---- TRK1b: the per-frame keys the title page draws (live, Apple and export: one template, these numbers)
/** pinAt sampled on the reel's frame clock over an item's span: [x, y, scale, rotate, opacity, w] per frame from frame
 * s0 * fps. The title page reads them (overlayLayout and pinned cues), interpolating between frames when live. */
export interface PinKeys { s0: number; fps: number; k: number[]; at: [number, number, number]; lost?: string; q?: number[]; flat?: FlatPlace }  // lost: the loss while the item is on, in plain words on the reel clock  // at = the item's x, y, w when sampled: a drag in progress moves the keys by its difference
// ---- TRK2: corner pin. A flat pin's keys also carry the surface's four corners per frame (q: TL, TR, BR, BL as x0, y0 ..
// x3, y3, frame fractions) and where the word sits on the surface (flat, in the surface's own units). The title page
// maps the word's box onto its quad with one perspective transform (matrix3d), so it reads as printed on the screen.
/** u, v: the box centre on the surface (0..1 each way); size: its width as a share of the surface's width; aspect: the
 * surface's own width over height at the pick frame (its edges' mean lengths), so the word is never stretched. */
export interface FlatPlace { u: number; v: number; size: number; aspect: number }
/** TRK0: words on a flat thing stay inside the inner 60% of it. */
export const FLAT_INNER = 0.6;
/** Where a box of this aspect (width over height, in pixels) sits on the surface: its four corners in surface units
 * (TL, TR, BR, BL), shrunk and moved to stay inside the inner 60%. The title page has the same function (template.html flatBox). */
export function flatBoxUnits(flat: FlatPlace, aspect: number): number[][] {
  let su = Math.max(0.01, flat.size), sv = su * flat.aspect / Math.max(aspect, 1e-6);
  const fit = Math.min(1, FLAT_INNER / su, FLAT_INNER / sv), lo = (1 - FLAT_INNER) / 2, hi = 1 - lo;
  su *= fit; sv *= fit;
  const u = clamp(flat.u, lo + su / 2, hi - su / 2), v = clamp(flat.v, lo + sv / 2, hi - sv / 2);
  return [[u - su / 2, v - sv / 2], [u + su / 2, v - sv / 2], [u + su / 2, v + sv / 2], [u - su / 2, v + sv / 2]];
}
/** The box's corners in the frame (q in any units: the result is in the same), through the surface's perspective. */
export function flatBox(q: number[], flat: FlatPlace, aspect: number): number[][] {
  return flatBoxUnits(flat, aspect).map(([u, v]) => quadPoint(q, u, v));
}
/** The 3x3 projective map (row major, h22 = 1) taking four points to four points. */
export function homography(from: number[][], to: number[][]): number[] {
  // Solve the 8 x 8 system for h00..h21 by Gauss-Jordan elimination with partial pivoting.
  const m: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    m.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const d = m[c][c] || 1e-12;
    for (let k = c; k < 9; k++) m[c][k] /= d;
    for (let r = 0; r < 8; r++) if (r !== c && m[r][c]) { const f = m[r][c]; for (let k = c; k < 9; k++) m[r][k] -= f * m[c][k]; }
  }
  return [...m.map(row => row[8]), 1];
}
/** Which cached track a pin reads: its key, or (an older pin) what it asked the tracker for. */
export const pinTrackId = (pin: PinChoice) => pin.track.key ?? JSON.stringify([pin.track.clipId, pin.track.mode, pin.track.s, pin.track.e, pin.track.box ?? pin.track.corners, pin.pickS]);
/** The picture an item is pinned through: a piece of its clip that shows the tracked span while the item is on, the one
 * on screen longest (the overlay lane wins a tie). Null when the clip is no longer under the item. */
export function pinPiece(item: { s: number; e: number; pin?: PinChoice | null }, pieces: DraftPiece[]): DraftPiece | null {
  const pin = item.pin;
  if (!pin) return null;
  let best: DraftPiece | null = null, most = 0;
  for (const piece of pieces) {
    if (piece.clipId !== pin.track.clipId || piece.layer > 1) continue;
    const on = Math.min(item.e, piece.endS) - Math.max(item.s, piece.startS);
    if (on <= 1e-6) continue;
    const a = sourceTime(piece, Math.max(item.s, piece.startS)), b = sourceTime(piece, Math.min(item.e, piece.endS));
    if (Math.max(a, b) < pin.track.s - 1e-3 || Math.min(a, b) > pin.track.e + 1e-3) continue;
    if (on > most + 1e-6 || Math.abs(on - most) <= 1e-6 && best && piece.layer > best.layer) { best = piece; most = on; }
  }
  return best;
}
const round = (n: number) => Math.round(n * 1e5) / 1e5;
/** The item's keys through its piece, or null (no pin, no picture of the clip under it). Off its piece the item hides. */
export function pinKeys(item: { s: number; e: number; x?: number; y?: number; w?: number; pin?: PinChoice | null }, pieces: DraftPiece[], track: TrackFile, frame: { width: number; height: number; fps: number }): PinKeys | null {
  const piece = pinPiece(item, pieces);
  if (!piece || !(frame.fps > 0)) return null;
  const first = Math.floor(item.s * frame.fps + 1e-6), last = Math.ceil(item.e * frame.fps - 1e-6), k: number[] = [];
  // TRK2: a flat pin on a plane track is a corner pin: the surface's corners every frame too.
  const corner = item.pin!.surface === "flat" && !!track.corners?.length, q: number[] = [];
  let held: PinKey | null = null;
  for (let n = first; n <= last; n++) {
    const t = n / frame.fps, inside = t >= piece.startS - 1e-6 && t <= piece.endS + 1e-6;
    const key: PinKey | null = pinAt(item, piece, Math.max(piece.startS, Math.min(piece.endS, t)), track, frame) ?? held;
    if (!key) return null;
    held = key;
    k.push(round(key.x), round(key.y), round(key.scale), round(key.rotate), inside ? round(key.opacity) : 0, round(key.w));
    if (corner) q.push(...(key.corners ?? held.corners ?? [[key.x, key.y], [key.x, key.y], [key.x, key.y], [key.x, key.y]]).flat().map(round));
  }
  const loss = pinLoss(item, piece, track), flat = corner ? flatPlace(item.pin!, track) : null;
  return { s0: first / frame.fps, fps: frame.fps, k, at: [item.x ?? 0, item.y ?? 0, item.w ?? 0], ...(loss ? { lost: lostText(loss, reelTime(piece, loss.atS), item.pin!.thing) } : {}),
    ...(flat && q.length === k.length / 6 * 8 ? { q, flat } : {}) };
}
/** TRK2: where a flat pin's word sits on its surface: offset from the centre and size in the surface's own units, and
 * the surface's shape at the pick frame (pixels, so a phone held upright reads as tall). */
export function flatPlace(pin: PinChoice, track: TrackFile): FlatPlace | null {
  const series = pinSeries(track, pin.steadiness), p0 = series && sample(series, pin.pickS);
  if (!p0?.q) return null;
  const q = p0.q, edge = (a: number, b: number) => Math.hypot(q[2 * b] - q[2 * a], q[2 * b + 1] - q[2 * a + 1]);
  const width = (edge(0, 1) + edge(3, 2)) / 2, height = (edge(0, 3) + edge(1, 2)) / 2;
  return { u: 0.5 + pin.offset.x, v: 0.5 + pin.offset.y, size: pin.size, aspect: Math.round(width / Math.max(height, 1e-6) * 1e4) / 1e4 };
}
/** The title page's reading of the keys (template.html pinKey), for the viewer's handles: the nearest frame's key, moved
 * by a drag in progress (the item's x, y, w against what was sampled). */
export function pinKeyAt(item: { x: number; y: number; w: number; pinKeys?: PinKeys | null }, time: number) {
  const keys = item.pinKeys, n = keys ? Math.floor(keys.k.length / 6) : 0;
  if (!keys || !n || !(keys.fps > 0)) return null;
  const i = clamp(Math.round((time - keys.s0) * keys.fps), 0, n - 1), k = keys.k.slice(i * 6, i * 6 + 6), grow = keys.at[2] > 0 ? item.w / keys.at[2] : 1;
  const q = keys.q && keys.q.length >= (i + 1) * 8 ? keys.q.slice(i * 8, i * 8 + 8) : null;
  return { x: k[0] + (item.x - keys.at[0]), y: k[1] + (item.y - keys.at[1]), scale: k[2] * grow, rotate: k[3], opacity: k[4], w: k[5] * grow, ...(q && keys.flat ? { q, flat: keys.flat } : {}) };
}
/** A drag or resize of a pinned item (its placement at the pick frame) as the pin's offset and size: object units from
 * the pick box (its width is the item's w over size there), the frame's and the picture's shapes as width over height. */
export function dragPin(pin: PinChoice, before: { x: number; y: number; w: number }, after: { x?: number; y?: number; w?: number }, frameAspect: number, sourceAspect: number): PinChoice {
  // TRK2: a flat pin's surface has the shape of its corners' bounds.
  const corners = pin.track.corners, xs = corners?.map(c => c[0]) ?? [], ys = corners?.map(c => c[1]) ?? [];
  const wide = before.w / Math.max(pin.size, 1e-6), box = pin.track.box ?? (corners ? { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } : undefined);
  const tall = wide * frameAspect * (box ? box.h / Math.max(box.w, 1e-6) / sourceAspect : 1);
  const [lo, hi] = PIN_RANGES.offset;
  const offset = { x: clamp(pin.offset.x + ((after.x ?? before.x) - before.x) / Math.max(wide, 1e-6), lo, hi), y: clamp(pin.offset.y + ((after.y ?? before.y) - before.y) / Math.max(tall, 1e-6), lo, hi) };
  const size = clamp(pin.size * (after.w ?? before.w) / Math.max(before.w, 1e-6), PIN_RANGES.size[0], PIN_RANGES.size[1]);
  return { ...pin, offset, size };
}
/** How long the pin holds on the item (reel seconds of the track's good part while the item is on), for the agent. */
export function pinHeld(item: { s: number; e: number; pin?: PinChoice | null }, piece: DraftPiece, track: TrackFile) {
  const [a, b] = goodRange(track);
  if (b < a) return 0;
  const x = reelTime(piece, track.frames[a][0]), y = reelTime(piece, track.frames[b][0]);
  return Math.max(0, Math.min(item.e, Math.max(x, y)) - Math.max(item.s, Math.min(x, y)));
}
/** The loss that shows while the item is on (source seconds), the first in reel order, or null. */
export function pinLoss(item: { s: number; e: number }, piece: DraftPiece, track: TrackFile): TrackLoss | null {
  const a = sourceTime(piece, piece.startS), b = sourceTime(piece, piece.endS);
  const found = [track.lost, track.lostBefore].flatMap(loss => {
    if (!loss || loss.atS < Math.min(a, b) - 1e-6 || loss.atS > Math.max(a, b) + 1e-6) return [];
    const at = reelTime(piece, loss.atS);
    return at >= item.s - 1e-6 && at < item.e - 1e-6 ? [{ loss, at }] : [];
  }).sort((p, q) => p.at - q.at)[0];
  return found?.loss ?? null;
}
