// alpha.2 (docs/design/web-unified-instance-nav.md, N1): the one instance list of the sidebar, on every page — Chat,
// View, Fleet, Settings, Needs — and for View's anonymous reader. It was two lists: the shell's (live dots, server
// order, no filter, every row to Chat) and View's roster (tag groups, drag order, a filter, rows to View). Now one:
// - live state (the status frames the app already receives; no new poll): dots, "needs you", context %, backend;
// - View's tag groups, folding and drag order, kept by this browser;
// - the filter — text plus status and CLI chips — kept by this browser and the same on every page;
// - a row opens the view you are in (View → View, everywhere else → Chat);
// - the list is never remounted on navigation, and only its own scrollTop follows the active row (#1515).
// Public (/assets/): an anonymous View reader gets the same list, fed by View's roster read instead of status frames.
import { html, useLayoutEffect, useRef, useState } from "./app-html.js";
import { t } from "./app-i18n.js";
import { appStore, createStore, useStore } from "./app-store.js";
import { chatPath, detailsPath, logPath, viewPath } from "./app-route.js";
import { Icon } from "./ui-icons.js";
import { Skeleton } from "./ui-states.js";
import { viewStore } from "./view-roster-store.js";
import { onPrefsChanged, prefInForce, prefsWritable, savePref } from "./app-prefs.js";
import "./view-strings.js";
import { themesShown, themesStore } from "./app-themes.js";
import { identityClasses, identityOf, paintIdentity, useIdentityColors } from "./identity-color.js";

