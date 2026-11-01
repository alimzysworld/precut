// BROLL2 (docs/plans/produced/reference-study-31-oct.md, gap 2): "Show what you say". For a stretch of what he says,
// find the things he names that his own library can show, and propose one short cutaway per phrase that earns it,
// cut on the word, his voice carrying on under it. Local and lexical (no model call): the picture text is the judge's
// description of each shot, its moment and place, and what a screen recording shows. A phrase earns a shot only when a
// shot's picture names the same thing; everything else is left on his face. The person (or Ask) chooses from the
// proposal; nothing lands until "Use these" (apply_broll_plan), as one version of timed layout scenes.
import type { Clip, CutEdit, LayoutChoice, Shoot } from './schema';
import { isScreenClip } from './screen';

export interface PlanWord { text: string; s: number; e: number; index: number }
/** One shot the library can show for a phrase: a clip and the source window the cutaway would play. */
export interface BrollShot {
  clipId: string;
  s: number;                 // source second the cutaway starts on
  e: number;                 // end of the usable window it plays inside (s + the cutaway's length <= e)
  kind: 'broll' | 'screen' | 'photo';
  name: string;              // what is in it, in the judge's or the screen reader's words
  why: string;               // "Shows the park", "Same moment"
  score: number;
  steady: boolean | null;    // null: shake not measured
}
export interface BrollSlot {
  id: string;
  phrase: string;            // the words he says over it
  thing: string;             // the named thing, as he says it
  word: number;              // caption word index of that thing (the cut lands just before it)
  s: number; e: number;      // edit seconds, on frames
  pick: BrollShot;
  alternatives: BrollShot[]; // up to five others to swap in
  screen: boolean;           // the phrase names an app or something on a screen
  desks: BrollShot[];        // hands-and-desk shots a screen recording can be laid over
  over: { desk: BrollShot; opacity: number } | null;  // the "over a desk shot" weave, off until chosen
}
export interface BrollPlan {
  s: number; e: number;
  slots: BrollSlot[];
  skipped: { phrase: string; s: number; e: number; why: string }[];
  note: string;
}
export type BrollPrefer = 'broll' | 'screen' | 'photo';
export interface BrollPlanOptions {
  s: number; e: number;
  maxShots?: number;
  prefer?: BrollPrefer;
  fps?: number;              // the edit's frame rate; cut points land on its frames
  lengthS?: number;          // the edit's length
  busy?: { s: number; e: number; why: string }[];   // stretches something else already covers (a layout, a full graphic)
  picture?: { s: number; e: number; clipId: string }[];   // what the edit already shows, on its clock: never cut away to what is already there
  pictureShots?: LibraryShot[];   // those pictures' own descriptions, talking clips too (he may be standing in the cafe he names)
}
/** A phrase earns a cutaway only when a shot's own picture (its description, place or screen text) names the thing;
 * the moment's name alone is not enough. */
export const EARNS = 3;

export const BROLL_LEAD_FRAMES = 3;
export const BROLL_MIN_S = .8, BROLL_MAX_S = 3.2;
export const BLEND_OPACITY = .55;
const MAX_ALTERNATIVES = 5;

// Words that never name something to show: function words, fillers and the commonest verbs and abstractions.
const STOP = new Set(('a an the and or but so because if then than that this these those there here it its it\'s i i\'m i\'ve i\'ll i\'d me my mine we us our ours ' +
  'you your yours you\'re you\'ve he him his she her they them their what which who whom whose when where why how all any both each every few more most ' +
  'other some such no nor not only own same too very can will just don\'t should now is are was were be been being have has had having do does did doing ' +
  'would could might must shall may of at by for with about against between into through during before after above below to from up down in out on off ' +
  'over under again further once also still even ever never always really actually literally basically honestly just like kind sort thing things stuff way ' +
  'lot lots bit time times day days week year people person someone something anything everything nothing everyone anyone one ones guy guys ' +
  'yeah yes yep no nope okay ok oh um uh erm er hmm mm ah well right sure maybe probably definitely totally gonna wanna gotta ' +
  'get got gets getting go goes going went gone make makes made making know knew known think thought say said says tell told want wanted need needs ' +
  'feel felt see saw seen look looking looks come came coming take took give gave put let lets let\'s try tried keep kept mean means meant use used ' +
  'start started thing\'s that\'s there\'s what\'s it\'ll we\'re they\'re isn\'t aren\'t wasn\'t can\'t won\'t didn\'t doesn\'t ' +
  'good great nice bad big little small new old first last next much many enough whole real best better idea ideas reason point part fact case ' +
  // verbs and words that only say how: never the thing to show
  'build building built open opened stop stopped admire run running ran invite invited show showed shown bought buy took send sent loved love loving ' +
  'having coming came caught finally eventually obviously back straight late early rush called call calls doing done talk talked talking walk walked ' +
  'work working worked help helped find found leave left bring brought turn turned play played watch watched wait waited ' +
  // people in general (a named person is a capitalised name)
  'man men woman women boy girl friend friends everyone somebody anybody').split(/\s+/));
