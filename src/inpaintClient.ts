/** Main-thread client for the inpaint worker (promisified, id-matched). */

export interface InpaintParams {
  rgba: Uint8Array; // RGBA, row 0 = top
  binary: Uint8Array; // 1 = person
  w: number;
  h: number;
  dilatePx: number;
  erodePx: number;
}

export interface InpaintResult {
  rgba: Uint8Array;
  w: number;
  h: number;
  ms: number;
}

export function createInpaintWorker(): Worker {
  return new Worker(new URL("./inpaintWorker.ts", import.meta.url), { type: "module" });
}

let nextId = 1;

export function inpaint(worker: Worker, params: InpaintParams): Promise<InpaintResult> {
  const id = nextId++;
  return new Promise((resolve) => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.id !== id) return;
      worker.removeEventListener("message", onMsg);
      resolve({ rgba: new Uint8Array(e.data.rgba), w: e.data.w, h: e.data.h, ms: e.data.ms });
    };
    worker.addEventListener("message", onMsg);
    // Copy buffers before transferring (callers keep their originals).
    const rgbaBuf = params.rgba.slice().buffer;
    const binBuf = params.binary.slice().buffer;
    worker.postMessage(
      { id, rgba: rgbaBuf, binary: binBuf, w: params.w, h: params.h, dilatePx: params.dilatePx, erodePx: params.erodePx },
      [rgbaBuf, binBuf],
    );
  });
}
