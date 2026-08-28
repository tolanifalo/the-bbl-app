/// <reference lib="webworker" />
/**
 * Web worker: build the clean plate at native resolution off the main thread,
 * so sliders stay responsive while it runs.
 */
import { buildCleanPlate } from "./inpaintCore.ts";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

interface Req {
  id: number;
  rgba: ArrayBuffer;
  binary: ArrayBuffer;
  w: number;
  h: number;
  dilatePx: number;
  erodePx: number;
}

ctx.onmessage = (e: MessageEvent<Req>) => {
  const { id, rgba, binary, w, h, dilatePx, erodePx } = e.data;
  const t0 = performance.now();
  const out = buildCleanPlate(new Uint8Array(rgba), new Uint8Array(binary), w, h, dilatePx, erodePx);
  const ms = performance.now() - t0;
  ctx.postMessage({ id, rgba: out.buffer, w, h, ms }, [out.buffer]);
};
