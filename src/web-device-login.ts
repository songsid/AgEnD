/**
 * Device-code sign-in (Refs #3061, P2a): a new browser shows an 8-character code; a device that is already signed in AND
 * is this fleet's verified owner types that code under Settings → Access & security → Add device and approves it; the
 * new browser then signs itself in.
 *
 * What is kept here is only the requests — never a credential. Approval moves a request from `pending` to `approved`
 * and nothing else: no cookie, session id or token passes from the approving device to the new one. The new browser
 * mints its own session in its own request (auth-api `POST /auth/device-login/poll`), by presenting the request id it
 * was given when it asked. That id is 256 random bits, is never shown to the approver, and travels only in an HttpOnly
 * cookie scoped to /auth/device-login.
 *
 * The rules, each of them a property worth testing on its own:
 * - **Short-lived and single-use.** A request lives five minutes from when it was asked for — approving does not extend
 *   it — and the poll that claims an approved request spends it. A second claim, a second approval of the same code and
 *   a code that has expired are all refused.
 * - **Rotating the web token withdraws every request** (each carries the token epoch it was made under), as it does an
 *   unused login code. So does `/dashboard revoke` (`revokeAll`).
 * - **Bounded.** At most MAX_PENDING_DEVICE_LOGINS requests at once, MAX_PENDING_PER_PEER per address, and a limit on
 *   how many one address — and the fleet — may ask for in a window, so a stranger on the network cannot fill the room
 *   or run the fleet out of memory. A full room refuses new requests; it never evicts a waiting person's.
 * - **A breaker on the approving side.** Typing a code that matches no request is a wrong try; enough of them pause every
 *   lookup and decision, correct codes included. With no request waiting there is nothing to guess: it counts against
 *   nothing (as for login codes). The approving side is already an owner-verified session, so this guards against a
 *   mistake, a stolen owner session guessing at someone else's code, and a phishing line "read me the code".
 * - **The approver learns only what it needs to decide:** the device's label, whether it asked from this computer or the
 *   network, its address, and the time left. Never the request id.
 *
 * Deliberately knows nothing of HTTP, sessions or who the approver is: the caller has already decided that.
 * In memory only — a restart drops every request, as it does an unused login code.
 */
import { createHash, randomBytes } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { constantTimeMatches, formatOneTimeCode, generateOneTimeCode, normalizeOneTimeCode } from "./auth/one-time-code.js";
import { fleetCookieName } from "./web-cookie-names.js";

export const DEVICE_LOGIN_TTL_MS = 5 * 60 * 1000;
export const MAX_PENDING_DEVICE_LOGINS = 8;
export const MAX_PENDING_PER_PEER = 2;
/** Requests one address, and the whole fleet, may ask for per DEVICE_LOGIN_CREATE_WINDOW_MS. */
export const DEVICE_LOGIN_CREATE_WINDOW_MS = 10 * 60 * 1000;
export const DEVICE_LOGIN_CREATES_PER_PEER = 6;
export const DEVICE_LOGIN_CREATES_GLOBAL = 20;
/**
 * The approving side's breaker: this many wrong codes in the window pause it. Shorter than a request's life on purpose
 * (a pause that outlasted it would end every request waiting): ten tries per two minutes is still hopeless against a
 * 40-bit code among at most eight, and the person approving is already an owner-verified session.
 */
export const DEVICE_APPROVE_WINDOW_MS = 15 * 60 * 1000;
export const DEVICE_APPROVE_THRESHOLD = 10;
export const DEVICE_APPROVE_PAUSE_MS = 2 * 60 * 1000;

/** Compared against when nothing waits, so "no request" costs what "wrong code" costs. */
const NO_REQUEST_PLACEHOLDER = "AAAAAAAA";
/** Where a request came from, for the approver: this computer, or somewhere on the network (LAN, tailnet). */
export type DeviceLoginPeer = "host" | "network";
export type DeviceLoginState = "pending" | "approved" | "denied";

interface Entry {
  readonly code: string;
  readonly label: string;
  readonly peer: DeviceLoginPeer;
  readonly address: string;
  readonly peerKey: string;
  readonly epoch: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  state: DeviceLoginState;
  decidedBy?: string;
}

