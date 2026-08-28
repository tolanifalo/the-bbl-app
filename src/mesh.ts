/**
 * Grid mesh generation. Pure / DOM-free (shared with the Node acceptance test).
 *
 * The grid is defined in image-space pixels: `srcX/srcY` are the *undeformed*
 * vertex positions (also the basis for texture coordinates). Each frame the MLS
 * engine writes deformed positions into a separate buffer; texcoords stay fixed,
 * which is what warps the sampled image.
 */

export interface GridMesh {
  /** Quads per row / column. */
  readonly cols: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  readonly vertexCount: number;
  /** Undeformed vertex X in image px. */
  readonly srcX: Float32Array;
  /** Undeformed vertex Y in image px. */
  readonly srcY: Float32Array;
  /** Texcoord U in [0,1]. */
  readonly u: Float32Array;
  /** Texcoord V in [0,1], 0 at image top (texture uploaded flipped). */
  readonly v: Float32Array;
  /** Interleaved [u,v] per vertex for a static GL attribute. */
  readonly uv: Float32Array;
  /** Triangle indices. */
  readonly triIndices: Uint16Array;
  /** Wireframe (grid line) indices. */
  readonly lineIndices: Uint16Array;
}

export function createGridMesh(
  cols: number,
  rows: number,
  width: number,
  height: number,
): GridMesh {
  const nx = cols + 1;
  const ny = rows + 1;
  const vertexCount = nx * ny;

  const srcX = new Float32Array(vertexCount);
  const srcY = new Float32Array(vertexCount);
  const u = new Float32Array(vertexCount);
  const v = new Float32Array(vertexCount);
  const uv = new Float32Array(vertexCount * 2);

  for (let i = 0; i < ny; i++) {
    const fy = i / rows;
    for (let j = 0; j < nx; j++) {
      const fx = j / cols;
      const idx = i * nx + j;
      srcX[idx] = fx * width;
      srcY[idx] = fy * height;
      u[idx] = fx;
      v[idx] = fy;
      uv[idx * 2] = fx;
      uv[idx * 2 + 1] = fy;
    }
  }

  const triIndices = new Uint16Array(cols * rows * 6);
  let t = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const tl = i * nx + j;
      const tr = tl + 1;
      const bl = (i + 1) * nx + j;
      const br = bl + 1;
      // Two triangles, consistent winding (used by the fold-over test).
      triIndices[t++] = tl;
      triIndices[t++] = bl;
      triIndices[t++] = tr;
      triIndices[t++] = tr;
      triIndices[t++] = bl;
      triIndices[t++] = br;
    }
  }

  // Wireframe: right + down edge from each vertex (avoids double-drawing).
  const lineList: number[] = [];
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      const idx = i * nx + j;
      if (j < nx - 1) lineList.push(idx, idx + 1);
      if (i < ny - 1) lineList.push(idx, idx + nx);
    }
  }
  const lineIndices = new Uint16Array(lineList);

  return {
    cols,
    rows,
    width,
    height,
    vertexCount,
    srcX,
    srcY,
    u,
    v,
    uv,
    triIndices,
    lineIndices,
  };
}
