import type { Clip, CutEdit, DraftPiece, LayoutChoice } from '../shared/schema';
import { LAYOUTS, LAYOUT_TRANSITION_S, isLayoutCamera, layoutMorph, clamp, cleanBox, layoutAt, migrateLayouts, phoneRatio, replaceLayoutRange, sourceStart, type Box, type LayoutBackground } from '../shared/layout-presets';
import { clipDimensions, mediaUrl } from '../shared/media';
import { matchScreen } from './screen-match';
import { planFx, layoutRangeAdvance } from './edits-fx';
import { fullRegion, layoutCrop, layoutSourceTime, type LayoutPicture } from './layout-math';
import type { StoredVersion } from './sidekick';
import { finishStoredVersion, renderStoredPreview } from './sidekick';
import { runActivity } from './activity';
import { copyOverlay, overlayPath, overlayUrl } from './overlays';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

type Clock=Pick<DraftPiece,'clipId'|'startS'|'endS'|'inS'|'timeMap'|'layer'>;
/** Preserve camera edits and measured sync clocks; an unrelated chosen clip runs from its own start. */
function sourceClock(pictures:Clock[],shoot:StoredVersion['assembly']['shoot'],ref:{clipId:string;s:number},range:LayoutChoice,s:number,e:number){
  const delta=(from:string)=>{if(from===ref.clipId)return 0;const group=shoot.angles?.find(g=>g.clips.some(c=>c.clipId===from)&&g.clips.some(c=>c.clipId===ref.clipId));return group?group.clips.find(c=>c.clipId===from)!.offsetS-group.clips.find(c=>c.clipId===ref.clipId)!.offsetS:undefined;};
  const origin=pictures.find(p=>p.layer===0&&p.startS<=range.s!+1e-7&&p.endS>range.s!+1e-7),picture=pictures.find(p=>p.layer===0&&p.startS<=s+1e-7&&p.endS>s+1e-7);
  if(!origin||!picture)return;
  const firstDelta=delta(origin.clipId),currentDelta=delta(picture.clipId);if(firstDelta===undefined||currentDelta===undefined)return;
  const offset=ref.s-layoutSourceTime(origin as DraftPiece,range.s!)-firstDelta;
  const time=(t:number)=>({t,s:layoutSourceTime(picture as DraftPiece,t)+currentDelta+offset});
  return [time(s),...(picture.timeMap??[]).filter(k=>k.t>s&&k.t<e).map(k=>({t:k.t,s:k.s+currentDelta+offset})),time(e)];
}
const hex=(s:unknown):s is string=>typeof s==='string'&&/^#[0-9a-f]{6}$/i.test(s);
export function normalizeLayoutBackground(b:LayoutBackground|undefined):LayoutBackground {
  if(!b)return {kind:'gradient',stops:['#182d40','#486c75'],angle:135,dim:0};
  if(!['screen','gradient','image','colour'].includes(b.kind))throw new Error('Choose a background source.');
  if(![b.blur??0,b.dim??0,b.angle??0].every(Number.isFinite))throw new Error('Choose valid background amounts.');
  const out:LayoutBackground={kind:b.kind,blur:clamp(b.blur??0,0,100),dim:clamp(b.dim??0,0,100)};
  if(b.kind==='colour'){if(!hex(b.colour))throw new Error('Choose a six digit colour.');out.colour=b.colour;}
  if(b.kind==='gradient'){
    if(!Array.isArray(b.stops)||b.stops.length<2||b.stops.length>3||!b.stops.every(hex))throw new Error('Choose two or three gradient colours.');
    out.stops=[...b.stops];out.angle=((b.angle??135)%360+360)%360;out.fromClip=!!b.fromClip;
  }
  if(b.kind==='image'){if(typeof b.image!=='string'||!b.image)throw new Error('Choose an image.');out.image=b.image;}
  return out;
}
/** Every source is pinned on save, including lexical fallback and synchronized clocks. */
export function validateScene(value:LayoutChoice,record:StoredVersion,s:number,e:number):LayoutChoice {
  if(![s,e].every(Number.isFinite)||s<0||e<=s||e>record.lengthS+1e-6)throw new Error('Choose a time range inside this edit.');
  if(!LAYOUTS.some(l=>l[0]===value.id))throw new Error('Choose a layout.');
  if(![value.radius??16,value.padding??.04].every(Number.isFinite))throw new Error('Choose valid corner and padding amounts.');
  if(value.swap!==undefined&&typeof value.swap!=='boolean')throw new Error('Choose a valid swap setting.');
  if(value.transition!==undefined&&!['smooth','cut'].includes(value.transition))throw new Error('Choose Smooth or Hard cut.');
  const out:LayoutChoice={kind:'scene',id:value.id,s,e,swap:!!value.swap,radius:clamp(value.radius??16,0,48),padding:clamp(value.padding??.04,0,.12),background:normalizeLayoutBackground(value.background),transition:value.transition??'smooth',sources:{}};
  out.reason=value.reason?.slice(0,1000);out.followCamera=value.followCamera===true;
  // BROLL2: an over layout's top picture can be see-through (the screen over a desk shot), and a cutaway keeps its words.
  if(value.opacity!==undefined){if(!Number.isFinite(value.opacity))throw new Error('Choose an opacity.');if(value.id==='clip-over-camera'||value.id==='phone-over-camera')out.opacity=clamp(value.opacity,.2,.95);}
  if(value.cutaway){if(typeof value.cutaway.phrase!=='string')throw new Error('A cutaway names the words it shows.');out.cutaway={phrase:value.cutaway.phrase.slice(0,300),...(Number.isInteger(value.cutaway.word)&&value.cutaway.word!>=0?{word:value.cutaway.word}:{})};}
  if(value.screenLoop){const loop=value.screenLoop;if(![loop.s,loop.e].every(Number.isFinite)||loop.s<0||loop.e<=loop.s)throw Error('Choose a valid repeating screen segment.');out.screenLoop={...loop};}
  if(value.boxes){out.boxes={};for(const key of ['a','b'] as const)if(value.boxes[key])out.boxes[key]=cleanBox(value.boxes[key]!);}
  const {shoot}=record.assembly, piece=record.pieces?.find(p=>s>=(p.timelineS??0)&&s<(p.timelineS??0)+p.lengthS)??record.pieces?.[0];
  const ready=(c:Clip)=>!!c.meta&&!!c.proxy&&!c.leftOut&&!c.missing&&c.stage!=='error';
  const needsA=value.id!=='camera-only',needsB=!['screen-only','phone-only'].includes(value.id!);
  out.swap=needsA&&needsB&&!!value.swap;
  const topic=record.pieces?.filter(p=>(p.timelineS??0)<e&&(p.timelineS??0)+p.lengthS>s).map(p=>p.words??p.description??'').join(' ')??'';
  const matches=matchScreen(shoot,topic);
  const clocks=planFx(record.assembly.cutList,record.assembly.template.fps,record).items.map((item,i)=>({...item,clipId:record.assembly.cutList[i].seg?.clip.id??'',inS:item.timeMap[0].s,layer:0 as const}));
  const fits=(clip:Clip,ref:{clipId:string;s:number})=>{
    if(!ready(clip)||!Number.isFinite(ref.s)||ref.s<0)return false;
    const spans=clocks.filter(p=>p.startS<e&&p.endS>s);
    const maps=spans.map(p=>sourceClock(clocks,shoot,ref,out,Math.max(s,p.startS),Math.min(e,p.endS))??[{s:ref.s+Math.max(s,p.startS)-s},{s:ref.s+Math.min(e,p.endS)-s}]);
    return (maps.length?maps.flat():[{s:ref.s},{s:ref.s+e-s}]).every(k=>k.s>=0&&k.s<=clip.meta!.durationS+1e-6);
  };
  for(const key of ['a','b'] as const){
    if(key==='a'&&!needsA||key==='b'&&!needsB)continue;
    let selected=value.sources?.[key];
    if(!selected){
      const ranked=key==='b'?shoot.clips.filter(c=>c.id===piece?.clipId&&ready(c)):matches.map(m=>shoot.clips.find(c=>c.id===m.clipId)!).filter(c=>c&&ready(c));
      const candidates=ranked.length||key==='b'?ranked:shoot.clips.filter(ready);
      const phone=value.id!.startsWith('phone');
      const ordered=phone&&key==='a'?[...candidates.filter(c=>clipDimensions(c).width<clipDimensions(c).height),...candidates.filter(c=>clipDimensions(c).width>=clipDimensions(c).height)]:candidates;
      for(const clip of ordered){
        const fallback=clamp(key==='a'?matches.find(m=>m.clipId===clip.id)?.s??0:piece?.s??0,0,Math.max(0,clip.meta!.durationS-(e-s)));
        const ref={clipId:clip.id,s:sourceStart(shoot,record,clip.id,s,fallback,{pieces:clocks})};
        if(key==='b'&&out.followCamera||fits(clip,ref)){selected=ref;break;}
      }
      if(!selected)throw new Error(key==='a'?'Add a screen or clip with enough picture for this range.':'Choose a camera clip with enough picture for this range.');
    }
    const clip=shoot.clips.find(c=>c.id===selected!.clipId);
    const loop=key==='a'?out.screenLoop:undefined;
    if(!clip||!(loop?ready(clip)&&loop.e<=clip.meta!.durationS&&selected.s>=loop.s&&selected.s<loop.e:out.followCamera&&key==='b'?ready(clip):fits(clip,selected)))throw new Error('Choose a ready source with enough picture for this range.');
    out.sources![key]={...selected};
  }
  // A bubble is round in output pixels, including custom boxes.
  if(out.boxes)for(const key of ['a','b'] as const){const b=out.boxes[key];if(b?.circle){const ar=record.assembly.template.width/record.assembly.template.height;const w=clamp(b.w,Math.max(.04,.04/ar),Math.min(1,1/ar));out.boxes[key]=cleanBox({...b,w,h:w*ar});}}
  return out;
}
export function editLayoutRange(root:string,cutId:string,version:number,edit:Extract<CutEdit,{kind:'layoutRange'}>){
  return runActivity({kind:'edit',root,target:{cutId,version},label:'Updating layout',cancelable:true},()=>finishStoredVersion(root,cutId,version,true,async(record,assembly)=>{
    record.assembly=assembly;
    if(![edit.s,edit.e].every(Number.isFinite)||edit.s<0||edit.e<=edit.s||edit.e>record.lengthS+1e-6)throw new Error('Choose a time range inside this edit.');
    const next=edit.layout?validateScene(edit.layout,record,edit.s,edit.e):null;
    if(next?.background?.kind==='image'){
      for(const directory of [path.join(root,'.sidething'),path.join(root,'.sidething','overlays')]){
        try{if((await fs.lstat(directory)).isSymbolicLink())throw new Error('The image cache must stay inside this shoot.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        await fs.mkdir(directory,{recursive:true});
      }
      const source=next.background.image!,clip=assembly.shoot.clips.find(c=>c.id===source);
      next.background.image=path.isAbsolute(source)?await copyOverlay(root,source):clip?await copyOverlay(root,path.resolve(root,clip.photo?.file??clip.file)):source;
      const file=overlayPath(root,next.background.image);
      const real=await fs.realpath(file),dir=await fs.realpath(path.dirname(file));
      if(path.dirname(real)!==dir||(await fs.lstat(file)).isSymbolicLink())throw new Error('Choose an image in this shoot.');
    }
    const existing=record.layouts??[];
    const legacy=Array.from({length:record.pieces?.length??0},(_,i)=>existing[i]?.kind==='scene'?null:existing[i]??null);
    record.layouts=replaceLayoutRange([...legacy,...existing.filter(l=>l?.kind==='scene')],edit.s,edit.e,next,layoutRangeAdvance(record));
    record.feedback=next?'Changed layout':'Removed layout';
    await renderStoredPreview(root,cutId,record,assembly);
    return {cutId,version:record.version};
  }));
}

/** Split only at authored boundaries; destination keys animate without decoder churn. */
export function scenePictures(pictures:DraftPiece[],record:Pick<StoredVersion,'layouts'|'assembly'|'pieceFx'|'titles'>,clocks:DraftPiece[]=pictures):LayoutPicture[]{
  const {shoot,template:{width,height,fps}}=record.assembly;
  const ranged=(record.layouts??[]).filter((l):l is LayoutChoice=>!!l&&l.kind==='scene');
  const legacy=migrateLayouts({layouts:record.layouts,pieces:record.assembly.cutList.map(c=>({clipId:c.seg?.clip.id,s:c.inFrames/(c.clipFpsR.num/c.clipFpsR.den),timelineS:c.offsetFrames/fps,lengthS:c.durTimelineFrames/fps})) as CutVersionPieces,lengthS:0},width/height);
  const all=[...legacy.filter(l=>l.kind!=='scene'),...ranged];
  const result:LayoutPicture[]=[];
  const loopEdges=ranged.flatMap(l=>{
    const loop=l.screenLoop,ref=l.sources?.a;if(!loop||!ref||loop.e<=loop.s)return [];
    const period=loop.e-loop.s,first=l.s!+loop.e-ref.s,end=l.e!+LAYOUT_TRANSITION_S;
    return Array.from({length:Math.max(0,Math.ceil((end-first)/period))},(_,i)=>first+i*period);
  });
  for(const p of pictures){
    const edges=[...new Set([p.startS,p.endS,...[...loopEdges,...ranged.flatMap(l=>[l.s!,l.e!,...(l.transition!=='cut'&&layoutAt(all,l.s!-.000001)?[Math.min(l.e!,l.s!+LAYOUT_TRANSITION_S)]:[])])].filter(t=>t>p.startS&&t<p.endS)])].sort((a,b)=>a-b);
    for(let i=0;i<edges.length-1;i++){
      const s=edges[i],e=edges[i+1],l=layoutAt(all,s+.000001);
      const inS=layoutSourceTime(p,s),span={...p,startS:s,endS:e,inS,timeMap:p.timeMap?[{t:s,s:inS},...p.timeMap.filter(k=>k.t>s&&k.t<e),{t:e,s:layoutSourceTime(p,e)}]:undefined};
      if(!l||l.kind!=='scene'){result.push(span);continue;}
      if(p.layer===1)continue;
      const prior=layoutAt(all,l.s!-.000001),aspect=phoneRatio(shoot,l),previousAspect=prior?phoneRatio(shoot,prior):undefined;
      const morph=(t:number)=>layoutMorph(l,prior,t,width,height,aspect,previousAspect);
      let layer=0;
      for(const entry of morph(s)){
        if(entry.departing&&s>=l.s!+LAYOUT_TRANSITION_S-1e-7)continue;
        const key=entry.slot,sourceScene=entry.sourceScene,follow=sourceScene.followCamera&&entry.sourceSlot==='b',ref=follow?{clipId:p.clipId,s:layoutSourceTime(p,s)}:sourceScene.sources?.[entry.sourceSlot];
        const clip=shoot.clips.find(c=>c.id===ref?.clipId);
        if(!clip?.meta||!clip.proxy||!ref)throw new Error('A layout source is missing. Reconnect its footage.');
        const at=(t:number)=>morph(t).find(p=>p.slot===key&&p.departing===entry.departing)!;
        const region=at(e).box,loop=entry.sourceSlot==='a'?sourceScene.screenLoop:undefined;
        const cycle=loop?Math.floor((ref.s+s-sourceScene.s!-loop.s+1e-7)/(loop.e-loop.s)):0;
        const loopStart=loop?ref.s+s-sourceScene.s!-cycle*(loop.e-loop.s):0;
        const timeMap=follow?span.timeMap:loop?[{t:s,s:loopStart},{t:e,s:loopStart+e-s}]:sourceClock(clocks,shoot,ref,sourceScene,s,e),source=follow?inS:timeMap?.[0].s??ref.s+s-sourceScene.s!;
        const piece:LayoutPicture={...span,clipId:clip.id,proxy:mediaUrl(shoot.root,'proxies',clip.proxy),layer:layer++ as DraftPiece['layer'],inS:source,timeMap,blur:undefined,layoutRegion:region,layoutCircle:!!region.circle,layoutRadius:at(e).radius,layoutReferenceWidth:width,layoutPhoneAspect:aspect,layoutScreen:true,layoutSlot:key,layoutScene:l,layoutDeparting:entry.departing,
          layoutBackground:layer===1?l.background:undefined,layoutImage:l.background?.kind==='image'?overlayUrl(shoot.root,l.background.image!):undefined};
        const keys=[...new Set([s,e,...Array.from({length:Math.ceil(Math.min(e-s,LAYOUT_TRANSITION_S)*fps)+1},(_,n)=>Math.min(e,s+n/fps))])].sort((a,b)=>a-b);
        piece.layoutRegionKeys=keys.map(t=>({t,...at(t).box}));
        const see=entry.sourceSlot==='a'?sourceScene.opacity??1:1;   // BROLL2: the screen laid over a desk shot
        piece.layoutShapeKeys=keys.map(t=>({t,radius:at(t).radius,opacity:at(t).opacity*see}));
        const cropKeys=clip.subject?.samples?.length?[...new Set([...keys,...Array.from({length:Math.ceil((e-s)*fps)},(_,n)=>Math.min(e,s+n/fps))])].sort((a,b)=>a-b):keys;
        piece.frame=cropKeys.map(t=>{
          const box=at(t).box;
          const crop={t,...layoutCrop(clip,layoutSourceTime(piece,t),box.w*width/(box.h*height),at(t).bubble)};
          return !isLayoutCamera(sourceScene,key)?{...crop,x:(1-crop.w)/2,y:(1-crop.h)/2}:crop;
        });
        result.push(piece);
      }
    }
  }
  return result.sort((a,b)=>a.layer-b.layer||a.startS-b.startS);
}
type CutVersionPieces=NonNullable<import('../shared/schema').CutVersion['pieces']>;
