// M-3339 (A2): the web client of the contact authorization API (src/contact-auth-types.ts; docs/design/
// classic-contact-authorizations.md). Same-origin fetch: the page's sign-in and write protection are added by the shell
// (agend-auth.js). The server resolves who is asking; nothing here sends an identity as authority.
// Every result is { ok: true, data } or { ok: false, status, code } — code: on 409 the server's own reason ("conflict":
// someone changed it first, read it again; "expired"; "already-decided"), "forbidden" (403), "unavailable" (503), "missing"
// (404), "invalid-approver" (400: an approver who isn't eligible — a Fleet admin or the verified host operator, for now) or
// "failed" (anything else, a network error included).

const CONFLICTS = new Set(["conflict", "expired", "already-decided"]);
const codeOf = (status) => (status === 409 ? "conflict" : status === 403 ? "forbidden" : status === 503 ? "unavailable" : status === 404 ? "missing" : "failed");

async function call(method, url, body) {
  let r;
  try {
    r = await fetch(url, { method, credentials: "same-origin", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  } catch { return { ok: false, status: 0, code: "failed" }; }
  if (!r.ok) {
    let code = codeOf(r.status);
    if (r.status === 409 || r.status === 400 || r.status === 403) {
      try { const b = await r.json(); const c = b && (b.code || b.error); if (CONFLICTS.has(c) || c === "invalid-approver" || c === "verification-required") code = c;
        else if (c === "Write rejected — missing or wrong CSRF token (reload the page)") code = "csrf";
        else if (c === "Cross-site request rejected") code = "cross-site"; } catch { /* no body: the status's own code */ }
    }
    return { ok: false, status: r.status, code };
  }
  try { return { ok: true, data: await r.json() }; } catch { return { ok: false, status: r.status, code: "failed" }; }
}

const enc = encodeURIComponent;
/** ContactPermissions of one agent (a ClassicBot room's or a worker's). */
export const getPermissions = (name) => call("GET", `/ui/api/instances/${enc(name)}/contact-permissions`);
/** ContactPermissionsWrite (with the revision read) → ContactPermissions. */
export const putPermissions = (name, write) => call("PUT", `/ui/api/instances/${enc(name)}/contact-permissions`, write);
/** Explicit administrator override; never accepts a client-supplied origin/person. */
export const clearOrigin = (name, snapshot) => call("POST", `/ui/api/instances/${enc(name)}/contact-permissions/origin-clear`, snapshot);
/** ContactTicketPage: { items, nextCursor }; filters: status, agent, person (an exact server identity key), cursor. */
export function listTickets(filters = {}) {
  const q = new URLSearchParams();
  for (const k of ["status", "agent", "person", "cursor"]) if (filters[k]) q.set(k, String(filters[k]));
  const s = q.toString();
  return call("GET", `/ui/api/contact-authorizations${s ? `?${s}` : ""}`);
}
export const getTicket = (id) => call("GET", `/ui/api/contact-authorizations/${enc(id)}`);
/** ContactTicketDecision (with the ticket's revision) → ContactTicket. */
export const decideTicket = (id, decision) => call("POST", `/ui/api/contact-authorizations/${enc(id)}/decision`, decision);

/** A request's id as people read it: the server's ids are R + a UUID — shown as R + its first 8 hex digits (links keep it whole). */
export const shortTicketId = (id) => { const s = String(id || ""); return /^R[a-f0-9]{8}-[a-f0-9-]{27}$/.test(s) ? s.slice(0, 9) : s; };

/** A person's whole server identity as the server's canonical key — JSON of [platform, userId] (ids may hold any
 * punctuation) — what the person filter takes; never a name. */
export const personKey = (p) => (p ? JSON.stringify([p.platform, p.userId]) : "");

/** Reminder dismissal only; never a contact approval or a permissions write. */
export const dismissSuggestion = (id) => call("POST", "/ui/needs/ack", { id });
