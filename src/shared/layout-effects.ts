import type {LayoutBackground} from './layout-presets';
export const rgb=(hex:string)=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255) as [number,number,number];
export function gradientParameters(bg:LayoutBackground){
  const colours=(bg.kind==='colour'?[bg.colour??'#191a20',bg.colour??'#191a20']:bg.stops??['#182d40','#486c75']).map(rgb);
  const rad=(bg.angle??135)*Math.PI/180;
  return {colours,cos:Math.cos(rad),sin:Math.sin(rad),dim:1-(bg.dim??0)/100};
}
/** The same Gaussian samples, edge clamp and linear RGB interpolation in both compositors. */
export const layoutBackgroundGLSL=`
uniform bool layoutBackdrop; uniform int backdropKind; uniform float backdropBlur; uniform float backdropDim;
uniform sampler2D backdropImage; uniform float backdropAspect; uniform vec3 backdropStops[3]; uniform int backdropCount; uniform int backdropTaps; uniform vec2 backdropDirection;
vec3 backdropAt(vec2 at) {
  float ar=backdropKind==2?backdropAspect:sourceAspect;
  vec2 size=ar>outputAspect?vec2(outputAspect/ar,1.):vec2(1.,ar/outputAspect);
  vec2 point=(clamp(at,0.,1.)-.5)*size+.5;
  return backdropKind==2?texture(backdropImage,point).rgb:grade(texture(picture,turned(point)).rgb);
}
vec3 drawBackdrop(){
  if(backdropKind==0){
    float u=clamp(.5+dot(uv-.5,backdropDirection)/(abs(backdropDirection.x)+abs(backdropDirection.y)),0.,1.);
    vec3 c=backdropCount==3?(u<.5?mix(backdropStops[0],backdropStops[1],u*2.):mix(backdropStops[1],backdropStops[2],u*2.-1.)):mix(backdropStops[0],backdropStops[1],u);
    return c*backdropDim;
  }
  vec3 c=vec3(0.);float total=0.;
  for(int tap=0;tap<backdropTaps;tap++){float x=float(tap%9-4),y=float(tap/9-4);float weight=exp(-(x*x+y*y)/8.);c+=backdropAt(uv+vec2(x,y*outputAspect)*backdropBlur/4.)*weight;total+=weight;}
  return c/total*backdropDim;
}
`;
export function gradientFilter(bg:LayoutBackground,width:number,height:number,fps:number,duration:number,label:string):string {
  const p=gradientParameters(bg),u=`clip(0.5+((X/W-0.5)*${p.cos}+(Y/H-0.5)*${p.sin})/${Math.abs(p.cos)+Math.abs(p.sin)},0,1)`;
  const expressions=[0,1,2].map(ch=>{
    const a=p.colours[0][ch]*255,b=p.colours[1][ch]*255;
    return p.colours.length===3?`if(lt(${u},0.5),${a}+(${b-a})*(${u})*2,${b}+(${p.colours[2][ch]*255-b})*((${u})*2-1))*${p.dim}`:`(${a}+(${b-a})*(${u}))*${p.dim}`;
  });
  return `color=c=black:s=${width}x${height}:r=${fps},trim=end_frame=1,format=gbrp,geq=r='${expressions[0]}':g='${expressions[1]}':b='${expressions[2]}',loop=loop=-1:size=1:start=0,trim=duration=${duration},setpts=N/(${fps}*TB)[${label}]`;
}
/** The nine viewer taps (offsets n*radius/4, weights exp(-n^2/8)) with their bilinear reads folded into one separable
 * pixel kernel, edges clamped. Longest half-width is ceil(radius), at most MAX_HALF (47 taps). */
const MAX_HALF=23,COEFFICIENT_SCALE=65536;
export function backdropKernel(radius:number,gain=1):number[]{
  const half=Math.max(1,Math.ceil(radius)),taps=Array.from({length:9},(_,i)=>i-4),weights=taps.map(n=>Math.exp(-n*n/8)),total=weights.reduce((a,b)=>a+b,0);
  const kernel=new Array<number>(2*half+1).fill(0);
  taps.forEach((n,i)=>{const d=n*radius/4,f=Math.floor(d),frac=d-f,w=weights[i]/total*gain;kernel[f+half]+=w*(1-frac);if(frac>0)kernel[f+1+half]+=w*frac;});
  return kernel;
}
function blurPasses(radius:number,dim:number):string{
  const half=Math.max(1,Math.ceil(radius)),pass=(mode:'row'|'column',gain:number)=>{
    // convolution keeps whole-number coefficients, so scale the weights up and divide back with rdiv.
    const m=backdropKernel(radius,gain).map(v=>Math.round(v*COEFFICIENT_SCALE)).join(' ');
    return [0,1,2].map(p=>`${p}m='${m}':${p}rdiv=${1/COEFFICIENT_SCALE}:${p}mode=${mode}`).join(':');
  };
  // Padding is smeared (edge pixels repeated), as the old geq clamp did; convolution alone would mirror.
  return `pad=iw+${2*half}:ih+${2*half}:${half}:${half},fillborders=left=${half}:right=${half}:top=${half}:bottom=${half}:mode=smear,convolution=${pass('row',1)},convolution=${pass('column',dim)},crop=iw-${2*half}:ih-${2*half}:${half}:${half}`;
}
export function backdropFilter(bg:LayoutBackground,width:number,height:number):string{
  const radius=(bg.blur??0)*.0005*width,dim=1-(bg.dim??0)/100;
  if(!radius)return `format=gbrp,lutrgb=r='val*${dim}':g='val*${dim}':b='val*${dim}'`;
  if(radius<=MAX_HALF)return 'format=gbrp,'+blurPasses(radius,dim);
  // Wider than 47 taps reach: blur a smaller picture (same spread in picture terms) and scale it back up.
  const k=Math.ceil(radius/MAX_HALF),w=Math.max(2,Math.round(width/k)),h=Math.max(2,Math.round(height/k));
  return `format=gbrp,scale=${w}:${h}:flags=area,${blurPasses(radius*w/width,dim)},scale=${width}:${height}:flags=bilinear`;
}
