// #1629 (first design §5, r2 (b)(d)): agents' web themes on the page. Each applies to THAT agent's own chat surface
// (and its avatar ring) — and, #2196, when the agent (theme.page.on) or a person (theme.pageByInstance) says so, its
// colours on the whole page while that agent's Chat, View, Log or Details is open: colour tokens only, on the shell
// (applyPageTheme); AgEnD's status colours, fonts, pictures and layout stay the page's own. What the host sends is
// canonical already; this checks it again (a value that fails is dropped, never passed on) and applies it through the
// CSSOM (custom properties) and fixed class tokens. No style attribute, no CSS text, no url() built in CSS.
// Not shown: with "Show agents' themes, effects and widgets" off (fx.show, synced), and in safe mode (?safe=1).
import { appStore, createStore } from "./app-store.js";
import { navStore } from "./app-nav.js";
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
  if (t.page && typeof t.page === "object") {
    const sb = {};
    if (t.page.sidebar && typeof t.page.sidebar === "object") for (const m of ["light", "dark"]) if (typeof t.page.sidebar[m] === "string" && COLOR.test(t.page.sidebar[m])) sb[m] = t.page.sidebar[m];
    out.page = { on: t.page.on === true, sidebar: sb };
  }
  return out;
}

// ── #2196: an agent's colours on the whole page ──

/** The token defaults (tokens.css; web-theme.ts THEME_DEFAULTS, pinned by a test) a theme's palette goes over. */
const PAGE_DEFAULTS = {
  dark: { bg: "#212121", surface: "#2f2f2f", text: "#ececec", text2: "#b4b4b4", accent: "#7ab7ff" },
  light: { bg: "#ffffff", surface: "#f4f4f4", text: "#0d0d0d", text2: "#5d5d5d", accent: "#0a62c2" },
};
/** AgEnD's status colours (tokens.css; web-theme.ts STATUS_COLORS, pinned by a test): never themed, always readable. */
export const STATUS_COLORS = {
  dark: { ok: "#4cc38a", warn: "#e3b341", danger: "#ff8a80", dangerFill: "#c9372c", focus: "#7ab7ff" },
  light: { ok: "#1a7f37", warn: "#8a5a00", danger: "#c4222b", dangerFill: "#c4222b", focus: "#0a62c2" },
};
const PAGE_PROPS = { bg: "--bg", sidebar: "--bg-sidebar", surface: "--surface", text: "--text", text2: "--text-2", accent: "--accent" };
const DERIVED_PROPS = ["--text-3", "--surface-2", "--border", "--border-strong", "--accent-dim", "--on-accent"];
function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a, b, f) => `#${[1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - f) + parseInt(b.slice(i, i + 2), 16) * f).toString(16).padStart(2, "0")).join("")}`;

/** The instance a page is about — Chat, View, Log or Details of it (app-shell.js openInstanceOf) — or null. */
function openOf(route) {
  return route && ["chat", "view", "log", "details"].includes(route.panel) && typeof route.instance === "string" ? route.instance : null;
}
/** A person's choice for `name`: "page" (the whole page), "chat" (only its chat) or null (the agent's own). */
export function pageChoice(name) {
  const f = prefInForce("theme.pageByInstance");
  const m = f && f.value;
  return m && typeof m === "object" && own(m, name) && (m[name] === "page" || m[name] === "chat") ? m[name] : null;
}
/** Set it ("agent" clears it), kept with the host's preferences like the identity colour a person picks. */
export function setPageChoice(name, choice) {
  const f = prefInForce("theme.pageByInstance");
  const cur = f && f.value && typeof f.value === "object" ? f.value : {};
  const keep = Object.keys(cur).filter((k) => own(cur, k) && k !== name && (cur[k] === "page" || cur[k] === "chat")).map((k) => [k, cur[k]]);
  if (choice === "page" || choice === "chat") keep.push([name, choice]);
  savePref("theme.pageByInstance", keep.length ? Object.fromEntries(keep) : null);
  // In force on this page at once: what draws a theme follows this store (another device's change: onPrefsChanged).
  themesStore.set({ pageRev: (themesStore.get().pageRev || 0) + 1 });
}
/** `name`'s theme when its colours go on the whole page (the person's choice, else the agent's), else null. */
export function pageThemeFor(name) {
  if (!name) return null;
  const theme = themeFor(name);
  if (!theme) return null;
  const choice = pageChoice(name);
  return choice === "page" || (choice !== "chat" && theme.page && theme.page.on) ? theme : null;
}
/** The page's colours for `mode`: the theme's palette over the defaults, and its sidebar (else its background). */
export function pagePalette(theme, mode) {
  const p = { ...PAGE_DEFAULTS[mode], ...(theme.accent ? { accent: theme.accent } : {}), ...((theme.colors && theme.colors[mode]) || {}) };
  const out = {};
  for (const k of Object.keys(PAGE_DEFAULTS[mode])) out[k] = p[k];
  out.sidebar = (theme.page && theme.page.sidebar && theme.page.sidebar[mode]) || out.bg;
  return out;
}
/**
 * Whether a page palette reads (web-theme.ts's checks, again here: a person may put an agent's colours on the page
 * though the agent never asked): text and secondary text 4.5:1 and the accent 3:1 on the background, surface and
 * sidebar; every status colour 3:1 on the sidebar and the background.
 */
