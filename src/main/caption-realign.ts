// 0.7.1: captions stay on the voice. A picture edit that ripples the voice (removing b-roll, a trim, a split) moves the
// voiceover lines when it is saved; the saved caption words must move with them in the same save, or captions run late
// and their key word indices point past the words (a real edit, v560 to v565: 191 saved words against 190 heard,
// every caption after 29.8 s 0.66 s late, and opening Captions blanked the window). No model call anywhere here.
import type { AudioFile, CaptionStyle, CutVersion, Shoot, TitleCue, TitleTrack } from "../shared/schema";
import type { StoredVersion } from "./sidekick";
import { buildCaptionTrack, type CaptionTrack, type KineticLine } from "./titles/captions";
import { DEFAULT_OPENING_STYLE, openingLine } from "./titles/opening";

type VoiceWord = { s: number; e: number; takeWord?: string; occurrence?: string };
const key = (w: VoiceWord) => `${w.takeWord}\u0000${w.occurrence ?? ""}`;
export const REALIGNED = "Captions realigned to the voice";

/** The saved voice caption words no longer sit on the voice heard now: a voice word added or gone, or one at another
 * time. Text is not compared (his corrections change it); only voice words (with a take-word id) are. */
export function voiceCaptionsDrift(saved: readonly VoiceWord[] | undefined, heard: readonly VoiceWord[]): boolean {
  const a = (saved ?? []).filter(w => w.takeWord), b = heard.filter(w => w.takeWord);
  if (a.length !== b.length) return true;
  // A word heard twice (a take word on both sides of a split seam) is matched in order.
  const at = new Map<string, VoiceWord[]>();
  for (const w of [...b].sort((x, y) => x.s - y.s)) at.set(key(w), [...at.get(key(w)) ?? [], w]);
  return [...a].sort((x, y) => x.s - y.s).some(w => { const h = at.get(key(w))?.shift(); return !h || Math.abs(h.s - w.s) > .02 || Math.abs(h.e - w.e) > .02; });
}

const withTakes = (shoot: Shoot, takes: AudioFile[]): Shoot => ({ ...shoot, audio: [...(shoot.audio ?? []).filter(a => !takes.some(t => t.file === a.file)), ...takes] });

/** In place on `record` (its voiceover already on this picture): when its captions are off the voice, they follow it,
 * as a voice edit's captions do (his corrections kept, key words carried by take-word id), and his designed lines (the
 * opening, lines made big) move with their own words (keepDesignOnVoice, run by followVoiceCaptions). True when the
 * captions changed. */
export async function followCaptionsToVoice(root: string, record: StoredVersion): Promise<boolean> {
  const titles = record.titles as (CaptionTrack & { captionSource?: { words: VoiceWord[] } }) | null | undefined;
  if (!titles?.captionSource?.words.length || record.captionLanguage || !record.voiceover?.lines.some(l => l.take)) return false;
  const { voiceoverCaptionWords, followVoiceCaptions } = await import("./titles");
  const shoot = withTakes(record.assembly.shoot, await (await import("./voiceover-takes")).listVoiceovers(root));
  const heard = voiceoverCaptionWords(shoot, record).words as VoiceWord[];
  if (!voiceCaptionsDrift(titles.captionSource.words, heard) && !designOffWords(titles, record.bigLines)) return false;
  const before = JSON.stringify([titles, record.bigLines]);
  await followVoiceCaptions(root, record, shoot, record.assembly.template, record.assembly.cutList, { onlyExisting: true });
  return JSON.stringify([record.titles, record.bigLines]) !== before;
}

// CAP1: his caption design stays on the voice. Designed lines (the opening, lines he made big) are drawn only while
// every one of their words is a caption word at exactly that time; a save that moved the voice used to leave them on the
// old times, and following re-measured them by time window, so the opening showed other words or none.
type DesignWord = { text: string; s: number; e: number; accent?: boolean };
type SourceWord = DesignWord & VoiceWord;
const sameTime = (a: { s: number; e: number }, b: { s: number; e: number }) => Math.abs(a.s - b.s) < 1e-6 && Math.abs(a.e - b.e) < 1e-6;
const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const lineWords = (line: KineticLine) => line.cues.flatMap(c => c.words ?? []).filter(w => Number.isFinite(w.s) && Number.isFinite(w.e));
/** Lines the style draws: the opening (Auto), every line (Throughout), and any line he made big. */
function drawnLines(track: CaptionTrack, bigLines: CutVersion["bigLines"]): KineticLine[] {
  const hook = track.captionStyle?.hook;
  if (!track.kinetic || hook === "off") return [];
  return track.kinetic.lines.filter(l => { const pick = bigLines?.find(b => Math.abs(b.s - l.s) < 1e-7); return pick ? pick.big : hook === "all" || l.hook; });
}
/** A drawn designed line is not on the caption words it shows (a save moved the voice under it). */
export function designOffWords(track: CaptionTrack | null | undefined, bigLines: CutVersion["bigLines"]): boolean {
  const words = track?.captionSource?.words;
  if (!track?.captionStyle || !words?.length) return false;
  return drawnLines(track, bigLines).some(l => { const own = lineWords(l); return !own.length ? false : own.some(w => !words.some(a => sameTime(a, w) && a.text.toLowerCase() === w.text.toLowerCase())); });
}

