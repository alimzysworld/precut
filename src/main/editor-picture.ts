import {transformGeometry,transformValue} from '../shared/clip-transform';
import { clipFilterTurn, clipRotationFilter, clipFileDimensions } from "../shared/media";
import * as fs from 'node:fs/promises';
import { threads } from "./activity";
import * as path from 'node:path';
import type { Clip, DraftPiece } from '../shared/schema';
import type { EditorInput } from './editors';
import { editorPlan } from './editor-timeline';
import { framingReference } from './framing';
import { framingMotion } from './motion';
import { joinFraming, renderFxPictures } from './preview';
import { anglePictures } from './angles';
import { layoutPictures } from './layouts';
import { fullRegion, TITLE_CARD_BASE, type Rect, layoutSourceTime } from './layout-math';
import { getPreferences } from './settings';

export interface PictureClip {
  transform?: import('../shared/schema').ClipTransform;
  transformRegion?: Rect; // the framed viewport, including any existing fit bars
  clip: Clip; name: string; s: number; d: number; track: number; owner: number; piece?: number;
  keys: { t: number; s: number }[];
  frames: NonNullable<DraftPiece['frame']>;
  region: Rect; colourClip?: Clip; colourKeys?: {t:number;s:number}[]; still?: boolean; rotation?: number; alpha?: boolean; circle?: boolean; dim?: boolean; colour?: string; animation?: { t: number; scale: number; y: number; opacity: number }[];
}
export type PictureRender = (key: unknown, extension: string, render: (out: string) => Promise<void>) => Promise<string>;
export type PictureFFmpeg = (args: string[], duration: number) => Promise<void>;
export type PictureCommand = (binary: string, args: string[]) => Promise<void>;
export function flattenedLayouts(layouts:import('../shared/schema').CutVersion['layouts']) {
  return layouts?.some(l=>l?.kind==='scene'&&((l.radius??16)>0||l.id?.includes('bubble')||l.boxes?.a?.circle||l.boxes?.b?.circle||l.background?.kind!=='colour'||l.transition!=='cut'))??false;
}
export function flattenedTransforms(version:Pick<import('../shared/schema').CutVersion,'pieceFx'|'layouts'>,editor='finalcut'){
  return !!version.pieceFx?.some(f=>f?.transform&&(version.layouts?.some(Boolean)||editor==='premiere'&&(f.transform.flipH||f.transform.flipV)));
}
export function editorLayoutNote(layouts:import('../shared/schema').CutVersion['layouts']) {
  if(!layouts?.some(l=>l?.kind==='scene'))return '';
  return flattenedLayouts(layouts)?'Timed layouts use a flattened picture layer in Resolve, Final Cut and Premiere to preserve rounded masks, composited backgrounds and 480 ms source-matched motion. Camera colour, layout transforms and backgrounds are baked into that layer; captions, overlays and sound remain separate. Source spans and custom boxes are in layouts.json.':'Timed layouts carry native position, scale and crop in Resolve, Final Cut and Premiere, with a generated colour backdrop. Source spans and custom boxes are in layouts.json.';
}

function pictureFrameAt(keys: NonNullable<DraftPiece['frame']>, t: number): Rect {
  const index=keys.findIndex(k=>k.t>=t);
  if(index<=0){const k=keys[index<0?keys.length-1:0];return {x:k.x,y:k.y,w:k.w,h:k.h};}
  const a=keys[index-1],b=keys[index],u=(t-a.t)/(b.t-a.t);
  return {x:a.x+(b.x-a.x)*u,y:a.y+(b.y-a.y)*u,w:a.w+(b.w-a.w)*u,h:a.h+(b.h-a.h)*u};
}

