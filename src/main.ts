import "./style.css";
import { Camera } from "./camera.ts";
import { createGridMesh, type GridMesh } from "./mesh.ts";
import { Compositor } from "./compositor.ts";
import { createTextureFromSource, createTextureFromPixels } from "./glutil.ts";
import { deformPoints, buildControlPoints } from "./mls.ts";
import { ControlPointStore } from "./controlPoints.ts";
import { drawOverlay } from "./overlay.ts";
import { setupInteraction } from "./interaction.ts";
import { setupDevPanel } from "./devpanel.ts";
import { exportComposite } from "./exporter.ts";
import { generateTestPattern } from "./testPattern.ts";
import { drawDetectionOverlay } from "./detectionOverlay.ts";
import { initDetector, runDetection, type DetectionResult } from "./detector.ts";
import { buildBodyEdit } from "./bodyEdit.ts";
import { featherMatte, buildPremultipliedPerson } from "./person.ts";
import { buildCleanPlate } from "./inpaintCore.ts";
import { createInpaintWorker, inpaint } from "./inpaintClient.ts";
import {
  GRID_QUADS,
  MAX_PREVIEW_SIZE,
  PREVIEW_PLATE_SIZE,
  type WarpOptions,
  type DebugOptions,
  type SliderState,
  type ViewOptions,
} from "./state.ts";

const stage = document.getElementById("stage") as HTMLDivElement;
const glCanvas = document.getElementById("gl") as HTMLCanvasElement;
const overlayCanvas = document.getElementById("overlay") as HTMLCanvasElement;
const dropHint = document.getElementById("drop-hint") as HTMLDivElement;

const gl = glCanvas.getContext("webgl2", {
  alpha: true,
  premultipliedAlpha: false,
  antialias: true,
  preserveDrawingBuffer: false,
});
if (!gl) throw new Error("WebGL2 is not available in this browser.");
const octx = overlayCanvas.getContext("2d")!;

const MAX_TEX = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
const EXPORT_MAX = Math.min(4096, MAX_TEX); // native-layer cap (bounds worker/mem)

const compositor = new Compositor(gl);
const camera = new Camera();
const store = new ControlPointStore();
const worker = createInpaintWorker();

const options: WarpOptions = {
  alpha: 1.2,
  radius: 0,
  localize: true,
  showWireframe: false,
  showControlPoints: true,
  showOriginal: false,
};
const debug: DebugOptions = { segModel: "multiclass", showMatte: false, showPose: false, showContour: false };
const sliders: SliderState = { waist: 0, hips: 0, bust: 0, bbl: 0, ceiling: 100 };
const view: ViewOptions = { split: false, splitRatio: 0.5 };

// ---- loaded-image state ----
type ImageSrc = ImageBitmap | HTMLCanvasElement;
let exportSource: ImageSrc | null = null;
let mesh: GridMesh | null = null;
let dstX = new Float32Array(0);
let dstY = new Float32Array(0);
let nativeW = 0;
let nativeH = 0;
let exportDims = { w: 0, h: 0 };
let meshDirty = true;
let lastMlsMs = 0;
let bodyRadius = 0;
let detection: DetectionResult | null = null;
let detectToken = 0; // guards against stale async results

// Layer textures.
let originalTex: WebGLTexture | null = null;
let personTexPreview: WebGLTexture | null = null;
let plateTexPreview: WebGLTexture | null = null;
let plateTexNative: WebGLTexture | null = null;

let dpr = 1;

const markDirty = () => {
  meshDirty = true;
};

// ---- dev panel ----
const panel = setupDevPanel({
  options,
  debug,
  sliders,
  view,
  store,
  markDirty,
  onExport: doExport,
  onResetView: () => {
    if (mesh) camera.fit(nativeW, nativeH, stage.clientWidth, stage.clientHeight);
    markDirty();
  },
  onOpenFile: openFile,
  onLoadTest: () => loadSource(generateTestPattern(1024, 1280)),
  onRedetect: () => void detect(),
});

initDetector()
  .then(() => panel.setDetectStatus("models ready", "ok"))
  .catch((err) => {
    console.error(err);
    panel.setDetectStatus("model load failed (see console)", "err");
  });

// ---- interaction ----
setupInteraction(overlayCanvas, {
  camera,
  store,
  options,
  view,
  imageSize: () => (mesh ? { w: nativeW, h: nativeH } : null),
  markDirty,
  onChange: () => panel.refreshList(),
});

// ---- image loading ----
async function openFile(file: File): Promise<void> {
  try {
    const bitmap = await createImageBitmap(file);
    loadSource(bitmap);
  } catch (err) {
    console.error(err);
    alert("Could not load that image.");
  }
}

