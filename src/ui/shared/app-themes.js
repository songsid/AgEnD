// #1629 (first design §5, r2 (b)(d)): agents' web themes on the page. Each applies to THAT agent's own chat surface
// (and its avatar ring) only — never the shell, the sidebar chrome or another instance. What the host sends is
// canonical already; this checks it again (a value that fails is dropped, never passed on) and applies it through the
// CSSOM (custom properties) and fixed class tokens. No style attribute, no CSS text, no url() built in CSS.
// Not shown: with "Show agents' themes and effects" off (fx.show, synced), and in safe mode (?safe=1).
import { appStore, createStore } from "./app-store.js";
import { hostPref, onPrefsChanged } from "./app-prefs.js";
import { safeMode } from "./owner-css.js";

/** { rev, themes: { <name>: theme }, locked: [<name>] } as GET /ui/themes said (rev -1: not read yet). */
export const themesStore = createStore({ rev: -1, themes: {}, locked: [], shown: true });
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

const COLOR = /^#[0-9a-f]{6}$/;
const ASSET = /^[0-9a-f]{32}$/;
const PALETTE = { bg: "--bg", surface: "--surface", text: "--text", text2: "--text-2", accent: "--accent", userBubble: "--user-bubble", agentBubble: "--agent-bubble" };
const FONTS = ["inter", "system", "mono"], BORDERS = ["none", "thin", "accent"], FITS = ["cover", "contain"];

/** Whether this page shows agents' themes now: the viewer's switch (default on), and never in safe mode. */
export function themesShown() {
  if (safeMode()) return false;
  try { return hostPref("fx.show") !== false; } catch { return true; }
}

/** The mode the page is drawn in: the chosen one, or the system's for "system". */
export function resolvedMode() {
  const T = globalThis.AgendTheme;
  const chosen = T && typeof T.get === "function" ? T.get() : "system";
  if (chosen === "light" || chosen === "dark") return chosen;
  try { return globalThis.matchMedia && globalThis.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"; } catch { return "dark"; }
}

/** The theme to draw for `name`, re-checked; null when none (or not shown). */
export function themeFor(name) {
  const s = themesStore.get();
  if (!s.shown || !own(s.themes, name)) return null;
  const t = s.themes[name];
  if (!t || typeof t !== "object") return null;
  const out = {};
  const palette = (p) => { const o = {}; if (p && typeof p === "object") for (const k of Object.keys(PALETTE)) if (typeof p[k] === "string" && COLOR.test(p[k])) o[k] = p[k]; return o; };
  if (t.colors && typeof t.colors === "object") out.colors = { light: palette(t.colors.light), dark: palette(t.colors.dark) };
  if (typeof t.accent === "string" && COLOR.test(t.accent)) out.accent = t.accent;
  if (t.bubble && typeof t.bubble === "object") {
    out.bubble = {};
    if (Number.isInteger(t.bubble.radius) && t.bubble.radius >= 0 && t.bubble.radius <= 24) out.bubble.radius = t.bubble.radius;
    if (BORDERS.includes(t.bubble.border)) out.bubble.border = t.bubble.border;
  }
  if (FONTS.includes(t.font)) out.font = t.font;
  const bg = t.background;
  if (bg && typeof bg.image === "string" && ASSET.test(bg.image) && FITS.includes(bg.fit) && typeof bg.opacity === "number" && bg.opacity >= 0.05 && bg.opacity <= 1) {
    out.background = { image: bg.image, fit: bg.fit, opacity: bg.opacity };
  }
  if (typeof t.workingLabel === "string" && t.workingLabel.length >= 1 && t.workingLabel.length <= 120) out.workingLabel = t.workingLabel;
  return out;
}

export function isThemeLocked(name) { return (themesStore.get().locked || []).includes(name); }

const TOKENS = ["th", "th-font-inter", "th-font-system", "th-font-mono", "th-bubble-none", "th-bubble-thin", "th-bubble-accent", "th-agent-bubble"];
/**
 * Draw `theme` (from themeFor) on one agent's chat root `el` for `mode`; null clears it. Colours are custom properties
 * set through the CSSOM; choices are class tokens from the fixed list above.
 */
export function applyTheme(el, theme, mode) {
  if (!el || !el.style) return;
  for (const prop of [...Object.values(PALETTE), "--bubble-radius"]) el.style.removeProperty(prop);
  for (const c of TOKENS) el.classList.remove(c);
  if (!theme) return;
  const pal = { ...(theme.accent ? { accent: theme.accent } : {}), ...((theme.colors && theme.colors[mode]) || {}) };
  for (const [k, prop] of Object.entries(PALETTE)) if (typeof pal[k] === "string" && COLOR.test(pal[k])) el.style.setProperty(prop, pal[k]);
  el.classList.add("th");
  if (theme.font) el.classList.add(`th-font-${theme.font}`);
  if (theme.bubble && theme.bubble.border) el.classList.add(`th-bubble-${theme.bubble.border}`);
  if (theme.bubble && Number.isInteger(theme.bubble.radius)) el.style.setProperty("--bubble-radius", `${theme.bubble.radius}px`);
  if (typeof pal.agentBubble === "string") el.classList.add("th-agent-bubble");
}

/** The theme picture's same-origin URL (the id is its content hash). */
export function themeImageUrl(name, id) { return `/ui/img/theme/${encodeURIComponent(name)}/${id}`; }

let reading = false, wanted = -1, started = false;
async function read(rev) {
  wanted = rev;
  if (reading) return;
  reading = true;
  try {
    while (themesStore.get().rev !== wanted) {
      const want = wanted;
      let body = null;
      try { const r = await fetch("/ui/themes", { credentials: "same-origin" }); body = r.ok ? await r.json() : null; } catch { body = null; }
      if (!body || typeof body !== "object") break;
      themesStore.set({ rev: typeof body.rev === "number" ? body.rev : want, themes: body.themes && typeof body.themes === "object" ? body.themes : {},
        locked: Array.isArray(body.locked) ? body.locked.filter((n) => typeof n === "string") : [] });
      if (want === wanted) break;
    }
  } finally { reading = false; }
}

/** Once per page load (the full app): read the themes when the status frame's themes_rev moves; follow fx.show. */
export function startThemes() {
  if (started) return;
  started = true;
  themesStore.set({ shown: themesShown() });
  let last = null;
  appStore.subscribe((s) => {
    const rev = typeof s.themesRev === "number" ? s.themesRev : null;
    if (rev === null || rev === last) return;
    last = rev;
    read(rev);
  });
  onPrefsChanged((changed) => { if (changed.has("fx.show")) themesStore.set({ shown: themesShown() }); });
}
