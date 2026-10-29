import type { CutEdit, CutVersion, DraftTimeline, Shoot } from './schema';

export type SourcePlacement = { at: number; atS: number; aligned: boolean; trim?: CutEdit };
/** Playback joins are authoritative after speed, overlaps and transcript cuts. */
export function sourceJoins(version: CutVersion, timeline?: DraftTimeline | null): number[] {
  return [...(version.pieces ?? []).map((p,i)=>timeline?.pieces.find(p=>p.layer===0 && p.piece===i)?.startS ?? p.timelineS),timeline?.durationS ?? version.lengthS];
}
/** E follows the shot under the clock; an exact join belongs to that join. Music never moves it. */
export function sourcePlacement(version: CutVersion, timeline: DraftTimeline | null | undefined, time: number, _shoot: Pick<Shoot,'clips'>, append=false): SourcePlacement {
  const joins=sourceJoins(version,timeline);
  const exact=joins.findIndex(t=>Math.abs(t-time)<1e-6);
  const next=joins.findIndex(t=>t>time);
  const at=append ? joins.length-1 : exact>=0 ? exact : next>=0 ? next : joins.length-1;
  return {at,atS:joins[at],aligned:!!timeline?.musicGrid?.beats.some(t=>Math.abs(t-joins[at])<1e-6)};
}
/** Use the saved editorial words, never manufacture a description from a filename. */
export function sourceDestination(version: CutVersion, placement: SourcePlacement, shoot: Pick<Shoot,'clips'>): string {
  const prior=version.pieces?.[placement.at-1];
  const name=prior?.description || shoot.clips.find(c=>c.id===prior?.clipId)?.judgement?.summary;
  const seconds=Math.max(0,Math.round(placement.atS));
  const clock=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
  return `${placement.at===0 ? 'Goes at the start' : name ? `Goes after ${name}` : 'Goes after this shot'}, ${clock}`;
}