/** view.* text with named values. */
function tn(key, values = {}) {
  let s = t(`view.${key}`);
  for (const [k, v] of Object.entries(values)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
/** A row's instance name: `name` (status frames) or `instance_name` (View's roster). */
const nameOf = (it) => (it && (it.name != null ? it.name : it.instance_name)) || "";

// ── Groups, labels, the filter ──
export function groupOf(it) {
  const tags = Array.isArray(it.tags) ? it.tags : [];
  if (tags.includes("classic")) return "Classic";
  if (tags.length) return tags[0];
  return "Other";
}
/** A group's heading: the fallback group ("Other") is a key, shown in the page's language; a tag is shown as it is. */
export function groupLabel(g) { return g === "Other" ? tn("groupOther") : g; }
/**
 * #2050: the model as a person reads it. The server's resolver writes English for a model it has not resolved yet
 * ("default (detected when it starts)") and for a CLI's own default ("x (default)"); those are shown in the page's language.
 */
export function modelText(it, raw = it && it.model) {
  if (!raw || typeof raw !== "string") return raw;
  if (it.model_source === "unresolved") {
    const why = /^default \((.*)\)$/.exec(raw)?.[1];
    const reason = why === "detected when it starts" ? tn("modelWhyStart") : why === "this CLI does not report a default" ? tn("modelWhyCli") : why;
    return reason ? tn("modelDefaultWhy", { reason }) : raw === "default" ? tn("modelDefault") : raw;
  }
  if (it.model_source === "cli-default") { const m = /^(.*) \(default\)$/.exec(raw); if (m) return tn("modelCliDefault", { model: m[1] }); }
  return raw;
}
const BACKEND_LABELS = { "claude-code": "Claude Code", "kiro-cli": "Kiro CLI", codex: "Codex", grok: "Grok Build", antigravity: "Antigravity", opencode: "OpenCode" };
export function backendLabel(backend) { return BACKEND_LABELS[backend] || backend || "Unknown"; }
export const KNOWN_BACKENDS = new Set(Object.keys(BACKEND_LABELS));
export const STATUS_KEYS = { running: "statusRunning", paused: "statusPaused", stopped: "statusStopped", crashed: "statusCrashed" };

/** The status chips, in order (design Q5): what the row's dot says, in five words. */
export const STATUS_FACETS = ["working", "needs", "idle", "stopped", "crashed"];
/** Which status chip a row falls under: needs you first, then crashed, not running, working (or stuck), idle. */
export function statusFacet(it, exec, awaiting) {
  if (awaiting != null) return "needs";
  if (!it || it.status === "crashed") return "crashed";
  if (it.status !== "running") return "stopped";
  return exec === "working" || exec === "stuck" ? "working" : "idle";
}

export function normalizeFilter(query) { return String(query == null ? "" : query).trim().toLowerCase(); }
/** Case-insensitive substring on name (incl. display name), model and backend. */
export function instanceMatchesFilter(it, needle, labelOf) {
  if (!needle) return true;
  const fields = [nameOf(it), it.display_name, it.model, it.backend, labelOf ? labelOf(it.backend) : null];
  return fields.some((value) => typeof value === "string" && value.toLowerCase().includes(needle));
}
/**
 * Visible groups in display order, and the "N / M" counts. `facets` (optional): { status: [...], cli: [...],
 * statusOf(name) } — an empty list does not filter; a non-empty one keeps the rows whose status / backend is in it.
 */
export function filterSidebar(groupNames, instByGroup, rosterByName, query, labelOf, facets) {
  const needle = normalizeFilter(query);
  const status = new Set(facets && Array.isArray(facets.status) ? facets.status : []);
  const cli = new Set(facets && Array.isArray(facets.cli) ? facets.cli : []);
  const keep = (name) => {
    const it = rosterByName.get(name);
    if (!instanceMatchesFilter(it, needle, labelOf)) return false;
    if (status.size && !status.has(facets.statusOf ? facets.statusOf(name) : statusFacet(it))) return false;
    if (cli.size && !cli.has(it.backend || "")) return false;
    return true;
  };
  const groups = [];
  let shown = 0, total = 0;
  for (const g of groupNames) {
    const names = (instByGroup.get(g) || []).filter((name) => rosterByName.has(name));
    total += names.length;
    const visible = names.filter(keep);
    shown += visible.length;
    if (visible.length) groups.push({ group: g, names: visible });
  }
  return { groups, shown, total, active: needle.length > 0 || status.size > 0 || cli.size > 0 };
}
export function instanceTooltip(it) {
  const context = it.context_pct != null && Number.isFinite(it.context_pct) ? `${Math.round(Math.min(100, Math.max(0, it.context_pct)))}%` : tn("tooltipUnavailable");
  const status = STATUS_KEYS[it.status] ? tn(STATUS_KEYS[it.status]) : it.status || tn("statusUnknown");
  const line = (key, value) => tn(key, { value });
  const lines = [];
  const name = nameOf(it);
  if (it.display_name && it.display_name !== name) lines.push(it.display_name, `(${name})`);
  else lines.push(name);
  lines.push(line("tooltipBackend", backendLabel(it.backend)));
  const src = (s) => (s === "instance" || s === "classic" ? tn("srcConfigured") : s === "fleet-default" ? tn("srcFleetDefault") : "");
  lines.push(line("tooltipModel", (modelText(it) || tn("tooltipUnavailable")) + src(it.model_source)));
  lines.push(line("tooltipStatus", status));
  lines.push(line("tooltipContext", context));
  if (it.effort) lines.push(line("tooltipEffort", it.effort + src(it.effort_source)));
  if (typeof it.cost === "number" && it.cost > 0) lines.push(line("tooltipCost", `$${it.cost.toFixed(2)}`));
  if (typeof it.description === "string" && it.description.trim()) lines.push("", it.description.trim());
  return lines.join("\n");
}

// ── The order (drag), folded groups and filter: host preferences since #1665 (nav.*), cached in this browser ──
const SIDEBAR_ORDER_KEY = "agend_view_sidebar_order";   // View's key since #999: everyone's arrangement carries over
const COLLAPSED_KEY = "agend_instance_collapsed";
const FILTER_KEY = "agend_instance_filter";
const FAVORITES_KEY = "agend_favorites";   // #1664
/**
 * A synced sidebar preference, as the JSON its reader parses: the value in force in memory (app-prefs.js — this
 * page's own change, else the host's; a full or blocked storage never brings an old one back), else this browser's copy.
 */
function inForce(prefKey, lsKey) {
  const p = prefInForce(prefKey);
  if (!p) return stored(lsKey);
  return p.value === undefined ? null : JSON.stringify(p.value);
}
function readOrder() {
  const groups = new Map(), insts = new Map();
  try {
    const rows = JSON.parse(inForce("nav.order", SIDEBAR_ORDER_KEY) || "[]");
    if (Array.isArray(rows)) for (const row of rows) {
      if (row && row.item_type === "group" && typeof row.item_name === "string") groups.set(row.item_name, Number(row.sort_index) || 0);
      else if (row && row.item_type === "instance" && typeof row.item_name === "string") insts.set(row.item_name, Number(row.sort_index) || 0);
    }
  } catch { /* ignore invalid browser-local state */ }
  return { groups, insts };
}
function readCollapsed() {
  try { const a = JSON.parse(inForce("nav.collapsed", COLLAPSED_KEY) || "[]"); return new Set(Array.isArray(a) ? a.filter((x) => typeof x === "string") : []); } catch { return new Set(); }
}
const strings = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === "string") : []);
function readFilter() {
  try {
    const f = JSON.parse(inForce("nav.filter", FILTER_KEY) || "{}");
    return { q: f && typeof f.q === "string" ? f.q : "", status: strings(f && f.status).filter((s) => STATUS_FACETS.includes(s)), cli: strings(f && f.cli) };
  } catch { return { q: "", status: [], cli: [] }; }
}
function readFavorites() {
  try { const a = JSON.parse(inForce("nav.favorites", FAVORITES_KEY) || "[]"); return Array.isArray(a) ? [...new Set(a.filter((x) => typeof x === "string"))] : []; } catch { return []; }
}
/** Display order: this browser's saved order first, then new groups/instances by tag and name. */
export function computeOrder(roster, order) {
  const groups = new Map();
  for (const it of roster) { const g = groupOf(it); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(it); }
  const gidx = (g) => (order.groups.has(g) ? order.groups.get(g) : Infinity);
  const groupNames = [...groups.keys()].sort((a, b) => {
    const ia = gidx(a), ib = gidx(b);
    if (ia !== ib) return ia - ib;
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });
  const instByGroup = new Map();
  for (const [g, items] of groups) {
    instByGroup.set(g, items.map(nameOf).sort((a, b) => {
      const ia = order.insts.has(a) ? order.insts.get(a) : Infinity, ib = order.insts.has(b) ? order.insts.get(b) : Infinity;
      return ia - ib;
    }));
  }
  return { groupNames, instByGroup };
}
function moveIn(arr, moving, target, before) {
  if (!arr) return;
  const from = arr.indexOf(moving);
  if (from === -1) return;
  arr.splice(from, 1);
  let to = arr.indexOf(target);
  if (to === -1) { arr.push(moving); return; }
  if (!before) to += 1;
  arr.splice(to, 0, moving);
}

