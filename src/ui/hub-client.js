// AgEnD Hub P1, slice 3 (fleet decision 7e5b8a8f; design #3095): the one seam between the Hub's web UI and its data.
// Every Hub page and card (the Hub shell's panels, the member's switcher and "Connect to a Hub") reads and writes through
// this client — nothing else. Until slice 0 (transport, pairing) lands it is a STUB: answers held in this page's
// memory, shaped as the real ones will be (docs/design/hub-ui-client.md). Re-pointing it at S0 replaces the bodies of
// `createStubClient`'s methods with requests; the pages do not change.
//
// Off is the default: the server marks the page (data-hub="member" | "hub") only when the Hub is on, and nothing here
// is ever loaded otherwise (app-shell.js and panel-settings.js import the Hub modules only when the mark is present).
import { appStore } from "/assets/app-store.js";

/** "off" | "member" (this fleet may connect to a Hub) | "hub" (this instance IS the Hub), from the server's mark. */
export function hubMode(doc = typeof document !== "undefined" ? document : null) {
  const v = doc && doc.body && doc.body.dataset ? doc.body.dataset.hub : "";
  return v === "member" || v === "hub" ? v : "off";
}
/** The Hub's operator-chosen name (Hub mode only), from the server's mark; "" when none. */
export function hubName(doc = typeof document !== "undefined" ? document : null) {
  const v = doc && doc.body && doc.body.dataset ? doc.body.dataset.hubName : "";
  return typeof v === "string" ? v.trim().slice(0, 60) : "";
}

/**
 * Pairing, as the member sees it:
 * - { state: "unpaired" }
 * - { state: "pending", hub: { address }, fingerprint, expiresAt }   — sent; compare the fingerprint, wait for approval
 * - { state: "paired", hub: { address, name, url, fingerprint } }    — url: the Hub's own web (the switcher opens it)
 * - { state: "key_changed", hub: { address, name, url, fingerprint }, offered }
 *     the Hub presented another key than the pinned one: nothing connects until it is re-paired (§4 "Pair")
 * @typedef {{ state: "unpaired" } | { state: "pending", hub: { address: string }, fingerprint: string, expiresAt: number }
 *   | { state: "paired", hub: { address: string, name: string, url: string, fingerprint: string } }
 *   | { state: "key_changed", hub: { address: string, name: string, url: string, fingerprint: string }, offered: string }} HubPairing
 */
/**
 * One of this fleet's agents, as the exposure list shows it. `exposed`: published to the Hub (the owner's consent);
 * `enforceable`: its restrictions can be enforced (slice 4) — an agent that cannot be isolated is never offered (§5).
 * @typedef {{ agent: string, display: string, exposed: boolean, enforceable: boolean, reason?: string }} HubExposure
 */

/** The client every Hub page uses (one per page). */
let client = null;
export function hubClient() { return client ??= createStubClient({ agents: () => (appStore.get().instances || []).filter((i) => i && i.name) }); }
/** For tests and S0's switch-over: put another client in place (null: the stub again, fresh). */
export function setHubClient(next) { client = next; }

const ADDRESS = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?\/?$/i;
const CODE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i;
/** A fingerprint as people compare it: 4 groups of 4 hex digits. */
export function formatFingerprint(hex) { return String(hex || "").replace(/[^0-9a-f]/gi, "").toUpperCase().slice(0, 16).replace(/(.{4})(?=.)/g, "$1 "); }

/** The stub: deterministic answers in this page's memory (no request leaves the page). */
export function createStubClient({ now = () => Date.now(), agents = () => [] } = {}) {
  let pairing = { state: "unpaired" };
  const exposed = new Map();
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) { try { fn(pairing); } catch { /* a listener's own failure */ } } };
  const digest = (s) => { let h1 = 0x811c9dc5, h2 = 0x01000193; for (const c of s) { h1 = Math.imul(h1 ^ c.codePointAt(0), 16777619) >>> 0; h2 = Math.imul(h2 + c.codePointAt(0), 2246822519) >>> 0; } return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")); };
  const api = {
    stub: true,
    /** @returns {Promise<HubPairing>} */
    async pairing() { return pairing; },
    /** Ask the Hub at `address` to pair, with its one-time `code`. @returns {Promise<{ ok: true, pairing: HubPairing } | { ok: false, error: "address" | "code" | "busy" }>} */
    async connect({ address, code }) {
      const a = String(address || "").trim(), c = String(code || "").trim();
      if (!ADDRESS.test(a)) return { ok: false, error: "address" };
      if (!CODE.test(c)) return { ok: false, error: "code" };
      if (pairing.state === "pending" || pairing.state === "paired") return { ok: false, error: "busy" };
      pairing = { state: "pending", hub: { address: a.replace(/\/$/, "") }, fingerprint: digest(`${a}|${c.toUpperCase().replace("-", "")}`), expiresAt: now() + 10 * 60_000 };
      emit();
      return { ok: true, pairing };
    },
    /** Withdraw a pending request. */
    async cancel() { if (pairing.state === "pending") { pairing = { state: "unpaired" }; emit(); } return pairing; },
    /** Leave the Hub (paired or key changed): every exposure is withdrawn with it. */
    async disconnect() { pairing = { state: "unpaired" }; exposed.clear(); emit(); return pairing; },
    /** @returns {Promise<HubExposure[]>} */
    async exposures() {
      return agents().map((a) => ({ agent: a.name, display: a.display_name || a.name, exposed: exposed.get(a.name) === true,
        enforceable: false, reason: "restricted_execution_pending" }));
    },
    /** Publish or withdraw one agent. Withdrawing always works; publishing needs a paired Hub and an enforceable agent. */
    async setExposed(agent, on) {
      if (!on) { exposed.delete(agent); return { ok: true }; }
      if (pairing.state !== "paired") return { ok: false, error: "not_paired" };
      const a = (await api.exposures()).find((x) => x.agent === agent);
      if (!a) return { ok: false, error: "unknown_agent" };
      if (!a.enforceable) return { ok: false, error: "not_enforceable" };
      exposed.set(agent, true);
      return { ok: true };
    },
    /** Hear pairing changes (S0: the status frame). @returns {() => void} */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // Hub side (Hub mode): placeholders until slices 2, 3 and 5 — what a person can ask, what they publish, administration.
    async askable() { return []; },
    async myExposures() { return []; },
    async administration() { return { fleets: [], grants: [], audit: [] }; },
    /** The stub's own controls (tests, smokes, a demo): what the Hub and its administrator would do. */
    control: {
      approve(name = "Hub") { if (pairing.state !== "pending") return; const hub = { address: pairing.hub.address, name, url: pairing.hub.address, fingerprint: pairing.fingerprint }; pairing = { state: "paired", hub }; emit(); },
      keyChanged(offered = "f00dbabe0badcafe") { if (pairing.state !== "paired") return; pairing = { state: "key_changed", hub: pairing.hub, offered }; emit(); },
      enforceable(set) { api.exposures = async () => agents().map((a) => ({ agent: a.name, display: a.display_name || a.name, exposed: exposed.get(a.name) === true, enforceable: set.has(a.name), ...(set.has(a.name) ? {} : { reason: "restricted_execution_pending" }) })); },
    },
  };
  return api;
}
