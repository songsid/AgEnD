// #2540: the Office view's canvas controls — the pure part (fleet-office.js applies it). The office fills the Fleet
// panel; its scene (the zones' 1280×720 logical canvas, or the desks layout) is panned and zoomed like the org chart's
// canvas (fleet-canvas-view.js: the same view { k, x, y }, gestures, wheel and keys), with these of its own:
//
// - Pixel levels for the steps. + and − step to the next pixel level (one logical unit a whole number of device px:
//   k·dpr = 1, 2, 3, …; below one device px a unit by 1.25); the canvas always draws unsmoothed (nearest neighbour).
//   The wheel and a pinch zoom continuously, and Fit takes whatever scale fills the panel.
// - Fit: two modes, kept per office (fleet-office-store.js). "contain" (the default): the largest scale at which the
//   whole scene shows — non-integer, so the scene fills the panel's width or height. "cover" (Fill): the smallest
//   scale that fills both; what overflows is cropped and stays a pan away. Either is centred.
// - The view never loses the scene (clampPan): along an axis where the scene is larger than the panel it covers the
//   panel (no gap at an edge); where it is smaller it stays wholly inside.
//
// Around the scene is a matte: the pack's `matte` (fleet-office-pack.js), else the colour of the background's edge
// pixels (sampled once per style: edgeMatte), else the skin's own (Studio's hall floor; Desks': the dashboard's
// background). It paints the whole canvas outside the scene (and the stage behind it), never the page's grey.
import { clampK, pinchTo, zoomTo } from "./fleet-canvas-view.js";
import { CANVAS_MAX } from "./fleet-office-model.js";

/** The zoom's range, in CSS px per logical unit. */
export const OK_MIN = 0.1, OK_MAX = 8;
const EPS = 1e-6;
const clampO = (k) => clampK(k, OK_MIN, OK_MAX);
/** The highest pixel level within the range at this ratio (at least 1). */
const topLevel = (dpr) => Math.max(1, Math.floor(OK_MAX * dpr + EPS));

/** `k` on its pixel level: k·dpr rounded to a whole number when it is 1 or more; as it is (in range) below that. */
export function snapK(k, dpr = 1) {
  const c = clampO(k), n = c * dpr;
  if (n < 1 - EPS) return c;
  return Math.min(topLevel(dpr), Math.max(1, Math.round(n))) / dpr;
}
/** Whether `k` is a pixel level (a whole number of device px per logical unit). */
export const isPixelK = (k, dpr = 1) => k * dpr >= 1 - EPS && Math.abs(k * dpr - Math.round(k * dpr)) < 1e-6;
/** One step in (`dir` > 0) or out: the next pixel level; below one device pixel a unit, by 1.25. */
export function stepK(k, dir, dpr = 1) {
  const n = k * dpr;
  if (dir > 0) {
    if (n >= 1 - EPS) return Math.min(topLevel(dpr), Math.floor(n + EPS) + 1) / dpr;
    return n * 1.25 >= 1 - EPS ? 1 / dpr : clampO(k * 1.25);
  }
  if (n > 1 + EPS) return Math.max(1, Math.ceil(n - EPS) - 1) / dpr;
  return clampO(k * 0.8);
}
/** The view at scale `k` (in range, continuous: the wheel's) about the viewport point (cx, cy). */
export const zoomOffice = (v, k, cx, cy) => zoomTo(v, clampO(k), cx, cy);
/** A pinch step: `raw` the zoom the pinch has reached (continuous); the world point under the old midpoint follows. */
export const pinchOffice = (v, from, to, raw) => pinchTo(v, from, to, clampO(raw));

/** The fit modes: "contain" (the whole scene shows) and "cover" (the panel is filled, the overflow cropped). */
export const FIT_MODES = ["contain", "cover"];
export const fitModeOk = (m) => (m === "cover" ? "cover" : "contain");
/** The scale at which a `w`×`h` scene fits a `size` viewport: contain (the whole scene) or cover (the whole panel). */
export function fitK(w, h, size, mode = "contain", margin = 0) {
  const sx = (size.w - 2 * margin) / Math.max(1, w), sy = (size.h - 2 * margin) / Math.max(1, h);
  return clampO(fitModeOk(mode) === "cover" ? Math.max(sx, sy) : Math.min(sx, sy));
}
/** The scene at fitK, centred. */
export function fitScene(w, h, size, mode = "contain", margin = 0) {
  const k = fitK(w, h, size, mode, margin);
  return { k, x: (size.w - w * k) / 2, y: (size.h - h * k) / 2 };
}
/**
 * The desks layout's scale when it opens: the pixel level nearest one CSS px a unit (1 on an ordinary or a 2× screen,
 * 4/3 at 150 %, 0.8 at 125 %); the layout wraps at the panel's width over it, so it opens as wide as the panel.
 */
export const desksK = (dpr = 1) => Math.max(1, Math.round(dpr)) / dpr;
/** The view a scene opens on with nothing kept: zones fitted (the office's mode), desks from the top left at desksK. */
export const openingView = (w, h, size, dpr, zones, mode = "contain") => (zones ? fitScene(w, h, size, mode) : { k: desksK(dpr), x: 0, y: 0 });
/** One axis of clampPan: offset `o` of a scene `s` long in a viewport `n` long. */
const clampAxis = (o, s, n) => (s >= n ? Math.min(0, Math.max(n - s, o)) : Math.min(n - s, Math.max(0, o)));
/**
 * The view kept on the scene: along an axis where the scene is at least the viewport it covers the viewport (no gap at
 * either edge); where it is smaller it stays wholly inside. Nothing can be scrolled off-screen.
 */
