import {displayedClip,clipRotationFilter,proxyRotation,quarterTurn} from '../shared/media';
import {Worker} from 'node:worker_threads';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {detectLevel,transformEdits,validTransform,straightenForFlips} from '../shared/clip-transform';
import type {CutEdit,ClipTransform,Clip} from '../shared/schema';
import {runActivity} from './activity';
import {tool} from './tools';
const exec=promisify(execFile);
export async function autoStraighten(root:string,clip:Clip,start:number,signal:AbortSignal){
 if(!clip.proxy||!clip.meta)throw new Error('The preview is not ready.');
 const notReady=(cause:unknown):never=>{throw new Error('The preview is not ready.',{cause});};
 const cache=await fs.realpath(path.join(root,'.sidething/proxies')).catch(notReady),file=await fs.realpath(path.resolve(cache,clip.proxy)).catch(notReady);
 if(!file.startsWith(cache+path.sep))throw new Error('Preview outside this shoot.');
 const shape=displayedClip(clip).meta!;if(![shape.width,shape.height].every(n=>Number.isFinite(n)&&n>0))throw new Error('The preview is not ready.');
 const factor=Math.min(320/shape.width,320/shape.height),w=Math.max(8,Math.round(shape.width*factor)),h=Math.max(8,Math.round(shape.height*factor));
 const orient=clipRotationFilter({...clip,meta:{...clip.meta,containerRotation:quarterTurn(proxyRotation(clip.proxy,clip.meta.rotation))}});
 // Measure one moment. Samples a second apart confuse camera movement with
 // uncertain line detection, even when the current horizon is unambiguous.
 const {stdout}=await exec(tool('ffmpeg'),['-v','error','-nostdin','-threads','1','-filter_threads','1','-ss',String(start),'-i',file,'-vf',`${orient}select='if(isnan(prev_selected_t),1,gte(t-prev_selected_t,0.08))',scale=${w}:${h},format=gray`,'-frames:v','3','-fps_mode','passthrough','-an','-threads','1','-f','rawvideo','-'],{signal,encoding:'buffer',maxBuffer:w*h*4}).catch(cause=>{signal.throwIfAborted();throw new Error("Couldn't read this preview. Try again.",{cause});});
 const angles=await new Promise<number[]>((resolve,reject)=>{
  const worker=new Worker(`const {parentPort}=require('node:worker_threads');const detect=${detectLevel.toString()};parentPort.on('message',({bytes,w,h})=>{try{const angles=[];for(let offset=0;offset+w*h<=bytes.length;offset+=w*h){const angle=detect(bytes.subarray(offset,offset+w*h),w,h);if(angle!==null)angles.push(angle);}parentPort.postMessage({angles});}catch(error){parentPort.postMessage({error:error.message});}});`,{eval:true});
  const abort=()=>{void worker.terminate();reject(signal.reason??new Error('Cancelled'));};
  const finish=()=>{signal.removeEventListener('abort',abort);void worker.terminate();};
  signal.addEventListener('abort',abort,{once:true});
  worker.once('message',value=>{finish();value.error?reject(new Error(value.error)):resolve(value.angles);});worker.once('error',error=>{finish();reject(error);});
  if(signal.aborted){abort();return;}worker.postMessage({bytes:stdout,w,h});
 });
 if(!angles.length)return null;angles.sort((a,b)=>a-b);const median=angles[Math.floor(angles.length/2)];return angles.some(a=>Math.abs(a-median)>.8)?null:median;
}
export async function editTransform(root:string,cutId:string,version:number,edit:Extract<CutEdit,{kind:'transform'}>){
 const {loadDraftVersion,editCut}=await import('./sidekick');
 if(edit.autoStraighten!==undefined&&typeof edit.autoStraighten!=='boolean')throw new Error('Choose a valid Auto setting.');
 if(!Array.isArray(edit.pieces)||edit.pieces.length>500)throw new Error('Choose clips in this edit.');
 if(edit.patch!==undefined&&edit.patch!==null&&!validTransform(edit.patch))throw new Error('Choose a valid transform.');
 const record=await loadDraftVersion(root,cutId,version),indexes=[...new Set(edit.pieces)];
 if(!indexes.length||indexes.some(i=>!Number.isInteger(i)||!record.pieces?.[i]))throw new Error('Choose clips in this edit.');
 if(!edit.autoStraighten){if(edit.patch===undefined)throw new Error('Choose a transform.');return editCut(root,cutId,version,transformEdits(record,indexes,edit.patch));}
 return runActivity({kind:'render',root,target:{cutId},label:'Finding a level line',cancelable:true},async activity=>{
  const edits:CutEdit[]=[],found:number[]=[];
  for(const piece of indexes){const p=record.pieces![piece],clip=record.assembly.shoot.clips.find(c=>c.id===p.clipId);if(!clip)throw new Error('The clip is missing.');const measured=await autoStraighten(root,clip,p.s,activity.signal);if(measured===null)return {edits:[],found:[],clear:false};const angle=straightenForFlips(measured,{...record.pieceFx?.[piece]?.transform,...edit.patch});found.push(angle);const patch:ClipTransform={...edit.patch,rotate:angle};const batch=transformEdits(record,[piece],patch);if(batch.kind==='batch')edits.push(...batch.edits);}
  // Release the render lane before saving; the ordinary version transaction owns Undo.
  return {edits,found,clear:true};
 },{renderLane:'background'}).then(({edits,found,clear})=>clear?editCut(root,cutId,version,{kind:'batch',label:indexes.length===1?`Levelled ${found[0].toFixed(1)}°`:`Levelled ${indexes.length} clips`,edits}):{cutId,version,unchanged:true,transformNote:'No clear horizon'});
}