function loadSource(source: ImageSrc): void {
  nativeW = source.width;
  nativeH = source.height;
  exportSource = source;
  exportDims = fitDims(nativeW, nativeH, EXPORT_MAX);

  mesh = createGridMesh(GRID_QUADS, GRID_QUADS, nativeW, nativeH);
  compositor.setMesh(mesh);
  dstX = new Float32Array(mesh.vertexCount);
  dstY = new Float32Array(mesh.vertexCount);

  disposeLayerTextures();
  originalTex = makeImageTexture(source, nativeW, nativeH);

  store.clear();
  sliders.waist = sliders.hips = sliders.bust = sliders.bbl = 0;
  panel.syncSliders();
  panel.applyImageSize(Math.min(nativeW, nativeH));
  panel.refreshList();
  camera.fit(nativeW, nativeH, stage.clientWidth, stage.clientHeight);
  dropHint.classList.add("hidden");
  meshDirty = true;

  detection = null;
  void detect();
}

function disposeLayerTextures(): void {
  for (const t of [originalTex, personTexPreview, plateTexPreview, plateTexNative]) {
    if (t) gl!.deleteTexture(t);
  }
  originalTex = personTexPreview = plateTexPreview = plateTexNative = null;
}

/** Whole-image texture capped at MAX_PREVIEW_SIZE (the "before" / spacebar layer). */
function makeImageTexture(source: TexImageSource, w: number, h: number): WebGLTexture {
  const long = Math.max(w, h);
  if (long <= MAX_PREVIEW_SIZE) return createTextureFromSource(gl!, source);
  const s = MAX_PREVIEW_SIZE / long;
  const c = document.createElement("canvas");
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext("2d")!.drawImage(source as CanvasImageSource, 0, 0, c.width, c.height);
  return createTextureFromSource(gl!, c);
}

// ---- M2 detection + M3 layer building ----
async function detect(): Promise<void> {
  if (!exportSource) return;
  const token = ++detectToken;
  panel.setDetectStatus("detecting…", "busy");
  try {
    const result = await runDetection(exportSource as CanvasImageSource, nativeW, nativeH, debug.segModel);
    if (token !== detectToken) return;
    detection = result;
    const { segMs, poseMs, totalMs } = result.timings;
    const covPct = (result.matte.coverage * 100).toFixed(1);
    console.log(
      `[M2] segmentation ${segMs.toFixed(0)}ms · pose ${poseMs.toFixed(0)}ms · total ${totalMs.toFixed(0)}ms · ` +
        `model ${result.model} · matte ${covPct}% · ${result.contour ? "contour 6/6" : "no contour"}`,
    );
    panel.setDetectStatus(
      `done ${totalMs.toFixed(0)}ms · ${covPct}% matte · ${result.contour ? "6 pts" : "no contour"}`,
      "ok",
    );

    buildPreviewLayers(result);
    meshDirty = true;
    void buildNativePlate(result, token);
  } catch (err) {
    console.error(err);
    if (token === detectToken) {
      detection = null;
      panel.setDetectStatus("detection failed (see console)", "err");
    }
  }
}

/** Immediate preview person + plate so sliders work while the native plate runs. */
function buildPreviewLayers(det: DetectionResult): void {
  // Person layer (premultiplied) at preview resolution.
  const pd = fitDims(nativeW, nativeH, MAX_PREVIEW_SIZE);
  const origP = sampleRGBA(exportSource!, pd.w, pd.h);
  const alphaP = featherMatte(
    det.matte.soft, det.matte.width, det.matte.height, pd.w, pd.h, featherSigma(Math.max(pd.w, pd.h)),
  );
  const personPx = buildPremultipliedPerson(origP, alphaP, pd.w, pd.h);
  if (personTexPreview) gl!.deleteTexture(personTexPreview);
  personTexPreview = createTextureFromPixels(gl!, personPx, pd.w, pd.h);

  // Clean plate at a small resolution (fast), replaced by the native plate later.
  const gd = fitDims(nativeW, nativeH, PREVIEW_PLATE_SIZE);
  const origG = sampleRGBA(exportSource!, gd.w, gd.h);
  const binG = upscaleBinaryNearest(det.matte.binary, det.matte.width, det.matte.height, gd.w, gd.h);
  const B = Math.max(4, 0.15 * personBBoxWidth(binG, gd.w, gd.h));
  const dil = Math.max(2, Math.round(Math.max(gd.w, gd.h) * 0.004));
  const plateG = buildCleanPlate(new Uint8Array(origG.buffer), binG, gd.w, gd.h, dil, B);
  if (plateTexPreview) gl!.deleteTexture(plateTexPreview);
  plateTexPreview = createTextureFromPixels(gl!, plateG, gd.w, gd.h);
  if (plateTexNative) {
    gl!.deleteTexture(plateTexNative);
    plateTexNative = null;
  }
}