export function clampPan(v, w, h, size) {
  return { k: v.k, x: clampAxis(v.x, w * v.k, size.w), y: clampAxis(v.y, h * v.k, size.h) };
}
/** The zoom as a person reads it: "150%". */
export const zoomLabel = (k) => `${Math.round(k * 100)}%`;
/**
 * The overview's box in a `size` stage: the scene's aspect, about a seventh of the stage's width (120–280 px, at most
 * a third of its height), `margin` px in from the bottom right corner — always inside the stage.
 */
export function miniBox(size, w, h, margin = 12) {
  const ar = Math.max(1, w) / Math.max(1, h), roomW = Math.max(0, size.w - 2 * margin), roomH = Math.max(0, size.h - 2 * margin);
  let bw = Math.min(280, Math.max(120, Math.round(size.w / 7)), roomW), bh = bw / ar;
  const maxH = Math.min(roomH, Math.max(60, size.h / 3));
  if (bh > maxH) { bh = maxH; bw = bh * ar; }
  bw = Math.floor(bw); bh = Math.floor(bh);
  return { x: size.w - margin - bw, y: size.h - margin - bh, w: bw, h: bh };
}
/** The view's frame on the overview (logical units): the part of the scene in view (never outside it). */
export function miniFrame(v, size, w, h) {
  const x0 = Math.max(0, -v.x / v.k), y0 = Math.max(0, -v.y / v.k);
  const x1 = Math.min(w, (size.w - v.x) / v.k), y1 = Math.min(h, (size.h - v.y) / v.k);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

// ── Kept per device, per office: the zoom and the logical point in the middle (the viewport's size may differ) ──

/** What is kept of a view: { k, cx, cy }, and `fit: true` when it is a fit (it is fitted again, to the size then). */
export const savedOf = (v, size, fit = false) => ({ k: v.k, cx: (size.w / 2 - v.x) / v.k, cy: (size.h / 2 - v.y) / v.k, ...(fit ? { fit: true } : {}) });
/** A kept view, checked: { k, cx, cy } with finite numbers (k in range), else null. */
export function savedOk(x) {
  if (!x || typeof x !== "object") return null;
  const { k, cx, cy } = x;
  if (![k, cx, cy].every((n) => typeof n === "number" && Number.isFinite(n)) || k <= 0) return null;
  if (Math.abs(cx) > 1e6 || Math.abs(cy) > 1e6) return null;
  return { k: clampO(k), cx, cy, ...(x.fit === true ? { fit: true } : {}) };
}
/** The view a kept one gives in a `size` viewport: the same zoom, the same logical point in the middle. */
export function viewFromSaved(s, size) {
  const k = clampO(s.k);
  return { k, x: size.w / 2 - s.cx * k, y: size.h / 2 - s.cy * k };
}

// ── Drawing ──

/** The cached layers' budget (device px): beyond it they are drawn coarser and scaled up by a whole number. */
export const LAYER_MAX = { side: CANVAS_MAX.side, area: 8 * 1024 * 1024 };
/**
 * The layers' resolution (layer px per logical unit) for a view at `a` device px a unit and a `w`×`h` scene: `a`
 * itself (the layer is blitted 1:1), or — over the budget — `a` divided by the smallest whole number that fits it,
 * so the blit is still an integer scale-up (nearest neighbour: crisp).
 */
export function layerScale(a, w, h, max = LAYER_MAX) {
  const cap = Math.min(max.side / Math.max(1, w), max.side / Math.max(1, h), Math.sqrt(max.area / Math.max(1, w * h)));
  if (a <= cap) return a;
  return a / Math.ceil(a / cap - EPS);
}
/**
 * The matte from a background's edge pixels: `strips` are RGBA pixel arrays (the top and bottom rows, the left and
 * right columns); the mean of their opaque pixels as #rrggbb, or null when none is opaque.
 */
export function edgeMatte(strips) {
  let r = 0, g = 0, b = 0, n = 0;
  for (const s of strips) {
    if (!s || typeof s.length !== "number") continue;
    for (let i = 0; i + 3 < s.length; i += 4) { if (s[i + 3] < 128) continue; r += s[i]; g += s[i + 1]; b += s[i + 2]; n++; }
  }
  if (!n) return null;
  const hx = (v) => Math.round(v / n).toString(16).padStart(2, "0");
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}
/** The edge strips of a canvas (its 2d context's pixels), for edgeMatte; null when they cannot be read. */
export function edgeStrips(c) {
  try {
    const g = c && typeof c.getContext === "function" ? c.getContext("2d") : null;
    if (!g || typeof g.getImageData !== "function" || !(c.width > 0) || !(c.height > 0)) return null;
    const w = c.width, h = c.height;
    return [g.getImageData(0, 0, w, 1).data, g.getImageData(0, h - 1, w, 1).data, g.getImageData(0, 0, 1, h).data, g.getImageData(w - 1, 0, 1, h).data];
  } catch { return null; }   // a tainted or lost canvas: the skin's matte
}