/** What the approving device may see of a request. */
export interface DeviceLoginView {
  /** As typed: `ABCD-EFGH`. */
  readonly code: string;
  readonly label: string;
  readonly peer: DeviceLoginPeer;
  readonly address: string;
  readonly expiresAt: number;
  readonly state: DeviceLoginState;
}

export type DeviceLoginCreate =
  | { readonly kind: "ok"; readonly requestId: string; readonly code: string; readonly expiresAt: number }
  /** Too many asked for from this address, or the fleet over. */
  | { readonly kind: "limited"; readonly retryAfterMs: number }
  /** The room is full (or this address already has its share waiting). */
  | { readonly kind: "full" };

export type DeviceLoginPoll =
  | { readonly kind: "pending"; readonly expiresAt: number }
  /** Approved, and now spent: the caller makes the session. Never returned twice for one request. */
  | { readonly kind: "claimed"; readonly label: string; readonly approvedBy: string }
  | { readonly kind: "denied" }
  /** Expired, spent, withdrawn, made under another token, or never made: deliberately indistinguishable. */
  | { readonly kind: "expired" };

export type DeviceLoginMatch =
  | { readonly kind: "ok"; readonly view: DeviceLoginView }
  /** Wrong, expired, or none waiting: deliberately indistinguishable. */
  | { readonly kind: "invalid" }
  | { readonly kind: "paused"; readonly retryAfterMs: number };

export type DeviceLoginDecision =
  | { readonly kind: "ok"; readonly view: DeviceLoginView }
  | { readonly kind: "invalid" }
  | { readonly kind: "paused"; readonly retryAfterMs: number }
  /** The code was already approved or denied (and not yet taken up): what it is now. */
  | { readonly kind: "decided"; readonly state: DeviceLoginState };

export interface DeviceLoginRequestsOptions {
  readonly now?: () => number;
  /** For tests that need a known code. */
  readonly generate?: () => string;
  readonly onEvent?: (event: "created" | "approved" | "denied" | "claimed" | "breaker-open") => void;
}

/**
 * The key the per-address limits count by. An IPv4 address (also one an IPv6 socket reports as `::ffff:a.b.c.d`) is its
 * own key. An IPv6 address counts by its /64: a single network hands one machine a whole /64, so keying by the full
 * address would give one host as many allowances as it has addresses. Whatever is not an IP address (`unknown`) is its
 * own key. Never read from a header: only the socket's peer.
 */
