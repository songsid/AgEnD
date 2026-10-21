// #1665: the web preferences that follow the person between devices — kept on the host (/ui/prefs), with this browser's
// localStorage, under the keys every panel already reads, as the cache. Design: the comment on #1665.
//
// - Synced: theme, language, the sidebar (order, folds, filter, favorites — #1664) and the HTML-preview opt-in. The tour and the first-run
//   card stay on each device, as every layout choice does.
// - The signed-in page is served with the host's values (<html data-prefs>). This module, imported before any panel
//   reads its key, copies them into the cache: the host wins once it has a value — and, on a device already in step
//   with it, a key the host does not have is the default (its stale copy here is cleared). theme.js and the
//   dictionary did the same for the theme and language, before paint.
// - A change made here is cached at once and sent to the host (a short debounce gathers a burst, such as typing in the
//   filter). Writes go one at a time; a key stays this page's own from the change until its write has ended, so no
//   answer — a read or another write — that started before can put an older value back. Every answer carries the
//   host's revision, and one older than what this page already has is ignored.
// - The public link, and the anonymous View reader, have no host write: theirs stays local.
// - The first load on a device (no agend_prefs_synced yet) uploads what it had locally for the keys the host does not
//   have yet, each with onlyIfUnset — the first device to arrive wins — then reads the host's values back. Only once
//   every upload got an answer and that read succeeded is the device marked: anything else tries again next load.
// - The status frame's prefs_rev: another device changed something; the host's values are read again and applied. A
//   revision counts as seen only once its read succeeded (a failed one is tried again, at most every few seconds).
import { deviceLanguage, lang, setLang } from "./app-i18n.js";
import { appStore, guestPage } from "./app-store.js";

