import type { CaptionAccentForm, CutEdit, TitleTrack, VoiceoverLine, Word } from './schema';
const ACCENT_FORMS: readonly CaptionAccentForm[] = ['colour', 'italic', 'caps', 'bigger', 'tag'];   // = captions.ts CAPTION_ACCENT_FORMS
import { transcriptGroups, transcriptText } from '../main/titles/text';
import { takeWordList } from './voice-edit';
export { cutVoiceEdits } from './voice-edit';

export type TimedCaptionWord = { index: number; text: string; s: number; e: number; accent?: boolean; estimated: boolean; cueId: string; accentAs?: CaptionAccentForm; big?: boolean };
export const isCaptionCue = (cue: { role: string; id: string }) => cue.role === 'subtitle' || cue.id.startsWith('kinetic-');
/** These are the exact words consumed by the live and export title renderer.
 * Display layers may repeat a word; the timeline and MCP expose it once. */
export function timedCaptionWords(track: TitleTrack | null | undefined): TimedCaptionWord[] {
  const unique = new Map<string, Omit<TimedCaptionWord, 'index'>>();
  for (const cue of track?.cues ?? []) {
    if (!isCaptionCue(cue)) continue;
    for (const word of cue.words?.length ? cue.words : [{ text: cue.text, s: cue.s, e: cue.e, estimated: true }]) {
      if (!Number.isFinite(word.s) || !Number.isFinite(word.e) || word.e <= word.s) continue;
      const key = JSON.stringify([word.s, word.e, word.text]);
      const prior = unique.get(key);
      unique.set(key, { ...word, estimated: (word.estimated ?? !!(track && "spokenCaptions" in track)) || !cue.words?.length, cueId: prior?.cueId ?? cue.id, accent: prior?.accent || word.accent });
    }
  }
  return [...unique.values()].sort((a, b) => a.s - b.s || a.e - b.e).map((word, index) => ({ ...word, index }));
}
export type CaptionWordEdit = Extract<CutEdit, { kind: 'captionWord' }>;
/** Pure immutable edit shared by optimistic playback and the saved version. */
export function updateCaptionWord(track: TitleTrack | null | undefined, edit: CaptionWordEdit, duration: number): TitleTrack {
  const words = timedCaptionWords(track), old = words[edit.index];
  if (!track || !Number.isInteger(edit.index) || !old) throw Error('Choose a caption word in this edit.');
  if (edit.text === undefined && edit.s === undefined && edit.e === undefined && edit.accent === undefined && edit.accentAs === undefined && edit.big === undefined) throw Error('Choose a word change.');
  if (edit.text !== undefined && (typeof edit.text !== 'string' || !edit.text.trim() || edit.text.trim().length > 120 || /\s/u.test(edit.text.trim()))) throw Error('Enter one caption word.');
  if (edit.accent !== undefined && typeof edit.accent !== 'boolean') throw Error('Choose whether to accent this word.');
  // CAP4: a word's own accent form (null goes back to the caption style's); choosing a form stresses the word.
  if (edit.accentAs !== undefined && edit.accentAs !== null && !(ACCENT_FORMS as readonly unknown[]).includes(edit.accentAs)) throw Error('Choose colour, italic, caps, bigger or tag.');
  if (edit.big !== undefined && typeof edit.big !== 'boolean') throw Error('Choose whether this word is big.');
  const s = edit.s ?? old.s, e = edit.e ?? old.e;
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e > duration + 1e-7 || e <= s ||
      (edit.s !== undefined || edit.e !== undefined) && (s < (words[edit.index - 1]?.e ?? 0) - 1e-7 || e > (words[edit.index + 1]?.s ?? duration) + 1e-7)) throw Error('Keep word timing inside its neighbours.');
  const next = { text: edit.text?.trim() ?? old.text, s, e, accent: edit.accent ?? (edit.accentAs ? true : old.accent), estimated: old.estimated && !(edit.s !== undefined && edit.e !== undefined),
    accentAs: edit.accentAs === undefined ? old.accentAs : edit.accentAs ?? undefined, big: edit.big === undefined ? old.big : edit.big || undefined };
  return replaceCaptionTimings(track, [old], [{ ...old, ...next }]);
}
export function replaceCaptionTimings(track: TitleTrack, oldWords: TimedCaptionWord[], nextWords: TimedCaptionWord[]): TitleTrack {
  const change = (word: { text: string; s: number; e: number }) => nextWords[oldWords.findIndex(old => word.text === old.text && word.s === old.s && word.e === old.e)];
  const matches = (word: { text: string; s: number; e: number }) => !!change(word);
  const cue = (c: TitleTrack['cues'][number]) => {
    if (!isCaptionCue(c)) return c;
    const tokens = c.words?.length ? c.words : [{ text: c.text, s: c.s, e: c.e, estimated: true }];
    if (!tokens.some(matches)) return c;
    const changed = tokens.map(w => matches(w) ? { ...w, ...change(w) } : w);
    // CAP4: a Big line is in caps whatever the style's case.
    const transform = (text: string) => track.captionStyle?.case === 'upper' || changed.every(w => w.big) ? text.toUpperCase() : track.captionStyle?.case === 'lower' ? text.toLowerCase() : text;
    return { ...c, words: changed, text: transcriptText(changed.map(w => transform(w.text))), s: Math.min(...changed.map(w => w.s)), e: Math.max(...changed.map(w => w.e)) };
  };
  // Preserve private caption metadata used when the style is changed later.
  const result = { ...track, cues: track.cues.map(cue) } as TitleTrack & { captionSource?: { words: { text: string; s: number; e: number }[] }; kinetic?: { lines: { s: number; e: number; cues: TitleTrack['cues'] }[] } };
  if (result.captionSource) {
    const source = result.captionSource.words;
    // Source tokens inside a changed word fold into its first token. PRO1: each kept token remembers the source tokens it
    // stands for, so key-word marks (emphasis indexes the source words) follow the tokens, then are renumbered.
    const kept: { w: (typeof source)[number]; from: number[]; i: number }[] = [];
    source.forEach((w, k) => {
      const i = oldWords.findIndex(old => w.s >= old.s - 1e-7 && w.e <= old.e + 1e-7);
      if (i < 0) kept.push({ w, from: [k], i });
      else if (Math.abs(w.s - oldWords[i].s) < 1e-7) kept.push({ w: { ...w, ...nextWords[i] }, from: [k], i });
      else { const owner = [...kept].reverse().find(x => x.i === i); owner?.from.push(k); }
    });
    result.captionSource = { ...result.captionSource, words: kept.map(x => x.w) };
    if (result.emphasis) {
      // PRO1: only a word whose accent changed takes its mark from that accent; every other saved key word stays (a
      // recompute from accents dropped key words with no accent, so an accent off and on again was not the same edit).
      // Overlap beyond float noise (as carryEmphasis): a shared boundary is not an overlap.
      const over = (a: { s: number; e: number }, b: { s: number; e: number }) => a.s < b.e - 1e-6 && a.e > b.s + 1e-6;
      const marks = new Set(result.emphasis);
      result.emphasis = kept.flatMap((x, j) => {
        const i = x.i >= 0 ? x.i : oldWords.findIndex((old, n) => over(old, x.w) || over(nextWords[n], x.w));
        if (i >= 0 && !!nextWords[i].accent !== !!oldWords[i].accent) return nextWords[i].accent ? [String(j)] : [];
        return x.from.some(k => marks.has(String(k))) ? [String(j)] : [];
      });
    }
  }
  if (result.kinetic) result.kinetic = { ...result.kinetic, lines: result.kinetic.lines.map(line => {
    const cues = line.cues.map(cue);
    return { ...line, cues, s: Math.min(...cues.map(c => c.s)), e: Math.max(...cues.map(c => c.e)) };
  }) };
  return { ...result, captionWordsEdited: true, speechOnsets: (track as TitleTrack & {speechOnsets?:number[]}).speechOnsets ?? timedCaptionWords(track).filter(w=>!w.estimated).flatMap(w=>[w.s,w.e]) } as TitleTrack;
}
export function retimeCaptionEdge(words: TimedCaptionWord[], index: number, edge: 's' | 'e', value: number, fps: number, duration: number, scale: number, onsets: number[], snap = true) {
  const word = words[index], frame = 1 / fps;
  const low = edge === 's' ? words[index - 1]?.e ?? 0 : word.s + frame;
  const high = edge === 'e' ? words[index + 1]?.s ?? duration : word.e - frame;
  if (high < low) return word[edge];
  const target = snap ? onsets.filter(t => t >= low && t <= high && Math.abs(t - value) * scale <= 6).sort((a, b) => Math.abs(a - value) - Math.abs(b - value))[0] : undefined;
  return Math.max(low, Math.min(high, target ?? Math.round(value * fps) / fps));
}

