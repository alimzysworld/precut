// A numeric subset of TypeScript, emitted verbatim as GLSL below. These are the
// export evaluator too: there is no separately maintained shader formula.
function lookBound(v:number){return Math.max(0,Math.min(1,v));}
function lookSmooth(a:number,b:number,x:number){const t=lookBound((x-a)/(b-a));return t*t*(3-2*t);}
function lookLinear(v:number){return v<.081?v/4.5:Math.pow((v+.099)/1.099,1/.45);}
function lookDisplay(v:number){return v<.018?4.5*v:1.099*Math.pow(Math.max(0,v),.45)-.099;}
function lookLuma(r:number,g:number,b:number){return .2126*r+.7152*g+.0722*b;}
function lookHue(r:number,g:number,b:number){
  const hi=Math.max(r,Math.max(g,b)),lo=Math.min(r,Math.min(g,b)),ch=hi-lo;
  const h=ch<1e-8?0:hi==r?60*((g-b)/ch):hi==g?60*((b-r)/ch+2):60*((r-g)/ch+4);
  return h<0?h+360:h;
}
function lookTone(v:number,ev:number,contrast:number,gain:number){
  const x=lookDisplay(lookLinear(v)*Math.pow(2,ev));
  return (x<=.41?.41*Math.pow(Math.max(0,x)/.41,contrast):1-.59*Math.pow(Math.max(0,1-x)/.59,contrast))*gain;
}
function lookSplit(v:number,y:number,sat:number,fade:number,strength:number,intensity:number,shadow:number,highlight:number){
  const level=lookBound(y);
  const x=y+(v-y)*sat+intensity*(shadow*Math.pow(1-level,2)+highlight*Math.pow(level,2));
  const softened=x>.75&&strength>0?.75+(x-.75)/(1+strength*(x-.75)/.25):x;
  return lookBound(fade+softened*(1-fade));
}
function lookSkin(r:number,g:number,b:number){const hue=lookHue(r,g,b);const h=hue>180?hue-360:hue;return lookSmooth(-40,-10,h)*(1-lookSmooth(80,110,h));}
function lookProtect(r:number,g:number,b:number,x:number,y:number,z:number,ch:number,sat:number,skin:number){
  const chroma=Math.max(r,Math.max(g,b))-Math.min(r,Math.min(g,b)),before=lookLuma(r,g,b),after=lookLuma(x,y,z);
  if(chroma<1e-8)return after;
  let scale=before>0?after/before*sat:0;
  const dr=r-before,dg=g-before,db=b-before;
  scale=dr>0?Math.min(scale,(1-after)/dr):scale;scale=dr<0?Math.min(scale,-after/dr):scale;
  scale=dg>0?Math.min(scale,(1-after)/dg):scale;scale=dg<0?Math.min(scale,-after/dg):scale;
  scale=db>0?Math.min(scale,(1-after)/db):scale;scale=db<0?Math.min(scale,-after/db):scale;
  const v=ch==0?x:ch==1?y:z,source=ch==0?r:ch==1?g:b;
  return skin>0?lookBound(v+(after+(source-before)*scale-v)*skin):v;
}
function lookLab(v:number){return v>216/24389?Math.cbrt(v):(24389/27*v+16)/116;}
function lookLabInverse(v:number){return v>6/29?Math.pow(v,3):(116*v-16)*27/24389;}
function lookShift(ch:number,fx:number,fy:number,fz:number,a:number,b:number,weight:number,scale:number){
  const x=.9504559271*lookLabInverse(fx+a*weight*scale/500),y=lookLabInverse(fy),z=1.0890577508*lookLabInverse(fz-b*weight*scale/200);
  return ch==0?3.2409699419*x-1.5373831776*y-.4986107603*z:ch==1?-.9692436363*x+1.8759675015*y+.0415550574*z:.0556300797*x-.2039769589*y+1.0569715142*z;
}
function lookGamut(r:number,g:number,b:number){return r>=0&&r<=1&&g>=0&&g<=1&&b>=0&&b<=1?1:0;}
function lookCast(r:number,g:number,b:number,ch:number,a:number,castB:number,amount:number){
  const lr=Math.pow(Math.max(0,r),2.4),lg=Math.pow(Math.max(0,g),2.4),lb=Math.pow(Math.max(0,b),2.4);
  const fx=lookLab((.4123907993*lr+.3575843394*lg+.1804807884*lb)/.9504559271),fy=lookLab(.2126390059*lr+.7151686788*lg+.0721923154*lb),fz=lookLab((.0193308187*lr+.1191947798*lg+.9505321522*lb)/1.0890577508);
  const lightness=116*fy-16,weight=amount*lookSmooth(0,25,lightness)*(1-lookSmooth(85,100,lightness));
  const original=ch==0?r:ch==1?g:b;
  if(weight==0)return original;
  let x=lookShift(0,fx,fy,fz,a,castB,weight,1),y=lookShift(1,fx,fy,fz,a,castB,weight,1),z=lookShift(2,fx,fy,fz,a,castB,weight,1);
  if(lookGamut(x,y,z)==0){
    let low=0,high=1;
    for(let i=0;i<20;i++){
      const mid=(low+high)/2;
      if(lookGamut(lookShift(0,fx,fy,fz,a,castB,weight,mid),lookShift(1,fx,fy,fz,a,castB,weight,mid),lookShift(2,fx,fy,fz,a,castB,weight,mid))==1)low=mid;else high=mid;
    }
    if(low==0)return original;
    x=lookShift(0,fx,fy,fz,a,castB,weight,low);y=lookShift(1,fx,fy,fz,a,castB,weight,low);z=lookShift(2,fx,fy,fz,a,castB,weight,low);
  }
  x=Math.pow(lookBound(x),1/2.4);y=Math.pow(lookBound(y),1/2.4);z=Math.pow(lookBound(z),1/2.4);
  const before=lookLuma(r,g,b),after=lookLuma(x,y,z),v=ch==0?x:ch==1?y:z;
  return after>before?v*before/after:v;
}
function lookFilmFade(v:number,amount:number){return amount==0?v:lookBound(.15*amount+v*(1-.19*amount));}
export function lookScalar(r:number,g:number,b:number,ch:number,p:number[]):number {
  const tr=lookTone(r,p[0],p[1],1+p[2]*.08+p[3]*.035),tg=lookTone(g,p[0],p[1],1-p[3]*.035),tb=lookTone(b,p[0],p[1],1-p[2]*.08+p[3]*.035),luma=lookLuma(tr,tg,tb);
  let x=lookSplit(tr,luma,p[4],p[5],p[6],p[7],p[9],p[12]),y=lookSplit(tg,luma,p[4],p[5],p[6],p[7],p[10],p[13]),z=lookSplit(tb,luma,p[4],p[5],p[6],p[7],p[11],p[14]);
  if(p[8]==0&&p[7]>0){
    const skin=lookSkin(r,g,b);
    const rx=lookProtect(r,g,b,x,y,z,0,p[4],skin),gy=lookProtect(r,g,b,x,y,z,1,p[4],skin),bz=lookProtect(r,g,b,x,y,z,2,p[4],skin);
    x=rx;y=gy;z=bz;
    if(p[15]!=0||p[16]!=0){const chroma=Math.max(r,Math.max(g,b))-Math.min(r,Math.min(g,b));return lookFilmFade(lookCast(x,y,z,ch,p[15],p[16],p[7]*(1-.4*skin*lookSmooth(0,.018,chroma))),p[17]);}
  }
  return lookFilmFade(ch==0?x:ch==1?y:z,p[17]);
}
const functions={lookBound,lookSmooth,lookLinear,lookDisplay,lookLuma,lookHue,lookTone,lookSplit,lookSkin,lookProtect,lookLab,lookLabInverse,lookShift,lookGamut,lookCast,lookFilmFade,lookScalar};
export function lookGLSL(){
  return Object.entries(functions).map(([name,fn])=>{
    let source=fn.toString();for(const [canonical,actual]of Object.entries(functions))source=source.replace(new RegExp(`(?<![\\w$.])${actual.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![\\w$])`,'g'),canonical);
    source=source.replace(/\$/g,'_dollar');
    const parameters=source.slice(source.indexOf('(')+1,source.indexOf(')')).split(',').map((p,i)=>name==='lookScalar'&&i===4?`float ${p.trim()}[18]`:`float ${p.trim()}`).join(',');
    let body=source.slice(source.indexOf('{')).replace(/Math\.cbrt\((\w+)\)/g,'pow($1,1./3.)').replace(/\b(?:const|let|var)\b/g,'float').replace(/Math\.(pow|max|min|abs)/g,'$1');
    // Indices remain integers; every other numeric literal is a GLSL float.
    body=body.replace(/(?<![\w.])(?:\d*\.\d+|\d+\.?)(?:e[+-]?\d+)?(?![\w.])/gi,(n,offset,text)=>text[offset-1]==='['?n:/[.e]/i.test(n)?n:`${n}.`).replace(/([^;{}\s])\s*}/g,'$1;}');
    return `float ${name}(${parameters}) ${body}`;
  }).join('\n');
}

