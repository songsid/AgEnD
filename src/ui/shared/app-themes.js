// #1629 (first design §5, r2 (b)(d)): agents' web themes on the page. Each applies to THAT agent's own chat surface
// (and its avatar ring) only — never the shell, the sidebar chrome or another instance. What the host sends is
// canonical already; this checks it again (a value that fails is dropped, never passed on) and applies it through the
// CSSOM (custom properties) and fixed class tokens. No style attribute, no CSS text, no url() built in CSS.
// Not shown: with "Show agents' themes, effects and widgets" off (fx.show, synced), and in safe mode (?safe=1).
import { appStore, createStore } from "./app-store.js";
import { onPrefsChanged, prefInForce, savePref } from "./app-prefs.js";
import { safeMode } from "./owner-css.js";
import { t } from "./app-i18n.js";
import { toast } from "./ui-toast.js";
import { confirmDialog } from "./ui-confirm.js";

/**
 * { rev, themes: { <name>: theme }, locked: [<name>], widgets: { <name>: { <slot>: widget } }, ambient: { <name>: { loop?, click? } } }
 * as GET /ui/themes said (rev -1: not read yet).
 */
export const themesStore = createStore({ rev: -1, themes: {}, locked: [], widgets: {}, ambient: {}, shown: true });
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

const COLOR = /^#[0-9a-f]{6}$/;
const ASSET = /^[0-9a-f]{32}$/;
const PALETTE = { bg: "--bg", surface: "--surface", text: "--text", text2: "--text-2", accent: "--accent", userBubble: "--user-bubble", agentBubble: "--agent-bubble" };
const FONTS = ["inter", "system", "mono"], BORDERS = ["none", "thin", "accent"], FITS = ["cover", "contain"];
// The label's rule, as the host's (web-theme.ts canonicalText): 1..24 graphemes on one line, no control, format or
// separator character but the zero-width joiner, and at least one character that draws something (#1888 review).
const FORBIDDEN = /(?!\u200d)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const VISIBLE = /[^\p{M}\p{C}\p{Z}\u115f\u1160\u3164\uffa0\u2800]/u;
let graphemes = null;
function labelOk(s) {
  if (typeof s !== "string" || FORBIDDEN.test(s) || s.trim() !== s || !VISIBLE.test(s)) return false;
  try { graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" }); } catch { return false; }
  const n = [...graphemes.segment(s)].length;
  return n >= 1 && n <= 24;
}

// Public/guest sessions cannot write host prefs. Keep their explicit browser switch apart from boot-cached defaults.
// Keep the existing public key for compatibility; both read-only viewer surfaces share this device choice.
const PUBLIC_FX_SHOW = "agend_public_fx_show";
let publicFxChoice = (() => { try { const v = localStorage.getItem(PUBLIC_FX_SHOW); return v === "on" ? true : v === "off" ? false : null; } catch { return null; } })();

/** Whether this page shows agents' themes now: the viewer's switch (default on), and never in safe mode. */
export function themesShown() {
  if (safeMode()) return false;
  if (localAppearanceViewer() && publicFxChoice !== null) return publicFxChoice;
  try {
    const f = prefInForce("fx.show");                       // this page's choice, else the host's, else the default
    if (f) return f.value !== false;
    return localStorage.getItem("agend_fx_show") !== "off";  // not known here (the public link): this browser's copy
  } catch { return true; }
}
/** The viewer's switch (Settings → Appearance): kept with the person's preferences, and in force on this page at once. */
export function setThemesShown(on) {
  if (localAppearanceViewer()) {
    publicFxChoice = !!on;
    try { localStorage.setItem(PUBLIC_FX_SHOW, on ? "on" : "off"); } catch { /* the in-memory choice still applies */ }
  } else savePref("fx.show", on ? null : false);
  themesStore.set({ shown: themesShown() });
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
  if (!s.shown || !themesShown() || !own(s.themes, name)) return null;
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
  if (labelOk(t.workingLabel)) out.workingLabel = t.workingLabel;
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
        locked: Array.isArray(body.locked) ? body.locked.filter((n) => typeof n === "string") : [],
        widgets: body.widgets && typeof body.widgets === "object" && !Array.isArray(body.widgets) ? body.widgets : {},
        ambient: body.ambient && typeof body.ambient === "object" && !Array.isArray(body.ambient) ? body.ambient : {} });
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

const publicLink = () => typeof document !== "undefined" && !!document.body && document.body.dataset.publicLink === "1";
const localAppearanceViewer = () => publicLink() || typeof document !== "undefined" && document.body?.dataset.tier === "guest";

/** A person's Reset or Lock of an agent's theme (an admin session; never over the public link). */
async function themeAction(name, what, body) {
  let r;
  try {
    const res = await fetch(`/ui/themes/${encodeURIComponent(name)}/${what}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    r = await res.json().catch(() => ({}));
    if (!res.ok) r = { error: r && r.error ? r.error : `HTTP ${res.status}` };
  } catch (err) { r = { error: err && err.message ? err.message : "network" }; }
  if (r && r.error) toast(t("chat.themeFailed", r.error), false);
  else toast(t(what === "reset" ? "chat.themeResetDone" : body && body.locked ? "chat.themeLocked" : "chat.themeUnlocked", name));
}

/** A person's removal of an agent's widget from one slot (r4-4). */
async function removeWidget(name, slot) {
  let r;
  try {
    const res = await fetch(`/ui/themes/${encodeURIComponent(name)}/widget`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slot }) });
    r = await res.json().catch(() => ({}));
    if (!res.ok) r = { error: r && r.error ? r.error : `HTTP ${res.status}` };
  } catch (err) { r = { error: err && err.message ? err.message : "network" }; }
  if (r && r.error) toast(t("chat.themeFailed", r.error), false);
  else toast(t("chat.widgetRemoved", name));
}

/** #2117: a person's Clear of an agent's ambient, one kind ("loop" or "click"). */
export async function clearAmbient(name, which) {
  let r;
  try {
    const res = await fetch(`/ui/themes/${encodeURIComponent(name)}/ambient`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ which }) });
    r = await res.json().catch(() => ({}));
    if (!res.ok) r = { error: r && r.error ? r.error : `HTTP ${res.status}` };
  } catch (err) { r = { error: err && err.message ? err.message : "network" }; }
  if (r && r.error) toast(t("chat.themeFailed", r.error), false);
  else toast(t("chat.ambientCleared", name));
}

/** The chat's and Details' ⋯ entries for an agent's theme: Lock/Unlock, Reset… and its widgets' Remove — none over the public link. */
export function themeMenuItems(name) {
  if (publicLink()) return [];
  const locked = isThemeLocked(name);
  const w = themesStore.get().widgets;
  const placed = w && own(w, name) && w[name] && typeof w[name] === "object" ? w[name] : {};
  return [
    ...["chat_header", "details"].filter((slot) => own(placed, slot)).map((slot) => ({
      key: `widget-remove-${slot}`, label: t(slot === "chat_header" ? "chat.widgetRemoveHeader" : "chat.widgetRemoveDetails"), icon: "trash",
      onSelect: () => removeWidget(name, slot),
    })),
    { key: "theme-lock", label: t(locked ? "chat.themeUnlock" : "chat.themeLock"), icon: "key", onSelect: () => themeAction(name, "lock", { locked: !locked }) },
    { key: "theme-reset", label: t("chat.themeReset"), icon: "restart", onSelect: async () => {
      if (await confirmDialog({ message: t("chat.themeResetConfirm", name), confirmLabel: t("chat.themeResetGo"), danger: true })) themeAction(name, "reset");
    } },
  ];
}
