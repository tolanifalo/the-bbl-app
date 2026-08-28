/**
 * Tests for the M3 clean-plate core: band mask (dilate - erode) and multi-scale
 * diffusion inpaint. Run: node test/inpaint.test.ts
 *
 * Scenario: a solid background with a differently-coloured "person" square. The
 * band around the silhouette must be filled from the BACKGROUND, never bleeding
 * the person's colour; valid/blocked pixels must stay original.
 */
import { buildBandState, inpaintDiffusion, VALID, FILL, BLOCKED } from "../src/inpaintCore.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`);
  }
}

const W = 120, H = 120;
const BG = [50, 100, 150];
const PERSON = [210, 40, 40];
const x0 = 40, x1 = 80, y0 = 40, y1 = 80; // person square [40,80)

const rgba = new Uint8Array(W * H * 4);
const binary = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const inside = x >= x0 && x < x1 && y >= y0 && y < y1;
    binary[i] = inside ? 1 : 0;
    const c = inside ? PERSON : BG;
    rgba[i * 4] = c[0];
    rgba[i * 4 + 1] = c[1];
    rgba[i * 4 + 2] = c[2];
    rgba[i * 4 + 3] = 255;
  }
}

const dilate = 2;
const B = 10;
const state = buildBandState(binary, W, H, dilate, B);
const at = (x: number, y: number) => state[y * W + x];

console.log("band state");
check("far background is VALID", at(2, 2) === VALID);
check("deep interior is BLOCKED", at(60, 60) === BLOCKED, `got ${at(60, 60)}`);
check("just inside the edge is FILL", at(x0 + 1, 60) === FILL, `got ${at(x0 + 1, 60)}`);
check("just outside the edge is FILL", at(x0 - 1, 60) === FILL, `got ${at(x0 - 1, 60)}`);

let nValid = 0, nFill = 0, nBlocked = 0;
for (let i = 0; i < state.length; i++) {
  if (state[i] === VALID) nValid++;
  else if (state[i] === FILL) nFill++;
  else nBlocked++;
}
check("all three regions are non-empty", nValid > 0 && nFill > 0 && nBlocked > 0, `v=${nValid} f=${nFill} b=${nBlocked}`);

console.log("diffusion inpaint");
const out = inpaintDiffusion(rgba, W, H, state);
const px = (x: number, y: number) => {
  const j = (y * W + x) * 4;
  return [out[j], out[j + 1], out[j + 2]];
};

// A band pixel just inside the person edge should be filled toward BACKGROUND,
// not the person's red.
const [r] = px(x0 + 1, 60);
check("band fill pulls background, not person", r < 128, `filled R=${r} (bg=${BG[0]}, person=${PERSON[0]})`);

// Valid + blocked pixels keep their original colour.
check("valid pixel unchanged", px(2, 2).join() === BG.join());
check("blocked interior unchanged", px(60, 60).join() === PERSON.join(), `got ${px(60, 60).join()}`);

// Output is opaque.
check("output alpha is opaque", out[(60 * W + 60) * 4 + 3] === 255);

console.log("");
if (failures === 0) {
  console.log("ALL PASS");
  process.exit(0);
} else {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
