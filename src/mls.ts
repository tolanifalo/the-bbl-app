/**
 * Moving Least Squares image deformation — SIMILARITY variant, with a locality
 * layer.
 *
 * Reference for the core solve: Schaefer, McPhail, Warren, "Image Deformation
 * Using Moving Least Squares", SIGGRAPH 2006, section 2.2 (Similarity).
 *
 * ---------------------------------------------------------------------------
 * CORE (faithful Schaefer similarity)
 * ---------------------------------------------------------------------------
 * Given control points with origins p_i and targets q_i, the deformation of a
 * point v is the per-point best-fit *similarity* transform (uniform scale +
 * rotation + translation) mapping the weighted p_i onto the weighted q_i:
 *
 *     f_mls(v) = q* + (1/mu_s) * SUM_i  w_i * qh_i * [ d  -e ]
 *                                                    [ e   d ]
 *   with, per control point i and evaluation point v:
 *     w_i  = 1 / |p_i - v|^(2*alpha)          (the required weight)
 *     p*   = SUM_i w_i p_i / SUM_i w_i        (weighted origin centroid)
 *     q*   = SUM_i w_i q_i / SUM_i w_i        (weighted target centroid)
 *     ph_i = p_i - p*,  qh_i = q_i - q*,  r = v - p*
 *     d    = ph_i . r,   e = ph_iy*rx - ph_ix*ry
 *     mu_s = SUM_i w_i (ph_i . ph_i)
 *
 * ---------------------------------------------------------------------------
 * LOCALITY LAYER (why this exists)
 * ---------------------------------------------------------------------------
 * The required weight 1/|p-v|^(2a) has *infinite support*: every control point
 * influences every pixel. That contradicts the project's core principle — edits
 * must be LOCAL — and it fails the acceptance test ("outer 20% pixel-identical").
 * Empirically, a center drag inside a corner+midpoint anchor cage still leaks
 * ~16px into the outer band under pure global MLS.
 *
 * So we blend the faithful MLS result toward identity by a smooth window:
 *
 *     f(v) = v + Phi(v) * (f_mls(v) - v)
 *
 * where Phi in [0,1] is 1 at a moving handle and falls to exactly 0 (with zero
 * slope, so no tear) at `radius` px away from the moving handles. "Distance to
 * the moving handles" is measured smoothly from the same inverse-distance
 * weights the solve already computes:
 *
 *     D(v) = ( SUM_{moving i} w_i )^(-1/(2*alpha))     // = handle distance for 1 handle
 *     Phi(v) = falloff( D(v) / radius )                // C1, zero slope at 1
 *
 * Only MOVING handles (target != origin) create edit support; ANCHORS
 * (target == origin) still participate in f_mls to pin geometry, but never
 * extend the edited region. Setting `localize:false` (or radius<=0) restores
 * pure global Schaefer MLS.
 *
 * This module is pure and DOM-free so it runs under Node for the acceptance
 * tests as well as in the browser render loop.
 */

export interface MlsControlPoints {
  /** Number of control points. */
  readonly count: number;
  /** Origin x per control point (image-space px). */
  readonly px: Float64Array;
  /** Origin y per control point (image-space px). */
  readonly py: Float64Array;
  /** Target x per control point (image-space px). */
  readonly qx: Float64Array;
  /** Target y per control point (image-space px). */
  readonly qy: Float64Array;
  /** 1 if the point is a moving handle (target != origin), else 0 (anchor). */
  readonly moving: Uint8Array;
}

/** Squared px distance under which v is treated as sitting *on* a control point. */
const COINCIDENT_EPS2 = 1e-8;
/** mu_s below this is treated as degenerate (single point / colocated origins). */
const MU_EPS = 1e-12;
/** A target this far (px) from its origin counts as a moving handle. */
const MOVING_EPS = 1e-6;

export interface DeformOptions {
  /** Falloff exponent. w_i = 1/|p_i - v|^(2*alpha). Default 1.2. */
  alpha?: number;
  /** Enable the locality layer. Default true. False => pure global Schaefer. */
  localize?: boolean;
  /** Edit radius in image px (support of a moving handle). Ignored if !localize. */
  radius?: number;
}

/**
 * C1 falloff window: 1 at r<=0, 0 at r>=1, with zero slope at both ends
 * (smootherstep on 1-r). Zero slope at r=1 is what prevents a tear at the
 * locality boundary.
 */
