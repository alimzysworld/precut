import type { ClipTransform, CutEdit, CutVersion } from './schema';
export const TRANSFORM_DEFAULT = { zoom:1,x:0,y:0,rotate:0,crop:{l:0,r:0,t:0,b:0},flipH:false,flipV:false,constrain:true };
export function transformValue(value?:ClipTransform|null) { return {...TRANSFORM_DEFAULT,...value,crop:{...TRANSFORM_DEFAULT.crop,...value?.crop}}; }
export function validTransform(value:unknown):value is ClipTransform {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as ClipTransform;
  const ranges={zoom:[.5,4],x:[-2,2],y:[-2,2],rotate:[-45,45]};
  if(Object.keys(v).some(k=>!['zoom','x','y','rotate','crop','flipH','flipV','constrain'].includes(k)))return false;
  for(const [k,[lo,hi]] of Object.entries(ranges)){const n=v[k as 'zoom'];if(n!==undefined&&(!Number.isFinite(n)||n<lo||n>hi))return false;}
  for(const k of ['flipH','flipV','constrain'] as const)if(v[k]!==undefined&&typeof v[k]!=='boolean')return false;
  if(v.crop!==undefined){if(!v.crop||typeof v.crop!=='object'||Array.isArray(v.crop)||Object.entries(v.crop).some(([k,n])=>!['l','r','t','b'].includes(k)||typeof n!=='number'||!Number.isFinite(n)||n<0||n>.95))return false;
    const c=transformValue(v).crop;if(c.l+c.r>=.98||c.t+c.b>=.98)return false;}
  return true;
}
/** Inverse mapping in the already framed picture, in pixels to keep rotation isotropic. */
export function transformGeometry(value:ClipTransform|undefined|null,aspect:number) {
  aspect=Number.isFinite(aspect)&&aspect>0?aspect:1;
  const v=transformValue(value),angle=v.rotate*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  const constrain=v.constrain?Math.max(Math.abs(c)+Math.abs(s)/aspect,Math.abs(c)+Math.abs(s)*aspect):1;
  let scale=v.zoom*constrain,x=v.x,y=v.y;
  if(v.constrain&&v.zoom>=1){
    // Cover every viewport corner with the retained crop, including translation.
    // Centre the retained source area before solving its required enlargement.
    const halfW=(1-v.crop.l-v.crop.r)/2,halfH=(1-v.crop.t-v.crop.b)/2;
    const extentX=(Math.abs(c)/2+Math.abs(s)/aspect/2+Math.abs(c*v.x+s*v.y/aspect))/halfW;
    const extentY=(Math.abs(s)*aspect/2+Math.abs(c)/2+Math.abs(-s*v.x*aspect+c*v.y))/halfH;
    scale=Math.max(scale,extentX,extentY);if(scale>1)scale*=1+1e-7;
    const cx=(v.crop.l-v.crop.r)/2*(v.flipH?-1:1),cy=(v.crop.t-v.crop.b)/2*(v.flipV?-1:1);
    x-=scale*(c*cx-s*cy/aspect);y-=scale*(s*cx*aspect+c*cy);
  }
  return {...v,x,y,angle,c,s,scale,aspect};
}
export function transformPoint(value:ClipTransform|undefined|null,aspect:number,x:number,y:number){
  const g=transformGeometry(value,aspect),dx=(x-.5-g.x)*g.aspect,dy=y-.5-g.y;
  let u=(g.c*dx+g.s*dy)/g.aspect/g.scale+.5,v=(-g.s*dx+g.c*dy)/g.scale+.5;
  if(g.flipH)u=1-u;if(g.flipV)v=1-v;
  return {x:u,y:v,visible:u>=g.crop.l&&u<=1-g.crop.r&&v>=g.crop.t&&v<=1-g.crop.b};
}
export function levelAngle(dx:number,dy:number){let a=Math.atan2(dy,dx)*180/Math.PI;while(a>90)a-=180;while(a< -90)a+=180;return Math.max(-45,Math.min(45,Math.round(-a*10)/10));}
export function transformEdits(version:Pick<CutVersion,'pieceFx'>,pieces:number[],patch:ClipTransform|null):CutEdit {
  return {kind:'batch',label:patch===null?'Reset transform':'Changed transform',edits:[...new Set(pieces)].map(piece=>{
    const fx={...version.pieceFx?.[piece]};if(patch===null)delete fx.transform;else fx.transform={...fx.transform,...patch,...(patch.crop?{crop:{...fx.transform?.crop,...patch.crop}}:{})};
    if(fx.transform&&!validTransform(fx.transform))throw new Error('Choose a valid transform. Keep some picture after cropping.');
    return {kind:'pieceFx',piece,fx};
  })};
}
/** Sobel edge directions vote for near-horizontal or vertical straight lines. A
 * Hough distance vote rejects texture: a direction alone is not a horizon. */
