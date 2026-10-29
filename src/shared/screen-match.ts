import type { Shoot } from './schema';
import { isScreenClip } from './screen';
export function listScreenRecordings(shoot: Shoot) {
  return shoot.clips.filter(c => isScreenClip(c) && !c.leftOut && !c.missing && c.stage !== 'error')
    .map(c => ({ clipId: c.id, durationS: c.meta?.durationS ?? 0, read: !!c.screen,
      segments: c.screen?.segments ?? [] }));
}
/** Local candidates, not a semantic judgement. Always offer the nearest available screen. */
export function matchScreen(shoot: Shoot, topic: string) {
  const query = topic.normalize('NFKC').toLowerCase().trim();
  const terms = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])];
  return listScreenRecordings(shoot).flatMap(c => (c.segments.length ? c.segments : [{ s: 0, e: c.durationS, text: '', still: '' }]).map(segment => {
    const text = [segment.line, segment.app, segment.action, segment.text].filter(Boolean).join(' ');
    const lower = text.normalize('NFKC').toLowerCase();
    const matched = terms.filter(t => lower.includes(t));
    return { clipId: c.clipId, ...segment, score: matched.length + (query && lower.includes(query) ? terms.length + 1 : 0),
      reason: matched.length ? `On screen: ${segment.line || segment.app || matched.join(', ')}.` : c.read ? 'Closest available screen; no matching words were found.' : 'Available screen recording; its contents have not been read yet.' };
  })).sort((a,b) => b.score - a.score || Number(!!(b.line || b.text)) - Number(!!(a.line || a.text)) || a.clipId.localeCompare(b.clipId) || a.s - b.s);
}
