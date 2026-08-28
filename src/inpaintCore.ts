/**
 * Clean-plate inpainting core (Milestone 3). Pure / DOM-free so it runs in a
 * web worker and can be reasoned about independently. PatchMatch quality is M4;
 * this is multi-scale diffusion.
 *
 * States per pixel:
 *   0 VALID   — known background, a source for diffusion (never modified)
 *   1 FILL    — the band, to be inpainted
 *   2 BLOCKED — deep person interior, ignored (never a source, never revealed)
 */
export const VALID = 0;
export const FILL = 1;
export const BLOCKED = 2;

/** Chamfer (3,4-style) distance to the nearest seed==1 pixel, in px. */
export function chamferDistance(seed: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = seed[i] ? 0 : INF;
  const A = 1;
  const B = Math.SQRT2;
  const relax = (i: number, j: number, cost: number) => {
    const v = d[j] + cost;
    if (v < d[i]) d[i] = v;
  };
  // Forward pass.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      if (x > 0) relax(i, i - 1, A);
      if (y > 0) relax(i, i - w, A);
      if (x > 0 && y > 0) relax(i, i - w - 1, B);
      if (x < w - 1 && y > 0) relax(i, i - w + 1, B);
    }
  }
  // Backward pass.
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      if (x < w - 1) relax(i, i + 1, A);
      if (y < h - 1) relax(i, i + w, A);
      if (x < w - 1 && y < h - 1) relax(i, i + w + 1, B);
      if (x > 0 && y < h - 1) relax(i, i + w - 1, B);
    }
  }
  return d;
}

/**
 * Band = (matte dilated by `dilatePx`) MINUS (matte eroded by `erodePx`).
 * Returns the per-pixel state array (VALID / FILL / BLOCKED).
 */
export function buildBandState(
  binary: Uint8Array,
  w: number,
  h: number,
  dilatePx: number,
  erodePx: number,
): Uint8Array {
  const person = binary; // 1 = person
  const bg = new Uint8Array(w * h);
  for (let i = 0; i < bg.length; i++) bg[i] = person[i] ? 0 : 1;

  const distToPerson = chamferDistance(person, w, h); // 0 on person, grows out
  const distToBg = chamferDistance(bg, w, h); // 0 on bg, grows into person

  const state = new Uint8Array(w * h);
  for (let i = 0; i < state.length; i++) {
    const isPerson = person[i] === 1;
    const inDilated = isPerson || distToPerson[i] <= dilatePx;
    const inEroded = isPerson && distToBg[i] >= erodePx;
    state[i] = !inDilated ? VALID : inEroded ? BLOCKED : FILL;
  }
  return state;
}

interface Level {
  w: number;
  h: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  state: Uint8Array;
}

function buildLevel0(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, state: Uint8Array): Level {
  const n = w * h;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = rgba[i * 4];
    g[i] = rgba[i * 4 + 1];
    b[i] = rgba[i * 4 + 2];
  }
  return { w, h, r, g, b, state };
}

function downsample(prev: Level): Level {
  const w = Math.max(1, Math.ceil(prev.w / 2));
  const h = Math.max(1, Math.ceil(prev.h / 2));
  const n = w * h;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  const state = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr = 0, sg = 0, sb = 0, cValid = 0;
      let hasValid = false, hasFill = false;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const px = Math.min(prev.w - 1, x * 2 + dx);
          const py = Math.min(prev.h - 1, y * 2 + dy);
          const j = py * prev.w + px;
          const st = prev.state[j];
          if (st === VALID) {
            hasValid = true;
            sr += prev.r[j]; sg += prev.g[j]; sb += prev.b[j]; cValid++;
          } else if (st === FILL) {
            hasFill = true;
          }
        }
      }
      const i = y * w + x;
      state[i] = hasValid ? VALID : hasFill ? FILL : BLOCKED;
      if (cValid > 0) {
        r[i] = sr / cValid;
        g[i] = sg / cValid;
        b[i] = sb / cValid;
      }
    }
  }
  return { w, h, r, g, b, state };
}

