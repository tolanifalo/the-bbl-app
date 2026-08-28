/** Shared, mutable warp/display options and UI constants. */

export interface WarpOptions {
  /** MLS falloff exponent (weight = 1/|p-v|^(2*alpha)). */
  alpha: number;
  /** Edit radius in image px (support of each moving handle). */
  radius: number;
  /** Enable the locality layer (false => pure global Schaefer MLS). */
  localize: boolean;
  /** Draw the deformed mesh wireframe. */
  showWireframe: boolean;
  /** Draw control-point handles + list overlay. */
  showControlPoints: boolean;
  /** Hold-to-preview the undeformed image (spacebar). */
  showOriginal: boolean;
}

/** Milestone-2 detection debug options (separate from the M1 warp options). */
export interface DebugOptions {
  /** Segmentation model: single-class selfie or multiclass (union non-bg). */
  segModel: "selfie" | "multiclass";
  /** Tint the detected person red @ 40%. */
  showMatte: boolean;
  /** Draw the 33 pose landmarks + skeleton. */
  showPose: boolean;
  /** Draw the 6 derived contour points. */
  showContour: boolean;
}

/** Milestone-3 body sliders (each 0-100). */
export interface SliderState {
  waist: number; // slim
  hips: number; // widen
  bust: number; // enhance + lift
  bbl: number; // preset: hips 100% + waist 60%
  ceiling: number;
}

/** Milestone-3 view options. */
export interface ViewOptions {
  /** Before/after split (left = original, right = edited). */
  split: boolean;
  /** Split divider position as a fraction of stage width [0..1]. */
  splitRatio: number;
}

export const GRID_QUADS = 96;
export const MAX_PREVIEW_SIZE = 2048;
export const MAX_CONTROL_POINTS = 40;
/** Long-side cap for the immediate preview clean plate (native runs in worker). */
export const PREVIEW_PLATE_SIZE = 640;

/** Screen-space (CSS px) hit radius for grabbing a handle. */
export const HANDLE_HIT_RADIUS = 11;
/** Pointer travel (CSS px) beyond which a press becomes a pan, not a click. */
export const CLICK_MOVE_THRESHOLD = 4;
