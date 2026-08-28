import type { WarpOptions, DebugOptions, SliderState, ViewOptions } from "./state.ts";
import { MAX_CONTROL_POINTS } from "./state.ts";
import type { ControlPointStore, ControlPoint } from "./controlPoints.ts";
import type { SegModel } from "./detector.ts";

export interface DevPanelDeps {
  options: WarpOptions;
  debug: DebugOptions;
  sliders: SliderState;
  view: ViewOptions;
  store: ControlPointStore;
  markDirty: () => void;
  onExport: () => void;
  onResetView: () => void;
  onOpenFile: (file: File) => void;
  onLoadTest: () => void;
  /** Rerun the M2 detection pipeline (e.g. after switching model). */
  onRedetect: () => void;
}

export interface DevPanel {
  refreshList: () => void;
  /** Recompute the px radius from the % slider for the loaded image. */
  applyImageSize: (minDim: number) => void;
  setPerf: (fps: number, mlsMs: number) => void;
  setDetectStatus: (text: string, kind?: "ok" | "err" | "busy" | "") => void;
  setEditStatus: (text: string, kind?: "ok" | "err" | "busy" | "") => void;
  /** Reflect the current slider state into the inputs. */
  syncSliders: () => void;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error("Missing #" + id);
  return node as T;
}

function isMoving(p: ControlPoint): boolean {
  return !p.anchor && (p.tx !== p.ox || p.ty !== p.oy);
}

