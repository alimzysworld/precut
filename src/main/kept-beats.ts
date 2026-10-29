// Chosen story beats are local constraints, not another model judgement pass.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SidekickMessage, VoiceoverScript } from '../shared/schema';
import type { StoredCut, StoredVersion } from './sidekick';
import { cutPieceGroups } from './export';
import { resolveReelPieces } from './reel';
import { planFx, syncFxMetadata, mapSource, mapTime } from './edits-fx';
import { retimeMagneticItems } from './edits-move';
import { retimeScript, timeScript } from './voiceover-retime';

export interface KeptBeat {
  clipId: string; shotId?: string; id: string; sourceVersion: number; piece: number;
  position: 'opening' | 'middle' | 'ending';
  minimumS?: number;
  s?: number; e?: number;
  narrationOrder?: number;
}

/** Narration is attached to its picture, even when that picture was not named
 * in the idea. Only pictures still present in the person's version are added. */
export function narratedKeptBeats(record: StoredVersion, script: VoiceoverScript, chosen: KeptBeat[]): KeptBeat[] {
  const fx=planFx(record.assembly.cutList,record.assembly.template.fps,record), healthy=timeScript(script);
  const result=chosen.map(b=>({...b}));
  for (const beat of seedKeptBeats(record,(record.assembly.reel?.cuts ?? []).map(c=>c.id))) {
    const items=fx.items.filter(i=>i.piece===beat.piece);
    if (!items.length) continue;
    const lines=healthy.lines.filter(l=>(l.s+l.e)/2>=items[0].startS && (l.s+l.e)/2<items.at(-1)!.endS);
    if (!lines.length) continue;
    const minimumS=Math.max(...lines.map(l=>l.e+(l.pauseAfterS ?? 0)))-items[0].startS;
    const existing=result.find(b=>findBeat(groups(record).map((_,piece)=>({record,piece})),b)===beat.piece);
    const narrationOrder=healthy.lines.findIndex(l=>l.id===lines[0].id);
    if (existing) { existing.minimumS=minimumS; existing.narrationOrder=narrationOrder; }
    else result.push({...beat,minimumS,narrationOrder});
  }
  return result;
}
const groups = (v: StoredVersion) => cutPieceGroups(v.assembly.cutList);
const matches = (v: StoredVersion, piece: number, beat: KeptBeat) => {
  const items=groups(v)[piece]?.items,first=items?.[0],clip=first?.seg?.clip;
  if (!clip || !first || !items) return false;
  if (clip.id !== beat.clipId) return !!beat.shotId && clip.shot?.id === beat.shotId;
  if (beat.s===undefined || beat.e===undefined || v.assembly.reel?.cuts?.[piece]?.id===beat.id) return true;
  const rate=first.clipFpsR.num/first.clipFpsR.den;
  return Math.min(items.at(-1)!.outFrames/rate,beat.e)>Math.max(first.inFrames/rate,beat.s);
};
// One source clip may supply several different story beats. Prefer the exact
// source span rather than mistaking the first use for the ending of that clip.
function findBeat(order: {record:StoredVersion;piece:number}[], beat:KeptBeat, reserved?:Set<typeof order[number]>): number {
  const score=(entry:typeof order[number])=>{
    const items=groups(entry.record)[entry.piece].items, first=items[0],last=items.at(-1)!;
    const rate=first.clipFpsR.num/first.clipFpsR.den,s=first.inFrames/rate,e=last.outFrames/rate;
    const overlap=beat.s===undefined || beat.e===undefined ? 0 : Math.max(0,Math.min(e,beat.e)-Math.max(s,beat.s));
    return overlap*1000 + (entry.record.assembly.reel?.cuts?.[entry.piece]?.id===beat.id ? 10 : 0)-Math.abs(s-(beat.s ?? s));
  };
  const target=beat.position==='opening' ? 0 : beat.position==='ending' ? order.length-1 : beat.piece;
  return order.map((entry,index)=>({entry,index})).filter(({entry})=>!reserved?.has(entry) && matches(entry.record,entry.piece,beat))
    .sort((a,b)=>score(b.entry)-score(a.entry) || Math.abs(a.index-target)-Math.abs(b.index-target))[0]?.index ?? -1;
}
export function keptBeatPacket(record:StoredVersion,beats:KeptBeat[]) {
  const order=groups(record).map((_,piece)=>({record,piece}));
  const reserved=new Set<typeof order[number]>();
  return beats.map(beat=>{const piece=findBeat(order,beat,reserved);if(piece>=0)reserved.add(order[piece]);return {...beat,sourcePiece:beat.piece,piece};});
}
/** Length repair can reorder a draft before its first save. References to that
 * same version must point at the published layout, not its discarded plan. */
