// M-3293 (#4119, the light version): play in the Office — pick a person up and drop them anywhere (they walk back to their
// seat along the usual route), and pat or feed them (a few hearts rising over the head and a speech bubble). The
// viewer's own: never stored on the host, never in a share link, never sent to an agent (no request at all), no
// tokens. Pure — fleet-office.js wires it to the pointer, the walkers and the scene.
//
// Who may play: a single zones office on the dashboard itself (not All offices, not a share link's page, not while Edit
// layout is open), with the viewer's "Drag and pat" on (per device, on by default) — and never with reduced motion.

/**
 * LONG_MS: a touch held this long without moving picks a person up (a finger that moves first pans, as before); SLOP:
 * a mouse picks up once it moves this far (CSS px) — a press that never moves is a click (their card). REACT_MS: a
 * pat's or a feed's hearts and words last this long; HEARTS of them, rising RISE units.
 */
export const PLAY = { LONG_MS: 450, SLOP: 6, REACT_MS: 1800, HEARTS: 3, RISE: 26 };
export const PLAY_KINDS = ["pat", "feed"];

/** Whether the viewer may play here: their toggle on, motion allowed, a single zones office of their own dashboard. */
export function playAllowed({ on, still, zones, overview, layout, shared }) {
  return !!on && !still && !!zones && !overview && !layout && !shared;
}

/**
 * The pick-up of one pointer: `down(id, type, x, y, t, name)` on a person (`name`; none: nothing to pick up) — a mouse
 * is "maybe" until it moves SLOP, a touch "press" until LONG_MS (`tick(t)`) or a move past SLOP first ("pan": the view's
 * own drag). Once "held", `move` carries them (`x`, `y` in the view's units; `px` the pointer's travel in CSS px decides
 * the slop). `up(id)` → { name, at } when they were held (dropped there), else null (a click, or a pan).
 */
export function createHold({ longMs = PLAY.LONG_MS, slop = PLAY.SLOP } = {}) {
  let s = null;
  return {
    down(id, type, x, y, t, name, cx = 0, cy = 0) {
      s = name ? { id, type, cx, cy, t0: t, name, state: type === "touch" ? "press" : "maybe", at: { x, y } } : null;
      return s ? s.state : null;
    },
    move(id, x, y, t, cx = 0, cy = 0) {
      if (!s || s.id !== id) return null;
      const far = Math.hypot(cx - s.cx, cy - s.cy) > slop;
      if (s.state === "maybe" && far) s.state = "held";
      else if (s.state === "press") { if (t - s.t0 >= longMs) s.state = "held"; else if (far) s.state = "pan"; }
      if (s.state === "held") s.at = { x, y };
      return s.state;
    },
    tick(t) { if (s && s.state === "press" && t - s.t0 >= longMs) s.state = "held"; return s ? s.state : null; },
    up(id) {
      if (!s || s.id !== id) return null;
      const r = s.state === "held" ? { name: s.name, at: { ...s.at } } : null;
      s = null;
      return r;
    },
    cancel() { s = null; },
    held() { return s && s.state === "held" ? { name: s.name, at: { ...s.at } } : null; },
    state() { return s ? s.state : null; },
  };
}

const WORDS = {
  en: { pat: "♪ Thanks!", feed: "Yum!" },
  "zh-TW": { pat: "♪ 謝謝！", feed: "好吃！" },
};
/** What a person says to a pat or a feed, in the page's language (English otherwise). */
export const reactWords = (kind, lang) => (WORDS[lang] || WORDS.en)[kind] || "";

/**
 * A reaction `r` ({ kind, t0 }) at `t`: its hearts — HEARTS of them over the head (dx, dy from the head, alpha), each
 * a little after the one before, rising and fading — and its words; null once it is over (or not started).
 */
export function reactionAt(r, t, lang = "en") {
  if (!r || !PLAY_KINDS.includes(r.kind)) return null;
  const f = (t - r.t0) / PLAY.REACT_MS;
  if (f < 0 || f >= 1) return null;
  const hearts = [];
  for (let i = 0; i < PLAY.HEARTS; i++) {
    const g = Math.min(1, Math.max(0, (f - i * 0.12) / (1 - (PLAY.HEARTS - 1) * 0.12)));
    if (g <= 0) continue;
    hearts.push({ dx: (i - (PLAY.HEARTS - 1) / 2) * 9, dy: -10 - g * PLAY.RISE, alpha: 1 - g });
  }
  return { f, hearts, say: reactWords(r.kind, lang) };
}

/** Reactions still showing at `t` (a Map name → { kind, t0 }), the rest dropped; whether any is left. */
export function pruneReactions(map, t) {
  for (const [n, r] of [...map]) if (t - r.t0 >= PLAY.REACT_MS || t < r.t0) map.delete(n);
  return map.size > 0;
}
