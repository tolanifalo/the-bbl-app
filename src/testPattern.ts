/**
 * A deterministic test image: a full-frame grid (so warps are obvious and
 * far-field locality is easy to diff) plus a colorful center subject.
 */
export function generateTestPattern(w = 1024, h = 1024): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;

  // Background gradient.
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#eef2f7");
  g.addColorStop(1, "#c9d3e0");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Fine grid.
  ctx.strokeStyle = "rgba(60,80,110,0.28)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= w; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
  }
  // Major grid.
  ctx.strokeStyle = "rgba(40,60,90,0.5)";
  ctx.lineWidth = 1.5;
  for (let x = 0; x <= w; x += 128) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += 128) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
  }

  // Center subject: concentric rings + a vertical bar (a "waistline" to nudge).
  const cx = w / 2;
  const cy = h / 2;
  const rings = ["#ff5d73", "#ffa14a", "#ffd23f", "#4ac6ff", "#7c5cff"];
  for (let i = rings.length - 1; i >= 0; i--) {
    ctx.beginPath();
    ctx.arc(cx, cy, (i + 1) * (Math.min(w, h) * 0.06), 0, Math.PI * 2);
    ctx.fillStyle = rings[i];
    ctx.fill();
  }
  ctx.fillStyle = "#12131a";
  ctx.fillRect(cx - 6, cy - Math.min(w, h) * 0.34, 12, Math.min(w, h) * 0.68);

  ctx.fillStyle = "#12131a";
  ctx.font = `bold ${Math.round(Math.min(w, h) * 0.045)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("MLS TEST", cx, cy + 8);

  return c;
}
