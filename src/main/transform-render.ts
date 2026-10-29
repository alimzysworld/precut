import type {ClipTransform} from '../shared/schema';
import {transformGeometry,transformPoint} from '../shared/clip-transform';
/** Only sample the source area that can reach the viewport. A 4x zoom must not
 * allocate a 4x (or larger constrained) full-frame raster. */
export function transformRasterBounds(value:ClipTransform,width:number,height:number){
 const g=transformGeometry(value,width/height),corners=[[0,0],[1,0],[0,1],[1,1]].map(([x,y])=>transformPoint(value,width/height,x,y));
 const x=Math.max(0,Math.floor(g.crop.l*width),Math.floor(Math.min(...corners.map(p=>p.x))*width)-3),y=Math.max(0,Math.floor(g.crop.t*height),Math.floor(Math.min(...corners.map(p=>p.y))*height)-3);
 const right=Math.min(width,Math.ceil((1-g.crop.r)*width),Math.ceil(Math.max(...corners.map(p=>p.x))*width)+3),bottom=Math.min(height,Math.ceil((1-g.crop.b)*height),Math.ceil(Math.max(...corners.map(p=>p.y))*height)+3);
 const w=right-x,h=bottom-y,dx=((x+w/2)/width-.5)*width*g.scale*(g.flipH?-1:1),dy=((y+h/2)/height-.5)*height*g.scale*(g.flipV?-1:1);
 return {x,y,w,h,sw:Math.max(1,Math.round(w*g.scale)),sh:Math.max(1,Math.round(h*g.scale)),centerX:width*(.5+g.x)+g.c*dx-g.s*dy,centerY:height*(.5+g.y)+g.s*dx+g.c*dy};
}
/** Transform one framed raster, retaining alpha so smaller pictures reveal layouts. */
export function clipTransformGraph(input:string,output:string,value:ClipTransform,width:number,height:number,fps:number,duration:number){
 const g=transformGeometry(value,width/height),b=transformRasterBounds(value,width,height);
 const canvas=`color=c=black@0:s=${width}x${height}:r=${fps},trim=duration=${duration},format=rgba`;
 if(b.w<1||b.h<1)return [`[${input}]nullsink`,`${canvas}[${output}]`];
 const filters=['format=rgba',`crop=${b.w}:${b.h}:${b.x}:${b.y}:exact=1`];
 if(g.flipH)filters.push('hflip');if(g.flipV)filters.push('vflip');
 filters.push(`scale=${b.sw}:${b.sh}:flags=bilinear`,`rotate=${g.angle}:ow=ceil(rotw(${g.angle})):oh=ceil(roth(${g.angle})):c=black@0:bilinear=1`);
 return [`[${input}]${filters.join(',')}[${output}turned]`,`${canvas}[${output}canvas]`,`[${output}canvas][${output}turned]overlay=x=${b.centerX}-w/2:y=${b.centerY}-h/2:format=auto:shortest=1[${output}]`];
}

/** Moving layout boxes temporarily stretch a fixed raster. Sample in that
 * frame's actual box aspect, then let the shared layout warp place the raster. */
export function clipTransformMorphGraph(input:string,output:string,value:ClipTransform,aspects:number[]){
 aspects=transformAspects(aspects);
 const g=transformGeometry(value,aspects[0]),num=(n:number)=>String(Number(n.toFixed(12)));
 const keys=aspects.map((aspect,n)=>({n,...transformGeometry(value,aspect)})).filter((k,i,a)=>i===0||k.aspect!==a[i-1].aspect);
 const sample=(field:'aspect'|'scale'|'x'|'y')=>{let expression=num(keys.at(-1)![field]);for(let i=keys.length-2;i>=0;i--)expression=`if(lt(N,${keys[i+1].n}),${num(keys[i][field])},${expression})`;return expression;};
 const aspect=sample('aspect'),scale=sample('scale');
 const c=num(g.c),s=num(g.s),px=`((X+.5)/W-.5-(${sample('x')}))`,py=`((Y+.5)/H-.5-(${sample('y')}))`;
 const setup=`st(2,${aspect});st(3,${scale});st(0,(${c}*${px}+${s}*${py}/ld(2))/ld(3)+.5);st(1,(-(${s})*${px}*ld(2)+${c}*${py})/ld(3)+.5);${g.flipH?'st(0,1-ld(0));':''}${g.flipV?'st(1,1-ld(1));':''}`;
 const inside=`gte(ld(0),${num(g.crop.l)})*lte(ld(0),${num(1-g.crop.r)})*gte(ld(1),${num(g.crop.t)})*lte(ld(1),${num(1-g.crop.b)})`;
 const channel=(fn:string)=>`'${setup}if(${inside},${fn}(ld(0)*W-.5,ld(1)*H-.5),0)'`;
 return [`[${input}]format=rgba,geq=r=${channel('r')}:g=${channel('g')}:b=${channel('b')}:a=${channel('alpha')}:interpolation=bilinear,format=rgba[${output}]`];
}

export function transformAspects(aspects:number[],fallback=1){
 const first=aspects.find(a=>Number.isFinite(a)&&a>0)??fallback;
 return aspects.map(a=>Number.isFinite(a)&&a>0?a:first);
}
