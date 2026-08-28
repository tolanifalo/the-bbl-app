/**
 * Derive body contour points from a binary person matte + pose landmarks.
 * Pure / DOM-free so it can be reasoned about and unit-tested independently.
 *
 * All inputs and outputs are in a single 2D pixel space (the caller passes the
 * matte's own resolution and landmarks scaled to it, then scales the returned
 * points wherever it needs them).
 *
 * MediaPipe Pose landmark indices used:
 *   11 L-shoulder, 12 R-shoulder, 23 L-hip, 24 R-hip, 25 L-knee, 26 R-knee.
 * "L"/"R" on the OUTPUT points are image-space left/right (viewer's), i.e. the
 * left and right silhouette edges at a given row.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Landmark {
  x: number;
  y: number;
  visibility: number;
}

export interface ContourPoints {
  bustL: Pt;
  bustR: Pt;
  waistL: Pt;
  waistR: Pt;
  hipL: Pt;
  hipR: Pt;
  /** Guide rows (same space), for debug drawing. */
  shoulderY: number;
  hipY: number;
  waistY: number;
  bustY: number;
}

interface RowEdges {
  l: number;
  r: number;
  y: number;
  width: number;
}

const SH_L = 11;
const SH_R = 12;
const HIP_L = 23;
const HIP_R = 24;
const KNEE_L = 25;
const KNEE_R = 26;

export function deriveContour(
  binary: Uint8Array,
  w: number,
  h: number,
  lm: ReadonlyArray<Landmark>,
): ContourPoints | null {
  for (const i of [SH_L, SH_R, HIP_L, HIP_R]) {
    if (!lm[i]) return null;
  }

  const shoulderY = (lm[SH_L].y + lm[SH_R].y) / 2;
  const shoulderMidX = (lm[SH_L].x + lm[SH_R].x) / 2;
  const hipY = (lm[HIP_L].y + lm[HIP_R].y) / 2;
  const hipMidX = (lm[HIP_L].x + lm[HIP_R].x) / 2;
  if (hipY <= shoulderY) return null; // upside-down / nonsense pose

  // Knee line for the hip search span; approximate if knees aren't confident.
  const lk = lm[KNEE_L];
  const rk = lm[KNEE_R];
  const kneeVisible = (lk && lk.visibility > 0.3) || (rk && rk.visibility > 0.3);
  const kneeY =
    kneeVisible && lk && rk ? (lk.y + rk.y) / 2 : hipY + (hipY - shoulderY);

  const isPerson = (x: number, y: number): boolean =>
    x >= 0 && x < w && y >= 0 && y < h && binary[y * w + x] === 1;

  // Torso centerline x at row y (interpolated shoulder-mid -> hip-mid).
  const centerX = (y: number): number => {
    const t = (y - shoulderY) / (hipY - shoulderY);
    return shoulderMidX + t * (hipMidX - shoulderMidX);
  };

  // Silhouette edges = boundaries of the person run that contains the centerline
  // (or the nearest person pixel on that row). This is what makes hands-on-hips
  // find the torso edge across the arm/torso gap, not the arm.
  const edgesAtRow = (yf: number): RowEdges | null => {
    const y = Math.round(yf);
    if (y < 0 || y >= h) return null;
    let xi = Math.max(0, Math.min(w - 1, Math.round(centerX(y))));
    if (!isPerson(xi, y)) {
      let best = Infinity;
      let found = -1;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (binary[row + x] === 1) {
          const d = Math.abs(x - xi);
          if (d < best) {
            best = d;
            found = x;
          }
        }
      }
      if (found < 0) return null;
      xi = found;
    }
    const row = y * w;
    let l = xi;
    while (l - 1 >= 0 && binary[row + (l - 1)] === 1) l--;
    let r = xi;
    while (r + 1 < w && binary[row + (r + 1)] === 1) r++;
    return { l, r, y, width: r - l };
  };

  // BUST: 25% of the way from shoulder line down to hip line.
  const bustY = shoulderY + 0.25 * (hipY - shoulderY);
  const bustE = edgesAtRow(bustY);

  // WAIST: 30%-70% from the hip line up to the shoulder line; minimum width.
  const wy0 = hipY + 0.3 * (shoulderY - hipY);
  const wy1 = hipY + 0.7 * (shoulderY - hipY);
  const wa = Math.round(Math.min(wy0, wy1));
  const wb = Math.round(Math.max(wy0, wy1));
  let waistE: RowEdges | null = null;
  let minWidth = Infinity;
  for (let y = wa; y <= wb; y++) {
    const e = edgesAtRow(y);
    if (e && e.width < minWidth) {
      minWidth = e.width;
      waistE = e;
    }
  }

  // HIPS: from the hip line down by 25% of the hip->knee distance; maximum width.
  const hy0 = hipY;
  const hy1 = hipY + 0.25 * (kneeY - hipY);
  const ha = Math.round(Math.min(hy0, hy1));
  const hb = Math.round(Math.max(hy0, hy1));
  let hipE: RowEdges | null = null;
  let maxWidth = -1;
  for (let y = ha; y <= hb; y++) {
    const e = edgesAtRow(y);
    if (e && e.width > maxWidth) {
      maxWidth = e.width;
      hipE = e;
    }
  }

  if (!bustE || !waistE || !hipE) return null;

  return {
    bustL: { x: bustE.l, y: bustE.y },
    bustR: { x: bustE.r, y: bustE.y },
    waistL: { x: waistE.l, y: waistE.y },
    waistR: { x: waistE.r, y: waistE.y },
    hipL: { x: hipE.l, y: hipE.y },
    hipR: { x: hipE.r, y: hipE.y },
    shoulderY,
    hipY,
    waistY: waistE.y,
    bustY: bustE.y,
  };
}

/** Scale contour points from matte space into another pixel space. */
export function scaleContour(c: ContourPoints, s: number): ContourPoints {
  const p = (pt: Pt): Pt => ({ x: pt.x * s, y: pt.y * s });
  return {
    bustL: p(c.bustL),
    bustR: p(c.bustR),
    waistL: p(c.waistL),
    waistR: p(c.waistR),
    hipL: p(c.hipL),
    hipR: p(c.hipR),
    shoulderY: c.shoulderY * s,
    hipY: c.hipY * s,
    waistY: c.waistY * s,
    bustY: c.bustY * s,
  };
}
