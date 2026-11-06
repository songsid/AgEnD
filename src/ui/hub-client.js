// AgEnD Hub P1, slice 3 (fleet decision 7e5b8a8f; docs/design/hub.md; docs/design/hub-ui-client.md): the one seam
// between the Hub's web UI and its data. Every Hub page and card (the Hub shell's panels, the member's switcher and
// "Connect to a Hub") reads and writes through this client — nothing else. Its objects are UI PROJECTIONS
// (HubPairingView, HubExposureView), never the signed protocol/model records of hub.md.
//
// Until slice 1 lands it is a STUB held in this page's memory, shaped as the real answers will be. Re-pointing it at the
// authenticated member/Hub APIs replaces `createStubClient` (and drops its `control`); the pages do not change. The
// browser never holds the machine credential or sees wire frames: the real client reads local projections only.
//
// Off is the default: the server marks the page (data-hub) only when a switch is on, and nothing here is ever loaded
// otherwise (app-shell.js and panel-settings.js import the Hub modules only when the mark is present).
import { appStore } from "/assets/app-store.js";

/** The page's Hub marks (presentation only — a mark confers no authority): { hub, member }. */
export function hubMarks(doc = typeof document !== "undefined" ? document : null) {
  const tokens = String((doc && doc.body && doc.body.dataset && doc.body.dataset.hub) || "").split(/\s+/);
  return { hub: tokens.includes("hub"), member: tokens.includes("member") };
}
/** The Hub's operator-chosen name (Hub shell only), from the server's mark; "" when none. */
export function hubName(doc = typeof document !== "undefined" ? document : null) {
  const v = doc && doc.body && doc.body.dataset ? doc.body.dataset.hubName : "";
  return typeof v === "string" ? v.trim().slice(0, 60) : "";
}

/**
 * A fingerprint as the page shows it: `digest` is the full SHA-256 (64 hex); people compare at least its first 128 bits
 * (32 hex, 8 groups of 4) and can open the whole. `kind` says what it binds — never compare one kind with another:
 * - "pairing": the whole pairing transcript of this attempt (hub.md §2 step 4), shown while it is pending;
 * - "hub-key": the Hub identity/key this fleet approved (paired), or the one the Hub now offers (key_changed).
 * @typedef {{ kind: "pairing" | "hub-key", digest: string }} HubFingerprintView
 */
/**
 * Pairing, as the member's page sees it (a projection of S1's local status):
 * - { state: "unpaired" }
 * - { state: "pending", memberOrigin, fingerprint (pairing), expiresAt, localConfirmed, ownerConfirmed, adminApproved }
 *     localConfirmed: this fleet's owner compared and confirmed the fingerprint here (confirmFingerprint);
 *     both Hub confirmations are needed: the owner's from a current Hub directory session, the Hub administrator's
 *     approval of this exact fingerprint — possession of the code proves neither. On a member they are null (unknown:
 *     S1 keeps neither; never derived from the local approval or a claim answer); true/false only from a trusted Hub
 *     status projection
 * - { state: "paired", hub: { hubId, name, memberOrigin, webOrigin, fingerprint (hub-key) }, link: "online" | "offline" }
 *     memberOrigin: the pinned transport origin; webOrigin: the separately approved browser origin (they may differ)
 * - { state: "key_changed", hub: {…approved, fingerprint (hub-key)}, offered (hub-key) }
 *     nothing connects; the offered value is never accepted automatically — re-pair or disconnect
 * - { state: "held", hold, memberOrigin? }
 *     a safety hold, visible: hold ∈ "unknown_outcome" | "expired" | "unsaved" | "refused" | "revoked" | "disconnected"
 *     — never shown as paired, never as a successful unpair ("unavailable": an older host, shown as one line, not a hold)
 * @typedef {object} HubPairingView
 */
/**
 * One of THIS fleet's agents (the local owner's own inventory — never the Hub's), as the exposure list shows it.
 * `agent` is the stable local agent name, never its label. `state` is the local consent; `revision` the exposure policy
 * revision the page shows (enabling refers to it: a stale tab gets "conflict", never a silent widening). `policy`
 * summarises what is shared: P1 shares the agent itself (`{ dataView: "agent", tools: [] }`,
 * docs/design/hub-representative-agent.md). `enforceable` false is never publishable; `reason: "republish_required"`
 * marks a mapping from the older restricted mode that answers nothing until the owner shares the agent again.
 * @typedef {{ agent: string, display: string, exposureId: string | null, revision: number,
 *   state: "published" | "withdrawn" | "frozen", policy: { dataView: string, tools: string[] } | null,
 *   enforceable: boolean, reason?: string }} HubExposureView
 */
