/**
 * Person-layer construction (Milestone 3). Pure math.
 *
 * The M2 soft matte is computed at <=1024px; compositing happens at native
 * resolution, so we bilinearly upscale the matte, feather it with a small
 * gaussian, and multiply it into the original RGB to build a PREMULTIPLIED
 * alpha texture (rendered with blendFunc(ONE, ONE_MINUS_SRC_ALPHA)). Straight
 * alpha + bilinear sampling would fringe dark at the silhouette.
 */

/** Bilinear upscale of a single-channel float map. */
export function upscaleBilinear(
  src: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Float32Array {
  const out = new Float32Array(dw * dh);
  const sx = sw / dw;
  const sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = Math.max(0, Math.min(1, fy - y0));
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) * sx - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = Math.max(0, Math.min(1, fx - x0));
      const a = src[y0 * sw + x0];
      const b = src[y0 * sw + x1];
      const c = src[y1 * sw + x0];
      const d = src[y1 * sw + x1];
      out[y * dw + x] =
        a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
    }
  }
  return out;
}

/** Separable gaussian blur of a single-channel float map (clamped edges). */
export function gaussianBlur(
  src: Float32Array,
  w: number,
  h: number,
  sigma: number,
): Float32Array {
  if (sigma <= 0.05) return src.slice();
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const tmp = new Float32Array(w * h);
  // Horizontal.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.max(0, Math.min(w - 1, x + k));
        acc += src[y * w + xx] * kernel[k + radius];
      }
      tmp[y * w + x] = acc;
    }
  }
  // Vertical.
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.max(0, Math.min(h - 1, y + k));
        acc += tmp[yy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/**
 * Build a premultiplied-alpha RGBA texture buffer from original RGB and a
 * feathered alpha map (both at the same resolution).
 */
export function buildPremultipliedPerson(
  originalRGBA: Uint8Array | Uint8ClampedArray,
  alpha: Float32Array,
  w: number,
  h: number,
): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = alpha[i] < 0 ? 0 : alpha[i] > 1 ? 1 : alpha[i];
    const j = i * 4;
    out[j] = Math.round(originalRGBA[j] * a);
    out[j + 1] = Math.round(originalRGBA[j + 1] * a);
    out[j + 2] = Math.round(originalRGBA[j + 2] * a);
    out[j + 3] = Math.round(a * 255);
  }
  return out;
}

/** Convenience: upscale the det-res soft matte to a target size and feather it. */
export function featherMatte(
  soft: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  sigmaPx: number,
): Float32Array {
  const up = upscaleBilinear(soft, sw, sh, dw, dh);
  return gaussianBlur(up, dw, dh, sigmaPx);
}