export function detectLevel(gray:ArrayLike<number>,width:number,height:number):number|null {
  let edges:{x:number;y:number;nx:number;ny:number}[]=[];
  for(let y=2;y<height-2;y++)for(let x=2;x<width-2;x++){
    const at=(dx:number,dy:number)=>gray[(y+dy)*width+x+dx];
    const gx=-at(-1,-1)+at(1,-1)-2*at(-1,0)+2*at(1,0)-at(-1,1)+at(1,1),gy=-at(-1,-1)-2*at(0,-1)-at(1,-1)+at(-1,1)+2*at(0,1)+at(1,1);
    const w=Math.hypot(gx,gy);if(w<120)continue;
    edges.push({x,y,nx:gx/w,ny:gy/w});
  }
  if(edges.length<Math.min(width,height)*.4)return null;
  const stride=Math.max(1,Math.ceil(edges.length/8000));if(stride>1)edges=edges.filter((_,i)=>i%stride===0);
  const scores:{a:number;score:number}[]=[],horizons:{a:number;score:number}[]=[];
  for(let a=-45;a<=45;a+=.1){const rad=a*Math.PI/180,c=Math.cos(rad),s=Math.sin(rad),bins=new Map<string,number>(),upper=new Map<number,number>();
    for(const e of edges){for(const vertical of [false,true]){
      // Foreground kerbs and paving recede in perspective. They must not
      // outweigh the skyline/roof line when measuring a camera's roll.
      const rho=vertical?e.x*c+e.y*s:-e.x*s+e.y*c;const key=`${vertical}:${Math.round(rho/1.5)}`;bins.set(key,(bins.get(key)??0)+1);
      if(!vertical&&e.y>=height*.1&&e.y<=height*.6&&Math.abs(-e.nx*s+e.ny*c)>.98){const k=Math.round(rho/1.5);upper.set(k,(upper.get(k)??0)+1);}
    }}
    scores.push({a,score:Math.max(0,...bins.values())});
    horizons.push({a,score:Math.max(0,...upper.values())});
  }
  const pick=(votes:typeof scores,minimum:number)=>{
    votes.sort((a,b)=>b.score-a.score);const best=votes[0];
    const runner=votes.find(s=>Math.min(Math.abs(s.a-best.a),90-Math.abs(s.a-best.a))>1.5)?.score??0;
    if(best.score<minimum||runner>best.score*.92)return null;
    const peak=votes.filter(s=>s.score>=best.score*.995&&Math.abs(s.a-best.a)<.5);
    return Math.round(-peak.reduce((n,s)=>n+s.a,0)/peak.length*10)/10;
  };
  return pick(horizons,width*.7/stride)??pick(scores,Math.min(width,height)*.5/stride);
}

/** Apply saved output geometry to retained plans without re-preparing media. */
export function withClipTransforms<T extends {piece?:number;transform?:ClipTransform}>(pictures:T[],fx:CutVersion['pieceFx']):T[]{
 let changed=false;
 const next=pictures.map(p=>{const value=fx?.[p.piece??-1]?.transform;if(JSON.stringify(p.transform)===JSON.stringify(value))return p;changed=true;const copy={...p};if(value)copy.transform=value;else delete copy.transform;return copy;});
 return changed?next:pictures;
}

export function straightenForFlips(angle:number,value?:ClipTransform){
 return !!value?.flipH!==!!value?.flipV?-angle:angle;
}