export function setupDevPanel(deps: DevPanelDeps): DevPanel {
  const { options, debug, sliders, view, store, markDirty } = deps;

  const alpha = el<HTMLInputElement>("alpha");
  const alphaVal = el("alpha-val");
  const radius = el<HTMLInputElement>("radius");
  const radiusVal = el("radius-val");
  const localize = el<HTMLInputElement>("localize");
  const wireframe = el<HTMLInputElement>("wireframe");
  const showCp = el<HTMLInputElement>("show-cp");
  const fileInput = el<HTMLInputElement>("file-input");
  const listEl = el("points-list");
  const countEl = el("cp-count");
  const fpsEl = el("fps");
  const mlsEl = el("mls-ms");

  // M2 detection controls.
  const segModel = el<HTMLSelectElement>("seg-model");
  const showMatte = el<HTMLInputElement>("show-matte");
  const showPose = el<HTMLInputElement>("show-pose");
  const showContour = el<HTMLInputElement>("show-contour");
  const sliderCeiling = el<HTMLInputElement>("slider-ceiling");

  // M3 sliders + view.
  const split = el<HTMLInputElement>("split");
  const holdCompare = el<HTMLButtonElement>("hold-compare");
  const sliderDefs: Array<[keyof SliderState, string]> = [
    ["waist", "s-waist"],
    ["hips", "s-hips"],
    ["bust", "s-bust"],
    ["bbl", "s-bbl"],
  ];
  const sliderInputs = {} as Record<keyof SliderState, HTMLInputElement>;
  const sliderVals = {} as Record<keyof SliderState, HTMLInputElement>;

  for (const [key, id] of sliderDefs) {
    const input = el<HTMLInputElement>(id);
    const valEl = el<HTMLInputElement>(id + "-val");
    sliderInputs[key] = input;
    sliderVals[key] = valEl;
    
    // Sync range slider -> number input
    input.addEventListener("input", () => {
      sliders[key] = Number(input.value);
      valEl.value = input.value;
      markDirty();
    });
    
    // Sync number input -> range slider
    valEl.addEventListener("input", () => {
      const v = Math.min(Number(valEl.max), Math.max(Number(valEl.min), Number(valEl.value) || 0));
      sliders[key] = v;
      input.value = String(v);
      markDirty();
    });
    el(id + "-reset").addEventListener("click", () => {
      sliders[key] = 0;
      input.value = "0";
      valEl.value = "0";
      markDirty();
    });
  }

  sliderCeiling.addEventListener("input", () => {
    const ceil = parseInt(sliderCeiling.value) || 100;
    sliders.ceiling = ceil;
    
    for (const [key] of sliderDefs) {
      const valEl = sliderVals[key];
      const rngEl = sliderInputs[key];
      valEl.max = ceil.toString();
      rngEl.max = ceil.toString();
      
      if (sliders[key] > ceil) {
        sliders[key] = ceil;
      }
      
      // sync
      rngEl.value = String(sliders[key]);
      valEl.value = String(sliders[key]);
    }
    
    markDirty();
  });

  split.addEventListener("change", () => {
    view.split = split.checked;
    markDirty();
  });

  let hudTimeout = 0;
  const showHud = (msg: string, type: "original" | "enhanced" | "error" | "info" = "info", duration = 800) => {
    const hud = document.getElementById("hud-label");
    if (!hud) return;
    hud.textContent = msg;
    hud.className = `hud-label show ${type}`;
    window.clearTimeout(hudTimeout);
    if (duration > 0) {
      hudTimeout = window.setTimeout(() => {
        hud.className = `hud-label ${type}`;
      }, duration);
    }
  };

  const triggerCompare = (on: boolean) => {
    if (minDim === 0) {
      if (on) showHud("SELECT AN IMAGE FIRST", "error", 1500);
      return;
    }
    
    // Only show ENHANCED if we were actually showing the original
    if (!on && !options.showOriginal) return;

    options.showOriginal = on;
    markDirty();

    if (on) {
      showHud("ORIGINAL", "original", 0); // Stays on
    } else {
      showHud("ENHANCED", "enhanced", 800);
    }
  };
  holdCompare.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    triggerCompare(true);
  });
  window.addEventListener("pointerup", () => triggerCompare(false));
  holdCompare.addEventListener("contextmenu", (e) => e.preventDefault());

  // Also bind Spacebar to the HUD logic (spacebar logic is currently in interaction.ts but we can just listen here too, or just let interaction.ts change options and we just listen to keydown here? Actually interaction.ts handles keydown. Let's just add a window keydown listener here for spacebar to trigger the HUD)
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat && document.activeElement?.tagName !== "INPUT") {
      triggerCompare(true);
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      triggerCompare(false);
    }
  });

  const closeShortcuts = document.getElementById("close-shortcuts");
  const shortcutsPane = document.getElementById("shortcuts-pane");
  const shortcutsToggle = document.getElementById("shortcuts-toggle");
  if (closeShortcuts && shortcutsPane && shortcutsToggle) {
    closeShortcuts.addEventListener("click", () => {
      shortcutsPane.classList.add("hidden");
      shortcutsToggle.classList.remove("hidden");
    });
    shortcutsToggle.addEventListener("click", () => {
      shortcutsToggle.classList.add("hidden");
      shortcutsPane.classList.remove("hidden");
    });
  }

  let minDim = 0; // image min dimension, for % -> px radius

  const applyRadius = (): void => {
    const pct = Number(radius.value);
    (radiusVal as HTMLInputElement).value = String(pct);
    options.radius = minDim > 0 ? (pct / 100) * minDim : 0;
  };

  alpha.addEventListener("input", () => {
    options.alpha = Number(alpha.value);
    (alphaVal as HTMLInputElement).value = options.alpha.toFixed(2);
    markDirty();
  });
  
  (alphaVal as HTMLInputElement).addEventListener("input", () => {
    const v = Math.min(3, Math.max(0.2, Number((alphaVal as HTMLInputElement).value) || 1.2));
    options.alpha = v;
    alpha.value = String(v);
    markDirty();
  });

  radius.addEventListener("input", () => {
    applyRadius();
    markDirty();
  });
  
  (radiusVal as HTMLInputElement).addEventListener("input", () => {
    const v = Math.min(100, Math.max(5, Number((radiusVal as HTMLInputElement).value) || 30));
    radius.value = String(v);
    applyRadius();
    markDirty();
  });
  localize.addEventListener("change", () => {
    options.localize = localize.checked;
    markDirty();
  });
  wireframe.addEventListener("change", () => {
    options.showWireframe = wireframe.checked;
    markDirty();
  });
  showCp.addEventListener("change", () => {
    options.showControlPoints = showCp.checked;
    markDirty();
  });

  segModel.addEventListener("change", () => {
    debug.segModel = segModel.value as SegModel;
    deps.onRedetect();
  });
  showMatte.addEventListener("change", () => {
    debug.showMatte = showMatte.checked;
  });
  showPose.addEventListener("change", () => {
    debug.showPose = showPose.checked;
  });
  showContour.addEventListener("change", () => {
    debug.showContour = showContour.checked;
  });
  el("redetect").addEventListener("click", () => {
    if (minDim === 0) return showHud("SELECT AN IMAGE FIRST", "error", 1500);
    showHud("RE-DETECTING...", "info", 1000);
    deps.onRedetect();
  });

  el("download").addEventListener("click", () => {
    if (minDim === 0) return showHud("SELECT AN IMAGE FIRST", "error", 1500);
    showHud("EXPORTING...", "info", 0);
    deps.onExport();
  });
  el("reset-view").addEventListener("click", () => {
    if (minDim === 0) return showHud("SELECT AN IMAGE FIRST", "error", 1500);
    showHud("VIEW RESET", "info", 800);
    deps.onResetView();
  });
  el("clear").addEventListener("click", () => {
    if (minDim === 0) return showHud("SELECT AN IMAGE FIRST", "error", 1500);
    showHud("POINTS CLEARED", "info", 800);
    store.clear();
    refreshList();
    markDirty();
  });
  el("open-file").addEventListener("click", () => fileInput.click());
  el("load-test").addEventListener("click", deps.onLoadTest);
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f) deps.onOpenFile(f);
    fileInput.value = "";
  });

  function refreshList(): void {
    countEl.textContent = `${store.count} / ${MAX_CONTROL_POINTS}`;
    listEl.replaceChildren();
    if (store.count === 0) {
      const empty = document.createElement("div");
      empty.className = "cp-empty";
      empty.textContent = "No points. Click the image to add one.";
      listEl.append(empty);
      return;
    }
    store.points.forEach((p, i) => {
      const row = document.createElement("div");
      row.className = "cp-row" + (p.id === store.selectedId ? " selected" : "");

      const badge = document.createElement("span");
      badge.className = "cp-badge " + (p.anchor ? "anchor" : "moving");

      const coords = document.createElement("span");
      coords.className = "cp-coords";
      const o = `(${Math.round(p.ox)}, ${Math.round(p.oy)})`;
      if (p.anchor) {
        coords.textContent = `#${i + 1} anchor ${o}`;
      } else if (isMoving(p)) {
        coords.textContent = `#${i + 1} ${o}→(${Math.round(p.tx)}, ${Math.round(p.ty)})`;
      } else {
        coords.textContent = `#${i + 1} point ${o}`;
      }

      const del = document.createElement("button");
      del.className = "cp-del";
      del.textContent = "✕";
      del.title = "Delete point";
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        store.remove(p.id);
        refreshList();
        markDirty();
      });

      row.addEventListener("click", () => {
        store.selectedId = p.id;
        refreshList();
        markDirty();
      });

      row.append(badge, coords, del);
      listEl.append(row);
    });
  }

  // Initialize labels from current option values.
  alpha.value = String(options.alpha);
  (alphaVal as HTMLInputElement).value = options.alpha.toFixed(2);
  localize.checked = options.localize;
  wireframe.checked = options.showWireframe;
  showCp.checked = options.showControlPoints;
  segModel.value = debug.segModel;
  showMatte.checked = debug.showMatte;
  showPose.checked = debug.showPose;
  showContour.checked = debug.showContour;
  refreshList();

  return {
    refreshList,
    applyImageSize(dim: number) {
      minDim = dim;
      applyRadius();
    },
    setPerf(fps: number, mlsMs: number) {
      fpsEl.textContent = `${fps.toFixed(0)} fps`;
      mlsEl.textContent = mlsMs > 0 ? `MLS ${mlsMs.toFixed(1)} ms` : "";
    },
    setDetectStatus(text: string, kind: "ok" | "err" | "busy" | "" = "") {
      if (text.includes("models ready")) return; // Don't show models ready
      if (text.includes("detecting")) return; // Already handled by re-detect click
      const type = kind === "err" ? "error" : "info";
      showHud(text.toUpperCase(), type, 2000);
    },
    setEditStatus(text: string, kind: "ok" | "err" | "busy" | "" = "") {
      const type = kind === "err" ? "error" : "info";
      showHud(text.toUpperCase(), type, kind === "busy" ? 0 : 2000);
    },
    syncSliders() {
      for (const [key, id] of sliderDefs) {
        void id;
        sliderInputs[key].value = String(sliders[key]);
        sliderVals[key].value = String(sliders[key]);
      }
      split.checked = view.split;
    },
  };
}
