/**
 * Body-intelligence pipeline (Milestone 2): person segmentation + pose +
 * derived contour points. MediaPipe Tasks Vision, run once per image in
 * static-image mode.
 *
 * OFFLINE: the wasm runtime and all model files are self-hosted under
 * /public (served from the app's own origin). Every fetch happens inside
 * `initDetector()`, which is kicked off at page load. After that, detection
 * runs entirely from in-memory models — zero network requests.
 */
import {
  FilesetResolver,
  ImageSegmenter,
  PoseLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import { deriveContour, scaleContour, type ContourPoints, type Landmark } from "./contour.ts";

export type SegModel = "selfie" | "multiclass";

const BASE = import.meta.env.BASE_URL; // "/" in dev; whatever base in build
const WASM_PATH = BASE + "wasm";
const MODELS = {
  selfie: BASE + "models/selfie_segmenter.tflite",
  multiclass: BASE + "models/selfie_multiclass_256x256.tflite",
  pose: BASE + "models/pose_landmarker_lite.task",
};

/** Cap the detection input so mask memory / upsampling stays bounded. */
const DETECT_MAX_SIDE = 1024;

export interface Matte {
  /** Detection-space dimensions (matte resolution). */
  width: number;
  height: number;
  /** 1 = person, 0 = background (thresholded at 0.5). */
  binary: Uint8Array;
  /** Soft person probability in [0,1]. */
  soft: Float32Array;
  /** Multiply detection-space coords by this to get image px. */
  scaleToImage: number;
  /** Red @ 40% where person, transparent elsewhere (detection-space canvas). */
  tint: HTMLCanvasElement;
  /** Fraction of pixels marked person (sanity metric). */
  coverage: number;
}

export interface LandmarkPx {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

export interface DetectionResult {
  imageW: number;
  imageH: number;
  model: SegModel;
  matte: Matte;
  /** 33 landmarks in image px, or null if no pose found. */
  landmarks: LandmarkPx[] | null;
  /** 6 contour points in image px, or null if not derivable. */
  contour: ContourPoints | null;
  timings: { segMs: number; poseMs: number; totalMs: number };
}

let readyPromise: Promise<void> | null = null;
const segmenters = new Map<SegModel, ImageSegmenter>();
let pose: PoseLandmarker | null = null;

/** Kick off (idempotent). All model + wasm network traffic happens here. */
export function initDetector(): Promise<void> {
  if (!readyPromise) {
    readyPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
      const [selfie, multiclass, poseLm] = await Promise.all([
        ImageSegmenter.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODELS.selfie },
          runningMode: "IMAGE",
          outputCategoryMask: true,
          outputConfidenceMasks: true,
        }),
        ImageSegmenter.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODELS.multiclass },
          runningMode: "IMAGE",
          outputCategoryMask: true,
          outputConfidenceMasks: true,
        }),
        PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODELS.pose },
          runningMode: "IMAGE",
          numPoses: 1,
        }),
      ]);
      segmenters.set("selfie", selfie);
      segmenters.set("multiclass", multiclass);
      pose = poseLm;
    })();
  }
  return readyPromise;
}

/** Run the full pipeline on one image. */
export async function runDetection(
  source: CanvasImageSource,
  imageW: number,
  imageH: number,
  model: SegModel,
): Promise<DetectionResult> {
  await initDetector();
  const segmenter = segmenters.get(model);
  if (!segmenter || !pose) throw new Error("Detector not initialized");

  const t0 = performance.now();

  // Downscaled detection canvas (bounds mask size + runtime).
  const long = Math.max(imageW, imageH);
  const s = long > DETECT_MAX_SIDE ? DETECT_MAX_SIDE / long : 1;
  const detW = Math.max(1, Math.round(imageW * s));
  const detH = Math.max(1, Math.round(imageH * s));
  const det = document.createElement("canvas");
  det.width = detW;
  det.height = detH;
  det.getContext("2d")!.drawImage(source, 0, 0, detW, detH);
  const scaleToImage = imageW / detW;

  // --- segmentation ---
  const ts = performance.now();
  const segRes = segmenter.segment(det);
  const matte = buildMatte(segRes, model, detW, detH, scaleToImage);
  segRes.close();
  const segMs = performance.now() - ts;

  // --- pose ---
  const tp = performance.now();
  const poseRes = pose.detect(det);
  const poseMs = performance.now() - tp;

  const rawLandmarks: NormalizedLandmark[] | undefined = poseRes.landmarks?.[0];
  const landmarks: LandmarkPx[] | null = rawLandmarks
    ? rawLandmarks.map((l) => ({
        x: l.x * imageW,
        y: l.y * imageH,
        z: l.z,
        visibility: l.visibility ?? 0,
      }))
    : null;

  // --- contour (derived in matte space, then scaled to image px) ---
  let contour: ContourPoints | null = null;
  if (rawLandmarks) {
    const lmDet: Landmark[] = rawLandmarks.map((l) => ({
      x: l.x * detW,
      y: l.y * detH,
      visibility: l.visibility ?? 0,
    }));
    const inDet = deriveContour(matte.binary, detW, detH, lmDet);
    if (inDet) contour = scaleContour(inDet, scaleToImage);
  }

  return {
    imageW,
    imageH,
    model,
    matte,
    landmarks,
    contour,
    timings: { segMs, poseMs, totalMs: performance.now() - t0 },
  };
}

interface SegmentLike {
  confidenceMasks?: Array<{ getAsFloat32Array(): Float32Array }>;
  categoryMask?: { getAsUint8Array(): Uint8Array };
}

/**
 * Build binary + soft mattes.
 *  - selfie (single class): confidence mask = foreground probability.
 *  - multiclass: person = any non-background category (union); soft = 1 - bg.
 */
function buildMatte(
  segRes: SegmentLike,
  model: SegModel,
  w: number,
  h: number,
  scaleToImage: number,
): Matte {
  const n = w * h;
  const binary = new Uint8Array(n);
  const soft = new Float32Array(n);

  if (model === "multiclass") {
    const cat = segRes.categoryMask?.getAsUint8Array();
    const conf = segRes.confidenceMasks;
    const bg = conf && conf.length > 0 ? conf[0].getAsFloat32Array() : null;
    for (let i = 0; i < n; i++) {
      const person = cat ? (cat[i] !== 0 ? 1 : 0) : 0;
      binary[i] = person;
      soft[i] = bg ? 1 - bg[i] : person;
    }
  } else {
    // Single-class selfie: last confidence mask is the foreground probability.
    const conf = segRes.confidenceMasks;
    const fg = conf && conf.length > 0 ? conf[conf.length - 1].getAsFloat32Array() : null;
    for (let i = 0; i < n; i++) {
      const p = fg ? fg[i] : 0;
      soft[i] = p;
      binary[i] = p >= 0.5 ? 1 : 0;
    }
  }

  // Tint canvas: red @ 40% where person.
  const tint = document.createElement("canvas");
  tint.width = w;
  tint.height = h;
  const tctx = tint.getContext("2d")!;
  const img = tctx.createImageData(w, h);
  const data = img.data;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (binary[i] === 1) {
      count++;
      const j = i * 4;
      data[j] = 255;
      data[j + 1] = 60;
      data[j + 2] = 60;
      data[j + 3] = 102; // ~40%
    }
  }
  tctx.putImageData(img, 0, 0);

  return { width: w, height: h, binary, soft, scaleToImage, tint, coverage: count / n };
}

/** Skeleton edges (index pairs) for drawing the pose. */
export function poseConnections(): ReadonlyArray<{ start: number; end: number }> {
  return PoseLandmarker.POSE_CONNECTIONS;
}
