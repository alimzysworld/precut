import type { DetailChoice } from "../../../../shared/schema";
import { DETAIL_KERNEL, DETAIL_STEPS, DETAIL_SCREEN, DETAIL_LUMA, detailGLSL, NO_DETAIL } from "./detailMath";

const vertex=`#version 300 es
in vec2 position;out vec2 uv;void main(){uv=(position+1.)*.5;gl_Position=vec4(position,0.,1.);}`;
const header=`#version 300 es
precision highp float;in vec2 uv;out vec4 color;uniform sampler2D source;`;
const seed=`${header}
${detailGLSL()}
void main(){float l=dot(texture(source,uv).rgb,vec3(${DETAIL_LUMA.join(",")}));color=vec4(l,h12_bloom(l),0.,1.);}`;
const blur=`${header}
uniform vec2 direction;void main(){color=vec4(0.);${DETAIL_KERNEL.map((k,i)=>`color+=texture(source,uv+direction*${i-2}.0)*${k}.0/16.;`).join("")}}`;
const finish=`${header}
uniform sampler2D level0,level1,level2,level4;
uniform float amount,radius,detail,masking,textureAmount,clarity,diffusion;uniform bool maskOnly;
${detailGLSL()}
void main(){vec2 px=1./vec2(textureSize(source,0));
float l=texture(level0,uv).r;
float edge=max(abs(texture(level0,uv+vec2(px.x,0.)).r-texture(level0,uv-vec2(px.x,0.)).r),abs(texture(level0,uv+vec2(0.,px.y)).r-texture(level0,uv-vec2(0.,px.y)).r));
float mask=h12_mask(edge,masking);
float delta=h12_delta(l,texture(level1,uv).r,texture(level2,uv).r,texture(level4,uv).r,edge,amount,radius,detail,masking,textureAmount,clarity);
vec3 rgb=clamp(texture(source,uv).rgb+delta,0.,1.);
rgb+=(1.-rgb)*texture(level4,uv).g*diffusion*${DETAIL_SCREEN};
color=vec4(maskOnly?vec3(mask):rgb,1.);}`;

/** Reuses one full-resolution separable pyramid for every spatial control.
 * No readback, uploads, allocations or shader compilation in the frame loop. */
export class DetailPass {
  private programs: WebGLProgram[]=[];
  private textures: WebGLTexture[]=[];
  // Completeness is stable until storage changes; querying each pass forces a
  // synchronous GPU round trip in the middle of playback.
  private validated = new Set<WebGLTexture>();
  private framebuffer: WebGLFramebuffer;
  private width=0; private height=0;
  constructor(private gl: WebGL2RenderingContext) {
    if(!gl.getExtension("EXT_color_buffer_float")) throw new Error("Detail preview needs floating point framebuffers.");
    this.framebuffer=gl.createFramebuffer()!;
    for(const fragment of [seed,blur,finish]) {
      const program=gl.createProgram()!;
      for(const [kind,code] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]] as const) {
        const shader=gl.createShader(kind)!;gl.shaderSource(shader,code);gl.compileShader(shader);
        if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)??"Detail shader failed");
        gl.attachShader(program,shader);gl.deleteShader(shader);
      }
      gl.bindAttribLocation(program,0,"position");gl.linkProgram(program);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error("Detail shader link failed");
      this.programs.push(program);
    }
    for(let i=0;i<7;i++) this.textures.push(gl.createTexture()!);
  }
  draw(source: WebGLTexture,width: number,height: number,choice: DetailChoice | null,maskOnly=false): WebGLTexture {
    const gl=this.gl,d=choice??NO_DETAIL;
    if(this.width!==width||this.height!==height) {
      this.validated.clear();
      for(const texture of this.textures) {
        gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16F,width,height,0,gl.RGBA,gl.HALF_FLOAT,null);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      }
      this.width=width;this.height=height;
    }
    const bind=(program: WebGLProgram,name: string,tex: WebGLTexture,unit: number)=>{gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,tex);gl.uniform1i(gl.getUniformLocation(program,name),unit);};
    const target=(tex: WebGLTexture)=>{gl.bindFramebuffer(gl.FRAMEBUFFER,this.framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);if(!this.validated.has(tex)){if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error("Detail framebuffer unavailable");this.validated.add(tex);}gl.viewport(0,0,width,height);};
    gl.useProgram(this.programs[0]);bind(this.programs[0],"source",source,3);target(this.textures[0]);gl.drawArrays(gl.TRIANGLES,0,6);
    const count=d.clarity||d.diffusion?4:d.texture||d.radius>1?2:1;
    for(let i=0;i<count;i++) {
      const program=this.programs[1];gl.useProgram(program);
      bind(program,"source",this.textures[i],3);target(this.textures[5]);gl.uniform2f(gl.getUniformLocation(program,"direction"),DETAIL_STEPS[i]/width,0);gl.drawArrays(gl.TRIANGLES,0,6);
      bind(program,"source",this.textures[5],3);target(this.textures[i+1]);gl.uniform2f(gl.getUniformLocation(program,"direction"),0,DETAIL_STEPS[i]/height);gl.drawArrays(gl.TRIANGLES,0,6);
    }
    const program=this.programs[2];gl.useProgram(program);
    bind(program,"source",source,3);bind(program,"level0",this.textures[0],4);bind(program,"level1",this.textures[1],5);bind(program,"level2",this.textures[Math.min(2,count)],6);bind(program,"level4",this.textures[count],7);
    for(const [name,value] of Object.entries(d)) gl.uniform1f(gl.getUniformLocation(program,name==="texture"?"textureAmount":name),value);
    gl.uniform1i(gl.getUniformLocation(program,"maskOnly"),maskOnly?1:0);
    target(this.textures[6]);gl.drawArrays(gl.TRIANGLES,0,6);
    return this.textures[6];
  }
  dispose(){for(const t of this.textures)this.gl.deleteTexture(t);for(const p of this.programs)this.gl.deleteProgram(p);this.gl.deleteFramebuffer(this.framebuffer);}
}
