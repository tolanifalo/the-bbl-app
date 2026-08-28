import type { GridMesh } from "./mesh.ts";
import { createProgram } from "./glutil.ts";

/**
 * Layered compositor (Milestone 3). Renders:
 *   1. a static textured QUAD (the clean plate — never warped), opaque;
 *   2. the PERSON mesh (the M1 warp geometry) textured with a premultiplied
 *      person layer, blended ONE / ONE_MINUS_SRC_ALPHA over the plate.
 * Plus an optional wireframe. The background never enters the warp.
 *
 * Same vertex transform as the M1 renderer (image px -> clip via camera). This
 * consumes the M1 mesh + its deformed positions; it does not touch the warp/MLS.
 */

const VERT_SRC = `#version 300 es
in vec2 a_position;
in vec2 a_uv;
uniform float u_scale;
uniform vec2 u_offset;
uniform vec2 u_canvas;
out vec2 v_uv;
void main() {
  vec2 screen = a_position * u_scale + u_offset;
  vec2 clip = vec2(screen.x / (u_canvas.x * 0.5) - 1.0, 1.0 - screen.y / (u_canvas.y * 0.5));
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = a_uv;
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform int u_mode;      // 0 textured, 1 flat (wireframe)
uniform vec4 u_flatColor;
out vec4 outColor;
void main() {
  outColor = (u_mode == 1) ? u_flatColor : texture(u_tex, v_uv);
}`;

export interface ViewUniforms {
  scale: number;
  offsetX: number;
  offsetY: number;
  canvasW: number;
  canvasH: number;
}

export class Compositor {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vaoQuad: WebGLVertexArrayObject;
  private vaoMesh: WebGLVertexArrayObject;
  private quadPos: WebGLBuffer;
  private quadUv: WebGLBuffer;
  private meshUv: WebGLBuffer;
  private meshPos: WebGLBuffer;
  private meshTri: WebGLBuffer;
  private meshLine: WebGLBuffer;
  private positions = new Float32Array(0);
  private triCount = 0;
  private lineCount = 0;

  private uScale: WebGLUniformLocation;
  private uOffset: WebGLUniformLocation;
  private uCanvas: WebGLUniformLocation;
  private uTex: WebGLUniformLocation;
  private uMode: WebGLUniformLocation;
  private uFlat: WebGLUniformLocation;
  private aPosition: number;
  private aUv: number;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VERT_SRC, FRAG_SRC);
    const need = (n: string) => {
      const l = gl.getUniformLocation(this.program, n);
      if (!l) throw new Error("Missing uniform " + n);
      return l;
    };
    this.uScale = need("u_scale");
    this.uOffset = need("u_offset");
    this.uCanvas = need("u_canvas");
    this.uTex = need("u_tex");
    this.uMode = need("u_mode");
    this.uFlat = need("u_flatColor");
    this.aPosition = gl.getAttribLocation(this.program, "a_position");
    this.aUv = gl.getAttribLocation(this.program, "a_uv");

    this.vaoQuad = gl.createVertexArray()!;
    this.vaoMesh = gl.createVertexArray()!;
    this.quadPos = gl.createBuffer()!;
    this.quadUv = gl.createBuffer()!;
    this.meshUv = gl.createBuffer()!;
    this.meshPos = gl.createBuffer()!;
    this.meshTri = gl.createBuffer()!;
    this.meshLine = gl.createBuffer()!;
  }

  setMesh(mesh: GridMesh): void {
    const gl = this.gl;
    const W = mesh.width;
    const H = mesh.height;

    // Plate quad covering the image, uv 0..1.
    gl.bindVertexArray(this.vaoQuad);
    const quadPos = new Float32Array([0, 0, W, 0, 0, H, W, H]);
    const quadUv = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadPos);
    gl.bufferData(gl.ARRAY_BUFFER, quadPos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.aPosition);
    gl.vertexAttribPointer(this.aPosition, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadUv);
    gl.bufferData(gl.ARRAY_BUFFER, quadUv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.aUv);
    gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);

    // Person mesh (M1 geometry).
    this.positions = new Float32Array(mesh.vertexCount * 2);
    this.triCount = mesh.triIndices.length;
    this.lineCount = mesh.lineIndices.length;
    gl.bindVertexArray(this.vaoMesh);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshUv);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.aUv);
    gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshPos);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aPosition);
    gl.vertexAttribPointer(this.aPosition, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshTri);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.triIndices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshLine);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.lineIndices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
  }

  updatePersonPositions(dstX: Float32Array, dstY: Float32Array, count: number): void {
    const p = this.positions;
    for (let k = 0; k < count; k++) {
      p[k * 2] = dstX[k];
      p[k * 2 + 1] = dstY[k];
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshPos);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, p);
  }

  private setView(u: ViewUniforms): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform1f(this.uScale, u.scale);
    gl.uniform2f(this.uOffset, u.offsetX, u.offsetY);
    gl.uniform2f(this.uCanvas, u.canvasW, u.canvasH);
  }

  /** Opaque textured quad (plate, original image, before-half). */
  drawQuad(texture: WebGLTexture, u: ViewUniforms): void {
    const gl = this.gl;
    this.setView(u);
    gl.disable(gl.BLEND);
    gl.uniform1i(this.uMode, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.uTex, 0);
    gl.bindVertexArray(this.vaoQuad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /** Person mesh, premultiplied-alpha over whatever is already in the buffer. */
  drawPerson(texture: WebGLTexture, u: ViewUniforms): void {
    const gl = this.gl;
    this.setView(u);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(this.uMode, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.uTex, 0);
    gl.bindVertexArray(this.vaoMesh);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshTri);
    gl.drawElements(gl.TRIANGLES, this.triCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  drawWireframe(u: ViewUniforms): void {
    const gl = this.gl;
    this.setView(u);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(this.uMode, 1);
    gl.uniform4f(this.uFlat, 0.15, 0.9, 0.55, 0.5);
    gl.bindVertexArray(this.vaoMesh);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshLine);
    gl.drawElements(gl.LINES, this.lineCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}
