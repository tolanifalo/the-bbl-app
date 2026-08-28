# BBL Warp Engine — Milestone 1

The isolated **warp engine** for THE BBL APP: Moving Least Squares (MLS) image
deformation on a textured WebGL2 mesh, with a dev harness for placing and
dragging control points. No segmentation, sliders, or styling — those are later
milestones. Stack: **Vite + TypeScript + WebGL2**, no UI framework.

> **Core principle carried from the whole project:** edits must be **LOCAL**.
> This engine never warps anything outside the edit radius, which is what lets a
> later milestone warp *only the segmented person* and leave the background
> untouched.

## Run

```bash
npm install
npm run dev        # open the printed localhost URL
```

Then either **Load test pattern** (a gridded image, great for seeing the warp)
or **Open image** / drag-drop a photo.

Other scripts:

```bash
npm run test:mls   # headless acceptance tests for the MLS math (Node, no browser)
npm run build      # typecheck + production build
npm run typecheck
```

## Controls

| Action | Result |
| --- | --- |
| **click** on image | place a control point (target starts at the origin) |
| **shift-click** | place an **anchor** (a pin: target locked to origin) |
| **drag** a handle | move that point's target (the warp follows) |
| **drag** empty space | pan |
| **wheel** | zoom around the cursor |
| **Del / Backspace** | remove the selected point |
| hold **Space** | preview the original (undeformed) image |
| Panel toggles | mesh wireframe, control-point overlay |
| **Download PNG** | re-render at the image's native resolution and save |

The panel lists every point with live coordinates; click a row to select, ✕ to
delete.

## How it works

- **Mesh** ([src/mesh.ts](src/mesh.ts)) — a 96×96-quad grid (9409 vertices) in
  image-space px. Texcoords are fixed to the *undeformed* grid; only vertex
  positions move, which is what warps the sampled image.
- **MLS** ([src/mls.ts](src/mls.ts)) — the **similarity** variant of Schaefer,
  McPhail & Warren (SIGGRAPH 2006). Weight `w_i = 1/|p_i − v|^(2·alpha)`,
  `alpha` default **1.2**. Deformation is recomputed on the CPU each interactive
  frame; the GPU rasterizes.
- **Renderer** ([src/renderer.ts](src/renderer.ts)) — one WebGL2 program draws
  the textured mesh and (optionally) the wireframe. The **same draw path** feeds
  the offscreen native-resolution export, so the PNG matches the preview exactly.
- **Export** ([src/exporter.ts](src/exporter.ts)) — renders the current
  deformation into an FBO at native resolution (capped at `MAX_TEXTURE_SIZE`)
  and downloads it. The preview texture is capped at 2048px; geometry and
  control points are always in native px, so preview and export deform
  identically.

### The locality layer (important design note)

The required weight `1/|p−v|^(2·alpha)` has **infinite support** — every control
point mathematically influences every pixel. Pure global Schaefer MLS therefore
*cannot* leave a far region pixel-identical: in the acceptance scenario (center
drag inside a corner+midpoint anchor cage) it leaks **~16.6px** into the outer
band. That both fails the acceptance test and violates the project's LOCAL
principle.