/** Native clean plate, computed once in the worker. */
async function buildNativePlate(det: DetectionResult, token: number): Promise<void> {
  const ed = exportDims;
  const orig = sampleRGBA(exportSource!, ed.w, ed.h);
  const bin = upscaleBinaryNearest(det.matte.binary, det.matte.width, det.matte.height, ed.w, ed.h);
  const B = Math.max(6, 0.15 * personBBoxWidth(bin, ed.w, ed.h));
  const dil = Math.max(3, Math.round(Math.max(ed.w, ed.h) * 0.004));
  const res = await inpaint(worker, {
    rgba: new Uint8Array(orig.buffer, orig.byteOffset, orig.length),
    binary: bin,
    w: ed.w,
    h: ed.h,
    dilatePx: dil,
    erodePx: B,
  });
  if (token !== detectToken) return;
  console.log(`[M3] native plate ${res.w}x${res.h} inpaint ${res.ms.toFixed(0)}ms`);
  if (plateTexNative) gl!.deleteTexture(plateTexNative);
  plateTexNative = createTextureFromPixels(gl!, res.rgba, res.w, res.h);
}

// ---- deformation (drives the person mesh) ----
function recompute(): void {
  if (!mesh) return;
  const origins: [number, number][] = [];
  const targets: [number, number][] = [];

  bodyRadius = 0;
  if (detection?.contour) {
    const be = buildBodyEdit(detection, sliders);
    if (be) {
      bodyRadius = be.radius;
      for (const p of be.pairs) {
        origins.push([p.ox, p.oy]);
        targets.push([p.tx, p.ty]);
      }
    }
  }
  for (const p of store.points) {
    origins.push([p.ox, p.oy]);
    targets.push([p.tx, p.ty]);
  }

  const cp = buildControlPoints(origins, targets);
  const radius = bodyRadius > 0 ? bodyRadius : options.radius;
  const t0 = performance.now();
  deformPoints(cp, mesh.srcX, mesh.srcY, dstX, dstY, mesh.vertexCount, {
    alpha: options.alpha,
    localize: options.localize,
    radius,
  });
  lastMlsMs = performance.now() - t0;
  compositor.updatePersonPositions(dstX, dstY, mesh.vertexCount);
}

async function doExport(): Promise<void> {
  if (!mesh || !exportSource) {
    alert("Load an image first.");
    return;
  }
  recompute();
  panel.setEditStatus("exporting…", "busy");
  const ed = exportDims;
  const plate = plateTexNative ?? plateTexPreview ?? originalTex!;

  // Build the native premultiplied person for a crisp export.
  let personNative: WebGLTexture | null = null;
  if (detection) {
    const orig = sampleRGBA(exportSource, ed.w, ed.h);
    const alpha = featherMatte(
      detection.matte.soft, detection.matte.width, detection.matte.height, ed.w, ed.h,
      featherSigma(Math.max(ed.w, ed.h)),
    );
    const px = buildPremultipliedPerson(orig, alpha, ed.w, ed.h);
    personNative = createTextureFromPixels(gl!, px, ed.w, ed.h);
  }
  try {
    await exportComposite(gl!, compositor, plate, personNative, ed.w, ed.h);
    panel.setEditStatus(`exported ${ed.w}×${ed.h}`, "ok");
  } catch (err) {
    console.error(err);
    panel.setEditStatus("export failed (see console)", "err");
  } finally {
    if (personNative) gl!.deleteTexture(personNative);
  }
  meshDirty = true;
}

// ---- pixel helpers ----
function sampleRGBA(source: CanvasImageSource, w: number, h: number): Uint8ClampedArray {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cx = c.getContext("2d", { willReadFrequently: true })!;
  cx.drawImage(source, 0, 0, w, h);
  return cx.getImageData(0, 0, w, h).data;
}

function upscaleBinaryNearest(bin: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
      out[y * dw + x] = bin[sy * sw + sx];
    }
  }
  return out;
}

function personBBoxWidth(bin: Uint8Array, w: number, h: number): number {
  let minX = w, maxX = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (bin[row + x] === 1) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  return maxX >= minX ? maxX - minX : w;
}

function featherSigma(long: number): number {
  return Math.max(0.6, (1.5 * long) / 1024);
}

