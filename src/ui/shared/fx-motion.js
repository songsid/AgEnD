// #2117 (the user's direction, hmsg-3c166c26): agents' effects play whatever the system's reduced-motion setting says,
// unless this device chose "Effects: follow the system's reduced-motion setting". One per-device switch (not synced:
// it is about this screen), shared by ambient effects and Canvas Worker effects; it also works on the public link.
export const FX_FOLLOW_REDUCED_MOTION_KEY = "agend_fx_follow_reduced_motion";
/** The one-time chat note "your system asks for reduced motion; effects are on" was shown on this device. */
export const FX_MOTION_NOTE_KEY = "agend_fx_motion_note_seen";
const listeners = new Set();
let pageChoice = null, noteShown = false;

/** Whether this device asked effects to follow the system's reduced-motion setting (default: no). */
export function followsReducedMotion() {
  if (pageChoice !== null) return pageChoice;
  try { return globalThis.localStorage.getItem(FX_FOLLOW_REDUCED_MOTION_KEY) === "1"; } catch { return false; }
}
export function setFollowsReducedMotion(on) {
  pageChoice = !!on;
  try { if (on) globalThis.localStorage.setItem(FX_FOLLOW_REDUCED_MOTION_KEY, "1"); else globalThis.localStorage.removeItem(FX_FOLLOW_REDUCED_MOTION_KEY); } catch { /* this page only */ }
  for (const fn of [...listeners]) { try { fn(); } catch { /* a listener's own */ } }
}
/** `fn()` when the switch or the system's answer moves (this tab, another tab, the OS). Returns the unsubscribe. */
export function onMotionChange(fn) {
  listeners.add(fn);
  const onStorage = (e) => {
    if (!e || e.key === FX_FOLLOW_REDUCED_MOTION_KEY || e.key === null) {
      pageChoice = e?.key === FX_FOLLOW_REDUCED_MOTION_KEY ? e.newValue === "1" : null;
      fn();
    }
  };
  let q = null;
  try { q = typeof globalThis.matchMedia === "function" ? globalThis.matchMedia("(prefers-reduced-motion: reduce)") : null; } catch { q = null; }
  try { globalThis.addEventListener && globalThis.addEventListener("storage", onStorage); } catch { /* none */ }
  try { if (q && q.addEventListener) q.addEventListener("change", fn); } catch { /* read again on the next render */ }
  return () => {
    listeners.delete(fn);
    try { globalThis.removeEventListener && globalThis.removeEventListener("storage", onStorage); } catch { /* gone */ }
    try { if (q && q.removeEventListener) q.removeEventListener("change", fn); } catch { /* gone */ }
  };
}
/** Whether the system asks for reduced motion (false when it can't say: the note is only for a clear yes). */
export function systemReducesMotion(win = globalThis) {
  try { return typeof win.matchMedia === "function" && win.matchMedia("(prefers-reduced-motion: reduce)").matches === true; } catch { return false; }
}
/**
 * The one-time note (the user's direction): the system asks for reduced motion, this device does not follow it, and the
 * note was not shown here before. Showing it marks it shown.
 */
export function motionNoteDue(win = globalThis) {
  if (noteShown || followsReducedMotion() || !systemReducesMotion(win)) return false;
  try { return globalThis.localStorage.getItem(FX_MOTION_NOTE_KEY) !== "1"; } catch { return true; }
}
export function markMotionNoteShown() {
  noteShown = true;
  try { globalThis.localStorage.setItem(FX_MOTION_NOTE_KEY, "1"); } catch { /* shown again next time: harmless */ }
}

/**
 * True when effects stay still here: this device follows the system's setting and the system asks for reduced motion
 * (or cannot say — then still, as asked for). With the switch off (the default), never.
 */
export function motionBlocked(win = globalThis) {
  if (!followsReducedMotion()) return false;
  try {
    if (typeof win.matchMedia !== "function") return true;
    const q = win.matchMedia("(prefers-reduced-motion: reduce)");
    return !q || typeof q.matches !== "boolean" || q.matches;
  } catch { return true; }
}