export async function editorPictures(i: EditorInput): Promise<PictureClip[]> {
  const cuts = i.selects?.cuts ?? i.cutList, version = i.finishing ?? i.opts?.finishing ?? {};
  const { fps, width, height } = i.template, plan = editorPlan(cuts, fps, version);
  const reference = framingReference(i.template, (await getPreferences()).output.height);
  const motions = await framingMotion(i.root, [...cuts,...(i.opts?.reel?.broll ?? []).map(b=>({piece:b.voiceIndex,seg:b.seg}))], version);
  const framing = joinFraming(cuts, fps, reference, version.energy ?? 'subtle', version, motions, reference);
  const pictures = renderFxPictures(cuts, fps, framing, plan);
  const assembly = { shoot: i.shoot, template: i.template, cutList: cuts } as import('./sidekick').StoredVersion['assembly'];
  const angles = anglePictures(pictures, { ...version, assembly }, motions, reference);
  const layouts = layoutPictures(angles, { ...version, assembly });
  const timed=version.layouts?.some(l=>l?.kind==='scene');
  const result = layouts.flatMap((p): PictureClip[] => {
    const clip = i.shoot.clips?.find(c => c.id === p.clipId) ?? cuts.find(c => c.seg?.clip.id === p.clipId)?.seg?.clip;
    if (!clip?.meta) return [];
    const owner = plan.items.findIndex(item => item.piece === p.piece && p.startS >= item.startS - 1e-6 && p.endS <= item.endS + 1e-6);
    const region = p.layoutRegion ?? fullRegion;
    const reverse = owner >= 0 && plan.items[owner].reverse && !p.layoutScreen;
    const sourceKeys = p.timeMap ?? [{ t: p.startS, s: p.inS }, { t: p.endS, s: p.inS + p.endS - p.startS }];
    const first = sourceKeys[0].s, last = sourceKeys.at(-1)!.s;
    const timedKeys = reverse ? [...new Set([p.startS,p.endS,...sourceKeys.map(k=>k.t),...Array.from({length:Math.ceil((p.endS-p.startS)*fps)},(_,n)=>p.startS+n/fps)])].sort((a,b)=>a-b).map(t=>({t:t-p.startS,s:Math.max(first,last-1/clip.meta!.fps-(layoutSourceTime(p,t)-first))})) : sourceKeys.map(k=>({t:k.t-p.startS,s:k.s}));
    // Fit fallback uses a smaller destination region over the editor canvas.
    const fit = Math.min(region.w * width / clip.meta.width, region.h * height / clip.meta.height);
    const fitRegion = { x: region.x + (region.w - clip.meta.width * fit / width) / 2,
      y: region.y + (region.h - clip.meta.height * fit / height) / 2,
      w: clip.meta.width * fit / width, h: clip.meta.height * fit / height };
    const transform=version.pieceFx?.[p.piece ?? -1]?.transform;
    return [{ clip, name: `${cuts[owner]?.seg?.marker ?? `Picture ${p.piece! + 1}`} / ${clip.id}`, s: p.startS, d: p.endS - p.startS,
      transform,...(transform?{transformRegion:region}:{}), owner, piece:p.piece, track: p.layer+(timed?1:0), keys: timedKeys,
      frames: p.frame ? Array.from({length:Math.ceil((p.endS-p.startS)*fps-1e-7)+1},(_,n)=>{const t=Math.min(p.endS-p.startS,n/fps);return {t,...pictureFrameAt(p.frame!,p.startS+t)};}) : [{ t: 0, ...fullRegion }, { t: p.endS - p.startS, ...fullRegion }],
      region: p.frame ? region : fitRegion, circle: p.layoutCircle, dim: p.layoutDim, colour: p.layoutColour }];
  });
  if(timed&&!flattenedLayouts(version.layouts))for(const p of layouts.filter(p=>p.layoutBackground)){
    const base=result.find(r=>r.s===p.startS&&r.piece===p.piece);if(base)result.unshift({...base,track:0,dim:true,colour:p.layoutBackground?.colour,region:fullRegion});
  }
  for (const b of i.opts?.reel?.broll ?? []) {
    const layout=version.layouts?.[b.voiceIndex];
    if(layout && !['face','placeholder'].includes(layout.kind))continue;
    const owner=plan.items.find(p=>p.piece===b.voiceIndex),clip=b.seg.clip;
    if(!owner || !clip.meta)continue;
    const sourceFps=clip.meta.fps,s=Math.ceil(b.seg.s*sourceFps)/sourceFps;
    const d=Math.min(Math.floor(b.seg.e*sourceFps)/sourceFps-s,Math.max(...plan.items.filter(p=>p.piece===b.voiceIndex).map(p=>p.endS))-owner.startS);
    if(d<=0)continue;
    const cut={piece:b.voiceIndex,seg:b.seg,inFrames:s*sourceFps,outFrames:(s+d)*sourceFps,clipFpsR:{num:sourceFps,den:1},offsetFrames:0,durTimelineFrames:d*fps};
    const framing=joinFraming([cut],fps,reference,version.energy ?? 'subtle',{...version,faceMatch:'off',joins:[],transition:{kind:'cut',sound:null}},motions,reference);
    const picture=renderFxPictures([cut],fps,framing,editorPlan([cut],fps,{energy:'off',faceMatch:'off'}))[0];
    result.push({transform:version.pieceFx?.[b.voiceIndex]?.transform,clip,name:b.seg.marker,s:owner.startS,d,track:1,owner:-2,piece:b.voiceIndex,keys:[{t:0,s},{t:d,s:s+d}],frames:picture.frame?.map(k=>({...k,t:k.t-picture.startS})) ?? [{t:0,...fullRegion},{t:d,...fullRegion}],region:fullRegion});
  }
  return result;
}