/** Match existing wording to local speech measurements. A missing match fails
 * the whole operation. Legacy line-only captions gain real word boundaries. */
export function alignCaptionTrack(track: TitleTrack, measured: {text:string;s:number;e:number}[]): TitleTrack {
  const normalize = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const old = timedCaptionWords(track), replacements = new Map<string, {text:string;s:number;e:number;accent?:boolean;estimated:boolean}[]>();
  if (!old.length) throw Error('This edit has no caption words to re-time.');
  let cursor = 0;
  for (const word of old) {
    const target = normalize(word.text);
    let matched = false;
    for (let start = cursor; start < measured.length && !matched; start++) {
      if (measured[start].s > word.e + 1) break;
      if (measured[start].e < word.s - 1) continue;
      let text = '';
      for (let end = start; end < measured.length && text.length <= target.length; end++) {
        text += normalize(measured[end].text);
        if (text !== target) continue;
        const tokens = measured.slice(start,end+1);
        if (tokens.some((w,i) => w.e <= w.s || i > 0 && w.s < tokens[i-1].e - 1e-7)) throw Error('Speech timings overlap. Your captions are unchanged.');
        replacements.set(JSON.stringify([word.s,word.e,word.text]), tokens.map(w => ({...w,accent:word.accent,estimated:false})));
        cursor = end+1; matched = true; break;
      }
    }
    if (!matched) throw Error('Some words could not be matched to speech. Your captions are unchanged.');
  }
  const cue = (c: TitleTrack['cues'][number]) => {
    if (!isCaptionCue(c)) return c;
    const words = (c.words?.length ? c.words : [{text:c.text,s:c.s,e:c.e}]).flatMap(w => replacements.get(JSON.stringify([w.s,w.e,w.text])) ?? [w]);
    return {...c,words,s:Math.min(...words.map(w=>w.s)),e:Math.max(...words.map(w=>w.e))};
  };
  const result = {...track,cues:track.cues.map(cue)} as TitleTrack & {captionSource?:{words:{text:string;s:number;e:number}[]};kinetic?:{lines:{s:number;e:number;cues:TitleTrack['cues']}[]}};
  if(result.captionSource)result.captionSource={...result.captionSource,words:[...replacements.values()].flat()};
  if(result.kinetic)result.kinetic={...result.kinetic,lines:result.kinetic.lines.map(line=>{const cues=line.cues.map(cue);return {...line,cues,s:Math.min(...cues.map(c=>c.s)),e:Math.max(...cues.map(c=>c.e))};})};
  return { ...result, captionWordsEdited: true, speechOnsets: measured.flatMap(w=>[w.s,w.e]) } as TitleTrack;
}

