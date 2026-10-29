// The clip transform's shader text, one copy: the Chrome viewer compiles it in WebGL (transformGpu.ts) and the Apple
// player's compositor runs it translated to Metal (src/main/apple-shader.ts transformToMetal). Moved here unchanged
// from transformGpu.ts (AV3) so main can read it without the renderer's WebGL types.
export const transformGLSL=`
uniform bool clipTransformEnabled;
uniform vec4 clipAffine; // cos/scale, sin/scale, x, y
uniform vec4 clipCrop;
uniform vec2 clipFlip;
vec2 clipPoint(vec2 at){
 if(!clipTransformEnabled)return at;
 vec2 p=(at-.5-clipAffine.zw)*vec2(outputAspect,1.);
 p=vec2(clipAffine.x*p.x+clipAffine.y*p.y,-clipAffine.y*p.x+clipAffine.x*p.y)/vec2(outputAspect,1.)+.5;
 p=mix(p,1.-p,clipFlip);
 if(any(lessThan(p,clipCrop.xy))||any(greaterThan(p,1.-clipCrop.zw)))discard;
 return p;
}`;
