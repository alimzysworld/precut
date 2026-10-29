import type { CaptionStyle, CutVersion, TitleCue, Shoot } from '../../shared/schema';
import { transcriptGroups } from './text';
import { buildCaptionTrack, type CaptionTrack, type KineticDesign } from './captions';
import { isOpeningCue, resolveOpeningLines } from './opening';

/** Selection is authored by the finishing/title model. This validates measured
 * speech coverage, rather than guessing which phrase deserves a graphic. */
export function validateKineticDesign(value: unknown, words: NonNullable<CaptionTrack['captionSource']>['words'],
  validate: (track: unknown) => { font: string; cues: TitleCue[] }): KineticDesign {
  if (!value || typeof value !== 'object') throw new Error('Kinetic captions need a design.');
  const v = value as KineticDesign;
  // The opening draws in the caption font; a design that names no title font keeps the default one.
  const font = typeof v.font === 'string' ? v.font : 'Inter Display';
  if (!Array.isArray(v.lines)) throw new Error('Kinetic captions need measured lines.');
  // An opening style's phrases become cues the engine sizes and places (opening.ts); the wording stays the model's.
  const lines = resolveOpeningLines(v.lines, words).map(line => {
    if (!line || !Number.isFinite(line.s) || !Number.isFinite(line.e) || line.e <= line.s ||
      typeof line.hook !== 'boolean' || typeof line.reason !== 'string' || !line.reason.trim() || !Array.isArray(line.cues) || !line.cues.length) throw new Error('Invalid kinetic caption line.');
    const spoken = words.filter(w => w.s >= line.s - 1e-7 && w.e <= line.e + 1e-7);
    if (!spoken.length || Math.abs(spoken[0].s - line.s) > 1e-7 || Math.abs(spoken.at(-1)!.e - line.e) > 1e-7 ||
      words.some(w => w.s < line.e && w.e > line.s && !spoken.includes(w))) throw new Error('Kinetic lines must contain complete measured words.');
    const designed = validate({ font, cues: line.cues });
    const cues = designed.cues.map((cue, i) => {
      const authored = line.cues.find(c => c.id === cue.id)!;
      // Running speech never inherits the title reading hold or an exit tail.
      return { ...cue, s: authored.s, e: authored.e, exit: 'none' as const, ...(isOpeningCue(authored) ? { opening: authored.opening } : {}) };
    });
    if (cues.some(c => c.role !== 'title' || !c.words?.length || c.s < line.s || c.e > line.e)) throw new Error('Kinetic cues must stay within their spoken line.');
    const coverage = cues.flatMap(c => c.words!).sort((a, b) => a.s - b.s);
    if (coverage.length !== spoken.length || coverage.some((w, i) => w.s !== spoken[i].s || w.e !== spoken[i].e || w.text.toLowerCase() !== spoken[i].text.toLowerCase())) throw new Error('Kinetic captions must show every measured word exactly once.');
    // No blank frame between the first reveal and the normal caption boundary.
    const intervals = [...cues].sort((a, b) => a.s - b.s);
    let end = line.s;
    for (const cue of intervals) { if (cue.s > end + 1e-7) throw new Error('Kinetic captions have a display gap.'); end = Math.max(end, cue.e); }
    if (end < line.e - 1e-7) throw new Error('Kinetic captions end before their line.');
    return { s: line.s, e: line.e, hook: line.hook, reason: line.reason, ...(line.style ? { style: line.style } : {}), cues };
  }).sort((a, b) => a.s - b.s);
  if (lines.filter(l => l.hook).length > 1) throw new Error('Choose one opening punch line.');
  if (lines.some((l, i) => i > 0 && l.s < lines[i - 1].e)) throw new Error('Kinetic lines cannot overlap.');
  return { font, lines };
}

export function updateBigLines(previous: CutVersion, s: number, big: boolean | null) {
  if (!Number.isFinite(s) || s < 0 || (big !== null && typeof big !== 'boolean')) throw new Error('Choose a caption line and big, normal or automatic.');
  const track = previous.titles as CaptionTrack | undefined;
  if (!track?.captionSource?.words.length || !track.captionStyle) throw new Error('Turn captions on before making a line big.');
  const normal = buildCaptionTrack(track.captionSource.words, track, { ...track.captionStyle, hook: 'off' });
  const known = [...normal.cues.filter(c => c.role === 'subtitle'), ...(track.kinetic?.lines ?? [])];
  if (!known.some(c => Math.abs(c.s - s) < 1e-7)) throw new Error('That caption line is no longer in this edit.');
  return [...(previous.bigLines ?? []).filter(item => Math.abs(item.s - s) >= 1e-7), ...(big === null ? [] : [{ s, big }])].sort((a, b) => a.s - b.s);
}