function fitDims(w: number, h: number, maxLong: number): { w: number; h: number } {
  const long = Math.max(w, h);
  const s = long > maxLong ? maxLong / long : 1;
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// ---- resize ----
function syncCanvasSize(): void {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const dw = Math.round(stage.clientWidth * dpr);
  const dh = Math.round(stage.clientHeight * dpr);
  if (glCanvas.width !== dw || glCanvas.height !== dh) {
    glCanvas.width = dw;
    glCanvas.height = dh;
    overlayCanvas.width = dw;
    overlayCanvas.height = dh;
  }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ---- render loop ----
let frames = 0;
let fpsClock = performance.now();

function frame(): void {
  syncCanvasSize();
  const cssW = stage.clientWidth;
  const cssH = stage.clientHeight;

  gl!.viewport(0, 0, glCanvas.width, glCanvas.height);
  gl!.clearColor(0, 0, 0, 0);
  gl!.clear(gl!.COLOR_BUFFER_BIT);
  octx.clearRect(0, 0, cssW, cssH);

  if (mesh && originalTex) {
    if (meshDirty) {
      recompute();
      meshDirty = false;
    }
    const u = { scale: camera.scale, offsetX: camera.offsetX, offsetY: camera.offsetY, canvasW: cssW, canvasH: cssH };
    const plateTex = plateTexNative ?? plateTexPreview;
    const splitX = view.split ? cssW * view.splitRatio : 0;

    if (options.showOriginal) {
      compositor.drawQuad(originalTex, u);
    } else if (view.split) {
      compositor.drawQuad(originalTex, u); // left half stays "before"
      const dx = Math.round(splitX * dpr);
      gl!.enable(gl!.SCISSOR_TEST);
      gl!.scissor(dx, 0, glCanvas.width - dx, glCanvas.height);
      compositor.drawQuad(plateTex ?? originalTex, u);
      if (personTexPreview) compositor.drawPerson(personTexPreview, u);
      if (options.showWireframe) compositor.drawWireframe(u);
      gl!.disable(gl!.SCISSOR_TEST);
    } else {
      compositor.drawQuad(plateTex ?? originalTex, u);
      if (personTexPreview) compositor.drawPerson(personTexPreview, u);
      if (options.showWireframe) compositor.drawWireframe(u);
    }

    drawDetectionOverlay(octx, camera, detection, debug);
    drawOverlay(octx, cssW, cssH, camera, store, options);
    if (view.split && !options.showOriginal) drawSplitDivider(splitX, cssH);
  }

  frames++;
  const now = performance.now();
  if (now - fpsClock >= 500) {
    const fps = (frames * 1000) / (now - fpsClock);
    frames = 0;
    fpsClock = now;
    panel.setPerf(fps, lastMlsMs);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function drawSplitDivider(x: number, cssH: number): void {
  octx.save();
  octx.strokeStyle = "rgba(255,255,255,0.9)";
  octx.lineWidth = 1.5;
  octx.beginPath();
  octx.moveTo(x, 0);
  octx.lineTo(x, cssH);
  octx.stroke();

  // Draw draggable handle
  const cy = cssH / 2;
  octx.fillStyle = "rgba(255,255,255,0.9)";
  octx.shadowColor = "rgba(0,0,0,0.3)";
  octx.shadowBlur = 6;
  octx.beginPath();
  octx.arc(x, cy, 16, 0, Math.PI * 2);
  octx.fill();
  octx.shadowColor = "transparent";

  // Handle grips
  octx.strokeStyle = "rgba(0,0,0,0.3)";
  octx.lineWidth = 2;
  octx.beginPath();
  octx.moveTo(x - 3, cy - 5);
  octx.lineTo(x - 3, cy + 5);
  octx.moveTo(x + 3, cy - 5);
  octx.lineTo(x + 3, cy + 5);
  octx.stroke();

  octx.font = "600 11px ui-monospace, monospace";
  octx.fillStyle = "rgba(255,255,255,0.85)";
  octx.textBaseline = "middle";
  octx.textAlign = "right";
  octx.shadowColor = "rgba(0,0,0,0.8)";
  octx.shadowBlur = 4;
  octx.fillText("before", x - 24, cy);
  octx.textAlign = "left";
  octx.fillText("after", x + 24, cy);
  octx.restore();
}

// ---- drag & drop ----
function stopDnd(e: DragEvent): void {
  e.preventDefault();
  e.stopPropagation();
}
stage.addEventListener("dragover", (e) => {
  stopDnd(e);
  stage.classList.add("dragover");
});
stage.addEventListener("dragleave", (e) => {
  stopDnd(e);
  stage.classList.remove("dragover");
});
stage.addEventListener("drop", (e) => {
  stopDnd(e);
  stage.classList.remove("dragover");
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type.startsWith("image/")) openFile(file);
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
