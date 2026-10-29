import type { GrainChoice } from "../../../../shared/schema";
import { grainPlateValues, GRAIN_TILE } from "./grainMath";

/** One tiny texture per active choice. Steady playback performs one bilinear
 * sample per pixel, with no procedural hash or per-frame texture upload. */
export class GrainPlate {
  private texture: WebGLTexture;
  private key="";
  constructor(private gl: WebGL2RenderingContext) { this.texture=gl.createTexture()!; }
  bind(grain: GrainChoice, unit: number) {
    const gl=this.gl,key=`${grain.roughness}:${grain.colour}`;
    gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,this.texture);
    if(key===this.key) return;
    const values=grainPlateValues(grain),rgba=new Float32Array(GRAIN_TILE*GRAIN_TILE*4);
    for(let i=0;i<GRAIN_TILE*GRAIN_TILE;i++){rgba.set(values.subarray(i*3,i*3+3),i*4);rgba[i*4+3]=1;}
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16F,GRAIN_TILE,GRAIN_TILE,0,gl.RGBA,gl.FLOAT,rgba);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.REPEAT);
    this.key=key;
  }
  dispose(){this.gl.deleteTexture(this.texture);}
}
