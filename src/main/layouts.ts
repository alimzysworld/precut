import { pieceName } from "../shared/clip-name";
import type { CutEdit, DraftPiece, LayoutChoice } from '../shared/schema';
import type { StoredVersion } from './sidekick';
import { titleCardColour, layoutFrames, layoutRegions, type LayoutPicture } from './layout-math';
import { mediaUrl } from '../shared/media';
import { planFx } from './edits-fx';
import { runActivity } from './activity';
import { finishStoredVersion, renderStoredPreview } from './sidekick';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { importLayoutMedia, withLayoutMedia, type LayoutAssembly } from './layout-media';
import { scenePictures } from './layout-ranges';
import { withPieceLayout } from '../shared/layout-presets';
import { gradientFilter, backdropFilter } from '../shared/layout-effects';
import { fullRegion } from './layout-math';

export const layoutReadme = 'Layouts (screen, face bubble, split and title cards) appear in the finished MP4. The cuts-only editor timeline keeps original picture. Reapply the saved layouts and their screen source spans in the editor; the finished MP4 is the visual reference. Unfilled shot placeholders keep the original person picture.';
export async function writeLayoutDelivery(folder: string, root: string, layouts: StoredVersion['layouts'], clips: StoredVersion['assembly']['shoot']['clips'], nativePlaceholders = false): Promise<void> {
  if (!layouts?.some(Boolean)) return;
  const ids=new Set(layouts.flatMap(l=>[...(l?.screen ? [l.screen.clipId] : []),...Object.values(l?.sources??{}).map(s=>s.clipId)]));
  await fs.writeFile(path.join(folder,'layouts.json'),JSON.stringify({layouts,sources:clips.filter(c=>ids.has(c.id)).map(c=>({clipId:c.id,file:path.resolve(root,c.file)}))},null,2));
  if(layouts.some(l=>l?.kind==='scene')){
    if(!nativePlaceholders)await fs.appendFile(path.join(folder,'README.txt'),'\nTimed layout settings and source spans are in layouts.json. The finished MP4 carries the complete picture.\n');
    return;
  }
  if (nativePlaceholders && layouts.every(l => !l || l.kind === 'placeholder' || l.kind === 'face')) return;
  const readme=path.join(folder,'README.txt');
  let existing='';try{existing=await fs.readFile(readme,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const note = nativePlaceholders ? 'Screen, bubble, split and title-card layouts need to be reapplied from layouts.json using the finished MP4 as the visual reference. Shot placeholders are native named markers.' : layoutReadme;
  if (!existing.includes(note)) await fs.appendFile(readme,`\n${note} Settings and source files are in layouts.json.\n`);
}
export function appendLayoutComposite(filters: string[], parts: LayoutPicture[], width: number, height: number, fps: number, duration: number, prefix: string, output: string): void {
  const scene=parts.some(p=>p.layoutScene),format=scene?'rgb':'auto';
  const bg=parts.find(p=>p.layoutBackground)?.layoutBackground;
  if(bg&&['gradient','colour'].includes(bg.kind))filters.push(gradientFilter(bg,width,height,fps,duration,`${prefix}base`));
  else if(bg)filters.push(`[${prefix}backdrop]${backdropFilter(bg,width,height)}[${prefix}base]`);
  else filters.push(`color=c=black:s=${width}x${height}:r=${fps},trim=duration=${duration}[${prefix}base]`);
  for (const [i,part] of parts.entries()) {
    const region = part.layoutRegion ?? fullRegion, label = `${prefix}part${i}`;
    const expression=(key:'x'|'y'|'w'|'h',size:number)=>{
      const keys=part.layoutRegionKeys;if(!keys?.length)return String(Math.round(region[key]*size));
      let out=String(Math.round(keys.at(-1)![key]*size));
      for(let k=keys.length-2;k>=0;k--){const a=keys[k],b=keys[k+1];if(Math.abs(a[key]-b[key])<1e-8)continue;const at=a.t-part.startS,bt=b.t-part.startS;out=`if(lt(t,${bt}),${a[key]*size}+(${(b[key]-a[key])*size})*clip((t-${at})/${bt-at},0,1),${out})`;}
      return out;
    };
    let picture=label;
    const radius=(part.layoutRadius??0)*width/(part.layoutReferenceWidth??width);
    const shapeExpression=(key:'radius'|'opacity',scale=1)=>{
      const keys=part.layoutShapeKeys;if(!keys?.length)return String(key==='radius'?radius:1);
      let out=String(keys.at(-1)![key]*scale);
      for(let k=keys.length-2;k>=0;k--){const a=keys[k],b=keys[k+1];if(Math.abs(a[key]-b[key])<1e-8)continue;const at=a.t-part.startS,bt=b.t-part.startS;out=`if(lt(T,${bt}),${a[key]*scale}+(${(b[key]-a[key])*scale})*clip((T-${at})/${bt-at},0,1),${out})`;}
      return out;
    };
    if(part.layoutRaster){
      // One fixed canvas per frame: crop, placement, mask and opacity share
      // the live player's keys. Overlay never sees changing input dimensions.
      const short=(n:number)=>Number(n.toFixed(8)),keyed=(keys:({t:number}&Record<string,number>)[]|undefined,key:string,fallback:number)=>{
        if(!keys?.length)return String(short(fallback));let value=String(short(keys.at(-1)![key]));
        for(let k=keys.length-2;k>=0;k--){const a=keys[k],b=keys[k+1];if(Math.abs(a[key]-b[key])<1e-8)continue;const at=short(a.t-part.startS),bt=short(b.t-part.startS);value=`if(lt(T,${bt}),${short(a[key])}+(${short(b[key]-a[key])})*clip((T-${at})/${short(bt-at)},0,1),${value})`;}
        return value;
      };
      const regions=part.layoutRegionKeys??[{t:part.startS,...region}],left=Math.min(...regions.map(k=>Math.round(k.x*width))),top=Math.min(...regions.map(k=>Math.round(k.y*height)));
      const canvasW=Math.max(1,...regions.map(k=>Math.round(k.x*width)+Math.round(k.w*width)-left)),canvasH=Math.max(1,...regions.map(k=>Math.round(k.y*height)+Math.round(k.h*height)-top));
      const dest=(key:'x'|'y'|'w'|'h',size:number)=>`(round((${keyed(part.layoutRegionKeys as ({t:number}&Record<string,number>)[],key,region[key])})*${size})-${key==='x'?left:key==='y'?top:0})`;
      const init=`st(0,${dest('x',width)});st(1,${dest('y',height)});st(2,max(1,${dest('w',width)}));st(3,max(1,${dest('h',height)}));`;
      const inside='between(X,ld(0),ld(0)+ld(2)-1)*between(Y,ld(1),ld(1)+ld(3)-1)';
      // AVExpr state belongs to each channel/thread. Evaluate time-only curves
      // once per frame, then reuse the mask parameters for its pixels.
      const cached=(body:string)=>`if(eq(ld(8),0)+1-eq(ld(9),N),${body}st(8,1);st(9,N),0);`;
      const shape=`${init}st(4,min(${shapeExpression('radius',width/(part.layoutReferenceWidth??width))},min(ld(2),ld(3))/2));st(7,${shapeExpression('opacity')});`;
      const distance='st(5,abs(X+0.5-ld(0)-ld(2)/2)-(ld(2)/2-ld(4)));st(6,abs(Y+0.5-ld(1)-ld(3)/2)-(ld(3)/2-ld(4)));255*ld(7)*clip(0.5-(hypot(max(ld(5),0),max(ld(6),0))+min(max(ld(5),ld(6)),0)-ld(4)),0,1)';
      const mask=`${cached(shape)}if(${inside},${distance},0)`;
      filters.push(`[${label}]scale=w='max(1,round(${expression('w',width)}))':h='max(1,round(${expression('h',height)}))':eval=frame:flags=bilinear[${label}scaled]`);
      filters.push(`color=c=black@0:s=${canvasW}x${canvasH}:r=${fps},format=rgba,trim=duration=${duration}[${label}empty]`);
      filters.push(`[${label}empty][${label}scaled]overlay=x='round(${expression('x',width)})-${left}':y='round(${expression('y',height)})-${top}':shortest=1:format=auto,format=rgba[${label}placed]`);
      filters.push(`color=c=black:s=${canvasW}x${canvasH}:r=${fps},trim=duration=${duration},format=gray,geq=lum='${mask}'[${label}mask]`);
      filters.push(`[${label}placed][${label}mask]alphamerge[${label}warped]`);
      filters.push(`[${i?`${prefix}over${i-1}`:`${prefix}base`}][${label}warped]overlay=x=${left}:y=${top}:shortest=1:format=${format}[${prefix}over${i}]`);
      continue;
    }
    const animatedShape=part.layoutShapeKeys?.some(k=>Math.abs(k.radius-part.layoutShapeKeys![0].radius)>1e-7||Math.abs(k.opacity-part.layoutShapeKeys![0].opacity)>1e-7);
    if(part.layoutScene&&(radius>0||part.layoutCircle||part.layoutShapeKeys?.some(k=>k.radius>0||k.opacity<1))){
      const r=part.layoutCircle&&!part.layoutShapeKeys?'min(W,H)/2':`min(${shapeExpression('radius',width/(part.layoutReferenceWidth??width))},min(W,H)/2)`;
      const qx=`abs(X+0.5-W/2)-(W/2-(${r}))`,qy=`abs(Y+0.5-H/2)-(H/2-(${r}))`;
      const distance=`hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0)-(${r})`;
      const animated=animatedShape||part.layoutRegionKeys?.some(k=>Math.abs(k.w-region.w)>1e-7||Math.abs(k.h-region.h)>1e-7);
      if(animated){filters.push(`[${picture}]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*(${shapeExpression('opacity')})*clip(0.5-(${distance}),0,1)'[${label}circle]`);}
      else{
        filters.push(`color=c=black:s=${Math.round(region.w*width)}x${Math.round(region.h*height)}:r=${fps},trim=end_frame=1,format=gray,geq=lum='255*(${shapeExpression('opacity')})*clip(0.5-(${distance}),0,1)',loop=loop=-1:size=1:start=0,trim=duration=${duration},setpts=N/(${fps}*TB)[${label}mask]`);
        filters.push(`[${picture}][${label}mask]alphamerge[${label}circle]`);
      }
      picture=`${label}circle`;
    }else if (part.layoutCircle){filters.push(`[${picture}]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip((W/2-hypot(X+0.5-W/2,Y+0.5-H/2))/${2*width/960},0,1)'[${label}circle]`);picture=`${label}circle`;}
    filters.push(`[${i ? `${prefix}over${i-1}` : `${prefix}base`}][${picture}]overlay=x='round(${expression('x',width)})':y='round(${expression('y',height)})':shortest=1:format=${format}[${prefix}over${i}]`);
  }
  filters.push(`[${prefix}over${parts.length-1}]setsar=1,${scene?'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:range=tv':'format=yuv420p'}[${output}]`);
}
export function validateLayout(value: LayoutChoice | null, record: StoredVersion, piece: number): LayoutChoice | null {
  if (!Number.isInteger(piece) || !record.pieces?.[piece]) throw new Error('Choose a clip in this edit.');
  if (value === null) return null;
  if (!value || !['face','screen','bubble','split','title','placeholder'].includes(value.kind)) throw new Error('Choose a layout.');
  const layout: LayoutChoice = { kind: value.kind };
  if (['screen','bubble','split'].includes(value.kind)) {
    const clip = record.assembly.shoot.clips.find(c => c.id === value.screen?.clipId);
    const items = planFx(record.assembly.cutList, record.assembly.template.fps, record).items.filter(p => p.piece === piece);
    const duration = items.length ? items.at(-1)!.endS-items[0].startS : record.pieces[piece].lengthS;
    if (!clip?.meta || !clip.proxy || !value.screen || !Number.isFinite(value.screen.s) || value.screen.s < 0 || value.screen.s + duration > clip.meta.durationS + 1e-6) throw new Error('Choose a ready screen or B-roll clip with enough picture for this clip.');
    layout.screen = { clipId: clip.id, s: value.screen.s };
  }
  if (value.kind === 'bubble') {
    const bubble = value.bubble ?? { corner: 'br', size: .3 };
    if (!['tl','tr','bl','br'].includes(bubble.corner) || !Number.isFinite(bubble.size) || bubble.size < .2 || bubble.size > .45) throw new Error('Choose a bubble corner and a size from 20% to 45%.');
    layout.bubble = { ...bubble };
  }
  if (value.kind === 'title' || value.kind === 'placeholder') {
    const text = value.kind === 'title' ? value.title : value.note;
    if (typeof text !== 'string' || !text.trim() || text.length > 500) throw new Error(value.kind === 'title' ? 'Write a title of up to 500 characters.' : 'Describe the shot needed in up to 500 characters.');
    if (value.kind === 'title') layout.title = text.trim(); else layout.note = text.trim();
  }
  return layout;
}
export function editLayout(root: string, cutId: string, version: number, edit: Extract<CutEdit,{kind:'layout'}>) {
  return runActivity({ kind:'edit', root, target:{cutId,version}, label:'Updating layout', cancelable:true }, () =>
    finishStoredVersion(root,cutId,version,true,async(record,assembly) => {
      record.assembly = assembly;
      let input = edit.layout;
      if (input?.screen && path.isAbsolute(input.screen.clipId)) {
        if (record.layouts?.[edit.piece]?.kind !== 'placeholder') throw new Error('Drop Finder media onto a shot placeholder.');
        const items = planFx(assembly.cutList,assembly.template.fps,record).items.filter(p => p.piece === edit.piece);
        if (!items.length) throw new Error('Choose a shot placeholder.');
        const clip = await importLayoutMedia(root,input.screen.clipId,input.screen.s+items.at(-1)!.endS-items[0].startS);
        const mediaAssembly: LayoutAssembly = {...assembly,layoutMedia:[...(assembly as LayoutAssembly).layoutMedia ?? [],clip]};
        mediaAssembly.shoot = withLayoutMedia(mediaAssembly);
        record.assembly = mediaAssembly;
        input = {...input,screen:{clipId:clip.id,s:input.screen.s}};
      }
      const layout = validateLayout(input,record,edit.piece);
      record.layouts = withPieceLayout(record.layouts,record.pieces!.length,edit.piece,layout);
      record.feedback = layout?.kind === 'placeholder' ? `Shot needed: ${layout.note}` : `Changed ${pieceName(record.assembly.shoot, record, edit.piece)} layout to ${layout?.kind ?? 'face'}`;
      if (!assembly.reel.why.includes(layoutReadme)) assembly.reel.why += `\n\n${layoutReadme}`;
      await renderStoredPreview(root,cutId,record,record.assembly);
      return {cutId,version:record.version};
    }));
}
/** Layouts decorate the final time-mapped pictures, so filler cuts, speeds,
 * dissolves and reverse keep their own source and reel clocks. */
export function layoutPictures(pictures: DraftPiece[], record: Pick<StoredVersion,'layouts'|'assembly'|'pieceFx'|'titles'>): LayoutPicture[] {
  if (!record.layouts?.some(Boolean)) return pictures;
  if (record.layouts.some(l=>l?.kind==='scene')) return scenePictures(layoutPictures(pictures,{...record,layouts:record.layouts.map(l=>l?.kind==='scene'?null:l)}),record,pictures);
  const { shoot, template } = record.assembly, {width,height,fps} = template;
  const starts = new Map<number,number>();
  for (const p of pictures.filter(p => p.layer === 0)) starts.set(p.piece ?? 0,Math.min(starts.get(p.piece ?? 0) ?? Infinity,p.startS));
  return pictures.flatMap((piece): LayoutPicture[] => {
    const layout = record.layouts?.[piece.piece ?? 0];
    if (!layout || layout.kind === 'face' || layout.kind === 'placeholder') return [piece];
    if (piece.layer === 1) return []; // Explicit scene layout replaces connected picture.
    if (layout.kind === 'title') return [{...piece,layoutDim:true,layoutColour:titleCardColour(record.titles?.captionStyle?.accent)}];
    const face = shoot.clips.find(c => c.id === piece.clipId), screen = shoot.clips.find(c => c.id === layout.screen?.clipId);
    if (!face?.meta || !screen?.meta || !screen.proxy || !layout.screen) throw new Error('A layout source is missing. Reconnect its footage.');
    const regions = layoutRegions(layout,width,height);
    const screenIn = layout.screen.s+piece.startS-starts.get(piece.piece ?? 0)!;
    const screenPiece: LayoutPicture = {...piece,clipId:screen.id,proxy:mediaUrl(shoot.root,'proxies',screen.proxy),inS:screenIn,timeMap:undefined,frame:null,
      layoutRegion:regions.screen,layoutCircle:false,layoutScreen:true,layer:layout.kind === 'split' ? 1 : 0,blur:undefined};
    screenPiece.frame = layoutFrames(screenPiece,screen,regions.screen!,width,height,fps,false).map(k => {
      // Screens stay centred rather than following an incidental webcam face.
      const w=k.w,h=k.h; return {...k,x:(1-w)/2,y:(1-h)/2};
    });
    if (!regions.face) return [screenPiece];
    const facePiece: LayoutPicture = {...piece,layer:layout.kind === 'bubble' ? 1 : 0,layoutRegion:regions.face,layoutCircle:regions.circle,
      blur:undefined,frame:layoutFrames(piece,face,regions.face,width,height,fps,!!regions.circle,!!record.pieceFx?.[piece.piece ?? 0]?.reverse)};
    return layout.kind === 'bubble' ? [screenPiece,facePiece] : [facePiece,screenPiece];
  }).sort((a,b) => a.layer-b.layer || a.startS-b.startS);
}

/** Missing is plain text in the contract. Anchor exact quoted/line references,
 * or an exact spoken quote. Ambiguous notes stay visible as warnings. */
export function seedMissingLayouts(record: StoredVersion): void {
  for (const note of record.missing ?? []) {
    const line = /\bline\s+(\d+)\b/i.exec(note), quoted = /["“]([^"”]+)["”]/.exec(note)?.[1]?.toLowerCase();
    const matches = (record.pieces ?? []).flatMap((p,i) => {
      const text = `${p.words ?? ''} ${p.description ?? ''}`.toLowerCase();
      const score = line ? Number(p.id.startsWith(`L${line[1]}A`)) : quoted ? Number(text.includes(quoted)) : 0;
      return score ? [{i,score}] : [];
    }).sort((a,b) => b.score-a.score);
    const best = matches[0];
    if (!best || matches[1]?.score === best.score) { record.warnings.push(`Place shot needed manually: ${note}`); continue; }
    record.layouts = withPieceLayout(record.layouts,record.pieces!.length,-1,null);
    const existing = record.layouts[best.i];
    if (!existing) record.layouts[best.i] = {kind:'placeholder',note};
    else if (existing.kind === 'placeholder' && !existing.note?.includes(note)) record.layouts[best.i] = {...existing,note:`${existing.note}\n${note}`};
  }
}