// ---------------------------------------------------------------------------------------------------------
// Voiceover words, shared by the captions that follow the voice (main/titles.ts), the Text panel and the MCP.
// A take's words keep their immutable take-word ids (VO7-5). Two things he can change, both on the caption
// track of one revision, so one undo takes them back:
//   voiceCorrections: his spelling of a take word, by its id ("" hides a word the transcriber made up);
//   voiceAdded: words the transcriber missed, in take seconds, each with its own new id. `before`/`after`
//   names the take word it was typed next to: that word gives up the time the added word now covers.
// ---------------------------------------------------------------------------------------------------------
export type VoiceCorrections = Record<string, { text: string; was: string }>;
export type VoiceAddedWord = { id: string; file: string; s: number; e: number; w: string; before?: string; after?: string };
export type VoiceTakeSource = { file: string; durationS: number; transcript?: { words: Word[] }[] | null };
/** One word as heard on the reel: reel seconds s/e, take seconds sourceS/sourceE. */
export type HeardVoiceWord = { id: string; occurrence: string; line: string; lineIndex: number; w: string; s: number; e: number; sourceS: number; sourceE: number; file: string; added: boolean };
/** A Text panel word: tokens grouped as captions group them ("work" "-life"), his correction applied. */
export type VoiceTranscriptWord = HeardVoiceWord & { text: string; spoken: string; hidden: boolean; tokens: string[] };