/** The list's state for the page's life: this browser's order, folded groups and filter (each also kept in storage). */
export const navStore = createStore({ order: readOrder(), collapsed: readCollapsed(), filter: readFilter(), favorites: readFavorites() });
/** Read them again from this browser's storage — what a page load does (the store above is made that way). */
export function loadNavPrefs() {
  navStore.set({ order: readOrder(), collapsed: readCollapsed(), filter: readFilter(), favorites: readFavorites() });
  namesStore.set({ primary: readNamesPrimary() });
}
/** Change the filter ({ q?, status?, cli? }): the same on every page, and kept by this browser. */
export function setNavFilter(patch) {
  const filter = { ...navStore.get().filter, ...patch };
  navStore.set({ filter });
  savePref("nav.filter", { q: filter.q, status: filter.status, cli: filter.cli });
}
function setCollapsed(collapsed) { navStore.set({ collapsed }); savePref("nav.collapsed", [...collapsed]); }
// Another device rearranged, folded or filtered: this page's list follows (its cache is already updated).
onPrefsChanged((keys) => { if (keys.has("nav.order") || keys.has("nav.collapsed") || keys.has("nav.filter") || keys.has("nav.favorites")) loadNavPrefs(); });

// ── #1664: favorites — starred instances, pinned at the top in the order they were starred (or moved) ──
export const MAX_FAVORITES = 50;
/** The favorites that are instances now (`known`: the names listed): what is shown, and the base of every change — so
 *  a deleted instance is dropped, never sent back to the host (which would refuse it). */
function liveFavorites(known) { return navStore.get().favorites.filter((n) => known.has(n)); }
function setFavorites(next) { navStore.set({ favorites: next }); savePref("nav.favorites", next); }
/** Star or unstar `name`. False: not done (the list is full). */
export function toggleFavorite(name, known) {
  const cur = liveFavorites(known);
  if (cur.includes(name)) { setFavorites(cur.filter((n) => n !== name)); return true; }
  if (cur.length >= MAX_FAVORITES || !known.has(name)) return false;
  setFavorites([...cur, name]);
  return true;
}
/** Move a favorite one place up (-1) or down (+1). */
export function moveFavorite(name, delta, known) {
  const cur = liveFavorites(known);
  const from = cur.indexOf(name), to = from + delta;
  if (from < 0 || to < 0 || to >= cur.length) return;
  cur.splice(to, 0, cur.splice(from, 1)[0]);
  setFavorites(cur);
}
// ── #1700: the filter's facet groups, open or folded — per device (localStorage; blocked or full storage: this page only) ──
const FACETS_KEY = "agend_nav_facets";
function readFacetsOpen() {
  try {
    const v = JSON.parse(stored(FACETS_KEY) || "{}");
    return { status: !!(v && v.status === true), cli: !!(v && v.cli === true) };
  } catch { return { status: false, cli: false }; }
}
function writeFacetsOpen(open) { try { localStorage.setItem(FACETS_KEY, JSON.stringify({ status: !!open.status, cli: !!open.cli })); } catch { /* this page only */ } }

