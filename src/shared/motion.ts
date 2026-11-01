// MOT1 (docs/plans/produced/motion-control-spike.md): the one record of time and feel for anything that moves. A
// graphic's look is its template's params; when each element lands and how it lands lives here, as plain numbers and
// choices, so the inspector, Ask and the MCP change values and never code. Pure: no node, no DOM.
//
// Element times are seconds from the item's start (`at`). An element may be anchored to a word (a transcript word id:
// it lands on the frame he starts saying it, and follows when his voice moves) or to a beat (a position in the
// de-duplicated beat list, index plus subdivision, snapped to the grid and shifted by the offset). resolveMotion turns
// the anchors into frame times for the item as it sits now; templates draw from the resolved `at`.

export type MotionTiming = "words" | "beats" | "syllables";
export type MotionStyle = "slam" | "snap" | "flash" | "cut" | "fade";
export type MotionGrid = 1 | 0.5 | 0.25;
export interface MotionElement {
  id: string;
  at: number;                                   // seconds from the item's start, as last resolved
  word?: string;                                // a transcript word id it lands on
  beat?: number;                                // a beat position: index in the de-duplicated beats + subdivision (3.5 = half way past beat 3)
  style?: MotionStyle; strength?: number;       // this element only; the item's when absent
}
export interface Motion {
  timing: MotionTiming;                         // what ticks snap to: his words, the music's beats, his syllables
  grid: MotionGrid;                             // beat grid for beat anchors: 1, 1/2 or 1/4 beat
  offsetBeats: number;                          // -1..1 in 1/4 steps, added to every beat anchor after the grid
  elements: MotionElement[];
  keepOrder: boolean;                           // a later element never lands before an earlier one: it is pushed along
  style: MotionStyle;
  strength: number;                             // 0..2, 1 = the launch video
  push: number;                                 // 0..8: per cent the scene grows over its length
  holdBeats: number;                            // 0..4: beats it holds after the last landing
}

export const MOTION_TIMINGS: MotionTiming[] = ["words", "beats", "syllables"];
export const MOTION_STYLES: MotionStyle[] = ["slam", "snap", "flash", "cut", "fade"];
export const MOTION_GRIDS: MotionGrid[] = [1, 0.5, 0.25];
export const MOTION_LIMITS = { offsetBeats: [-1, 1], strength: [0, 2], push: [0, 8], holdBeats: [0, 4], elements: 64, atS: 60, beat: 100_000 } as const;
export const MOTION_DEFAULT: Motion = { timing: "words", grid: 0.5, offsetBeats: 0, elements: [], keepOrder: true, style: "slam", strength: 1, push: 3, holdBeats: 0.5 };
/** A beat's length when there is no music to measure (120 bpm). */
export const FALLBACK_BEAT_S = 0.5;
export const MOTION_NOTES = {
  afterEnd: "That's after the scene ends; make the scene longer first.",
  beforeStart: "That's before the scene starts; start the scene earlier first.",
  noHold: "There isn't room to hold that long after the last one lands; make the scene longer or hold less.",
  noBeats: "There are no music beats here, so it is timed to his syllables.",
  noBeatsOrSyllables: "There are no music beats here, so it keeps its own times.",
  lostWord: "A word it was timed to is no longer in the edit, so it keeps its last time.",
} as const;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round = (n: number, step: number) => Math.round(n / step) * step;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
function one<T>(v: unknown, options: readonly T[], fallback: T): T { return options.includes(v as T) ? v as T : fallback; }   // a declaration, so a .tsx-mode transpile (the renderer test harness) reads it

