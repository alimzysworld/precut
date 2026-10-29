import type { Clip, CutVersion } from './schema';

const timestamp = String.raw`\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b`;
const timeRange = String.raw`\s*(?:-|\u2013|\u2014|to)\s*${timestamp}`;
const timePrefix = String.raw`(?:\band\s+)?[\[(]?\s*(?:\b(?:at|from|around|to)\s*)?[\[(]?\s*`;
const rangeStamp = new RegExp(String.raw`${timePrefix}${timestamp}${timeRange}[\])]*`, 'gi');
const markerStamp = new RegExp(String.raw`${timePrefix}${timestamp}(?:${timeRange}|\s+to the end)?[\])]*`, 'gi');

export function cleanClipLabel(value: string, markerTimes = false): string {
  return value.replace(/^\s*(?:[LB]\d+(?:A\d+)?\s*:\s*|b-roll\s+[^:]+:\s*)/i, "")
    // Single times in saved markers are source positions; prose may name a clock time.
    .replace(markerTimes ? markerStamp : rangeStamp, " ")
    .replace(/\(\s*\)|\[\s*\]/g, "").replace(/\s+([,.;])/g, "$1")
    .replace(/[,;](?:\s*[,;])+/g, ",").replace(/[,;]\s*([.!?])/g, "$1")
    .replace(/^[\s,;:]+|[\s,;:]+$/g, "").replace(/\s{2,}/g, " ").trim();
}

/** Reuse the judge/person's words. No new judgement or model call for a label. */
export type NamedSpan = { s?: number; e?: number; timelineS?: number; lengthS?: number; description?: string; words?: string; marker?: string };
export function shotTime(seconds = 0): string {
  const ticks = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 100);
  const whole = Math.floor(ticks / 100), fraction = ticks % 100;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}${fraction ? '.' + String(fraction).padStart(2, '0').replace(/0$/, '') : ''}`;
}
export function clipName(clip?: Pick<Clip, 'judgement' | 'transcript' | 'meta'> | null, span: NamedSpan = {}): string {
  const transcript = clip?.transcript?.filter(s => s.e > (span.s ?? 0) && s.s < (span.e ?? Infinity)).map(s => s.text).join(' ');
  const authored = [span.marker, span.description, clip?.judgement?.summary, span.words, transcript].find(s => s?.trim());
  const cleaned = authored === undefined ? undefined : cleanClipLabel(authored, authored === span.marker).replace(/[\r\n]+/g, ' ').replace(/[–—]/g, ',').replace(/\s+/g, ' ').trim();
  // A short excerpt, never a synthesized description. Keep sentence/word boundaries.
  const sentence = cleaned?.split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, '');
  const words = sentence?.split(' ') ?? [];
  let short = words.slice(0, 9).join(' ');
  if (short.length > 64) short = short.slice(0, 64).replace(/\s+\S*$/, '');
  if (sentence && short.length < sentence.length) short = short.replace(/(?:\s+\b(?:at|from|around|and|then|or|to|the|a|an|of|with|in|on)\b|[,;:])+$/gi, '') + '…';
  const duration = span.lengthS ?? (span.e !== undefined ? span.e - (span.s ?? 0) : clip?.meta?.durationS);
  // ANA1 (TEST1 #15): a 31-minute clip read "the 1880.1 s shot". Minutes from a minute up.
  const fallback = duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration >= 60 ? `the ${Math.round(duration / 60)} min shot` : `the ${duration.toFixed(1)} s shot` : 'the shot';
  return `${short || fallback} at ${shotTime(span.timelineS ?? span.s)}`;
}
export function pieceName(shoot: { clips: Clip[] }, version: Pick<CutVersion, 'pieces'>, index: number): string {
  const piece = version.pieces?.[index];
  return clipName(shoot.clips.find(c => c.id === piece?.clipId), piece);
}

/** Older saved critiques/undo text can still contain one-based clip numbers. */
export function nameLegacyPieces(text: string, names: readonly string[]): string {
  return text.replace(/\b(?:clip|piece)\s+#?(\d+)\b(?!\s+of\b)/gi, (original, number) => names[Number(number) - 1] ?? 'the shot');
}
