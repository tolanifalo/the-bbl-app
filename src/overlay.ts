import type { Camera } from "./camera.ts";
import type { ControlPointStore, ControlPoint } from "./controlPoints.ts";
import type { WarpOptions } from "./state.ts";

const COLOR_MOVING = "#33c6ff";
const COLOR_ANCHOR = "#ffb020";
const COLOR_ORIGIN = "#8a8f98";
const COLOR_SELECT = "#ffffff";

function isMoving(p: ControlPoint): boolean {
  return !p.anchor && (p.tx !== p.ox || p.ty !== p.oy);
}

/** Render control-point handles onto the 2D overlay (already scaled to CSS px). */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  _cssW: number,
  _cssH: number,
  camera: Camera,
  store: ControlPointStore,
  options: WarpOptions,
): void {
  // Note: the caller clears the overlay once per frame (detection layers draw
  // underneath these handles), so this function must not clear.
  if (!options.showControlPoints) return;

  // Edit radius ring around the selected moving handle (context for locality).
  const sel = store.get(store.selectedId);
  if (options.localize && sel && isMoving(sel)) {
    const [sx, sy] = camera.toScreen(sel.ox, sel.oy);
    ctx.beginPath();
    ctx.arc(sx, sy, options.radius * camera.scale, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(51,198,255,0.25)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const p of store.points) {
    const selected = p.id === store.selectedId;
    const [ox, oy] = camera.toScreen(p.ox, p.oy);

    if (p.anchor) {
      // Diamond pin.
      drawDiamond(ctx, ox, oy, 6, COLOR_ANCHOR, selected);
    } else {
      const [tx, ty] = camera.toScreen(p.tx, p.ty);
      if (isMoving(p)) {
        // Connector origin -> target.
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(tx, ty);
        ctx.strokeStyle = "rgba(51,198,255,0.7)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // Hollow origin.
        ctx.beginPath();
        ctx.arc(ox, oy, 3, 0, Math.PI * 2);
        ctx.strokeStyle = COLOR_ORIGIN;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      // Target handle.
      drawDisc(ctx, tx, ty, 6, COLOR_MOVING, selected);
    }
  }
}

function drawDisc(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  selected: boolean,
): void {
  if (selected) {
    ctx.beginPath();
    ctx.arc(x, y, r + 3, 0, Math.PI * 2);
    ctx.strokeStyle = COLOR_SELECT;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawDiamond(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  selected: boolean,
): void {
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
  };
  if (selected) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale((r + 3) / r, (r + 3) / r);
    ctx.translate(-x, -y);
    path();
    ctx.restore();
    ctx.strokeStyle = COLOR_SELECT;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  path();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.lineWidth = 1;
  ctx.stroke();
}