/** Jacobi smoothing of FILL pixels from VALID/FILL 4-neighbours (skip BLOCKED). */
function jacobi(level: Level, fillIdx: Int32Array, iters: number): void {
  const { w, h, r, g, b, state } = level;
  const tr = new Float32Array(fillIdx.length);
  const tg = new Float32Array(fillIdx.length);
  const tb = new Float32Array(fillIdx.length);
  for (let it = 0; it < iters; it++) {
    for (let k = 0; k < fillIdx.length; k++) {
      const i = fillIdx[k];
      const x = i % w;
      const y = (i / w) | 0;
      let sr = 0, sg = 0, sb = 0, c = 0;
      if (x > 0 && state[i - 1] !== BLOCKED) { sr += r[i - 1]; sg += g[i - 1]; sb += b[i - 1]; c++; }
      if (x < w - 1 && state[i + 1] !== BLOCKED) { sr += r[i + 1]; sg += g[i + 1]; sb += b[i + 1]; c++; }
      if (y > 0 && state[i - w] !== BLOCKED) { sr += r[i - w]; sg += g[i - w]; sb += b[i - w]; c++; }
      if (y < h - 1 && state[i + w] !== BLOCKED) { sr += r[i + w]; sg += g[i + w]; sb += b[i + w]; c++; }
      if (c > 0) { tr[k] = sr / c; tg[k] = sg / c; tb[k] = sb / c; }
      else { tr[k] = r[i]; tg[k] = g[i]; tb[k] = b[i]; }
    }
    for (let k = 0; k < fillIdx.length; k++) {
      const i = fillIdx[k];
      r[i] = tr[k]; g[i] = tg[k]; b[i] = tb[k];
    }
  }
}

function fillIndices(level: Level): Int32Array {
  const idx: number[] = [];
  for (let i = 0; i < level.state.length; i++) if (level.state[i] === FILL) idx.push(i);
  return Int32Array.from(idx);
}

function bilinear(arr: Float32Array, w: number, h: number, fx: number, fy: number): number {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = arr[y0 * w + x0], bb = arr[y0 * w + x1];
  const c = arr[y1 * w + x0], dd = arr[y1 * w + x1];
  return a * (1 - tx) * (1 - ty) + bb * tx * (1 - ty) + c * (1 - tx) * ty + dd * tx * ty;
}

/**
 * Multi-scale diffusion inpaint. Returns a fresh RGBA (opaque) with FILL pixels
 * replaced by diffused background; VALID and BLOCKED pixels keep their original
 * colour.
 */
export function inpaintDiffusion(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  state: Uint8Array,
): Uint8Array {
  const level0 = buildLevel0(rgba, w, h, state);

  // Build pyramid down to a small coarsest level.
  const levels: Level[] = [level0];
  while (Math.min(levels[levels.length - 1].w, levels[levels.length - 1].h) > 16) {
    levels.push(downsample(levels[levels.length - 1]));
  }

  // Solve coarsest fully, then refine down.
  for (let li = levels.length - 1; li >= 0; li--) {
    const lvl = levels[li];
    const fills = fillIndices(lvl);
    if (li < levels.length - 1) {
      // Seed FILL pixels from the coarser (already-solved) level.
      const coarse = levels[li + 1];
      for (let k = 0; k < fills.length; k++) {
        const i = fills[k];
        const x = i % lvl.w;
        const y = (i / lvl.w) | 0;
        const fx = (x + 0.5) * (coarse.w / lvl.w) - 0.5;
        const fy = (y + 0.5) * (coarse.h / lvl.h) - 0.5;
        lvl.r[i] = bilinear(coarse.r, coarse.w, coarse.h, fx, fy);
        lvl.g[i] = bilinear(coarse.g, coarse.w, coarse.h, fx, fy);
        lvl.b[i] = bilinear(coarse.b, coarse.w, coarse.h, fx, fy);
      }
      jacobi(lvl, fills, 12);
    } else {
      jacobi(lvl, fills, 80);
    }
  }

  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    if (state[i] === FILL) {
      out[j] = clamp255(level0.r[i]);
      out[j + 1] = clamp255(level0.g[i]);
      out[j + 2] = clamp255(level0.b[i]);
    } else {
      out[j] = rgba[j];
      out[j + 1] = rgba[j + 1];
      out[j + 2] = rgba[j + 2];
    }
    out[j + 3] = 255;
  }
  return out;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Full plate build: band mask + diffusion. Returns opaque RGBA. */
export function buildCleanPlate(
  rgba: Uint8Array | Uint8ClampedArray,
  binary: Uint8Array,
  w: number,
  h: number,
  dilatePx: number,
  erodePx: number,
): Uint8Array {
  const state = buildBandState(binary, w, h, dilatePx, erodePx);
  return inpaintDiffusion(rgba, w, h, state);
}
