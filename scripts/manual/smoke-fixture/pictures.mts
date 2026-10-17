/**
 * Realistic demo pictures, drawn in the browser's canvas (no image files in the repo): photo-like detail — layered
 * gradients, soft light, noise, many shapes and fine lines, a horizon, CJK and Latin type — at real sizes, so scaling,
 * cropping and compression show the way they do with a real photo (a flat colour hides them: #2038). Also a picture
 * with transparency, a tiny one and a huge one (past every cap, to see the refusal).
 */

export interface PictureSpec { w: number; h: number; hue: number; label: string; alpha?: boolean; seed?: number; mime?: "image/png" | "image/jpeg" | "image/webp" }

/** The sizes every smoke can ask for by name. */
export const PICTURES = {
  avatar: { w: 512, h: 512, hue: 205, label: "AV", mime: "image/jpeg" },
  avatarTiny: { w: 24, h: 24, hue: 20, label: "" },
  avatarTransparent: { w: 320, h: 320, hue: 140, label: "PNG", alpha: true },
  /** A transparent PNG past the 256 KiB avatar cap: what a person picking a big PNG sees refused. */
  avatarTooBig: { w: 512, h: 512, hue: 140, label: "PNG", alpha: true },
  portrait: { w: 600, h: 900, hue: 260, label: "肖像 portrait", mime: "image/jpeg" },
  bannerWide: { w: 1600, h: 600, hue: 190, label: "1600×600 橫幅", mime: "image/jpeg" },
  banner169: { w: 1600, h: 900, hue: 30, label: "1600×900" },
  bannerShort: { w: 1500, h: 500, hue: 330, label: "1500×500" },
  bannerSmall: { w: 400, h: 150, hue: 90, label: "400×150" },
  bannerTall: { w: 800, h: 1200, hue: 280, label: "800×1200 直幅" },
  huge: { w: 4000, h: 3000, hue: 10, label: "4000×3000" },
} satisfies Record<string, PictureSpec>;

/** Draw one picture in `page` (a playwright Page, any URL) and return its bytes (without `mime`: PNG up to 1 MP or with alpha, JPEG above — a noisy large PNG is over the banner cap). */
export async function drawPicture(page: { evaluate(expr: string): Promise<unknown> }, s: PictureSpec): Promise<Buffer> {
  const url = await page.evaluate(`(() => {
    const W = ${s.w}, H = ${s.h}, hue = ${s.hue}, alpha = ${!!s.alpha};
    let seed = ${s.seed ?? s.w * 31 + s.h * 17 + s.hue};
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d");
    if (!alpha) {
      const sky = g.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, "hsl(" + hue + ",70%,72%)"); sky.addColorStop(0.55, "hsl(" + (hue + 30) + ",60%,48%)"); sky.addColorStop(1, "hsl(" + (hue + 80) + ",55%,22%)");
      g.fillStyle = sky; g.fillRect(0, 0, W, H);
      const sun = g.createRadialGradient(W * 0.72, H * 0.3, 0, W * 0.72, H * 0.3, Math.max(W, H) * 0.45);
      sun.addColorStop(0, "rgba(255,240,200,0.9)"); sun.addColorStop(1, "rgba(255,240,200,0)"); g.fillStyle = sun; g.fillRect(0, 0, W, H);
    }
    // Hills: three layers of noisy horizons.
    for (let layer = 0; layer < 3; layer++) {
      g.beginPath(); g.moveTo(0, H);
      let y = H * (0.55 + layer * 0.12);
      for (let x = 0; x <= W; x += Math.max(2, W / 120)) { y += (rnd() - 0.5) * H * 0.03; g.lineTo(x, y); }
      g.lineTo(W, H); g.closePath();
      g.fillStyle = "hsla(" + (hue + 100 + layer * 20) + ",40%," + (35 - layer * 9) + "%," + (alpha ? 0.75 : 1) + ")"; g.fill();
    }
    // Shapes and fine lines: many small circles, a grid of hairlines, scattered dots (texture that compression shows).
    for (let i = 0; i < Math.min(400, (W * H) / 4000); i++) {
      g.beginPath(); g.arc(rnd() * W, rnd() * H, 2 + rnd() * Math.min(W, H) * 0.04, 0, Math.PI * 2);
      g.fillStyle = "hsla(" + Math.floor(rnd() * 360) + ",70%,60%," + (0.15 + rnd() * 0.35) + ")"; g.fill();
    }
    g.strokeStyle = "rgba(255,255,255,0.18)"; g.lineWidth = 1;
    for (let x = 0; x < W; x += Math.max(8, Math.round(W / 40))) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke(); }
    if (W * H <= 4e6) { const img = g.getImageData(0, 0, W, H); for (let i = 0; i < img.data.length; i += 4) { const n = (rnd() - 0.5) * 18; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; } g.putImageData(img, 0, 0); }
    // Corner marks and a centre target, so crops and scaling are visible.
    const m = Math.max(4, Math.round(Math.min(W, H) * 0.06));
    g.fillStyle = "#ffeb3b"; for (const [x, y] of [[0, 0], [W - m, 0], [0, H - m], [W - m, H - m]]) g.fillRect(x, y, m, m);
    g.strokeStyle = "#fff"; g.lineWidth = Math.max(1, Math.round(Math.min(W, H) / 120)); g.beginPath(); g.arc(W / 2, H / 2, Math.min(W, H) * 0.16, 0, Math.PI * 2); g.stroke();
    if (${JSON.stringify(s.label)} && Math.min(W, H) >= 48) {
      g.fillStyle = "#fff"; g.shadowColor = "rgba(0,0,0,0.6)"; g.shadowBlur = 8; g.textAlign = "center"; g.textBaseline = "middle";
      g.font = "bold " + Math.round(Math.min(W, H) * 0.12) + "px 'Noto Sans CJK TC', 'Noto Sans TC', sans-serif";
      g.fillText(${JSON.stringify(s.label)}, W / 2, H * 0.8);
    }
    return c.toDataURL(${JSON.stringify(s.mime ?? (s.alpha || s.w * s.h <= 1_000_000 ? "image/png" : "image/jpeg"))}, 0.86);
  })()`);
  return Buffer.from(String(url).split(",")[1]!, "base64");
}
