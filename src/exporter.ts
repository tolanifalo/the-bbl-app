import type { Compositor } from "./compositor.ts";

/**
 * Composite export (Milestone 3): render the clean plate + warped person layer
 * into an offscreen framebuffer and download a PNG. Uses the current mesh
 * positions already in the compositor, so the export matches the preview.
 */
export async function exportComposite(
  gl: WebGL2RenderingContext,
  compositor: Compositor,
  plateTexture: WebGLTexture,
  personTexture: WebGLTexture | null,
  outW: number,
  outH: number,
  fileName = "bbl-edit.png",
): Promise<void> {
  const colorTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, colorTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, outW, outH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    cleanup();
    throw new Error("Export framebuffer incomplete: 0x" + status.toString(16));
  }

  gl.viewport(0, 0, outW, outH);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // canvas uniform = out size so image-px positions [0..outW] fill clip space.
  const u = { scale: 1, offsetX: 0, offsetY: 0, canvasW: outW, canvasH: outH };
  compositor.drawQuad(plateTexture, u);
  if (personTexture) compositor.drawPerson(personTexture, u);

  const pixels = new Uint8Array(outW * outH * 4);
  gl.readPixels(0, 0, outW, outH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  // readPixels is bottom-up; flip into a top-down ImageData.
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const octx = out.getContext("2d")!;
  const img = octx.createImageData(outW, outH);
  const rowBytes = outW * 4;
  for (let y = 0; y < outH; y++) {
    const src = (outH - 1 - y) * rowBytes;
    img.data.set(pixels.subarray(src, src + rowBytes), y * rowBytes);
  }
  octx.putImageData(img, 0, 0);

  cleanup();

  const blob: Blob | null = await new Promise((res) => out.toBlob(res, "image/png"));
  if (!blob) throw new Error("toBlob failed");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  function cleanup(): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(colorTex);
  }
}
