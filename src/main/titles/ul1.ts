import { maskedWord, maskCues } from "./bleep-presentation";
export { maskedWord } from "./bleep-presentation";
import { lowerThirdCues } from "./lower-thirds";
import type { CutVersion, TitleCue, TitleTrack } from '../../shared/schema';
import type { CutItem } from '../export';
import { transcriptText } from './text';
import { mapTime, planFx } from '../edits-fx';
import type { CaptionSource, CaptionTrack } from './captions';

export function bleepTimes(version: Pick<CutVersion, 'bleeps' | 'pieceFx' | 'joins' | 'transition' | 'faceMatch'>, cuts: CutItem[], fps: number) {
  const plan = planFx(cuts, fps, version);
  return (version.bleeps ?? []).flatMap(b => plan.items.flatMap(item => {
    const s = Math.max(b.s, item.timeMap[0].s), e = Math.min(b.e, item.timeMap.at(-1)!.s);
    if (b.piece !== item.piece || e <= s || item.reverse) return [];
    return [{ s: mapTime(item.timeMap, s), e: mapTime(item.timeMap, e), sound: b.sound }];
  }));
}
// The source track is retained privately for exact removal/undo. Every live and
// export consumer receives the same presentation track, including kinetic text.
export function presentTitles(version: Pick<CutVersion, 'titles' | 'bleeps' | 'lowerThirds' | 'pieceFx' | 'joins' | 'transition' | 'faceMatch' | 'layouts'>, cuts: CutItem[], fps: number, source?: CaptionSource): TitleTrack {
  type Track = CaptionTrack & { ul1Source?: TitleTrack };
  const prior = version.titles as Track | null | undefined;
  const raw = prior?.ul1Source ?? prior ?? { font: 'Outfit', cues: [], prompt: null, skillIds: [] };
  const spans = bleepTimes(version, cuts, fps);
  const masked = (w: { s: number; e: number; text: string }) => spans.some(b => b.s < w.e - 1e-7 && b.e > w.s + 1e-7) ? maskedWord(w.text) : w.text;
  const cues = maskCues(raw.cues.filter(c=>!c.id.startsWith('lower-third:') && !c.id.startsWith('layout-title:')),spans);
  const captionSource = source ?? (raw as CaptionTrack).captionSource ?? prior?.captionSource;
  const style = raw.captionStyle;
  const plan = planFx(cuts,fps,version);
  for (const [piece,layout] of (version.layouts ?? []).entries()) {
    if (layout?.kind !== 'title' || !layout.title) continue;
    const items = plan.items.filter(p => p.piece === piece);
    if (!items.length) continue;
    cues.push({id:`layout-title:${piece}`,role:'title',layer:'front',s:items[0].startS,e:items.at(-1)!.endS,text:layout.title,
      x:.5,y:.5,align:'center',size:.055,weight:800,italic:false,color:style?.primary ?? '#ffffff',accent:style?.accent ?? '#F7C204',enter:'none',exit:'none'});
  }
  cues.push(...lowerThirdCues(version.lowerThirds,style));
  return { ...raw, cues: uniquePresentationCues(cues), ...(captionSource ? { captionSource: { ...captionSource, words: captionSource.words.map(w => ({ ...w, text: masked(w) })) } } : {}),
    ul1Source: raw } as Track;
}

/** Suppress only repeated speech, retaining unrelated captions below a card.
 * Split at graphic boundaries so a held caption is restored after the graphic. */
export function uniquePresentationCues(cues: TitleCue[]): TitleCue[] {
  const key = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const seen = new Set<string>();
  const titles = cues.filter(c => c.role === 'title' && !c.id.startsWith('lower-third:'));
  return cues.flatMap(cue => {
    const identity = JSON.stringify([cue.s,cue.e,key(cue.text),cue.role]);
    if (seen.has(identity)) return [];
    seen.add(identity);
    if (cue.role !== 'subtitle') return [cue];
    const active = titles.filter(c => c.s < cue.e && c.e > cue.s);
    const boundaries = [...new Set([cue.s,cue.e,...active.flatMap(c => [Math.max(cue.s,c.s),Math.min(cue.e,c.e)])])].sort((a,b)=>a-b);
    return boundaries.slice(0,-1).flatMap((s,i) => {
      const e = boundaries[i+1], graphics = active.filter(c => c.s < e && c.e > s);
      if (graphics.some(c => key(c.text).includes(key(cue.text)))) return [];
      if (!cue.words?.length) return [{...cue,s,e,id:boundaries.length===2?cue.id:`${cue.id}:part${i}`}];
      const words = cue.words.filter(w => w.s < e && !graphics.some(c =>
        c.words?.some(t => t.s < w.e && t.e > w.s && key(t.text) === key(w.text))));
      if (!words.length) return [];
      return [{...cue,s,e,id:boundaries.length===2?cue.id:`${cue.id}:part${i}`,
        text:words.length===cue.words.length?cue.text:transcriptText(words.map(w=>{ const at=cue.text.toLowerCase().indexOf(w.text.toLowerCase()); return at<0?w.text:cue.text.slice(at,at+w.text.length); })),
        words:words.map(w=>({...w,s:Math.max(s,w.s),e:Math.max(Math.max(s,w.s)+1e-7,Math.min(e,w.e))}))}];
    });
  });
}
