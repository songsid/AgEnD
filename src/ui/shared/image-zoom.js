// #2333: zoom and pan for the chat image lightbox. The math is pure (a view box, the image's natural size, a scale and
// an offset) and unit-tested; `createZoom` applies it to one <img> in one stage as a CSSOM transform — translate then
// scale from the top-left corner, so the browser never re-decodes the picture, and no style attribute is written
// (#1300: the CSSOM is not governed by the page's style-src).
//
// Gestures: wheel and ctrl/⌘+wheel (a trackpad pinch arrives as ctrl+wheel) zoom around the cursor; once the image is
// larger than the view a plain wheel scrolls it instead, so a tall sheet reads like a page. A mouse click on the image
// toggles fit ↔ 100% at that point; a drag pans. Touch: two fingers pinch (and pan), one finger pans, a double tap
// toggles fit ↔ 100%. A gesture that moved is never also a click (the lightbox closes on a click on the dark area).

/** The largest zoom: 8× the picture's own pixels. */
export const MAX_SCALE = 8;
/** One step of +/−, the keys or the toolbar. */
export const STEP = 1.25;
/** A pointer that moved less than this (CSS px) clicked or tapped; more, it dragged. */
export const SLOP = 4;
/** Two taps within this long and this close are a double tap. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 24;

/** The whole picture in the view, never enlarged. view = { x, y, w, h } (stage coordinates); img = { w, h } natural. */
export function fitScale(view, img) {
  return Math.min(1, view.w / img.w, view.h / img.h);
}
/** The picture's width across the view, never enlarged: a tall sheet then scrolls. */
export function fitWidthScale(view, img) {
  return Math.min(1, view.w / img.w);
}
/** The scales a gesture may reach: down to fit (or 100%, for a picture smaller than the view), up to MAX_SCALE. */
export function scaleLimits(view, img) {
  return { min: fitScale(view, img), max: Math.max(MAX_SCALE, fitScale(view, img)) };
}

/**
 * Keep the picture in view: an axis it does not fill is centred; an axis it overflows has no gap at either edge.
 * z = { s, tx, ty } (tx, ty: where the picture's top-left corner is, in stage coordinates). Returns a new z.
 */
export function clampPan(z, view, img) {
  const axis = (t, size, start, len) => size <= len ? start + (len - size) / 2 : Math.min(start, Math.max(start + len - size, t));
  return { s: z.s, tx: axis(z.tx, img.w * z.s, view.x, view.w), ty: axis(z.ty, img.h * z.s, view.y, view.h) };
}

/** Scale to `s` (within the limits) keeping the picture point under (px, py) where it is. */
export function zoomAt(z, s, px, py, view, img) {
  const { min, max } = scaleLimits(view, img);
  const to = Math.min(max, Math.max(min, s));
  const k = to / z.s;
  return clampPan({ s: to, tx: px - (px - z.tx) * k, ty: py - (py - z.ty) * k }, view, img);
}

/** Fit: the whole picture, centred. */
export function fitView(view, img) {
  return clampPan({ s: fitScale(view, img), tx: 0, ty: 0 }, view, img);
}
/** Fit width: the picture across the view, from its top. */
export function fitWidthView(view, img) {
  return clampPan({ s: fitWidthScale(view, img), tx: 0, ty: view.y }, view, img);
}
/** Whether the picture is larger than the view on either axis (then a plain wheel scrolls it, and a drag pans it). */
export function overflows(z, view, img) {
  return img.w * z.s > view.w + 0.5 || img.h * z.s > view.h + 0.5;
}

/** Wheel distance in CSS px (a line is 16, a page the view's height). */
function wheelPx(e, view) {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.h : 1;
  return { dx: (e.deltaX || 0) * unit, dy: (e.deltaY || 0) * unit };
}

/**
 * Drive one picture in one stage. `onChange({ scale, fit, mode })` after every change (mode: "fit" | "width" | "free").
 * Returns { reset, fit, fitWidth, actual, zoomBy, toggle, destroy }. Nothing happens until the picture has loaded.
 */
