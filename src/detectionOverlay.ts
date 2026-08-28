import type { Camera } from "./camera.ts";
import type { DebugOptions } from "./state.ts";
import type { DetectionResult } from "./detector.ts";
import { poseConnections } from "./detector.ts";
import type { ContourPoints, Pt } from "./contour.ts";

/**
 * Debug overlays for the M2 detection results, drawn on the same 2D overlay
 * canvas (already scaled to CSS px) BEFORE the M1 control-point handles, so
 * handles stay on top. All layers are opt-in (checkboxes, default off).
 */
export function drawDetectionOverlay(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  detection: DetectionResult | null,
  debug: DebugOptions,
): void {
  if (!detection) return;

  if (debug.showMatte) drawMatte(ctx, camera, detection);
  if (debug.showPose) drawPose(ctx, camera, detection);
  if (debug.showContour && detection.contour) drawContour(ctx, camera, detection.contour);
}

function drawMatte(ctx: CanvasRenderingContext2D, camera: Camera, d: DetectionResult): void {
  // The tint canvas spans the whole image in detection space; map it into
  // image space (0..imageW) and let the camera transform take it to screen.
  ctx.save();
  ctx.translate(camera.offsetX, camera.offsetY);
  ctx.scale(camera.scale, camera.scale);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(d.matte.tint, 0, 0, d.imageW, d.imageH);
  ctx.restore();
}

function drawPose(ctx: CanvasRenderingContext2D, camera: Camera, d: DetectionResult): void {
  const lms = d.landmarks;
  if (!lms) return;

  ctx.strokeStyle = "rgba(120,220,120,0.85)";
  ctx.lineWidth = 2;
  for (const c of poseConnections()) {
    const a = lms[c.start];
    const b = lms[c.end];
    if (!a || !b) continue;
    const [ax, ay] = camera.toScreen(a.x, a.y);
    const [bx, by] = camera.toScreen(b.x, b.y);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  for (const l of lms) {
    const [x, y] = camera.toScreen(l.x, l.y);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = l.visibility >= 0.5 ? "#39d353" : "rgba(57,211,83,0.4)";
    ctx.fill();
  }
}

function drawContour(ctx: CanvasRenderingContext2D, camera: Camera, c: ContourPoints): void {
  const dots: Array<{ p: Pt; label: string }> = [
    { p: c.bustL, label: "bust L" },
    { p: c.bustR, label: "bust R" },
    { p: c.waistL, label: "waist L" },
    { p: c.waistR, label: "waist R" },
    { p: c.hipL, label: "hip L" },
    { p: c.hipR, label: "hip R" },
  ];

  // Faint silhouette guide connecting left edges and right edges.
  ctx.strokeStyle = "rgba(255,80,160,0.5)";
  ctx.lineWidth = 1.5;
  strokePolyline(ctx, camera, [c.bustL, c.waistL, c.hipL]);
  strokePolyline(ctx, camera, [c.bustR, c.waistR, c.hipR]);

  ctx.font = "600 11px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  for (const { p, label } of dots) {
    const [x, y] = camera.toScreen(p.x, p.y);
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ff50a0";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 1;
    ctx.stroke();

    const onLeft = label.endsWith("L");
    ctx.textAlign = onLeft ? "right" : "left";
    const tx = x + (onLeft ? -9 : 9);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.strokeText(label, tx, y);
    ctx.fillStyle = "#ffd6ea";
    ctx.fillText(label, tx, y);
  }
}

function strokePolyline(ctx: CanvasRenderingContext2D, camera: Camera, pts: Pt[]): void {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = camera.toScreen(p.x, p.y);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}
