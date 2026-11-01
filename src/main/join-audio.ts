import type { CutItem } from './export';
import type { FxItem, FxPlan, TimeKey } from './edits-fx';

export type AudioHandle = { leadS: number; trailS: number; fadeInS: number; fadeOutS: number };
const words = (c: CutItem) => (c.seg?.clip.transcript?.flatMap(p => p.words) ?? c.seg?.speechWords ?? [])
  .filter(w => Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s);
const known = (c: CutItem) => !!c.seg && c.seg.lineIndex !== null && !!words(c).length;
const edgeSpeed = (p: FxItem, head: boolean) => {
  const k = head ? p.timeMap.slice(0, 2) : p.timeMap.slice(-2);
  return (k[1].s - k[0].s) / (k[1].t - k[0].t);
};
function at(keys: TimeKey[], s: number) {
  for (let i = 1; i < keys.length; i++) if (s <= keys[i].s) {
    const a = keys[i - 1], b = keys[i];
    return a.t + (s - a.s) * (b.t - a.t) / (b.s - a.s);
  }
  return keys.at(-1)!.t;
}
/** Extend source handles without moving any existing word out of sync. Unknown
 * timings never authorize an overlap. Shorten at the nearest speech collision. */
export function planAudioHandles(cuts: CutItem[], plan: FxPlan): void {
  let j = 0;
  for (let i = 1; i < cuts.length; i++) {
    if (plan.items[i - 1].piece === plan.items[i].piece) continue;
    const join = plan.joins[j++], wanted = join.choice.audio;
    if (!wanted || (!wanted.leadS && !wanted.trailS)) continue;
    const a = plan.items[i - 1], b = plan.items[i];
    // VT1: b-roll plays no sound of its own, so a measured take next to it may
    // carry its natural sound across (L cut into b-roll, J cut out of it), but
    // never its neighbouring words.
    const silent = (c: CutItem) => !!c.seg && c.seg.lineIndex === null;
    const intoBroll = silent(cuts[i]) && known(cuts[i - 1]), outOfBroll = silent(cuts[i - 1]) && known(cuts[i]);
    // Dissolves already own their audio overlap. Reverse has no dialogue.
    if (b.overlap || a.reverse || b.reverse || (!(known(cuts[i - 1]) && known(cuts[i])) && !intoBroll && !outOfBroll)) {
      join.choice = { ...join.choice, audio: { leadS: 0, trailS: 0 } }; continue;
    }
    const sa = edgeSpeed(a, false), sb = edgeSpeed(b, true), boundary = b.startS;
    const endA = a.timeMap.at(-1)!.s, startB = b.timeMap[0].s;
    let lead = Math.min(wanted.leadS ?? 0, startB / sb, boundary - a.startS);
    let trail = Math.min(wanted.trailS ?? 0, Math.max(0, (cuts[i - 1].seg!.clip.meta!.durationS - endA) / sa), b.endS - boundary);
    const soundB = cuts[i].seg!.clip.sound;
    if (soundB) lead = Math.min(lead, Math.max(0, (startB + soundB.offsetS) / sb));
    // Compare actual timeline intervals, including speed ramps and guard bands.
    const spokenA = outOfBroll ? [] : words(cuts[i - 1]).filter(w => w.e > a.timeMap[0].s && w.s < endA)
      .map(w => ({ s: at(a.timeMap, Math.max(w.s, a.timeMap[0].s)) - .03, e: at(a.timeMap, Math.min(w.e, endA)) + .03 }));
    const spokenB = intoBroll ? [] : words(cuts[i]).filter(w => w.e > startB && w.s < b.timeMap.at(-1)!.s)
      .map(w => ({ s: at(b.timeMap, Math.max(w.s, startB)) - .03, e: at(b.timeMap, Math.min(w.e, b.timeMap.at(-1)!.s)) + .03 }));
    if (intoBroll) {
      lead = 0;
      const next = words(cuts[i - 1]).filter(w => w.e > endA).reduce((n, w) => Math.min(n, w.s), Infinity);
      if (Number.isFinite(next)) trail = Math.min(trail, Math.max(0, (next - .03 - endA) / sa));
    }
    if (outOfBroll) {
      trail = 0;
      const previous = words(cuts[i]).filter(w => w.s < startB).reduce((n, w) => Math.max(n, w.e), -Infinity);
      if (Number.isFinite(previous)) lead = Math.min(lead, Math.max(0, (startB - previous - .03) / sb));
    }
    for (const w of words(cuts[i]).filter(w => w.s < startB)) {
      const s = boundary + (w.s - startB) / sb - .03, e = boundary + (w.e - startB) / sb + .03;
      for (const v of spokenA) if (s < v.e && e > v.s) lead = Math.min(lead, Math.max(0, boundary - e));
    }
    for (const w of words(cuts[i - 1]).filter(w => w.e > endA)) {
      const s = boundary + (w.s - endA) / sa - .03, e = boundary + (w.e - endA) / sa + .03;
      for (const v of spokenB) if (s < v.e && e > v.s) trail = Math.min(trail, Math.max(0, s - boundary));
    }
    // A handle must not repeat words already used by the adjacent source cut.
    if (cuts[i - 1].seg!.clip.id === cuts[i].seg!.clip.id) {
      lead = Math.min(lead, Math.max(0, (startB - endA) / sb));
      trail = Math.min(trail, Math.max(0, (startB - endA) / sa));
      if (lead && trail) trail = 0;
    }
    lead = Math.max(0, Math.floor((lead + 1e-9) * 48000) / 48000);
    trail = Math.max(0, Math.floor((trail + 1e-9) * 48000) / 48000);
    join.choice = { ...join.choice, audio: { leadS: lead, trailS: trail } };
    a.audio ??= { leadS: 0, trailS: 0, fadeInS: 0, fadeOutS: 0 };
    b.audio ??= { leadS: 0, trailS: 0, fadeInS: 0, fadeOutS: 0 };
    b.audio.leadS = lead; a.audio.trailS = trail;
    a.audio.fadeOutS = lead + trail;
    b.audio.fadeInS = lead + trail;
  }
  // On short consecutive pieces two extended handles can meet each other.
  // Test the whole track as well as each pair's base speech. Withdraw a handle
  // rather than allow any unmeasured simultaneous dialogue or repeated word.
  if (!plan.items.some(p => p.audio)) return;
  const spans = plan.items.map(audioSpan);
  const spoken = cuts.map((cut, i) => words(cut).filter(w => w.s < spans[i].timeMap.at(-1)!.s && w.e > spans[i].timeMap[0].s).map(w => ({
    s: at(spans[i].timeMap, Math.max(w.s, spans[i].timeMap[0].s)) - .03,
    e: at(spans[i].timeMap, Math.min(w.e, spans[i].timeMap.at(-1)!.s)) + .03,
    lead: w.s < plan.items[i].timeMap[0].s, trail: w.e > plan.items[i].timeMap.at(-1)!.s,
  })));
  for (let i = 0; i < cuts.length; i++) for (let n = i + 1; n < cuts.length && spans[n].startS < spans[i].endS + .06; n++) {
    for (const a of spoken[i]) for (const b of spoken[n]) if (a.s < b.e && b.s < a.e) {
      if (a.lead && plan.items[i].audio) plan.items[i].audio!.leadS = 0;
      if (a.trail && plan.items[i].audio) plan.items[i].audio!.trailS = 0;
      if (b.lead && plan.items[n].audio) plan.items[n].audio!.leadS = 0;
      if (b.trail && plan.items[n].audio) plan.items[n].audio!.trailS = 0;
    }
  }
  j = 0;
  for (let i = 1; i < cuts.length; i++) {
    if (plan.items[i - 1].piece === plan.items[i].piece) continue;
    const join = plan.joins[j++], a = plan.items[i - 1].audio, b = plan.items[i].audio;
    if (!join.choice.audio) continue;
    const leadS = b?.leadS ?? 0, trailS = a?.trailS ?? 0;
    if (a) a.fadeOutS = leadS + trailS;
    if (b) b.fadeInS = leadS + trailS;
    join.choice = { ...join.choice, audio: { leadS, trailS } };
  }
}