export function voiceAddedOf(track: unknown): VoiceAddedWord[] {
  const list = (track as { voiceAdded?: unknown } | null | undefined)?.voiceAdded;
  return Array.isArray(list) ? list.filter((w): w is VoiceAddedWord => !!w && typeof w === 'object' && typeof (w as VoiceAddedWord).id === 'string'
    && typeof (w as VoiceAddedWord).file === 'string' && typeof (w as VoiceAddedWord).w === 'string' && Number.isFinite((w as VoiceAddedWord).s)
    && Number.isFinite((w as VoiceAddedWord).e) && (w as VoiceAddedWord).e > (w as VoiceAddedWord).s) : [];
}
type SourceWord = { text: string; takeWord?: string; spoken?: string };
/** His corrections by take-word id: the stored map, updated from the caption words now in the track (a voice
 * word whose text differs from what was spoken is his correction; one put back removes it). Words not in the
 * track any more (removed speech, or a word he hid) keep theirs. */
export function voiceCorrectionsOf(track: TitleTrack | null | undefined): VoiceCorrections {
  const t = track as (TitleTrack & { voiceCorrections?: VoiceCorrections; captionSource?: { words: SourceWord[] } }) | null | undefined;
  const saved = t?.voiceCorrections, map: VoiceCorrections = { ...(saved && typeof saved === 'object' ? saved : {}) };
  for (const word of t?.captionSource?.words ?? []) {
    if (!word.takeWord || typeof word.spoken !== 'string') continue;
    if (word.text.trim() && word.text !== word.spoken) map[word.takeWord] = { text: word.text, was: word.spoken };
    else delete map[word.takeWord];
  }
  return map;
}
/** A take's words with their ids, plus his added words. A transcript word that overlaps an added word gives way:
 * the word it was typed before starts after it, the word it was typed after ends before it, any other keeps its
 * larger side (the transcriber stretched it over the speech it missed). */
export function voiceTakeWords(take: VoiceTakeSource, added: VoiceAddedWord[] = []): { word: Word; id: string; added: boolean }[] {
  const mine = added.filter(a => a.file === take.file).sort((a, b) => a.s - b.s);
  const listed = takeWordList(take).flatMap(({ word, id }) => {
    let s = word.s, e = word.e;
    for (const a of mine) {
      if (a.e <= s + 1e-9 || a.s >= e - 1e-9) continue;
      if (a.before === id) s = Math.max(s, a.e);
      else if (a.after === id) e = Math.min(e, a.s);
      else if (a.s - s >= e - a.e) e = Math.min(e, a.s); else s = Math.max(s, a.e);
    }
    return e - s > 1e-3 ? [{ word: s === word.s && e === word.e ? word : { ...word, s, e }, id, added: false }] : [];
  });
  return [...listed, ...mine.map(a => ({ word: { s: a.s, e: a.e, w: a.w, id: a.id } as Word, id: a.id, added: true }))]
    .sort((a, b) => a.word.s - b.word.s || a.word.e - b.word.e);
}
/** The shortest stretch of a word a voice piece must play for the word to be heard (and captioned). */
export const MIN_HEARD_S = 1e-3;
/** Every word the placed voice pieces play, on the reel clock, in time order. A word heard straight across a
 * split seam (the same take word, the same placement, one piece ending where the next begins) is one word, not
 * one per piece. Lines whose take has no words yet are `pending`. */
