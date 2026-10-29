import type {ClipTransform} from './schema';
import {transformGeometry} from './clip-transform';
/** Cropping follows source axes even after the framed picture is flipped/rotated. */
export function cropGesture(value:ClipTransform,kind:string,dx:number,dy:number,aspect:number){
 const g=transformGeometry(value,aspect),c={...g.crop};
 const x=(g.c*dx+g.s*dy/aspect)/g.scale*(g.flipH?-1:1),y=(-g.s*dx*aspect+g.c*dy)/g.scale*(g.flipV?-1:1);
 if(kind.includes('l'))c.l=Math.max(0,Math.min(.95,1-c.r-.03,c.l+x));
 if(kind.includes('r'))c.r=Math.max(0,Math.min(.95,1-c.l-.03,c.r-x));
 if(kind.includes('t'))c.t=Math.max(0,Math.min(.95,1-c.b-.03,c.t+y));
 if(kind.includes('b'))c.b=Math.max(0,Math.min(.95,1-c.t-.03,c.b-y));
 return {crop:c};
}

export function transformHandlePoints(value:ClipTransform|undefined,aspect:number){
 const g=transformGeometry(value,aspect),c=g.crop,l=c.l,r=1-c.r,t=c.t,b=1-c.b,mx=(l+r)/2,my=(t+b)/2;
 const source:Record<string,[number,number]>={tl:[l,t],t:[mx,t],tr:[r,t],l:[l,my],r:[r,my],bl:[l,b],b:[mx,b],br:[r,b],rotate:[mx,t-.08/g.scale]};
 const mapped=Object.fromEntries(Object.entries(source).map(([key,[x,y]])=>{const dx=(x-.5)*(g.flipH?-1:1),dy=(y-.5)*(g.flipV?-1:1);return[key,{x:.5+g.x+g.scale*(g.c*dx-g.s*dy/g.aspect),y:.5+g.y+g.scale*(g.s*dx*g.aspect+g.c*dy)}];}));
 // Clip the picture polygon, not the coordinates of individual handles. Rays
 // from its visible centre land exactly on the visible crop or viewport edge.
 type Point={x:number;y:number};let polygon=[mapped.tl,mapped.tr,mapped.br,mapped.bl];
 for(const [axis,bound,sign] of [['x',0,1],['x',1,-1],['y',0,1],['y',1,-1]] as const){
  const clipped:Point[]=[];
  for(let i=0;i<polygon.length;i++){const a=polygon[i],b=polygon[(i+1)%polygon.length],insideA=(a[axis]-bound)*sign>=0,insideB=(b[axis]-bound)*sign>=0;
   if(insideA)clipped.push(a);
   if(insideA!==insideB){const u=(bound-a[axis])/(b[axis]-a[axis]);clipped.push({x:a.x+u*(b.x-a.x),y:a.y+u*(b.y-a.y)});}
  }polygon=clipped;
 }
 const centre=polygon.length?{x:polygon.reduce((n,p)=>n+p.x,0)/polygon.length,y:polygon.reduce((n,p)=>n+p.y,0)/polygon.length}:{x:.5,y:.5};
 const cross=(a:Point,b:Point)=>a.x*b.y-a.y*b.x;
 const corners=['tl','tr','br','bl'],anchor=polygon.reduce((best,p,i)=>Math.hypot((p.x-mapped.tl.x)*g.aspect,p.y-mapped.tl.y)<Math.hypot((polygon[best].x-mapped.tl.x)*g.aspect,polygon[best].y-mapped.tl.y)?i:best,0);
 const points=Object.fromEntries(Object.entries(mapped).map(([key,target])=>{
  if(corners.includes(key)&&polygon.length>=4)return [key,polygon[(anchor+Math.round(corners.indexOf(key)*polygon.length/4))%polygon.length]];
  const d={x:target.x-centre.x,y:target.y-centre.y};let distance=Infinity;
  for(let i=0;i<polygon.length;i++){const a=polygon[i],b=polygon[(i+1)%polygon.length],edge={x:b.x-a.x,y:b.y-a.y},delta={x:a.x-centre.x,y:a.y-centre.y},den=cross(d,edge);if(Math.abs(den)<1e-12)continue;
   const u=cross(delta,edge)/den,v=cross(delta,d)/den;if(u>=0&&v>=-1e-9&&v<=1+1e-9)distance=Math.min(distance,u);
  }
  return [key,Number.isFinite(distance)?{x:centre.x+d.x*distance,y:centre.y+d.y*distance}:centre];
 }));
 // The rotation control sits inside the picture, clear of the crop handle.
 points.rotate={x:points.t.x+(points.t.x<.1?.09:points.t.x>.9?-.09:0),y:points.t.y+(points.t.y<.12?.09:-.09)};
 return points;
}
