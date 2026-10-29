import { isScreenClip } from '../shared/screen';
// PF1: small, verified things precut found while it works. Every line is read from
// the shoot's saved data by code (never written by a model), and a feed lets at most
// one through per gap so the page stays calm.
import { clipTurn } from "../shared/media";
import type { Clip, Shoot } from "../shared/schema";

export interface Discovery {
  id: string;                          // stable: the same finding is never told twice
  kind: "mic" | "takes" | "best" | "stumble" | "screen" | "broll" | "rotation";
  text: string;
  clipId?: string; t?: number;         // where a click goes
  clipIds?: string[];                  // WR: the clips it is about, that one first (at most six)
}
export interface AnnouncedDiscovery extends Discovery { at: number }

const stamp = (t: number) => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, "0")}`;
const noun = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// WR: the clip a discovery is about first, then the other clips it names. Unique, at most six.
const clipsOf = (first: string | undefined, rest: string[]) => [...new Set([...(first ? [first] : []), ...rest])].slice(0, 6);
const stumbled = (note: string) => /\bstumbl(?:e|es|ed|ing)\b/i.test(note) && !/\b(?:no|not|without|never|didn't|doesn't)\s+(?:\w+\s+)?stumbl/i.test(note);

// WR4: whether a clip's words are the person's, from the judge or their own tag. Speech on
// b-roll is someone else's (a checkout machine, a passer-by, a TV), so its ums and stumbles
// are not theirs to hear about. null = not judged yet, so nobody knows whose voice it is.
export function wordsAreTheirs(clip: Pick<Clip, "byHand" | "judgement"> | undefined): boolean | null {
  const kind = clip?.byHand?.kind ?? clip?.judgement?.kind;
  return kind === undefined ? null : kind !== "broll";
}

/** Everything that is true of the shoot right now, in the order a person would care about it. */
export function discoveriesOf(shoot: Shoot | null): Discovery[] {
  if (!shoot) return [];
  const found: Discovery[] = [];
  const clips = shoot.clips ?? [];
  const upright = clips.filter(c => c.judgement?.rotate && c.byHand?.rotate === undefined && clipTurn(c));
  if (upright.length) found.push({ id: "rotation", kind: "rotation", text: `Turned ${noun(upright.length, "clip")} upright`, clipId: upright[0].id, clipIds: upright.map(c => c.id) });
  const mic = clips.filter(c => c.sound && c.sound.confidence > 0);
  if (mic.length) found.push({ id: "mic", kind: "mic", text: `Matched your microphone to ${noun(mic.length, "clip")}`, clipId: mic[0].id, clipIds: clipsOf(mic[0].id, mic.map(c => c.id)) });
  for (const take of [...(shoot.takes ?? [])].sort((a, b) => a.lineIndex - b.lineIndex)) {
    const attempts = take.attempts.filter(a => !a.practice);
    const line = take.lineIndex === 0 ? "your opening line" : `line ${take.lineIndex + 1}`;
    const takeClips = take.attempts.map(a => a.clipId);
    if (attempts.length > 1) found.push({ id: `takes:${take.lineIndex}`, kind: "takes", text: `Found ${noun(attempts.length, "take")} of ${line}`,
      clipId: attempts[0].clipId, t: attempts[0].s, clipIds: clipsOf(attempts[0].clipId, attempts.map(a => a.clipId)) });
    const best = take.attempts[take.starred];
    if (attempts.length > 1 && best && !best.practice && !take.starredByHand) found.push({ id: `best:${take.lineIndex}`, kind: "best",
      text: `Take ${take.starred + 1} is the strongest of ${line} so far`, clipId: best.clipId, t: best.s, clipIds: clipsOf(best.clipId, attempts.map(a => a.clipId)) });
    for (const a of take.attempts) if (stumbled(a.note) && wordsAreTheirs(clips.find(c => c.id === a.clipId)) !== false) found.push({ id: `stumble:${a.clipId}:${a.s}`, kind: "stumble",
      text: `A take of ${line} has a stumble at ${stamp(a.s)}`, clipId: a.clipId, t: a.s, clipIds: clipsOf(a.clipId, takeClips) });
  }
  const screens = clips.filter(isScreenClip);
  if (screens.length) found.push({ id: "screen", kind: "screen", text: `Found ${noun(screens.length, "screen recording")}`, clipId: screens[0].id, clipIds: clipsOf(screens[0].id, screens.map(c => c.id)) });
  const broll = clips.filter(c => (c.byHand?.kind ?? c.judgement?.kind) === "broll");
  if (broll.length) found.push({ id: "broll", kind: "broll", text: `Found ${noun(broll.length, "b-roll clip")}`, clipId: broll[0].id, clipIds: clipsOf(broll[0].id, broll.map(c => c.id)) });
  return found;
}

/** Hands out one discovery at a time. While nothing is processing, what exists is marked told, silently. */
export class DiscoveryFeed {
  private told = new Map<string, AnnouncedDiscovery>();
  private last = -Infinity;
  private shown: { d: AnnouncedDiscovery; until: number } | null = null;
  constructor(private gapMs = 20_000, private showMs = 6_000) {}
  poll(found: Discovery[], live: boolean, now = Date.now()): { toast: Discovery | null; told: AnnouncedDiscovery[] } {
    if (!live) {
      for (const d of found) if (!this.told.has(d.id)) this.told.set(d.id, { ...d, at: -1 });
      this.shown = null;
      return { toast: null, told: this.list() };
    }
    if (this.shown && now >= this.shown.until) this.shown = null;
    if (!this.shown && now - this.last >= this.gapMs) {
      const next = found.find(d => !this.told.has(d.id));
      if (next) {
        const d = { ...next, at: now };
        this.told.set(d.id, d); this.last = now; this.shown = { d, until: now + this.showMs };
      }
    }
    return { toast: this.shown?.d ?? null, told: this.list() };
  }
  private list(): AnnouncedDiscovery[] { return [...this.told.values()].filter(d => d.at >= 0); }
}

const feeds = new Map<string, DiscoveryFeed>();
export function discoveryFeed(root: string): DiscoveryFeed {
  let feed = feeds.get(root);
  if (!feed) { feed = new DiscoveryFeed(); feeds.set(root, feed); }
  return feed;
}