export function createZoom({ stage, img, onChange }) {
  let nat = null;            // { w, h } once loaded
  let z = { s: 1, tx: 0, ty: 0 };
  let mode = "fit";
  const pointers = new Map(); // pointerId → { x, y }
  let gesture = null;        // { kind: "drag" | "pinch", ... }
  let moved = false;         // the gesture now ending moved: its click is not a click
  let lastTap = null;        // { t, x, y } of the last touch tap
  let lastType = "mouse";    // the pointer type of the last press: a touch tap's click never toggles (double tap does);
                             // a mouse or a pen click does, and neither runs the double-tap logic

  const view = () => {
    const r = stage.getBoundingClientRect();
    const cs = typeof getComputedStyle === "function" ? getComputedStyle(stage) : null;
    const px = (k) => (cs ? parseFloat(cs[k]) || 0 : 0);
    const x = px("paddingLeft"), y = px("paddingTop");
    return { x, y, w: Math.max(1, r.width - x - px("paddingRight")), h: Math.max(1, r.height - y - px("paddingBottom")) };
  };
  const at = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const apply = () => {
    img.style.transform = `translate(${z.tx}px, ${z.ty}px) scale(${z.s})`;
    stage.classList.toggle("lb-zoomed", !!nat && overflows(z, view(), nat));
    if (onChange) onChange({ scale: z.s, fit: nat ? fitScale(view(), nat) : 1, mode });
  };
  const set = (next, m = "free") => { if (!nat) return; z = next; mode = m; apply(); };

  const api = {
    /** A new picture (or the first): read its size and fit it. */
    reset() {
      nat = img.naturalWidth > 0 && img.naturalHeight > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null;
      img.classList.toggle("lb-ready", !!nat);
      img.classList.remove("lb-err");
      if (nat) set(fitView(view(), nat), "fit");
    },
    fit() { if (nat) set(fitView(view(), nat), "fit"); },
    fitWidth() { if (nat) set(fitWidthView(view(), nat), "width"); },
    /** 100% at a point (default: the middle of the view). */
    actual(px, py) {
      if (!nat) return;
      const v = view();
      set(zoomAt(z, 1, px ?? v.x + v.w / 2, py ?? v.y + v.h / 2, v, nat));
    },
    zoomBy(factor, px, py) {
      if (!nat) return;
      const v = view();
      set(zoomAt(z, z.s * factor, px ?? v.x + v.w / 2, py ?? v.y + v.h / 2, v, nat));
    },
    /** Fit ↔ 100%: anything but fit goes back to fit. */
    toggle(px, py) {
      if (!nat) return;
      if (mode === "fit" && Math.abs(z.s - 1) > 1e-6) api.actual(px, py); else api.fit();
    },
    destroy() {
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("pointerdown", onDown);
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerup", onUp);
      stage.removeEventListener("pointercancel", onUp);
      stage.removeEventListener("click", onClick, true);
      img.removeEventListener("load", api.reset);
      img.removeEventListener("error", onError);
      if (typeof window !== "undefined") window.removeEventListener("resize", onResize);
    },
  };

  function onWheel(e) {
    if (!nat) return;
    e.preventDefault();
    const v = view();
    const { dx, dy } = wheelPx(e, v);
    if (e.ctrlKey || e.metaKey || !overflows(z, v, nat)) {
      const p = at(e);
      // A pinch on a trackpad sends small ctrl+wheel steps; a wheel notch is ~100 px.
      set(zoomAt(z, z.s * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), p.x, p.y, v, nat));
    } else {
      // Shift+wheel on a mouse scrolls sideways.
      const sx = e.shiftKey && !dx ? dy : dx, sy = e.shiftKey && !dx ? 0 : dy;
      set(clampPan({ s: z.s, tx: z.tx - sx, ty: z.ty - sy }, v, nat), mode === "width" ? "width" : "free");
    }
  }
  function onDown(e) {
    if (!nat || (e.pointerType === "mouse" && e.button !== 0)) return;
    lastType = e.pointerType || "mouse";
    pointers.set(e.pointerId, at(e));
    // No pointer capture yet: it would retarget the click to the stage, and a click on the picture is not one on the
    // dark area. Captured only once the pointer moves (capture()).
    if (pointers.size === 1) { moved = false; gesture = { kind: "drag", from: at(e), z0: z }; }
    else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { kind: "pinch", d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, z0: z };
      moved = true;           // two fingers: never a tap
      for (const id of pointers.keys()) capture(id);
    }
  }
  function onMove(e) {
    if (!gesture || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, at(e));
    const v = view();
    if (gesture.kind === "pinch" && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const { z0, m0, d0 } = gesture;
      const s = z0.s * (Math.hypot(b.x - a.x, b.y - a.y) / d0);
      // The picture point under the fingers' first midpoint follows the midpoint (zoom and pan in one).
      const zoomed = zoomAt(z0, s, m0.x, m0.y, v, nat);
      set(clampPan({ s: zoomed.s, tx: zoomed.tx + (m.x - m0.x), ty: zoomed.ty + (m.y - m0.y) }, v, nat));
    } else if (gesture.kind === "drag") {
      const p = pointers.get(e.pointerId);
      const dx = p.x - gesture.from.x, dy = p.y - gesture.from.y;
      if (!moved && Math.hypot(dx, dy) < SLOP) return;
      if (!moved) capture(e.pointerId);
      moved = true;
      if (overflows(gesture.z0, v, nat)) set(clampPan({ s: gesture.z0.s, tx: gesture.z0.tx + dx, ty: gesture.z0.ty + dy }, v, nat), mode === "width" ? "width" : "free");
    }
  }
  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (pointers.size === 1 && gesture && gesture.kind === "pinch") {
      // One finger left after a pinch: it pans on from here.
      const [rest] = [...pointers.values()];
      gesture = { kind: "drag", from: rest, z0: z };
      return;
    }
    if (pointers.size > 0) return;
    const tapped = !moved && gesture && gesture.kind === "drag";
    gesture = null;
    // Only a finger double-taps: a mouse or a pen clicks (onClick toggles), so a pen tap must not also count here.
    if (!tapped || e.pointerType !== "touch") return;
    // A touch tap: a second one soon and near is a double tap — fit ↔ 100% there.
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < DOUBLE_TAP_PX) {
      lastTap = null;
      moved = true;           // its click neither closes nor toggles again
      api.toggle(p.x, p.y);
    } else lastTap = { t: now, x: p.x, y: p.y };
  }
  /** A drag or pinch keeps its pointers even off the stage. */
  function capture(id) {
    if (stage.setPointerCapture) { try { stage.setPointerCapture(id); } catch { /* already gone */ } }
  }
  // Capture phase: before the lightbox's own click (which closes on the dark area) can see it. A click that ended a
  // drag or a double tap is swallowed; a mouse click on the picture toggles fit ↔ 100% there. A touch tap's click on
  // the picture does nothing (a single tap waits for a double tap); on the dark area it still closes.
  function onClick(e) {
    if (moved) { moved = false; e.stopPropagation(); e.preventDefault(); return; }
    if (e.target === img && nat && lastType !== "touch") {
      const p = at(e);
      e.stopPropagation();
      api.toggle(p.x, p.y);
    }
  }
  // A picture that does not load is shown as the browser shows a broken one, where the old lightbox put it.
  const onError = () => { nat = null; img.classList.add("lb-err"); img.classList.remove("lb-ready"); if (onChange) onChange(null); };
  const onResize = () => { if (!nat) return; if (mode === "fit") api.fit(); else if (mode === "width") api.fitWidth(); else set(clampPan(z, view(), nat)); };

  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);
  stage.addEventListener("click", onClick, true);
  img.addEventListener("load", api.reset);
  img.addEventListener("error", onError);
  if (typeof window !== "undefined") window.addEventListener("resize", onResize);
  if (img.complete) api.reset();
  return api;
}