export function heardVoiceWords(lines: VoiceoverLine[], takeOf: (file: string) => VoiceTakeSource | undefined, added: VoiceAddedWord[] = []): { words: HeardVoiceWord[]; pending: string[] } {
  const listed = new Map<string, ReturnType<typeof voiceTakeWords>>(), words: HeardVoiceWord[] = [], pending: string[] = [];
  lines.forEach((line, lineIndex) => {
    const take = line.take;
    if (!take || ![line.s, take.s, take.e].every(Number.isFinite) || take.e <= take.s) return;
    const audio = takeOf(take.file);
    if (!audio || !Array.isArray(audio.transcript)) { pending.push(line.id); return; }
    if (!listed.has(take.file)) listed.set(take.file, voiceTakeWords(audio, added));
    const occurrence = line.occurrence ?? line.id;
    for (const { word, id, added: mine } of listed.get(take.file)!) {
      if (!word.w.trim() || word.e <= take.s || word.s >= take.e) continue;
      const s = line.s + Math.max(word.s, take.s) - take.s, e = line.s + Math.min(word.e, take.e) - take.s;
      // A word must be heard for at least a millisecond (the same floor voiceTakeWords keeps): a line whose take
      // ends where the next word starts, give or take float noise from retiming, overlaps that word by 1e-14 s,
      // and that sliver became a zero length caption cue the export refused ("Invalid title word").
      if (e - s >= MIN_HEARD_S) words.push({ id, occurrence, line: line.id, lineIndex, w: word.w, s, e, sourceS: word.s, sourceE: word.e, file: take.file, added: mine });
    }
  });
  words.sort((a, b) => a.s - b.s || a.e - b.e);
  const merged: HeardVoiceWord[] = [], open = new Map<string, HeardVoiceWord>();
  for (const word of words) {
    const key = `${word.occurrence}\u0000${word.id}`, prior = open.get(key);
    if (prior && Math.abs(prior.e - word.s) <= 1e-6) { prior.e = Math.max(prior.e, word.e); continue; }
    const next = { ...word }; merged.push(next); open.set(key, next);
  }
  return { words: merged, pending };
}
/** The voiceover as the Text panel shows it: what is heard, in timeline order, grouped and corrected exactly as
 * the captions are. Hidden words (corrected to nothing) stay listed so they can be put back. */
export function voiceTranscript(lines: VoiceoverLine[], takeOf: (file: string) => VoiceTakeSource | undefined, track: TitleTrack | null | undefined): VoiceTranscriptWord[] {
  const corrections = voiceCorrectionsOf(track);
  const { words } = heardVoiceWords(lines, takeOf, voiceAddedOf(track));
  return transcriptGroups(words, w => w.w, (a, b) => a.lineIndex === b.lineIndex && a.occurrence === b.occurrence).map(({ text, tokens }) => {
    const fix = corrections[tokens[0].id], shown = fix && fix.was === text ? fix.text : text;
    return { ...tokens[0], s: Math.min(...tokens.map(t => t.s)), e: Math.max(...tokens.map(t => t.e)), sourceS: Math.min(...tokens.map(t => t.sourceS)),
      sourceE: Math.max(...tokens.map(t => t.sourceE)), text: shown, spoken: text, hidden: !shown.trim(), tokens: tokens.map(t => t.id) };
  });
}

const tokenKey = (text: string) => text.toLocaleLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
/** What retyping a run of voice words means, word by word: words he kept, words he respelled (`fix`), words he
 * typed that were not there (`add`, each next to the word it was typed before or after) and words he left out
 * (`fix` to "", hidden from captions; the voice itself is cut with Delete). Matching is by spelling, in order. */