/** CAP1, after captions follow the voice (same save, no model call): every designed line moves with its own words by
 * take-word identity onto the words heard now. A line whose words were read again (a take swap) is carried by its
 * words in order. The opening is kept while it still leads; when new speech leads (its words went, or speech came in
 * front) it is rebuilt from the first spoken words in his opening style, in his caption lines with his key words, and
 * marked so choosing Auto again asks the designer for a new one. Lines whose words are gone stay in the design, undrawn,
 * as before. `before` is the track as it was before following. True when the track changed. */
export function keepDesignOnVoice(record: CutVersion, before: TitleTrack | null | undefined): boolean {
  const prior = before as CaptionTrack | null | undefined, track = record.titles as CaptionTrack | null | undefined;
  if (record.captionLanguage || !track?.captionStyle || !track.captionSource || !prior?.kinetic?.lines.length) return false;
  const style = track.captionStyle, oldWords = (prior.captionSource?.words ?? []) as SourceWord[];
  const words = [...track.captionSource.words as SourceWord[]].sort((a, b) => a.s - b.s);
  // A take word heard twice (both sides of a split seam with a gap between) is matched in order, as voiceCaptionsDrift does.
  const byKey = new Map<string, SourceWord[]>(), oldByKey = new Map<string, SourceWord[]>();
  for (const w of words) if (w.takeWord) byKey.set(key(w), [...byKey.get(key(w)) ?? [], w]);
  for (const w of [...oldWords].sort((a, b) => a.s - b.s)) if (w.takeWord) oldByKey.set(key(w), [...oldByKey.get(key(w)) ?? [], w]);
  const oldOf = (w: DesignWord) => oldWords.find(o => sameTime(o, w) && o.text.toLowerCase() === w.text.toLowerCase());
  const lead = (first: { s: number } | undefined, list: { s: number }[]) => first ? list.filter(w => w.s < first.s - 1e-6).length : Infinity;
  const oldSorted = [...oldWords].sort((a, b) => a.s - b.s);
  /** The line's words, each paired with the word heard now; null when any is missing or speech came in between. */
  const carry = (line: KineticLine, pair: (own: DesignWord[]) => (SourceWord | undefined)[]): KineticLine | null => {
    const own = lineWords(line);
    if (!own.length) return null;
    const next = pair(own);
    if (next.some(w => !w)) return null;
    const to = next as SourceWord[];
    if (to.some((w, i) => i && w.s < to[i - 1].s - 1e-9)) return null;
    const inside = words.filter(w => w.s >= to[0].s - 1e-7 && w.e <= to.at(-1)!.e + 1e-7);
    if (inside.length !== new Set(to).size) return null;  // another word is spoken inside the line: it is not this line any more
    const still = own.every((w, i) => sameTime(w, to[i]) && w.text === to[i].text);
    // Times on the line's own clock: a word edge maps to the same edge now; anything else keeps its offset from the
    // word it follows (the opening's phrases all run to the line's end, and its edge spans).
    const map = (t: number) => {
      if (still) return t;
      for (let i = 0; i < own.length; i++) { if (Math.abs(own[i].s - t) < 1e-6) return to[i].s; if (Math.abs(own[i].e - t) < 1e-6) return to[i].e; }
      let i = 0;
      own.forEach((w, j) => { if (w.s <= t) i = j; });
      return t + to[i].s - own[i].s;
    };
    const at = new Map(own.map((w, i) => [w, to[i]]));
    const word = <W extends DesignWord>(w: W): W => { const n = at.get(w); return n ? { ...w, text: n.text, s: n.s, e: n.e } : { ...w, s: map(w.s), e: map(w.e) }; };
    return { ...line, s: map(line.s), e: map(line.e), ...(line.edges ? { edges: line.edges.map(x => ({ s: map(x.s), e: map(x.e) })) } : {}),
      cues: line.cues.map(c => {
        const cue = { ...c, s: map(c.s), e: map(c.e), ...(still ? {} : { layer: "front" as const }), words: c.words?.map(word) } as TitleCue & { wordFixSource?: { words?: DesignWord[]; text: string } };
        // The words the cue had before a vocabulary fix: re-measured by their times on later rebuilds, so they stay on
        // the cue's own clock (a picture edit's retime moved the cue but not these). Gone when they can't be placed.
        const fix = cue.wordFixSource, first = cue.words?.[0], fixed = fix?.words?.map(w => ({ ...w, s: map(w.s), e: map(w.e) }));
        if (!fix || !fixed?.length || !first) return cue;
        const shift = fixed.every(w => words.some(n => sameTime(n, w))) ? 0 : plain(fixed[0].text) === plain(first.text) ? first.s - fixed[0].s : NaN;
        if (Number.isNaN(shift)) delete cue.wordFixSource;
        else if (!still || shift) cue.wordFixSource = { ...fix, words: fixed.map(w => ({ ...w, s: w.s + shift, e: w.e + shift })) };
        return cue;
      }) };
  };
  const byIdentity = (own: DesignWord[]) => own.map(w => { const o = oldOf(w); return o?.takeWord ? byKey.get(key(o))?.[oldByKey.get(key(o))!.indexOf(o)] : !o ? undefined : words.find(n => !n.takeWord && sameTime(n, o)); });
  /** The same words in order, read again (another take or occurrence), starting at one of `starts`. */
  const byText = (starts: number[]) => (own: DesignWord[]) => {
    for (const start of starts) {
      const run = words.slice(start, start + own.length);
      if (run.length === own.length && run.every((w, i) => plain(w.text) === plain(own[i].text))) return run;
    }
    return own.map(() => undefined);
  };
  const uniqueText = (own: DesignWord[]) => {
    const starts = words.flatMap((_, i) => byText([i])(own)[0] ? [i] : []);
    return starts.length === 1 ? byText(starts)(own) : own.map(() => undefined);
  };
  const lines = prior.kinetic.lines.map(line => ({ line, next: carry(line, byIdentity) ?? (line.hook ? null : carry(line, uniqueText)) }));
  // The opening: kept while it leads as it did; otherwise its words read again at the front, or rebuilt.
  const hookAt = lines.findIndex(l => l.line.hook);
  let opening: KineticLine | null = null;
  // He made the opening a normal line by hand: it stays his choice.
  const handNormal = hookAt >= 0 && record.bigLines?.some(b => !b.big && Math.abs(b.s - lines[hookAt].line.s) < 1e-7);
  if (hookAt >= 0 && !handNormal && style.hook !== "off" && words.length) {
    const { line, next } = lines[hookAt], was = lead(oldOf(lineWords(line)[0] ?? { text: "", s: NaN, e: NaN }), oldSorted);
    const leads = (l: KineticLine | null) => !!l && lead(lineWords(l)[0], words) <= (Number.isFinite(was) ? was : 0);
    if (!leads(next)) {
      const again = carry(line, byText(Array.from({ length: (Number.isFinite(was) ? was : 0) + 1 }, (_, i) => i)));
      opening = leads(again) ? again : rebuildOpening(line, words, track.captionSource.words as SourceWord[], style, track.emphasis);
      if (opening) lines[hookAt] = { line, next: opening };
    }
  }
  const final = lines.map(l => l.next ?? l.line).filter(l => !opening || l === opening || !l.cues.some(c => (c.words ?? []).some(w => w.s >= opening!.s - 1e-7 && w.e <= opening!.e + 1e-7)));
  // Lines he made big or normal move with their line.
  const bigLines = record.bigLines?.map(b => { const l = lines.find(x => Math.abs(x.line.s - b.s) < 1e-7); return l?.next ? { ...b, s: l.next.s } : b; });
  // Following re-measures designed lines by time window; what it made of them is replaced by the lines carried here.
  if (JSON.stringify(final) === JSON.stringify(track.kinetic?.lines ?? []) && JSON.stringify(bigLines) === JSON.stringify(record.bigLines)) return false;
  if (bigLines) record.bigLines = bigLines;
  const moved = lines.some(l => l.next && (l.next.s !== l.line.s || l.next.e !== l.line.e));
  const kinetic = { ...prior.kinetic, ...track.kinetic, lines: moved ? final.map(l => ({ ...l, cues: l.cues.map(c => ({ ...c, layer: "front" as const })) })) : final };
  // Person mattes were cut for the old timeline: designed text that moved goes in front until they are made again.
  record.titles = { ...track, ...buildCaptionTrack(words, { ...track, kinetic } as CaptionTrack, style, track.captionSource.safeArea, record.bigLines), kinetic,
    ...(moved ? { personMattes: [] } : {}) } as CaptionTrack;
  return true;
}

