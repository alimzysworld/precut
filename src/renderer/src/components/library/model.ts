import type { CutVersion, Shoot } from '../../../../shared/schema';
import { librarySearchScores, replacementChoices, replacementLead } from '../../../../main/library-ranking';
export { replacementChoices } from '../../../../main/library-ranking';
import { clipItem, itemStarred, similarItems, type FootageItem } from '../footage/model';
import { replacementSpan } from '../replaceModel';
import { matchScreen } from '../../../../shared/screen-match';
import type { LayoutChoice, CutEdit } from '../../../../shared/schema';
export function layoutReplacementGroups(shoot:Shoot,layout:LayoutChoice,topic:string){
  const seen=new Set<string>();
  const items=matchScreen(shoot,topic).flatMap(m=>{
    const clip=shoot.clips.find(c=>c.id===m.clipId);
    if(!clip?.proxy||!clip.meta||clip.meta.durationS<=0||seen.has(m.clipId)||m.clipId===layout.sources?.a?.clipId)return [];
    seen.add(m.clipId);return [{...clipItem(shoot,clip),s:m.s,e:m.e}];
  });
  return [{id:'replace-layout',name:'Closest screens',items}];
}
export function layoutReplacementEdit(layout:LayoutChoice,item:FootageItem):CutEdit {
  const s=item.s,e=Math.min(item.e??item.clip.meta!.durationS,item.clip.meta!.durationS),loop=e-s<layout.e!-layout.s!;
  return {kind:'layoutRange',s:layout.s!,e:layout.e!,layout:{...layout,auto:false,sources:{...layout.sources,a:{clipId:item.clip.id,s}},screenLoop:loop?{s,e}:undefined,reason:(loop?'Repeats this screen segment to fill the range.':undefined)}};
}

// BUG1: the search scores live in main so the MCP Replace listing ranks the same way.
export { librarySearchScores } from '../../../../main/library-ranking';
export function libraryItemRank(shoot: Shoot, item: FootageItem, scores: Map<string, number>): number {
  return (scores.get(item.clip.id) ?? 0) + Number(itemStarred(shoot, item)) / 10
    + ({ best: 4, alt: 3, maybe: 2, unusable: 1 }[item.clip.judgement?.verdict ?? 'unusable']) / 100;
}
export function rankLibraryGroups<T extends { items: FootageItem[] }>(shoot: Shoot, groups: T[], scores: Map<string, number>): T[] {
  const rank = (item: FootageItem) => libraryItemRank(shoot, item, scores);
  return groups.map(group => ({ ...group, items: [...group.items].sort((a, b) => rank(b) - rank(a)) }))
    .sort((a, b) => Math.max(...b.items.map(rank)) - Math.max(...a.items.map(rank)));
}

export function mediaItem(shoot: Shoot, item: FootageItem): FootageItem {
  if (item.attempt) return item;
  try { return { ...item, ...replacementSpan(item.clip, item.clip.meta?.durationS ?? 0) }; }
  catch { return item; }
}
export function scopedLibraryGroups(shoot: Shoot, version: CutVersion, piece: number, allowed: FootageItem[], query = '') {
  const original = shoot.clips.find(c => c.id === version.pieces?.[piece]?.clipId);
  if (!original) return [];
  const allowedIds = new Set(allowed.map(i => i.clip.id));
  // BUG1: the lead row (Recently added, or Matches while searching) comes from main, the same list MCP list_replacements returns.
  const lead = replacementLead(shoot, original.id, allowedIds, query);
  const leadGroup = { id: query.trim() ? 'replace-matches' : 'replace-recent', name: lead.name, items: lead.clipIds.map(id => mediaItem(shoot, clipItem(shoot, shoot.clips.find(c => c.id === id)!))) };
  if (query.trim()) return [leadGroup].filter(g => g.items.length);
  const seen = new Set<string>();
  const group = (id: string, name: string, ids: string[]) => ({ id, name, items: ids.flatMap(id => {
    const clip = shoot.clips.find(c => c.id === id);
    if (!clip || !allowedIds.has(id) || seen.has(id)) return [];
    seen.add(id); return [mediaItem(shoot, clipItem(shoot, clip))];
  }) });
  const scene = (shoot as Shoot & { scenes?: { name: string; clipIds: string[] }[] }).scenes?.find(s => s.clipIds.includes(original.id));
  const sceneIds = scene?.clipIds ?? shoot.clips.filter(c => original.judgement?.scene && c.judgement?.scene === original.judgement.scene).map(c => c.id);
  const related = shoot.clips.filter(c => c.shot?.id && c.shot.id === original.shot?.id || original.angles?.includes(c.id)).map(c => c.id);
  const choices = replacementChoices(shoot, original.id, version);
  // BUG1: the clips precut read most recently lead, so a clip just added is the first choice. They stay in the rows below too.
  return [leadGroup, group('replace-scene', scene?.name ?? original.judgement?.scene ?? 'This scene', [original.id, ...sceneIds, ...related]),
    (() => { const similar = similarItems(shoot, clipItem(shoot, original)).map(i => i.clip.id); similar.forEach(id => seen.delete(id)); return group('replace-similar', 'Similar', similar); })(),
    group('replace-nearby', 'Nearby shots', choices.nearest.map(c => c.clip.id))].filter(g => g.items.length);
}
/** BUG1: the Replace clip list as Clips' footage browser shows it. keep applies the panel's own filters;
 * a query keeps the clips the library search finds (file name, what it shows, what is said). */
export function replaceClipGroups(shoot: Shoot, version: CutVersion, piece: number, query = '', keep: (clip: Shoot['clips'][number]) => boolean = () => true) {
  const footage = { ...shoot, clips: shoot.clips.filter(c => !c.leftOut) };
  const q = query.trim(), scores = q ? librarySearchScores(footage, q) : null;
  const allowed = footage.clips.filter(c => keep(c) && (!scores || (scores.get(c.id) ?? 0) > 0)).map(c => clipItem(footage, c));
  return scopedLibraryGroups(footage, version, piece, allowed, q);
}
