// #4010: the Office view's carousel (signage) — chosen offices, one full-size office in turn, for a TV.
// Pure helpers; fleet-office.js draws it. The switcher's id is none a stored office can have (CAROUSEL_ID: '*' is
// not an office id's character). The offices and the interval are kept per browser; playing is not (it starts on
// enter and on reload). Pause / next / previous come from the keyboard or a remote (Space, arrows, N / P, media
// keys) and from on-screen Pause / Next. A focused field, button or link keeps those keys.

/** The switcher's "Carousel…" value: '*' is never in a stored office's id (fleet-office-model.js officeOk). */
export const CAROUSEL_ID = "*carousel";
/** Seconds: shortest, longest, and the opening pick. */
export const INTERVAL_MIN = 15, INTERVAL_MAX = 600, INTERVAL_DEFAULT = 30;
/** The interval menu: 15s, 30s, 1 min, 2 min, 5 min, 10 min. */
export const INTERVALS = [15, 30, 60, 120, 300, 600];
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const IDS_MAX = 20;

/** Whether Carousel is offered: at least two stored offices (the same bar as All offices). */
export const carouselOk = (stored) => Array.isArray(stored) && stored.length >= 2;

/** Clamp a seconds value into [INTERVAL_MIN, INTERVAL_MAX]; missing or junk is INTERVAL_DEFAULT. */
export function intervalOk(n) {
  if (n == null || n === "") return INTERVAL_DEFAULT;
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return INTERVAL_DEFAULT;
  return Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, v));
}

/**
 * The offices in the carousel, in stored order. `ids` null / omitted: every stored office (nothing saved yet).
 * An array (empty included): those ids that still exist, unique, stored order kept. Gone ids are dropped.
 */
export function carouselIdsOk(ids, stored) {
  if (!Array.isArray(stored) || !stored.length) return [];
  if (!Array.isArray(ids)) return stored.map((o) => o.id);
  const want = new Set();
  for (const id of ids) if (typeof id === "string" && ID.test(id)) want.add(id);
  return stored.map((o) => o.id).filter((id) => want.has(id));
}

/**
 * What this browser kept: `{ ids, interval }`. Ids are unique, the office-id shape, at most IDS_MAX; they are not
 * checked against the host's list here (the page filters with carouselIdsOk). A missing or odd value is empty ids
 * and INTERVAL_DEFAULT.
 */
export function carouselSavedOk(v) {
  const ids = [], seen = new Set();
  if (v && Array.isArray(v.ids)) {
    for (const id of v.ids) {
      if (typeof id !== "string" || !ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= IDS_MAX) break;
    }
  }
  return { ids, interval: intervalOk(v && v.interval) };
}

/** Wrap to the next index in `n` slides (`n` < 1: 0). */
export function nextIndex(i, n) {
  const len = Math.max(0, n | 0);
  if (!len) return 0;
  return (((i | 0) % len) + len + 1) % len;
}

/** Wrap to the previous index in `n` slides (`n` < 1: 0). */
export function prevIndex(i, n) {
  const len = Math.max(0, n | 0);
  if (!len) return 0;
  return (((i | 0) % len) + len - 1) % len;
}

/**
 * A key from a keyboard or a remote: "pause" | "next" | "prev" | null. Space pauses; → / n / MediaTrackNext step
 * forward; ← / p / MediaTrackPrevious back. Repeats and modified keys are ignored (a held arrow must not skip a
 * run of offices).
 */
export function carouselKey(e) {
  if (!e || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return null;
  const k = e.key;
  if (k === " " || k === "Spacebar" || k === "MediaPlayPause") return "pause";
  if (k === "ArrowRight" || k === "n" || k === "N" || k === "MediaTrackNext") return "next";
  if (k === "ArrowLeft" || k === "p" || k === "P" || k === "MediaTrackPrevious") return "prev";
  return null;
}

const HELD = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A", "OPTION"]);
/**
 * True when the key should stay with the focused control (a field, button, or link) instead of the carousel. A TV
 * remote with nothing focused still reaches the document handler.
 */
export function carouselHeld(el) {
  if (!el) return false;
  if (HELD.has(el.tagName) || el.isContentEditable === true) return true;
  if (typeof el.closest !== "function") return false;
  return !!el.closest("button, a, select, input, textarea, option, [contenteditable=true], [contenteditable='']");
}