export function anchorKeptBeats(record:StoredVersion,beats:KeptBeat[]):KeptBeat[] {
  const packet=keptBeatPacket(record,beats),current=seedKeptBeats(record,(record.assembly.reel?.cuts ?? []).map(c=>c.id));
  return beats.map((beat,i)=>{
    const anchor=current.find(b=>b.piece===packet[i].piece);
    return {...beat,...(beat.sourceVersion===record.version && anchor ? anchor : {})};
  });
}
export function seedKeptBeats(record: StoredVersion, named: string[] = []): KeptBeat[] {
  // Old finishing-only records have no authored reel catalog to recover.
  if (!record.assembly.reel?.cuts?.length) return [];
  const list = groups(record);
  return list.flatMap((group, piece) => {
    const clip = group.items[0]?.seg?.clip, id = record.assembly.reel.cuts[piece]?.id ?? record.pieces?.[piece]?.id;
    if (!clip || !id || piece !== 0 && piece !== list.length - 1 && !named.includes(id) && !named.includes(clip.id)) return [];
    const first=group.items[0],last=group.items.at(-1)!,rate=first.clipFpsR.num/first.clipFpsR.den;
    return [{ clipId: clip.id, ...(clip.shot?.id ? { shotId: clip.shot.id } : {}), id, sourceVersion: record.version, piece,s:first.inFrames/rate,e:last.outFrames/rate,
      position: piece === 0 ? 'opening' as const : piece === list.length - 1 ? 'ending' as const : 'middle' as const }];
  });
}

/** Old cuts recover the chosen idea from the thread. Each personal version can
 * release or reposition a beat; automatic critique versions cannot erase it. */
export async function keptBeatsFor(root: string, cut: Pick<StoredCut, 'cutId' | 'versions'>, version: number): Promise<KeptBeat[]> {
  const history = cut.versions.filter(v => v.version <= version && v.assembly).sort((a,b) => a.version-b.version);
  if (!history.length) return [];
  let beats: KeptBeat[];
  const first = history[0];
  if (first.keptBeats) beats = first.keptBeats;
  else {
    const thread: SidekickMessage[] = await fs.readFile(path.join(root, '.sidething/sidekick/thread.json'), 'utf8')
      .then(JSON.parse, error => { if (error.code === 'ENOENT') return []; throw error; });
    const idea = thread.flatMap(m => m.ideas ?? []).find(i => i.cutId === cut.cutId);
    beats = seedKeptBeats(first, idea?.uses ?? []);
  }
  for (const record of history.slice(1)) {
    if (record.keptBeatOrigin === record.version && record.keptBeats) { beats = record.keptBeats; continue; }
    if (record.critique && record.keptBeatOrigin === undefined) continue;
    const order=groups(record).map((_,piece)=>({record,piece})),reserved=new Set<typeof order[number]>();
    // A hand removal remains released even if a later pass adds that shot again.
    beats = beats.flatMap(beat => {
      const piece = findBeat(order,beat,reserved);
      if (piece < 0) return [];
      reserved.add(order[piece]);
      const current=seedKeptBeats(record,(record.assembly.reel?.cuts ?? []).map(c=>c.id)).find(b=>b.piece===piece);
      return [{...(current ?? beat)}];
    });
  }
  return beats.map(b => ({...b}));
}

/** Fix a returned plan before publishing it. No second model call. Existing
 * valid trims and same-shot takes survive; absent beats reuse their valid span. */
