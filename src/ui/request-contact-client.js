// M-3736 J (S-228; slice I's contract: docs/design/request-contact-same-card-api.md, version 1): the web client of the
// same-card contact API, /ui/api/request-contact-authorizations. A module of its own (the module-skew rule): the older
// contact-auth-client.js keeps serving the old namespace while the new host is not installed.
// Same-origin fetch: the page's sign-in and write protection are added by the shell. The server resolves who is asking;
// nothing here sends an identity, a person or an engine as authority.
// Every result is { ok: true, data } or { ok: false, status, code }. `code` is the server's stable error
// ({ error: <code> }) when it is one this page words, else the status's own: 401 sign-in-required, 403 forbidden,
// 404 not-found, 409 conflict, 503 unavailable, anything else (a network error included) failed.
// A decision is never retried here, after any failure or an unknown network outcome: the caller reads the same card.

const BASE = "/ui/api/request-contact-authorizations";
/** The stable error codes the contract lists (§3). */
export const RC_CODES = new Set(["invalid-request", "invalid-grant", "sign-in-required", "forbidden", "verification-required", "not-found",
  "conflict", "policy-conflict", "operation-conflict", "expired", "already-decided", "stale-generation", "unavailable"]);
/** The 409s that mean "it was decided or changed elsewhere": read the same card again and show its outcome. */
export const RC_REREAD = new Set(["conflict", "policy-conflict", "operation-conflict", "expired", "already-decided", "stale-generation"]);
const byStatus = (s) => (s === 401 ? "sign-in-required" : s === 403 ? "forbidden" : s === 404 ? "not-found" : s === 409 ? "conflict" : s === 503 ? "unavailable" : s === 400 ? "invalid-request" : "failed");
/** A ticket id as the server makes them: R + a UUID. Anything else is never put in a path. */
export const RC_ID = /^R[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function call(method, url, body) {
  let r;
  try {
    r = await fetch(url, { method, credentials: "same-origin", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  } catch { return { ok: false, status: 0, code: "failed" }; }
  if (!r.ok) {
    let code = byStatus(r.status);
    try { const b = await r.json(); const c = b && b.error; if (typeof c === "string" && RC_CODES.has(c)) code = c; } catch { /* no body: the status's own code */ }
    return { ok: false, status: r.status, code };
  }
  try { return { ok: true, data: await r.json() }; } catch { return { ok: false, status: r.status, code: "failed" }; }
}

/** RequestContactCardPageV1 { version, items, nextCursor }; filters: agent, status ("pending" by default on the server), cursor. */
export function listCards(filters = {}) {
  const q = new URLSearchParams();
  for (const k of ["agent", "status", "cursor"]) if (filters[k]) q.set(k, String(filters[k]));
  const s = q.toString();
  return call("GET", `${BASE}${s ? `?${s}` : ""}`);
}
/** One RequestContactCardV1. */
export const getCard = (id) => (RC_ID.test(String(id)) ? call("GET", `${BASE}/${id}`) : Promise.resolve({ ok: false, status: 404, code: "not-found" }));
/**
 * A decision on the card the person saw: its snapshot exactly as read, "approve-once" or "decline", and for Always allow
 * the existing strict grant object (personKeys only from the card's grantCandidates). 200 → the fresh card.
 */
export function decideCard(card, decision, grant) {
  if (!card || !RC_ID.test(String(card.ticket && card.ticket.id))) return Promise.resolve({ ok: false, status: 400, code: "invalid-request" });
  const s = card.snapshot || {};
  return call("POST", `${BASE}/${card.ticket.id}/decision`, {
    snapshot: { ticketRevision: s.ticketRevision, policyRevision: s.policyRevision, imageSha256: s.imageSha256 },
    decision, ...(grant ? { grant } : {}),
  });
}

/**
 * Is the same-card host installed here? Read once per page load, from the collection (Sentinel, #4492): 200 → "on" (the
 * V1 card everywhere; each card's own approvalScope says what a decision covers), 404 → "off" (the dormant host, no
 * inventory: today's cards). Anything else — 401, 403, 503, a network failure — is "unknown": never a reason to fall back
 * to today's less-scoped reads; the page says why and asks again later (it is not remembered).
 */
let state = null, lastCode = null, asking = null;
export function sameCardState() {
  if (state) return Promise.resolve(state);
  asking ??= (async () => {
    let r = null;
    try { r = await fetch(`${BASE}?status=pending`, { credentials: "same-origin" }); } catch { r = null; }
    finally { asking = null; }
    if (r && r.ok) { state = "on"; return state; }
    if (r && r.status === 404) { state = "off"; return state; }
    lastCode = r ? byStatus(r.status) : "failed";
    try { const b = r ? await r.json() : null; if (b && typeof b.error === "string" && RC_CODES.has(b.error)) lastCode = b.error; } catch { /* the status's own code */ }
    return "unknown";
  })();
  return asking;
}
/** Why the last answer was "unknown" (a stable code: sign-in-required, forbidden, verification-required, unavailable, failed…). */
export const sameCardUnknownCode = () => lastCode;
/** Tests, and a page that learns the host changed (a reload does the same). */
export function resetSameCardActive() { state = null; lastCode = null; asking = null; }
