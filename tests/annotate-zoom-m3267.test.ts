/**
 * M-3267 (the user, 11-17: 「引用給 agent 沒有辦法縮放圖再開始畫」): the image annotate editor zooms and pans before (and
 * between) drawing — a wheel, ± and Fit on a desk; a two-finger pinch on a phone, while one finger still draws; a hand
 * mode (or Space held, or the middle button) pans. Every mark is kept in the picture's own pixels, so the PNG quoted
 * to the agent is the same at any zoom. Here: the mapping between the screen and the picture at several zoom and pan
 * states (image-zoom.js, pure), and the editor wired to it. What a browser draws is
 * scripts/manual/smoke/smoke-annotate-zoom-m3267.mts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let Z: any;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  Z = await import("../src/ui/image-zoom.js");
});

const PIC = { w: 1200, h: 800 };                      // the canvas: the picture's own pixels
const VIEW = { x: 12, y: 12, w: 366, h: 600 };        // a phone's stage, inside its margin
const close = (a: number[], b: number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]!) < eps);

describe("M-3267: the screen ↔ picture mapping", () => {
  const states = () => [Z.fitView(VIEW, PIC), { s: 1, tx: -300, ty: -100 }, { s: 2.5, tx: -1400, ty: -700 }, { s: 8, tx: -6000, ty: -3000 }];
  it("a stage point maps to the picture pixel under it, at any zoom and pan, and back", () => {
    for (const z of states()) {
      for (const p of [[0, 0], [600, 400], [1199, 799], [37.5, 712.25]]) {
        const at = Z.imageToStage(z, p[0], p[1]);
        expect(close(Z.stageToImage(z, at[0], at[1]), p), JSON.stringify({ z, p })).toBe(true);
      }
    }
    // Fitted: the picture's corners are the fitted box's corners.
    const f = Z.fitView(VIEW, PIC);
    expect(close(Z.stageToImage(f, f.tx, f.ty), [0, 0])).toBe(true);
    expect(close(Z.stageToImage(f, f.tx + PIC.w * f.s, f.ty + PIC.h * f.s), [PIC.w, PIC.h])).toBe(true);
  });
  it("zooming at the cursor keeps the picture pixel under the cursor where it is (a mark started there lands on it)", () => {
    // Zoomed in far enough that the picture overflows the view on both axes (a smaller axis is centred by the clamp).
    let z = Z.clampPan({ s: 1, tx: -300, ty: -100 }, VIEW, PIC);
    for (const [px, py, k] of [[100, 300, 2], [300, 150, 1.5], [200, 500, 0.8], [50, 50, 1.25]] as const) {
      const before = Z.stageToImage(z, px, py);
      const next = Z.zoomAt(z, z.s * k, px, py, VIEW, PIC);
      expect(next.s).toBeCloseTo(z.s * k, 9);
      expect(close(Z.stageToImage(next, px, py), before, 1e-6), JSON.stringify({ px, py, k })).toBe(true);
      z = next;
    }
  });
  it("a pinch scales by how far the fingers spread and follows their midpoint; it stays within fit … 8×", () => {
    const start = Z.fitView(VIEW, PIC);
    const p0 = [150, 300], p1 = [250, 300];                    // 100 px apart, midpoint (200, 300)
    const mid = Z.stageToImage(start, 200, 300);
    // 300 px apart (3×: the picture then overflows the view both ways), midpoint (220, 320).
    const z = Z.pinchView(start, p0, p1, [70, 320], [370, 320], VIEW, PIC);
    expect(z.s).toBeCloseTo(start.s * 3, 9);
    expect(close(Z.stageToImage(z, 220, 320), mid, 1e-6)).toBe(true);
    // Pinching in past fit stops at fit (the whole picture, centred); spreading past 8× stops at 8×.
    expect(Z.pinchView(start, p0, p1, [190, 300], [210, 300], VIEW, PIC)).toEqual(Z.fitView(VIEW, PIC));
    expect(Z.pinchView(start, p0, p1, [-50000, 300], [50000, 300], VIEW, PIC).s).toBe(Z.MAX_SCALE);
    // Two fingers on one spot (no distance) never divide by zero.
    expect(Number.isFinite(Z.pinchView(start, [200, 300], [200, 300], [210, 300], [230, 300], VIEW, PIC).s)).toBe(true);
  });
  it("a mark drawn at the same picture spot is the same mark at fit, zoomed in and panned", () => {
    // The same picture pixel (900, 200), reached on screen at three zoom states, maps back to the same pixel.
    for (const z of states()) {
      const [sx, sy] = Z.imageToStage(z, 900, 200);
      expect(close(Z.stageToImage(z, sx, sy), [900, 200])).toBe(true);
    }
  });
});

describe("M-3267: the editor uses it", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src/ui/shared/image-annotate.js"), "utf8");
  const css = readFileSync(join(import.meta.dirname, "..", "src/ui/shared/image-annotate.css"), "utf8");
  it("pointers map through the view (stageToImage), never the fitted box alone", () => {
    expect(src).toMatch(/import \{[^}]*\bstageToImage\b[^}]*\} from "\.\/image-zoom\.js"/);
    expect(src).toMatch(/stageToImage\(view\.current/);
    expect(src).not.toMatch(/\/ Math\.max\(1, r\.width\)\) \* c\.width/);
  });
  it("a wheel zooms at the cursor (not passive: the page never scrolls); ± and Fit; a pinch; a hand mode", () => {
    expect(src).toMatch(/addEventListener\("wheel", [^)]*\{ passive: false \}\)/);
    expect(src).toMatch(/zoomAt\(/);
    expect(src).toMatch(/pinchView\(/);
    for (const cls of ["an-zoom-in", "an-zoom-out", "an-zoom-fit", "an-hand"]) expect(src, cls).toContain(cls);
    // A second finger turns a stroke into a pinch: the stroke in progress is dropped, never kept as a mark.
    expect(src).toMatch(/pinch[\s\S]{0,200}drag\.current = null/);
  });
  it("the canvas is placed by a CSSOM transform from its top-left (no style attribute, #1300)", () => {
    expect(src).toMatch(/\.style\.transform = /);
    expect(src).not.toMatch(/style=\$\{/);
    expect(css).toMatch(/\.an-canvas \{[^}]*transform-origin: 0 0/);
  });
});
