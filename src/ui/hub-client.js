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
 *     a safety hold, visible: hold ∈ "unknown_outcome" | "expired" | "unsaved" | "refused" | "revoked" | "rejected" | "disconnected"
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
/** The session feature a Hub with rooms (seam 1) lists. */
export const ROOMS_FEATURE = "rooms-v1";
export const TEAMS_FEATURE = "teams-v1";
/** The live stream's events (seam 1). */
/**
 * The live stream's events (seam 1, as agreed with Lumen): message.added / message.updated { roomId, message, parent?:
 * { id, ask } } (a reply that changes its question's counts carries them), presence.changed { roomId, memberId, presence,
 * presenceNote? }, member.changed { roomId } (joined, left, role: read the room again), room.changed { roomId, room } or
 * { roomId, removed: true } (no longer a member: drop it), unread.changed { roomId, unread }, invitation.changed {}.
 */
export const ROOM_EVENTS = Object.freeze(["message.added", "message.updated", "presence.changed", "member.changed", "room.changed", "unread.changed", "invitation.changed"]);
/**
 * Today's room (one asker, one agent; GET /hub/v1/rooms before ROOMS_FEATURE) in the rooms list's shape: a direct room
 * named after its agent, the old item kept under `legacy` (its state, its agent's state, its grant's end, its features),
 * and `limited: true`: that Hub has no members, presence or unread, so the page leaves those controls out.
 */
