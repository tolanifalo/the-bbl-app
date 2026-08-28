import { buildControlPoints, type MlsControlPoints } from "./mls.ts";
import { MAX_CONTROL_POINTS } from "./state.ts";

export interface ControlPoint {
  id: number;
  /** Origin in image px (where it was placed). */
  ox: number;
  oy: number;
  /** Target in image px (draggable). For anchors, always equals origin. */
  tx: number;
  ty: number;
  /** True => pin (target locked to origin). */
  anchor: boolean;
}

export class ControlPointStore {
  points: ControlPoint[] = [];
  selectedId: number | null = null;
  private nextId = 1;

  get count(): number {
    return this.points.length;
  }

  get(id: number | null): ControlPoint | undefined {
    if (id == null) return undefined;
    return this.points.find((p) => p.id === id);
  }

  atCapacity(): boolean {
    return this.points.length >= MAX_CONTROL_POINTS;
  }

  add(x: number, y: number, anchor: boolean): ControlPoint | null {
    if (this.atCapacity()) return null;
    const p: ControlPoint = { id: this.nextId++, ox: x, oy: y, tx: x, ty: y, anchor };
    this.points.push(p);
    this.selectedId = p.id;
    return p;
  }

  remove(id: number): void {
    const i = this.points.findIndex((p) => p.id === id);
    if (i >= 0) this.points.splice(i, 1);
    if (this.selectedId === id) this.selectedId = null;
  }

  clear(): void {
    this.points = [];
    this.selectedId = null;
  }

  /** Move a handle. Anchors move origin+target together (stay pinned). */
  moveHandle(id: number, x: number, y: number): void {
    const p = this.get(id);
    if (!p) return;
    if (p.anchor) {
      p.ox = x;
      p.oy = y;
      p.tx = x;
      p.ty = y;
    } else {
      p.tx = x;
      p.ty = y;
    }
  }

  /** Pack into the MLS control-point arrays. */
  build(): MlsControlPoints {
    const origins: [number, number][] = this.points.map((p) => [p.ox, p.oy]);
    const targets: [number, number][] = this.points.map((p) => [p.tx, p.ty]);
    return buildControlPoints(origins, targets);
  }
}
