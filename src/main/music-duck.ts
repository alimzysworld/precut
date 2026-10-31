import { laneMuted } from '../shared/lane-levels';
import type { CutVersion } from '../shared/schema';
import { MUSIC_DUCK, musicDuckKeys, type DuckSpan } from '../shared/music-duck';
import type { CutItem } from './export';
import type { FxItem, FxPlan } from './edits-fx';
import { audioSpan } from './join-audio';
/** Speech is backed by measured transcript words in the chosen source span. */
export function clipDuckDb(cut: CutItem, item: FxItem): number {
  const s=item.timeMap[0].s,e=item.timeMap.at(-1)!.s;
  const words=[...(cut.seg?.clip.transcript?.flatMap(p=>p.words ?? []) ?? []),...(cut.seg?.speechWords ?? [])];
  return cut.seg?.lineIndex != null || words.some(w=>w.s<e && w.e>s) ? MUSIC_DUCK.speechDb : MUSIC_DUCK.ambienceDb;
}
export function cutDuckSpans(cuts: CutItem[], plan: FxPlan, narration: CutVersion['voiceover'], attached: {cut:CutItem;item:FxItem}[] = []): DuckSpan[] {
  return [...cuts.map((cut,i)=>({cut,item:plan.items[i]})),...attached].flatMap<DuckSpan>(({cut,item})=>{
    const clip=cut.seg?.clip;
    return !item || item.muted || item.reverse || !clip || (!clip.sound && !clip.meta?.audioChannels) ? [] : [{...audioSpan(item),duckDb:clipDuckDb(cut,item)}];
  }).concat((narration?.lines ?? []).flatMap(l=>l.take ? [{startS:l.s,endS:Math.min(plan.durationS,l.s+l.take.e-l.take.s),duckDb:MUSIC_DUCK.speechDb}] : []));
}
export function cutMusicKeys(cuts: CutItem[], plan: FxPlan, version: Pick<CutVersion,'music'|'voiceover'|'laneMuted'>, attached: {cut:CutItem;item:FxItem}[] = []) {
  // PRO3a: the music's stillnesses and hits ride on the duck (shared/music-shape.ts).
  return musicDuckKeys(cutDuckSpans(cuts,plan,laneMuted(version,'voice') ? undefined : version.voiceover,attached),plan.durationS,version.music?.duckDepthDb,version.music?.shape);
}
