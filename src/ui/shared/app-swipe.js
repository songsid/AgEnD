// #1605: on a phone (whenever the sidebar is a drawer), a swipe right in the main area opens the drawer and a swipe left
// on the drawer or its scrim closes it — through the same open/close as ☰, so focus, the scrim and Esc are unchanged.
//
// Never in the way of anything that owns a sideways drag or a touch:
// - the left screen edge (the first EDGE px) belongs to the browser: on iOS Safari a swipe from there is "back";
// - a gesture that starts in something that scrolls sideways (a code block, a wide table or CSV card — found as the
//   nearest horizontally scrollable ancestor, not a fixed list), in the terminal view (xterm), in the composer or any
//   input, or while a dialog, the image lightbox or the preview panel is open, is left alone;
// - vertical scrolling is never taken: only a mostly-horizontal swipe counts (dx ≥ MIN_DX and |dy| < |dx|/2), and the
//   listeners are passive — nothing is ever prevented, the browser scrolls as it always does.

export const SWIPE = { EDGE: 24, MIN_DX: 60 };

/** Elements a sideways gesture belongs to (their own scrolling, selection, typing or drag). */
function owns(el) {
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || tag === "pre" || tag === "table" || tag === "iframe") return true;
  if (el.isContentEditable || (el.getAttribute && el.getAttribute("contenteditable") === "true")) return true;
  const cl = el.classList;
  return !!cl && (cl.contains("xterm") || cl.contains("composer") || cl.contains("composer-box") || cl.contains("pv-panel")
    || cl.contains("lb") || cl.contains("csv-card") || cl.contains("codeblock"));
}
/** Scrolls sideways (and has room to): the gesture is the content's. */
function scrollsSideways(el, win) {
  if (!(el.scrollWidth > el.clientWidth + 1)) return false;
  const cs = win && typeof win.getComputedStyle === "function" ? win.getComputedStyle(el) : null;
  const ox = cs ? cs.overflowX : "";
  return ox === "auto" || ox === "scroll";
}
function blocked(target, win) {
  for (let el = target; el && el.nodeType === 1; el = el.parentNode) {
    if (owns(el) || scrollsSideways(el, win)) return true;
  }
  return false;
}
function inside(target, test) {
  for (let el = target; el && el.nodeType === 1; el = el.parentNode) if (test(el)) return true;
  return false;
}

/**
 * Install once per page. `isDrawer()`: the sidebar is a drawer now (phone width); `isOpen()`; `open()` / `close()`: the
 * same paths ☰ and the scrim use. Returns the uninstall function.
 */
export function installSwipe({ doc = document, win = window, isDrawer, isOpen, open, close }) {
  let start = null;   // { x, y, opening }
  const modalUp = () => !!(doc.querySelector && (doc.querySelector("dialog[open]") || doc.querySelector(".pv-panel")))
    || !!(doc.documentElement && doc.documentElement.classList && doc.documentElement.classList.contains("lb-open"));
  function onStart(e) {
    start = null;
    if (!e.touches || e.touches.length !== 1 || !isDrawer()) return;
    const t = e.touches[0], target = e.target;
    if (modalUp() || blocked(target, win)) return;
    if (isOpen()) {
      // Closing: a swipe left that starts on the drawer or its scrim.
      if (inside(target, (el) => el.id === "sidebar" || (el.classList && el.classList.contains("scrim")))) start = { x: t.clientX, y: t.clientY, opening: false };
      return;
    }
    // Opening: in the main area, and never from the edge the browser owns.
    if (t.clientX < SWIPE.EDGE) return;
    if (!inside(target, (el) => el.id === "main")) return;
    start = { x: t.clientX, y: t.clientY, opening: true };
  }
  function onEnd(e) {
    const s = start;
    start = null;
    if (!s || !e.changedTouches || !e.changedTouches.length || !isDrawer()) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (Math.abs(dx) < SWIPE.MIN_DX || Math.abs(dy) >= Math.abs(dx) / 2) return;   // short, or mostly vertical: a scroll
    if (s.opening && dx > 0 && !isOpen()) open();
    else if (!s.opening && dx < 0 && isOpen()) close();
  }
  function onCancel() { start = null; }
  function onMove(e) { if (start && e.touches && e.touches.length !== 1) start = null; }   // a second finger: a pinch
  const opts = { passive: true };
  doc.addEventListener("touchstart", onStart, opts);
  doc.addEventListener("touchmove", onMove, opts);
  doc.addEventListener("touchend", onEnd, opts);
  doc.addEventListener("touchcancel", onCancel, opts);
  return () => {
    doc.removeEventListener("touchstart", onStart, opts);
    doc.removeEventListener("touchmove", onMove, opts);
    doc.removeEventListener("touchend", onEnd, opts);
    doc.removeEventListener("touchcancel", onCancel, opts);
  };
}