/** The Favorites group's key among the tag groups: no tag can be it (a group name is never a control character). */
const FAV_GROUP = "\u0000favorites";
/** #1936: the open instance, pinned on top while a filter is on. */
const PINNED_GROUP = "\u0000pinned";
function persistOrder(groupNames, instByGroup) {
  const rows = [];
  groupNames.forEach((g, i) => rows.push({ item_type: "group", item_name: g, sort_index: i, group_name: null }));
  for (const g of groupNames) (instByGroup.get(g) || []).forEach((n, j) => rows.push({ item_type: "instance", item_name: n, sort_index: j, group_name: g }));
  savePref("nav.order", rows);
  navStore.set({ order: { groups: new Map(groupNames.map((g, i) => [g, i])), insts: new Map(rows.filter((r) => r.item_type === "instance").map((r) => [r.item_name, r.sort_index])) } });
}

// ── #1630: what stands for an instance (design: the comment on #1630) ──
// The server decides (the status frame's `avatar` / `accent`); the page only draws it. The anonymous View roster has
// neither: its rows get the first character. A picture is only ever a same-origin /ui/img/ path — never a platform's
// CDN (CSP img-src stays 'self'); one that fails to load falls back to the first character, never a broken image.

const GRAPHEMES = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
/** The first user-perceived character, upper-cased where that means anything. */
export function firstCharacter(text) {
  const s = String(text == null ? "" : text).trim();
  if (!s) return "?";
  if (GRAPHEMES) for (const { segment } of GRAPHEMES.segment(s)) return segment.toLocaleUpperCase();
  return Array.from(s)[0].toLocaleUpperCase();
}
/** What a row is called: the display name when it has one, else the instance name (shown on hover and in Details). */
export function labelOf(it) {
  const d = it && typeof it.display_name === "string" ? it.display_name.trim() : "";
  return d || nameOf(it);
}

// ── #1722: both names — which one leads is a synced preference (#1665 "names.primary", default the nickname) ──
const NAMES_KEY = "agend_names_primary";
function readNamesPrimary() {
  const p = prefInForce("names.primary");
  const v = p ? p.value : stored(NAMES_KEY);
  return v === "instance" ? "instance" : "nickname";
}
/** { primary: "nickname" | "instance" } — every surface that names an instance (sidebar, chat header, Needs you) reads it. */
export const namesStore = createStore({ primary: readNamesPrimary() });
export function setNamesPrimary(value) {
  const primary = value === "instance" ? "instance" : "nickname";
  namesStore.set({ primary });
  savePref("names.primary", primary);
}
onPrefsChanged((keys) => { if (keys.has("names.primary")) namesStore.set({ primary: readNamesPrimary() }); });
/**
 * An instance's two names as the web shows them: the one leading (`primary`) and the other (`secondary`), or "" when
 * there is no other — no nickname, or a nickname that is the instance name itself (one line).
 */
export function namesOf(it, primary = namesStore.get().primary) {
  const real = nameOf(it);
  const nick = it && typeof it.display_name === "string" ? it.display_name.trim() : "";
  if (!nick || nick === real) return { primary: real, secondary: "" };
  return primary === "instance" ? { primary: real, secondary: nick } : { primary: nick, secondary: real };
}

