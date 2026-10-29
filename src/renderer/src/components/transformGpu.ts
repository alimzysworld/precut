import type {ClipTransform} from '../../../shared/schema';
import {transformGeometry} from '../../../shared/clip-transform';
export {transformGLSL} from '../../../shared/transform-glsl';
export function paintTransform(gl:WebGL2RenderingContext,uniform:(name:string)=>WebGLUniformLocation|null,value:ClipTransform|undefined,aspect:number){
 gl.uniform1i(uniform('clipTransformEnabled'),value?1:0);
 if(!value)return;
 const g=transformGeometry(value,aspect);
 gl.uniform4f(uniform('clipAffine'),g.c/g.scale,g.s/g.scale,g.x,g.y);
 gl.uniform4f(uniform('clipCrop'),g.crop.l,g.crop.t,g.crop.r,g.crop.b);
 gl.uniform2f(uniform('clipFlip'),g.flipH?1:0,g.flipV?1:0);
}