/** A clean copy with every knob inside its range; anything missing or wrong takes the default (or `defaults`). */
export function clampMotion(input: unknown, defaults: Partial<Motion> = {}): Motion {
  const d = { ...MOTION_DEFAULT, ...defaults };
  const m = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const L = MOTION_LIMITS, num = (v: unknown, fallback: number, [lo, hi]: readonly [number, number], step: number) => r4(round(clamp(finite(v) ? v : fallback, lo, hi), step));
  const seen = new Set<string>();
  const elements = (Array.isArray(m.elements) ? m.elements : d.elements).slice(0, L.elements).map((raw, i): MotionElement => {
    const e = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    let id = typeof e.id === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(e.id) ? e.id : `e${i}`;
    if (seen.has(id)) id = `e${i}`;
    seen.add(id);
    const out: MotionElement = { id, at: r4(clamp(finite(e.at) ? e.at : 0, 0, L.atS)) };
    if (typeof e.word === "string" && e.word.trim()) out.word = e.word.trim().slice(0, 200);   // MOT1b: a take-word id is the take's path plus #w<n>
    if (finite(e.beat)) out.beat = r4(round(clamp(e.beat, 0, L.beat), 0.25));
    if (MOTION_STYLES.includes(e.style as MotionStyle)) out.style = e.style as MotionStyle;
    if (finite(e.strength)) out.strength = num(e.strength, 1, L.strength, 0.01);
    return out;
  });
  return {
    timing: one(m.timing, MOTION_TIMINGS, d.timing), grid: one(m.grid, MOTION_GRIDS, d.grid),
    offsetBeats: num(m.offsetBeats, d.offsetBeats, L.offsetBeats, 0.25), elements,
    keepOrder: typeof m.keepOrder === "boolean" ? m.keepOrder : d.keepOrder,
    style: one(m.style, MOTION_STYLES, d.style), strength: num(m.strength, d.strength, L.strength, 0.01),
    push: num(m.push, d.push, L.push, 0.1), holdBeats: num(m.holdBeats, d.holdBeats, L.holdBeats, 0.25),
  };
}

/** Beat times, sorted, each once: the music analysis repeats a time as a beat, a bar and a hit. */
export function dedupeBeats(beats: readonly (number | { atS?: number; s?: number; t?: number })[] | null | undefined, toleranceS = 0.02): number[] {
  const times = (beats ?? []).map(b => typeof b === "number" ? b : b?.atS ?? b?.s ?? b?.t).filter(finite).filter(t => t >= 0).sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of times) if (!out.length || t - out[out.length - 1] > toleranceS) out.push(t);
  return out;
}

/** The typical beat length near a time (median of the nearest intervals), or the fallback without music. */
export function beatLength(beats: number[], nearS = 0): number {
  if (beats.length < 2) return FALLBACK_BEAT_S;
  const gaps = beats.slice(1).map((b, i) => ({ g: b - beats[i], d: Math.abs((b + beats[i]) / 2 - nearS) })).filter(x => x.g > 0.05).sort((a, b) => a.d - b.d).slice(0, 8).map(x => x.g).sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : FALLBACK_BEAT_S;
}
/** The time of a beat position (index + subdivision); beyond either end the beat length carries on. */
export function beatTime(beats: number[], position: number): number {
  if (!beats.length) return position * FALLBACK_BEAT_S;
  const last = beats.length - 1;
  if (position <= 0) return beats[0] + position * beatLength(beats, beats[0]);
  if (position >= last) return beats[last] + (position - last) * beatLength(beats, beats[last]);
  const i = Math.floor(position);
  return beats[i] + (position - i) * (beats[i + 1] - beats[i]);
}
/** The beat position of a time, the inverse of beatTime: how the inspector shows a time in beats. */
export function beatPosition(beats: number[], t: number): number {
  if (!beats.length) return t / FALLBACK_BEAT_S;
  const last = beats.length - 1;
  if (t <= beats[0]) return (t - beats[0]) / beatLength(beats, beats[0]);
  if (t >= beats[last]) return last + (t - beats[last]) / beatLength(beats, beats[last]);
  let i = 0;
  while (i < last && beats[i + 1] <= t) i++;
  return i + (t - beats[i]) / (beats[i + 1] - beats[i]);
}

export interface MotionContext {
  itemS: number; itemE: number;                 // the item on the edit's clock (reel seconds)
  words: { id: string; s: number; e: number; text?: string }[];   // MOT1b: text, so a word can be named and found by what he says
  beats: number[];                              // de-duplicated (dedupeBeats)
  syllables?: number[];                         // his syllable onsets, for timing without music
  fps?: number;                                 // frames land on; 30 when absent
}
export interface ResolvedMotion {
  times: number[];                              // reel seconds, one per element, on frames
  at: number[];                                 // the same, seconds from the item's start
  notes: string[];                              // plain words for anything that could not be done as asked
  moved: string[];                              // element ids that keep-order or hold moved off where they were asked to land
  orderGap: Record<string, "grid" | "frames">;  // MOT1b: each one keep order pushed, and how far after the one before: a grid step, or 4 frames
}
/** MOT1b: the least keep order leaves between two landings when a grid step won't fit, so two slams never overlap. */
export const MIN_GAP_FRAMES = 4;

