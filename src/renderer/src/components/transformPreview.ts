import type {ClipTransform,DraftPiece,DraftTimeline,CutEdit,CutVersion} from '../../../shared/schema';
import {transformEdits} from '../../../shared/clip-transform';
type Session={pieces:number[];version:CutVersion;busy:boolean;level:boolean;edit:(edit:CutEdit)=>unknown};
const sessions=new WeakMap<DraftTimeline,Session>(),retained=new Map<string,{timeline:DraftTimeline;session:Session}>(),previews=new Map<string,ClipTransform>();
const key=(p:DraftPiece)=>JSON.stringify([p.proxy,p.piece,p.startS,p.endS,p.transform]);
const timelineKey=(t:DraftTimeline)=>JSON.stringify([t.width,t.height,t.durationS,t.pieces.map(key)]);
export const transformSessions={set(t:DraftTimeline,s:Session){sessions.set(t,s);retained.set(timelineKey(t),{timeline:t,session:s});},get(t:DraftTimeline){return sessions.get(t)??retained.get(timelineKey(t))?.session;},delete(t:DraftTimeline){sessions.delete(t);const k=timelineKey(t);if(retained.get(k)?.timeline===t)retained.delete(k);}};
export function previewTransform(t:DraftTimeline,pieces:number[],patch:ClipTransform|null){
  for(const p of t.pieces)if(pieces.includes(p.piece??-1)){if(patch)previews.set(key(p),{...p.transform,...patch,crop:{...p.transform?.crop,...patch.crop}});else previews.delete(key(p));}
  document.querySelectorAll('[data-live-player]').forEach(v=>v.dispatchEvent(new Event('precut:layout-preview')));
}
export const visualTransform=(p:DraftPiece)=>previews.get(key(p))??p.transform;
export async function saveTransform(t:DraftTimeline,patch:ClipTransform|null){const s=transformSessions.get(t);if(!s||s.busy)return;const result=await s.edit(transformEdits(s.version,s.pieces,patch));if(result===false||result===undefined){previewTransform(t,s.pieces,null);return false;}return true;}
export function announceTransform(){document.dispatchEvent(new Event('precut:layout-session'));}