// A few everyday names for the same picture, so "stroll" finds a walk and "computer" a laptop.
const SAME = new Map(Object.entries({ stroll: ['walk', 'walking'], computer: ['laptop'], mobile: ['phone'], meeting: ['meetup'], meetup: ['meeting'], coffee: ['cafe'], cafe: ['coffee'],
  fight: ['ring'], kitchen: ['cooking', 'hob', 'sink'], cooking: ['kitchen', 'hob', 'pot'], tube: ['train', 'underground'], train: ['tube'],
  underground: ['tube'], gig: ['concert'], concert: ['gig'], dinner: ['food', 'plate'], lunch: ['food', 'plate'], brunch: ['food', 'plate', 'cafe'] }));
// The judge's own words about a shot's quality and timing, not about what is in it.
const PICTURE_NOISE = new Set('steady shaky handheld wobble wobbles throughout whole short shorter second seconds choice best version shot shots frame frames start end swings swing slightly bit dark blurry underexposed nothing use usable same angle wide close low high top down first last more most'.split(' '));
// Things that live on a screen: a phrase with one of these may want the screen recording.
const SCREEN_WORDS = new Set('app apps screen screens website site page dashboard laptop computer email inbox chat message messages code notion figma canva slack roadmap settings tab browser button click signup login download software tool tools spreadsheet doc docs document editor timeline'.split(' '));
// Shots of hands and a desk that a screen recording can be laid over (the Canva video's weave).
const DESK_WORDS = new Set('desk keyboard typing laptop trackpad notebook workspace'.split(' '));
const isDesk = (words: Set<string>) => [...words].some(w => DESK_WORDS.has(w)) || (words.has('hand') || words.has('hands')) && ['phone', 'laptop', 'table', 'desk'].some(w => words.has(w));