export function retypeVoiceWords(words: Pick<VoiceTranscriptWord, 'id' | 'occurrence' | 'text'>[], typed: string): {
  fix: { word: string; text: string }[]; add: { text: string; before?: { word: string; occurrence: string }; after?: { word: string; occurrence: string } }[] } {
  const tokens = typed.trim().split(/\s+/u).filter(Boolean), n = tokens.length, m = words.length;
  // Longest common subsequence by spelling: those words stay put; everything between them is respelled, added or left out.
  const table = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    table[i][j] = tokenKey(tokens[i]) && tokenKey(tokens[i]) === tokenKey(words[j].text) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (tokenKey(tokens[i]) && tokenKey(tokens[i]) === tokenKey(words[j].text)) { pairs.push([i, j]); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) i++; else j++;
  }
  const fix: { word: string; text: string }[] = [], add: ReturnType<typeof retypeVoiceWords>['add'] = [];
  const at = (j: number) => ({ word: words[j].id, occurrence: words[j].occurrence });
  let ti = 0, wj = 0;
  for (const [pi, pj] of [...pairs, [n, m] as [number, number]]) {
    const gapTokens = tokens.slice(ti, pi), gapWords = words.slice(wj, pj).map((_, k) => wj + k), shared = Math.min(gapTokens.length, gapWords.length);
    for (let k = 0; k < shared; k++) if (gapTokens[k] !== words[gapWords[k]].text) fix.push({ word: words[gapWords[k]].id, text: gapTokens[k] });
    for (const j of gapWords.slice(shared)) fix.push({ word: words[j].id, text: '' });
    const extra = gapTokens.slice(shared);
    if (extra.length) {
      // Typed before a word he kept: they go before it. Typed at the end: after the last word there.
      const last = gapWords.length ? gapWords[gapWords.length - 1] : wj - 1;
      if (pj < m) add.push({ text: extra.join(' '), before: at(pj) });
      else if (last >= 0) add.push({ text: extra.join(' '), after: at(last) });
    }
    if (pi < n && pj < m && tokens[pi] !== words[pj].text) fix.push({ word: words[pj].id, text: tokens[pi] });
    ti = pi + 1; wj = pj + 1;
  }
  return { fix, add };
}
/** Where typed missing words go: in the piece of the word they were typed next to, in the pause beside it when
 * there is room, otherwise sharing that word's time by length. Take seconds, one new id each. */
export function placeVoiceWords(lines: VoiceoverLine[], heard: HeardVoiceWord[], text: string, anchor: { before?: { word: string; occurrence: string }; after?: { word: string; occurrence: string } }, newId: () => string): VoiceAddedWord[] {
  const tokens = text.trim().split(/\s+/u).filter(Boolean);
  if (!tokens.length || tokens.some(t => t.length > 120)) throw new Error('Type the missing words.');
  const side = anchor.before ? 'before' : 'after', target = anchor.before ?? anchor.after;
  const index = target ? heard.findIndex(w => w.id === target.word && w.occurrence === target.occurrence) : -1;
  if (index < 0) throw new Error('Those words have changed. Choose where to add the word again.');
  const word = heard[index], line = lines.find(l => l.id === word.line);
  if (!line?.take) throw new Error('Those words have changed. Choose where to add the word again.');
  const lineEnd = line.s + line.take.e - line.take.s, letters = (t: string) => Math.max(1, tokenKey(t).length);
  const need = tokens.reduce((n, t) => n + letters(t), 0), mine = letters(word.w), roomy = 0.12 * tokens.length, natural = 0.32 * tokens.length;
  let s: number, e: number;
  if (side === 'before') {
    const prior = heard.slice(0, index).reverse().find(w => w.line === word.line), lo = Math.max(line.s, prior?.e ?? line.s), hi = word.s;
    if (hi - lo >= roomy) { s = Math.max(lo, hi - natural); e = hi; }
    else { s = lo; e = lo + (word.e - lo) * need / (need + mine); }
  } else {
    const next = heard.slice(index + 1).find(w => w.line === word.line), lo = word.e, hi = Math.min(lineEnd, next?.s ?? lineEnd);
    if (hi - lo >= roomy) { s = lo; e = Math.min(hi, lo + natural); }
    else { e = Math.max(lo, hi); s = word.s + (e - word.s) * mine / (need + mine); }
  }
  if (!(e - s > 0.02)) throw new Error('There is no room for a word there.');
  const toTake = (t: number) => line.take!.s + t - line.s;
  let at = toTake(s);
  const span = toTake(e) - at;
  return tokens.map(t => {
    const from = at; at += span * letters(t) / need;
    return { id: newId(), file: line.take!.file, s: from, e: at, w: ` ${t}`, ...(side === 'before' ? { before: word.id } : { after: word.id }) };
  });
}
/** Re-listened words for one piece (take seconds) against what the take already says there: the words the
 * transcriber missed, matched in order by spelling, as added words next to the word they come before. */