/** Element times for the item as it sits now: words on their first frame, beats on the grid plus the offset, the order
 *  kept, and the hold at the end kept by pulling landings earlier. Nothing is lost: what can't be done is a note. */
export function resolveMotion(motion: Motion, ctx: MotionContext): ResolvedMotion {
  const fps = ctx.fps && ctx.fps > 0 ? ctx.fps : 30, F = 1 / fps;
  // exact frame times inside; rounded only on the way out, so `at` is a whole number of frames from a start on a frame
  const onFrame = (t: number) => Math.round(t * fps - 1e-6) / fps, floorFrame = (t: number) => Math.floor(t * fps + 1e-6) / fps;
  const beats = dedupeBeats(ctx.beats), words = new Map(ctx.words.map(w => [w.id, w]));
  const syllables = (ctx.syllables ?? []).filter(finite).sort((a, b) => a - b);
  const notes = new Set<string>(), moved = new Set<string>();
  const first = onFrame(ctx.itemS), last = floorFrame(ctx.itemE - F);
  const nearest = (list: number[], t: number) => list.reduce((x, y) => Math.abs(y - t) < Math.abs(x - t) ? y : x);
  const times = motion.elements.map(el => {
    let t = ctx.itemS + el.at;
    if (el.word !== undefined) {
      const w = words.get(el.word);
      if (w) t = w.s; else notes.add(MOTION_NOTES.lostWord);
    } else if (el.beat !== undefined && beats.length) t = beatTime(beats, round(el.beat, motion.grid) + motion.offsetBeats);
    else if (el.beat !== undefined || motion.timing === "syllables") {
      const inside = syllables.filter(s => s >= ctx.itemS - 1e-6 && s < ctx.itemE);
      if (inside.length) { t = nearest(inside, t); if (el.beat !== undefined) notes.add(MOTION_NOTES.noBeats); }
      else if (el.beat !== undefined) notes.add(MOTION_NOTES.noBeatsOrSyllables);
    }
    t = onFrame(t);
    if (t < first) { notes.add(MOTION_NOTES.beforeStart); t = first; }
    if (t > last) { notes.add(MOTION_NOTES.afterEnd); t = last; }
    return t;
  });
  // MOT1b: one pushed along lands a grid step after the one before (4 frames when a step won't fit in the scene), never
  // on the same frame, so two slams don't overlap; past the end it is the after-the-end note
  const step = (t: number) => motion.grid * beatLength(beats, t), orderGap: Record<string, "grid" | "frames"> = {};
  if (motion.keepOrder) for (let i = 1; i < times.length; i++) if (times[i] < times[i - 1]) {
    const after = times[i - 1], id = motion.elements[i].id;
    const ceilFrame = (x: number) => Math.ceil(x * fps - 1e-6) / fps;   // at least the gap, on a frame
    let t = ceilFrame(after + step(after)); orderGap[id] = "grid";
    if (t > last) { t = ceilFrame(after + MIN_GAP_FRAMES * F); orderGap[id] = "frames"; }
    if (t > last) { notes.add(MOTION_NOTES.afterEnd); t = last; }
    times[i] = t; moved.add(id);
  }
  if (motion.holdBeats > 0 && times.length) {
    const holdS = motion.holdBeats * beatLength(beats, ctx.itemE);
    let limit = floorFrame(ctx.itemE - holdS);
    if (limit < first) { notes.add(MOTION_NOTES.noHold); limit = first; }
    times.forEach((t, i) => { if (t > limit) { times[i] = limit; moved.add(motion.elements[i].id); } });
  }
  return { times: times.map(r4), at: times.map(t => r4(Math.max(0, t - ctx.itemS))), notes: [...notes], moved: [...moved], orderGap };
}

/** The motion with its elements' `at` replaced by resolved times (seconds from the item's start). */
export function withTimes(motion: Motion, at: number[]): Motion {
  return { ...motion, elements: motion.elements.map((e, i) => finite(at[i]) ? { ...e, at: r4(Math.max(0, at[i])) } : e) };
}

// ---- MOT1b: one change, the same from the inspector, the timeline's ticks, Ask and the MCP