/** Output-pixel affine mapping, before each format's unit conversion. */
export function pictureTransform(p: PictureClip, r: Rect & { t?: number }, width: number, height: number) {
  const animation = p.animation?.find(k=>Math.abs(k.t-(r.t ?? 0))<1e-7);
  const m = p.clip.meta!, scale = p.region.w * width / (r.w * m.width) * (animation?.scale ?? 1);
  const baseX=(.5-r.x-r.w/2)*m.width*scale,baseY=(.5-r.y-r.h/2)*m.height*scale;
  const viewport=p.transformRegion??p.region,g=transformGeometry(p.transform,viewport.w*width/(viewport.h*height)),sx=g.flipH?-1:1,sy=g.flipV?-1:1;
  return {scale:scale*g.scale,scaleX:scale*g.scale*sx,scaleY:scale*g.scale*sy,
    x:(p.region.x+p.region.w/2-.5)*width+(g.c*baseX*sx-g.s*baseY*sy)*g.scale+g.x*viewport.w*width,
    y:(p.region.y+p.region.h/2-.5)*height+(g.s*baseX*sx+g.c*baseY*sy)*g.scale+g.y*viewport.h*height+(animation?.y??0)};
}
export function nativeTransformCrop(p:PictureClip){
 const c=transformValue(p.transform).crop,f=p.transformRegion??p.region,r=p.region,clamp=(n:number)=>Math.max(0,Math.min(1,n));
 if(!p.transform||!p.transformRegion||p.transformRegion===p.region)return c;
 return {l:clamp((f.x+c.l*f.w-r.x)/r.w),r:clamp((r.x+r.w-f.x-(1-c.r)*f.w)/r.w),t:clamp((f.y+c.t*f.h-r.y)/r.h),b:clamp((r.y+r.h-f.y-(1-c.b)*f.h)/r.h)};
}
export function fcpxPictureTransform(p: PictureClip, width: number, height: number, time: (n: number) => string) {
  const first = pictureTransform(p, p.frames[0], width, height), m = p.clip.meta!;
  const blend = p.animation ? `<adjust-blend amount="${p.animation[0].opacity}"><param name="amount"><keyframeAnimation>${p.animation.map(k=>`<keyframe time="${time(k.t)}" value="${k.opacity}" interp="linear" curve="linear"/>`).join('')}</keyframeAnimation></param></adjust-blend>` : '';
  const values = (r: Rect) => { const v = pictureTransform(p, r, width, height); return { scale: `${v.scaleX} ${v.scaleY}`, position: `${v.x / height * 100} ${-v.y / height * 100}` }; };
  const param = (name: string, get: (r: Rect) => string) => `<param name="${name}"><keyframeAnimation>${p.frames.map(k => `<keyframe time="${time(k.t)}" value="${get(k)}" interp="linear" curve="linear"/>`).join('')}</keyframeAnimation></param>`;
  const crop = (r: Rect, side: string) => {const c=nativeTransformCrop(p);return String(({left:(r.x+c.l*r.w)*m.width/m.height,right:(1-r.x-r.w+c.r*r.w)*m.width/m.height,top:r.y+c.t*r.h,bottom:1-r.y-r.h+c.b*r.h}[side]??0)*100);};
  return `<adjust-crop mode="trim"><trim-rect ${['left','right','top','bottom'].map(s => `${s}="${crop(p.frames[0], s)}"`).join(' ')}>${['left','right','top','bottom'].map(s => param(s, r => crop(r, s))).join('')}</trim-rect></adjust-crop><adjust-conform type="none"/><adjust-transform scale="${first.scaleX} ${first.scaleY}" position="${first.x / height * 100} ${-first.y / height * 100}" rotation="${(p.rotation ?? 0)-(p.transform?.rotate ?? 0)}">${param('scale', r => values(r).scale)}${param('position', r => values(r).position)}</adjust-transform>${blend}`;
}
export function premierePictureTransform(p: PictureClip, width: number, height: number, fps: number) {
  const parameter = (id: string, value: (r: Rect) => string, frames=p.frames) => `<parameter><parameterid>${id}</parameterid><name>${id}</name>${[...new Map(frames.map(k=>[Math.round(k.t*fps),k])).values()].map(k => `<keyframe><when>${Math.round(k.t * fps)}</when><value>${value(k)}</value><interpolation><name>FCPCurve</name></interpolation></keyframe>`).join('')}</parameter>`;
  const effect = (name: string, id: string, body: string) => `<filter><effect><name>${name}</name><effectid>${id}</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>${body}</effect></filter>`;
  const opacity=p.animation ? effect('Opacity','opacity',parameter('opacity',r=>String((p.animation!.find(k=>Math.abs(k.t-(r as Rect & {t:number}).t)<1e-7)?.opacity ?? 1)*100),p.animation.map(k=>({t:k.t,...fullRegion})))) : '';
  return effect('Basic Motion', 'basic', parameter('scale', r => String(pictureTransform(p,r,width,height).scale * 100)) + parameter('center', r => {
    const v = pictureTransform(p,r,width,height); return `<horiz>${v.x / width}</horiz><vert>${v.y / height}</vert>`;
  }) + parameter('rotation', () => String((p.rotation ?? 0) + (p.transform?.rotate ?? 0) + clipFilterTurn(p.clip)))) + effect('Crop', 'crop',
    ['left','right','top','bottom'].map(s => parameter(s, r => String(({left:r.x+nativeTransformCrop(p).l*r.w,right:1-r.x-r.w+nativeTransformCrop(p).r*r.w,top:r.y+nativeTransformCrop(p).t*r.h,bottom:1-r.y-r.h+nativeTransformCrop(p).b*r.h}[s] ?? 0)*100))).join('')) + opacity;
}

