// One numeric evaluator for export and generated GLSL. No renderer/Node state.
function mixerBound(v:number){return Math.max(0,Math.min(1,v));}
function mixerMod(v:number,n:number){return v-n*Math.floor(v/n);}
function mixerWeight(hue:number,centre:number){const d=Math.abs(mixerMod(hue-centre+540,360)-180);return d<60?.5+.5*Math.cos(3.141592653589793*d/60):0;}
export function mixerScalar(r:number,g:number,b:number,channel:number,p:number[]):number {
  const hi=Math.max(r,Math.max(g,b)),lo=Math.min(r,Math.min(g,b)),chroma=hi-lo,original=channel==0?r:channel==1?g:b;
  if(chroma<1e-10)return original;
  const raw=chroma<1e-8?0:hi==r?60*((g-b)/chroma):hi==g?60*((b-r)/chroma+2):60*((r-g)/chroma+4),hue=raw<0?raw+360:raw;
  const w0=mixerWeight(hue,0),w1=mixerWeight(hue,30),w2=mixerWeight(hue,60),w3=mixerWeight(hue,120),w4=mixerWeight(hue,180),w5=mixerWeight(hue,240),w6=mixerWeight(hue,275),w7=mixerWeight(hue,315);
  const dh=0+p[0]/100*30*w0+p[3]/100*30*w1+p[6]/100*30*w2+p[9]/100*30*w3+p[12]/100*30*w4+p[15]/100*30*w5+p[18]/100*30*w6+p[21]/100*30*w7;
  const ds=0+p[1]/100*w0+p[4]/100*w1+p[7]/100*w2+p[10]/100*w3+p[13]/100*w4+p[16]/100*w5+p[19]/100*w6+p[22]/100*w7;
  const dl=0+p[2]/100*w0+p[5]/100*w1+p[8]/100*w2+p[11]/100*w3+p[14]/100*w4+p[17]/100*w5+p[20]/100*w6+p[23]/100*w7;
  if(dh==0&&ds==0&&dl==0)return original;
  const light=(hi+lo)/2,sat=chroma/Math.max(1e-10,1-Math.abs(2*light-1));
  const ns=mixerBound(sat*Math.pow(2,ds)),nl=mixerBound(light+dl*.25*Math.min(1,chroma/.1));
  const c=(1-Math.abs(2*nl-1))*ns,h=mixerMod(hue+dh+360,360)/60,x=c*(1-Math.abs(mixerMod(h,2)-1)),m=nl-c/2;
  const red=h<1?c:h<2?x:h<4?0:h<5?x:c,green=h<1?x:h<3?c:h<4?x:0,blue=h<2?0:h<3?x:h<5?c:x;
  return mixerBound((channel==0?red:channel==1?green:blue)+m);
}
const functions={mixerBound,mixerMod,mixerWeight,mixerScalar};
export function mixerGLSL():string {
  return Object.entries(functions).map(([name,fn])=>{
    let source=fn.toString();for(const [canonical,actual]of Object.entries(functions))source=source.replace(new RegExp(`(?<![\\w$.])${actual.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![\\w$])`,'g'),canonical);
    source=source.replace(/\$/g,'_dollar');
    const parameters=source.slice(source.indexOf('(')+1,source.indexOf(')')).split(',').map((p,i)=>name==='mixerScalar'&&i===4?`float ${p.trim()}[24]`:`float ${p.trim()}`).join(',');
    const body=source.slice(source.indexOf('{')).replace(/\b(?:const|let|var)\b/g,'float').replace(/Math\.(pow|max|min|abs|floor|cos)/g,'$1')
      .replace(/(?<![\w.])(?:\d*\.\d+|\d+\.?)(?:e[+-]?\d+)?(?![\w.])/gi,(n,offset,text)=>text[offset-1]==='['?n:/[.e]/i.test(n)?n:`${n}.`).replace(/([^;{}\s])\s*}/g,'$1;}');
    return `float ${name}(${parameters}) ${body}`;
  }).join('\n')+`\nvec3 mixerPreview(vec3 rgb,float p[24]) { return vec3(mixerScalar(rgb.r,rgb.g,rgb.b,0.,p),mixerScalar(rgb.r,rgb.g,rgb.b,1.,p),mixerScalar(rgb.r,rgb.g,rgb.b,2.,p)); }`;
}
