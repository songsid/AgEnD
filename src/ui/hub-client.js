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
 * - { state: "pending", memberOrigin, fingerprint (pairing), expiresAt, ownerConfirmed, adminApproved }
 *     both confirmations are needed: the owner's from a current Hub directory session, the Hub administrator's approval
 *     of this exact fingerprint — possession of the code proves neither
 * - { state: "paired", hub: { hubId, name, memberOrigin, webOrigin, fingerprint (hub-key) }, link: "online" | "offline" }
 *     memberOrigin: the pinned transport origin; webOrigin: the separately approved browser origin (they may differ)
 * - { state: "key_changed", hub: {…approved, fingerprint (hub-key)}, offered (hub-key) }
 *     nothing connects; the offered value is never accepted automatically — re-pair or disconnect
 * - { state: "held", hold, memberOrigin? }
 *     a safety hold, visible: hold ∈ "unknown_outcome" | "expired" | "unsaved" | "refused" | "revoked" — never shown as
 *     paired, never as a successful unpair
 * @typedef {object} HubPairingView
 */
/**
 * One of THIS fleet's agents (the local owner's own inventory — never the Hub's), as the exposure list shows it.
 * `agent` is the stable local agent name, never its label. `state` is the local consent; `revision` the exposure policy
 * revision the page shows (enabling refers to it: a stale tab gets "conflict", never a silent widening). `policy`
 * summarises the approved data view and tools. `enforceable` is slice 4's restricted-context result (false until it
 * exists; never a model's claim) — not enforceable is never publishable, and true never means the owner's normal
 * session is exposed.
 * @typedef {{ agent: string, display: string, exposureId: string | null, revision: number,
 *   state: "published" | "withdrawn" | "frozen", policy: { dataView: string, tools: string[] } | null,
 *   enforceable: boolean, reason?: string }} HubExposureView
 */
/**
 * Results. A withdrawal or disconnect fences locally at once (even offline) but answers ok only once the local
 * restrictive state is saved; `remote` says whether the Hub confirmed it ("pending": not yet — shown as a warning).
 * @typedef {{ ok: true, pairing: HubPairingView } | { ok: false, error: "address" | "code" | "busy" | "unreachable" | "refused" }} HubConnectResult
 * @typedef {{ ok: true, view: HubExposureView } | { ok: false, error: "not_paired" | "unknown_agent" | "not_enforceable" | "conflict" | "unsaved" }} HubPublishResult
 * @typedef {{ ok: true, remote: "confirmed" | "pending" } | { ok: false, error: "unsaved" | "conflict" }} HubWithdrawResult
 */

/** The client every Hub page uses (one per page). */
let client = null;
export function hubClient() { return client ??= createStubClient({ agents: () => (appStore.get().instances || []).filter((i) => i && i.name) }); }
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
      state: c.state, policy: ok ? { dataView: "read-only summary", tools: ["read"] } : null, enforceable: ok, ...(ok ? {} : { reason: "restricted_execution_pending" }) };
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
    async setExposed(agent, on, expectedRevision) {
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
      consent.set(agent, { state: "published", revision: c.revision + 1 });
      return { ok: true, view: view(a) };
    },
    /** Hear pairing changes (slice 1: the member's local status projections). @returns {() => void} */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // Hub shell (placeholders until slices 2, 3 and 5): what a person can ask, what they publish, administration.
    async askable() { return []; },
    async myExposures() { return []; },
    async administration() { return { fleets: [], grants: [], audit: [] }; },
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
