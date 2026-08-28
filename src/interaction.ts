import type { Camera } from "./camera.ts";
import type { ControlPointStore } from "./controlPoints.ts";
import { CLICK_MOVE_THRESHOLD, HANDLE_HIT_RADIUS, type WarpOptions, type ViewOptions } from "./state.ts";

export interface InteractionDeps {
  camera: Camera;
  store: ControlPointStore;
  options: WarpOptions;
  view: ViewOptions;
  /** Native image size, or null if no image is loaded yet. */
  imageSize: () => { w: number; h: number } | null;
  /** Request a re-render (and MLS recompute). */
  markDirty: () => void;
  /** Notify that the control-point set changed (refresh the list UI). */
  onChange: () => void;
}

type Mode = "idle" | "maybeClick" | "pan" | "dragHandle" | "dragSplit";

/** Wire pointer / wheel / keyboard interaction onto `target` (the overlay). */
export function setupInteraction(target: HTMLElement, deps: InteractionDeps): void {
  const { camera, store, options, imageSize } = deps;

  let mode: Mode = "idle";
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let shiftAtStart = false;
  let dragId: number | null = null;

  const cssPos = (e: PointerEvent | WheelEvent): [number, number] => {
    const rect = target.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  /** Return the id of the topmost point whose grab handle is within hit radius. */
  const hitHandle = (sx: number, sy: number): number | null => {
    for (let i = store.points.length - 1; i >= 0; i--) {
      const p = store.points[i];
      // Grab point: target handle for regular points, origin pin for anchors.
      const hx = p.anchor ? p.ox : p.tx;
      const hy = p.anchor ? p.oy : p.ty;
      const [px, py] = camera.toScreen(hx, hy);
      if (Math.hypot(px - sx, py - sy) <= HANDLE_HIT_RADIUS) return p.id;
    }
    return null;
  };

  target.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (!imageSize()) return;
    const [sx, sy] = cssPos(e);
    startX = lastX = sx;
    startY = lastY = sy;
    shiftAtStart = e.shiftKey;
    target.setPointerCapture(e.pointerId);

    const hit = hitHandle(sx, sy);
    const splitX = deps.view.split ? target.clientWidth * deps.view.splitRatio : -100;

    if (deps.view.split && Math.abs(sx - splitX) < 24) {
      mode = "dragSplit";
    } else if (hit != null) {
      store.selectedId = hit;
      dragId = hit;
      mode = "dragHandle";
      deps.onChange();
      deps.markDirty();
    } else {
      mode = "maybeClick";
    }
  });

  target.addEventListener("pointermove", (e) => {
    if (mode === "idle") return;
    const [sx, sy] = cssPos(e);

    if (mode === "dragSplit") {
      deps.view.splitRatio = Math.max(0, Math.min(1, sx / target.clientWidth));
      deps.markDirty();
    } else if (mode === "dragHandle" && dragId != null) {
      const [ix, iy] = camera.toImage(sx, sy);
      store.moveHandle(dragId, ix, iy);
      deps.markDirty();
      deps.onChange();
    } else if (mode === "maybeClick") {
      if (Math.hypot(sx - startX, sy - startY) > CLICK_MOVE_THRESHOLD) {
        mode = "pan";
      }
    }
    if (mode === "pan") {
      camera.pan(sx - lastX, sy - lastY);
      deps.markDirty();
    }
    lastX = sx;
    lastY = sy;
  });

  const endPointer = (e: PointerEvent) => {
    if (mode === "maybeClick") {
      // A click on empty space places a control point (or an anchor with shift).
      const size = imageSize();
      const [ix, iy] = cssPos(e);
      const [imx, imy] = camera.toImage(ix, iy);
      if (size && imx >= 0 && imy >= 0 && imx <= size.w && imy <= size.h) {
        const added = store.add(imx, imy, shiftAtStart);
        if (added) {
          deps.onChange();
          deps.markDirty();
        }
      }
    }
    mode = "idle";
    dragId = null;
  };
  target.addEventListener("pointerup", endPointer);
  target.addEventListener("pointercancel", () => {
    mode = "idle";
    dragId = null;
  });

  target.addEventListener(
    "wheel",
    (e) => {
      if (!imageSize()) return;
      e.preventDefault();
      const [sx, sy] = cssPos(e);
      const factor = Math.exp(-e.deltaY * 0.0015);
      camera.zoomAt(sx, sy, factor);
      deps.markDirty();
    },
    { passive: false },
  );

  const typingInField = (): boolean => {
    const el = document.activeElement;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
  };

  window.addEventListener("keydown", (e) => {
    if (typingInField()) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      if (store.selectedId != null) {
        e.preventDefault();
        store.remove(store.selectedId);
        deps.onChange();
        deps.markDirty();
      }
    } else if (e.code === "Space") {
      e.preventDefault();
      if (!options.showOriginal) {
        options.showOriginal = true;
        deps.markDirty();
      }
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      options.showOriginal = false;
      deps.markDirty();
    }
  });
}