So the faithful MLS result is blended toward identity by a smooth, zero-slope
falloff window of adjustable **radius** (default 30% of the image's short side):

```
f(v) = v + Φ(v) · (f_mls(v) − v)
```

- `f_mls` is the exact Schaefer similarity solve (unchanged) using the required
  weight — anchors still pin geometry locally.
- `Φ ∈ [0,1]` is 1 at a moving handle and falls to **exactly 0** at `radius`
  away, measured smoothly from the same inverse-distance weights. The zero slope
  at the boundary means no tear; the hard zero means the far field is
  **bit-exact identity**.
- Only **moving handles** (target ≠ origin) create edit support. Anchors
  constrain the solve but never extend the edited region.
- Toggle **localize** off (or set radius to its max) to see pure global MLS.

## Acceptance criteria → where they're verified

| Criterion | Status | Where |
| --- | --- | --- |
| Smooth LOCAL bulge dying out at 4 surrounding anchors | ✅ | interactive; `test:mls` no-fold test |
| No mesh tearing / fold-over up to 8% of width | ✅ | `test:mls` checks no triangle inverts |
| Locality: outer 20% pixel-identical after a center drag | ✅ | `test:mls` — localized max displacement in outer band is **0** |
| Exported PNG matches the preview deformation | ✅ | shared draw path + native-px geometry |
| 96×96 vs. up to 40 points at 60fps | ✅ | HUD shows live `MLS x.x ms` (well under the 16.6ms frame budget) |

To eyeball the locality diff: Load test pattern → shift-click the 4 corners and 4
edge midpoints (anchors) → click the center and drag it → **Download PNG**, and
diff against a clean export. The outer band is unchanged.

## Milestone 2 — body intelligence

Adds person segmentation, pose landmarks, and auto-derived body contour points
with debug overlays. **Detection and visualization only** — no sliders,
compositing, or inpainting. The M1 warp engine and its localize layer are
untouched.

- **Stack addition:** `@mediapipe/tasks-vision`, run once per image in
  static-image mode.
- **Self-hosted + offline:** the wasm runtime lives in
  [public/wasm/](public/wasm/) and the models in [public/models/](public/models/)
  (`selfie_segmenter.tflite`, `selfie_multiclass_256x256.tflite`,
  `pose_landmarker_lite.task`). Every fetch happens inside `initDetector()`,
  kicked off at page load. After load, detection runs from in-memory models —
  **zero network requests**, and the built bundle contains no CDN hosts.

### Pipeline (on image load / Re-detect)

1. **Segmentation** → person confidence mask, thresholded at 0.5 for a binary
   matte; the soft mask is kept too. Default model is **multiclass** (union of
   all non-background classes — robust on full-body shots); switch to
   single-class **selfie** in the panel. Masks are computed at a detection
   resolution capped at 1024px and stored with a scale back to image px.
2. **Pose** → 33 landmarks, converted to image pixels.
3. **Contour points** ([src/contour.ts](src/contour.ts)) from matte + landmarks:
   torso centerline (shoulder-mid → hip-mid), outward edge-scan of the person
   run containing the centerline (so hands-on-hips finds the torso edge across
   the arm gap, not the arm), then **bust** (25% shoulder→hip), **waist**
   (min silhouette width in the 30–70% hip→shoulder band), **hips** (max width
   from the hip line down 25% of hip→knee). Six points: bust/waist/hip L/R.

### Debug overlays (panel checkboxes, all OFF by default)

- **matte tint** — detected person tinted red at 40%.
- **pose** — 33 landmarks + skeleton connections.
- **contour points** — the 6 derived points as labeled dots, with a faint
  silhouette guide.

**Re-detect** reruns the pipeline; segmentation/pose timings are `console.log`ged
(and summarized in the panel status line).

### M2 acceptance → how to check

Test on 3 photos (arms at sides, hands on hips, busy patterned background):

- Toggle **matte tint** — it should hug the body (no background chunks inside,
  no missing limbs; soft hair edges are fine). If the single-class matte is poor
  on a full-body shot, the model selector defaults to multiclass for exactly
  this reason.
- Toggle **contour points** — the 6 points sit on the silhouette edge at
  plausible heights (waist at the visible narrowing, hips at the widest point).
- **Offline check:** open DevTools → Network, load/re-detect an image; there are
  **zero** requests (all wasm/model traffic already happened at page load).
- **M1 intact:** the warp, localize layer, and `npm run test:mls` are unchanged.

> Detection targets real photos. On the built-in test pattern there is no person,
> so the matte is empty and no contour is derived — that's expected.

## Milestone 3 — the product core

Real edits with **zero background distortion**, via three layers that replace
whole-image warping. The M1 warp/localize engine and the M2 detector internals
are untouched — M3 only consumes their outputs.

### Layers (bottom → top)

1. **Clean plate** (never warped): the original photo with a band around the
   silhouette filled by diffusion inpainting, so slimming can't reveal a halo.
2. **Person layer** (the only thing warped): original × soft matte, premultiplied
   alpha, textured on the M1 warp mesh.
3. Render order: plate quad (opaque) → person mesh, `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`.

Details: the M2 soft matte is upscaled to native and feathered (~1.5px gaussian,
scaled with image size); premultiplied alpha avoids dark edge fringing. The band
mask = (matte dilated ~3px) − (matte eroded by B), `B = 15%` of the person bbox
width, via a chamfer distance transform. The plate is inpainted with pure-TS
multi-scale diffusion in a **web worker** at native res (a small preview plate is
computed immediately so sliders work while it finishes). The deep interior stays
original and is never revealed because slider caps stay below B.

### Sliders (0–100, ease-out `t^0.8`)

| Slider | Effect at 100 |
| --- | --- |
| **waist** (slim) | each waist edge toward the centerline, 7% of waist width |
| **hips** (widen) | each hip edge outward, 8% of hip width |
| **bust** (enhance) | each bust edge outward 6% of bust width + 30% of that as up-lift |
| **BBL preset** | drives hips 100% + waist 60% |

Every contour point is an MLS pair (unmoved = pin). **Permanent anchors** are
present every frame: shoulders, spine centerline (shoulder/waist/hip heights),
mid-thigh edges, ankle centerline — they keep compression symmetric with no
sideways drift. The **localize radius** is derived from the body bounding box
(not the fixed 30%), so `Φ ≈ 1` across the whole cage and sliders feel strong.

UI: four sliders with readouts + per-slider reset, a **50/50 before·after split**
(left original, right edited), and spacebar still previews the original. Download
PNG now exports the composite at up to 4096px.

### M3 acceptance → how to check

- **Zero background warp:** the plate is a static quad; the mesh only ever
  samples the person layer. Toggle the M2 **matte tint** to see what's warped.
- **No dark fringing:** premultiplied alpha + `ONE, ONE_MINUS_SRC_ALPHA`.
- **No halo when slimming:** the band is inpainted; deep interior can't be
  revealed (caps < B).
- **Plate < a moment, sliders responsive:** preview plate is immediate; the
  native plate runs in the worker (its ms is `console.log`ged).
- **M1 + M2 intact:** `npm test` (MLS + inpaint cores) passes; the detector is
  unchanged.

> Bugfix carried in M3: the M1 texture upload flipped Y (`UNPACK_FLIP_Y=true`)
> while the mesh has v=0 at the image top — that rendered the image upside-down
> and mismatched the export flip and the image-space M2 overlays. Fixed to
> `FLIP_Y=false` so preview, export, and overlays are consistently upright.

## Layout

```
src/
  mls.ts             MLS similarity solve + locality layer (pure, unit-tested) — M1, untouched
  mesh.ts            96×96 grid generation (pure)
  camera.ts          pan / zoom (image px <-> screen px)
  glutil.ts          shader + texture helpers (image + raw-pixel textures)
  renderer.ts        M1 WebGL2 textured-mesh renderer (superseded by compositor)
  compositor.ts      M3 layered renderer: plate quad + person mesh (premultiplied)
  controlPoints.ts   control-point model / store
  overlay.ts         2D handle overlay
  interaction.ts     pointer / wheel / keyboard
  devpanel.ts        panel: sliders (M3) + detection (M2) + manual warp (M1)
  exporter.ts        composite native-resolution PNG export
  testPattern.ts     built-in gridded test image
  detector.ts        M2: MediaPipe init + segmentation + pose + contour (offline)
  contour.ts         M2: pure contour derivation from matte + landmarks
  detectionOverlay.ts M2: matte / pose / contour debug layers
  bodyEdit.ts        M3: sliders + anchors -> MLS pairs, bbox-derived radius (pure)
  person.ts          M3: matte upscale/feather + premultiplied person (pure)
  inpaintCore.ts     M3: band mask + multi-scale diffusion inpaint (pure, tested)
  inpaintWorker.ts   M3: native plate off the main thread
  inpaintClient.ts   M3: promisified worker client
  main.ts            wiring + render loop
public/
  wasm/              self-hosted MediaPipe wasm runtime
  models/            self-hosted .tflite / .task model files
test/
  mls.test.ts        M1 warp-engine acceptance tests
  inpaint.test.ts    M3 plate band-mask + diffusion tests
```
