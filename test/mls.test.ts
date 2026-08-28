/**
 * Acceptance / correctness tests for the MLS warp engine.
 * Run with: npm run test:mls   (uses Node's native TypeScript type stripping)
 *
 * These mirror the Milestone 1 acceptance criteria:
 *  - identity when all points are anchors / no points
 *  - single-point translation
 *  - coincident point maps exactly to its target
 *  - LOCAL smooth bulge with no fold-over up to 8% displacement
 *  - locality: center drag inside an anchor cage leaves the outer band ~fixed
 */

import { deformPoints, deformPoint, buildControlPoints } from "../src/mls.ts";
import { createGridMesh } from "../src/mesh.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`);
  }
}
function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

const W = 1000;
const H = 1000;

// ---------------------------------------------------------------------------
console.log("identity / degenerate");
{
  const empty = buildControlPoints([], []);
  const [x, y] = deformPoint(empty, 123, 456);
  check("no control points -> identity", approx(x, 123) && approx(y, 456));

  // All anchors (target == origin) -> identity everywhere.
  const origins: [number, number][] = [
    [100, 100], [900, 100], [100, 900], [900, 900], [500, 500],
  ];
  const anchors = buildControlPoints(origins, origins);
  let maxErr = 0;
  for (let ty = 50; ty <= 950; ty += 137) {
    for (let tx = 50; tx <= 950; tx += 137) {
      const [dx, dy] = deformPoint(anchors, tx, ty);
      maxErr = Math.max(maxErr, Math.hypot(dx - tx, dy - ty));
    }
  }
  check("all-anchors -> identity everywhere", maxErr < 1e-6, `maxErr=${maxErr.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
console.log("single-point translation");
{
  const cp = buildControlPoints([[500, 500]], [[560, 470]]);
  let maxErr = 0;
  for (let ty = 50; ty <= 950; ty += 173) {
    for (let tx = 50; tx <= 950; tx += 173) {
      const [dx, dy] = deformPoint(cp, tx, ty);
      maxErr = Math.max(maxErr, Math.hypot(dx - (tx + 60), dy - (ty - 30)));
    }
  }
  check("one point => uniform translation", maxErr < 1e-6, `maxErr=${maxErr.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
console.log("coincidence & interpolation");
{
  const origins: [number, number][] = [[200, 300], [800, 300], [500, 800]];
  const targets: [number, number][] = [[220, 280], [790, 340], [500, 820]];
  const cp = buildControlPoints(origins, targets);
  let maxErr = 0;
  for (let i = 0; i < origins.length; i++) {
    const [dx, dy] = deformPoint(cp, origins[i][0], origins[i][1]);
    maxErr = Math.max(maxErr, Math.hypot(dx - targets[i][0], dy - targets[i][1]));
  }
  check("f(p_i) == q_i (interpolation)", maxErr < 1e-4, `maxErr=${maxErr.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// Fold-over test: a center drag surrounded by 4 anchors, up to 8% of width.
// A deformed grid must keep every triangle's winding sign (no inversion).
// ---------------------------------------------------------------------------
console.log("no fold-over up to 8% displacement (bulge inside 4 anchors)");
{
  const mesh = createGridMesh(96, 96, W, H);
  const disp = 0.08 * W; // 80px
  const radius = 0.3 * W; // default edit radius
  const origins: [number, number][] = [
    [500, 500],           // the dragged point
    [300, 300], [700, 300], [300, 700], [700, 700], // 4 surrounding anchors
  ];
  const targets: [number, number][] = [
    [500 + disp, 500],    // drag right by 8%
    [300, 300], [700, 300], [300, 700], [700, 700],
  ];
  const cp = buildControlPoints(origins, targets);

  const dstX = new Float32Array(mesh.vertexCount);
  const dstY = new Float32Array(mesh.vertexCount);
  deformPoints(cp, mesh.srcX, mesh.srcY, dstX, dstY, mesh.vertexCount, {
    alpha: 1.2,
    radius,
  });

  // No triangle may flip orientation vs. the undeformed grid (y-down => the
  // undeformed winding is negative; we require the *sign* to be preserved).
  let noFlip = true;
  let minRatio = Infinity; // deformed area / undeformed area; <=0 means inverted
  const tri = mesh.triIndices;
  for (let k = 0; k < tri.length; k += 3) {
    const a = tri[k], b = tri[k + 1], c = tri[k + 2];
    const ua =
      (mesh.srcX[b] - mesh.srcX[a]) * (mesh.srcY[c] - mesh.srcY[a]) -
      (mesh.srcY[b] - mesh.srcY[a]) * (mesh.srcX[c] - mesh.srcX[a]);
    const da =
      (dstX[b] - dstX[a]) * (dstY[c] - dstY[a]) -
      (dstY[b] - dstY[a]) * (dstX[c] - dstX[a]);
    const ratio = da / ua;
    if (ratio <= 0) noFlip = false;
    minRatio = Math.min(minRatio, ratio);
  }
  check("no triangle inverted after 8% drag", noFlip, `minAreaRatio=${minRatio.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// Locality test: anchors pin the 4 corners + 4 edge midpoints; drag the center
// by 8%. Measure the max vertex displacement in the OUTER 20% band. Report both
// the pure-MLS residual and what a small dead-zone yields.
// ---------------------------------------------------------------------------
console.log("locality: center drag inside corner+midpoint cage");
{
  const mesh = createGridMesh(96, 96, W, H);
  const disp = 0.08 * W;
  const cage: [number, number][] = [
    [0, 0], [W, 0], [0, H], [W, H],           // corners
    [W / 2, 0], [W, H / 2], [W / 2, H], [0, H / 2], // edge midpoints
  ];
  const origins: [number, number][] = [[500, 500], ...cage];
  const targets: [number, number][] = [[500 + disp, 500], ...cage];
  const cp = buildControlPoints(origins, targets);

  const measure = (localize: boolean, radius: number): number => {
    const dstX = new Float32Array(mesh.vertexCount);
    const dstY = new Float32Array(mesh.vertexCount);
    deformPoints(cp, mesh.srcX, mesh.srcY, dstX, dstY, mesh.vertexCount, {
      alpha: 1.2,
      localize,
      radius,
    });
    const band = 0.2; // outer 20%
    let maxDisp = 0;
    for (let n = 0; n < mesh.vertexCount; n++) {
      const x = mesh.srcX[n];
      const y = mesh.srcY[n];
      const inOuter =
        x <= band * W || x >= (1 - band) * W || y <= band * H || y >= (1 - band) * H;
      if (!inOuter) continue;
      maxDisp = Math.max(maxDisp, Math.hypot(dstX[n] - x, dstY[n] - y));
    }
    return maxDisp;
  };

  const pure = measure(false, 0);
  console.log(`  info  max outer-band displacement, pure global MLS = ${pure.toFixed(3)} px`);
  const radius = 0.3 * W; // default edit radius (30% of image)
  const local = measure(true, radius);
  console.log(`  info  max outer-band displacement, localized r=${radius} = ${local.toFixed(6)} px`);
  check("pure global MLS leaks into outer band (motivates locality)", pure > 2.0);
  check("localized: outer band is bit-exact identity", local === 0, `got ${local.toExponential(3)}px`);
}

// ---------------------------------------------------------------------------
console.log("");
if (failures === 0) {
  console.log("ALL PASS");
  process.exit(0);
} else {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
