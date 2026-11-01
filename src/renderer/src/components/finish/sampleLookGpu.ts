import { lookGLSL } from "../../../../shared/look-scalar";
import { lookParameters, neutralGrade } from "../../../../shared/grade-math";

/** Setup uses the export evaluator, with one shared canvas and no encoders on slider motion. */
export function sampleLookGpu(canvas: HTMLCanvasElement, photo: HTMLImageElement) {
  const gl = canvas.getContext("webgl2", { alpha: false, preserveDrawingBuffer: true });
  if (!gl) throw Error("Couldn't show the looks. Reopen this step to try again.");
  const compile = (kind: number, source: string) => {
    const shader = gl.createShader(kind)!; gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const message = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw Error(message ?? "Couldn't draw this look."); }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
    in vec2 position; out vec2 uv;
    void main(){uv=vec2((position.x+1.)*.5,(1.-position.y)*.5);gl_Position=vec4(position,0.,1.);}`);
  const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float; in vec2 uv; out vec4 colour;
    uniform sampler2D photo; uniform float look[18]; uniform vec2 crop;
    ${lookGLSL()}
    void main(){vec3 c=texture(photo,(uv-.5)*crop+.5).rgb;
      colour=vec4(lookScalar(c.r,c.g,c.b,0.,look),lookScalar(c.r,c.g,c.b,1.,look),lookScalar(c.r,c.g,c.b,2.,look),1.);}`);
  const program = gl.createProgram()!; gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error("Couldn't draw this look.");
  gl.useProgram(program);
  const buffer = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "position"); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, photo);
  const parameters = gl.getUniformLocation(program, "look[0]"), crop = gl.getUniformLocation(program, "crop");
  return {
    draw(preset: string, intensity: number, width: number, height: number) {
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      gl.viewport(0, 0, width, height);
      const ratio = width / height, source = photo.naturalWidth / photo.naturalHeight;
      gl.uniform2f(crop, Math.min(1, ratio / source), Math.min(1, source / ratio));
      gl.uniform1fv(parameters, lookParameters({ ...neutralGrade("rec709"), preset, intensity }));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    dispose() { gl.deleteTexture(texture); gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment); gl.getExtension("WEBGL_lose_context")?.loseContext(); },
  };
}