/** His words on the reel clock, with an id that follows the word: a voiceover word's take-word id, else a camera word's
 *  piece and source time. Read from the caption source the titles keep (the words the captions are made of). */
export interface MotionWord { id: string; text: string; s: number; e: number }
export function motionWords(titles: unknown): MotionWord[] {
  const raw = (titles as { captionSource?: { words?: unknown[] } } | null | undefined)?.captionSource?.words;
  const seen = new Map<string, number>(), out: MotionWord[] = [];
  for (const w of Array.isArray(raw) ? raw : []) {
    const x = w as { text?: unknown; s?: unknown; e?: unknown; piece?: unknown; sourceS?: unknown; takeWord?: unknown };
    if (typeof x.text !== "string" || !finite(x.s) || !finite(x.e) || x.e <= x.s) continue;
    let id = (typeof x.takeWord === "string" && x.takeWord ? x.takeWord : `p${finite(x.piece) ? x.piece : 0}@${(finite(x.sourceS) ? x.sourceS : x.s).toFixed(3)}`).slice(0, 196);
    const n = seen.get(id) ?? 0; seen.set(id, n + 1);
    if (n) id = `${id}~${n}`;
    out.push({ id, text: x.text.trim(), s: x.s, e: x.e });
  }
  return out.sort((a, b) => a.s - b.s);
}

/** What each element is, for people: a beat-words scene's words, a title's lines, else its landings in order. */
export function motionLabels(params: Record<string, unknown> | undefined, count: number): string[] {
  const p = params ?? {}, words = Array.isArray(p.words) ? p.words : typeof p.words === "string" ? p.words.split(/\n|;/) : null;
  const lines = [p.line1, p.line2].filter((l): l is string => typeof l === "string" && !!l.trim());
  return Array.from({ length: count }, (_, i) => {
    const own = words ? words.map(w => String(w).trim()).filter(Boolean)[i] : lines.length ? lines[i] : undefined;
    return own ? own.toLocaleLowerCase("en") : `Landing ${i + 1}`;
  });
}

const quarter = (n: number) => { const q = Math.round(n * 4), w = Math.floor(q / 4), f = q - w * 4; return `${w || !f ? w : ""}${["", "¼", "½", "¾"][f]}`; };
/** A time as a beat counted from the scene's own first beat (1 = the beat at or before it starts): "2½", or "2.38" off the grid. */
export function beatLabel(beats: number[], itemS: number, t: number): string {
  const base = Math.floor(beatPosition(beats, itemS) + 1e-6), rel = beatPosition(beats, t) - base + 1;
  return Math.abs(rel * 4 - Math.round(rel * 4)) < 0.08 ? quarter(rel) : rel.toFixed(2);
}
/** His word as a label: the word without its punctuation ("match," is “match”). */
export const spokenWord = (text: string) => text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || text;

/** What an element lands on, in words, first: “On “ever”, 0.21 s”, “Beat 1¼, 0.00 s” (a beat anchor, in quarter
 *  steps counted from the scene's first beat, never a decimal) or “Free, 0.11 s”. The inspector rows and the ticks. */
export function elementLine(motion: Motion, i: number, at: number, ctx: MotionContext): string {
  const e = motion.elements[i], s = `${at.toFixed(2)} s`, beats = dedupeBeats(ctx.beats);
  const word = e?.word !== undefined ? ctx.words.find(w => w.id === e.word) : undefined;
  if (word) return `On “${spokenWord(word.text ?? "")}”, ${s}`;
  if (e?.beat !== undefined && beats.length) {
    const base = Math.floor(beatPosition(beats, ctx.itemS) + 1e-6);
    return `Beat ${quarter(round(e.beat, motion.grid) + motion.offsetBeats - base + 1)}, ${s}`;
  }
  return `Free, ${s}`;
}

export interface MotionElementChange {
  id: string;
  at?: number;                                  // seconds from the item's start, free of any word or beat
  beat?: number;                                // a beat position (as get_motion lists it); it snaps to the grid
  word?: string;                                // a word id (or the word itself, nearest inside the item)
  shiftBeats?: number;                          // move it by this many beats from where it lands now (0.5 = half a beat later)
  nudge?: -1 | 1;                               // to the next grid line before or after where it lands now
  style?: MotionStyle | null; strength?: number | null;   // null = the item's own again
}
export type MotionChange = Partial<Pick<Motion, "timing" | "grid" | "offsetBeats" | "keepOrder" | "style" | "strength" | "push" | "holdBeats">> & { elements?: MotionElementChange[] };
export interface MotionChanged { motion: Motion; resolved: ResolvedMotion; changed: string[]; notes: string[] }

