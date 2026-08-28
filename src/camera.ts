/**
 * 2D camera mapping image-space px <-> screen (CSS) px.
 *   screen = image * scale + offset
 * Device-pixel-ratio does not enter here: it scales the drawing buffer only,
 * and cancels out in the clip-space transform (see renderer / vertex shader).
 */
export class Camera {
  scale = 1;
  offsetX = 0;
  offsetY = 0;

  /** image px -> screen (CSS) px */
  toScreen(ix: number, iy: number): [number, number] {
    return [ix * this.scale + this.offsetX, iy * this.scale + this.offsetY];
  }

  /** screen (CSS) px -> image px */
  toImage(sx: number, sy: number): [number, number] {
    return [(sx - this.offsetX) / this.scale, (sy - this.offsetY) / this.scale];
  }

  /** Fit an image of size (w,h) centered in a viewport of (vw,vh) CSS px. */
  fit(w: number, h: number, vw: number, vh: number, margin = 0.92): void {
    const s = Math.min(vw / w, vh / h) * margin;
    this.scale = s;
    this.offsetX = (vw - w * s) / 2;
    this.offsetY = (vh - h * s) / 2;
  }

  /** Zoom by `factor` while keeping the image point under (sx,sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number, min = 0.02, max = 40): void {
    const next = Math.min(max, Math.max(min, this.scale * factor));
    const [ix, iy] = this.toImage(sx, sy);
    this.scale = next;
    this.offsetX = sx - ix * next;
    this.offsetY = sy - iy * next;
  }

  pan(dx: number, dy: number): void {
    this.offsetX += dx;
    this.offsetY += dy;
  }
}