function falloff(r: number): number {
  if (r <= 0) return 1;
  if (r >= 1) return 0;
  const t = 1 - r;
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Deform `count` source points into destination arrays.
 *
 * srcX/srcY are the undeformed positions (e.g. the static grid). dstX/dstY
 * receive f(v). Source and destination must not alias.
 */
export function deformPoints(
  cp: MlsControlPoints,
  srcX: ArrayLike<number>,
  srcY: ArrayLike<number>,
  dstX: Float32Array,
  dstY: Float32Array,
  count: number,
  opts: DeformOptions = {},
): void {
  const alpha = opts.alpha ?? 1.2;
  const localize = opts.localize ?? true;
  const radius = opts.radius ?? 0;
  const useLocal = localize && radius > 0;
  const invRadius = useLocal ? 1 / radius : 0;
  // D = (movingWsum)^(-1/(2a)); Phi arg = D/radius. Precompute the exponent.
  const dExp = -1 / (2 * alpha);

  const n = cp.count;
  const { px, py, qx, qy, moving } = cp;

  // No control points -> identity.
  if (n === 0) {
    for (let k = 0; k < count; k++) {
      dstX[k] = srcX[k];
      dstY[k] = srcY[k];
    }
    return;
  }

  const negAlpha = -alpha; // w = (d2)^(-alpha)
  const w = new Float64Array(n);

  for (let k = 0; k < count; k++) {
    const vx = srcX[k];
    const vy = srcY[k];

    // Pass A: weights + weighted centroid sums (+ moving-weight sum, coincidence).
    let wsum = 0;
    let movingWsum = 0;
    let pcx = 0;
    let pcy = 0;
    let qcx = 0;
    let qcy = 0;
    let coincident = -1;
    for (let i = 0; i < n; i++) {
      const dx = px[i] - vx;
      const dy = py[i] - vy;
      const d2 = dx * dx + dy * dy;
      if (d2 < COINCIDENT_EPS2) {
        coincident = i;
        break;
      }
      const wi = Math.pow(d2, negAlpha);
      w[i] = wi;
      wsum += wi;
      if (moving[i]) movingWsum += wi;
      pcx += wi * px[i];
      pcy += wi * py[i];
      qcx += wi * qx[i];
      qcy += wi * qy[i];
    }
    if (coincident >= 0) {
      // v sits on a control point: it maps exactly to that point's target.
      dstX[k] = qx[coincident];
      dstY[k] = qy[coincident];
      continue;
    }

    // Locality weight Phi from the moving handles only.
    let phi = 1;
    if (useLocal) {
      if (movingWsum <= 0) {
        phi = 0; // no moving handle in range -> untouched
      } else {
        const dHandle = Math.pow(movingWsum, dExp); // effective distance to handles
        phi = falloff(dHandle * invRadius);
      }
    }
    if (phi <= 0) {
      dstX[k] = vx;
      dstY[k] = vy;
      continue;
    }

    const inv = 1 / wsum;
    pcx *= inv;
    pcy *= inv;
    qcx *= inv;
    qcy *= inv;

    const rx = vx - pcx;
    const ry = vy - pcy;

    // Pass B: mu_s and the similarity combination.
    let mu = 0;
    let ax = 0;
    let ay = 0;
    for (let i = 0; i < n; i++) {
      const wi = w[i];
      const phx = px[i] - pcx;
      const phy = py[i] - pcy;
      mu += wi * (phx * phx + phy * phy);

      const d = phx * rx + phy * ry;
      const e = phy * rx - phx * ry;
      const qhx = qx[i] - qcx;
      const qhy = qy[i] - qcy;
      // qh (row) * [[d,-e],[e,d]] * w_i
      ax += wi * (qhx * d + qhy * e);
      ay += wi * (-qhx * e + qhy * d);
    }

    let fx: number;
    let fy: number;
    if (mu < MU_EPS) {
      // Degenerate: a single control point (or colocated origins) has no
      // rotational information -> fall back to pure translation q* - p*.
      fx = vx + (qcx - pcx);
      fy = vy + (qcy - pcy);
    } else {
      const invMu = 1 / mu;
      fx = qcx + ax * invMu;
      fy = qcy + ay * invMu;
    }

    if (phi >= 1) {
      dstX[k] = fx;
      dstY[k] = fy;
    } else {
      // Blend toward identity: f = v + phi*(f_mls - v).
      dstX[k] = vx + phi * (fx - vx);
      dstY[k] = vy + phi * (fy - vy);
    }
  }
}

/** Deform a single point (convenience; allocates a tiny result). */
export function deformPoint(
  cp: MlsControlPoints,
  vx: number,
  vy: number,
  opts: DeformOptions = {},
): [number, number] {
  const ox = new Float32Array(1);
  const oy = new Float32Array(1);
  deformPoints(cp, [vx], [vy], ox, oy, 1, opts);
  return [ox[0], oy[0]];
}

/** Build the packed control-point arrays MLS consumes from origin/target pairs. */
export function buildControlPoints(
  origins: ReadonlyArray<readonly [number, number]>,
  targets: ReadonlyArray<readonly [number, number]>,
): MlsControlPoints {
  const count = origins.length;
  const px = new Float64Array(count);
  const py = new Float64Array(count);
  const qx = new Float64Array(count);
  const qy = new Float64Array(count);
  const moving = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    px[i] = origins[i][0];
    py[i] = origins[i][1];
    qx[i] = targets[i][0];
    qy[i] = targets[i][1];
    const dx = qx[i] - px[i];
    const dy = qy[i] - py[i];
    moving[i] = dx * dx + dy * dy > MOVING_EPS * MOVING_EPS ? 1 : 0;
  }
  return { count, px, py, qx, qy, moving };
}