export function kineticNeeds(track: CaptionTrack, style: CaptionStyle, overrides: CutVersion['bigLines'] = []) {
  if (style.hook === "off") return [];
  const normal = buildCaptionTrack(track.captionSource?.words ?? [], track, { ...style, hook: 'off' });
  return normal.cues.filter(c => c.role === 'subtitle' && overrides.some(o => o.big && Math.abs(o.s - c.s) < 1e-7) && !track.kinetic?.lines.some(l => Math.abs(l.s - c.s) < 1e-7));
}

/** First-cut fields use piece-local word indices so the model never has to
 * predict frame rounding, removed pauses, joins or the final reel clock. */
export function resolveKineticPlan(raw: unknown, words: NonNullable<CaptionTrack['captionSource']>['words'], pieceIds: string[], catalog?: ReturnType<typeof kineticWordCatalog>): unknown {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as KineticDesign).lines)) return raw;
  const value = raw as { font: string; lines: Record<string, unknown>[] };
  type SourcedWord = typeof words[number] & { sourceS?: number; sourceE?: number };
  const range = (data: Record<string, unknown>, spoken: typeof words, original?: { s: number; e: number }[]) => {
    const from = data.from, to = data.to;
    if (!Number.isInteger(from) || !Number.isInteger(to) || (from as number) < 0 || (to as number) <= (from as number) || (to as number) > (original?.length ?? spoken.length)) throw new Error("Kinetic word indices are outside this piece.");
    if (!original) return spoken.slice(from as number, to as number);
    const low = original[from as number].s, high = original[(to as number) - 1].e;
    const selected = (spoken as SourcedWord[]).filter(w => w.sourceS !== undefined && w.sourceE !== undefined && w.sourceS >= low - 1e-7 && w.sourceE <= high + 1e-7);
    if (!selected.length) throw new Error("The kinetic phrase was removed from this edit.");
    return selected;
  };
  return { ...value, lines: value.lines.map(line => {
    if (typeof line.piece !== "string") return line;
    if (pieceIds.filter(id => id === line.piece).length !== 1) throw new Error("Kinetic captions need an unambiguous piece id.");
    const spoken = words.filter(w => w.piece === pieceIds.indexOf(line.piece as string));
    const original = catalog?.find(entry => entry.piece === line.piece)?.words;
    if (Array.isArray(line.phrases)) {
      // An opening style: each phrase's words resolved here; the engine sizes, places and times them (opening.ts).
      return { ...line, phrases: line.phrases.map(data => {
        if (!data || typeof data !== "object") throw new Error("Invalid opening phrase.");
        const phrase = data as Record<string, unknown>, chosen = range(phrase, spoken, original), accents = Array.isArray(phrase.accents) ? phrase.accents : [];
        const index = (w: SourcedWord, j: number) => original ? original.findIndex(old => old.s === w.sourceS && old.e === w.sourceE) : Number(phrase.from) + j;
        return { role: phrase.role, words: chosen.map((w, j) => ({ text: w.text, s: w.s, e: w.e, accent: accents.includes(index(w as SourcedWord, j)) })) };
      }) };
    }
    const selected = range(line, spoken, original);
    if (!Array.isArray(line.cues)) throw new Error("Kinetic captions need cues.");
    return { ...line, s: selected[0].s, e: selected.at(-1)!.e, cues: line.cues.map((data, i) => {
      if (!data || typeof data !== "object") throw new Error("Invalid kinetic cue.");
      const cue = data as Record<string, unknown>, selected = range(cue, spoken, original);
      const accents = cue.accents ?? [];
      if (!Array.isArray(accents) || accents.some(index => !Number.isInteger(index) || index < Number(cue.from) || index >= Number(cue.to))) throw new Error("Kinetic accents must be measured word indices in the cue.");
      return { ...cue, id: cue.id ?? `line-${line.piece}-${line.from}-${i}`, role: "title", text: selected.map(w => w.text).join(" "),
        s: selected[0].s, e: selected.at(-1)!.e, words: selected.map((w, j) => ({ text: w.text, s: w.s, e: w.e, accent: accents.includes(original ? original.findIndex(old => old.s === (w as SourcedWord).sourceS && old.e === (w as SourcedWord).sourceE) : Number(cue.from) + j) })) };
    }) };
  }) };
}

export function kineticWordCatalog(shoot: Shoot) {
  return shoot.takes.flatMap(t => t.attempts.map((a, i) => ({ piece: `L${t.lineIndex + 1}A${i + 1}`,
    words: transcriptGroups((shoot.clips.find(c => c.id === a.clipId)?.transcript ?? []).flatMap(s => s.words).filter(w => w.e > a.s && w.s < a.e), w => w.w, () => true)
      .map(({ text, tokens }, index) => ({ index, text, s: Math.min(...tokens.map(w => w.s)), e: Math.max(...tokens.map(w => w.e)) })) })));
}