export function legacyRoom(item) {
  if (!item || typeof item !== "object" || typeof item.id !== "string") return null;
  return { id: item.id, kind: "direct", name: String(item.exposureName || ""), people: 1, agents: 1, online: null, unread: 0,
    lastAt: Number.isFinite(item.lastAt) ? item.lastAt : 0, lastText: "", lastAuthor: "",
    agent: { exposureId: String(item.exposureId || ""), owner: { name: String(item.ownerName || "") }, presence: null }, limited: true, legacy: item };
}
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
export function createHubWebClient({ fetchImpl = (...a) => fetch(...a), readTimeoutMs = 120_000 } = {}) {
  // The factory override is for owned transports/rehearsals; the page uses the finite default.
  const readBudget = Number.isInteger(readTimeoutMs) && readTimeoutMs > 0 && readTimeoutMs <= 300_000 ? readTimeoutMs : 120_000;
  let csrf = null, codeNotices = false, roomsLive = false, teamsLive = false, generation = 0;
  const ended = new Set(), pendingReads = new Map(), waits = new Set(), readControllers = new Set();
  let readTail = Promise.resolve();
  const retired = () => ({ ok: false, status: 401, code: "unauthenticated" });
  const unreachable = () => ({ ok: false, status: 0, code: "unreachable" });
  const retireReads = () => {
    generation++; pendingReads.clear();
    for (const controller of readControllers) controller.abort();
    for (const wake of waits) wake();
  };
  const pause = (ms, signal) => new Promise(resolve => {
    const wake = () => { clearTimeout(timer); waits.delete(wake); signal.removeEventListener("abort", wake); resolve(); };
    const timer = setTimeout(wake, ms); waits.add(wake); signal.addEventListener("abort", wake, { once: true });
    if (signal.aborted) wake();
  });
  // Private reads share fresh directory eligibility admission. Only simultaneous signal-less GETs coalesce;
  // a caller-owned signal stays independent. No successful-response cache and no automatic write replay.
  function call(method, path, body, signal) {
    if (method !== "GET") { pendingReads.clear(); return request(method, path, body, signal); }
    if (!signal && pendingReads.has(path)) return pendingReads.get(path);
    const mine = generation, controller = new AbortController();
    let timedOut = false;
    readControllers.add(controller);
    const aborted = () => mine !== generation ? retired() : { ...unreachable(), ...(timedOut ? { timedOut: true } : {}) };
    let stop;
    const stopped = new Promise(resolve => { stop = () => resolve(aborted()); controller.signal.addEventListener("abort", stop, { once: true }); });
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        if (mine !== generation) return retired();
        if (controller.signal.aborted) return aborted();
        // Budget begins when this attempt is admitted, and covers BOTH headers and JSON body. Abort the actual
        // transport before settling the timeout; the race also fences late/non-cooperative transport completions.
        const timer = setTimeout(() => { timedOut = true; cancel(); }, readBudget);
        let result;
        try { result = await Promise.race([request(method, path, body, controller.signal), stopped]); }
        finally { clearTimeout(timer); }
        if (mine !== generation) return retired();
        if (controller.signal.aborted) return aborted();
        if (result.ok || result.status !== 429 || result.code !== "backpressure" || attempt === 3) return result;
        await pause(Math.min(2000, Math.max(500 * 2 ** attempt, Number(result.retryAfter) * 1000 || 0)), controller.signal);
      }
    };
    const queued = readTail.then(run, run);
    // A queued caller can cancel promptly, but does not let later work jump its still-running predecessor.
    readTail = queued.then(() => {}, () => {});
    const result = Promise.race([queued, stopped]);
    const forget = () => {
      readControllers.delete(controller); controller.signal.removeEventListener("abort", stop);
      signal?.removeEventListener("abort", cancel);
      if (pendingReads.get(path) === result) pendingReads.delete(path);
    };
    void result.then(forget, forget);
    if (!signal) pendingReads.set(path, result);
    return result;
  }
  async function request(method, path, body, signal) {
    const mine = generation;
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && csrf) headers["X-AgEnD-Hub-CSRF"] = csrf;
    let r;
    try { r = await fetchImpl(path, { method, headers, credentials: "same-origin", cache: "no-store", ...(signal ? { signal } : {}), body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch { return { ok: false, status: 0, code: "unreachable" }; }
    if (method === "GET" && signal?.aborted) return unreachable();
    let json = null;
    try { json = await r.json(); } catch { json = null; }
    if (method === "GET" && signal?.aborted) return unreachable();
    if (r.status === 401 && mine === generation) { retireReads(); csrf = null; codeNotices = false; roomsLive = false; teamsLive = false; for (const fn of ended) { try { fn(); } catch { /* a listener's own failure */ } } }
    if (!r.ok) return { ok: false, status: r.status, code: (json && typeof json.code === "string" && json.code) || "failed", retryAfter: Number(r.headers.get("Retry-After")) || 0,
      ...(method === "POST" && path === "/hub/v1/admin/enrolment-codes" && r.status === 429 && json?.code === "backpressure"
        && ["live-code-limit", "hourly-code-limit"].includes(json.reason) ? { reason: json.reason } : {}), ...roomRefusal(json) };
    return { ok: true, ...(json && typeof json === "object" ? json : {}) };
  }
  const id = (v) => encodeURIComponent(String(v));
  // Track U2: a refused room write says what the person is told — 409 people-limit the room's would-be head count (the
  // deduplicated union, the creator and current members included) and the limit; 503 group-unavailable which group.
  const roomRefusal = (json) => json?.code === "people-limit" && Number.isSafeInteger(json.people)
    ? { people: json.people, limit: Number.isSafeInteger(json.limit) ? json.limit : 100 }
    : json?.code === "group-unavailable" && typeof json.group === "string" ? { group: json.group } : {};
  // One stream per tab (#1580): every live subscription shares one EventSource. A Hub with rooms carries the notices on
  // its rooms stream too (`notices` = the notice version); before that the notices have their own. Listeners are kept
  // per event name; the stream closes with its last listener, and a refused (CLOSED) stream tells every subscriber once.
  // One dispatcher per event name per source, added when the name first listens and kept while that source lives (with no
  // listeners it reads an empty set), so a name that listens again while the stream stays open is heard once (Fable on #3848).
  const stream = { source: null, url: "", listeners: new Map(), dispatchers: new Map(), closers: new Set() };
  const attach = (name) => { if (stream.source && !stream.dispatchers.has(name)) { const fn = dispatch(name); stream.dispatchers.set(name, fn); stream.source.addEventListener(name, fn); } };
  const dispatch = (name) => (event) => {
    let data; try { data = JSON.parse(event.data); } catch { return; }
    for (const fn of [...(stream.listeners.get(name) || [])]) { try { fn(data); } catch { /* a listener's own failure */ } }
  };
  function listen(url, handlers, onClosed) {
    if (typeof EventSource === "undefined") return () => {};
    if (stream.source && stream.url !== url) { stream.source.close(); stream.source = null; stream.dispatchers.clear(); }   // the session changed what it may hear
    const mine = [];
    for (const [name, fn] of Object.entries(handlers)) {
      if (typeof fn !== "function") continue;
      if (!stream.listeners.has(name)) stream.listeners.set(name, new Set());
      attach(name);
      stream.listeners.get(name).add(fn); mine.push([name, fn]);
    }
    stream.closers.add(onClosed);
    if (!stream.source) {
      const source = new EventSource(url); stream.source = source; stream.url = url; stream.dispatchers.clear();
      for (const name of stream.listeners.keys()) attach(name);
      source.addEventListener("error", () => {
        // A refused handshake is CLOSED, unlike a transient disconnect that EventSource itself reconnects.
        if (stream.source !== source || source.readyState !== 2) return;
        source.close(); stream.source = null; stream.listeners.clear(); stream.dispatchers.clear();
        const closers = [...stream.closers]; stream.closers.clear();
        for (const fn of closers) { try { fn(); } catch { /* a subscriber's own failure */ } }
      });
    }
    let live = true;
    return () => {
      if (!live) return; live = false;
      for (const [name, fn] of mine) { const set = stream.listeners.get(name); set?.delete(fn); if (set && !set.size) stream.listeners.delete(name); }
      stream.closers.delete(onClosed);
      if (!stream.listeners.size && stream.source) { stream.source.close(); stream.source = null; stream.dispatchers.clear(); }
    };
  }
  const noticeVersion = (version) => version === 3 && codeNotices ? 3 : 2;
  const streamUrl = (version) => roomsLive ? `/hub/v1/rooms/events?notices=${noticeVersion(version)}` : `/hub/v1/notices/events?v=${noticeVersion(version)}`;
  return {
    stub: false, web: true,
    /** Hear the session end (a 401 anywhere). @returns {() => void} */
    onSignedOut(fn) { ended.add(fn); return () => ended.delete(fn); },
    async session() { const r = await call("GET", "/hub/v1/session"); if (r.ok) { csrf = r.signedIn ? r.csrf || null : null; codeNotices = r.signedIn === true && r.features?.includes("enrolment-code-v1") === true; roomsLive = r.signedIn === true && r.features?.includes(ROOMS_FEATURE) === true; teamsLive = r.signedIn === true && r.features?.includes(TEAMS_FEATURE) === true; } return r; },
    async signIn(login, password) { retireReads(); teamsLive = false; const r = await call("POST", "/hub/v1/session", { login, password }); if (r.ok) { csrf = r.csrf || null; codeNotices = r.features?.includes("enrolment-code-v1") === true; roomsLive = r.features?.includes(ROOMS_FEATURE) === true; teamsLive = r.features?.includes(TEAMS_FEATURE) === true; } return r; },
    async signOut() { retireReads(); const r = await call("DELETE", "/hub/v1/session"); csrf = null; codeNotices = false; roomsLive = false; teamsLive = false; return r; },
    catalog() { return call("GET", "/hub/v1/exposures"); },
    sharingPauseV1: true,
    sharing(exposureId, revision, sharingEpoch, paused) { return call("POST", `/hub/v1/exposures/${id(exposureId)}/sharing`, { revision, sharingEpoch, paused }); },
    grant(input) { return call("POST", "/hub/v1/grants", input); },
    grantSubjectsV1: true,
    async searchGrantSubjects(exposureId, exposureRevision, kind, q, signal) {
      const out = await call("POST", `/hub/v1/exposures/${id(exposureId)}/grant-subjects/search`, { exposureRevision, kind, q }, signal);
      return signal?.aborted ? { ok: false, status: 0, code: "unreachable" } : out;
    },
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
      const mine = generation;
      const headers = { Accept: "application/json", "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(String(file && file.name || "")) };
      if (csrf) headers["X-AgEnD-Hub-CSRF"] = csrf;
      let r;
      try { r = await fetchImpl(`/hub/v1/rooms/${id(roomId)}/files`, { method: "POST", headers, credentials: "same-origin", cache: "no-store", body: file }); }
      catch { return { ok: false, status: 0, code: "unreachable" }; }
      let json = null;
      try { json = await r.json(); } catch { json = null; }
      if (r.status === 401 && mine === generation) { retireReads(); csrf = null; for (const fn of ended) { try { fn(); } catch { /* a listener's own failure */ } } }
      if (!r.ok) return { ok: false, status: r.status, code: (json && typeof json.code === "string" && json.code) || "failed" };
      return { ok: true, ...(json && typeof json === "object" ? json : {}) };
    },
    read(roomId, after = 0) { return call("GET", `/hub/v1/rooms/${id(roomId)}/messages?after=${id(after)}`); },
    chooseButtons(roomId, input) { return call("POST", `/hub/v1/rooms/${id(roomId)}/buttons`, input); },
    // Hub rooms (docs/design/hub-rooms-split.md, seams 1, 3 and 5). The Hub speaks them once its session lists
    // ROOMS_FEATURE; before that it has today's rooms (one asker, one agent), which roomList() still answers in the same
    // shape (kind "direct", the old item under `legacy`), and whose messages stay with hub-chat-store.js.
    roomsV1: true,
    /** The Hub answers the rooms calls (seam 1) — otherwise only roomList() is meaningful. */
    roomsLive() { return roomsLive; },
    teamsLive() { return teamsLive; },
    /**
     * → { ok, rooms: [{ id, kind: "direct" | "group", name, people, agents, online, unread, lastAt, lastText, lastAuthor }] }.
     * `?v=2` (Ridge, #3858): the combined list; GET /hub/v1/rooms itself stays direct-only for older cached tabs, and a
     * server without rooms ignores the parameter (its answer is then normalised here).
     */
    async roomList() {
      const r = await call("GET", "/hub/v1/rooms?v=2");
      if (!r.ok || roomsLive) return r;
      return { ...r, rooms: (Array.isArray(r.rooms) ? r.rooms : []).map(legacyRoom).filter(Boolean) };
    },
    /** → { ok, room, me: { role }, members: [Member], settings: { allMention, historyForNew } } */
    room(roomId) { return call("GET", `/hub/v1/rooms/${id(roomId)}`); },
    /** A group room: { name, people: [personId], teams: [teamId], groups: [groupId], agents: [exposureId], assistant }. */
    createRoom(input) { return call("POST", "/hub/v1/rooms", input); },
    /** { name?, allMention?, historyForNew?, assistant?, archived? } */
    updateRoom(roomId, patch) { return call("PATCH", `/hub/v1/rooms/${id(roomId)}`, patch); },
    /** One member: { kind: "person" | "team" | "group" | "agent" | "assistant", id? } (the assistant has no id). */
    addRoomMember(roomId, member) { return call("POST", `/hub/v1/rooms/${id(roomId)}/members`, member); },
    removeRoomMember(roomId, memberId) { return call("DELETE", `/hub/v1/rooms/${id(roomId)}/members/${id(memberId)}`); },
    /** A page of Message, newest last: the latest `limit`, or those before the message `before`. */
    roomMessages(roomId, { before, limit } = {}) {
      const q = new URLSearchParams();
      if (before) q.set("before", String(before));
      if (Number.isSafeInteger(limit) && limit > 0) q.set("limit", String(limit));
      const query = q.toString();
      return call("GET", `/hub/v1/rooms/${id(roomId)}/messages${query ? `?${query}` : ""}`);
    },
    /** { text, mentions: ["all" | "assistant" | exposureId], replyTo?, files?: [fileId], idempotencyKey } → the stored Message. */
    sendRoomMessage(roomId, { text, mentions = [], replyTo, files, idempotencyKey }) {
      return call("POST", `/hub/v1/rooms/${id(roomId)}/messages`, { text, mentions, idempotencyKey,
        ...(replyTo ? { replyTo } : {}), ...(Array.isArray(files) && files.length ? { files } : {}) });
    },
    markRoomRead(roomId, upTo) { return call("POST", `/hub/v1/rooms/${id(roomId)}/read`, { upTo }); },
    /**
     * The one live stream of everything this person may see (seam 1): `handlers[name](data)` for each of ROOM_EVENTS,
     * on the tab's one stream (which also carries the notices). A refused stream (CLOSED) calls onClosed once; a
     * transient drop reconnects by itself. → unsubscribe.
     */
    subscribeRooms(handlers = {}, onClosed = () => {}) {
      if (!roomsLive) return () => {};
      const mine = {};
      for (const name of ROOM_EVENTS) if (typeof handlers[name] === "function") mine[name] = (data) => { if (data && typeof data === "object") handlers[name](data); };
      return listen(streamUrl(codeNotices ? 3 : 2), mine, onClosed);
    },
    // Seam 3: agents enter a room by their owner's consent.
    inviteToRoom(roomId, input) { return call("POST", `/hub/v1/rooms/${id(roomId)}/invitations`, input); },
    invitations() { return call("GET", "/hub/v1/invitations"); },
    acceptInvitation(invitationId) { return call("POST", `/hub/v1/invitations/${id(invitationId)}/accept`, {}); },
    declineInvitation(invitationId) { return call("POST", `/hub/v1/invitations/${id(invitationId)}/decline`, {}); },
    // Seam 5: teams, who may open rooms, and the administrator's list of rooms (names and members, no content).
    teams() { return call("GET", "/hub/v1/teams"); },
    team(teamId) { return call("GET", `/hub/v1/teams/${id(teamId)}`); },
    createTeam(input) { return call("POST", "/hub/v1/teams", input); },
    updateTeam(teamId, patch) { return call("PATCH", `/hub/v1/teams/${id(teamId)}`, patch); },
    deleteTeam(teamId) { return call("DELETE", `/hub/v1/teams/${id(teamId)}`); },
    async teamSuggestions(kind, q, teamId, signal) {
      const s = new URLSearchParams({ kind: String(kind), q: String(q ?? "") });
      if (teamId !== undefined) s.set("teamId", decodeURIComponent(id(teamId)));
      const out = await call("GET", `/hub/v1/teams/candidates?${s}`, undefined, signal);
      return signal?.aborted ? { ok: false, status: 0, code: "unreachable" } : out;
    },
    roomCreators() { return call("GET", "/hub/v1/admin/rooms/creators"); },
    saveRoomCreators(input) { return call("PUT", "/hub/v1/admin/rooms/creators", input); },
    adminRooms() { return call("GET", "/hub/v1/admin/rooms"); },
    // Track U2 (dev-claude2): pickers, roles, invitations, leave, the agent's rooms, admin rooms.
    // Leaving is removeRoomMember(roomId, <my id>) (409 last-manager); `me.assistant` comes with roomList()'s answer.
    /** The new-room and add-member pickers → { ok, candidates: [{ kind: "person" | "team" | "group" | "agent", id, name, people?, owner?: { name }, mine? }] }. */
    roomCandidates(q, kind, signal) {
      const s = new URLSearchParams({ q: String(q ?? "") });
      if (kind) s.set("kind", kind);
      return call("GET", `/hub/v1/rooms/candidates?${s}`, undefined, signal);
    },
    /**
     * A chosen AD group's label and head count → { ok, kind: "group", id, name, people } (its direct members now, nested
     * groups not followed; creating the room or adding the group reads the list again). 503 group-unavailable when the
     * directory cannot read the whole list.
     */
    roomGroup(groupId) { return call("GET", `/hub/v1/rooms/candidates/group/${id(groupId)}`); },
    /** 設為房間管理 / 改為成員. */
    setRoomMemberRole(roomId, memberId, role) { return call("PATCH", `/hub/v1/rooms/${id(roomId)}/members/${id(memberId)}`, { role }); },
    /** A room manager withdraws a pending (or clears an expired) invitation; 重新邀請 is a new inviteToRoom(). */
    cancelRoomInvitation(roomId, invitationId) { return call("DELETE", `/hub/v1/rooms/${id(roomId)}/invitations/${id(invitationId)}`); },
    /** The rooms one of my shared agents is in → { ok, rooms: [{ id, name, people, memberId }] }; 退出這個房間 is removeRoomMember(id, memberId). */
    agentRooms(exposureId) { return call("GET", `/hub/v1/exposures/${id(exposureId)}/rooms`); },
    /** 管理 → 房間: 加入自己成為房間管理 (the room gets a system line). */
    joinRoomAsAdmin(roomId) { return call("POST", `/hub/v1/admin/rooms/${id(roomId)}/join`, {}); },
    /** 管理 → 房間: 封存. */
    archiveRoomAsAdmin(roomId, archived = true) { return call("PATCH", `/hub/v1/admin/rooms/${id(roomId)}`, { archived }); },
    pairings() { return call("GET", "/hub/v1/pairings"); },
    quickPairingV1: true,
    createQuickPairing(label) { return call("POST", "/hub/v1/quick-pairing", { label }); },
    quickPairing(pairingId) { return call("GET", `/hub/v1/quick-pairing${pairingId ? `?id=${id(pairingId)}` : ""}`); },
    stopQuickPairing(pairingId) { return call("POST", `/hub/v1/quick-pairing/${id(pairingId)}/stop`); },
    revokeOwnFleet(fleetId, generation) { return call("POST", `/hub/v1/fleets/${id(fleetId)}/revoke`, { generation }); },
    // A cached notice renderer calls with no version and must never receive a code row it would label as group approval.
    pairingNoticesV3: true,
    pairingNotices(version = 2) { return call("GET", `/hub/v1/notices?v=${version === 3 && codeNotices ? 3 : 2}`); },
    directorySecurityNoticesV1: true,
    directorySecurityNotices({ before, limit = 25 } = {}) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (before) query.set("before", before);
      return call("GET", `/hub/v1/security-notices/directory?${query}`);
    },
    acknowledgeDirectorySecurityNotice(noticeId) { return call("POST", `/hub/v1/security-notices/directory/${id(noticeId)}/ack`); },
    /** The Hub's stream begins with the complete current snapshot; no bootstrap GET is needed. */
    pairingNoticeSnapshotV1: typeof EventSource !== "undefined",
    acknowledgePairingNotice(noticeId) { return call("POST", `/hub/v1/notices/${id(noticeId)}/ack`); },
    subscribePairingNotices(fn, onClosed = () => {}, version = 2) {
      return listen(streamUrl(version), { notices: (value) => { if (value && Array.isArray(value.notices)) fn(value.notices); } }, onClosed);
    },
    confirmPairing(pairingId, fingerprint) { return call("POST", `/hub/v1/pairings/${id(pairingId)}/confirm`, { fingerprint }); },
    companyJoinSettings() { return call("GET", "/hub/v1/admin/company-join"); },
    adminOverview() { return call("GET", "/hub/v1/admin/overview"); },
    /** B2 capability, not permission: the server still checks the configured administrator on every call. */
    enrolmentCodeV1: true,
    enrolmentCodes() { return call("GET", "/hub/v1/admin/enrolment-codes"); },
    createEnrolmentCode(input) { return call("POST", "/hub/v1/admin/enrolment-codes", input); },
    revokeEnrolmentCode(codeId) { return call("POST", `/hub/v1/admin/enrolment-codes/${id(codeId)}/revoke`, {}); },
    createPairing(login) { return call("POST", "/hub/v1/admin/pairings", { login }); },
    approvePairing(pairingId, fingerprint) { return call("POST", `/hub/v1/admin/pairings/${id(pairingId)}/approve`, { fingerprint }); },
    revokeFleet(fleetId) { return call("POST", `/hub/v1/admin/fleets/${id(fleetId)}/revoke`); },
    // #3298 S-89 (experimental, off unless the session lists "group-policy-v1"): group permissions, admin only; the welcome, any
    // signed-in person (display only — every action still asks the server).
    groupPolicy() { return call("GET", "/hub/v1/admin/group-policy"); },
    resolveGroup(dn) { return call("POST", "/hub/v1/admin/group-policy/resolve", { dn }); },
    /** M-2932 (Hub UX U2, S2): a prefix search of the directory's groups — input feedback only; choosing one still resolves its DN. */
    searchGroups(q) { return call("POST", "/hub/v1/admin/group-policy/search", { q }); },
    /** #3698 r1: the public join metadata a Fleet's discovery reads — its features name company-join-v1 only while joining is ON. */
    joinMetadata() { return call("GET", "/hub/v1/join/metadata"); },
    previewGroupPolicy(policy) { return call("POST", "/hub/v1/admin/group-policy/preview", { policy }); },
    /** The policy that was previewed and that preview's digest: the server applies only its own sealed candidate for them. */
    saveGroupPolicy(policy, previewDigest) { return call("PUT", "/hub/v1/admin/group-policy", { policy, previewDigest }); },
    /** One exact paused resource: its own revision, and the policy and suspension-record (lifecycle) revisions the page was shown. */
    resumeGroupResource(resource, expectedPolicyRevision, expectedLifecycleRevision) {
      return call("POST", "/hub/v1/admin/group-policy/resources/resume", { resource, expectedPolicyRevision, expectedLifecycleRevision });
    },
    welcome() { return call("GET", "/hub/v1/me/welcome"); },
    // M-2682: Administration → This Hub — what it is, and its rename (two steps: the server binds the second to the first).
    thisHub() { return call("GET", "/hub/v1/admin/hub"); },
    prepareHubName(name) { return call("POST", "/hub/v1/admin/hub/name/prepare", { name }); },
    commitHubName(ref) { return call("POST", "/hub/v1/admin/hub/name/commit", { ref }); },
    /** This client has the This Hub calls (a cached older client does not: the card is then left out). */
    thisHubV1: true,
    /** Paired with directory-editor-v1 and the current read DTO; cached clients cannot offer the editor. */
    directoryEditorV1: true,
    directorySettings(signal) { return call("GET", "/hub/v1/admin/hub/directory", undefined, signal); },
    prepareDirectorySettings(input, signal) { return call("POST", "/hub/v1/admin/hub/directory/prepare", input, signal); },
    testDirectorySettings(input, signal) { return call("POST", "/hub/v1/admin/hub/directory/test", input, signal); },
    saveDirectorySettings(input, signal) { return call("POST", "/hub/v1/admin/hub/directory/save", input, signal); },
    cancelDirectorySettings(input) { return call("POST", "/hub/v1/admin/hub/directory/cancel", input); },
    inspectDirectoryCa(input, signal) { return call("POST", "/hub/v1/admin/hub/directory/ca/inspect", input, signal); },
    fetchDirectoryCa(input, signal) { return call("POST", "/hub/v1/admin/hub/directory/ca/fetch", input, signal); },
    /** This client has the group permissions calls (a cached older client does not: the pages then hide them). */
    groupPolicyV1: true,
    // Track A (Sentinel): the room assistant's admin page.
    assistantAdminV1: true,
    assistantSettings() { return call("GET", "/hub/v1/admin/assistant"); },
    saveAssistantSettings(input) { return call("PUT", "/hub/v1/admin/assistant", input); },
    assistantUsage() { return call("GET", "/hub/v1/admin/assistant/usage"); },
    stopRoomAssistant(roomId) { return call("POST", `/hub/v1/admin/assistant/rooms/${id(roomId)}/stop`); },
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
  let pairingNotices = [], noticeEpoch = 0;
  const noticeReaders = new Set();
  const listed = async () => {
    const r = await confirm.api("/api/hub/member/exposures");
    return r.ok && r.body && Array.isArray(r.body.exposures) ? r.body.exposures : r.status === 404 ? null : [];
  };
  const fail = (r) => ({ ok: false, error: r.status === 404 ? "unavailable" : (r.body && typeof r.body.error === "string" ? r.body.error : "unsaved") });
  // Pairing (S3c PR B): GET the projection; connect / confirm / disconnect go through the Settings confirmation (a 202:
  // "sent for confirmation", followed in the background; the poll shows the result); cancel at once.
  const pairingNow = async () => {
    const mine = noticeEpoch, version = noticeReaders.size ? 3 : 2;
    const r = await confirm.api(`/api/hub/member/pairing?v=2${version === 3 ? "&notices=3" : ""}`);
    if (r.ok && r.body && r.body.pairing) {
      if (mine === noticeEpoch) pairingNotices = Array.isArray(r.body.notices) ? r.body.notices.filter(n => n && typeof n === "object"
        && (n.source === undefined || n.source === "group" || n.source === "manual" || n.source === "code" && version === 3)) : [];
      return r.body.pairing;
    }
    if (mine === noticeEpoch) pairingNotices = [];
    return { state: "held", hold: r.status === 404 ? "unavailable" : "unsaved" };
  };
  const step = async (name, body) => {
    const r = await confirm.api(`/api/hub/member/pairing/${name}`, { method: "POST", headers: { "Idempotency-Key": confirm.newKey("hub") }, body: JSON.stringify(body || {}) });
    if (confirm.isPendingResponse(r)) {
      const settled = Promise.resolve(confirm.track(r.body.pending_change, "hub"));
      void settled.catch(() => {});
      return { ok: true, pendingConfirmation: true, settled, pairing: await pairingNow() };
    }
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
    pairingNotices: () => pairingNotices,
    /** Presentation lease only. Cached renderers never call this and continue to receive v2. */
    usePairingNoticeVersion(version) {
      if (version !== 3) return () => {};
      const reader = {}; if (!noticeReaders.size) noticeEpoch++; noticeReaders.add(reader);
      return () => { if (noticeReaders.delete(reader) && !noticeReaders.size) { noticeEpoch++; pairingNotices = pairingNotices.filter(n => n.source !== "code"); } };
    },
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
      const r = await step("disconnect", { hubId, binding }); return r.ok ? { ok: true, remote: "pending", ...(r.pendingConfirmation ? { pendingConfirmation: true, settled: r.settled } : {}) } : { ok: false, error: r.error === "unsaved" ? "unsaved" : "conflict" }; },
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
        return { ok: true, pending: { id: p.id, expiresAt: p.expires_at }, view: { ...row, pending: { expiresAt: p.expires_at } }, settled: confirm.track(p, "hub") };
      }
      return r.ok && r.body && r.body.ok ? { ok: true, view: r.body.view } : fail(r);
    },
  };
}
