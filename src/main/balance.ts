import { mapSource, planFx } from "./edits-fx";
// V27. Cached stills only. Model work never owns an edit transaction.
import * as fs from 'node:fs/promises';
import * as sync from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as electron from 'electron';
import { spawn } from 'node:child_process';
import { balanceWork } from './balance-work';
const images=()=>Reflect.get(electron,'nativeImage') as typeof electron.nativeImage;
import type { BalanceOptions, BalanceStatus, BasicAdjust, Clip, ClipBalance, CutVersion } from '../shared/schema';
import { normalizeBasic } from './basics';
import { balanceSheetBitmap } from './balance-sheet';
import { focusSample, intentPrompt, parseIntent, type BalanceFrame, type BalanceIntent, type RGB, type SolveFrame } from './balance-core';
import { gradeForLook, gradeForPiece } from '../shared/grade-math';
import { runModel } from './ai';
import { getEngine, getPreferences } from './settings';
import { runActivity, threads } from './activity';
import { tool } from './tools';
import { saveLook, waitForLiveSaves } from './look-saves';
import { detachedEditWork, changed, finishStoredVersion, loadDraftVersion, type StoredVersion } from './sidekick';
import { commitPinned, currentVersion, markMilestone, pinRevision, type RevisionPin } from './revisions';
const isRevisionConflict=(error:unknown)=>(error as {code?:string}|null)?.code==='REVISION_CONFLICT';
import { applyNeutralBase, cameraConversionFilter, exposureRegion, exposureSpans, pieceColour, readGradeMetadata, type ExposureSpan, type PieceCorrection } from './grade';
const key=(root:string,id:string)=>JSON.stringify([path.resolve(root),id]);
const clipCount=(n:number)=>`${n} ${n===1 ? "clip" : "clips"}`;
const file=(root:string)=>path.join(root,'.sidething','balances.json');
// V67: rows from the older model-only matcher (no solver revision) are recomputed, never reused. V68 (2): metered on the subject.
const SOLVER_REVISION=2;
type CachedBalance = ClipBalance & { referenceKey?: string; reason?: string; solver?: number; intent?: {basic:BasicAdjust;source:string;referenceKey?:string;reason?:string;solver?:number} };
type Cache = Record<string, CachedBalance>;
const revisions=new Map<string,number>();
const claimed=new Set<string>();
const handWrites=new Map<string,Promise<void>>();
const states=new Map<string,BalanceStatus>();
const etaTimes=new Map<string,number>();
const jobs=new Map<string,Promise<unknown>>();
const rootJobs=new Map<string,Promise<unknown>>();
const proposals=new Map<string,Cache>();
async function cache(root:string):Promise<Cache> { try{return JSON.parse(await fs.readFile(file(root),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {};throw e;} }
async function write(root:string,patch:Cache,expected?:Map<string,number>) {
  // Synchronous merge/rename after the await avoids clobbering another clip's hand marker.
  const name=file(root);sync.mkdirSync(path.dirname(name),{recursive:true});
  let old:Cache={};try{old=JSON.parse(sync.readFileSync(name,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(expected)for(const id of Object.keys(patch))if((revisions.get(key(root,id)) ?? 0)!==expected.get(id))delete patch[id];
  const temp=`${name}.${randomUUID()}.tmp`;sync.writeFileSync(temp,JSON.stringify({...old,...patch}));sync.renameSync(temp,name);
  for(const [id,row] of Object.entries(patch))if(row.owner==='auto')claimed.delete(key(root,id));
}
export async function sourceFingerprint(root:string,clip:Clip) {
  const stat=await fs.stat(path.resolve(root,clip.file));
  return createHash('sha256').update(JSON.stringify([clip.id,clip.file,stat.size,stat.mtimeMs,stat.ctimeMs,clip.byHand?.rotate,clip.judgement?.rotate,clip.meta?.pictureProfile])).digest('hex');
}
export function balanceHand(root:string,clipId:string):Promise<void> {
  const k=key(root,clipId),already=claimed.has(k);claimed.add(k);revisions.set(k,(revisions.get(k) ?? 0)+1);
  for(const [edit,rows] of proposals) if(edit.startsWith(JSON.stringify([path.resolve(root)]).slice(0,-1)+',')) delete rows[clipId];
  // Every input invalidates a reply; repeated input shares the first durable claim.
  if(already)return handWrites.get(k) ?? Promise.resolve();
  const work=(async()=>{
    const previous=(await cache(root))[clipId];
    await write(root,{[clipId]:{basic:previous?.basic ?? normalizeBasic(),source:previous?.source ?? '',owner:'hand',intent:previous?.intent ?? (previous?.owner==='auto' ? {basic:previous.basic,source:previous.source,referenceKey:previous.referenceKey,reason:previous.reason,solver:previous.solver} : undefined),updatedAt:new Date().toISOString()}});
  })();
  handWrites.set(k,work);void work.finally(()=>{if(handWrites.get(k)===work)handWrites.delete(k);}).catch(()=>{});return work;
}

/** Called inside the normal clip-look transaction. Basics are stored once per source. */
export async function saveHandBalance(root:string,record:StoredVersion,piece:number,basic:Partial<BasicAdjust>|undefined) {
  const clip=record.assembly.cutList.find((c,i)=>(c.piece ?? i)===piece)?.seg?.clip;
  if(!clip)return;
  await balanceHand(root,clip.id).catch(()=>{});
  const balance:ClipBalance={basic:normalizeBasic(basic ?? record.balances?.[clip.id]?.basic),source:await sourceFingerprint(root,clip).catch(()=>record.balances?.[clip.id]?.source ?? ''),owner:'hand',updatedAt:new Date().toISOString()};
  record.balances={...record.balances,[clip.id]:balance};
  try{const previous=(await cache(root))[clip.id];await write(root,{[clip.id]:{...balance,intent:previous?.intent}});}catch{/* The cut transaction remains the durable owner when its optional cache is unavailable. */}
}
function clipsOf(record:StoredVersion) {
  const assembly=record.assembly,fps=assembly.template.fps;
  const spans=exposureSpans(assembly.cutList,assembly.reel.broll,fps);
  if(record.angleCuts?.length || record.layouts?.some(l=>l?.screen)) {
    const timing=planFx(assembly.cutList,fps,record);
    for(const [i,change] of (record.angleCuts ?? []).entries()) {
      const until=record.angleCuts?.[i+1]?.atS ?? timing.durationS;
      for(const [j,item] of timing.items.entries()) {
        const s=Math.max(change.atS,item.startS),e=Math.min(until,item.endS),base=assembly.cutList[j].seg?.clip;
        const group=assembly.shoot.angles?.find(g=>g.clips.some(c=>c.clipId===base?.id) && g.clips.some(c=>c.clipId===change.clipId));
        if(e<=s || !base || !group)continue;
        const delta=group.clips.find(c=>c.clipId===base.id)!.offsetS-group.clips.find(c=>c.clipId===change.clipId)!.offsetS;
        spans.push({clipId:change.clipId,s:mapSource(item.timeMap,s)+delta,e:mapSource(item.timeMap,e)+delta});
      }
    }
    for(const [piece,layout] of (record.layouts ?? []).entries())if(layout?.screen) {
      const items=timing.items.filter(c=>c.piece===piece),length=items.reduce((n,c)=>n+c.endS-c.startS,0);
      if(length>0)spans.push({clipId:layout.screen.clipId,s:layout.screen.s,e:layout.screen.s+length});
    }
  }
  return [...new Set(spans.map(s=>s.clipId))].map(id=>{
    const clip=assembly.shoot.clips.find(c=>c.id===id),used=spans.filter(s=>s.clipId===id && s.e>s.s).sort((a,b)=>(b.e-b.s)-(a.e-a.s));
    // When a source appears twice, sample the middle of its longest used span, never a gap between uses.
    const end=clip?.meta?.durationS ?? Infinity;
    return clip && used[0] ? {clip,mid:Math.max(0,Math.min(end,(used[0].s+used[0].e)/2)),s:Math.max(0,Math.min(end,used[0].s)),e:Math.max(0,Math.min(end,used[0].e))}:null;
  }).filter((c):c is NonNullable<typeof c>=>!!c);
}

async function frameFor(root:string,clip:Clip,mid:number):Promise<Pick<BalanceFrame,"pixels"|"displayPixels"|"aspect">> {
  // V1 names cached frames with their source time. Fall back to a thumbnail, never decode.
  const candidates=(clip.frames ?? []).map((name,i)=>({name,t:Number(path.basename(name).match(/_t([\d.]+)\.(?:jpg|png)$/)?.[1] ?? (i+.5)/Math.max(1,clip.frames.length)*(clip.meta?.durationS ?? 0))})).sort((a,b)=>Math.abs(a.t-mid)-Math.abs(b.t-mid));
  for(const name of [...candidates.map(c=>c.name),`${clip.id}.jpg`].filter((f):f is string=>!!f)) {
    const paths=[path.resolve(root,'.sidething',name),path.resolve(root,'.sidething/frames',path.basename(name)),path.resolve(root,'.sidething/thumbs',path.basename(name))];
    for(const picture of paths) {
      if(!picture.startsWith(path.resolve(root,'.sidething')+path.sep))continue;
      try{await fs.access(picture);}catch{continue;}
      const image=images().createFromPath(picture);if(image.isEmpty())continue;
      const read=(width:number,height:number)=>{const b=image.resize({width,height,quality:'good'}).toBitmap();return Array.from({length:width*height},(_,i)=>[b[i*4+2]/255,b[i*4+1]/255,b[i*4]/255] as RGB);};
      const size=image.getSize();return {pixels:read(64,36),displayPixels:read(192,108),aspect:size.width/size.height};
    }
  }
  throw Error('Auto correct needs the saved clip pictures. Reconnect the footage and try again.');
}
async function sheet(root:string,frames:Pick<BalanceFrame,'id'|'aspect'>[],rendered:RGB[][]):Promise<string> {
  const {bitmap,width,height}=balanceSheetBitmap(frames,rendered);
  const dir=path.join(root,'.sidething/balance');await fs.mkdir(dir,{recursive:true});
  const name=path.join(dir,`${randomUUID()}.png`);await fs.writeFile(name,images().createFromBitmap(bitmap,{width,height}).toPNG());return name;
}
// V67: measure from the camera original, 16-bit after camera conversion, exactly as the export grades it.
// V68: decoded at four times the sample size so sharpness can be read; the sample is each block's mean.
const SAMPLE_W=128,SAMPLE_H=72,FOCUS=4,DECODE_W=SAMPLE_W*FOCUS,DECODE_H=SAMPLE_H*FOCUS,SAMPLE_BYTES=DECODE_W*DECODE_H*6;
type Measured={data:Float32Array;face?:Uint8Array;focus?:Float32Array;peak?:Float32Array;exposure?:PieceCorrection;precision:'source'|'still'};
function decodeSample(file:string,conversion:string,t:number,signal:AbortSignal):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    // The keyframe at or before t: one intra decode instead of a whole long-GOP run.
    const child=spawn(tool('ffmpeg'),['-hide_banner','-nostdin','-loglevel','error','-threads',String(threads(2)),'-skip_frame','nokey','-noaccurate_seek','-ss',String(Math.max(0,t)),'-i',file,'-an','-vf',`${conversion},scale=${DECODE_W}:${DECODE_H}:flags=area,format=rgb48le`,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb48le','pipe:1'],{stdio:['ignore','pipe','pipe']});
    const abort=()=>child.kill('SIGKILL'),timer=setTimeout(abort,30_000),chunks:Buffer[]=[];let bytes=0,stderr='';
    signal.addEventListener('abort',abort,{once:true});
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
    child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>SAMPLE_BYTES)child.kill('SIGKILL');else chunks.push(chunk);});
    child.stderr.on('data',(chunk:Buffer)=>{stderr=(stderr+chunk.toString()).slice(-2000);});
    child.once('error',error=>{done();reject(error);});
    child.once('close',code=>{done();if(signal.aborted)reject(signal.reason);else if(code!==0 || bytes!==SAMPLE_BYTES)reject(new Error(stderr || 'Incomplete sample'));else resolve(Buffer.concat(chunks));});
  });
}
async function measureSource(root:string,item:{clip:Clip;mid:number;s:number;e:number},neighbours:ExposureSpan[],signal:AbortSignal):Promise<Measured> {
  const {clip}=item,cacheDir=path.join(root,'.sidething','finish-cache'),colourClip=structuredClone(clip);
  try {
    if(clip.missing)throw Error('Original missing');
    const file=path.resolve(root,clip.file),stat=await fs.stat(file);
    await fs.mkdir(cacheDir,{recursive:true});
    await readGradeMetadata(colourClip,root,cacheDir);
    const conversion=await cameraConversionFilter(colourClip,cacheDir);
    // The setup base and piece exposure the export applies below Basic. A neighbour that cannot be
    // measured must not stop this source being measured from its own original.
    const {base,exposure}=await pieceColour(colourClip,cacheDir,{root,s:item.s,e:Math.max(item.e,item.s+.04),neighbours},false).catch(error=>{if(signal.aborted)throw error;return {base:null,exposure:undefined};});
    const count=Math.max(1,Math.min(3,Math.round((item.e-item.s)/1.5)));
    const times=Array.from({length:count},(_,i)=>item.s+(item.e-item.s)*(i+.5)/count);
    const key=createHash('sha256').update(JSON.stringify([SOLVER_REVISION,file,stat.size,stat.mtimeMs,conversion,times,DECODE_W,DECODE_H])).digest('hex');
    const cached=path.join(cacheDir,`balance-sample-${key}.bin`);
    let raw:Buffer|undefined;
    try{const value=await fs.readFile(cached);if(value.length===times.length*SAMPLE_BYTES)raw=value;}catch{/* measured below */}
    if(!raw){
      const frames:Buffer[]=[];for(const t of times)frames.push(await decodeSample(file,conversion,t,signal));
      raw=Buffer.concat(frames);const temp=`${cached}.${randomUUID()}.tmp`;await fs.writeFile(temp,raw);await fs.rename(temp,cached);
    }
    const cells=SAMPLE_W*SAMPLE_H,pixels=cells*times.length,data=new Float32Array(pixels*3),peak=new Float32Array(pixels*3),focus=new Float32Array(pixels),face=new Uint8Array(pixels);
    for(let f=0;f<times.length;f++){
      const decoded=new Float32Array(DECODE_W*DECODE_H*3);
      for(let j=0;j<DECODE_W*DECODE_H*3;j++)decoded[j]=raw.readUInt16LE(f*SAMPLE_BYTES+j*2)/65535;
      // Area scale first, then the setup base on each cell, exactly as the 128 x 72 sample was measured before.
      const sample=focusSample(decoded,DECODE_W,DECODE_H,FOCUS);focus.set(sample.focus,f*cells);
      for(let c=0;c<cells;c++){let rgb:RGB=[sample.data[c*3],sample.data[c*3+1],sample.data[c*3+2]],top:RGB=[sample.peak[c*3],sample.peak[c*3+1],sample.peak[c*3+2]];if(base){rgb=applyNeutralBase(rgb,base);top=applyNeutralBase(top,base);}data.set(rgb,(f*cells+c)*3);peak.set(top,(f*cells+c)*3);}
    }
    const boxes=times.map(t=>exposureRegion(colourClip,t));
    for(let i=0;i<pixels;i++){
      const box=boxes[Math.floor(i/(SAMPLE_W*SAMPLE_H))],x=(i%SAMPLE_W+.5)/SAMPLE_W,y=(Math.floor(i/SAMPLE_W)%SAMPLE_H+.5)/SAMPLE_H;
      if(box.kind==='face' && x>=box.x && x<box.x+box.w && y>=box.y && y<box.y+box.h)face[i]=1;
    }
    return {data,focus,peak,exposure,precision:'source',...(face.some(Boolean) ? {face} : {})};
  } catch(error) {
    if(signal.aborted)throw signal.reason;
    // Original unavailable or undecodable: the cached still is the honest fallback.
    const still=await frameFor(root,clip,item.mid);
    return {data:Float32Array.from((still.displayPixels ?? still.pixels).flat()),precision:'still'};
  }
}
async function pool<T,R>(items:T[],size:number,work:(item:T)=>Promise<R>):Promise<R[]> {
  const out:R[]=new Array(items.length);let next=0;
  await Promise.all(Array.from({length:Math.max(1,Math.min(size,items.length))},async()=>{while(next<items.length){const i=next++;out[i]=await work(items[i]);}}));
  return out;
}
const intentFile=(root:string)=>path.join(root,'.sidething','balance-intent.json');
type IntentCache=Record<string,BalanceIntent & {source:string}>;
async function readIntents(root:string):Promise<IntentCache>{try{return JSON.parse(await fs.readFile(intentFile(root),'utf8'));}catch{return {};}}
async function writeIntents(root:string,patch:IntentCache){
  const old=await readIntents(root),temp=`${intentFile(root)}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(temp),{recursive:true});await fs.writeFile(temp,JSON.stringify({...old,...patch}));await fs.rename(temp,intentFile(root));
}
export async function balanceStatus(root:string,cutId:string,version:number):Promise<BalanceStatus> {
  const record=await loadDraftVersion(root,cutId,version),ids=clipsOf(record).map(c=>c.clip.id),stored=await cache(root).catch(()=>({} as Cache)),k=key(root,cutId);
  const ready=ids.filter(id=>proposals.get(k)?.[id] && stored[id]?.owner!=='hand' && !stored[id]?.protected && !record.balances?.[id]);
  const current=states.get(k),remaining=current?.etaS==null ? null : Math.max(0,current.etaS-(performance.now()-(etaTimes.get(k) ?? performance.now()))/1000);
  return {...(current ?? {state:'idle'}),etaS:remaining,ready,corrected:ids.filter(id=>record.balances?.[id]?.owner==='auto').length,hand:ids.filter(id=>record.balances?.[id]?.owner==='hand' || record.balances?.[id]?.protected || stored[id]?.owner==='hand' || stored[id]?.protected || record.pieces?.some((p,i)=>p.clipId===id && !!record.pieceFx?.[i]?.look)).length};
}
type BalanceSave={cutId:string;version:number;baseVersion?:number;count?:number};
// VO7-2: Auto correct computes against a pinned revision and commits with expected = that revision.
// A result computed before an undo or redo never publishes; the job reports it in plain words.
const CONFLICT="Your edit changed while Auto correct was working. Run it again.";
async function apply(root:string,cutId:string,version:number,rows:Cache,expected:Map<string,number>,reference:string|undefined,pin:RevisionPin|null):Promise<BalanceSave> {
  if(!Object.keys(rows).length)return {cutId,version};
  // An edit with no history (none yet readable) keeps today's path on the version it was given.
  const commit=(work:(base:number)=>Promise<BalanceSave>)=>pin ? commitPinned(root,cutId,pin,{onCurrent:true},work) : work(version);
  return commit(async version=>{
  const original=await loadDraftVersion(root,cutId,version);
  if((reference===undefined || original.balanceReference===reference) && original.grade?.matchClips===false && Object.entries(rows).every(([id,b])=>{const old=original.balances?.[id];return JSON.stringify(old?.basic)===JSON.stringify(b.basic) && old?.owner===b.owner && !!old?.protected===!!b.protected;}))return {cutId,version};
  return saveLook(root,cutId,version,base=>finishStoredVersion(root,cutId,base,true,async(record,assembly,baseVersion)=>{
    record.assembly=assembly;
    const used=new Set(clipsOf(record).map(c=>c.clip.id)),accepted:Cache={};
    for(const [id,balance] of Object.entries(rows)) {
      const clip=assembly.shoot.clips.find(c=>c.id===id);
      if(used.has(id) && clip && (revisions.get(key(root,id)) ?? 0)===(expected.get(id) ?? 0) && await sourceFingerprint(root,clip)===balance.source) accepted[id]=balance;
    }
    for(const id of Object.keys(accepted))if((revisions.get(key(root,id)) ?? 0)!==expected.get(id))delete accepted[id];
    if(!Object.keys(accepted).length)throw Object.assign(new Error("No Auto correct changes"),{balanceNoChange:true,version:baseVersion});
    // Before it applies, the state before Auto correct becomes a version (a before-auto milestone).
    await markMilestone(root,cutId,baseVersion,{kind:'before-auto',name:'Before Auto correct'}).catch(error=>console.warn('[revisions]',error));
    // balanceUndo is only the renderer's hint for its Undo link (stage 3 moves that to ⌘Z). Main never
    // reopens it: Auto correct is one ordinary step on the undo path, and undo removes it.
    record.balances={...record.balances,...accepted};record.balanceReference=reference ?? record.balanceReference;
    record.balanceUndo=baseVersion;record.grade={...(record.grade ?? gradeForLook('rec709',{preset:'clean',words:null})),matchClips:false};
    record.feedback=`Auto correct ${clipCount(Object.keys(accepted).length)}`;
    // Source-owned basics replace old occurrence overrides only for accepted clips.
    record.pieceFx=record.pieceFx?.map((fx,i)=>{if(!accepted[record.pieces?.[i]?.clipId ?? ''] || !fx?.look?.basic)return fx;const look={...fx.look};delete look.basic;return {...fx,look:Object.keys(look).length?look:null};});
    return {cutId,version:record.version,baseVersion,count:Object.keys(accepted).length};
  },true)).catch(error=>{if(error.balanceNoChange)return {cutId,version:error.version as number};throw error;});
  }).catch(error=>{if(isRevisionConflict(error))throw Object.assign(new Error(CONFLICT),{revisionConflict:true});throw error;});
}
/** The revision a request computes against, pinned when it is asked for (before it queues). */
const pinFor=(root:string,cutId:string,version?:number)=>Promise.resolve().then(()=>pinRevision(root,cutId,version)).catch(()=>null);
export function balanceClips(root:string,cutId:string,version:number,options:BalanceOptions={}):Promise<{cutId:string;version:number;baseVersion?:number}> {
  // Preparing offers looks at the current revision; an explicit request pins the version it names.
  const pin=pinFor(root,cutId,options.prepareOnly ? undefined : version);
  return requestBalance(root,cutId,version,options,new Map(revisions),pin);
}
function requestBalance(root:string,cutId:string,version:number,options:BalanceOptions,requested:Map<string,number>,pin:Promise<RevisionPin|null>):Promise<BalanceSave> {
  if(options.pieces!==undefined && options.piece!==undefined)return Promise.reject(new Error('Choose a clip or a list of clips.'));
  if(options.pieces!==undefined && (!Array.isArray(options.pieces) || !options.pieces.length || options.pieces.length>500 || options.pieces.some(p=>!Number.isInteger(p) || p<0)))return Promise.reject(new Error('Choose clips in this edit.'));
  if(options.replaceHand!==undefined && typeof options.replaceHand!=='boolean' || options.prepareOnly!==undefined && typeof options.prepareOnly!=='boolean' || options.readyOnly!==undefined && typeof options.readyOnly!=='boolean')return Promise.reject(new Error('Choose a valid Auto correct option.'));
  root=path.resolve(root);const k=key(root,cutId);
  if(options.readyOnly)return acceptReady(root,cutId,version,options,pin).catch(error=>{const message=balanceError(error);states.set(k,{state:'error',ready:[],corrected:0,hand:0,message});throw new Error(message);});
  // Preparation calls coalesce; explicit acceptance waits for any computation then applies it.
  const running=jobs.get(k);
  if(running) return running.then(()=>requestBalance(root,cutId,version,options,requested,pin));
  const previous=rootJobs.get(root) ?? Promise.resolve();
  const work=previous.catch(()=>{}).then(()=>correct(root,cutId,version,options,requested,pin)).catch(error=>{
    const message=balanceError(error);states.set(k,{state:'error',ready:[],corrected:0,hand:0,message});throw new Error(message);
  });jobs.set(k,work);rootJobs.set(root,work);
  void work.finally(()=>{if(jobs.get(k)===work)jobs.delete(k);if(rootJobs.get(root)===work)rootJobs.delete(root);}).catch(()=>{});return work;
}
async function correct(root:string,cutId:string,version:number,options:BalanceOptions,requested:Map<string,number>,pinned:Promise<RevisionPin|null>) {
  const pin=await pinned;
  // VO7-2: offers are prepared on the current revision (the pin's), not the newest snapshot.
  if(options.prepareOnly)version=pin?.version ?? await currentVersion(root,cutId).catch(()=>version);
  const k=key(root,cutId),record=await loadDraftVersion(root,cutId,version),all=clipsOf(record),stored=await cache(root),prefs=await getPreferences();
  const selected=options.piece===undefined ? null : record.pieces?.[options.piece]?.clipId ?? record.assembly.cutList.find((c,i)=>(c.piece ?? i)===options.piece)?.seg?.clip.id;
  const selectedIds=options.pieces?.map(p=>record.pieces?.[p]?.clipId);
  if(selectedIds?.some(id=>!id))throw Error('Choose clips in this edit.');
  const reference=options.reference===undefined ? undefined : record.pieces?.[options.reference]?.clipId ?? record.assembly.cutList.find((c,i)=>(c.piece ?? i)===options.reference)?.seg?.clip.id;
  if(options.piece!==undefined && !selected || options.reference!==undefined && !reference)throw Error('Choose a clip in this edit.');
  const referenceClip=all.find(c=>c.clip.id===reference)?.clip;
  const {matchClips:_matching,matchRef:_reference,...referenceGrade}=record.grade ?? {};
  const referenceKey=referenceClip ? JSON.stringify([reference,await sourceFingerprint(root,referenceClip),record.balances?.[reference!]?.basic,referenceGrade]) : undefined;
  const sources=new Map<string,string>();
  const rows:Cache={},expected=new Map<string,number>(),missing:typeof all=[];
  const legacyHand=new Set(record.pieces?.filter((_,i)=>record.pieceFx?.[i]?.look && Object.keys(record.pieceFx[i]!.look!).length).map(p=>p.clipId));
  for(const item of all) {
    const id=item.clip.id;if(selectedIds && !selectedIds.includes(id) || selected && selected!==id || reference===id || options.prepareOnly && record.balances?.[id])continue;
    expected.set(id,requested.get(key(root,id)) ?? 0);
    if((revisions.get(key(root,id)) ?? 0)!==expected.get(id))continue;
    if((claimed.has(key(root,id)) || stored[id]?.owner==='hand' || stored[id]?.protected || record.balances?.[id]?.owner==='hand' || record.balances?.[id]?.protected || legacyHand.has(id)) && !options.replaceHand && !selected && !selectedIds)continue;
    if((claimed.has(key(root,id)) || stored[id]?.owner==='hand' || stored[id]?.protected || legacyHand.has(id)) && options.prepareOnly)continue;
    const source=await sourceFingerprint(root,item.clip);
    sources.set(id,source);
    if(stored[id]?.intent?.source===source && stored[id].intent!.solver===SOLVER_REVISION && (!reference || stored[id].intent!.referenceKey===referenceKey))rows[id]={...stored[id],basic:stored[id].intent!.basic,reason:stored[id].intent!.reason,solver:SOLVER_REVISION,source,referenceKey:stored[id].intent!.referenceKey,owner:'auto'};
    else if(stored[id]?.source===source && stored[id]?.owner==='auto' && stored[id]?.solver===SOLVER_REVISION && (!reference || stored[id].referenceKey===referenceKey))rows[id]=stored[id];else missing.push(item);
  }
  let pace:number|null=null;try{const p=JSON.parse(await fs.readFile(path.join(root,'.sidething/balance-pace.json'),'utf8'));if(Number.isFinite(p.secondsPerClip)&&p.secondsPerClip>0)pace=p.secondsPerClip;}catch{}
  const started=performance.now();etaTimes.set(k,started);
  // Scene matching needs the other clips of each corrected clip's scene, and the reference.
  const scenesOf=new Set(missing.map(c=>c.clip.judgement?.scene).filter(Boolean));
  const context=all.filter(c=>missing.includes(c) || c.clip.id===reference || !!c.clip.judgement?.scene && scenesOf.has(c.clip.judgement.scene));
  const firstEta=pace===null?null:pace*context.length;
  states.set(k,{etaS:firstEta,state:missing.length?'working':'idle',ready:[],corrected:0,hand:0,message:missing.length ? options.prepareOnly ? 'Preparing Auto correct' : `Correcting ${clipCount(missing.length)}` : undefined});
  try {
    if(missing.length) {
      await runActivity({kind:'looks',root,target:{cutId,version},label:options.prepareOnly ? "Preparing Auto correct" : `Correcting ${clipCount(missing.length)}`,cancelable:true},async activity=>{
        activity.progress(null,undefined,firstEta);
        const editGrade=record.grade ?? gradeForLook('rec709',prefs.look);
        const lookOf=(id:string)=>{const owner=reference===id && options.reference!==undefined ? options.reference : record.pieces?.findIndex(p=>p.clipId===id) ?? -1;return owner>=0 ? record.pieceFx?.[owner]?.look : undefined;};
        const gradeOf=(id:string)=>{const look=lookOf(id);return gradeForPiece(editGrade,look ? {...look,basic:undefined} : null);};
        const basicOf=(id:string)=>record.balances?.[id]?.basic ?? normalizeBasic(lookOf(id)?.basic);
        const neighbours=exposureSpans(record.assembly.cutList,record.assembly.reel.broll,record.assembly.template.fps);
        // 1. Measure from the camera originals, in 16-bit, exactly what the export grades.
        let measuredCount=0;
        const measured=await pool(context,Math.max(1,Math.min(6,threads(6))),async item=>{
          activity.signal.throwIfAborted();const value=await measureSource(root,item,neighbours,activity.signal);measuredCount++;
          const etaS=(performance.now()-started)/1000/measuredCount*(context.length-measuredCount);
          etaTimes.set(k,performance.now());states.set(k,{...states.get(k)!,etaS});activity.progress(measuredCount/context.length*85,undefined,etaS);return value;
        });
        // 2. One cached look at the light per source: night stays night, a warm lamp stays warm.
        const intents=await readIntents(root);
        const active=missing.filter(c=>(revisions.get(key(root,c.clip.id)) ?? 0)===expected.get(c.clip.id));
        // V68: an answer from before the subject was named is asked once more.
        const unjudged=active.filter(c=>intents[c.clip.id]?.source!==sources.get(c.clip.id) || intents[c.clip.id]?.subject===undefined);
        if(unjudged.length && prefs.aiSeesFrames) for(let start=0;start<unjudged.length;start+=24) {
          activity.signal.throwIfAborted();
          const batch=unjudged.slice(start,start+24),pictures:string[]=[];
          try {
            const stills:BalanceFrame[]=[];
            for(const c of batch)stills.push({id:c.clip.id,...await frameFor(root,c.clip,c.mid),grade:gradeOf(c.clip.id),basic:basicOf(c.clip.id)});
            const view=await balanceWork({kind:"view",frames:stills});
            pictures.push(await sheet(root,view.sheetFrames,view.pixels));
            const allowed=new Set(batch.map(c=>c.clip.id));
            const reply=await runModel({engine:await getEngine(),cwd:root,prompt:intentPrompt(stills,allowed),images:pictures,signal:activity.signal});
            const patch:IntentCache={};
            for(const [id,intent] of Object.entries(parseIntent(reply,allowed)))intents[id]=patch[id]={...intent,source:sources.get(id)!};
            if(Object.keys(patch).length)await writeIntents(root,patch);
          } catch(error) {
            // Not signed in, no stills or an unreadable answer: the measured defaults still grade every clip.
            if(activity.signal.aborted)throw error;
          } finally {await Promise.all(pictures.map(picture=>fs.rm(picture,{force:true})));}
        }
        // 3. Grade each source on its own, then match scenes, off the main thread.
        const solving=new Set(active.map(c=>c.clip.id));
        const frames:SolveFrame[]=context.map((item,i)=>{
          const id=item.clip.id,hand=!solving.has(id) && (claimed.has(key(root,id)) || stored[id]?.owner==='hand' || record.balances?.[id]?.owner==='hand' || legacyHand.has(id));
          return {id,data:measured[i].data,face:measured[i].face,focus:measured[i].focus,peak:measured[i].peak,exposure:measured[i].exposure,grade:gradeOf(id),basic:basicOf(id),group:item.clip.judgement?.scene ?? undefined,intent:intents[id],
            ...(reference===id ? {fixed:'reference' as const} : hand ? {fixed:'hand' as const} : {})};
        });
        const solved=await balanceWork({kind:"solve",frames,reference,only:[...solving]});
        for(const {clip} of active)if((revisions.get(key(root,clip.id)) ?? 0)===expected.get(clip.id) && await sourceFingerprint(root,clip)===sources.get(clip.id)) {
          const answer=solved[clip.id],still=measured[context.findIndex(c=>c.clip.id===clip.id)]?.precision==='still';
          rows[clip.id]={basic:answer?.basic ?? normalizeBasic(),reason:`${answer?.reason ?? 'Already looks right'}${still ? ' Measured from the saved picture.' : ''}`,solver:SOLVER_REVISION,source:sources.get(clip.id)!,referenceKey,owner:'auto',updatedAt:new Date().toISOString()};
        }
        activity.progress(100,undefined,0);
      },{renderLane:'background',deferRenderSlot:true});
      await fs.writeFile(path.join(root,'.sidething/balance-pace.json'),JSON.stringify({secondsPerClip:(performance.now()-started)/1000/Math.max(1,context.length)}));
    }
    for(const [id,value] of Object.entries(rows))if((revisions.get(key(root,id)) ?? 0)!==expected.get(id))delete rows[id];
    if(selected || selectedIds)for(const row of Object.values(rows))row.protected=true;
    for(const row of Object.values(rows))delete row.intent;
    // Cache only unchanged sources. No model reply can overwrite a hand marker.
    await write(root,rows,expected);
    if(options.prepareOnly){proposals.set(k,{...proposals.get(k),...rows});changed(root);return {cutId,version};}
    const result=await apply(root,cutId,version,rows,expected,reference,pin);
    publishApplied(root,cutId,result);
    for(const id of Object.keys(rows))delete proposals.get(k)?.[id];return result;
  }catch(e){states.set(k,{state:'error',ready:[],corrected:0,hand:0,message:e instanceof Error?e.message:'Could not auto correct. Try again.'});throw e;}
  finally{etaTimes.delete(k);if(states.get(k)?.state!=='error')states.delete(k);}
}
/** Detached publication hook: no caller waits for correction to open/play an edit. */
export function correctDraftInBackground(root:string,cutId:string,version:number):Promise<unknown> {
  return detachedEditWork(async()=>{
    if((await getPreferences()).autoCorrectNewEdits===false)return;
    return balanceClips(root,cutId,version);
  });
}
export function prepareHandClips(root:string,cutId:string,version:number):void {
  void detachedEditWork(async()=>{
    // The insert's snapshot can exist before its owning commit publishes it.
    // Pin the current revision only after queued hand saves have published.
    await waitForLiveSaves(root,cutId,version);
    if((await getPreferences()).autoCorrectNewEdits!==false)await balanceClips(root,cutId,version,{prepareOnly:true});
  }).catch(()=>{});
}
/** Seed reused sources before a new draft's first publication, without a model call. */
export async function reuseBalances(root:string,record:StoredVersion) {
  const stored=await cache(root).catch(()=>({} as Cache)),balances={...record.balances};
  for(const {clip} of clipsOf(record))if(!balances[clip.id] && stored[clip.id]?.source===await sourceFingerprint(root,clip).catch(()=>null))balances[clip.id]=stored[clip.id];
  record.balances=balances;
  record.grade={...(record.grade ?? gradeForLook('rec709',{preset:'clean',words:null})),matchClips:false};
}

export async function readClipBalance(root:string,clipId:string) {return (await cache(root))[clipId] ?? null;}

function balanceError(error:unknown):string {
  const message=error instanceof Error ? error.message : '';
  if(/(?:not|isn['’]t) (?:signed|logged) in|sign in|unauthori[sz]ed|authentication|401/i.test(message))return 'Sign in in Settings to use Auto';
  if(/^Turn on picture sharing/.test(message))return 'Turn on picture sharing in Settings to use Auto';
  if((error as NodeJS.ErrnoException)?.code==='ENOENT')return 'Reconnect the footage to auto correct.';
  if((error as {revisionConflict?:boolean})?.revisionConflict || isRevisionConflict(error))return CONFLICT;
  if(/^(Auto correct needs|Auto correct returned|Choose a|Choose clips|Turn on picture sharing)/.test(message))return message;
  return "Couldn't auto correct. Try again.";
}

function publishApplied(root:string,cutId:string,result:BalanceSave) {
  if(!result.count || result.baseVersion===undefined)return;
  for(const win of electron.BrowserWindow.getAllWindows())if(!win.isDestroyed() && !win.webContents.isDestroyed())win.webContents.send('api:balanceApplied',{root,cutId,version:result.version,baseVersion:result.baseVersion,count:result.count});
}
async function acceptReady(root:string,cutId:string,version:number,options:BalanceOptions,pinned:Promise<RevisionPin|null>) {
  const pin=await pinned;
  const k=key(root,cutId),rows:Cache=structuredClone(proposals.get(k) ?? {}),expected=new Map(Object.keys(rows).map(id=>[id,revisions.get(key(root,id)) ?? 0]));
  const record=await loadDraftVersion(root,cutId,version),selected=options.piece===undefined ? undefined : record.pieces?.[options.piece]?.clipId;
  if(options.piece!==undefined && !selected)throw Error('Choose a clip in this edit.');
  const selectedIds=options.pieces?.map(p=>record.pieces?.[p]?.clipId);
  if(selectedIds?.some(id=>!id))throw Error('Choose clips in this edit.');
  for(const id of Object.keys(rows))if(selectedIds && !selectedIds.includes(id) || selected && selected!==id)delete rows[id];
  for(const id of selectedIds ?? (selected ? [selected] : []))if(id && rows[id]) {
    const k=key(root,id),revision=revisions.get(k) ?? 0;
    if(revision!==expected.get(id))delete rows[id];
    else {revisions.set(k,revision+1);expected.set(id,revision+1);rows[id].protected=true;}
  }
  await write(root,rows,expected);
  const result=await apply(root,cutId,version,rows,expected,undefined,pin);publishApplied(root,cutId,result);
  for(const id of Object.keys(rows))delete proposals.get(k)?.[id];return result;
}

/** V67 MCP: the values Auto set on each source of a version, with its one-line measured reason. */
export async function correctionSummary(root:string,cutId:string,version:number) {
  const record=await loadDraftVersion(root,cutId,version),stored=await cache(root).catch(()=>({} as Cache));
  return clipsOf(record).map(({clip})=>{
    const row=record.balances?.[clip.id] as CachedBalance|undefined;
    return {clipId:clip.id,pieces:(record.pieces ?? []).flatMap((p,i)=>p.clipId===clip.id ? [i] : []),owner:row?.owner ?? null,protected:!!row?.protected,
      basic:row?.basic ?? null,reason:row?.reason ?? (row?.owner==='auto' && stored[clip.id]?.source===row.source ? stored[clip.id]?.reason : undefined) ?? (row?.owner==='hand' ? 'Set by hand' : null)};
  });
}
