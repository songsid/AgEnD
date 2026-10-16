// #1629: host-authoritative personal choices. No local cache, migration, frame, code fetch or automatic resend.
import { createStore, appStore } from "./app-store.js";
import { OWNER_EFFECT_PREF_KEYS } from "./app-prefs.js";
import { checkEffectOwnerSlots } from "./effect-runtime-loader.js";
const KEYS = OWNER_EFFECT_PREF_KEYS, ID = /^[a-f0-9]{32}$/, EPOCH = /^[a-f0-9]{16}$/;
const plain = x => !!x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype;
const own = (x, k) => Object.hasOwn(x, k);
const unknownSlots = () => Object.fromEntries(KEYS.map(k => [k, { status: "unknown", id: null }]));
const publicPage = () => typeof document === "undefined" || document.body?.dataset.publicLink === "1" || document.body?.dataset.mode === "view-only";
function bootScope() {
  try {
    const x = JSON.parse(document.documentElement.getAttribute("data-prefs") || "null");
    return plain(x) && ["person", "operator"].includes(x.ownerScope) && typeof x.ownerEpoch === "string" && EPOCH.test(x.ownerEpoch)
      ? Object.freeze({ scope: x.ownerScope, epoch: x.ownerEpoch }) : null;
  } catch { return null; }
}
const owner = bootScope();
export const ownerEffectsStore = createStore({ scope: owner?.scope ?? "none", status: "unknown", revoked: false, busy: false, slots: unknownSlots(), error: null });
let watchers = 0, generation = 0, active = null, queuedRead = false, unsubscribe = null, rev = -1, seen = null, failedAt = -Infinity;
const clock = () => { try { const n = performance.now(); return Number.isFinite(n) && n >= 0 ? n : null; } catch { return null; } };
const eligible = () => !!owner && watchers > 0 && !publicPage() && !ownerEffectsStore.get().revoked;
const current = op => eligible() && op.generation === generation && active === op;
function revoke() {
  queuedRead = false;
  ownerEffectsStore.set({ status: "unknown", revoked: true, slots: unknownSlots(), error: "sign_in_changed" });
}
function unknown(error) { const n = clock(); failedAt = n === null ? Infinity : n; ownerEffectsStore.set({ status: "unknown", slots: unknownSlots(), error }); }
function claim() {
  if (!eligible() || active) return null;
  const controller = new AbortController(), op = { controller, generation };
  active = op; ownerEffectsStore.set({ busy: true, error: null }); return op;
}
async function call(op, path, init = {}) {
  const started = clock();
  if (started === null || op.controller.signal.aborted) return { ok: false, status: 0, body: null };
  const timer = setTimeout(() => op.controller.abort(), 10000);
  try {
    const res = await fetch(path, { credentials: "same-origin", ...init, signal: op.controller.signal });
    let body = null; try { body = await res.json(); } catch { /* unknown */ }
    const ended = clock();
    if (op.controller.signal.aborted || ended === null || ended < started || ended - started >= 10000) return { ok: false, status: 0, body: null };
    return { ok: res.ok, status: res.status, body };
  } catch { return { ok: false, status: 0, body: null }; }
  finally { clearTimeout(timer); }
}
function finish(op) {
  if (active !== op) return;
  active = null; ownerEffectsStore.set({ busy: false });
  const again = queuedRead; queuedRead = false;
  const n = clock();
  if (again && eligible() && n !== null && n - failedAt >= 5000) refreshOwnerEffects();
}
/** An owner response is closed and bounded. Unavailable means a stored id, not an empty slot or private manifest. */
export function checkOwnerSlots(body) { return checkEffectOwnerSlots(body); }