export function peerKeyOf(address: string): string {
  const a = address.replace(/%.*$/, "").toLowerCase();                       // a zone id (fe80::1%eth0) is not part of the address
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (dotted) return dotted[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) { const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16); return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`; }
  if (isIPv4(a) || !isIPv6(a)) return a;
  const halves = a.split("::");
  const groups = (part: string | undefined): string[] => (part ? part.split(":").flatMap(g => {
    if (!g.includes(".")) return [g];
    const [b0, b1, b2, b3] = g.split(".").map(Number) as [number, number, number, number];     // an embedded IPv4 is two groups
    return [((b0 << 8) | b1).toString(16), ((b2 << 8) | b3).toString(16)];
  }) : []);
  const head = groups(halves[0]), tail = halves.length > 1 ? groups(halves[1]) : [];
  const all = halves.length > 1 ? [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
  return `${all.slice(0, 4).map(g => parseInt(g || "0", 16).toString(16)).join(":")}::/64`;
}

/** The key a request id is kept under: its hash, so the map never holds what the new browser presents. */
function keyOf(requestId: string): string {
  return createHash("sha256").update(`agend-device-login-v1:${requestId}`).digest("hex");
}

const REQUEST_ID = /^[0-9a-f]{64}$/;

export class DeviceLoginRequests {
  private readonly entries = new Map<string, Entry>();
  private readonly createdByPeer = new Map<string, number[]>();
  private created: number[] = [];
  private approveFailures: number[] = [];
  private approvePausedUntil = 0;
  private readonly now: () => number;
  private readonly generate: () => string;
  private readonly onEvent: (event: "created" | "approved" | "denied" | "claimed" | "breaker-open") => void;

  constructor(opts: DeviceLoginRequestsOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.generate = opts.generate ?? generateOneTimeCode;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  /** How many requests are waiting (or approved and not yet taken up) — for tests and status lines. */
  get size(): number { this.prune(); return this.entries.size; }

  /** How many addresses the creation rate limit is holding stamps for (for tests: it must not grow without bound). */
  get rateTableSize(): number { return this.createdByPeer.size; }

  /**
   * A new request. `replaces` is the request id the same browser held (its cookie): it is withdrawn first, so "get a
   * new code" never counts against the room — but it does count against the rate. `label`, `peer` and `address` are
   * the server's own reading of the request (never body input); they are what the approver is shown.
   */
  create(input: { epoch: string; peerKey: string; label: string; peer: DeviceLoginPeer; address: string; replaces?: string }): DeviceLoginCreate {
    const now = this.now();
    this.prune();
    if (input.replaces && REQUEST_ID.test(input.replaces)) this.entries.delete(keyOf(input.replaces));
    const cutoff = now - DEVICE_LOGIN_CREATE_WINDOW_MS;
    this.created = this.created.filter(t => t > cutoff);
    // The whole per-address table, not just this address: one whose every stamp is out of the window is forgotten, so
    // addresses seen once never pile up (the table holds at most what the window admitted — DEVICE_LOGIN_CREATES_GLOBAL).
    for (const [key, stamps] of this.createdByPeer) {
      const live = stamps.filter(t => t > cutoff);
      if (live.length) this.createdByPeer.set(key, live); else this.createdByPeer.delete(key);
    }
    const mine = this.createdByPeer.get(input.peerKey) ?? [];
    if (mine.length >= DEVICE_LOGIN_CREATES_PER_PEER) return { kind: "limited", retryAfterMs: Math.max(1000, mine[0]! + DEVICE_LOGIN_CREATE_WINDOW_MS - now) };
    if (this.created.length >= DEVICE_LOGIN_CREATES_GLOBAL) return { kind: "limited", retryAfterMs: Math.max(1000, this.created[0]! + DEVICE_LOGIN_CREATE_WINDOW_MS - now) };
    let waitingHere = 0;
    for (const e of this.entries.values()) if (e.peerKey === input.peerKey) waitingHere++;
    if (this.entries.size >= MAX_PENDING_DEVICE_LOGINS || waitingHere >= MAX_PENDING_PER_PEER) return { kind: "full" };

    // A code no other waiting request has (the room is eight; a clash is a one-in-a-trillion retry).
    let code = this.generate();
    for (let n = 0; n < 16 && this.codeTaken(code); n++) code = this.generate();
    if (this.codeTaken(code)) return { kind: "full" };
    const requestId = randomBytes(32).toString("hex");
    const expiresAt = now + DEVICE_LOGIN_TTL_MS;
    this.entries.set(keyOf(requestId), { code, label: input.label, peer: input.peer, address: input.address, peerKey: input.peerKey,
      epoch: input.epoch, createdAt: now, expiresAt, state: "pending" });
    this.created.push(now);
    this.createdByPeer.set(input.peerKey, [...mine, now]);
    this.onEvent("created");
    return { kind: "ok", requestId, code: formatOneTimeCode(code), expiresAt };
  }

  /**
   * The new browser asks where its request stands. An approved one is spent by this very call (`claimed`): the caller
   * then makes the session, and a second poll with the same id finds nothing. A denied one is told once and forgotten.
   * An unknown, malformed, expired or other-token id is `expired` — the answer never says which.
   */
  poll(requestId: string | undefined, currentEpoch: string): DeviceLoginPoll {
    if (!requestId || !REQUEST_ID.test(requestId)) return { kind: "expired" };
    this.prune();
    const key = keyOf(requestId), e = this.entries.get(key);
    if (!e) return { kind: "expired" };
    if (e.epoch !== currentEpoch) { this.entries.delete(key); return { kind: "expired" }; }
    if (e.state === "pending") return { kind: "pending", expiresAt: e.expiresAt };
    this.entries.delete(key);
    if (e.state === "denied") return { kind: "denied" };
    this.onEvent("claimed");
    return { kind: "claimed", label: e.label, approvedBy: e.decidedBy ?? "" };
  }

  /** The browser leaves the page (or asks again): its request is withdrawn. Whatever the id, nothing is said. */
  cancel(requestId: string | undefined): void {
    if (requestId && REQUEST_ID.test(requestId)) this.entries.delete(keyOf(requestId));
  }

  /** The approving side types a code: the request it names, for the confirm screen. A wrong code counts. */
  lookup(input: string, currentEpoch: string): DeviceLoginMatch {
    const m = this.match(input, currentEpoch);
    return m.kind === "found" ? { kind: "ok", view: viewOf(m.entry) } : m;
  }

  /**
   * Approve or deny the request this code names. Only a pending one changes: one already decided says what it is now,
   * so a second tap approves nothing twice. `by` is the approving session's handle (logged, never shown to the device).
   */
  decide(input: string, decision: "approved" | "denied", by: string, currentEpoch: string): DeviceLoginDecision {
    const m = this.match(input, currentEpoch);
    if (m.kind !== "found") return m;
    const e = m.entry;
    if (e.state !== "pending") return { kind: "decided", state: e.state };
    e.state = decision;
    e.decidedBy = by;
    this.onEvent(decision === "approved" ? "approved" : "denied");
    return { kind: "ok", view: viewOf(e) };
  }

  /** `/dashboard revoke`: every request is withdrawn. */
  revokeAll(): void { this.entries.clear(); }

  /** How long the approving side stays paused by its breaker (0 when it is closed). */
  approvePausedForMs(): number { return Math.max(0, this.approvePausedUntil - this.now()); }

  private codeTaken(code: string): boolean {
    for (const e of this.entries.values()) if (e.code === code) return true;
    return false;
  }

  private match(input: string, currentEpoch: string): { kind: "found"; entry: Entry } | { kind: "invalid" } | { kind: "paused"; retryAfterMs: number } {
    const now = this.now();
    if (now < this.approvePausedUntil) return { kind: "paused", retryAfterMs: this.approvePausedUntil - now };
    const provided = normalizeOneTimeCode(input);
    // Nothing typed is not a guess; it costs nothing.
    if (!provided) return { kind: "invalid" };
    this.prune();
    for (const [key, e] of this.entries) if (e.epoch !== currentEpoch) this.entries.delete(key);       // the token was rotated
    if (!this.entries.size) {
      constantTimeMatches(provided, NO_REQUEST_PLACEHOLDER);
      return { kind: "invalid" };
    }
    // Every waiting code is compared, in constant time each: where the match is does not show in the time taken.
    let hit: Entry | null = null;
    for (const e of this.entries.values()) if (constantTimeMatches(provided, e.code)) hit = e;
    if (hit) return { kind: "found", entry: hit };
    this.approveFailures = this.approveFailures.filter(t => t > now - DEVICE_APPROVE_WINDOW_MS);
    this.approveFailures.push(now);
    if (this.approveFailures.length >= DEVICE_APPROVE_THRESHOLD) {
      this.approvePausedUntil = now + DEVICE_APPROVE_PAUSE_MS;
      this.approveFailures = [];
      this.onEvent("breaker-open");
    }
    return { kind: "invalid" };
  }

  private prune(): void {
    const now = this.now();
    for (const [key, e] of this.entries) if (now >= e.expiresAt) this.entries.delete(key);
  }
}

function viewOf(e: Entry): DeviceLoginView {
  return { code: formatOneTimeCode(e.code), label: e.label, peer: e.peer, address: e.address, expiresAt: e.expiresAt, state: e.state };
}

// ── The new browser's one cookie: the request id, HttpOnly, and sent only to /auth/device-login ──
export const DEVICE_LOGIN_COOKIE = "agend_device_login";
export const DEVICE_LOGIN_PATH = "/auth/device-login";

export function buildDeviceLoginCookie(requestId: string, secure: boolean, webToken: string, maxAgeSeconds: number): string {
  return [`${fleetCookieName(DEVICE_LOGIN_COOKIE, webToken)}=${requestId}`, `Path=${DEVICE_LOGIN_PATH}`, "HttpOnly", "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`, ...(secure ? ["Secure"] : [])].join("; ");
}

export function clearDeviceLoginCookie(secure: boolean, webToken: string): string {
  return buildDeviceLoginCookie("", secure, webToken, 0);
}

/** The request id this browser holds, if the cookie header carries a well-formed one. */
export function readDeviceLoginCookie(cookieHeader: string | undefined, webToken: string): string | undefined {
  if (!cookieHeader) return undefined;
  const name = fleetCookieName(DEVICE_LOGIN_COOKIE, webToken);
  for (const part of cookieHeader.split(";")) {
    const at = part.indexOf("=");
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    const value = part.slice(at + 1).trim();
    if (REQUEST_ID.test(value)) return value;
  }
  return undefined;
}