const SYNCED_FLAG = "agend_prefs_synced";
const RETRY_MS = 5000;
const json = { toLocal: (v) => JSON.stringify(v), fromLocal: (s) => { try { return s == null ? undefined : JSON.parse(s); } catch { return undefined; } } };
/** Each synced preference: its cache key, and how a host value is cached (null: no entry) and read back. */
export const SYNCED = {
  theme: { ls: "agend_theme", toLocal: (v) => (v === "light" || v === "dark" ? v : null), fromLocal: (s) => (s === "light" || s === "dark" ? s : undefined) },
  lang: { ls: "agend_lang", toLocal: (v) => (v === "en" || v === "zh-TW" ? v : null), fromLocal: (s) => (s === "en" || s === "zh-TW" ? s : undefined) },
  "nav.order": { ls: "agend_view_sidebar_order", ...json },
  "nav.collapsed": { ls: "agend_instance_collapsed", ...json },
  "nav.filter": { ls: "agend_instance_filter", ...json },
  "nav.favorites": { ls: "agend_favorites", ...json },   // #1664
  "nav.sort": { ls: "agend_nav_sort", ...json },          // #2179
  "preview.optIn": { ls: "agend_html_preview", toLocal: (v) => (v ? "on" : null), fromLocal: (s) => (s === "on" ? true : undefined) },
  "names.primary": { ls: "agend_names_primary", toLocal: (v) => (v === "instance" ? v : null), fromLocal: (s) => (s === "instance" ? s : undefined) },   // #1722
  // #1629 r2 (d): "Show agents' themes and effects" — on unless turned off (only "off" is cached).
  "fx.show": { ls: "agend_fx_show", toLocal: (v) => (v === false ? "off" : null), fromLocal: (s) => (s === "off" ? false : undefined) },
  // #1629 r4.1 Q3 (a): the identity card's size — every card's default (M unless chosen), and the cards set apart.
  "card.size": { ls: "agend_card_size", toLocal: (v) => (v === "s" || v === "l" ? v : null), fromLocal: (s) => (s === "s" || s === "l" ? s : undefined) },
  "card.sizeByInstance": { ls: "agend_card_sizes", ...json },
  // #1629 r4-4: the person's own sidebar widget ({ spec, data }), drawn by the page's own components.
  "widget.sidebar": { ls: "agend_widget_sidebar", ...json },
  // #1958: where identity colours show by default (#2056: name, bar and ring unless chosen), and the host's switch to turn them off.
  "color.show": { ls: "agend_color_show", ...json },
  "theme.pageByInstance": { ls: "agend_theme_page", ...json },   // #2196
  "color.off": { ls: "agend_color_off", toLocal: (v) => (v === true ? "on" : null), fromLocal: (s) => (s === "on" ? true : undefined) },
};
// #1629: fixed personal scope. A separate session-bound owner-effect store synchronizes these, never this host cache.
export const OWNER_EFFECT_PREF_KEYS = Object.freeze(["fx.sidebar", "fx.header", "fx.page", "fx.box", "fx.cursor"]);
for (const spec of Object.values(SYNCED)) spec.scope = "host";
for (const key of OWNER_EFFECT_PREF_KEYS) SYNCED[key] = Object.freeze({ scope: "person", ls: null });
for (const spec of Object.values(SYNCED)) Object.freeze(spec);
Object.freeze(SYNCED);
const HOST_KEYS = Object.keys(SYNCED).filter(key => SYNCED[key].scope === "host");
const hostKey = key => own(SYNCED, key) && SYNCED[key].scope === "host";
const hostValues = values => Object.fromEntries(HOST_KEYS.filter(key => own(values, key)).map(key => [key, values[key]]));
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function readLocal(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeLocal(key, s) { try { if (s == null) localStorage.removeItem(key); else localStorage.setItem(key, s); } catch { /* this page only */ } }
function cache(key, value) { if (!hostKey(key)) return; const k = SYNCED[key]; writeLocal(k.ls, value == null ? null : k.toLocal(value)); }
const inStep = () => readLocal(SYNCED_FLAG) === "1";

function pageHost() {
  try {
    const d = JSON.parse(document.documentElement.getAttribute("data-prefs") || "null");
    return d && typeof d === "object" && typeof d.rev === "number" && d.values && typeof d.values === "object" ? d : null;
  } catch { return null; }
}

const initial = typeof document !== "undefined" ? pageHost() : null;
let rev = initial ? initial.rev : null;
let host = initial ? hostValues(initial.values) : null;
const pending = new Map();     // key → value chosen here, not sent yet
const mine = new Map();        // key → value chosen here whose write is not over (pending or out)
const inflight = new Map();    // key → writes sent and not answered yet
let flushTimer = null;
let writes = Promise.resolve();   // one write at a time, in the order they were made
const listeners = new Set();
// #2347: the "You" group's preferences (Settings → Preferences, Look) are saved by the Settings bar's Save like
// every Settings change. While Settings is open (holdPrefs), a choice there is shown on this page at once (cached, and
// this page's own in prefInForce) but not sent: `held` keeps it until savePrefsHeld sends them all, or discardHeldPrefs
// puts back what the host has (the same path as another device's change: apply and onPrefsChanged).
// Only keys Settings itself changes (a card's own size, card.sizeByInstance, is set from the card, outside Settings).
export const HELD_KEYS = Object.freeze(new Set(["theme", "lang", "names.primary", "preview.optIn", "fx.show", "color.show", "color.off", "card.size"]));
let holding = 0;
const held = new Map();        // key → value chosen in Settings, shown here, not saved yet
const heldFrom = new Map();    // key → its cached form before it was held (a choice back to it is no change)
const heldListeners = new Set();
// #2193: whether the signed-in person has a personal effect slot chosen (their fx.* keys: in the page's data-prefs and
// in every host read, never in this host cache). The effects runtime is loaded only when there is something to play.
const ownerEffectsIn = (values) => !!values && OWNER_EFFECT_PREF_KEYS.some((k) => own(values, k) && values[k] != null && values[k] !== "");
let ownerFx = initial ? ownerEffectsIn(initial.values) : false;
const ownerFxListeners = new Set();
/** Whether the person has any personal effect (fx.page/header/sidebar/box/cursor) chosen, as this page last read. */
export function ownerEffectsChosen() { return ownerFx; }
/** Called when that changes. Returns the unsubscribe. */
export function onOwnerEffectsChanged(fn) { ownerFxListeners.add(fn); return () => ownerFxListeners.delete(fn); }

// The host's values into the cache, now — before the sidebar, the tour or the first-run card read their keys. A key
// the host does not have: the default, on a device in step with the host; this device's own (to upload) otherwise.
if (host) {
  const step = inStep();
  for (const key of HOST_KEYS) {
    if (own(host, key)) cache(key, host[key]);
    else if (step) cache(key, null);
  }
}

/** This page may change the host's preferences: the signed-in app, not over the public link, not a guest's (#1920). */
export function prefsWritable() {
  return !!initial && !guestPage() && !(typeof document !== "undefined" && document.body && document.body.dataset.publicLink === "1");
}
/**
 * The value in force for a key, in memory — never only in this browser's storage (a full storage must not bring back
 * an old value): this page's own choice while its write is not over; else the host's; else, on a device in step with
 * the host, the default ({ value: undefined }). null: not known here (no host values on this page, or a device not yet
 * in step) — the caller reads this browser's copy.
 */
export function prefInForce(key) {
  if (!hostKey(key)) return null;
  if (mine.has(key)) return { value: mine.get(key) };
  if (host && own(host, key)) return { value: host[key] };
  if (initial && inStep()) return { value: undefined };
  return null;
}
/** The host's value for a key as this page last saw it (undefined: not set there, or not known). */
export function hostPref(key) { return hostKey(key) && host && own(host, key) ? host[key] : undefined; }
/** Called with the keys another device changed, after they are cached and applied here. Returns the unsubscribe. */
export function onPrefsChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** A host answer ({ values, rev }): a real view of the host (not an unreadable store's defaults)? */
const isView = (body) => !!body && typeof body.rev === "number" && !!body.values && typeof body.values === "object" && !body.unreadable;
/** Take a view as this page's — unless it is older than the one it has. True: taken. */
function take(body) {
  if (!isView(body) || (rev !== null && body.rev < rev)) return false;
  rev = body.rev;
  host = hostValues(body.values);
  const fx = ownerEffectsIn(body.values);
  if (fx !== ownerFx) { ownerFx = fx; for (const fn of [...ownerFxListeners]) { try { fn(fx); } catch { /* the rest still hear */ } } }
  return true;
}

/**
 * A preference chosen on this page: cached now, and kept on the host (a burst within 400 ms is one write). Not writable
 * (the public link, the anonymous reader): this browser only, as before.
 */
export function savePref(key, value) {
  if (!hostKey(key)) return;
  if (holding && HELD_KEYS.has(key)) { hold(key, value); return; }
  cache(key, value);
  if (!prefsWritable()) return;
  pending.set(key, value);
  mine.set(key, value);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 400);
}

function hold(key, value) {
  const k = SYNCED[key];
  // What was in force before, as cached: never read back from this browser's copy, which the caller may have written
  // already (theme.js stores the theme as it sets it).
  if (!heldFrom.has(key)) { const f = prefInForce(key); heldFrom.set(key, f ? (f.value == null ? null : k.toLocal(f.value)) : readLocal(k.ls)); }
  cache(key, value);
  if ((value == null ? null : k.toLocal(value)) === heldFrom.get(key)) {          // back to what it was: no change
    held.delete(key); heldFrom.delete(key);
    if (!pending.has(key) && !inflight.has(key)) mine.delete(key);
  } else { held.set(key, value); mine.set(key, value); }
  notifyHeld();
}
function notifyHeld() { for (const fn of [...heldListeners]) { try { fn(held.size); } catch { /* the rest still hear */ } } }

/**
 * #2347: Settings is open — a "You" preference chosen now is held (shown, not saved) until savePrefsHeld or
 * discardHeldPrefs. Returns the release; held choices left when the last hold goes (Settings closed without either) are
 * put back.
 */
export function holdPrefs() {
  holding++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holding--;
    // A panel shown again at once (a language switch remounts it) holds again before this runs.
    setTimeout(() => { if (!holding && held.size) discardHeldPrefs(); }, 0);
  };
}
/** How many "You" preferences are chosen and not saved yet. */
export function heldPrefsCount() { return held.size; }
/** Called with that count whenever it changes. Returns the unsubscribe. */
export function onHeldPrefs(fn) { heldListeners.add(fn); return () => heldListeners.delete(fn); }
/**
 * Save every held choice (one write). Resolves when it has been answered; rejects when the host did not take it (what
 * the host has is shown again). Not writable (the public link): this browser only, as before.
 */
