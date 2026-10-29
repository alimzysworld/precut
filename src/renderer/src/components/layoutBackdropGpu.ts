import {gradientParameters,layoutBackgroundGLSL} from '../../../shared/layout-effects';
import type {LayoutBackground} from '../../../shared/layout-presets';
/** Small backdrop shader. The picture shader grades a screen once into target(). */
export class LayoutBackdropPass {
  private program:WebGLProgram;private framebuffer:WebGLFramebuffer;private texture:WebGLTexture;private width=0;private height=0;
  constructor(private gl:WebGL2RenderingContext){
    const compile=(kind:number,source:string)=>{const shader=gl.createShader(kind)!;gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader)??'Background shader failed');return shader;};
    const vertex=compile(gl.VERTEX_SHADER,`#version 300 es
in vec2 position;out vec2 uv;void main(){uv=vec2((position.x+1.)*.5,(1.-position.y)*.5);gl_Position=vec4(position,0.,1.);}`);
    const fragment=compile(gl.FRAGMENT_SHADER,`#version 300 es
precision highp float;in vec2 uv;out vec4 color;uniform sampler2D picture;uniform float sourceAspect;uniform float outputAspect;
vec3 grade(vec3 c){return c;}vec2 turned(vec2 p){return vec2(p.x,1.-p.y);}
${layoutBackgroundGLSL}
void main(){color=vec4(drawBackdrop(),1.);}`);
    this.program=gl.createProgram()!;gl.attachShader(this.program,vertex);gl.attachShader(this.program,fragment);gl.bindAttribLocation(this.program,0,'position');gl.linkProgram(this.program);gl.deleteShader(vertex);gl.deleteShader(fragment);if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw Error('Background shader link failed');
    this.framebuffer=gl.createFramebuffer()!;this.texture=gl.createTexture()!;
  }
  target(width:number,height:number){
    const gl=this.gl;gl.activeTexture(gl.TEXTURE7);gl.bindTexture(gl.TEXTURE_2D,this.texture);
    if(width!==this.width||height!==this.height){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,width,height,0,gl.RGB,gl.UNSIGNED_BYTE,null);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);this.width=width;this.height=height;}
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.texture,0);gl.activeTexture(gl.TEXTURE0);
    return this.texture;
  }
  draw(background:LayoutBackground,width:number,height:number,imageTexture?:WebGLTexture,imageAspect=1){
    const gl=this.gl,p=gradientParameters(background),u=(name:string)=>gl.getUniformLocation(this.program,name);
    gl.useProgram(this.program);gl.viewport(0,0,width,height);gl.uniform1i(u('picture'),7);gl.uniform1f(u('sourceAspect'),width/height);gl.uniform1f(u('outputAspect'),width/height);
    gl.uniform1i(u('backdropKind'),background.kind==='screen'?1:background.kind==='image'?2:0);gl.uniform1f(u('backdropBlur'),(background.blur??0)*.0005);gl.uniform1f(u('backdropDim'),p.dim);gl.uniform1i(u('backdropCount'),p.colours.length);gl.uniform1i(u('backdropTaps'),81);gl.uniform2f(u('backdropDirection'),p.cos,p.sin);
    p.colours.forEach((colour,i)=>gl.uniform3f(u(`backdropStops[${i}]`),...colour));
    gl.activeTexture(gl.TEXTURE7);gl.bindTexture(gl.TEXTURE_2D,this.texture);
    gl.activeTexture(gl.TEXTURE6);gl.bindTexture(gl.TEXTURE_2D,imageTexture??this.texture);gl.uniform1i(u('backdropImage'),6);gl.uniform1f(u('backdropAspect'),imageAspect);
    gl.drawArrays(gl.TRIANGLES,0,6);gl.activeTexture(gl.TEXTURE0);
  }
  dispose(){const gl=this.gl;gl.deleteProgram(this.program);gl.deleteFramebuffer(this.framebuffer);gl.deleteTexture(this.texture);}
}