/**
 * Results (docs/design/hub-ui-client.md "Results"). A withdrawal or disconnect fences locally at once (even offline) but
 * answers ok only once the local restrictive state is saved; `remote` is "pending" in P1 (S1 has no acknowledgement or
 * remote revoke), shown as a warning — "confirmed" is reserved.
 * @typedef {{ ok: true, pairing: HubPairingView } | { ok: false, error: "address" | "code" | "busy" | "unreachable" | "refused" }} HubConnectResult
 * @typedef {{ ok: true, view: HubExposureView } | { ok: true, pending: { expiresAt: number }, view: HubExposureView, settled: Promise<unknown> }
 *   | { ok: false, error: "not_paired" | "unknown_agent" | "unknown_view" | "not_enforceable" | "limit" | "conflict" | "unsaved" | "unavailable" }} HubPublishResult
 * @typedef {{ ok: true, remote: "confirmed" | "pending" } | { ok: false, error: "unsaved" | "conflict" | "unavailable" }} HubWithdrawResult
 */

/**
 * The client every Hub page uses (one per page): on a Hub's own workspace the Hub's /hub/v1/* API at this page's own
 * origin, with the Hub's session; on a member fleet's Settings card this fleet's /api/hub/member/*; in tests the stub.
 */
let client = null;
/**
 * The Settings confirmation (settings-confirm.js), loaded only when a member fleet's card first needs it — never
 * statically: a Hub's own listener serves only the Hub's three modules (src/hub/http/compose.ts HUB_UI_MODULES), so a
 * static import of a fleet Settings module left the Hub workspace unable to load at all.
 */
let confirmModule = null, confirmLoaded = null;
const loadConfirm = () => (confirmModule ??= import("./settings-confirm.js").then((m) => { confirmLoaded = m; return m; }, (e) => { confirmModule = null; throw e; }));
const lazyConfirm = {
  async api(path, opts) { return (await loadConfirm()).api(path, opts); },
  // Called before the first request goes out: the same key settings-confirm.js would make.
  newKey(prefix = "k") {
    if (confirmLoaded) return confirmLoaded.newKey(prefix);
    return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  },
  // Only ever asked of a response api() returned, so the module is loaded by then.
  isPendingResponse(r) { return confirmLoaded ? confirmLoaded.isPendingResponse(r) : false; },
  track(view, label) { return loadConfirm().then((m) => m.track(view, label)); },
};
export function hubClient() {
  // S3c: a member fleet's card uses this fleet's own endpoints (createMemberClient); the Hub workspace its own; tests the stub.
  return client ??= hubMarks().hub ? createHubWebClient() : hubMarks().member ? createMemberClient({ confirm: lazyConfirm })
    : createStubClient({ agents: () => (appStore.get().instances || []).filter((i) => i && i.name) });
}
/** For tests and the switch-over to slice 1: put another client in place (null: the stub again, fresh). */
export function setHubClient(next) { client = next; }

