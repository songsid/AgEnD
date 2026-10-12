// #1665: the web preferences that follow the person between devices — kept on the host (/ui/prefs), with this browser's
// localStorage, under the keys every panel already reads, as the cache. Design: the comment on #1665.
//
// - Synced: theme, language, the sidebar (order, folds, filter) and the HTML-preview opt-in. The tour and the first-run
//   card stay on each device, as every layout choice does.
// - The signed-in page is served with the host's values (<html data-prefs>). This module, imported before any panel
//   reads its key, copies them into the cache: the host wins once it has a value. theme.js and the dictionary already
//   took the theme and language from the same attribute, before paint.
// - A change made here is written to the cache at once and sent to the host (a short debounce gathers a burst, such as
//   typing in the filter). The public link, and the anonymous View reader, have no host write: theirs stays local.
// - The first load on a device (no agend_prefs_synced yet) uploads what it had locally for the keys the host does not
//   have yet, each with onlyIfUnset — the first device to arrive wins — and adopts the host's values; never again.
// - The status frame's prefs_rev: another device changed something; the host's values are read again and applied.
import { lang, setLang } from "./app-i18n.js";
import { appStore } from "./app-store.js";

const SYNCED_FLAG = "agend_prefs_synced";
const json = { toLocal: (v) => JSON.stringify(v), fromLocal: (s) => { try { return s == null ? undefined : JSON.parse(s); } catch { return undefined; } } };
/** Each synced preference: its cache key, and how a host value is cached (null: no entry) and read back. */
export const SYNCED = {
  theme: { ls: "agend_theme", toLocal: (v) => (v === "light" || v === "dark" ? v : null), fromLocal: (s) => (s === "light" || s === "dark" ? s : undefined) },
  lang: { ls: "agend_lang", toLocal: (v) => (v === "en" || v === "zh-TW" ? v : null), fromLocal: (s) => (s === "en" || s === "zh-TW" ? s : undefined) },
  "nav.order": { ls: "agend_view_sidebar_order", ...json },
  "nav.collapsed": { ls: "agend_instance_collapsed", ...json },
  "nav.filter": { ls: "agend_instance_filter", ...json },
  "preview.optIn": { ls: "agend_html_preview", toLocal: (v) => (v ? "on" : null), fromLocal: (s) => (s === "on" ? true : undefined) },
};
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

function readLocal(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeLocal(key, s) { try { if (s == null) localStorage.removeItem(key); else localStorage.setItem(key, s); } catch { /* this page only */ } }
function cache(key, value) { const k = SYNCED[key]; writeLocal(k.ls, value == null ? null : k.toLocal(value)); }

function pageHost() {
  try {
    const d = JSON.parse(document.documentElement.getAttribute("data-prefs") || "null");
    return d && typeof d === "object" && typeof d.rev === "number" && d.values && typeof d.values === "object" ? d : null;
  } catch { return null; }
}

const initial = typeof document !== "undefined" ? pageHost() : null;
let rev = initial ? initial.rev : null;
let host = initial ? initial.values : null;
const pending = new Map();     // key → value not sent yet (adopting the host's values never overwrites these)
let flushTimer = null;
const listeners = new Set();

// The host's values into the cache, now — before the sidebar, the tour or the first-run card read their keys.
if (host) for (const key of Object.keys(SYNCED)) if (own(host, key)) cache(key, host[key]);

/** This page may change the host's preferences: the signed-in app, not over the public link. */
export function prefsWritable() {
  return !!initial && !(typeof document !== "undefined" && document.body && document.body.dataset.publicLink === "1");
}
/** The host's value for a key as this page last saw it (undefined: not set there, or not known). */
export function hostPref(key) { return host && own(host, key) ? host[key] : undefined; }
/** Called with the keys another device changed, after they are cached and applied here. Returns the unsubscribe. */
export function onPrefsChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/**
 * A preference chosen on this page: cached now, and kept on the host (a burst within 400 ms is one write). Not writable
 * (the public link, the anonymous reader): this browser only, as before.
 */
export function savePref(key, value) {
  if (!own(SYNCED, key)) return;
  cache(key, value);
  if (!prefsWritable()) return;
  pending.set(key, value);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 400);
}

async function post(set, onlyIfUnset) {
  const res = await fetch("/ui/prefs", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(onlyIfUnset ? { set, onlyIfUnset: true } : { set }) });
  const body = await res.json().catch(() => null);
  if (res.ok && body && typeof body.rev === "number") { rev = body.rev; host = body.values || {}; }
  return { ok: res.ok, status: res.status };
}

async function flush() {
  flushTimer = null;
  if (!pending.size) return;
  const set = Object.fromEntries(pending);
  pending.clear();
  let ok = false;
  try { ok = (await post(set, false)).ok; } catch { ok = false; }
  // Refused or not sent: what the host has is what holds — read it back, so this page does not show a choice no other
  // device will see.
  if (!ok) await refresh();
}

/** Read the host's values again and apply the ones that differ from this page's (keys still being sent excepted). */
export async function refresh() {
  if (!initial) return;
  let body = null;
  try {
    const res = await fetch("/ui/prefs", { credentials: "same-origin" });
    body = res.ok ? await res.json() : null;
  } catch { body = null; }
  if (!body || typeof body.rev !== "number" || !body.values) return;
  rev = body.rev;
  host = body.values;
  const changed = new Set();
  for (const key of Object.keys(SYNCED)) {
    if (pending.has(key)) continue;
    const k = SYNCED[key];
    const want = own(host, key) ? k.toLocal(host[key]) : null;
    if (readLocal(k.ls) === want) continue;
    writeLocal(k.ls, want);
    changed.add(key);
  }
  if (changed.size) apply(changed);
}

function apply(changed) {
  if (changed.has("theme") && typeof globalThis.AgendTheme !== "undefined") globalThis.AgendTheme.set(hostPref("theme") || "system");
  if (changed.has("lang")) { const l = hostPref("lang"); if (l && l !== lang()) setLang(l); }
  const P = globalThis.AgendPreview;
  if (changed.has("preview.optIn") && P && typeof P.setOptIn === "function") P.setOptIn(hostPref("preview.optIn") === true);
  for (const fn of [...listeners]) { try { fn(changed); } catch { /* one listener's error stops no other */ } }
}

/**
 * Once per device: upload what this browser had for the keys the host has not got yet (each on its own, onlyIfUnset — a
 * value the host refuses is simply not taken), then adopt the host's values. A request that never got an answer leaves
 * the device unmarked, so the next load tries again.
 */
export async function migratePrefs() {
  if (!prefsWritable() || readLocal(SYNCED_FLAG) === "1") return false;
  for (const key of Object.keys(SYNCED)) {
    if (own(host, key)) continue;
    const local = SYNCED[key].fromLocal(readLocal(SYNCED[key].ls));
    if (local === undefined) continue;
    try { await post({ [key]: local }, true); } catch { return false; }
  }
  await refresh();
  writeLocal(SYNCED_FLAG, "1");
  return true;
}

/** The app's boot ("full" mode): the first-load migration, then another device's changes at each status frame. */
export function bootPrefs() {
  if (!initial) return;
  // Each new revision the frames announce, once (the store changes many times a second); none newer than ours: nothing.
  let seen = rev;
  appStore.subscribe((s) => {
    const r = s.prefsRev;
    if (typeof r !== "number" || r === seen) return;
    seen = r;
    if (r !== rev) refresh();
  });
  migratePrefs();
}