/** #1722: the CLI on the avatar's corner — a letter, so it reads without colour (its name is in the row's text too). */
const CLI_MONOGRAM = { "claude-code": "C", codex: "X", "kiro-cli": "K", grok: "G", antigravity: "A", opencode: "O", muse: "M" };
// One path segment under /ui/img/<kind>/ — no further slash or backslash, and not a dot segment ("." / ".." or their
// %2e spellings, which a browser resolves too): the picture can only ever be one of those routes (#1642 review).
const sameOrigin = (src) => typeof src === "string"
  && (/^\/ui\/img\/(bot|avatar|emoji)\/(?!(?:\.|%2[eE]){1,2}(?:\?|$))[^/\\?#\s]+(\?v=[0-9A-Za-z%._-]*)?$/.test(src)
    // #1629: a theme's picture — one name segment, then its 32-hex content id.
    || /^\/ui\/img\/theme\/(?!(?:\.|%2[eE]){1,2}\/)[^/\\?#\s]+\/[0-9a-f]{32}$/.test(src));
/**
 * The avatar to draw: the server's, if it is one the page may load; else the first character. #1629: the agent's theme
 * picture first, while this viewer shows agents' themes (fx.show, not safe mode).
 */
export function avatarOf(it) {
  const th = it && themesShown() ? it.theme_avatar : null;
  if (th && th.kind === "image" && sameOrigin(th.src)) return { kind: "image", src: th.src };
  const a = it && it.avatar;
  if (a && a.kind === "image" && sameOrigin(a.src)) return { kind: "image", src: a.src };
  if (a && a.kind === "emoji" && sameOrigin(a.src)) return { kind: "emoji", src: a.src, alt: typeof a.alt === "string" ? a.alt : "" };
  if (a && a.kind === "emoji" && typeof a.text === "string" && a.text.trim()) return { kind: "emoji", text: a.text.trim() };
  // #1722: the initial is the leading name's ("Names"), not the server's (which is always the nickname's).
  return { kind: "initial", text: firstCharacter(namesOf(it).primary) || (a && a.kind === "initial" && typeof a.text === "string" ? a.text : "") };
}
/** The status dot on the avatar: needs you, crashed, paused, stopped, looks stuck, working, idle — colour AND a label. */
export function dotState(it, exec, awaiting) {
  if (awaiting != null) return "needs";
  if (!it || it.status === "crashed") return "crashed";
  if (it.status === "paused") return "paused";
  if (it.status !== "running") return "stopped";
  return exec === "stuck" ? "stuck" : exec === "working" ? "working" : "idle";
}
const DOT = {
  needs: ["warn", () => t("app.needsYou")], crashed: ["bad", () => t("app.statusCrashed")], paused: ["off hollow", () => t("app.statusPaused")],
  stopped: ["off", () => t("app.statusStopped")], stuck: ["warn", () => t("app.statusStuck")], working: ["busy", () => t("app.statusWorking")],
  idle: ["ok", () => t("app.statusIdle")],
};
export function dotLabel(state) { return (DOT[state] || DOT.stopped)[1](); }

/**
 * An instance's avatar with its status dot. #1958: its ring is the identity colour, painted by the row it sits in
 * (identity-color.js: `.idc.id-ring`), for every face.
 */
export function InstanceAvatar({ it, state, cli = false }) {
  useStore(themesStore);                                    // #1629: redraw when the viewer turns agents' themes on or off
  const a = avatarOf(it);
  const [broken, setBroken] = useState("");
  const src = a.kind !== "initial" && a.src && broken !== a.src ? a.src : "";
  const text = a.kind === "emoji" && a.text ? a.text : a.kind === "initial" ? a.text : firstCharacter(namesOf(it).primary);
  const [cls] = DOT[state] || DOT.stopped;
  const label = dotLabel(state);
  return html`<span class=${`av${a.kind === "emoji" ? " av-emoji" : ""}`}>
    ${src ? html`<img src=${src} alt="" decoding="async" onError=${() => setBroken(src)} />` : html`<span class="av-text" aria-hidden="true">${text}</span>`}
    <span class=${`av-dot dot ${cls}`} role="img" aria-label=${label} title=${label}></span>${cli
      ? html`<span class="av-cli" aria-hidden="true" title=${backendLabel(it.backend)}>${CLI_MONOGRAM[it.backend] || "·"}</span>` : null}</span>`;
}

// ── The list ──

const statusText = (facet) => (facet === "needs" ? t("app.needsYou") : facet === "working" ? t("app.statusWorking") : facet === "idle" ? t("app.statusIdle")
  : facet === "crashed" ? t("app.statusCrashed") : t("app.statusStopped"));

/**
 * The sidebar's instance list. `route`: the page's (which instance is open, and which view a row opens). `items`: the
 * rows (status frames' instances, or View's roster for an anonymous reader); `loaded` false shows a skeleton.
 * `exec` / `awaiting`: live state by name (empty for the anonymous reader). `onPick`: a row was clicked (the drawer
 * closes).
 */
export function InstanceNav({ route, items, loaded = true, exec = {}, awaiting = {}, viewOnly = false, onPick }) {
  const nav = useStore(navStore);
  const names = useStore(namesStore);   // #1722: which name leads
  useIdentityColors();                  // #1958: repaint when the host's colour settings or the themes switch change
  const filterRef = useRef(null);
  const list = useRef(null);
  const drag = useRef(null);
  // #1700: which facet groups are open — this device's (screen layout, not a synced preference), read when the list mounts.
  const [facetOpen, setFacetOpen] = useState(readFacetsOpen);
  const toggleFacet = (key) => setFacetOpen((cur) => { const next = { ...cur, [key]: !cur[key] }; writeFacetsOpen(next); return next; });
  // #1664: "☆ Edit" — the stars on every row (on a phone the only way to them) and ↑ ↓ on the favorites — only on the
  // full list, as drag: in a filtered one the row above may not be the one above in the list (#1677 review).
  const [editing, setEditing] = useState(false);
  // Where a row goes: the view the page is in (#1523 §3.1). View → View; Details → Details; everywhere else, a Fleet tab
  // included (#1917: the user's call, replacing Q4 = A), → Chat. The anonymous reader only ever has View.
  const rowPath = viewOnly || (route && route.panel === "view") ? viewPath
    : route && route.panel === "log" ? logPath                                  // #1218: Log → Log
    : route && route.panel === "details" ? detailsPath : chatPath;
  const active = route && (route.panel === "chat" || route.panel === "view" || route.panel === "log" || route.panel === "details") ? route.instance : null;
  const own = (map, name) => Object.prototype.hasOwnProperty.call(map, name);
  const byName = new Map(items.map((it) => [nameOf(it), it]));
  const facetOf = (name) => statusFacet(byName.get(name), own(exec, name) ? exec[name] : null, own(awaiting, name) ? awaiting[name] : null);
  const { groupNames, instByGroup } = computeOrder(items, nav.order);
  // #1664: the favorites that are instances now, as a group of their own on top; the other groups keep the rest, in
  // their order. Changing them: a signed-in page that may write preferences (not the public link, not the anonymous
  // reader — they still see the list).
  const known = new Set(byName.keys());
  const favs = nav.favorites.filter((n) => known.has(n));
  const favSet = new Set(favs);
  const canStar = !viewOnly && prefsWritable();
  const shownGroups = favs.length ? [FAV_GROUP, ...groupNames] : groupNames;
  const shownInsts = new Map([...instByGroup].map(([g, names]) => [g, names.filter((n) => !favSet.has(n))]));
  if (favs.length) shownInsts.set(FAV_GROUP, favs);
  const f = nav.filter;
  const shown = filterSidebar(shownGroups, shownInsts, byName, f.q, backendLabel, { status: f.status, cli: f.cli, statusOf: facetOf });
  // #1936: while a filter is on, the instance you have open stays on top, pinned and marked "Current", whether or not
  // it matches; a match is not repeated below. "N / M" still counts the filter's matches (the pinned row counts only
  // when it is one). Clearing the filter puts it back in its place, and the list scrolls to it again.
  const pinned = shown.active && active && byName.has(active) ? active : null;
  const listed = pinned ? shown.groups.map((x) => ({ ...x, names: x.names.filter((n) => n !== pinned) })).filter((x) => x.names.length) : shown.groups;
  useLayoutEffect(() => { keepActiveInView(list.current); }, [active, items.length, loaded, shown.active]);
  const backends = [...new Set(items.map((it) => it.backend).filter((b) => typeof b === "string" && b))].sort((a, b) => backendLabel(a).localeCompare(backendLabel(b)));
  const toggle = (g) => { const c = new Set(navStore.get().collapsed); if (c.has(g)) c.delete(g); else c.add(g); setCollapsed(c); };
  // From the store, not this render's copy: two clicks before the next render must both count.
  const flip = (key, value) => { const cur = new Set(navStore.get().filter[key]); if (cur.has(value)) cur.delete(value); else cur.add(value); setNavFilter({ [key]: [...cur] }); };
  // Drag to reorder: only the full list (a filtered subset would be ambiguous), groups among groups, instances within
  // their group.
  const dragProps = (item) => shown.active ? {} : {
    draggable: true,
    onDragStart: (e) => { drag.current = item; e.currentTarget.classList.add("dragging"); try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", item.name); } catch { /* Firefox needs data */ } },
    onDragEnd: (e) => { e.currentTarget.classList.remove("dragging"); drag.current = null; },
    onDragOver: (e) => {
      const d = drag.current;
      if (!d || d.type !== item.type || d.name === item.name || (item.type === "instance" && d.group !== item.group)) return;
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      e.currentTarget.classList.toggle("drop-before", before);
      e.currentTarget.classList.toggle("drop-after", !before);
    },
    onDragLeave: (e) => e.currentTarget.classList.remove("drop-before", "drop-after"),
    onDrop: (e) => {
      e.preventDefault();
      const before = e.currentTarget.classList.contains("drop-before");
      e.currentTarget.classList.remove("drop-before", "drop-after");
      const d = drag.current;
      if (!d || d.type !== item.type) return;
      const names = [...groupNames], insts = new Map([...instByGroup].map(([g, n]) => [g, [...n]]));
      if (item.type === "group") moveIn(names, d.name, item.name, before);
      else if (d.group === item.group) moveIn(insts.get(item.group), d.name, item.name, before);
      else return;
      persistOrder(names, insts);
    },
  };
  // #1700: a facet group (Status, CLI) folds under a real header button. Folded with a filter set, the header says so:
  // one or two choices by name, more as "N selected" — a filter is never out of sight.
  const chips = (key, values, label, text) => {
    const open = !!facetOpen[key];
    const sel = f[key];
    const summary = !open && sel.length ? (sel.length <= 2 ? sel.map(text).join(", ") : tn("facetSelected", { n: sel.length })) : "";
    const hint = tn(open ? "facetHide" : "facetShow", { group: label });
    return html`<div class=${`nav-facet${open ? " open" : ""}`}>
      <button type="button" class="nav-facet-head" aria-expanded=${open ? "true" : "false"} aria-controls=${`nav-facet-${key}`}
        title=${summary ? `${hint} (${label} · ${summary})` : hint} onClick=${() => toggleFacet(key)}>
        <${Icon} name="chevron" size=${12} cls=${open ? "caret" : "caret folded"} /><span class="nav-facet-label">${label}</span>
        ${summary ? html`<span class="nav-facet-sum">· ${summary}</span>` : sel.length ? html`<span class="nav-facet-n">${sel.length}</span>` : null}
      </button>
      ${open ? html`<div id=${`nav-facet-${key}`} class="nav-facet-list" role="group" aria-label=${label}>${values.map((value) => html`<label key=${value} class="nav-chip">
        <input type="checkbox" checked=${sel.includes(value)} onChange=${() => flip(key, value)} /><span>${text(value)}</span></label>`)}</div>` : null}
    </div>`;
  };
  const row = (name, g, i, count) => {
    const it = byName.get(name);
    // #1722: both names, the preferred one first; one line when there is no other.
    const { primary: label, secondary } = namesOf(it, names.primary);
    const facet = facetOf(name);
    const waiting = own(awaiting, name) ? awaiting[name] : null;
    const on = name === active;
    const fav = g === FAV_GROUP, starred = favSet.has(name);
    // #1958: its identity colour — the ring, a left bar and/or the name, as resolved; painted through the CSSOM.
    const id = identityOf(it);
    const full = !starred && favs.length >= MAX_FAVORITES;
    return html`<li key=${name} class="v-li"><a class=${`inst v-inst${on ? " active" : ""} ${identityClasses(id)}`} ref=${(el) => paintIdentity(el, id)} href=${rowPath(name)} title=${instanceTooltip(it)}
        aria-current=${on ? "page" : undefined} onClick=${onPick} ...${fav ? {} : dragProps({ type: "instance", name, group: g })}>
      <${InstanceAvatar} it=${it} state=${dotState(it, own(exec, name) ? exec[name] : null, waiting)} cli=${true} />
      <span class="inst-text"><span class="inst-name" title=${label}>${label}</span>
        ${secondary ? html`<span class="inst-alt" title=${secondary}>${secondary}</span>` : null}
        ${facet === "needs" ? html`<span class="inst-sub"><span class="badge-await" title=${waiting || t("app.approxNote")}>${t("app.needsYou")}</span></span>` : null}
        <span class="sr-only">${tn("tooltipBackend", { value: backendLabel(it.backend) })}</span></span>
      <span class="v-meta">${it.context_pct != null ? `${Math.round(it.context_pct)}%` : ""}</span>
    </a>${fav && editing && canStar ? html`<button type="button" class="icon-btn inst-move" aria-label=${tn("favUp", { name: label })}
        title=${shown.active ? tn("favFiltered") : tn("favUp", { name: label })} disabled=${shown.active || i === 0} onClick=${() => { if (!shown.active) moveFavorite(name, -1, known); }}><${Icon} name="up" size=${14} /></button><button type="button" class="icon-btn inst-move"
        aria-label=${tn("favDown", { name: label })} title=${shown.active ? tn("favFiltered") : tn("favDown", { name: label })} disabled=${shown.active || i === count - 1}
        onClick=${() => { if (!shown.active) moveFavorite(name, 1, known); }}><${Icon} name="down" size=${14} /></button>` : null}${canStar
      ? html`<button type="button" class=${`icon-btn inst-star${starred ? " on" : ""}`} aria-pressed=${starred ? "true" : "false"} disabled=${full}
          aria-label=${tn(starred ? "favRemove" : "favAdd", { name: label })} title=${full ? tn("favFull", { max: MAX_FAVORITES }) : tn(starred ? "favRemove" : "favAdd", { name: label })}
          onClick=${() => toggleFavorite(name, known)}><${Icon} name="star" size=${14} /></button>` : null}</li>`;
  };
  // The list scrolls; the filter under it stays in view (#999), so it sits outside the scrolling section.
  return html`<div class=${`view-roster inst-nav${editing && canStar ? " fav-editing" : ""}`}>
    <div data-trust="navigation" class="side-section" id="instanceList" ref=${list}>
    <div class="inst-head"><h2 class="side-label">${tn("instancesLabel")}</h2>
      ${canStar && items.length ? html`<button type="button" class="chip-btn fav-edit" aria-pressed=${editing ? "true" : "false"} onClick=${() => setEditing(!editing)}>
        ${editing ? tn("favDone") : html`<${Icon} name="star" size=${12} />${tn("favEdit")}`}</button>` : null}</div>
    ${!loaded ? html`<${Skeleton} lines=${4} />` : !items.length ? html`<p class="side-empty">${t("app.noInstances")}</p>` : null}
    ${pinned ? html`<div key=${PINNED_GROUP} class="v-group v-pinned" role="group" aria-label=${tn("pinnedLabel")}>
      <div class="v-group-head pinned-head"><span class="grow">${tn("pinnedCurrent")}</span></div>
      <ul class="inst-list">${row(pinned, PINNED_GROUP, 0, 1)}</ul></div>` : null}
    ${listed.map(({ group: g, names }) => {
      // #1664: Favorites — always open, not dragged (↑ ↓ in Edit), named in the page's language.
      if (g === FAV_GROUP) return html`<div key=${g} class="v-group v-fav" role="group" aria-label=${tn("favorites")}>
        <div class="v-group-head fav-head"><${Icon} name="star" size=${14} cls="fav-mark" /><span class="grow">${tn("favorites")}</span><span class="count">${names.length}</span></div>
        <ul class="inst-list">${names.map((name, i) => row(name, g, i, names.length))}</ul></div>`;
      const folded = nav.collapsed.has(g);
      return html`<div key=${g} class="v-group">
        <button type="button" class="v-group-head" aria-expanded=${folded ? "false" : "true"} onClick=${() => toggle(g)}
          title=${tn(folded ? "expandGroup" : "collapseGroup", { group: groupLabel(g) })} ...${dragProps({ type: "group", name: g })}>
          <${Icon} name="chevron" size=${14} cls=${folded ? "caret folded" : "caret"} /><span class="grow">${groupLabel(g)}</span><span class="count">${names.length}</span></button>
        ${folded ? null : html`<ul class="inst-list">${names.map((name, i) => row(name, g, i, names.length))}</ul>`}
      </div>`;
    })}
    ${loaded && shown.active && !shown.groups.length ? html`<p class="side-empty">${tn("filterNone")}</p>` : null}
    </div>
    <div class="v-filter">
      <label class="v-filter-box"><${Icon} name="search" size=${14} /><span class="sr-only">${tn("filterPh")}</span>
        <input ref=${filterRef} id="filterInput" type="text" autocomplete="off" spellcheck=${false} placeholder=${tn("filterPh")} value=${f.q}
          onInput=${(e) => setNavFilter({ q: e.target.value })}
          onKeyDown=${(e) => { if (e.key === "Escape" && f.q) { e.preventDefault(); e.stopPropagation(); setNavFilter({ q: "" }); } }} />
        ${f.q ? html`<button type="button" class="icon-btn v-filter-clear" aria-label=${tn("filterClear")} title=${tn("filterClear")}
          onClick=${() => { setNavFilter({ q: "" }); filterRef.current && filterRef.current.focus(); }}><${Icon} name="close" size=${14} /></button>` : null}
      </label>
      <div class="nav-facets">
        <div class="nav-facet-groups">
          ${viewOnly ? null : chips("status", STATUS_FACETS, tn("filterStatus"), statusText)}
          ${backends.length > 1 || f.cli.length ? chips("cli", backends, tn("filterCli"), backendLabel) : null}
          ${f.status.length || f.cli.length ? html`<button type="button" class="chip-btn nav-facet-reset" onClick=${() => setNavFilter({ status: [], cli: [] })}>${tn("filterFacetsReset")}</button>` : null}
        </div>
        <p class="note nav-shown" aria-live="polite">${shown.shown} / ${shown.total}${shown.active ? ` ${tn("filterShown")}` : ""}</p>
      </div>
    </div>
  </div>`;
}

/**
 * Keep a sidebar list's current item in view by scrolling that list only (alpha.2): never scrollIntoView, which would
 * also scroll every scrollable ancestor, the page included. A list the reader scrolled stays where it is otherwise.
 */
export function keepActiveInView(container) {
  const a = container && container.querySelector('[aria-current="page"]');
  if (!a) return;
  const c = container.getBoundingClientRect(), r = a.getBoundingClientRect();
  if (r.top < c.top) container.scrollTop -= c.top - r.top;
  else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom;
}

/** The list fed by View's roster read (/api/profiles): the anonymous View reader's, who has no status frames. */
export function RosterNav({ route, viewOnly = false, onPick }) {
  const v = useStore(viewStore);
  return html`<${InstanceNav} route=${route || { panel: "view", instance: v.current }} items=${v.roster} loaded=${v.loaded} viewOnly=${viewOnly} onPick=${onPick} />`;
}
