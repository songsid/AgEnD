// The Fleet canvases' shared view (#1918's org chart canvas, fleet-canvas.js; #2540's Office, fleet-office.js): the pure
// pan and zoom math and the pointer gestures, so both feel the same. A view is { k, x, y }: a world point (wx, wy) is
// drawn at (x + wx·k, y + wy·k) in the viewport's CSS px.
//
// - One pointer pans once it has moved a few px (so a tap still opens what it is on); two pinch: the world point under
//   their old midpoint goes to the new one, scaled by how their span changed (a two-finger move pans too). The pointer
//   is captured only once it drags: a capture at once would send the tap's click to the viewport, not what was tapped.
//   The click that ends a drag or a pinch opens nothing.
// - The wheel zooms about the pointer; + / − / 0 zoom in, out and fit (with no Alt, Ctrl or Meta held).

export const K_MIN = 0.2, K_MAX = 2.5;
/** `k` kept in [lo, hi] (the org canvas's range by default). */
export const clampK = (k, lo = K_MIN, hi = K_MAX) => Math.min(hi, Math.max(lo, k));

/**
 * The view that shows region `r` in a `size` viewport: as large as fits (at most `maxK`), centred across, from the top.
 * `minK`: never smaller than this (a phone's opening); a region that is then wider than the viewport starts at its left.
 * `widthOnly`: fit the width, let the height run on (the opening: the rest is below).
 */
export function fitView(r, size, { margin = 24, minK = K_MIN, maxK = 1.25, widthOnly = false } = {}) {
  const across = (size.w - 2 * margin) / r.w, down = widthOnly ? Infinity : (size.h - 2 * margin) / r.h;
  const k = clampK(Math.max(minK, Math.min(across, down, maxK)));
  const x = r.w * k > size.w - 2 * margin ? margin - r.x * k : size.w / 2 - (r.x + r.w / 2) * k;
  return { k, x, y: margin - r.y * k };
}
/** The view at scale `k` with the viewport point (cx, cy) on the same world point as in `v`. */
export function zoomTo(v, k, cx, cy) {
  return { k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) };
}
/** Zoom by `f` about the viewport point (cx, cy): the canvas point under it stays under it. */
export function zoomAt(v, f, cx, cy) { return zoomTo(v, clampK(v.k * f), cx, cy); }
/** A pinch step at scale `k`: the world point under the old midpoint goes to the new midpoint. */
export function pinchTo(v, from, to, k) {
  const wx = (from.mid.x - v.x) / v.k, wy = (from.mid.y - v.y) / v.k;
  return { k, x: to.mid.x - wx * k, y: to.mid.y - wy * k };
}
/** A pinch step: the canvas point under the old midpoint goes to the new midpoint, the zoom scaled by the spans' ratio. */
export function pinchView(v, from, to) { return pinchTo(v, from, to, clampK(v.k * (to.dist / from.dist))); }
/** Viewport CSS px → world units, and back. */
export const toWorld = (v, sx, sy) => ({ x: (sx - v.x) / v.k, y: (sy - v.y) / v.k });
export const toScreen = (v, wx, wy) => ({ x: v.x + wx * v.k, y: v.y + wy * v.k });
/** The view at the same scale with world point (wx, wy) in the middle of a `size` viewport. */
export const centreOn = (v, size, wx, wy) => ({ k: v.k, x: size.w / 2 - wx * v.k, y: size.h / 2 - wy * v.k });
/**
 * The world point a click on an overview at `rect` (its client box) shows, for an overview of world box `box` drawn
 * whole and centred in it (an SVG viewBox's xMidYMid meet); null when it has no size.
 */
export function miniPoint(rect, box, clientX, clientY) {
  if (!rect || !rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / box.w, rect.height / box.h);
  return { x: box.x + (clientX - rect.left - (rect.width - box.w * scale) / 2) / scale, y: box.y + (clientY - rect.top - (rect.height - box.h * scale) / 2) / scale };
}
/** The wheel's zoom factor (a notch is about 15%; a trackpad's small deltas zoom a little). */
export const wheelFactor = (e) => Math.exp(-e.deltaY * 0.0015);
/** What a key does to the view: "in", "out", "fit" (0), or null (any other key, or with Alt, Ctrl or Meta). */
export function zoomKey(e) {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.key === "+" || e.key === "=") return "in";
  if (e.key === "-" || e.key === "_") return "out";
  if (e.key === "0") return "fit";
  return null;
}

// ── The pointer gestures: the state lives in the caller's ref (it outlives a render), the handlers are made per render ──

export const SLOP = 5;
/** A fresh gesture state: the pointers down, how far the one has moved, the pinch's last span, whether to swallow the click. */
export const gestureState = () => ({ pts: new Map(), moved: 0, span: null, swallow: false });
/**
 * The handlers for state `d`: `el()` the element measured and captured; `pan(dx, dy)` and `pinch(from, to)` move the
 * view. `move` returns whether it was a drag or a pinch (not a hover). `busy()`: a drag or pinch is under way.
 */
export function gestures(d, { el, pan, pinch }) {
  const spanOf = () => {
    const [a, b] = [...d.pts.values()], r = el().getBoundingClientRect();
    return { mid: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  return {
    down(e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      d.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (d.pts.size === 1) { d.moved = 0; d.swallow = false; d.span = null; }
      else if (d.pts.size === 2) { d.swallow = true; d.span = spanOf(); }
    },
    move(e) {
      const prev = d.pts.get(e.pointerId);
      if (!prev) return false;
      d.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (d.pts.size === 1) {
        d.moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
        if (d.moved < SLOP) return false;
        if (!d.swallow) { d.swallow = true; try { el().setPointerCapture(e.pointerId); } catch { /* gone already */ } }
        pan(e.clientX - prev.x, e.clientY - prev.y);
        return true;
      }
      if (d.pts.size !== 2) return true;
      d.swallow = true;
      const next = spanOf();
      if (d.span && d.span.dist > 0 && next.dist > 0) pinch(d.span, next);
      d.span = next;
      return true;
    },
    up(e) {
      d.pts.delete(e.pointerId);
      // Back to one finger: it pans on at once (the pinch already swallows the click); two again: a new span.
      d.span = d.pts.size === 2 ? spanOf() : null;
      if (d.pts.size === 1) d.moved = SLOP;
      // The click that ends a drag comes after this: let it be swallowed, then forget.
      if (d.swallow && !d.pts.size) setTimeout(() => { if (!d.pts.size) d.swallow = false; }, 0);
    },
    clickCapture(e) { if (d.swallow) { e.preventDefault(); e.stopPropagation(); } },
    busy: () => d.swallow && d.pts.size > 0,
  };
}