/** The opening, rebuilt from the first spoken words without a model: the first sentence (up to 12 words, else up to its
 * last pause in punctuation), phrased as his caption style breaks lines, accents on his key words, in the opening's
 * style. The engine (openingLine) sizes, stacks and times it. */
function rebuildOpening(was: KineticLine, words: SourceWord[], indexed: SourceWord[], style: CaptionStyle, emphasis: string[] | undefined): KineticLine | null {
  const MAX = 12, end = (w: DesignWord) => /[.!?]["'’”)]?$/u.test(w.text), pause = (w: DesignWord) => /[,;:]["'’”)]?$/u.test(w.text);
  let n = words.slice(0, MAX).findIndex(end) + 1;
  if (!n) n = words.slice(0, MAX).reduce((at, w, i) => pause(w) ? i + 1 : at, 0) || Math.min(MAX, words.length);
  const sentence = words.slice(0, n);
  if (!sentence.length) return null;
  const keyWords = new Set((emphasis ?? []).map(Number));
  const phrases = buildCaptionTrack(sentence, { font: "", cues: [], prompt: null, skillIds: [] }, { ...style, emphasis: false, hook: "off" }).cues
    .filter(c => c.role === "subtitle").map((c, i, all) => {
      const own = sentence.filter(w => c.words?.some(x => sameTime(x, w)));
      return { role: all.length > 1 && i === all.length - 1 ? "payoff" : "phrase", words: own.map(w => ({ text: w.text, s: w.s, e: w.e, accent: keyWords.has(indexed.indexOf(w)) })) };
    }).filter(p => p.words.length);
  if (!phrases.length) return null;
  try {
    const line = openingLine({ style: was.style ?? DEFAULT_OPENING_STYLE, hook: true, reason: "Rebuilt from the first spoken words", phrases }, sentence);
    return { ...line, rebuilt: true };
  } catch { return null; }
}

const tried = new Set<string>();
const sessionStart = Date.now() - process.uptime() * 1000;
/** Self-heal on open: an edit whose saved captions are off the voice (saved before captions moved with ripples) gets one
 * new version with them realigned, made like a background job on its current revision. Once per version a session;
 * never for an older version opened on purpose. FIX4: it completes that version rather than adding a step, so ⌘Z takes
 * back the edit that made it together with the realign (revisions.followOn). A version he made this session keeps its
 * own words, so the undo step reads as what he did; an older one healed on open says why it changed. */
export function realignOnOpen(root: string, cutId: string, version: number, record: CutVersion & { titles?: unknown }, heard: readonly VoiceWord[]) {
  const words = (record.titles as { captionSource?: { words: VoiceWord[] } } | null | undefined)?.captionSource?.words;
  const id = `${root}\u0000${cutId}\u0000${version}`;
  if (tried.has(id) || !words?.length || record.captionLanguage || record.feedback === REALIGNED
    || !voiceCaptionsDrift(words, heard) && !designOffWords(record.titles as CaptionTrack | null | undefined, record.bigLines)) return;
  tried.add(id);
  setImmediate(() => { void (async () => {
    const { currentVersion } = await import("./revisions");
    if (await currentVersion(root, cutId).catch(() => undefined) !== version) return;
    const { runActivity } = await import("./activity");
    const { finishStoredVersion, renderStoredPreview, detachedEditWork } = await import("./sidekick");
    const { followOn } = await import("./revisions");
    const unchanged = new Error("captions already on the voice"), madeNow = Date.parse(record.createdAt) >= sessionStart;
    await detachedEditWork(() => followOn(root, cutId, version, () => runActivity({ kind: "edit", root, target: { cutId, version }, label: "Realigning captions to the voice" }, () =>
      finishStoredVersion(root, cutId, version, true, async (record, assembly) => {
        if (!await followCaptionsToVoice(root, record)) throw unchanged;
        if (!madeNow) record.feedback = REALIGNED;
        tried.add(`${root}\u0000${cutId}\u0000${record.version}`);  // its own realign is never tried again this session
        await renderStoredPreview(root, cutId, record, assembly);
        return { cutId, version: record.version };
      })))).catch(error => { if (error !== unchanged) console.warn(`[captions] ${cutId} v${version}: couldn't realign captions to the voice`, error); });
  })(); });
}