export function pageReadable(p, mode) {
  if (!p || !Object.values(p).every((c) => typeof c === "string" && COLOR.test(c))) return false;
  for (const bg of [p.bg, p.surface, p.sidebar]) {
    if (ratio(p.text, bg) < 4.5 - 1e-9 || ratio(p.text2, bg) < 4.5 - 1e-9) return false;
  }
  if (ratio(p.accent, p.bg) < 3 - 1e-9 || ratio(p.accent, p.sidebar) < 3 - 1e-9) return false;
  return Object.values(STATUS_COLORS[mode]).every((c) => ratio(c, p.sidebar) >= 3 - 1e-9 && ratio(c, p.bg) >= 3 - 1e-9);
}
/** The page colours in force now for `mode` (the instance the route is about), or null: the page's own. */
export function pageNow(mode, route = navStore.get().route) {
  const theme = pageThemeFor(openOf(route));
  const p = theme && pagePalette(theme, mode);
  return p && pageReadable(p, mode) ? p : null;
}
/**
 * Draw page colours `p` (pageNow) on the shell `el`, or clear them (null): the palette's tokens and the few derived
 * from it (borders, raised rows, the accent's tint and the colour on it), through the CSSOM; class th-page.
 */
export function applyPageTheme(el, p, mode) {
  if (!el || !el.style) return;
  for (const prop of [...Object.values(PAGE_PROPS), ...DERIVED_PROPS]) el.style.removeProperty(prop);
  el.classList.remove("th-page");
  if (!p) return;
  for (const [k, prop] of Object.entries(PAGE_PROPS)) el.style.setProperty(prop, p[k]);
  el.style.setProperty("--text-3", p.text2);
  el.style.setProperty("--surface-2", mix(p.surface, p.text, 0.08));
  el.style.setProperty("--border", mix(p.bg, p.text, 0.14));
  el.style.setProperty("--border-strong", mix(p.bg, p.text, 0.45));
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(p.accent.slice(i, i + 2), 16));
  el.style.setProperty("--accent-dim", `rgba(${r}, ${g}, ${b}, ${mode === "dark" ? 0.14 : 0.08})`);
  el.style.setProperty("--on-accent", ratio("#ffffff", p.accent) >= ratio("#0d0d0d", p.accent) ? "#ffffff" : "#0d0d0d");
  el.classList.add("th-page");
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
  // #2196: where this agent's colours go — its own choice, the whole page, or only its chat (the person's wins).
  const choice = pageChoice(name), theme = themeFor(name), mode = resolvedMode();
  const agentsOwn = theme && theme.page && theme.page.on ? "chat.pageAgentOn" : "chat.pageAgentOff";
  const readable = !!theme && pageReadable(pagePalette(theme, mode), mode);
  const page = theme ? [
    { key: "page-heading", heading: true, label: t("chat.pageColours") },
    { key: "page-agent", checked: choice === null, label: t(agentsOwn), onSelect: () => setPageChoice(name, "agent") },
    { key: "page-page", checked: choice === "page", label: t("chat.pageWhole"), disabled: !readable && choice !== "page", onSelect: () => setPageChoice(name, "page") },
    { key: "page-chat", checked: choice === "chat", label: t("chat.pageChatOnly"), onSelect: () => setPageChoice(name, "chat") },
  ] : [];
  return [
    ...page,
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