export function restoreKeptBeats(record: StoredVersion, beats: KeptBeat[], versions: StoredVersion[]): string[] {
  if (!beats.length) { record.keptBeats=[]; record.keptBeatOrigin=record.version; return []; }
  const previous = structuredClone(record);
  let order = groups(previous).map((_, piece) => ({ record: previous, piece }));
  const reserved=new Set<typeof order[number]>();
  const restored: string[] = [];
  for (const beat of beats) {
    let index = findBeat(order,beat,reserved);
    const moved = index >= 0 && (beat.position === 'opening' && index !== 0 || beat.position === 'ending' && index !== order.length-1);
    const duration=index<0 ? 0 : groups(order[index].record)[order[index].piece].items.reduce((s,c)=>s+c.durTimelineFrames,0)/record.assembly.template.fps/(order[index].record.pieceFx?.[order[index].piece]?.speed ?? 1);
    const tooShort=!!beat.minimumS && duration+1e-6<beat.minimumS;
    if (index >= 0 && !moved && !tooShort) { reserved.add(order[index]); continue; }
    const source = versions.find(v => v.version === beat.sourceVersion);
    if (index < 0 && (!source || !matches(source, beat.piece, beat))) throw new Error('The chosen shot is unavailable. Your saved edit stays as it is.');
    const sourceDuration=source && matches(source,beat.piece,beat) ? groups(source)[beat.piece].items.reduce((s,c)=>s+c.durTimelineFrames,0)/source.assembly.template.fps/(source.pieceFx?.[beat.piece]?.speed ?? 1) : 0;
    const canGrow=tooShort && sourceDuration>duration+1e-6;
    if (index>=0 && !moved && !canGrow) { reserved.add(order[index]); continue; }
    let entry = index >= 0 ? order.splice(index,1)[0] : { record: source!, piece: beat.piece };
    if (canGrow && source) entry={record:source,piece:beat.piece};
    const target = beat.position === 'opening' ? 0 : beat.position === 'ending' ? order.length : Math.min(beat.piece, Math.max(0, order.length-1));
    order.splice(target,0,entry);
    reserved.add(entry);
    restored.push(`Restored the ${beat.position === 'middle' ? 'chosen shot' : beat.position + ' shot'}${index>=0 && canGrow ? ' for its voiceover' : ''}.`);
  }
  // V17 preserves the person's spoken sequence. When an automatic middle move
  // conflicts with that sequence, restore picture order rather than pushing a
  // later line over an unrelated shot. Unnarrated middle shots can still move.
  const narrated=beats.filter(b=>b.narrationOrder!==undefined).sort((a,b)=>a.narrationOrder!-b.narrationOrder!);
  const positions=narrated.map(b=>findBeat(order,b));
  if (positions.some((position,i)=>i>0 && position<positions[i-1])) {
    const entries=positions.map(i=>order[i]),slots=[...positions].sort((a,b)=>a-b);
    slots.forEach((slot,i)=>{order[slot]=entries[i];});
    if (beats.some(b=>b.position==='opening' && findBeat(order,b)!==0 || b.position==='ending' && findBeat(order,b)!==order.length-1))
      throw new Error('The voiceover and chosen pictures need a review. Your saved edit stays as it is.');
    restored.push('Kept the voiceover pictures in their spoken order.');
  }
  if (!restored.length) { record.keptBeats = beats; record.keptBeatOrigin = record.version; return []; }
  let offsetFrames = 0;
  const fps = record.assembly.template.fps;
  const cutList = order.flatMap((entry,piece) => groups(entry.record)[entry.piece].items.map(item => {
    const next = structuredClone(item); next.piece=piece; next.offsetFrames=offsetFrames;
    offsetFrames += next.durTimelineFrames; return next;
  }));
  const reel = structuredClone(record.assembly.reel);
  reel.cuts = order.map((entry,piece) => ({...entry.record.assembly.reel.cuts[entry.piece],offsetS:cutList.find(c=>c.piece===piece)!.offsetFrames/fps}));
  reel.model.voice = reel.cuts.map(c=>({id:c.id}));
  reel.broll = order.flatMap(entry => entry.record.assembly.reel.broll.filter(b=>b.voiceIndex===entry.piece).map(b=>({...structuredClone(b),voiceIndex:order.indexOf(entry)})));
  reel.model.broll = reel.broll.map(b=>({id:b.id,over:b.over}));
  record.assembly = {...record.assembly,cutList,reel};
  record.voice = reel.cuts.map(c=>c.id); record.broll = reel.broll.map(b=>({id:b.id,over:b.over}));
  record.pieceFx = order.map(e=>structuredClone(e.record.pieceFx?.[e.piece] ?? null));
  record.layouts = order.map(e=>structuredClone(e.record.layouts?.[e.piece] ?? null));
  record.jumpScales = order.map(e=>e.record.jumpScales?.[e.piece] ?? null);
  record.bleeps = order.flatMap((e,piece)=>(e.record.bleeps ?? []).filter(b=>b.piece===e.piece).map(b=>({...b,piece})));
  record.joins = order.slice(1).map((right,i) => right.record===order[i].record && right.piece===order[i].piece+1 ? structuredClone(right.record.joins?.[order[i].piece] ?? null) : null);
  const oldIndex = (piece:number) => order.findIndex(e=>e.record===previous && e.piece===piece);
  if (record.grade?.matchRef != null) record.grade={...record.grade,matchRef:oldIndex(record.grade.matchRef)>=0 ? oldIndex(record.grade.matchRef) : undefined};
  record.formats = previous.formats?.map(f=>({...f,pieceFraming:f.pieceFraming && order.map(e=>e.record.formats?.find(v=>v.aspect===f.aspect)?.pieceFraming?.[e.piece] ?? null)}));
  record.pieces = resolveReelPieces(record.assembly.shoot,record.assembly.template,cutList,reel);
  const before=planFx(previous.assembly.cutList,fps,previous), after=planFx(cutList,fps,record);
  const point=(t:number) => {
    const item=before.items.find(i=>t>=i.startS && t<i.endS) ?? before.items.at(-1);
    const piece=item ? oldIndex(item.piece) : -1;
    const next=after.items.find(i=>i.piece===piece);
    return item && next ? mapTime(next.timeMap,mapSource(item.timeMap,t)) : Math.min(t,after.durationS);
  };
  retimeMagneticItems(previous,record,{point,range:<T extends {s:number;e:number}>(r:T):T=>({...r,s:point(r.s),e:point(r.e)})});
  syncFxMetadata(record,after);
  record.preview=null; record.finished=null; record.previewRev=0;
  record.keptBeats=beats; record.keptBeatOrigin=record.version;
  // The final publication also reads the current sidecar; retain embedded lines
  // for callers which inspect the draft before saving.
  const script = record.voiceover;
  if (script) record.voiceover=retimeScript(script,versions.find(v=>v.version===script.version),record);
  record.warnings=[...record.warnings,...restored];
  return restored;
}