/** A word reduced to a comparable stem: lower case, no possessive, simple plural and verb endings off. */
export function stem(word: string): string {
  let w = word.normalize('NFKC').toLowerCase().replace(/[’']/g, "'").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/'s$/, '');
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  return w;
}
const clean = (word: string) => word.normalize('NFKC').replace(/[’]/g, "'").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, '');
/** The words of a picture description, minus speech the judge quoted ('so good') and timecodes. */
export function pictureTerms(text: string): Set<string> {
  // A quote opens after a space and closes before one (an apostrophe inside "there's" does neither).
  const plain = text.replace(/(^|[\s(])['‘“"][^"“”]{0,160}?['’”"](?=[\s,.;:!?)]|$)/g, '$1 ').replace(/\b\d+:\d+(?:\.\d+)?\b/g, ' ');
  return new Set((plain.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).flatMap(w => w.split('-')).map(stem)
    .filter(w => w.length > 1 && !STOP.has(w) && !PICTURE_NOISE.has(w)));
}

/** Phrases: break on punctuation, a pause, or a long run at a joining word. */
export function phrasesOf(words: PlanWord[]): PlanWord[][] {
  const out: PlanWord[][] = [];
  let current: PlanWord[] = [];
  for (const [i, word] of words.entries()) {
    const previous = words[i - 1];
    const joining = /^(and|but|so|because|then|when|which|while|or)$/i.test(clean(word.text));
    if (previous && current.length && (/[.!?;:,]["”’)]*$/.test(previous.text) || word.s - previous.e > .3 || current.length >= 6 && joining)) { out.push(current); current = []; }
    current.push(word);
  }
  if (current.length) out.push(current);
  return out;
}

export interface NamedThing { text: string; first: number; stems: string[]; proper: boolean; screen: boolean }
/** The things a phrase names: content words, with runs of capitalised words (Tower Bridge, Green Park) kept whole. */
export function namedThings(phrase: PlanWord[], sentenceStart: (word: PlanWord) => boolean = () => false): NamedThing[] {
  const out: NamedThing[] = [];
  for (let i = 0; i < phrase.length; i++) {
    const raw = clean(phrase[i].text), s = stem(raw);
    if (!s || STOP.has(raw.toLowerCase()) || STOP.has(s) || s.length < 3 || /^\d+$/.test(s)) continue;
    const capital = /^\p{Lu}/u.test(raw) && raw !== 'I' && !sentenceStart(phrase[i]);
    if (capital) {   // a proper name runs over the capitalised words after it
      let j = i;
      while (j + 1 < phrase.length && /^\p{Lu}|^\d/u.test(clean(phrase[j + 1].text)) && !/[.!?,;:]$/.test(phrase[j].text)) j++;
      const run = phrase.slice(i, j + 1);
      out.push({ text: run.map(w => clean(w.text)).join(' '), first: i, stems: run.map(w => stem(w.text)).filter(w => w && !STOP.has(w)), proper: true, screen: run.some(w => SCREEN_WORDS.has(stem(w.text))) });
      i = j;
      continue;
    }
    out.push({ text: raw, first: i, stems: [s, ...SAME.get(s) ?? []], proper: false, screen: SCREEN_WORDS.has(s) });
  }
  return out;
}

/** Measured steady windows (one second or longer) between the shaky spans; null when shake was never measured. */
export function steadyWindows(clip: Pick<Clip, 'shake' | 'meta'>): [number, number][] | null {
  if (!clip.shake?.measured) return null;
  const through = Math.min(clip.meta?.durationS ?? 0, clip.shake.perSecond?.length ?? 0);
  const out: [number, number][] = [];
  let cursor = 0;
  for (const [s, e] of [...clip.shake.shakySpans].filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s).sort((a, b) => a[0] - b[0])) {
    if (Math.min(through, s) - cursor >= 1) out.push([cursor, Math.min(through, s)]);
    cursor = Math.max(cursor, e);
  }
  if (through - cursor >= 1) out.push([cursor, through]);
  return out;
}

/** Everything in the library a cutaway could show, each with the words that describe its picture. */
export interface LibraryShot { clip: Clip; kind: BrollShot['kind']; name: string; scene: string; place: string; words: Set<string>; strong: Set<string>; spans: [number, number][]; steady: [number, number][] | null; quality: number; desk: boolean }
export function libraryShots(shoot: Pick<Shoot, 'clips'>, excluded: Set<string> = new Set()): LibraryShot[] {
  const out: LibraryShot[] = [];
  for (const clip of shoot.clips) {
    if (clip.leftOut || clip.missing || clip.stage === 'error' || !clip.meta || !clip.proxy || excluded.has(clip.id)) continue;
    const j = clip.judgement, kind = clip.byHand?.kind ?? j?.kind, duration = clip.meta.durationS;
    if (j?.verdict === 'unusable') continue;
    const verdict = { best: 1, alt: .6, maybe: .2, unusable: 0 }[j?.verdict ?? 'maybe'] + (clip.byHand?.star ? .4 : 0);
    const place = clip.place?.name ?? '', scene = j?.scene ?? '';
    if (isScreenClip(clip)) {
      for (const segment of clip.screen?.segments?.length ? clip.screen.segments : [{ s: 0, e: duration, text: '', still: '' }]) {
        const name = segment.line || [segment.app, segment.action].filter(Boolean).join(': ') || j?.summary || 'Screen recording';
        const words = pictureTerms([segment.line, segment.app, segment.action, segment.text, j?.summary].filter(Boolean).join(' '));
        out.push({ clip, kind: 'screen', name, scene, place, words, strong: pictureTerms([segment.line, segment.app, segment.action].filter(Boolean).join(' ')),
          spans: [[segment.s, duration]], steady: null, quality: verdict, desk: false });
      }
      continue;
    }
    if (clip.photo) {
      out.push({ clip, kind: 'photo', name: j?.summary || 'Photo', scene, place, words: pictureTerms([j?.summary, scene].filter(Boolean).join(' ')), strong: pictureTerms(j?.summary ?? ''),
        spans: [[0, duration]], steady: null, quality: verdict, desk: false });
      continue;
    }
    if (kind !== 'broll' && !(j?.verdict === 'maybe' && /b-?roll/i.test(j.summary))) continue;
    const spans = (j?.usableSpans?.length ? j.usableSpans : [[0, duration]] as [number, number][]).filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s);
    if (!spans.length) continue;
    const summary = j?.summary ?? '', words = pictureTerms(summary);
    out.push({ clip, kind: 'broll', name: summary || 'B-roll', scene, place, words, strong: words, spans, steady: steadyWindows(clip), quality: verdict,
      desk: isDesk(words) });
  }
  return out;
}

/** What a clip already on the picture shows, whatever its kind, for "the picture already shows it". */
export function pictureShot(clip: Clip): LibraryShot {
  const summary = clip.judgement?.summary ?? '', words = pictureTerms(summary);
  return { clip, kind: 'broll', name: summary, scene: clip.judgement?.scene ?? '', place: clip.place?.name ?? '', words, strong: words, spans: [], steady: null, quality: 0, desk: false };
}
/** The source window a shot plays for `length` seconds: steady and inside a usable span, centred on the judge's peak when
 * it can be. null when the shot has no window that long. */
export function sourceWindow(shot: LibraryShot, length: number): { s: number; e: number; steady: boolean | null } | null {
  const fit = (windows: [number, number][]) => windows.filter(([s, e]) => e - s >= length - 1e-6);
  const usable = fit(shot.spans);
  if (!usable.length) return null;
  const steady = shot.steady ? fit(usable.flatMap(([a, b]) => shot.steady!.flatMap(([c, d]) => Math.min(b, d) - Math.max(a, c) > 0 ? [[Math.max(a, c), Math.min(b, d)] as [number, number]] : []))) : [];
  const windows = steady.length ? steady : usable, peak = shot.clip.judgement?.peakS;
  const at = (peak !== undefined && windows.find(([s, e]) => peak >= s && peak <= e)) || windows.reduce((a, b) => b[1] - b[0] > a[1] - a[0] ? b : a);
  const centre = peak !== undefined && peak >= at[0] && peak <= at[1] ? peak - length / 2 : at[0] + Math.min(.4, (at[1] - at[0] - length) / 2);
  const s = Math.max(at[0], Math.min(at[1] - length, centre));
  return { s: Math.round(s * 1000) / 1000, e: at[1], steady: shot.steady === null ? null : steady.length > 0 };
}

interface Scored { shot: LibraryShot; score: number; match: number; why: string }
/** How well a shot's picture shows the named things: picture description and place count most, the moment's name less. */
export function scoreShot(shot: LibraryShot, things: NamedThing[], prefer?: BrollPrefer): Scored {
  let match = 0;
  const hits: string[] = [];
  const placeText = shot.place.toLowerCase(), sceneWords = pictureTerms(shot.scene), placeWords = pictureTerms(shot.place);
  for (const thing of things) {
    const weight = thing.proper ? 1.5 : 1;
    let best = 0;
    for (const s of thing.stems) {
      if (shot.strong.has(s) || placeWords.has(s)) best = Math.max(best, 3);
      else if (shot.words.has(s)) best = Math.max(best, 2);
      else if (sceneWords.has(s)) best = Math.max(best, 2);
    }
    if (thing.proper && thing.stems.length > 1 && (placeText.includes(thing.text.toLowerCase()) || shot.name.toLowerCase().includes(thing.text.toLowerCase()))) best += 2;
    if (best) { match += best * weight; hits.push(thing.text); }
  }
  if (!match) return { shot, score: 0, match: 0, why: '' };
  const score = match + shot.quality + (prefer && shot.kind === prefer ? 1.5 : 0) + (shot.steady?.length ? .2 : 0);
  return { shot, score, match, why: `Shows ${hits.slice(0, 2).join(' and ')}` };
}

const onFrame = (t: number, fps: number) => Math.round(t * fps) / fps;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** Cut points: a few frames before the named word, out on a word edge at the phrase end (at least BROLL_MIN_S, at most
 * BROLL_MAX_S, never into the next cutaway or past bounds.e). */
export function cutPoints(words: PlanWord[], phrase: PlanWord[], named: PlanWord, fps: number, bounds: { s: number; e: number }): { s: number; e: number } | null {
  const lead = BROLL_LEAD_FRAMES / fps;
  const s = onFrame(Math.max(bounds.s, named.s - lead), fps);
  const after = words.filter(w => w.index >= named.index);
  const ends = after.map(w => w.e).filter(e => e <= bounds.e + 1e-6);
  const phraseEnd = phrase.at(-1)!.e;
  let e = phraseEnd - s >= BROLL_MIN_S && phraseEnd - s <= BROLL_MAX_S ? phraseEnd
    : phraseEnd - s > BROLL_MAX_S ? ends.filter(t => t - s >= BROLL_MIN_S && t - s <= BROLL_MAX_S).at(-1) ?? s + BROLL_MAX_S
    : ends.find(t => t - s >= BROLL_MIN_S) ?? Math.min(bounds.e, s + BROLL_MIN_S);
  e = onFrame(Math.min(e, bounds.e), fps);
  return e - s >= BROLL_MIN_S - 1 / fps - 1e-6 ? { s: r3(s), e: r3(e) } : null;
}

function asShot(scored: Scored, length: number): BrollShot | null {
  const window = sourceWindow(scored.shot, length);
  if (!window) return null;
  return { clipId: scored.shot.clip.id, s: window.s, e: r3(window.e), kind: scored.shot.kind, name: scored.shot.name, why: scored.why, score: r3(scored.score), steady: window.steady };
}

/** The proposal: which phrases earn a cutaway, the best shot for each, and what else could go there. */
export function planBroll(words: PlanWord[], library: LibraryShot[], options: BrollPlanOptions): BrollPlan {
  const fps = options.fps && options.fps > 0 ? options.fps : 25, s0 = Math.max(0, options.s), e0 = Math.min(options.e, options.lengthS ?? Infinity);
  if (!(e0 > s0)) throw new Error('Choose a stretch of the edit to show.');
  const all = [...words].sort((a, b) => a.s - b.s), inside = all.filter(w => w.s >= s0 - .05 && w.e <= e0 + .05);
  if (!inside.length) throw new Error('Nothing is said in that stretch. Choose words he says.');
  const sentenceStarts = new Set<number>();
  for (const [i, w] of words.entries()) if (i === 0 || /[.!?]["”’)]*$/.test(words[i - 1].text) || w.s - words[i - 1].e > 1) sentenceStarts.add(w.index);
  const phrases = phrasesOf(inside);
  const wanted = Math.max(1, Math.min(12, Math.round(options.maxShots ?? Math.max(1, Math.ceil((e0 - s0) / 3.5 - 1e-9)))));
  const byClip = new Map([...library, ...options.pictureShots ?? []].map(l => [l.clip.id, l]));
  const picture = options.picture ?? [], onScreen = new Set(picture.filter(p => p.s < e0 && p.e > s0).map(p => p.clipId));
  const skipped: BrollPlan['skipped'] = [];
  const candidates: { phrase: PlanWord[]; text: string; things: NamedThing[]; ranked: Scored[]; screen: boolean }[] = [];
  for (const phrase of phrases) {
    const text = phrase.map(w => w.text.trim()).filter(Boolean).join(' ');
    const things = namedThings(phrase, w => sentenceStarts.has(w.index));
    const where = { s: phrase[0].s, e: phrase.at(-1)!.e };
    const busy = options.busy?.find(b => b.s < where.e && b.e > where.s);
    if (busy) { skipped.push({ phrase: text, ...where, why: busy.why }); continue; }
    if (!things.length) { skipped.push({ phrase: text, ...where, why: 'Names nothing to show' }); continue; }
    // Already on the picture under these words: the edit shows it, a cutaway would repeat it.
    const shown = picture.filter(p => p.s < where.e && p.e > where.s).map(p => byClip.get(p.clipId)).find(l => l && scoreShot(l, things).match >= EARNS);
    if (shown) { skipped.push({ phrase: text, ...where, why: 'The picture already shows it' }); continue; }
    const ranked = library.filter(l => !onScreen.has(l.clip.id)).map(shot => scoreShot(shot, things, options.prefer)).filter(r => r.match >= 2).sort((a, b) => b.score - a.score);
    if (!ranked.length || ranked[0].match < EARNS) { skipped.push({ phrase: text, ...where, why: `Nothing in the library shows ${things.slice(0, 2).map(t => t.text).join(' or ')}` }); continue; }
    candidates.push({ phrase, text, things, ranked, screen: things.some(t => t.screen) || ranked[0].shot.kind === 'screen' });
  }
  // Restraint: the strongest matches first, never more than the stretch can carry, one clip once.
  const order = [...candidates].sort((a, b) => b.ranked[0].score - a.ranked[0].score);
  const chosen: { c: typeof candidates[number]; at: { s: number; e: number }; named: PlanWord }[] = [];
  for (const c of order) {
    if (chosen.length >= wanted) { skipped.push({ phrase: c.text, s: c.phrase[0].s, e: c.phrase.at(-1)!.e, why: 'Kept on you: the stretch already has enough cutaways' }); continue; }
    const thing = c.things.find(t => c.ranked[0].why.includes(t.text)) ?? c.things[0];
    const named = c.phrase[thing.first];
    const before = chosen.filter(x => x.at.e <= named.s).reduce((n, x) => Math.max(n, x.at.e), s0);
    // A phrase at the very end of the stretch may run on to the next word edge after it (a cutaway needs time to read).
    const after = chosen.filter(x => x.at.s >= named.s).reduce((n, x) => Math.min(n, x.at.s), Math.min(options.lengthS ?? Infinity, e0 + BROLL_MAX_S));
    const at = cutPoints(all, c.phrase, named, fps, { s: before, e: after });
    if (!at) { skipped.push({ phrase: c.text, s: c.phrase[0].s, e: c.phrase.at(-1)!.e, why: 'Too short for a cutaway' }); continue; }
    chosen.push({ c, at, named });
  }
  const used = new Set<string>();
  const slots: BrollSlot[] = [];
  for (const { c, at, named } of chosen.sort((a, b) => a.at.s - b.at.s)) {
    // The best shot is shorter than the phrase: end earlier, on a word edge it can fill (never under BROLL_MIN_S).
    const longest = (l: LibraryShot) => Math.max(0, ...l.spans.map(([a, b]) => b - a));
    const room = longest(c.ranked[0].shot);
    if (room < at.e - at.s && room >= BROLL_MIN_S) {
      const edge = all.filter(w => w.index >= named.index && w.e - at.s >= BROLL_MIN_S - 1e-6 && w.e - at.s <= room + 1e-6).at(-1)?.e;
      if (edge !== undefined) at.e = r3(onFrame(edge, fps) > at.s + room ? Math.floor(edge * fps) / fps : onFrame(edge, fps));
    }
    const length = at.e - at.s;
    const shots = c.ranked.map(r => asShot(r, length)).filter((x): x is BrollShot => !!x);
    const pick = shots.find(x => !used.has(x.clipId)) ?? shots[0];
    if (!pick) { skipped.push({ phrase: c.text, s: c.phrase[0].s, e: c.phrase.at(-1)!.e, why: 'No matching shot is long enough' }); continue; }
    used.add(pick.clipId);
    const seen = new Set([`${pick.clipId}@${pick.s}`]), alternatives: BrollShot[] = [];
    const add = (x: BrollShot | null) => { if (x && alternatives.length < MAX_ALTERNATIVES && !seen.has(`${x.clipId}@${x.s}`) && x.clipId !== pick.clipId) { seen.add(`${x.clipId}@${x.s}`); alternatives.push(x); } };
    // A screen phrase always offers the closest screen recording, even when b-roll won.
    if (c.screen) add(shots.find(x => x.kind === 'screen') ?? null);
    for (const x of shots) add(x);
    if (alternatives.length < 3) {   // fill from the same moment, then the same place: the next best thing to show
      const pickShot = library.find(l => l.clip.id === pick.clipId);
      for (const l of library.filter(l => l.clip.id !== pick.clipId && l.kind !== 'screen' && pickShot && (l.scene && l.scene === pickShot.scene || l.place && l.place === pickShot.place)).sort((a, b) => b.quality - a.quality))
        add(asShot({ shot: l, score: l.quality, match: 0, why: l.scene && l.scene === pickShot!.scene ? 'Same moment' : 'Same place' }, length));
    }
    const desks = c.screen && (pick.kind === 'screen' || alternatives.some(a => a.kind === 'screen'))
      ? library.filter(l => l.desk && l.kind === 'broll').sort((a, b) => b.quality - a.quality).map(l => asShot({ shot: l, score: l.quality, match: 0, why: 'Hands and desk' }, length)).filter((x): x is BrollShot => !!x).slice(0, 4) : [];
    slots.push({ id: `slot-${named.index}`, phrase: c.text, thing: c.things.find(t => c.phrase[t.first] === named)?.text ?? clean(named.text), word: named.index,
      s: at.s, e: at.e, pick, alternatives, screen: c.screen, desks, over: null });
  }
  const shown = slots.length;
  const note = !shown ? (candidates.length ? 'Nothing in the library fits these words well enough to cut away from you.' : 'Nothing said here is something the library shows, so it stays on you.')
    : `${shown} ${shown === 1 ? 'cutaway' : 'cutaways'} for ${phrases.length} ${phrases.length === 1 ? 'phrase' : 'phrases'}; the rest stays on you.`;
  return { s: r3(s0), e: r3(e0), slots, skipped: skipped.sort((a, b) => a.s - b.s), note };
}

/** Swap a slot's shot for one of its alternatives; the old pick becomes an alternative. Lengths stay the same. */
export function swapSlot(plan: BrollPlan, slotId: string, choice: { clipId: string; s: number }): BrollPlan {
  return { ...plan, slots: plan.slots.map(slot => {
    if (slot.id !== slotId) return slot;
    const next = slot.alternatives.find(a => a.clipId === choice.clipId && Math.abs(a.s - choice.s) < 1e-6);
    if (!next) throw new Error('Choose one of this slot\'s shots.');
    return { ...slot, pick: next, alternatives: [slot.pick, ...slot.alternatives.filter(a => a !== next)], over: next.kind === 'screen' ? slot.over : null };
  }) };
}
export function removeSlot(plan: BrollPlan, slotId: string): BrollPlan {
  if (!plan.slots.some(s => s.id === slotId)) throw new Error('That cutaway is not in this proposal.');
  return { ...plan, slots: plan.slots.filter(s => s.id !== slotId) };
}
/** The weave: lay the slot's screen recording over a hands-and-desk shot at an opacity (null takes it off). */
export function overDesk(plan: BrollPlan, slotId: string, desk: { clipId: string; s: number } | null, opacity = BLEND_OPACITY): BrollPlan {
  return { ...plan, slots: plan.slots.map(slot => {
    if (slot.id !== slotId) return slot;
    if (!desk) return { ...slot, over: null };
    if (slot.pick.kind !== 'screen') throw new Error('Lay a screen recording over a desk shot: pick the screen recording first.');
    const found = slot.desks.find(d => d.clipId === desk.clipId) ?? null;
    if (!found) throw new Error('Choose one of the desk shots offered for this slot.');
    return { ...slot, over: { desk: found, opacity: clampOpacity(opacity) } };
  }) };
}
export const clampOpacity = (n: number) => Math.min(.95, Math.max(.2, Number.isFinite(n) ? n : BLEND_OPACITY));

/** One cutaway as it lands: edit seconds, the shot's source start, and the optional desk shot under it. */
export interface BrollPlacement { s: number; e: number; phrase: string; word?: number; clipId: string; sourceS: number; over?: { clipId: string; sourceS: number; opacity: number } | null }
export const slotPlacement = (slot: BrollSlot): BrollPlacement => ({ s: slot.s, e: slot.e, phrase: slot.phrase, word: slot.word, clipId: slot.pick.clipId, sourceS: slot.pick.s,
  over: slot.over ? { clipId: slot.over.desk.clipId, sourceS: slot.over.desk.s, opacity: slot.over.opacity } : null });
const FULL = { x: 0, y: 0, w: 1, h: 1 };
/** A cutaway is a timed scene: the shot full frame (framed on its subject), a hard cut in and out, his voice under it.
 * Over a desk shot: the screen recording on top at the opacity, the desk shot under it. */
export function cutawayLayout(p: BrollPlacement): LayoutChoice {
  const base = { kind: 'scene' as const, padding: 0, radius: 0, transition: 'cut' as const, followCamera: false, reason: `Shows what he says: “${p.phrase.slice(0, 200)}”`,
    cutaway: { phrase: p.phrase.slice(0, 300), ...(p.word !== undefined ? { word: p.word } : {}) } };
  if (p.over) return { ...base, id: 'clip-over-camera', boxes: { a: FULL, b: FULL }, opacity: clampOpacity(p.over.opacity),
    sources: { a: { clipId: p.clipId, s: p.sourceS }, b: { clipId: p.over.clipId, s: p.over.sourceS } } };
  return { ...base, id: 'camera-only', sources: { b: { clipId: p.clipId, s: p.sourceS } } };
}
/** "Use these": every cutaway in one version. Cutaways already inside the stretch are taken out first, so running it
 * again over the same words replaces rather than stacks. */
export function brollPlanEdit(placements: BrollPlacement[], existing: Pick<LayoutChoice, 'kind' | 's' | 'e' | 'cutaway'>[] = [], stretch?: { s: number; e: number }, label = 'Show what I say'): Extract<CutEdit, { kind: 'batch' }> {
  if (!placements.length && !stretch) throw new Error('Choose at least one cutaway.');
  const sorted = [...placements].sort((a, b) => a.s - b.s);
  for (const [i, p] of sorted.entries()) {
    if (![p.s, p.e, p.sourceS].every(Number.isFinite) || p.s < 0 || p.e - p.s < .2 || p.sourceS < 0) throw new Error('Each cutaway needs a start, an end and a source time.');
    if (i && sorted[i - 1].e > p.s + 1e-6) throw new Error('Cutaways cannot overlap.');
  }
  const lo = Math.min(stretch?.s ?? Infinity, ...sorted.map(p => p.s)), hi = Math.max(stretch?.e ?? -Infinity, ...sorted.map(p => p.e));
  const clear = existing.filter(l => l.kind === 'scene' && l.cutaway && l.s !== undefined && l.e !== undefined && l.s < hi && l.e > lo)
    .map(l => ({ kind: 'layoutRange' as const, s: l.s!, e: l.e!, layout: null }));
  return { kind: 'batch', label, edits: [...clear, ...sorted.map(p => ({ kind: 'layoutRange' as const, s: p.s, e: p.e, layout: cutawayLayout(p) }))] };
}

/** Trim a placed cutaway's edge like a b-roll clip: the start lands a few frames before a word, the end on a word's
 * end, when one is near (else on a frame); the shot keeps its frames in place (a later start plays later footage).
 * One version: the old range out, the trimmed one in. null when nothing moves. */
export function cutawayTrim(layout: LayoutChoice, edge: 's' | 'e', to: number, words: { s: number; e: number }[], bounds: { lo: number; hi: number }, fps = 25): Extract<CutEdit, { kind: 'batch' }> | null {
  if (layout.s === undefined || layout.e === undefined || !Number.isFinite(to)) return null;
  const lead = BROLL_LEAD_FRAMES / fps, edges = words.map(w => edge === 's' ? w.s - lead : w.e);
  const near = edges.filter(t => Math.abs(t - to) <= .2).sort((a, b) => Math.abs(a - to) - Math.abs(b - to))[0];
  let at = onFrame(near ?? to, fps);
  at = edge === 's' ? Math.min(layout.e - .5, Math.max(bounds.lo, at)) : Math.max(layout.s + .5, Math.min(bounds.hi, at));
  const d = edge === 's' ? at - layout.s : 0;
  // Footage before the shot's first frame doesn't exist: the start can move earlier only as far as the source allows.
  const room = Math.min(...Object.values(layout.sources ?? {}).map(v => v?.s ?? Infinity));
  if (edge === 's' && d < 0 && -d > room) at = layout.s - room;
  const s = edge === 's' ? r3(at) : layout.s, e = edge === 'e' ? r3(at) : layout.e;
  if (Math.abs(s - layout.s) < 1e-6 && Math.abs(e - layout.e) < 1e-6) return null;
  const shift = s - layout.s;
  const sources = layout.sources ? Object.fromEntries(Object.entries(layout.sources).map(([k, v]) => [k, v && { ...v, s: r3(Math.max(0, v.s + shift)) }])) as LayoutChoice['sources'] : undefined;
  const { s: _s, e: _e, ...rest } = layout;
  return { kind: 'batch', label: 'Trimmed cutaway', edits: [{ kind: 'layoutRange', s: layout.s, e: layout.e, layout: null }, { kind: 'layoutRange', s, e, layout: { ...rest, sources } }] };
}