const KNOB_WORDS: Record<string, string> = { timing: "timing", grid: "grid", offsetBeats: "beat offset", keepOrder: "keep order", style: "style", strength: "strength", push: "push", holdBeats: "hold" };
const knobValue = (k: string, v: unknown) => k === "grid" ? (v === 1 ? "1 beat" : v === 0.5 ? "half beats" : "quarter beats") : k === "holdBeats" || k === "offsetBeats" ? `${v} beat${v === 1 || v === -1 ? "" : "s"}`
  : k === "push" ? `${v}%` : k === "keepOrder" ? (v ? "on" : "off") : String(v);

/** His words that start inside the item: from a frame before it (a scene cuts in on the frame he starts a word) to its end. */
export function wordsInSpan(ctx: MotionContext): MotionContext["words"] {
  const F = 1 / (ctx.fps && ctx.fps > 0 ? ctx.fps : 30);
  return ctx.words.filter(w => w.s >= ctx.itemS - F - 1e-6 && w.s < ctx.itemE);
}
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
/** An element given a word by what he says ("match") instead of its id takes the id of that word in the item's span,
 *  the one nearest its time, so it follows his voice from then on. Ids, and words he doesn't say there, are left alone. */
export function anchorWordsByText(motion: Motion, ctx: MotionContext): Motion {
  const ids = new Set(ctx.words.map(w => w.id)), inside = wordsInSpan(ctx).filter(w => w.text !== undefined);
  if (!motion.elements.some(e => e.word !== undefined && !ids.has(e.word))) return motion;
  return { ...motion, elements: motion.elements.map(e => {
    if (e.word === undefined || ids.has(e.word)) return e;
    const found = inside.filter(w => norm(w.text!) === norm(e.word!)).sort((a, b) => Math.abs(a.s - ctx.itemS - e.at) - Math.abs(b.s - ctx.itemS - e.at))[0];
    return found ? { ...e, word: found.id } : e;
  }) };
}

/** Apply one change to a motion record and resolve it for the item as it sits now. Unknown elements or words are
 *  refused in plain words; everything else lands, and what could not be done exactly is a note. */
