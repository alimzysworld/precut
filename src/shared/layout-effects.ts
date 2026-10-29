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
export function backdropFilter(bg:LayoutBackground,width:number,height:number):string{
  const radius=(bg.blur??0)*.0005*width,dim=1-(bg.dim??0)/100;
  if(!radius)return `format=gbrp,lutrgb=r='val*${dim}':g='val*${dim}':b='val*${dim}'`;
  const taps=Array.from({length:9},(_,i)=>i-4),weights=taps.map(n=>Math.exp(-n*n/8)),total=weights.reduce((a,b)=>a+b,0);
  const pass=(axis:'x'|'y',gain:number)=>'geq='+['r','g','b'].map(ch=>`${ch}='(${taps.map((n,i)=>`${ch}(clip(X+${axis==='x'?n*radius/4:0},0,W-1),clip(Y+${axis==='y'?n*radius/4:0},0,H-1))*${weights[i]}`).join('+')})/${total}*${gain}'`).join(':');
  return 'format=gbrp,'+pass('x',1)+','+pass('y',dim);
}
