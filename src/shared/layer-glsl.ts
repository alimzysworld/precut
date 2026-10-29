// AV4: how the viewer draws one picture layer of the stage, one copy: its layout uniforms and its fragment main()
// (the dim card, the motion blur taps, the circle and rounded corner masks, the layer's opacity). The Chrome viewer
// compiles it in WebGL (LivePlayer FRAGMENT) and the Apple player's presenter runs it translated to Metal
// (src/main/apple-shader.ts layerToMetal). Moved here unchanged from LivePlayer.tsx, as AV3 moved transform-glsl.ts.
export const layerUniformsGLSL = `uniform bool layoutCircle; uniform bool layoutSceneMask; uniform bool layoutDim; uniform vec3 layoutColour; uniform vec2 layoutPixels;
uniform float layoutRadius;
`;
export const layerMainGLSL = `void main(){
  vec2 sampleUV=clipPoint(uv);
  vec3 rgb;
  if(layoutDim) {
    rgb=layoutColour;
  } else if(any(notEqual(blurVector,vec2(0.)))) {
    rgb=vec3(0.);
    for(int tap=-4;tap<=4;tap++) rgb+=pictureAt(clamp(sampleUV+blurVector*float(tap)/8.,0.,1.))/9.;
  } else rgb=pictureAt(sampleUV);
  if (clipping) { if (max(max(rgb.r,rgb.g),rgb.b) >= .995) rgb=vec3(1.,0.,0.); else if (min(min(rgb.r,rgb.g),rgb.b) <= .005) rgb=vec3(0.,.2,1.); }
  float radius=min(layoutRadius,min(layoutPixels.x,layoutPixels.y)/2.);
  vec2 q=abs((uv-.5)*layoutPixels)-(layoutPixels/2.-radius);
  float distance=length(max(q,0.))+min(max(q.x,q.y),0.)-radius;
  float mask=layoutCircle?(layoutSceneMask?clamp(.5-(length((uv-.5)*layoutPixels)-min(layoutPixels.x,layoutPixels.y)/2.),0.,1.):clamp((.5-length(uv-.5))*min(layoutPixels.x,layoutPixels.y)/2.,0.,1.)):radius>0.?clamp(.5-distance,0.,1.):1.;
  color=vec4(rgb,opacity*mask);
}`;