export function changeMotion(motion: Motion, change: MotionChange, ctx: MotionContext, labels: string[] = []): MotionChanged {
  motion = anchorWordsByText(motion, ctx);
  const before = resolveMotion(motion, ctx), beats = dedupeBeats(ctx.beats);
  const next: Motion = { ...motion, elements: motion.elements.map(e => ({ ...e })) };
  for (const k of ["timing", "grid", "offsetBeats", "keepOrder", "style", "strength", "push", "holdBeats"] as const)
    if (change[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = change[k];
  for (const c of change.elements ?? []) {
    const i = next.elements.findIndex(e => e.id === c.id);
    if (i < 0) throw new Error(`There is no element "${c.id}" in this graphic. get_motion lists them.`);
    const el = next.elements[i], now = before.times[i] ?? ctx.itemS + el.at;
    const free = (at: number) => { delete el.word; delete el.beat; el.at = r4(Math.max(0, at)); };
    if (c.word !== undefined) {
      const found = ctx.words.find(w => w.id === c.word) ?? wordsInSpan(ctx).filter(w => w.text !== undefined && norm(w.text) === norm(c.word!)).sort((a, b) => Math.abs(a.s - now) - Math.abs(b.s - now))[0];
      if (!found) throw new Error(`He doesn't say "${c.word}" in this graphic's span. get_motion lists the words he says there.`);
      delete el.beat; el.word = found.id; el.at = r4(Math.max(0, found.s - ctx.itemS));
    } else if (c.beat !== undefined) { delete el.word; el.beat = c.beat; }
    else if (c.at !== undefined) free(c.at);
    else if (c.shiftBeats !== undefined) free(now + c.shiftBeats * beatLength(beats, now) - ctx.itemS);
    else if (c.nudge) {
      const g = next.grid;
      if (!beats.length) free(now + c.nudge * g * FALLBACK_BEAT_S - ctx.itemS);
      else {
        // from its grid line when it is on the beat; else from where it lands, within a frame of a line counting as on it
        const tol = el.beat !== undefined ? 1e-3 : 0.6 / (ctx.fps || 30) / beatLength(beats, now) / g;
        const pos = (el.beat !== undefined ? round(el.beat, g) : beatPosition(beats, now) - next.offsetBeats) / g;
        delete el.word; el.beat = c.nudge > 0 ? (Math.floor(pos + tol) + 1) * g : (Math.ceil(pos - tol) - 1) * g;
      }
    }
    if (c.style !== undefined) { if (c.style === null) delete el.style; else el.style = c.style; }
    if (c.strength !== undefined) { if (c.strength === null) delete el.strength; else el.strength = c.strength; }
  }
  const clamped = clampMotion(next), resolved = resolveMotion(clamped, ctx), out = withTimes(clamped, resolved.at);
  const changed: string[] = [];
  for (const k of Object.keys(KNOB_WORDS) as (keyof typeof KNOB_WORDS)[]) {
    const a = (motion as unknown as Record<string, unknown>)[k], b = (out as unknown as Record<string, unknown>)[k];
    if (a !== b) changed.push(`${KNOB_WORDS[k]} ${knobValue(k, a)} to ${knobValue(k, b)}`);
  }
  const name = (i: number) => labels[i] ? `“${labels[i]}”` : out.elements[i].id;
  const lands = (i: number) => elementLine(out, i, resolved.at[i], ctx).replace(/^On /, "on ").replace(/^Beat /, "on beat ").replace(/^Free, /, "free, ");
  out.elements.forEach((e, i) => {
    const was = motion.elements[i], dt = r4(resolved.times[i] - (before.times[i] ?? resolved.times[i]));
    if (Math.abs(dt) > 1e-4) changed.push(`${name(i)} lands ${Math.abs(dt).toFixed(2)} s ${dt > 0 ? "later" : "earlier"} (${lands(i)})`);
    else if ((was?.word ?? null) !== (e.word ?? null) || (was?.beat ?? null) !== (e.beat ?? null)) changed.push(`${name(i)} now ${e.word ? "follows his word" : e.beat !== undefined ? "sits on the beat" : "keeps its own time"}`);
    if ((was?.style ?? null) !== (e.style ?? null)) changed.push(`${name(i)} style ${e.style ?? `back to the scene's (${out.style})`}`);
    if ((was?.strength ?? null) !== (e.strength ?? null)) changed.push(`${name(i)} strength ${e.strength ?? `back to the scene's (${out.strength})`}`);
  });
  // why the ones nobody asked about moved: the hold at the end pulled them earlier, or keep order pushed them along
  const asked = new Set((change.elements ?? []).map(c => c.id)), notes = [...resolved.notes];
  const loose = (m: Motion) => resolveMotion({ ...m, holdBeats: 0 }, ctx).times;
  const unheld = loose(clamped), unheldBefore = loose(motion);
  const heldNow = out.elements.map((_, i) => i).filter(i => resolved.times[i] < unheld[i] - 1e-6);
  const heldBefore = new Set(motion.elements.map((_, i) => i).filter(i => before.times[i] < unheldBefore[i] - 1e-6));
  const held = heldNow.filter(i => !asked.has(out.elements[i].id) && (change.holdBeats !== undefined || !heldBefore.has(i)));
  const kept = resolved.moved.filter(id => !asked.has(id) && !before.moved.includes(id)).map(id => out.elements.findIndex(e => e.id === id)).filter(i => !heldNow.includes(i));
  const and = (list: number[]) => `${list.map(name).join(" and ")} ${list.length > 1 ? "land" : "lands"}`;
  const gapWords = (kind: "grid" | "frames") => kind === "frames" ? `${MIN_GAP_FRAMES} frames` : out.grid === 1 ? "a beat" : out.grid === 0.5 ? "half a beat" : "a quarter beat";
  for (const kind of ["grid", "frames"] as const) {
    const these = kept.filter(i => (resolved.orderGap[out.elements[i].id] ?? "grid") === kind);
    if (these.length) notes.push(`To keep the order, ${and(these)} ${gapWords(kind)} after the one before.`);
  }
  if (held.length) notes.push(`To hold ${knobValue("holdBeats", out.holdBeats)} at the end, ${and(held)} earlier.`);
  return { motion: out, resolved, changed, notes };
}