export function missedVoiceWords(existing: { id: string; w: string; s: number; e: number }[], fresh: Word[], file: string, prior: VoiceAddedWord[], newId: () => string): VoiceAddedWord[] {
  const a = fresh.filter(w => tokenKey(w.w)), b = existing.filter(w => tokenKey(w.w)), n = a.length, m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    table[i][j] = tokenKey(a[i].w) === tokenKey(b[j].w) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const missing: { word: Word; next?: string; prev?: string }[] = [];
  let i = 0, j = 0;
  while (i < n) {
    if (j < m && tokenKey(a[i].w) === tokenKey(b[j].w)) { i++; j++; continue; }
    if (j < m && table[i][j + 1] > table[i + 1][j]) { j++; continue; }
    missing.push({ word: a[i], next: b[j]?.id, prev: b[j - 1]?.id }); i++;
  }
  // Never add a word twice: one already added here with the same spelling at the same time is the same word.
  return missing.filter(({ word }) => !prior.some(p => p.file === file && tokenKey(p.w) === tokenKey(word.w) && p.s < word.e && p.e > word.s))
    .map(({ word, next, prev }) => ({ id: newId(), file, s: word.s, e: word.e, w: word.w.startsWith(' ') ? word.w : ` ${word.w.trim()}`, ...(next ? { before: next } : prev ? { after: prev } : {}) }));
}
/** The caption track with his voice word changes on it: respellings by take-word id ("" hides the word; his
 * spelling put back removes the correction) and the full list of added words. The caption words carry the
 * spelling too, or the next follow would read them as a correction put back. Captions themselves are rebuilt
 * by the follow (main); the Text panel uses this to show the change at once. */
export function withVoiceWordChanges<T extends TitleTrack>(track: T, transcript: Pick<VoiceTranscriptWord, 'id' | 'spoken'>[], fixes: { word: string; text: string }[], added: VoiceAddedWord[]): T {
  const corrections = voiceCorrectionsOf(track);
  for (const fix of fixes) {
    const word = transcript.find(w => w.id === fix.word);
    if (!word) throw new Error('Those words have changed. Choose the word again.');
    if (fix.text.trim() === word.spoken) delete corrections[fix.word]; else corrections[fix.word] = { text: fix.text.trim(), was: word.spoken };
  }
  const source = (track as { captionSource?: { words: SourceWord[] } }).captionSource;
  const words = source?.words.flatMap(w => {
    if (!w.takeWord || typeof w.spoken !== 'string') return [w];
    const fix = corrections[w.takeWord];
    if (fix && fix.was === w.spoken) return fix.text ? [{ ...w, text: fix.text }] : [];
    return w.text === w.spoken ? [w] : [{ ...w, text: w.spoken }];
  });
  const next = { ...track, ...(source ? { captionSource: { ...source, words } } : {}), voiceCorrections: corrections, voiceAdded: added } as T & { voiceCorrections?: VoiceCorrections; voiceAdded?: VoiceAddedWord[] };
  if (!Object.keys(corrections).length) delete next.voiceCorrections;
  if (!added.length) delete next.voiceAdded;
  return next;
}
/** Voice pieces that may play words the transcript doesn't have: a take word lasting over a second inside the
 * piece is usually the transcriber stretching one word over speech it missed. Listening to the piece again on
 * its own finds them. Measurement only; the Text panel offers it, it never runs by itself. */
export function stretchedVoiceLines(lines: VoiceoverLine[], takeOf: (file: string) => VoiceTakeSource | undefined, track: TitleTrack | null | undefined): string[] {
  const added = voiceAddedOf(track), listed = new Map<string, ReturnType<typeof voiceTakeWords>>();
  return lines.filter(line => {
    const take = line.take, audio = take ? takeOf(take.file) : undefined;
    if (!take || !audio || !Array.isArray(audio.transcript)) return false;
    if (!listed.has(take.file)) listed.set(take.file, voiceTakeWords(audio, added));
    return listed.get(take.file)!.some(({ word, added: mine }) => !mine && word.e - word.s > 1 && word.s < take.e && word.e > take.s);
  }).map(line => line.id);
}