export async function savePrefsHeld() {
  const keys = [...held.keys()];
  for (const key of keys) { if (prefsWritable()) pending.set(key, held.get(key)); else mine.delete(key); }
  held.clear(); heldFrom.clear();
  notifyHeld();
  if (!keys.length || !prefsWritable()) return;
  clearTimeout(flushTimer);
  if ((await flush()) === false) throw new Error("preferences not saved");
}
/** Put back what the host has for every held choice, on this page (theme, language, … and every onPrefsChanged reader). */
export function discardHeldPrefs() {
  const keys = [...held.keys()];
  held.clear(); heldFrom.clear();
  for (const key of keys) if (!pending.has(key) && !inflight.has(key)) mine.delete(key);
  notifyHeld();
  if (keys.length) align(keys, { force: true });
}
/** Run `fn` with nothing held (a confirmed action, such as Restore defaults, saves at once); its keys are held no more. */
export function withoutHold(fn) {
  const h = holding;
  holding = 0;
  try { return fn(); } finally {
    holding = h;
    for (const key of [...held.keys()]) if (pending.has(key)) { held.delete(key); heldFrom.delete(key); }
    notifyHeld();
  }
}

/** One write. ok: the host took it (its answer is a view; an older one than this page has is not taken). */
async function post(set, onlyIfUnset) {
  const res = await fetch("/ui/prefs", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(onlyIfUnset ? { set, onlyIfUnset: true } : { set }) });
  const body = await res.json().catch(() => null);
  const ok = res.ok && isView(body);
  if (ok) take(body);
  return { ok, status: res.status };
}