export function pictureTiming(p: PictureClip) {
  const low = Math.min(...p.keys.map(k => k.s)), high = Math.max(...p.keys.map(k => k.s));
  const reverse=p.keys[0].s>p.keys.at(-1)!.s;
  const keys=p.keys.map((k,n)=>({t:p.s+k.t,s:reverse ? (n===p.keys.length-1 ? high+1/p.clip.meta!.fps : low+high-k.s) : k.s}));
  return { piece: p.owner, startS: p.s, endS: p.s + p.d, overlap: 0, reverse, gainDb: 0,
    timeMap: keys.filter((k,n)=>!n || k.s>keys[n-1].s+1e-9) };
}

/** Only masks and pixel effects without a shared native equivalent are baked.
 * Camera rectangles, layout placement, time maps and all audio stay separate. */
export async function preparePictureAssets(i: EditorInput, folder: string, cache: PictureRender, ffmpeg: PictureFFmpeg, command: PictureCommand, editor='finalcut') {
  const { tool } = await import('./tools');
  const { resource } = await import('./titles/mattes');
  const { previewFraming } = await import('./preview');
  const { fxSetpts } = await import('./edits-fx');
  const { backgroundImage, backgroundMaskFilter } = await import('./backgrounds');
  const version = i.finishing ?? i.opts?.finishing ?? {}, fps = i.template.fps;
  const result: PictureClip[] = [];
  await fs.mkdir(path.join(folder,'Layers'),{recursive:true});
  const copy = async (file: string, name: string) => { const out = path.join(folder,'Layers',name); await fs.copyFile(file,out); return out; };
  const media = (p: PictureClip, file: string, w: number, h: number, d: number, mediaFps=p.clip.meta!.fps): Clip => ({...p.clip,id:path.basename(file),file,byHand:{...p.clip.byHand,rotate:0},meta:{...p.clip.meta!,rotation:0,containerRotation:0,codedWidth:w,codedHeight:h,width:w,height:h,fps:mediaFps,durationS:Math.ceil(d*mediaFps-1e-7)/mediaFps,startTimecode:'00:00:00:00',audioChannels:0}});
  const flattened=flattenedLayouts(version.layouts)||flattenedTransforms(version,editor);
  if(flattened){
    const cuts=i.selects?.cuts??i.cutList,first=i.pictures?.[0];
    if(!first)throw new Error('A layout source is missing.');
    const assembly={shoot:i.shoot,template:i.template,cutList:cuts,reel:i.opts?.reel} as import('./sidekick').StoredVersion['assembly'];
    const rendered=await (await import('./preview')).renderFinishingPreview(i.root,cuts,{name:`editor-layouts-${(await import('node:crypto')).createHash('sha256').update(JSON.stringify([version,i.template])).digest('hex').slice(0,16)}`,template:i.template,version:{...version,music:null,titles:null,lowerThirds:[],bleeps:[],overlays:[],assembly},reel:i.opts?.reel,full:true});
    const file=await copy(rendered,'Layouts.mp4'),d=editorPlan(cuts,fps,version).durationS;
    const clip=media(first,file,i.template.width,i.template.height,d,fps);
    i.pictures=editorPlan(cuts,fps,version).items.map((item,owner)=>({clip,name:'Composited layouts',s:item.startS,d:item.endS-item.startS,track:0,owner,piece:item.piece,keys:[{t:0,s:item.startS},{t:item.endS-item.startS,s:item.endS}],frames:[{t:0,...fullRegion},{t:item.endS-item.startS,...fullRegion}],region:fullRegion}));
  }
  for (const [n,p] of (i.pictures ?? []).entries()) {
    const m = p.clip.meta!, source = path.resolve(i.root,p.clip.file), stat = await fs.stat(source);
    const key = {picture:p,source:[source,stat.size,stat.mtimeMs],revision:3};
    const low = Math.min(...p.keys.map(k=>k.s)), high = Math.max(...p.keys.map(k=>k.s));
    const sourceD = Math.max(1/m.fps,high-low + (p.keys[0].s > p.keys.at(-1)!.s ? 1/m.fps : 0));
    if (p.dim) {
      // A title card is only a solid native still below its alpha title.
      const card=await cache({kind:'title-card-colour',colour:p.colour,width:i.template.width,height:i.template.height},'.png',out=>ffmpeg(['-f','lavfi','-i',`color=c=${p.colour ?? TITLE_CARD_BASE}:s=${i.template.width}x${i.template.height},format=rgba`,'-frames:v','1','-threads','1',out],0));
      const file=await copy(card,`Title card ${n+1}.png`);
      result.push({...p,clip:media(p,file,i.template.width,i.template.height,p.d,fps),name:`Title card colour ${n+1}`,still:true,frames:[{t:0,...fullRegion},{t:p.d,...fullRegion}],keys:[{t:0,s:0},{t:p.d,s:p.d}],region:fullRegion,dim:false});
      continue;
    }
    let foreground = p;
    const background = version.pieceFx?.[p.piece ?? i.cutList[p.owner]?.piece ?? p.owner]?.background;
    if (!flattened && background && background.mode !== 'blur' && !version.layouts?.[p.piece ?? i.cutList[p.owner]?.piece ?? p.owner]?.screen) {
      const native = clipFileDimensions(p.clip);
      const maskW = Math.max(2,Math.round(native.width*Math.min(1,1280/native.width)/2)*2), maskH = Math.max(2,Math.round(native.height*maskW/native.width/2)*2);
      const person = await cache({...key,kind:'background-person'},'.mov',async out => {
        // matte.py only writes inside <root>/.sidething/mattes/ (its own guard); the matte is removed after use.
        await fs.mkdir(path.join(i.root,'.sidething','mattes'),{recursive:true});
        const matte = path.join(i.root,'.sidething','mattes',`editor-${path.basename(out)}.mkv`);
        try {
          await command(tool('python3'),['-I',await resource('pipeline/matte.py'),i.root,'--clip',p.clip.id,'--s',String(low),'--e',String(low+sourceD),'--fps',String(m.fps),'--size',`${maskW}x${maskH}`,'--out',matte]);
          await ffmpeg(['-ss',String(low),'-t',String(sourceD),'-i',source,'-i',matte,'-filter_complex_threads','1','-filter_complex',`[0:v]${clipRotationFilter(p.clip)}setpts=PTS-STARTPTS,format=rgb24[p];[1:v]setpts=PTS-STARTPTS,${backgroundMaskFilter(maskW,maskH)},${clipRotationFilter(p.clip)}scale=${m.width}:${m.height}[m];[p][m]alphamerge[v]`,'-map','[v]','-an','-c:v','prores_ks','-profile:v','4444','-pix_fmt','yuva444p10le','-threads',String(threads(2)),out],sourceD);
        } finally {await fs.rm(matte,{force:true});}
      });
      const personFile = await copy(person,`Person background ${n+1}.mov`);
      foreground = {...p,colourClip:p.clip,colourKeys:p.keys,clip:media(p,personFile,m.width,m.height,sourceD),name:`Person background ${n+1}`,alpha:true,track:p.track+1,keys:p.keys.map(k=>({...k,s:k.s-low}))};
      const image = background.mode==='image' ? await backgroundImage(i.root,background.image!) : null;
      const imageStat = image ? await fs.stat(image) : null;
      const backing = await cache({...key,kind:'background',background,imageStat:imageStat && [imageStat.size,imageStat.mtimeMs]},'.mov',async out=>{
        const args = image ? ['-loop','1','-i',image] : ['-f','lavfi','-i',`color=c=${background.colour ?? '#000000'}:s=${m.width}x${m.height}:r=${m.fps}`];
        await ffmpeg([...args,'-vf',`scale=${m.width}:${m.height}:force_original_aspect_ratio=increase,crop=${m.width}:${m.height},setsar=1`,'-t',String(sourceD),'-r',String(m.fps),'-an','-c:v','prores_ks','-profile:v','3','-threads',String(threads(2)),out],sourceD);
      });
      const backingFile = await copy(backing,`Background ${n+1}.mov`);
      result.push({...p,colourClip:p.clip,colourKeys:p.keys,clip:media(p,backingFile,m.width,m.height,sourceD),name:`Background ${n+1}`,keys:p.keys.map(k=>({...k,s:k.s-low}))});
    }
    if(p.circle) {
      const w=Math.max(2,Math.round(p.region.w*i.template.width/2)*2), h=Math.max(2,Math.round(p.region.h*i.template.height/2)*2);
      const bubble=await cache({...key,kind:'bubble'},'.mov',async out=>{
        const timing=pictureTiming(p), reverse=p.keys[0].s>p.keys.at(-1)!.s;
        const plans={crop:null,scale:1,push:0,x:.5,y:.5,elapsed:0,duration:p.d,rects:p.frames.map(k=>({...k,x:k.x*m.width,y:k.y*m.height,w:k.w*m.width,h:k.h*m.height}))};
        const filters=[`[0:v]${clipRotationFilter(p.clip)}setpts=PTS-STARTPTS,${reverse?'reverse,':''}${fxSetpts(timing)},fps=${fps}[source]`,...previewFraming(p.clip,low,low+sourceD,{w,h},'source','framed','off',undefined,fps,undefined,plans),`[framed]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip((W/2-hypot(X+0.5-W/2,Y+0.5-H/2))/${2*i.template.width/960},0,1)'[out]`];
        await ffmpeg(['-ss',String(low),'-t',String(sourceD),'-i',source,'-filter_complex_threads','1','-filter_complex',filters.join(';'),'-map','[out]','-an','-t',String(p.d),'-r',String(fps),'-c:v','prores_ks','-profile:v','4444','-pix_fmt','yuva444p10le','-threads',String(threads(2)),out],p.d);
      });
      const file=await copy(bubble,`Bubble ${n+1}.mov`);
      foreground={...p,colourClip:p.clip,colourKeys:p.keys,clip:media(p,file,w,h,p.d,fps),name:`Bubble alpha ${n+1}`,alpha:true,frames:[{t:0,...fullRegion},{t:p.d,...fullRegion}],keys:[{t:0,s:0},{t:p.d,s:p.d}],circle:false};
    }
    result.push(foreground);
  }
  const nativeTop=Math.max(0,...result.filter(p=>p.owner>=0).map(p=>p.track));
  for(const p of result) if(p.owner===-2) p.track=nativeTop+1;
  // Native stills retain the original pixels; only rounded corners are baked.
  const { overlayPath }=await import('./overlays');
  const { execFile }=await import('node:child_process');const {promisify}=await import('node:util');
  for(const [n,o] of (version.overlays ?? []).filter(o=>!o.graphic).entries()) {  // GFX1: graphics are alpha layers, not stills
    const source=overlayPath(i.root,o.file);
    const {stdout}=await promisify(execFile)(tool('ffprobe'),['-v','error','-show_streams','-of','json',source]);
    const m=JSON.parse(stdout).streams[0],d=o.e-o.s, w=m.width,h=m.height;
    let file=source;
    if(o.corner==='round') {
      const stat=await fs.stat(source), radius=i.template.width*.03/(o.w*i.template.width/w);
      file=await cache({kind:'rounded-still',source,size:stat.size,mtime:stat.mtimeMs,radius},'.png',out=>ffmpeg(['-i',source,'-vf',`format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(${radius}-hypot(max(${radius}-X-0.5,max(X+0.5-(W-${radius}),0)),max(${radius}-Y-0.5,max(Y+0.5-(H-${radius}),0))),0,1)'`,'-frames:v','1','-threads','1',out],0));
    }
    file=await copy(file,`Overlay ${n+1}${path.extname(file)}`);
    const region={x:o.x-o.w/2,y:o.y-o.w*i.template.width/w*h/i.template.height/2,w:o.w,h:o.w*i.template.width/w*h/i.template.height};
    const clip={id:`overlay-${o.id}`,file,meta:{width:w,height:h,fps,durationS:Math.ceil(d*fps-1e-7)/fps,audioChannels:0}} as Clip;
    const animation = Array.from({length:Math.ceil(d*fps-1e-7)+1},(_,frame)=>{
      const t=Math.min(d,frame/fps),u=Math.max(0,Math.min(1,t/Math.min(.25,d/2))),v=Math.max(0,Math.min(1,(d-t)/Math.min(.15,d/2))),ease=1-(1-u)**3;
      let scale=1,opacity=1,y=0;
      if(o.enter!=='none')opacity*=Math.min(1,u*5);
      if(o.enter==='pop')scale=u<.7?.6+.44*(1-(1-u/.7)**3):1+.04*(1-(u-.7)/.3)**2;
      if(o.enter==='slide-up')y=i.template.width*.06*(1-ease);
      if(o.enter==='fade')opacity=ease;
      if(o.exit!=='none')opacity*=v;
      if(o.exit==='pop')scale*=.8+.2*v;
      return {t,scale,opacity,y};
    });
    result.push({clip,name:`Image overlay: ${o.id}`,s:o.s,d,track:Math.max(2,...result.map(p=>p.track))+1,owner:-1,region,still:true,alpha:true,rotation:o.rotate,animation,keys:[{t:0,s:0},{t:d,s:d}],frames:animation.map(k=>({t:k.t,...fullRegion}))});
  }
  i.pictures=result.map(p=>p.owner>=0 && !p.name.startsWith((i.cutList[p.owner]?.seg?.marker ?? '')+' / ') ? {...p,name:`${i.cutList[p.owner]?.seg?.marker ?? 'Picture'} / ${p.name}`} : p);
}