/** UX checks only (the server parses and canonicalizes): an https:// origin, and a code of the shape people type. */
export const ADDRESS_HINT = /^https:\/\/[^\s/?#@]+\/?$/i;
export const CODE_HINT = /^[A-Za-z0-9][A-Za-z0-9 -]{4,62}[A-Za-z0-9]$/;
/** The part of a fingerprint people compare: its first 32 hex digits (128 bits) in 8 groups of 4. */
export function compareGroups(digest) { return String(digest || "").replace(/[^0-9a-f]/gi, "").toLowerCase().slice(0, 32).replace(/(.{4})(?=.)/g, "$1 "); }
/** An origin the switcher may open: the approved webOrigin of a paired Hub, https only, nothing after the host. */
export function safeWebOrigin(pairing) {
  if (!pairing || pairing.state !== "paired" || !pairing.hub) return null;
  try {
    const u = new URL(String(pairing.hub.webOrigin || ""));
    return u.protocol === "https:" && !u.username && !u.password ? u.origin : null;
  } catch { return null; }
}

/**
 * The stub: deterministic answers in this page's memory (no request leaves the page). Its fingerprints are placeholders
 * — a real one binds the pairing transcript (S1) and is never derived from the address and code.
 */
export function createStubClient({ now = () => Date.now(), agents = () => [] } = {}) {
  let pairing = { state: "unpaired" };
  const consent = new Map();                // agent → { state, revision }
  let enforceable = new Set();
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) { try { fn(pairing); } catch { /* a listener's own failure */ } } };
  let seq = 0;
  const placeholder = () => { seq++; let s = ""; for (let i = 0; i < 64; i++) s += ((i * 7 + seq * 13) % 16).toString(16); return s; };
  const view = (a) => {
    const c = consent.get(a.name) || { state: "withdrawn", revision: 0 };
    const ok = enforceable.has(a.name);
    return { agent: a.name, display: a.display_name || a.name, exposureId: c.revision ? `stub-${a.name}` : null, revision: c.revision,
      state: c.state, policy: ok && c.state === "published" ? { dataView: c.dataView || "agent", tools: c.tools ? [...c.tools] : [] } : null, enforceable: ok, ...(ok ? {} : { reason: "restricted_execution_pending" }),
      // P1 representative agent: the one choice is the agent itself, with no Hub tools; no pending confirmation.
      choices: ok ? { dataViews: [{ id: "agent", label: a.display_name || a.name }], tools: [] } : { dataViews: [], tools: [] },
      pending: null };
  };
  const api = {
    stub: true,
    /** @returns {Promise<HubPairingView>} */
    async pairing() { return pairing; },
    /** @returns {Promise<HubConnectResult>} */
    async connect({ address, code }) {
      const a = String(address || "").trim(), c = String(code || "").trim();
      if (!ADDRESS_HINT.test(a)) return { ok: false, error: "address" };
      if (!CODE_HINT.test(c)) return { ok: false, error: "code" };
      if (pairing.state === "pending" || pairing.state === "paired") return { ok: false, error: "busy" };
      pairing = { state: "pending", memberOrigin: a.replace(/\/$/, ""), fingerprint: { kind: "pairing", digest: placeholder() },
        expiresAt: now() + 10 * 60_000, ownerConfirmed: false, adminApproved: false };
      emit();
      return { ok: true, pairing };
    },
    /** Withdraw a pending request (or clear a hold). */
    async cancel() { if (pairing.state === "pending" || pairing.state === "held") { pairing = { state: "unpaired" }; emit(); } return pairing; },
    /** Leave the Hub: every exposure is withdrawn with it. @returns {Promise<HubWithdrawResult>} */
    async disconnect() {
      const online = pairing.state === "paired" && pairing.link === "online";
      pairing = { state: "unpaired" };
      for (const [k, c] of consent) consent.set(k, { state: "withdrawn", revision: c.revision + 1 });
      emit();
      return { ok: true, remote: online ? "confirmed" : "pending" };
    },
    /** @returns {Promise<HubExposureView[]>} */
    async exposures() { return agents().map(view); },
    /**
     * Publish (on) or withdraw (off) one agent, against the revision the page showed.
     * @returns {Promise<HubPublishResult | HubWithdrawResult>}
     */
    async setExposed(agent, on, expectedRevision, choice = null) {
      const a = agents().find((x) => x.name === agent);
      if (!a) return { ok: false, error: "unknown_agent" };
      const c = consent.get(agent) || { state: "withdrawn", revision: 0 };
      if (expectedRevision !== c.revision) return { ok: false, error: "conflict" };
      if (!on) {
        consent.set(agent, { state: "withdrawn", revision: c.revision + 1 });
        return { ok: true, remote: pairing.state === "paired" && pairing.link === "online" ? "confirmed" : "pending" };
      }
      if (pairing.state !== "paired") return { ok: false, error: "not_paired" };
      if (!enforceable.has(agent)) return { ok: false, error: "not_enforceable" };
      consent.set(agent, { state: "published", revision: c.revision + 1, dataView: choice && choice.dataViewId, tools: choice && choice.tools });
      return { ok: true, view: view(a) };
    },
    /** Hear pairing changes (slice 1: the member's local status projections). @returns {() => void} */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** The stub's own controls (tests, smokes, a demo) — what the Hub, its administrator and the owner would do. */
    control: {
      ownerConfirmed() { if (pairing.state === "pending") { pairing = { ...pairing, ownerConfirmed: true }; emit(); } },
      approve({ name = "Team Hub", webOrigin } = {}) {
        if (pairing.state !== "pending") return;
        pairing = { state: "paired", hub: { hubId: "00000000-0000-4000-8000-000000000001", name, memberOrigin: pairing.memberOrigin,
          webOrigin: webOrigin || pairing.memberOrigin, fingerprint: { kind: "hub-key", digest: placeholder() } }, link: "online" };
        emit();
      },
      link(state) { if (pairing.state === "paired") { pairing = { ...pairing, link: state }; emit(); } },
      keyChanged() { if (pairing.state === "paired") { pairing = { state: "key_changed", hub: pairing.hub, offered: { kind: "hub-key", digest: placeholder() } }; emit(); } },
      hold(hold) { pairing = { state: "held", hold, ...(pairing.memberOrigin || pairing.hub ? { memberOrigin: pairing.memberOrigin || pairing.hub.memberOrigin } : {}) }; emit(); },
      enforceable(names) { enforceable = new Set(names); },
    },
  };
  return api;
}