/** The exact source/time range used by playback, rendering and editor tracks. */
export function audioSpan(item: FxItem): FxItem {
  const lead = item.audio?.leadS ?? 0, trail = item.audio?.trailS ?? 0;
  const keys = item.timeMap;
  return { ...item, startS: item.startS - lead, endS: item.endS + trail,
    timeMap: [...(lead ? [{ t: item.startS - lead, s: keys[0].s - lead * edgeSpeed(item, true) }] : []),
      ...keys, ...(trail ? [{ t: item.endS + trail, s: keys.at(-1)!.s + trail * edgeSpeed(item, false) }] : [])] };
}

/** REL09e: where a fade out of `fadeS` starts in a clip `d` long, as plain decimals ffmpeg reads. A J cut out of a short
 * b-roll can take the b-roll's whole length (lead bounded by boundary - a.startS), leaving d - fade a rounding hair from
 * zero; JavaScript wrote it 1.05e-15 and ffmpeg refused the exponent, so the whole export failed. Under a microsecond is 0;
 * every other start is written as before (String never uses an exponent from 1e-6 up). */
export const fadeOutStart = (d: number, fadeS: number): string => { const st = d - fadeS; return st < 1e-6 ? '0' : String(st); };

export function joinAudioMix(plan: FxPlan, filters: string[], output: string): void {
  plan.items.forEach((item, i) => {
    const span = audioSpan(item), d = span.endS - span.startS, fadeIn = item.audio?.fadeInS ?? 0, fadeOut = item.audio?.fadeOutS ?? 0;
    filters.push(`[a${i}]atrim=duration=${d},${fadeIn ? `afade=t=in:d=${fadeIn},` : ''}${fadeOut ? `afade=t=out:st=${fadeOutStart(d, fadeOut)}:d=${fadeOut},` : ''}adelay=${Math.round(span.startS * 48000)}S:all=1,apad,atrim=duration=${plan.durationS}[jl${i}]`);
  });
  filters.push(plan.items.map((_, i) => `[jl${i}]`).join('') + `amix=inputs=${plan.items.length}:normalize=0:duration=longest[${output}]`);
}
