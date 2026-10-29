import type { CutVersion, Shoot } from '../shared/schema';
import { filmedOrder, filmedTime } from './filmed-time';
import { replacementSpan } from './library-span';
import { screenText } from '../shared/screen';
import { matchesLibraryQuery } from './library-filters';
import { clipStarred } from './footage-stars';

/** Shared Media ranking. No IO or model calls. */
const kind = (clip?: Shoot['clips'][number]) => clip?.photo ? 'photo' : clip?.byHand?.kind ?? clip?.judgement?.kind;
export function replacementChoices(shoot: Shoot, clipId: string, version?: CutVersion) {
  const original = shoot.clips.find(c => c.id === clipId), at = filmedTime(original);
  const eligible = shoot.clips.flatMap((clip, index) => {
    if (clip.leftOut || clip.missing || clip.stage === 'error') return [];
    try { replacementSpan(clip, 1); } catch { return []; }
    return [{ clip, index, inEdit: !!version?.pieces?.some(p => p.clipId === clip.id || p.overlay?.clipId === clip.id) }];
  });
  const nearest = at === null ? [] : eligible.filter(({clip}) => clip.id !== clipId && filmedTime(clip) !== null && kind(clip) === kind(original))
    .sort((a,b) => Math.abs(filmedTime(a.clip)! - at) - Math.abs(filmedTime(b.clip)! - at) || a.index - b.index).slice(0,4);
  const ids = new Set(nearest.map(c => c.clip.id));
  return { nearest, rest: filmedOrder(eligible.filter(c => !ids.has(c.clip.id)), c => c.clip) };
}

// Rank the existing local matches. Descriptions and scene names explain what
// is in the picture; a passing transcript word should not displace those hits.
export function librarySearchScores(shoot: Shoot, query: string): Map<string, number> {
  const q = query.trim().toLowerCase(), words = q.split(/\s+/);
  const strength = (values: (string | undefined)[]) => Math.max(0, ...values.map(value => {
    const text = value?.toLowerCase() ?? '';
    if (text.includes(q)) return 3;
    return words.length > 1 && words.every(word => text.includes(word)) ? 2 : 0;
  }));
  const scenes = new Map<string, string[]>(), takes = new Map<string, string[]>();
  for (const scene of (shoot as Shoot & { scenes?: { name: string; clipIds: string[] }[] }).scenes ?? []) for (const id of scene.clipIds) scenes.set(id, [...scenes.get(id) ?? [], scene.name]);
  for (const take of shoot.takes) for (const attempt of take.attempts) takes.set(attempt.clipId, [...takes.get(attempt.clipId) ?? [], attempt.text, attempt.soundbite ?? '']);
  return new Map(shoot.clips.map(clip => {
    if (!q) return [clip.id, 0];
    const scene = strength([clip.judgement?.scene, ...scenes.get(clip.id) ?? []]);
    const picture = strength([clip.judgement?.summary, ...screenText(clip)]);
    const speech = strength([...(clip.transcript?.map(segment => segment.text) ?? []), ...takes.get(clip.id) ?? []]);
    return [clip.id, scene ? 400 + scene : picture ? 300 + picture : speech ? 200 + speech : matchesLibraryQuery(clip, q) ? 100 : 0];
  }));
}

/** BUG1: how many of the newest clips the Replace clip list leads with, before its scene, similar and nearby rows. */
export const RECENT_CLIPS = 12;
/** BUG1: clip ids in the order precut first read them, newest first. The pipeline appends newly read clips
 * to the index and never reorders the clips it already has (process.py), so index order is read order. */
export function newestReadIds(shoot: Pick<Shoot, 'clips'>, ids: Iterable<string>): string[] {
  const at = new Map(shoot.clips.map((clip, index) => [clip.id, index]));
  return [...new Set(ids)].filter(id => at.has(id)).sort((a, b) => at.get(b)! - at.get(a)!);
}
/** BUG1: the Replace clip list's first row, shared by Clips' footage browser and MCP list_replacements.
 * No query: the clips read most recently, newest first. A query: every allowed clip it finds, best match first,
 * newest first among equals (match strength, then starred, then verdict, as the library ranks clips). */
export function replacementLead(shoot: Shoot, originalId: string, allowedIds: Iterable<string>, query = ''): { name: string; clipIds: string[] } {
  const ids = newestReadIds(shoot, allowedIds).filter(id => id !== originalId);
  if (!query.trim()) return { name: 'Recently added', clipIds: ids.slice(0, RECENT_CLIPS) };
  const scores = librarySearchScores(shoot, query), byId = new Map(shoot.clips.map(c => [c.id, c]));
  const rank = (id: string) => { const clip = byId.get(id)!;
    return (scores.get(id) ?? 0) + Number(clipStarred(shoot, clip)) / 10 + ({ best: 4, alt: 3, maybe: 2, unusable: 1 }[clip.judgement?.verdict ?? 'unusable']) / 100; };
  return { name: 'Matches', clipIds: ids.filter(id => (scores.get(id) ?? 0) > 0).sort((a, b) => rank(b) - rank(a)) };
}
