import type { TitleCue } from '../../shared/schema';
export function maskedWord(text: string): string {
  let first = true;
  return text.replace(/[\p{L}\p{N}]/gu, letter => { if (first) { first = false; return letter; } return '*'; });
}
/** Shared by in-place finishing and export. Source captions stay restorable. */
export function maskCues(cues: TitleCue[], spans: {s:number;e:number}[]): TitleCue[] {
  return cues.map(c => {
    if (!c.words?.length) return c;
    let cursor = 0, text = '';
    const words = c.words.map(w => {
      const at = c.text.toLowerCase().indexOf(w.text.toLowerCase(), cursor);
      const value = spans.some(b => b.s < w.e - 1e-7 && b.e > w.s + 1e-7) ? maskedWord(w.text) : w.text;
      if (at >= cursor) { text += c.text.slice(cursor, at) + (value === w.text ? c.text.slice(at, at + w.text.length) : value); cursor = at + w.text.length; }
      return { ...w, text: value };
    });
    text += c.text.slice(cursor);
    return { ...c, text, words };
  });
}