// AV2: the per piece grade stage shared by the Chrome viewer's shader (LivePlayer FRAGMENT) and the Apple
// player's Metal compositor (src/main/apple-shader.ts translates it). The maths inside comes from the scalar
// emitters (basicsGLSL, lookGLSL, mixerGLSL); this part only says the order they run in, once, for both players.
// Kept in this file, which imports nothing, so every renderer harness that already loads it gets the stage too.

/** Tetrahedral sampling of a colour table (red fastest), the same six cases the finishing tables use. */
export const TABLE_AT_GLSL = `vec3 tableAt(sampler3D table,vec3 rgb,float tableSize,int offset){
  vec3 p=clamp(rgb,0.,1.)*(tableSize-1.);
  ivec3 lo=min(ivec3(floor(p)),ivec3(int(tableSize)-2));
  vec3 f=p-vec3(lo); lo.z+=offset;
  ivec3 a; ivec3 b; vec3 w;
  if(f.r>=f.g){
    if(f.g>=f.b){a=ivec3(1,0,0);b=ivec3(1,1,0);w=f.rgb;}
    else if(f.r>=f.b){a=ivec3(1,0,0);b=ivec3(1,0,1);w=f.rbg;}
    else{a=ivec3(0,0,1);b=ivec3(1,0,1);w=f.brg;}
  }else{
    if(f.r>=f.b){a=ivec3(0,1,0);b=ivec3(1,1,0);w=f.grb;}
    else if(f.g>=f.b){a=ivec3(0,1,0);b=ivec3(0,1,1);w=f.gbr;}
    else{a=ivec3(0,0,1);b=ivec3(0,1,1);w=f.bgr;}
  }
  vec3 c0=texelFetch(table,lo,0).rgb;
  vec3 c1=texelFetch(table,lo+a,0).rgb;
  vec3 c2=texelFetch(table,lo+b,0).rgb;
  vec3 c3=texelFetch(table,lo+ivec3(1),0).rgb;
  return c0+w.x*(c1-c0)+w.y*(c2-c1)+w.z*(c3-c2);
}`;

/** One vertex of a piece's live grade, after its base table: exposure gains, basics before the look, the look,
 * the mixer, basics after. Needs basicsGLSL(), lookGLSL() and mixerGLSL() before it. */
export const GRADE_VERTEX_GLSL = `vec3 gradeVertexWith(vec3 basis,vec4 gain,float basics[10],float look[18],float mixer[24]){
  basis=vec3(basicDisplay(basicLinear(basis.r)*gain.r),basicDisplay(basicLinear(basis.g)*gain.g),basicDisplay(basicLinear(basis.b)*gain.b));
  basis=basicBeforeOnly(basis,basics);
  vec3 looked=vec3(lookScalar(basis.r,basis.g,basis.b,0.,look),lookScalar(basis.r,basis.g,basis.b,1.,look),lookScalar(basis.r,basis.g,basis.b,2.,look));
  return clamp(basicAfterOnly(mixerPreview(looked,mixer),basics),0.,1.);
}`;

/** The live grade is evaluated on this lattice of the base table's output and interpolated between (33 points). */
export const GRADE_LATTICE = 32;