function flush() {
  flushTimer = null;
  if (!pending.size) return writes;
  const set = Object.fromEntries(pending);
  const keys = [...pending.keys()];
  pending.clear();
  for (const k of keys) inflight.set(k, (inflight.get(k) || 0) + 1);
  writes = writes.then(async () => {
    let ok = false;
    try { ok = (await post(set, false)).ok; } catch { ok = false; }
    const released = new Set();
    for (const k of keys) {
      const n = (inflight.get(k) || 1) - 1;
      if (n) inflight.set(k, n); else inflight.delete(k);
      if (!n && !pending.has(k) && !held.has(k)) { mine.delete(k); released.add(k); }
    }
    // Each key whose last write this was, and not changed here again since, now shows the newest host view this page
    // has — usually its own value; another device's newer one if that arrived while the write was out (held back then,
    // and an older answer to this write cannot overrule it); refused or not sent, what the host has (read back first).
    // Always applied: what the page shows came from this page's own choice, not from the cache, so the cache matching
    // the host (a storage that refused the choice) says nothing about the screen.
    if (!ok) await refresh();
    align(released, { force: true });
    return ok;
  });
  return writes;
}

/**
 * Read the host's values again and apply the ones that differ from this page's — not a key still being changed here
 * (unsent, or its write not answered yet), and nothing from an answer older than the view this page has. True: the read
 * succeeded (taken, or older than what this page already has — nothing to do).
 */
export async function refresh() {
  if (!initial) return false;
  let body = null;
  try {
    const res = await fetch("/ui/prefs", { credentials: "same-origin" });
    body = res.ok ? await res.json() : null;
  } catch { body = null; }
  if (!isView(body)) return false;
  const before = new Map(HOST_KEYS.map((key) => [key, own(host, key) ? SYNCED[key].toLocal(host[key]) : null]));
  if (take(body)) align(HOST_KEYS, { before });
  return true;
}