export function premierePictureTimeMap(p: PictureClip, fps: number) {
  if(p.still)return '';
  const reverse=p.keys[0].s>p.keys.at(-1)!.s;
  const span=Math.max(...p.keys.map(k=>k.s))-Math.min(...p.keys.map(k=>k.s))+(reverse?1/p.clip.meta!.fps:0);
  if(!reverse && p.keys.length===2 && Math.abs(span-p.d)<1e-7)return '';
  const parameter=(id:string,value:string|number)=>`<parameter><parameterid>${id}</parameterid><name>${id}</name><value>${value}</value></parameter>`;
  const keys=[...new Map(p.keys.map(k=>[Math.round(k.t*fps),k])).values()];
  return `<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>${parameter('speed',span/p.d*100)}${parameter('reverse',reverse?'TRUE':'FALSE')}${parameter('variablespeed',p.keys.length>2?1:0)}${parameter('frameblending','FALSE')}<parameter><parameterid>graphdict</parameterid><name>graphdict</name>${keys.map((k,n)=>`<keyframe><when>${Math.round(k.t*fps)}</when><value>${k.s*p.clip.meta!.fps}</value><interpolation><name>FCPCurve</name></interpolation>${n===0?'<speedkfin>TRUE</speedkfin>':''}${n===keys.length-1?'<speedkfout>TRUE</speedkfout>':''}</keyframe>`).join('')}</parameter></effect></filter>`;
}

