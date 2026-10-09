// #1408 step 3 + #1423: a Settings write an admin has to confirm. Changing access lists, secrets, connections, public
// exposure or control-bearing instance settings answers 202 { result: "pending_confirmation", pending_change } instead
// of applying; a fleet admin confirms the redacted diff in chat (or on the host: `agend settings confirm <id>`).
//
// This module is the page's one record of those requests, whatever panel made them (Settings, Fleet's config, Chat's
// delete, New instance). It lives as long as the page (ES module state), not as long as a panel: a request keeps being
// followed after Settings unmounts, and the shell shows it in any panel (appStore.pendingChanges, app-shell.js).
//
// Following one is a passive read (GET /api/settings/pending/:id is on the #1374 passive list and the public link's
// manifest): one request at a time, every POLL_MS while anything is open, nothing while nothing is. The countdown is
// the server's remaining_ms against a monotonic clock, never the display timestamp.
import { appStore } from "/assets/app-store.js";

const POLL_MS = 2000;
const SHOW_DONE_MS = 4000;                       // an applied request stays on screen this long, then goes
const TERMINAL = new Set(["applied", "rejected", "expired", "stale", "failed"]);
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** A key for one request, reused by every retry of it: a retry with the same key and body is the same request. */
export function newKey(prefix = "k") {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** fetch → { ok, status, body } (body null when it is not JSON). A network failure throws, as fetch does. */
export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(path, { ...opts, headers });
  let body = null;
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

/** The 202 that means "waiting for an admin", not "done". */
export function isPendingResponse(res) {
  return !!res && res.status === 202 && !!res.body && res.body.result === "pending_confirmation" && !!res.body.pending_change?.id;
}

const tracked = new Map();                       // id → { view, at, label, waiters, done }
let timer = null, polling = false;

function publish() {
  appStore.set({
    pendingChanges: [...tracked.values()].map(({ view, at, label }) => ({
      ...view,
      label: label || null,
      // Monotonic: when the server's countdown reaches zero on this page's clock.
      deadline: at + Math.max(0, Number(view.remaining_ms) || 0),
      withdraw: view.can_withdraw && view.state === "pending" ? () => withdraw(view.id) : null,
      dismiss: TERMINAL.has(view.state) ? () => forget(view.id) : null,
    })),
  });
}

function forget(id) {
  const e = tracked.get(id);
  if (!e) return;
  if (e.doneTimer) clearTimeout(e.doneTimer);
  tracked.delete(id);
  publish();
}

function update(view) {
  const e = tracked.get(view.id);
  if (!e) return;
  e.view = view; e.at = now();
  if (TERMINAL.has(view.state) && !e.done) {
    e.done = true;
    for (const resolve of e.waiters.splice(0)) resolve(view);
    // A request that applied goes away by itself; one that did not stays until it is dismissed, so it is read.
    if (view.state === "applied") e.doneTimer = setTimeout(() => forget(view.id), SHOW_DONE_MS);
  }
  publish();
}

function schedule() {
  if (timer || polling) return;
  if (![...tracked.values()].some(e => !e.done)) return;
  timer = setTimeout(poll, POLL_MS);
}

async function poll() {
  timer = null;
  polling = true;
  try {
    for (const e of [...tracked.values()]) {
      if (e.done) continue;
      let res;
      try { res = await api(`/api/settings/pending/${encodeURIComponent(e.view.id)}`); } catch { continue; }   // offline: next round
      if (res.ok && res.body && res.body.id) update(res.body);
      // 404: no longer this session's, or aged out of the store. Either way it will not apply now.
      else if (res.status === 404) update({ ...e.view, state: "expired", can_withdraw: false,
        outcome: { state: "expired", reason_code: "not_found", message: "" } });
    }
  } finally { polling = false; schedule(); }
}

/**
 * Follow a pending request until it is decided. Resolves with its final view (applied, rejected, expired, stale or
 * failed). The same id twice is followed once.
 */
export function track(view, label) {
  let e = tracked.get(view.id);
  if (!e) { e = { view, at: now(), label, waiters: [], done: false }; tracked.set(view.id, e); }
  else if (label && !e.label) e.label = label;
  const settled = e.done ? Promise.resolve(e.view) : new Promise((resolve) => e.waiters.push(resolve));
  update(view);
  schedule();
  return settled;
}

/** Withdraw a request nobody has decided yet. The view it answers with is the truth (decided meanwhile, or not). */
export async function withdraw(id) {
  let res;
  try { res = await api(`/api/settings/pending/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch { return false; }
  if (res.ok && res.body && res.body.id) { update(res.body); return true; }
  return false;
}

/** This session's requests still open on the server (after a reload): followed like new ones. */
export async function attach() {
  let res;
  try { res = await api("/api/settings/pending"); } catch { return; }
  if (!res.ok || !Array.isArray(res.body)) return;
  for (const view of res.body) if (view && view.id && !TERMINAL.has(view.state)) track(view);
}

/**
 * A write that may need confirmation. A 202 pending_confirmation is followed until decided and answered as the write
 * itself would have been: applied → { ok: true, body: what the write answered }, anything else → { ok: false } with
 * the reason. Every other answer is returned as it is. `key` is the request's Idempotency-Key: pass the same one to
 * retry the same request. `onPending(id)` is told when it starts waiting.
 */
export async function confirmedWrite(path, { method = "POST", body, key = newKey("w"), label, headers, onPending } = {}) {
  const res = await api(path, { method, headers: { ...(headers || {}), "Idempotency-Key": key }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!isPendingResponse(res)) return res;
  if (onPending) onPending(res.body.pending_change.id);
  const final = await track(res.body.pending_change, label);
  return outcomeResponse(final);
}

/** A decided request as the write's own answer. */
export function outcomeResponse(view) {
  if (view.state === "applied") return { ok: true, status: 200, body: (view.outcome && view.outcome.result) || {}, confirmed: view };
  const reason = (view.outcome && (view.outcome.message || view.outcome.reason_code)) || view.state;
  return { ok: false, status: 409, body: { error: reason, pending_state: view.state }, confirmed: view };
}

/** For tests: forget everything and stop following. */
export function resetConfirmations() {
  for (const e of tracked.values()) if (e.doneTimer) clearTimeout(e.doneTimer);
  tracked.clear();
  if (timer) { clearTimeout(timer); timer = null; }
  appStore.set({ pendingChanges: [] });
}