/**
 * Show the host view this page has for these keys — except a key still being changed here (unsent, or out). A key is
 * applied when its host value moved in memory (`before`: the host view before this read), when this browser's copy
 * differs, or always (`force`: this page's own write just ended). The copy alone never decides: a storage that refused
 * a write keeps an old copy that may equal the host while the screen shows something else.
 */
function align(keys, opts = {}) {
  const changed = new Set();
  for (const key of keys) {
    if (!hostKey(key)) continue;
    if (pending.has(key) || inflight.has(key) || held.has(key)) continue;
    const k = SYNCED[key];
    const want = own(host, key) ? k.toLocal(host[key]) : null;
    const copyDiffers = readLocal(k.ls) !== want;
    const moved = !!opts.before && opts.before.get(key) !== want;
    if (!copyDiffers && !moved && !opts.force) continue;
    if (copyDiffers) writeLocal(k.ls, want);
    changed.add(key);
  }
  if (changed.size) apply(changed);
}

function apply(changed) {
  // Only what differs from what the page shows (a key re-applied after its own write may already be in force).
  const T = globalThis.AgendTheme;
  if (changed.has("theme") && typeof T !== "undefined") { const v = hostPref("theme") || "system"; if (typeof T.get !== "function" || T.get() !== v) T.set(v); }
  if (changed.has("lang")) {
    const l = hostPref("lang");
    // None chosen any more: the device's own language, on this page only (no copy is kept for it).
    if (l) { if (l !== lang()) setLang(l); } else if (deviceLanguage() !== lang()) setLang(deviceLanguage(), { store: false });
  }
  const P = globalThis.AgendPreview;
  if (changed.has("preview.optIn") && P && typeof P.setOptIn === "function") {
    const on = hostPref("preview.optIn") === true;
    if (typeof P.optedIn !== "function" || P.optedIn() !== on) P.setOptIn(on);
  }
  for (const fn of [...listeners]) { try { fn(changed); } catch { /* one listener's error stops no other */ } }
}

/**
 * Once per device: upload what this browser had for the keys the host has not got yet (each on its own, onlyIfUnset — a
 * value the host refuses as invalid is simply not taken), then adopt the host's values. Marked only when every upload
 * was answered (taken, or refused as invalid) and the read back succeeded; a request with no answer, a server error, a
 * refused session or an unreadable store leaves the device unmarked, so the next load tries again.
 */
export async function migratePrefs() {
  if (!prefsWritable() || inStep()) return false;
  for (const key of HOST_KEYS) {
    if (own(host, key)) continue;
    const local = SYNCED[key].fromLocal(readLocal(SYNCED[key].ls));
    if (local === undefined) continue;
    let r;
    try { r = await post({ [key]: local }, true); } catch { return false; }
    if (!r.ok && r.status !== 400) return false;
  }
  if (!(await refresh())) return false;
  writeLocal(SYNCED_FLAG, "1");
  return true;
}

/** The app's boot ("full" mode): the first-load migration, then another device's changes at each status frame. */
export function bootPrefs() {
  if (!initial) return;
  // Each new revision the frames announce, read once (the store changes many times a second); one announced while a read
  // is out is read as soon as it ends. Seen only once its read succeeded: after a failed read the next try waits for a
  // later frame, at least RETRY_MS on.
  let seen = rev, busy = false, failedAt = -Infinity;
  const check = () => {
    const r = appStore.get().prefsRev;
    if (typeof r !== "number" || r === seen || busy) return;
    if (r === rev) { seen = r; return; }
    if (now() - failedAt < RETRY_MS) return;
    busy = true;
    refresh().then((ok) => { if (ok) seen = r; else failedAt = now(); }, () => { failedAt = now(); })
      .finally(() => { busy = false; check(); });
  };
  appStore.subscribe(check);
  migratePrefs();
}
