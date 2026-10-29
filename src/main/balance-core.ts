import type { BasicAdjust, Grade } from '../shared/schema';
import { normalizeBasic, basicBefore, basicAfter, basicLinear } from './basics';
import { gradeForPiece, gradeTransform, lookTransform, expose, type PieceCorrection } from '../shared/grade-math';
import { mixerTransform } from './mixer';
export type RGB = [number, number, number];
/** A cached still, used only for the contact sheet the intent judge sees. */
export type BalanceFrame = { id: string; pixels: RGB[]; displayPixels?: RGB[]; aspect?: number; editGrade?: Grade; grade: Grade; basic?: BasicAdjust; group?: string };
const y = (p: RGB) => p[0] * .2126 + p[1] * .7152 + p[2] * .0722;
const quantile = (sorted: number[], q: number) => sorted[Math.floor((sorted.length-1)*q)] ?? 0;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const median = (values: number[]) => { const s = Float64Array.from(values).sort(); return s.length ? (s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2 : 0; };
function hue(p: RGB) {
  const high=Math.max(...p), low=Math.min(...p), d=high-low;
  if (d < .02) return null;
  return ((high===p[0] ? (p[1]-p[2])/d : high===p[1] ? 2+(p[2]-p[0])/d : 4+(p[0]-p[1])/d)*60+360)%360;
}
export function measurements(pixels: RGB[]) {
  const lum=pixels.map(y).sort((a,b)=>a-b), histogram=Array(32).fill(0);
  for(const n of lum) histogram[Math.min(31,Math.max(0,Math.floor(n*32)))]++;
  return { histogram, black:quantile(lum,.02), white:quantile(lum,.98), mid:quantile(lum,.5), contrast:quantile(lum,.9)-quantile(lum,.1),
    saturation:pixels.reduce((n,p)=>n+(Math.max(...p)-Math.min(...p))/Math.max(.01,Math.max(...p)),0)/Math.max(1,pixels.length),
    warmth:pixels.reduce((n,p)=>n+p[0]-p[2],0)/Math.max(1,pixels.length),
    clipped:pixels.filter(p=>p.some(n=>n>=.995 || n<=.005)).length/Math.max(1,pixels.length) };
}
export function graded(frame: BalanceFrame, basic = frame.basic): RGB[] {
  const transform=gradeTransform(gradeForPiece(frame.grade,{basic:normalizeBasic(basic)}));
  return frame.pixels.map(transform);
}
const rendered = (frame: BalanceFrame) => frame.displayPixels ? {...frame,pixels:frame.displayPixels} : frame;
/** Contact sheet pixels: each still under the edit's look, as the person sees it. */
export function balanceView(frames: BalanceFrame[]) {
  return { pixels: frames.map(f=>graded(rendered(f))), sheetFrames: frames.map(f=>({id:f.id,aspect:f.aspect})) };
}

// V67. Measurement is code; the light's creative intent is one cached model look per source.
export type BalanceKey = 'low' | 'normal' | 'bright';
export interface BalanceIntent { key: BalanceKey; keep: number; why?: string; subject?: string }
export const DEFAULT_INTENT: BalanceIntent = { key: 'normal', keep: .5 };
export function intentPrompt(frames: Pick<BalanceFrame,'id'>[], allowed: Set<string>): string {
  const positions = frames.map((f,i)=>`Image ${Math.floor(i/24)+1} position ${i%24+1}=${f.id}`).join(', ');
  return `Each picture is one source clip from a video edit, shown under the edit's chosen look. precut measures every clip itself and sets exposure, white and black points, contrast and white balance from the 10-bit source. Your only job is the creative intent of the light, so that correction keeps it.
For each clip return:
- key: "low" when the scene is meant to look dark (night, a dim bar, candlelight, a cinema), "bright" when it is meant to look bright and airy (sunny beach, snow, a white studio), otherwise "normal". Judge what the moment is, not how the camera exposed it: an underexposed daytime cafe is still "normal".
- keep: how much of the light's own colour to keep, 0 to 1. 1 keeps it fully (warm lamp light, golden hour, neon, a night street), 0 makes greys neutral (overcast daylight with a camera cast, office light). Most clips sit between.
- why: at most eight plain words about the light.
- subject: what is in sharp focus, at most five plain lowercase words ("the phone and hand", "his face", "the laptop and hands"), or "" when nothing is sharper than the rest.
Return JSON only: {"clips":[{"id":"...","key":"normal","keep":0.4,"why":"...","subject":"..."}]}. Sheet positions: ${positions}. Only return these ids: ${[...allowed].join(', ')}.`;
}
/** Lenient: an unreadable or partial answer falls back to measured defaults, never to an error. */
export function parseIntent(text: string, allowed: Set<string>): Record<string, BalanceIntent> {
  let raw: unknown;
  try { raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return {}; }
  const rows = (raw as { clips?: unknown })?.clips;
  if (!Array.isArray(rows)) return {};
  const result: Record<string, BalanceIntent> = {};
  for (const row of rows as Record<string, unknown>[]) {
    const id = typeof row?.id === 'string' ? row.id : '';
    if (!allowed.has(id) || result[id]) continue;
    const key = row.key === 'low' || row.key === 'bright' ? row.key : 'normal';
    const keep = typeof row.keep === 'number' && Number.isFinite(row.keep) ? clamp(row.keep, 0, 1) : DEFAULT_INTENT.keep;
    // V68: the subject's name is always stored (empty when unnamed) so an older answer is asked once more.
    const subject = typeof row.subject === 'string' ? row.subject.trim().replace(/[.!]+$/, '').slice(0, 48) : '';
    result[id] = { key, keep, ...(typeof row.why === 'string' && row.why.trim() ? { why: row.why.trim().slice(0, 80) } : {}), subject };
  }
  return result;
}

/** One measured source, below its Basic: camera converted, setup base applied, in display Rec.709. */
export interface SolveFrame {
  id: string;
  data: Float32Array;            // interleaved RGB samples, 0..1
  face?: Uint8Array;             // 1 where the sample sits in a measured face box
  focus?: Float32Array;          // V68: how sharp the picture is at each sample (see focusSample)
  peak?: Float32Array;           // V68: the brightest decoded pixel in each sample's block, interleaved RGB like data
  exposure?: PieceCorrection;    // the per-piece exposure stage that runs before Basic
  grade: Grade;                  // edit grade plus this source's creative look, without its own Basic
  basic?: BasicAdjust;           // current source Basic
  group?: string;                // Claude's scene name
  intent?: BalanceIntent;
  fixed?: 'hand' | 'reference';  // a target only: never changed
}
export type SubjectKind = 'face' | 'focus' | 'frame';
/** `subject` is the level exposure is set on: the face, else the in-focus part of the picture, else the frame's middle.
 *  `around` is the brightest large part of everything else (its 90th percentile): a defocused background or window. */
export interface ToneLevels { black: number; shadow: number; mid: number; high: number; white: number; subject: number; subjectKind: SubjectKind; around: number; clipped: number; chroma: number; colour: number; cast: [number, number] }
export interface SolvedClip { basic: BasicAdjust; reason: string; before: ToneLevels; after: ToneLevels; matched?: string }
type Band = [number, number];
interface Targets { gentle?: boolean; match?: boolean; mid: Band; subject: Band; focus: Band; high: number; white: Band; black: Band; chroma: Band; cast: [number, number]; castWeight: number; matched?: string }
// Where a correctly exposed frame sits after the look, in display luma. The key is
// the judge's call; within it these bands are the colourist's ordinary conventions,
// set against a colourist's hand grade of a sample clip (18 Oct).
const KEY_BANDS: Record<BalanceKey, Omit<Targets, 'cast' | 'castWeight'>> = {
  // V68 focus: where the in-focus subject sits. In a normal or bright scene that is where a frame's middle
  // sits; in a low-key scene the frame's middle is the darkness, and the subject is what the light falls on.
  low:    { gentle: true, mid: [.10, .24], subject: [.26, .36], focus: [.26, .36], high: .62, white: [.62, .90], black: [.02, .05], chroma: [.24, .5] },
  normal: { mid: [.37, .43], subject: [.42, .48], focus: [.37, .43], high: .78, white: [.84, .91], black: [.05, .07], chroma: [.28, .5] },
  bright: { mid: [.48, .58], subject: [.46, .54], focus: [.48, .58], high: .85, white: [.88, .95], black: [.05, .08], chroma: [.28, .5] },
};
const TONES = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] as const;
const lin = (v: number) => Math.max(1e-4, basicLinear(clamp(v, 0, 1)));
const skinLike = (p: RGB) => { const h = hue(p), high = Math.max(...p), sat = high > 0 ? (high - Math.min(...p)) / high : 0, l = y(p); return h !== null && h >= 10 && h <= 50 && sat >= .15 && sat <= .7 && l > .08 && l < .85; };
function pixelsOf(data: Float32Array): RGB[] { const out: RGB[] = []; for (let i = 0; i + 2 < data.length; i += 3) out.push([data[i], data[i+1], data[i+2]]); return out; }
/** Rank-stratified sample: keeps both histogram ends exact while the search stays fast. */
function stratified(indices: number[], lum: number[], n: number): number[] {
  // Pack luma and index into one float so the native numeric sort does the work.
  const keys = Float64Array.from(indices, i => Math.round(clamp(lum[i], 0, 1) * 1e6) * 2 ** 20 + i).sort();
  const sorted = Array.from(keys, k => k % 2 ** 20);
  if (sorted.length <= n) return sorted;
  return Array.from({ length: n }, (_, i) => sorted[Math.round(i * (sorted.length - 1) / (n - 1))]);
}
/** Neutral surfaces in linear light: red-blue and green-magenta cast in stops, with a confidence. */
function castOf(px: RGB[]): { cast: [number, number]; weight: number } {
  const mids = px.filter(p => { const l = y(p); return l > .08 && l < .85 && Math.max(...p) < .98; });
  const neutral = mids.filter(p => { const high = Math.max(...p); return (high - Math.min(...p)) / Math.max(.01, high) < .22 && !skinLike(p); });
  const pool = neutral.length >= Math.max(24, px.length * .01) ? neutral : mids;
  if (!pool.length) return { cast: [0, 0], weight: 0 };
  const logs = pool.map(p => { const l = Math.log2(lin(y(p))); return [Math.log2(lin(p[0])) - l, Math.log2(lin(p[1])) - l, Math.log2(lin(p[2])) - l]; });
  const r = median(logs.map(v => v[0])), g = median(logs.map(v => v[1])), b = median(logs.map(v => v[2]));
  const rb = r - b, spread = median(logs.map(v => Math.abs(v[0] - v[2] - rb)));
  // Mixed light (sodium and LED, lamp and window) is incoherent: correct it less, never remove it.
  const weight = clamp(pool === neutral ? neutral.length / (px.length * .06) : .3, 0, 1) * clamp(1 - spread / .6, 0, 1);
  return { cast: [rb, g - (r + b) / 2], weight };
}
// V68. Exposure is set from the subject, not the frame: a dark defocused sleeve in the foreground
// or a bright defocused room behind must not decide how light the sharp phone and hand are.
/** Per-sample subject weights, aligned with the sample: a measured face box, else sharpness. Null meters the frame. */
interface Subject { kind: 'face' | 'focus'; weights: Float64Array; mean: number }
/** Just below clipping on any channel: a lift may not add area here beyond what the source already has. */
const NEAR_CLIP = .98;
/** The brightest points are held a hair under it: they are read per block, and the full picture has finer highlights. */
const PEAK_HOLD = NEAR_CLIP - .005;
/** Added near-clip points tolerated, as a share of the frame: a colourist's hand grade of a sample clip adds 0.03%. */
const PEAK_ALLOWANCE = .0003;
/**
 * Where the picture is sharp, from a decode at `factor` times the sample size: the gradient energy of display
 * luma, pooled into each sample cell and smoothed over its neighbours so a subject reads as a region, not
 * scattered edges. Also returns the sample itself, each cell the mean of its block (an area scale).
 */