/** Connected picture overlaps are opacity envelopes on separate native tracks.
 * Allocate before titles so the title lanes stay above every scene element. */
export function premierePictureLanes(pictures: PictureClip[], plan: ReturnType<typeof editorPlan>, fps: number) {
  const ends: number[] = [], assigned = new Map<PictureClip, PictureClip>();
  for(const p of [...pictures].filter(p=>p.track>0 && p.owner>=0).sort((a,b)=>a.s-b.s || a.track-b.track)) {
    let lane=p.track;while((ends[lane] ?? 0)>p.s+1e-7)lane++;
    ends[lane]=p.s+p.d;
    const item=plan.items[p.owner],outgoing=plan.items[p.owner+1]?.overlap ?? 0;
    const animation=item.overlap || outgoing ? Array.from({length:Math.ceil(p.d*fps-1e-7)+1},(_,n)=>{
      const t=Math.min(p.d,n/fps),at=p.s+t;
      return {t,scale:1,y:0,opacity:Math.max(0,Math.min(1,item.overlap?(at-item.startS)/item.overlap:1))*Math.max(0,Math.min(1,outgoing?(item.endS-at)/outgoing:1))};
    }) : p.animation;
    assigned.set(p,{...p,track:lane,animation});
  }
  const native=pictures.map(p=>assigned.get(p) ?? p),top=Math.max(0,...native.filter(p=>p.owner>=0).map(p=>p.track));
  let upper=top+1;
  return native.map(p=>p.owner<0 ? {...p,track:upper++} : p);
}
