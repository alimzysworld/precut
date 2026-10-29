import type { CutEdit, DraftTimeline } from '../shared/schema';
import type { StoredVersion } from './sidekick';
import { sourceRange, sourceLengths } from '../shared/source-windows';
import { sourcePlacement, sourceJoins, sourceDestination } from '../shared/source-placement';
import { planFx } from './edits-fx';
import { timelineMusic } from './music-timeline';
import { readShoot } from './ask-read';

/** Resolve the same local windows used by the source viewer. Never measures or calls a model. */
export async function sourceInsertRequest(root:string, record:StoredVersion, input:{at?:number;after?:number;atS?:number;source:{clipId?:string;s?:number;e?:number;take?:string};length?:string}) {
  const shoot=await readShoot(root), source=input.source;
  const match=source?.take && /^L([1-9]\d*)A([1-9]\d*)$/.exec(source.take);
  const attempt=match ? shoot.takes.find(t=>t.lineIndex===Number(match[1])-1)?.attempts[Number(match[2])-1] : undefined;
  const clip=shoot.clips.find(c=>c.id===(attempt?.clipId ?? source?.clipId));
  if(!clip || clip.leftOut || clip.missing || source?.take && (!attempt || attempt.practice))throw Error('Choose a usable source from this shoot.');
  const usable=sourceRange(clip,attempt ?? (source.s!==undefined && source.e!==undefined ? {s:source.s,e:source.e} : undefined));
  const fx=planFx(record.assembly.cutList,record.assembly.template.fps,record), grid=await timelineMusic(root,record,fx);
  const timeline:DraftTimeline={durationS:fx.durationS,width:record.assembly.template.width,height:record.assembly.template.height,pieces:fx.items.map(p=>({piece:p.piece,layer:0,clipId:record.pieces?.[p.piece]?.clipId ?? '',inS:p.timeMap[0].s,startS:p.startS,endS:p.endS,timeMap:p.timeMap,proxy:'',frame:null,lut:''})),musicGrid:grid,sound:null,look:null,titles:null};
  if([input.at,input.after,input.atS].filter(v=>v!==undefined).length!==1)throw Error('Choose exactly one of at, after or atS.');
  const count=record.pieces?.length ?? 0;
  if(input.after!==undefined && (!Number.isInteger(input.after) || input.after<0 || input.after>=count))throw Error('Choose a valid preceding piece.');
  if(input.atS!==undefined && (!Number.isFinite(input.atS) || input.atS<0 || input.atS>timeline.durationS))throw Error('Choose a time inside the edit.');
  const at=input.after!==undefined ? input.after+1 : input.atS!==undefined ? sourcePlacement(record,timeline,input.atS,shoot).at : input.at!;
  if(!Number.isInteger(at) || at<0 || at>count)throw Error('Choose a valid insertion index.');
  const placement={at,atS:sourceJoins(record,timeline)[at],aligned:false};
  const custom=input.length===undefined && source.s!==undefined && source.e!==undefined;
  if(custom && (![source.s,source.e].every(Number.isFinite) || source.s!<0 || source.e!<=source.s! || source.e!>(clip.meta?.durationS ?? 0)))throw Error('Choose a valid source span.');
  const length=(input.length ?? (custom ? 'custom' : 'best')).trim().toLowerCase().replace(/\s+/g,' ');
  const musical=/^\d+ (beat|bar)s?$/.test(length);
  if(musical && !grid?.beats.length)throw Error('No measured music here.');
  const choice=custom ? {id:'custom',range:{clipId:clip.id,s:source.s!,e:source.e!}} : sourceLengths(clip,usable,musical?grid:undefined,musical?placement.atS:undefined,shoot).find(c=>c.id===length || length==='best' && c.id==='best');
  if(!choice)throw Error('That length cannot fit inside this usable span without cutting a word.');
  const insert:CutEdit={kind:'insert',at:placement.at,source:choice.range};
  return {edit:insert,window:choice.range,at:placement.at,atS:placement.atS,length:choice.id,destination:sourceDestination(record,placement,shoot)};
}

/** Report the saved output clock, including speed and transition changes. */
export function insertedSourcePosition(record:StoredVersion, at:number) {
  const fx=planFx(record.assembly.cutList,record.assembly.template.fps,record);
  const atS=fx.items.find(p=>p.piece===at)?.startS ?? fx.durationS;
  return {atS,destination:sourceDestination(record,{at,atS,aligned:false},record.assembly.shoot)};
}