async function read(op) {
  const r = await call(op, `/ui/effects/owner?ownerEpoch=${owner.epoch}`);
  if (!current(op)) return false;
  if ([401, 403, 409].includes(r.status)) { revoke(); return false; }
  const data = r.ok ? checkOwnerSlots(r.body) : null;
  if (!data) { unknown("unreadable"); return false; }
  if (data.rev < rev) { unknown("stale"); return false; }
  rev = data.rev; failedAt = -Infinity;
  ownerEffectsStore.set({ status: "known", slots: data.slots, error: null }); return true;
}
export async function refreshOwnerEffects() {
  if (!eligible()) return false;
  if (active) { queuedRead = true; return false; }
  const op = claim(); if (!op) return false;
  try { return await read(op); } finally { finish(op); }
}
/** One physical operation survives until settlement, including after abort. At most one coalesced read follows. */
export function watchOwnerEffects() {
  watchers++;
  if (watchers === 1 && eligible()) {
    const check = () => {
      const next = appStore.get().prefsRev, n = clock();
      if (next !== seen || ownerEffectsStore.get().status === "unknown" && n !== null && n - failedAt >= 5000) { seen = next; refreshOwnerEffects(); }
    };
    unsubscribe = appStore.subscribe(check); check();
  }
  let ended = false;
  return () => {
    if (ended) return; ended = true;
    if (--watchers > 0) return;
    generation++; queuedRead = false; unsubscribe?.(); unsubscribe = null; active?.controller.abort();
    ownerEffectsStore.set({ status: "unknown", slots: unknownSlots(), error: null });
  };
}
export async function saveOwnerEffects(set) {
  if (!plain(set) || !Object.keys(set).length || Object.keys(set).some(k => !KEYS.includes(k) || set[k] !== null && (typeof set[k] !== "string" || !ID.test(set[k])))) return { ok: false, error: "invalid" };
  // Snapshot both data and immutable boot context before the first wait. No optimistic runtime selection.
  const values = { ...set }, op = claim(); if (!op) return { ok: false, error: "busy_or_unavailable" };
  let saved = false;
  try {
    const r = await call(op, "/ui/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ set: values, ownerEpoch: owner.epoch }) });
    if (!current(op)) return { ok: false, error: "superseded" };
    if ([401, 403, 409].includes(r.status)) { revoke(); return { ok: false, error: "sign_in_changed" }; }
    if (r.ok && plain(r.body) && (r.body.ownerEpoch !== owner.epoch || r.body.ownerScope !== owner.scope)) { revoke(); return { ok: false, error: "sign_in_changed" }; }
    if (!r.ok || !plain(r.body) || !plain(r.body.values) || !Number.isSafeInteger(r.body.rev) || r.body.rev < 0 || r.body.rev < rev || r.body.unreadable) { unknown("not_saved"); return { ok: false, error: "not_saved" }; }
    if (!Object.entries(values).every(([k, v]) => v === null ? !own(r.body.values, k) : r.body.values[k] === v)) { unknown("not_saved"); return { ok: false, error: "not_saved" }; }
    saved = true;
    const refreshed = await read(op); return { ok: refreshed, saved, error: refreshed ? null : "refresh_failed" };
  } finally { finish(op); }
}
/** Runtime adapter asks only for the exact, currently known selection; a cursor can never request Worker source. */
export function ownerEffectUrl(key, id, kind = "resource") {
  const row = ownerEffectsStore.get().slots[key];
  if (!eligible() || ownerEffectsStore.get().status !== "known" || !KEYS.includes(key) || !row || row.status !== "available" || row.id !== id || !["resource", "poster", "cursor"].includes(kind) || kind === "resource" && key === "fx.cursor") return null;
  const path = kind === "resource" ? `/ui/effects/resource/${id}` : `/ui/effects/image/${id}/${kind}.png`;
  return `${path}?slot=${encodeURIComponent(key)}&ownerEpoch=${owner.epoch}`;
}
export function markOwnerEffectUnavailable(key, id) {
  const s = ownerEffectsStore.get(), row = s.slots[key];
  if (!eligible() || s.status !== "known" || !KEYS.includes(key) || row?.id !== id) return;
  ownerEffectsStore.set({ slots: { ...s.slots, [key]: { status: "unavailable", id } } });
}