/**
 * AgEnD Hub P1, slice 3b: the Hub workspace's client — /hub/v1/* on this page's own origin (the Hub's), with its own
 * session cookie (HttpOnly; this page never sees it) and the CSRF token /hub/v1/session gives a same-origin read.
 * Every answer is { ok: true, ...body } or { ok: false, status, code }; a 401 also tells the page the session ended.
 */
export function createHubWebClient({ fetchImpl = (...a) => fetch(...a) } = {}) {
  let csrf = null;
  const ended = new Set();
  async function call(method, path, body) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && csrf) headers["X-AgEnD-Hub-CSRF"] = csrf;
    let r;
    try { r = await fetchImpl(path, { method, headers, credentials: "same-origin", cache: "no-store", body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch { return { ok: false, status: 0, code: "unreachable" }; }
    let json = null;
    try { json = await r.json(); } catch { json = null; }
    if (r.status === 401) { csrf = null; for (const fn of ended) { try { fn(); } catch { /* a listener's own failure */ } } }
    if (!r.ok) return { ok: false, status: r.status, code: (json && typeof json.code === "string" && json.code) || "failed", retryAfter: Number(r.headers.get("Retry-After")) || 0 };
    return { ok: true, ...(json && typeof json === "object" ? json : {}) };
  }
  const id = (v) => encodeURIComponent(String(v));
  return {
    stub: false, web: true,
    /** Hear the session end (a 401 anywhere). @returns {() => void} */
    onSignedOut(fn) { ended.add(fn); return () => ended.delete(fn); },
    async session() { const r = await call("GET", "/hub/v1/session"); if (r.ok) csrf = r.signedIn ? r.csrf || null : null; return r; },
    async signIn(login, password) { const r = await call("POST", "/hub/v1/session", { login, password }); if (r.ok) csrf = r.csrf || null; return r; },
    async signOut() { const r = await call("DELETE", "/hub/v1/session"); csrf = null; return r; },
    catalog() { return call("GET", "/hub/v1/exposures"); },
    grant(input) { return call("POST", "/hub/v1/grants", input); },
    revokeGrant(grantId, revision) { return call("DELETE", `/hub/v1/grants/${id(grantId)}?revision=${id(revision)}`); },
    activity(exposureId) { return call("GET", `/hub/v1/exposures/${id(exposureId)}/activity`); },
    freeze(exposureId, revision, admin = false) { return call("POST", `/hub/v1/${admin ? "admin/" : ""}exposures/${id(exposureId)}/freeze`, { revision }); },
    quotaVisibility(exposureId, revision, visible) { return call("POST", `/hub/v1/exposures/${id(exposureId)}/quota`, { revision, visible }); },
    rooms() { return call("GET", "/hub/v1/rooms"); },
    openRoom(exposureId, grantId) { return call("POST", "/hub/v1/rooms", { exposureId, grantId }); },
    /** #3226 D2: this client carries files (ask sends `extras.files`; upload exists); hub-attachments checks the mark. */
    filesV1: true,
    /** #3226 D: `extras.files` names the asker's own uploads in this room (only on a room whose features take files). */
    ask(roomId, idempotencyKey, text, extras = {}) {
      return call("POST", `/hub/v1/rooms/${id(roomId)}/messages`, { idempotencyKey, text, ...(Array.isArray(extras.files) && extras.files.length ? { files: extras.files } : {}) });
    },
    /** #3226 D: one file for a later question in this room, sent as is (the server types it by its name, images by
     * their bytes). → { ok: true, file: { id, name, size, mime, url } } or { ok: false, status, code }. */
    async upload(roomId, file) {
      const headers = { Accept: "application/json", "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(String(file && file.name || "")) };
      if (csrf) headers["X-AgEnD-Hub-CSRF"] = csrf;
      let r;
      try { r = await fetchImpl(`/hub/v1/rooms/${id(roomId)}/files`, { method: "POST", headers, credentials: "same-origin", cache: "no-store", body: file }); }
      catch { return { ok: false, status: 0, code: "unreachable" }; }
      let json = null;
      try { json = await r.json(); } catch { json = null; }
      if (r.status === 401) { csrf = null; for (const fn of ended) { try { fn(); } catch { /* a listener's own failure */ } } }
      if (!r.ok) return { ok: false, status: r.status, code: (json && typeof json.code === "string" && json.code) || "failed" };
      return { ok: true, ...(json && typeof json === "object" ? json : {}) };
    },
    read(roomId, after = 0) { return call("GET", `/hub/v1/rooms/${id(roomId)}/messages?after=${id(after)}`); },
    chooseButtons(roomId, input) { return call("POST", `/hub/v1/rooms/${id(roomId)}/buttons`, input); },
    pairings() { return call("GET", "/hub/v1/pairings"); },
    confirmPairing(pairingId, fingerprint) { return call("POST", `/hub/v1/pairings/${id(pairingId)}/confirm`, { fingerprint }); },
    adminOverview() { return call("GET", "/hub/v1/admin/overview"); },
    createPairing(login) { return call("POST", "/hub/v1/admin/pairings", { login }); },
    approvePairing(pairingId, fingerprint) { return call("POST", `/hub/v1/admin/pairings/${id(pairingId)}/approve`, { fingerprint }); },
    revokeFleet(fleetId) { return call("POST", `/hub/v1/admin/fleets/${id(fleetId)}/revoke`); },
  };
}

/**
 * S3c (S-55): the member fleet's client — this fleet's own endpoints (/api/hub/member/*, local admin only, never the
 * public link). Exposures: the list; publish/revise through the Settings confirmation (a 202 is "waiting for your
 * confirmation": `pending` and `settled`, a promise of the decision); withdraw at once (ok once saved; remote
 * "pending": the Hub learns it with the next snapshot). An older host (404): { ok: false, error: "unavailable" }.
 * `confirm` is settings-confirm.js (loaded with the card): { api, isPendingResponse, track, newKey }.
 */
export function createMemberClient({ confirm, pollMs = 5000, doc = typeof document !== "undefined" ? document : null, timers = globalThis }) {
  const listed = async () => {
    const r = await confirm.api("/api/hub/member/exposures");
    return r.ok && r.body && Array.isArray(r.body.exposures) ? r.body.exposures : r.status === 404 ? null : [];
  };
  const fail = (r) => ({ ok: false, error: r.status === 404 ? "unavailable" : (r.body && typeof r.body.error === "string" ? r.body.error : "unsaved") });
  // Pairing (S3c PR B): GET the projection; connect / confirm / disconnect go through the Settings confirmation (a 202:
  // "sent for confirmation", followed in the background; the poll shows the result); cancel at once.
  const pairingNow = async () => {
    const r = await confirm.api("/api/hub/member/pairing");
    if (r.ok && r.body && r.body.pairing) return r.body.pairing;
    return { state: "held", hold: r.status === 404 ? "unavailable" : "unsaved" };
  };
  const step = async (name, body) => {
    const r = await confirm.api(`/api/hub/member/pairing/${name}`, { method: "POST", headers: { "Idempotency-Key": confirm.newKey("hub") }, body: JSON.stringify(body || {}) });
    if (confirm.isPendingResponse(r)) { void Promise.resolve(confirm.track(r.body.pending_change, "hub")).catch(() => {}); return { ok: true, pendingConfirmation: true, pairing: await pairingNow() }; }
    if (r.status === 404) return { ok: false, error: "unavailable" };
    return r.body && typeof r.body === "object" ? r.body : { ok: false, error: "unsaved" };
  };
  const listeners = new Set();
  let timer = null, inFlight = false;
  const tick = async () => {
    timer = null;
    if (!listeners.size) return;
    if (!(doc && doc.hidden) && !inFlight) {
      inFlight = true;
      try { const p = await pairingNow(); for (const fn of listeners) { try { fn(p); } catch { /* a listener's own failure */ } } } catch { /* the next tick */ }
      finally { inFlight = false; }
    }
    if (listeners.size) timer = timers.setTimeout(tick, pollMs);
  };
  return {
    stub: false, member: true,
    pairing: pairingNow,
    async connect({ address, code }) {
      const a = String(address || "").trim(), c = String(code || "").trim();
      if (!ADDRESS_HINT.test(a)) return { ok: false, error: "address" };
      if (!CODE_HINT.test(c)) return { ok: false, error: "code" };
      return step("connect", { address: a, code: c });
    },
    confirmFingerprint(digest) { return step("confirm", { digest }); },
    /** `shown`: the pairing the page showed when the person chose Disconnect (never re-read after their dialog). */
    async disconnect(shown) {
      // #3115 r2: exactly the pairing shown — its hub and bindingId; the server refuses any other (a replacement, a re-pair).
      const hubId = shown && (shown.hub ? shown.hub.hubId : shown.hubId), binding = shown && shown.binding;
      if (!hubId || !binding) return { ok: false, error: "conflict" };
      const r = await step("disconnect", { hubId, binding }); return r.ok ? { ok: true, remote: "pending", ...(r.pendingConfirmation ? { pendingConfirmation: true } : {}) } : { ok: false, error: r.error === "unsaved" ? "unsaved" : "conflict" }; },
    async cancel() { const r = await confirm.api("/api/hub/member/pairing/cancel", { method: "POST", body: "{}" }); return r.ok && r.body && r.body.pairing ? r.body.pairing : pairingNow(); },
    /** The local status, every pollMs while visible (one request at a time; none while hidden); stops with the last listener. */
    subscribe(fn) { listeners.add(fn); if (!timer) timer = timers.setTimeout(tick, pollMs); return () => { listeners.delete(fn); if (!listeners.size && timer) { timers.clearTimeout(timer); timer = null; } }; },
    async exposures() { const rows = await listed(); return rows || []; },
    async setExposed(agent, on, expectedRevision, choice = null) {
      const rows = await listed();
      if (rows === null) return { ok: false, error: "unavailable" };
      const row = rows.find((x) => x.agent === agent);
      if (!row) return { ok: false, error: "unknown_agent" };
      if (!on) {
        if (!row.exposureId) return { ok: false, error: "conflict" };
        const r = await confirm.api(`/api/hub/member/exposures/${encodeURIComponent(row.exposureId)}/withdraw`, { method: "POST", body: JSON.stringify({ expectedRevision }) });
        return r.ok && r.body && r.body.ok ? { ok: true, remote: r.body.remote === "confirmed" ? "confirmed" : "pending" } : fail(r);
      }
      if (!choice || typeof choice.dataViewId !== "string" || !Array.isArray(choice.tools)) return { ok: false, error: "not_enforceable" };
      const r = await confirm.api("/api/hub/member/exposures", { method: "POST", headers: { "Idempotency-Key": confirm.newKey("hub") },
        body: JSON.stringify({ agent, dataViewId: choice.dataViewId, tools: choice.tools, expectedRevision }) });
      if (confirm.isPendingResponse(r)) {
        const p = r.body.pending_change;
        return { ok: true, pending: { expiresAt: p.expires_at }, view: { ...row, pending: { expiresAt: p.expires_at } }, settled: confirm.track(p, "hub") };
      }
      return r.ok && r.body && r.body.ok ? { ok: true, view: r.body.view } : fail(r);
    },
  };
}
