/**
 * Milestone 3: map the body sliders + M2 detection outputs to a set of MLS
 * control-point pairs (origin -> target) that drive the M1 warp engine.
 *
 * Every point is a pair. Moved points (contour) do the reshaping; unmoved
 * points (permanent anchors) act as pins that make the edit look pro:
 * shoulders, the spine centerline (shoulder/waist/hip heights), mid-thigh
 * edges, and an ankle centerline. The localize radius is derived from the body
 * bounding box so Phi ~ 1 across the whole cage (a fixed 30% would let sliders
 * feel weak near the window edge).
 *
 * Builds only on detector OUTPUTS (contour, landmarks, matte) — it does not
 * touch the M1 warp/localize engine or the M2 detector internals.
 */
import type { DetectionResult } from "./detector.ts";
import type { SliderState } from "./state.ts";

export interface BodyPair {
  ox: number;
  oy: number;
  tx: number;
  ty: number;
}

export interface BodyEdit {
  pairs: BodyPair[];
  /** Localize radius (image px) for deformPoints. */
  radius: number;
}

// MediaPipe pose indices.
const L_SH = 11, R_SH = 12, L_HIP = 23, R_HIP = 24, L_KNEE = 25, R_KNEE = 26, L_ANK = 27, R_ANK = 28;

const easeOut = (v: number, ceil: number): number => Math.pow(clamp(v, 0, ceil) / 100, 0.8);
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

export function buildBodyEdit(
  det: DetectionResult,
  sliders: SliderState,
): BodyEdit | null {
  const c = det.contour;
  const lm = det.landmarks;
  if (!c || !lm) return null;

  const shoulderMidX = (lm[L_SH].x + lm[R_SH].x) / 2;
  const hipMidX = (lm[L_HIP].x + lm[R_HIP].x) / 2;
  const shoulderY = c.shoulderY;
  const hipY = c.hipY;
  const centerXAt = (y: number): number => {
    const t = (y - shoulderY) / (hipY - shoulderY || 1);
    return shoulderMidX + t * (hipMidX - shoulderMidX);
  };

  const waistWidth = Math.abs(c.waistR.x - c.waistL.x);
  const hipWidth = Math.abs(c.hipR.x - c.hipL.x);
  const bustWidth = Math.abs(c.bustR.x - c.bustL.x);

  const waistVal = Math.min(sliders.ceiling, sliders.waist + 0.6 * sliders.bbl);
  const hipVal = Math.min(sliders.ceiling, sliders.hips + sliders.bbl);
  const bustVal = sliders.bust;

  const dWaist = easeOut(waistVal, sliders.ceiling) * 0.07 * waistWidth;
  const dHip = easeOut(hipVal, sliders.ceiling) * 0.08 * hipWidth;
  
  const dBust = easeOut(bustVal, sliders.ceiling) * 0.06 * bustWidth;
  const dOuterX = dBust * 0.6;
  const dOuterY = dBust * 0.4;
  const lift = dBust * 0.2; // Gentle upward rotation effect

  const waistCenter = centerXAt(c.waistY);
  const hipCenter = centerXAt(hipY);
  const bustCenterY = c.bustY;
  
  const underbustY = bustCenterY + 0.35 * (c.waistY - bustCenterY);

  const pairs: BodyPair[] = [];

  // ---- moving contour points ----
  // Waist: each edge toward the centerline (slim).
  pairs.push(move(c.waistL, c.waistL.x + Math.sign(waistCenter - c.waistL.x) * dWaist, c.waistL.y));
  pairs.push(move(c.waistR, c.waistR.x + Math.sign(waistCenter - c.waistR.x) * dWaist, c.waistR.y));
  
  // Hips: each edge outward (widen).
  pairs.push(move(c.hipL, c.hipL.x + Math.sign(c.hipL.x - hipCenter) * dHip, c.hipL.y));
  pairs.push(move(c.hipR, c.hipR.x + Math.sign(c.hipR.x - hipCenter) * dHip, c.hipR.y));
  
  // Bust: shallow downward-outward arc + lift
  pairs.push(move(c.bustL, c.bustL.x - dOuterX, c.bustL.y + dOuterY - lift));
  pairs.push(move(c.bustR, c.bustR.x + dOuterX, c.bustR.y + dOuterY - lift));

  // ---- permanent anchors (target == origin) ----
  pin(pairs, lm[L_SH].x, lm[L_SH].y);
  pin(pairs, lm[R_SH].x, lm[R_SH].y);
  pin(pairs, shoulderMidX, shoulderY); // Collarbone centerline
  pin(pairs, centerXAt(underbustY), underbustY); // Underbust centerline pin
  
  pin(pairs, waistCenter, c.waistY);
  pin(pairs, hipMidX, hipY);

  // Mid-thigh outer edges from the silhouette (pin the legs).
  const kneeVisible = lm[L_KNEE].visibility > 0.3 || lm[R_KNEE].visibility > 0.3;
  const kneeY = kneeVisible ? (lm[L_KNEE].y + lm[R_KNEE].y) / 2 : hipY + (hipY - shoulderY);
  const thighY = (hipY + kneeY) / 2;
  const thigh = silhouetteExtent(det, thighY);
  if (thigh) {
    pin(pairs, thigh.l, thighY);
    pin(pairs, thigh.r, thighY);
  }

  // Ankle centerline.
  if (lm[L_ANK] && lm[R_ANK] && (lm[L_ANK].visibility > 0.2 || lm[R_ANK].visibility > 0.2)) {
    pin(pairs, (lm[L_ANK].x + lm[R_ANK].x) / 2, (lm[L_ANK].y + lm[R_ANK].y) / 2);
  }

  // Radius from the body bbox of ALL pairs (origins + targets).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pairs) {
    minX = Math.min(minX, p.ox, p.tx);
    maxX = Math.max(maxX, p.ox, p.tx);
    minY = Math.min(minY, p.oy, p.ty);
    maxY = Math.max(maxY, p.oy, p.ty);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  const radius = Math.max(1, diag * 1.2);

  return { pairs, radius };
}

function move(o: { x: number; y: number }, tx: number, ty: number): BodyPair {
  return { ox: o.x, oy: o.y, tx, ty };
}
function pin(list: BodyPair[], x: number, y: number): void {
  list.push({ ox: x, oy: y, tx: x, ty: y });
}

/** Leftmost/rightmost person pixel at image-space row y (via the det-res matte). */
function silhouetteExtent(det: DetectionResult, imageY: number): { l: number; r: number } | null {
  const m = det.matte;
  const yDet = Math.round(imageY / m.scaleToImage);
  if (yDet < 0 || yDet >= m.height) return null;
  const row = yDet * m.width;
  let l = -1, r = -1;
  for (let x = 0; x < m.width; x++) {
    if (m.binary[row + x] === 1) {
      if (l < 0) l = x;
      r = x;
    }
  }
  if (l < 0) return null;
  return { l: l * m.scaleToImage, r: r * m.scaleToImage };
}