export function focusSample(rgb: Float32Array, width: number, height: number, factor: number): { data: Float32Array; focus: Float32Array; peak: Float32Array } {
  const w = Math.floor(width / factor), h = Math.floor(height / factor), data = new Float32Array(w * h * 3), peak = new Float32Array(w * h * 3), energy = new Float32Array(w * h), lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) lum[i] = rgb[i*3] * .2126 + rgb[i*3+1] * .7152 + rgb[i*3+2] * .0722;
  for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) {
    let r = 0, g = 0, b = 0, e = 0, top = -1, brightest = 0;
    for (let yy = cy * factor; yy < (cy + 1) * factor; yy++) for (let xx = cx * factor; xx < (cx + 1) * factor; xx++) {
      const i = yy * width + xx; r += rgb[i*3]; g += rgb[i*3+1]; b += rgb[i*3+2];
      const high = Math.max(rgb[i*3], rgb[i*3+1], rgb[i*3+2]); if (high > top) { top = high; brightest = i; }
      if (xx + 1 < width) e += Math.abs(lum[i + 1] - lum[i]);
      if (yy + 1 < height) e += Math.abs(lum[i + width] - lum[i]);
    }
    const n = factor * factor, o = cy * w + cx; data[o*3] = r / n; data[o*3+1] = g / n; data[o*3+2] = b / n; energy[o] = e / n;
    peak.set(rgb.subarray(brightest * 3, brightest * 3 + 3), o * 3);
  }
  const focus = new Float32Array(w * h);
  for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) {
    let e = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = cx + dx, yy = cy + dy; if (x >= 0 && x < w && yy >= 0 && yy < h) { e += energy[yy * w + x]; n++; } }
    focus[cy * w + cx] = e / n;
  }
  return { data, focus, peak };
}
function subjectOf(frame: SolveFrame, sample: number[]): Subject | null {
  if (frame.face && sample.some(i => frame.face![i] > 0)) { const weights = Float64Array.from(sample, i => frame.face![i] > 0 ? 1 : 0); return { kind: 'face', weights, mean: weights.reduce((a, b) => a + b, 0) / weights.length }; }
  if (!frame.focus || !frame.focus.some(v => v > 0)) return null;
  // Squared energy: the sharp region carries the reading even when it is a small part of the frame,
  // and an evenly sharp frame (deep focus) still meters as a whole.
  const weights = Float64Array.from(sample, i => (frame.focus![i] ?? 0) ** 2);
  return { kind: 'focus', weights, mean: weights.reduce((a, b) => a + b, 0) / weights.length };
}
function weightedQuantile(lum: ArrayLike<number>, weights: ArrayLike<number>, f: number, keep: (w: number) => boolean = w => w > 0): number {
  const order = Array.from({ length: lum.length }, (_, i) => i).filter(i => keep(weights[i])).sort((a, b) => lum[a] - lum[b]);
  let total = 0; for (const i of order) total += Math.max(weights[i], 1e-12);
  let run = 0; for (const i of order) { run += Math.max(weights[i], 1e-12); if (run >= total * f) return lum[i]; }
  return lum[order.at(-1) ?? 0] ?? 0;
}
/** The subject's level, and the brightest large part of everything else (its 90th percentile). */
function subjectRead(lum: ArrayLike<number>, subject: Subject | null, frameMid: number, frameHigh: number): { subject: number; around: number; kind: SubjectKind } {
  if (!subject) return { subject: frameMid, around: frameHigh, kind: 'frame' };
  if (subject.kind === 'face') {
    const faces: number[] = [], rest: number[] = [];
    for (let i = 0; i < lum.length; i++) (subject.weights[i] > 0 ? faces : rest).push(lum[i]);
    return { subject: median(faces), around: rest.length ? quantile(rest.sort((a, b) => a - b), .9) : frameHigh, kind: 'face' };
  }
  // Everything less sharp than the frame's average sharpness is the surroundings.
  return { subject: weightedQuantile(lum, subject.weights, .5), around: quantile(Array.from(lum).filter((_, i) => subject.weights[i] < subject.mean).sort((a, b) => a - b), .9) || frameHigh, kind: 'focus' };
}
function levelsOf(px: RGB[], subject: Subject | null): ToneLevels {
  const raw = px.map(y), lum = [...raw].sort((a, b) => a - b);
  const mids = px.filter(p => { const l = y(p); return l > .1 && l < .85; });
  return { black: quantile(lum, .02), shadow: quantile(lum, .1), mid: quantile(lum, .5), high: quantile(lum, .9), white: quantile(lum, .995),
    ...(({ subject: level, around, kind }) => ({ subject: level, around, subjectKind: kind }))(subjectRead(raw, subject, quantile(lum, .5), quantile(lum, .9))),
    clipped: px.filter(p => Math.max(...p) >= NEAR_CLIP).length / Math.max(1, px.length),
    chroma: quantile(Float64Array.from(mids, p => (Math.max(...p) - Math.min(...p)) / Math.max(.01, Math.max(...p))).sort() as unknown as number[], .75),
    colour: quantile(Float64Array.from(mids, p => (Math.max(...p) - Math.min(...p)) / Math.max(.01, Math.max(...p))).sort() as unknown as number[], .9), cast: [0, 0] };
}
/** The cheap tonal read the search needs: luma quantiles, the subject's level and clipping only. */
function toneOf(px: RGB[], subject: Subject | null) {
  const lum = new Float64Array(px.length), faces: number[] = []; let clipped = 0, crushed = 0;
  const face = subject?.kind === 'face' ? subject.weights : null;
  for (let i = 0; i < px.length; i++) { const p = px[i], l = y(p), high = Math.max(p[0], p[1], p[2]); lum[i] = l; if (face?.[i]) faces.push(l); if (high >= NEAR_CLIP) clipped++; if (high <= .01) crushed++; }
  const level = subject?.kind === 'focus' ? weightedQuantile(lum, subject.weights, .5) : faces.length ? median(faces) : null;
  lum.sort();
  const q = (f: number) => lum[Math.floor((lum.length - 1) * f)] ?? 0;
  return { black: q(.02), shadow: q(.1), quarter: q(.25), mid: q(.5), upper: q(.8), high: q(.9), white: q(.995), subject: level ?? q(.5), face: faces.length > 0, focus: subject?.kind === 'focus', clipped: clipped / Math.max(1, px.length), crushed: crushed / Math.max(1, px.length) };
}
type Tone = ReturnType<typeof toneOf> & { peak: number };
const centre = ([lo, hi]: Band) => (lo + hi) / 2;
const sum = (edit: BasicAdjust, clip: Partial<BasicAdjust>) => normalizeBasic(Object.fromEntries(Object.entries(edit).map(([k, v]) => [k, v + (clip[k as keyof BasicAdjust] ?? 0)])));
interface Prepared { frame: SolveFrame; pre: RGB[]; peakPre: RGB[]; subject: Subject | null; sample: number[]; peaks: number[]; edit: BasicAdjust; stage: (rgb: RGB) => RGB; zero: ToneLevels; cast: { cast: [number, number]; weight: number }; skin: number[] }
function prepare(frame: SolveFrame): Prepared {
  const pre = pixelsOf(frame.data).map(p => expose(p, frame.exposure)), lum = pre.map(y);
  const face = frame.face && frame.face.some(Boolean) ? Array.from(frame.face, v => v > 0) : null;
  const all = pre.map((_, i) => i), faces = face ? all.filter(i => face[i]) : [];
  const sample = [...new Set([...stratified(all, lum, 480), ...stratified(faces, lum, 120)])];
  // The brightest points on any channel (a phone screen, a white wall, a saturated sign), read on their
  // own so a lift can be held below clipping there without skewing the frame's own levels.
  // The finer decode's brightest pixel per block when measured, so a small highlight is not averaged away.
  const peakPre = frame.peak && frame.peak.length === frame.data.length ? pixelsOf(frame.peak).map(p => expose(p, frame.exposure)) : pre;
  // The brightest of each channel, so a white balance move that lifts red or blue is still watched.
  const top = (c: number) => Array.from(Float64Array.from(all, i => Math.round(clamp(peakPre[i][c], 0, 1) * 1e6) * 2 ** 20 + i).sort().reverse().slice(0, Math.max(12, Math.round(all.length * .003))), k => k % 2 ** 20);
  const peaks = [...new Set([...top(0), ...top(1), ...top(2)])];
  const subject = subjectOf(frame, sample);
  const look = lookTransform(frame.grade), mixer = mixerTransform(frame.grade.mixer), edit = normalizeBasic(frame.grade.basic);
  const stage = (rgb: RGB) => mixer(look(rgb));
  const zeroBefore = basicBefore(edit), zeroAfter = basicAfter(edit);
  const zero = levelsOf(sample.map(i => zeroAfter(stage(zeroBefore(pre[i])))), subject);
  return { frame, pre, peakPre, subject, sample, peaks, edit, stage, zero, cast: castOf(pre), skin: sample.filter(i => skinLike(pre[i])) };
}
/** Final pixels for one plan, sample only. */
function render(p: Prepared, clip: BasicAdjust, indices = p.sample): RGB[] {
  const total = sum(p.edit, clip), before = basicBefore(total), after = basicAfter(total);
  return indices.map(i => after(p.stage(before(p.pre[i]))));
}
/** Cast after this source's own white balance, before the edit's and the look's: gains are exact log offsets. */
const castAfter = (p: Prepared, clip: BasicAdjust): [number, number] => [p.cast.cast[0] + .7 * clip.temperature / 100, p.cast.cast[1] - .36 * clip.tint / 100];
function finalLevels(p: Prepared, clip: BasicAdjust): ToneLevels {
  return { ...levelsOf(render(p, clip), p.subject), cast: castAfter(p, clip) };
}
/** White balance first, below the look: the look's own colour stays its signature. */
function solveWhiteBalance(p: Prepared, t: Targets): { temperature: number; tint: number } {
  // Matching moves a measurable cast all the way to its scene's; a lone clip moves as far as its neutrals are trustworthy.
  const [rb, g] = p.cast.cast, weight = t.match && p.cast.weight > .2 ? t.castWeight : Math.min(p.cast.weight, t.castWeight);
  let temperature = clamp((t.cast[0] - rb) / .7 * 100 * weight, -60, 60), tint = clamp((g - t.cast[1]) / .36 * 100 * weight, -60, 60);
  // Skin keeps a natural hue. A cast that would push faces out of it is corrected less.
  if (p.skin.length >= 12) {
    const skinHue = (s: number) => { const b = basicBefore({ ...normalizeBasic(), temperature: temperature * s, tint: tint * s }); return median(p.skin.map(i => hue(b(p.pre[i])) ?? 30)); };
    const fits = (s: number) => { const h = skinHue(s); return h >= 10 && h <= 50; };
    if (fits(0) && !fits(1)) { let lo = 0, hi = 1; for (let i = 0; i < 10; i++) { const m = (lo + hi) / 2; if (fits(m)) lo = m; else hi = m; } temperature *= lo; tint *= lo; }
  }
  return { temperature: Math.round(temperature * 10) / 10, tint: Math.round(tint * 10) / 10 };
}
function solveTones(p: Prepared, t: Targets, wb: { temperature: number; tint: number }): BasicAdjust {
  const looks = new Map<number, RGB[]>();
  const looked = (ev: number) => {
    const key = Math.round(ev * 400) / 400; let v = looks.get(key);
    if (!v) { const b = basicBefore(sum(p.edit, { exposure: key, temperature: wb.temperature, tint: wb.tint })); v = [...p.sample.map(i => p.pre[i]), ...p.peaks.map(i => p.peakPre[i])].map(rgb => p.stage(b(rgb))); looks.set(key, v); }
    return v;
  };
  type X = Record<typeof TONES[number], number>;
  // Without vibrance or saturation the tone stage is one curve per channel: tabulate it once per try.
  const separable = !p.edit.vibrance && !p.edit.saturation, curve = new Float64Array(129);
  const after = (x: X) => {
    const a = basicAfter(sum(p.edit, { contrast: x.contrast, highlights: x.highlights, shadows: x.shadows, whites: x.whites, blacks: x.blacks }));
    if (!separable) return a;
    for (let i = 0; i <= 128; i++) curve[i] = a([i / 128, 0, 0])[0];
    const at = (v: number) => { const f = clamp(v, 0, 1) * 128, n = Math.min(127, Math.floor(f)); return curve[n] + (curve[n + 1] - curve[n]) * (f - n); };
    return (rgb: RGB): RGB => [at(rgb[0]), at(rgb[1]), at(rgb[2])];
  };
  const n = p.sample.length;
  const read = (x: X) => {
    const px = looked(x.exposure).map(after(x));
    let hot = 0; for (let i = n; i < px.length; i++) if (Math.max(px[i][0], px[i][1], px[i][2]) >= PEAK_HOLD) hot++;
    return { ...toneOf(px.slice(0, n), p.subject), peak: hot };
  };
  const zero = read({ exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 });
  const allowedClip = Math.max(zero.clipped, .002), allowedCrush = Math.max(.005, zero.crushed), allowance = Math.round(p.pre.length * PEAK_ALLOWANCE), allowedPeak = zero.peak + allowance;
  /** Bisection on one slider for a reading that rises with it. */
  const fit = (x: X, key: keyof X, [lo, hi]: Band, reading: (l: Tone) => number, goal: number) => {
    let a = lo, b = hi;
    if (reading(read({ ...x, [key]: a })) >= goal) return a;
    if (reading(read({ ...x, [key]: b })) <= goal) return b;
    for (let i = 0; i < 11; i++) { const m = (a + b) / 2; if (reading(read({ ...x, [key]: m })) < goal) a = m; else b = m; }
    return (a + b) / 2;
  };
  /** The largest slider value whose reading (rising with it) stays at or under a limit. */
  const hold = (x: X, key: keyof X, [lo, hi]: Band, reading: (l: Tone) => number, limit: number) => {
    if (reading(read({ ...x, [key]: hi })) <= limit) return hi;
    if (reading(read({ ...x, [key]: lo })) > limit) return lo;
    let a = lo, b = hi;
    for (let i = 0; i < 11; i++) { const m = (a + b) / 2; if (reading(read({ ...x, [key]: m })) <= limit) a = m; else b = m; }
    return a;
  };
  const x: X = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };
  // A normal or bright scene is set decisively to the middle of its range; a low-key scene
  // (night, a dim bar) is only moved when it falls outside it: night stays night.
  const goal = (band: Band, now: number) => t.gentle ? clamp(now, band[0], band[1]) : centre(band);
  // A face sits in the skin band, the in-focus subject in the focus band, otherwise the frame's middle in the mid band.
  const subject = (l: Tone) => l.subject;
  const midGoal = goal(zero.face ? t.subject : zero.focus ? t.focus : t.mid, subject(zero)), whiteGoal = goal(t.white, zero.white), blackGoal = goal(t.black, zero.black);
  // The colourist's order. Each slider has one job, refitted against the others until they settle.
  const highGoal = Math.max(t.high + .07, zero.high);
  for (let pass = 0; pass < 4; pass++) {
    // Exposure puts the subject right, but a lift stops where the bright part of the frame
    // (a sky, a lit street) would lose its texture: a dark coat stays a dark coat.
    const wanted = fit(x, 'exposure', [-2, 2], subject, midGoal);
    const cap = zero.upper < t.high ? fit({ ...x, highlights: 0, whites: 0 }, 'exposure', [0, 2], l => l.upper, t.high) : 0;
    x.exposure = wanted > 0 ? Math.min(wanted, Math.max(cap, 0)) : wanted;
    // Contrast keeps a lift from washing out the shadows: most of it lands in the mids, as by hand.
    const lifted = read({ ...x, contrast: 0 }), quarterGoal = zero.quarter + .25 * (lifted.mid - zero.mid);
    x.contrast = lifted.quarter > quarterGoal ? fit({ ...x, contrast: 0 }, 'contrast', [0, 50], l => -l.quarter, -quarterGoal) : 0;
    // Highlights hold the bright part of the frame where it keeps its texture (a sky, a lamp).
    x.highlights = 0;
    if (read(x).high > highGoal) x.highlights = fit(x, 'highlights', [-80, 0], l => l.high, highGoal);
    // Whites built up to just below clipping.
    x.whites = read({ ...x, whites: 0 }).white < whiteGoal ? fit(x, 'whites', [0, 70], l => l.white, whiteGoal) : 0;
    if (read(x).white > t.white[1]) x.highlights = Math.min(x.highlights, fit(x, 'highlights', [-80, 0], l => l.white, t.white[1]));
    if (read(x).clipped > allowedClip) x.highlights = Math.min(x.highlights, fit(x, 'highlights', [-80, 0], l => l.clipped, allowedClip));
    // V68: the brightest points never pushed past just below clipping where the source holds them below it.
    // Whites give way first (as by hand), then highlights.
    if (read(x).peak > allowedPeak && x.whites > 0) x.whites = hold(x, 'whites', [0, x.whites], l => l.peak, allowedPeak);
    if (read(x).peak > allowedPeak) x.highlights = hold(x, 'highlights', [-80, x.highlights], l => l.peak, allowedPeak);
    // Blacks to just above crush.
    x.blacks = fit(x, 'blacks', [-60, 60], l => l.black, blackGoal);
    if (read(x).crushed > allowedCrush) x.blacks = Math.max(x.blacks, fit(x, 'blacks', [-60, 60], l => -l.crushed, -allowedCrush));
    // Shadows open only when a measured face sits in them (backlit), never to fake exposure.
    x.shadows = zero.face && read(x).subject < t.subject[0] - .02 ? fit(x, 'shadows', [0, 60], subject, t.subject[0]) : 0;
  }
  const basic = normalizeBasic({ ...x, temperature: wb.temperature, tint: wb.tint });
  // Vibrance last: dull colour (flat log, grey light) comes back to a natural floor. A source
  // with no colour to restore (a white room) or a monochrome look is left alone; never desaturates.
  if (p.zero.colour > .2) {
    const chromaAt = (v: number) => levelsOf(render(p, { ...basic, vibrance: v }), p.subject).chroma;
    // Colour comes back only as far as no point is pushed to clipping. Vibrance moves any saturated
    // colour, not only the brightest, so every measured point is watched here.
    const hotAt = (v: number, points: RGB[]) => { const total = sum(p.edit, { ...basic, vibrance: v }), before = basicBefore(total), after = basicAfter(total); return points.filter(rgb => Math.max(...after(p.stage(before(rgb)))) >= PEAK_HOLD); };
    if (chromaAt(0) < t.chroma[0]) {
      let a = 0, b = 25;
      for (let i = 0; i < 10; i++) { const m = (a + b) / 2; if (chromaAt(m) < t.chroma[0]) a = m; else b = m; }
      basic.vibrance = (a + b) / 2;
      // Only points that clip at the chosen vibrance can matter; the search runs on those alone.
      const at = hotAt(basic.vibrance, p.peakPre), hot = hotAt(0, at).length;
      if (at.length > hot + allowance) { let lo = 0, hi = basic.vibrance; for (let i = 0; i < 10; i++) { const m = (lo + hi) / 2; if (hotAt(m, at).length <= hot + allowance) lo = m; else hi = m; } basic.vibrance = lo; }
    }
  }
  return normalizeBasic(Object.fromEntries(Object.entries(basic).map(([k, v]) => [k, Math.round(v * (k === 'exposure' ? 100 : 10)) / (k === 'exposure' ? 100 : 10)])));
}
function point(v: number, width: number): Band { return [v - width, v + width]; }
function reasonFor(basic: BasicAdjust, t: Targets, intent: BalanceIntent | undefined, before: ToneLevels, after: ToneLevels): string {
  const parts: string[] = [];
  if (Math.abs(basic.exposure) >= .05) parts.push(`${basic.exposure > 0 ? 'lifted' : 'lowered'} ${Math.abs(basic.exposure).toFixed(2)} ${Math.abs(basic.exposure) > 1 ? 'stops' : 'stop'}`);
  if (Math.abs(basic.whites) >= 3 || Math.abs(basic.blacks) >= 3) parts.push(`whites to ${after.white.toFixed(2)}, blacks to ${after.black.toFixed(2)}`);
  if (basic.contrast >= 5) parts.push('added contrast'); else if (basic.contrast <= -5) parts.push('softened contrast');
  if (basic.highlights <= -5) parts.push('held the highlights');
  if (basic.shadows >= 5) parts.push('opened the shadows'); else if (basic.shadows <= -5) parts.push('kept the shadows down');
  if (Math.abs(basic.temperature) >= 3 || Math.abs(basic.tint) >= 3) parts.push(t.matched ? 'matched the white balance' : intent && intent.keep >= .6 ? "balanced the colour, keeping the light's own colour" : 'neutralised the colour cast');
  if (basic.vibrance >= 5) parts.push('brought the colour back');
  if (!parts.length) return 'Already looks right';
  // V68: say what set the exposure when it was not the frame's middle, and that the bright surroundings held.
  if (after.subjectKind === 'focus' && Math.abs(before.subject - before.mid) >= .03) parts.unshift(`metered on ${intent?.subject || 'what is in focus'}`);
  else if (after.subjectKind === 'face' && Math.abs(before.subject - before.mid) >= .03) parts.unshift('metered on the face');
  // Only alongside the metering it explains: a subject metered darker than a bright surround that stayed unclipped.
  if (parts[0]?.startsWith('metered') && after.around > after.subject + .1 && after.clipped <= Math.max(before.clipped, .002)) parts.splice(1, 0, 'kept the bright background below clipping');
  const text = parts.join(', ');
  return `${text[0].toUpperCase()}${text.slice(1)}.${t.matched ? ` Matched to ${t.matched}.` : ''} Brightness ${before.mid.toFixed(2)} to ${after.mid.toFixed(2)}.`;
}
/** Grade every clip on its own, then match clips that share a scene (or the chosen reference). */
export function solveBalances(frames: SolveFrame[], reference?: string, only?: string[]): Record<string, SolvedClip> {
  const wanted = only ? new Set(only) : null;
  const prepared = new Map(frames.map(f => [f.id, prepare(f)]));
  const current = (p: Prepared) => finalLevels(p, normalizeBasic(p.frame.basic));
  const intentOf = (f: SolveFrame) => f.intent ?? DEFAULT_INTENT;
  const keyOf = (peers: SolveFrame[]) => { const votes = new Map<BalanceKey, number>(); for (const f of peers) votes.set(intentOf(f).key, (votes.get(intentOf(f).key) ?? 0) + 1); return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'normal'; };
  const solving = (f: SolveFrame) => !f.fixed && (!wanted || wanted.has(f.id));
  const own = (f: SolveFrame): Targets => { const p = prepared.get(f.id)!, intent = intentOf(f); return { ...KEY_BANDS[intent.key], cast: [p.cast.cast[0] * intent.keep, p.cast.cast[1] * intent.keep], castWeight: 1 }; };
  const solve = (f: SolveFrame, t: Targets): SolvedClip => {
    const p = prepared.get(f.id)!;
    let wb = solveWhiteBalance(p, t);
    // Matching may pull white balance toward the scene, but no further than a colourist would
    // nudge one shot to sit with another: a different light under the same scene name keeps its own.
    if (t.match) { const alone = solveWhiteBalance(p, own(f)); wb = { temperature: clamp(wb.temperature, alone.temperature - 20, alone.temperature + 20), tint: clamp(wb.tint, alone.tint - 20, alone.tint + 20) }; }
    let basic = solveTones(p, t, wb);
    const before = finalLevels(p, normalizeBasic());
    let reason = reasonFor(basic, t, f.intent, before, finalLevels(p, basic));
    // Moves below what anyone could see are noise, not a grade: the clip measures right as it is.
    if (reason === 'Already looks right') basic = normalizeBasic();
    const after = finalLevels(p, basic);
    if (reason === 'Already looks right') reason = `Already looks right. Brightness ${after.mid.toFixed(2)}.`;
    return { basic, reason, before, after, ...(t.matched ? { matched: t.matched } : {}) };
  };
  const level = (levels: ToneLevels[], k: 'mid' | 'subject' | 'high' | 'white' | 'black' | 'chroma') => median(levels.map(l => l[k]));
  // What a clip without a face is metered on: its in-focus subject, else its middle.
  const metered = (l: ToneLevels) => l.subjectKind === 'face' ? l.mid : l.subject;
  const matchTo = (levels: ToneLevels[], matched: string): Targets => ({ mid: point(median(levels.map(metered)), .02), focus: point(median(levels.map(metered)), .02), subject: point(level(levels, 'subject'), .02),
    high: Math.max(level(levels, 'high') - .07, .78), white: point(level(levels, 'white'), .03), black: point(level(levels, 'black'), .012), chroma: point(level(levels, 'chroma'), .03),
    cast: [median(levels.map(l => l.cast[0])), median(levels.map(l => l.cast[1]))], castWeight: 1, match: true, matched });
  const out: Record<string, SolvedClip> = {};
  // "Match others to this clip": every other source is solved to the reference's own result.
  const referenceFrame = reference ? prepared.get(reference) : undefined;
  if (referenceFrame) {
    const t = { ...matchTo([current(referenceFrame)], reference!), mid: point(metered(current(referenceFrame)), .015), focus: point(metered(current(referenceFrame)), .015) };
    for (const f of frames) if (solving(f) && f.id !== reference) out[f.id] = solve(f, t);
    return out;
  }
  const scenes = new Map<string, SolveFrame[]>();
  for (const f of frames) if (f.group) scenes.set(f.group, [...(scenes.get(f.group) ?? []), f]);
  for (const f of frames) if (solving(f) && !(f.group && (scenes.get(f.group)?.length ?? 0) > 1)) out[f.id] = solve(f, own(f));
  for (const peers of scenes.values()) {
    if (peers.length < 2) continue;
    const hand = peers.filter(f => f.fixed === 'hand');
    // The person's own grade in a scene is the target its other clips match.
    if (hand.length) { const t = matchTo(hand.map(f => current(prepared.get(f.id)!)), 'your grade in this scene'); for (const f of peers) if (solving(f)) out[f.id] = solve(f, t); continue; }
    // Otherwise grade each clip on its own under the scene's shared intent, then match them to
    // the scene's middle so cuts within it don't jump in brightness or colour.
    const open = peers.filter(f => !f.fixed), keep = median(open.map(f => intentOf(f).keep));
    const casts = open.map(f => prepared.get(f.id)!.cast).filter(c => c.weight > .2);
    const shared: Targets = { ...KEY_BANDS[keyOf(open)], cast: casts.length ? [median(casts.map(c => c.cast[0] * keep)), median(casts.map(c => c.cast[1] * keep))] : [0, 0], castWeight: casts.length ? 1 : 0 };
    const first = new Map(open.map(f => [f.id, solving(f) ? solve(f, shared).after : current(prepared.get(f.id)!)]));
    const t = matchTo([...first.values()], 'the rest of this scene');
    for (const f of open) if (solving(f)) out[f.id] = solve(f, t);
  }
  return out;
}
