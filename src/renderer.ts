import type { GridMesh } from "./mesh.ts";
import { createProgram } from "./glutil.ts";

const VERT_SRC = `#version 300 es
in vec2 a_position;   // deformed vertex, image-space px
in vec2 a_uv;         // static texcoord in [0,1]
uniform float u_scale;
uniform vec2 u_offset; // CSS px
uniform vec2 u_canvas; // logical viewport size (CSS px for preview, image px for export)
out vec2 v_uv;
void main() {
  vec2 screen = a_position * u_scale + u_offset;
  vec2 clip = vec2(
    screen.x / (u_canvas.x * 0.5) - 1.0,
    1.0 - screen.y / (u_canvas.y * 0.5)
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = a_uv;
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform int u_mode;       // 0 = textured, 1 = flat color (wireframe)
uniform vec4 u_flatColor;
out vec4 outColor;
void main() {
  if (u_mode == 1) {
    outColor = u_flatColor;
  } else {
    outColor = texture(u_tex, v_uv);
  }
}`;

export interface DrawParams {
  texture: WebGLTexture;
  scale: number;
  offsetX: number;
  offsetY: number;
  canvasW: number;
  canvasH: number;
  showWireframe: boolean;
}

export class MeshRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uvBuffer: WebGLBuffer;
  private posBuffer: WebGLBuffer;
  private triBuffer: WebGLBuffer;
  private lineBuffer: WebGLBuffer;
  private positions: Float32Array = new Float32Array(0); // interleaved xy scratch
  private triCount = 0;
  private lineCount = 0;

  private uScale: WebGLUniformLocation;
  private uOffset: WebGLUniformLocation;
  private uCanvas: WebGLUniformLocation;
  private uTex: WebGLUniformLocation;
  private uMode: WebGLUniformLocation;
  private uFlatColor: WebGLUniformLocation;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VERT_SRC, FRAG_SRC);

    const need = (name: string): WebGLUniformLocation => {
      const loc = gl.getUniformLocation(this.program, name);
      if (!loc) throw new Error("Missing uniform " + name);
      return loc;
    };
    this.uScale = need("u_scale");
    this.uOffset = need("u_offset");
    this.uCanvas = need("u_canvas");
    this.uTex = need("u_tex");
    this.uMode = need("u_mode");
    this.uFlatColor = need("u_flatColor");

    this.vao = gl.createVertexArray()!;
    this.uvBuffer = gl.createBuffer()!;
    this.posBuffer = gl.createBuffer()!;
    this.triBuffer = gl.createBuffer()!;
    this.lineBuffer = gl.createBuffer()!;
  }

  /** (Re)upload a mesh: static uv + indices, and allocate the dynamic pos buffer. */
  setMesh(mesh: GridMesh): void {
    const gl = this.gl;
    const aPosition = gl.getAttribLocation(this.program, "a_position");
    const aUv = gl.getAttribLocation(this.program, "a_uv");

    this.positions = new Float32Array(mesh.vertexCount * 2);
    this.triCount = mesh.triIndices.length;
    this.lineCount = mesh.lineIndices.length;

    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.triIndices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.lineIndices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
  }

  /** Interleave deformed vertex positions and upload them. */
  updatePositions(dstX: Float32Array, dstY: Float32Array, count: number): void {
    const p = this.positions;
    for (let k = 0; k < count; k++) {
      p[k * 2] = dstX[k];
      p[k * 2 + 1] = dstY[k];
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, p);
  }

  /** Draw into the currently bound framebuffer / viewport. */
  draw(params: DrawParams): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.uniform1f(this.uScale, params.scale);
    gl.uniform2f(this.uOffset, params.offsetX, params.offsetY);
    gl.uniform2f(this.uCanvas, params.canvasW, params.canvasH);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, params.texture);
    gl.uniform1i(this.uTex, 0);

    // Textured fill: no blending so exported pixels are exact.
    gl.disable(gl.BLEND);
    gl.uniform1i(this.uMode, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triBuffer);
    gl.drawElements(gl.TRIANGLES, this.triCount, gl.UNSIGNED_SHORT, 0);

    if (params.showWireframe) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1i(this.uMode, 1);
      gl.uniform4f(this.uFlatColor, 0.15, 0.9, 0.55, 0.5);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineBuffer);
      gl.drawElements(gl.LINES, this.lineCount, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.BLEND);
    }

    gl.bindVertexArray(null);
  }
}
