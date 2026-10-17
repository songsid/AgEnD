/**
 * The dashboard's login codes: who may redeem one, how often they may be wrong,
 * and what happens when they are wrong too often.
 *
 * Deliberately not `SetupCredentials`. That class belongs to a ten-minute
 * escape hatch whose answer to five wrong tries is to destroy itself; a fleet
 * that runs for months must not be closable by whoever finds its address. So the
 * rules here are different, and each is a property worth testing directly:
 *
 * - **No outstanding code, nothing to guess.** A redemption while no code has
 *   been issued gets the same refusal as a wrong code and counts against
 *   nothing. The door is only a door in the few minutes after the operator asked
 *   for a code on a channel only they can read.
 * - **A code dies with its fifth wrong try — the code, not the fleet.** The
 *   cost to a stranger who guesses is that the operator asks for another.
 * - **A breaker for the rest.** Enough wrong tries across codes pauses
 *   redemption for a while, correct codes included, so a patient guesser cannot
 *   turn five-per-code into an unbounded stream. Sessions already signed in are
 *   not affected: this object knows nothing about them.
 * - **One code at a time, single use.** Issuing replaces the outstanding code;
 *   redeeming it spends it.
 *
 * The code is only an exchange key. What a successful redemption yields is a
 * fresh 256-bit session id from `web-session.ts` that has no relation to it.
 *
 * Deliberately has no idea what an HTTP request is.
 */
import {
  constantTimeMatches,
  formatOneTimeCode,
  generateOneTimeCode,
  normalizeOneTimeCode,
} from "./auth/one-time-code.js";
import { randomBytes } from "node:crypto";
import type { SessionTier } from "./web-session.js";

export const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;
/** Same reasoning as setup: eight characters on a phone get mistyped. */
export const MAX_LOGIN_CODE_ATTEMPTS = 5;
export const LOGIN_BREAKER_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_BREAKER_THRESHOLD = 20;
export const LOGIN_BREAKER_PAUSE_MS = 5 * 60 * 1000;

/** Compared against when nothing is outstanding, so "no code" costs what "wrong code" costs. */
const NO_CODE_PLACEHOLDER = "AAAAAAAA";

export interface LoginCodeOwner {
  /** Server-owned live adapter identity; never accepted from HTTP. */
  readonly binding?: object;
  readonly adapterId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly threadId?: string;
  /** #1827: the account's display name when the code was asked for — the web name it starts with. */
  readonly username?: string;
}
/**
 * #1827: the account a code was sent to privately, for recognition only — the web person a session redeemed with it is
 * (their id, `via web`; their name). Unlike an owner it authorizes nothing and gates nothing (no returning device, no
 * public-link confirmation): a code delivered to a fleet admin outside an owning General still says who it went to.
 */
export interface LoginCodeRecipient {
  readonly adapterId: string;
  readonly userId: string;
  readonly username?: string;
}
export interface IssuedLoginCode {
  readonly issuanceId: string;
  /** As typed: `ABCD-EFGH`. */
  readonly display: string;
  readonly expiresAt: number;
  readonly tier: SessionTier;
}

export type LoginRedeemResult =
  | { readonly kind: "ok"; readonly tier: SessionTier; readonly owner?: LoginCodeOwner; readonly recipient?: LoginCodeRecipient }
  /** Wrong, expired, spent, or none issued — deliberately indistinguishable. */
  | { readonly kind: "invalid" }
  /** The breaker is open. Even a correct code is refused until it closes. */
  | { readonly kind: "paused"; readonly retryAfterMs: number };

interface Outstanding {
  readonly issuanceId: string;
  readonly audience: string;
  readonly owner?: LoginCodeOwner;
  readonly recipient?: LoginCodeRecipient;
  readonly code: string;
  readonly expiresAt: number;
  readonly tier: SessionTier;
  /** The web token's epoch when the code was issued: a code dies with the token it was issued under. */
  readonly epoch: string;
  failures: number;
}

export interface WebLoginCodesOptions {
  readonly now?: () => number;
  /** For tests that need a known code. */
  readonly generate?: () => string;
  readonly onEvent?: (event: "issued" | "spent" | "burned" | "breaker-open") => void;
}

export class WebLoginCodes {
  private outstanding: Outstanding | null = null;
  private failures: number[] = [];
  private pausedUntil = 0;
  private readonly now: () => number;
  private readonly generate: () => string;
  private readonly onEvent: (event: "issued" | "spent" | "burned" | "breaker-open") => void;

  constructor(opts: WebLoginCodesOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.generate = opts.generate ?? generateOneTimeCode;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  /**
   * Issue a code, replacing any outstanding one. Only ever called from a channel the operator controls.
   * `epoch` is the current web token's (`tokenEpoch`): rotating the token — from this process or from
   * `agend web-token rotate` in another — withdraws an unused code, because redemption re-checks it.
   */
  issue(opts: { tier?: SessionTier; epoch: string; audience?: string; owner?: LoginCodeOwner; recipient?: LoginCodeRecipient }): IssuedLoginCode {
    const code = this.generate();
    const tier = opts.tier ?? "admin";
    const expiresAt = this.now() + LOGIN_CODE_TTL_MS;
    const issuanceId = randomBytes(16).toString("hex");
    this.outstanding = { code, expiresAt, tier, epoch: opts.epoch, failures: 0, issuanceId, audience: opts.audience ?? "local", owner: opts.owner,
      // #1827: an owner is also who the code went to; a recipient alone is recognition only.
      ...(opts.owner || opts.recipient ? { recipient: opts.recipient ?? { adapterId: opts.owner!.adapterId, userId: opts.owner!.userId, ...(opts.owner!.username ? { username: opts.owner!.username } : {}) } } : {}) };
    this.onEvent("issued");
    return { display: formatOneTimeCode(code), expiresAt, tier, issuanceId };
  }

  /** #1570: how long redemption stays paused by the breaker (0 when it is closed). A code request is refused meanwhile. */
  pausedForMs(): number {
    return Math.max(0, this.pausedUntil - this.now());
  }

  /** Whether a redemption right now would be compared against anything. */
  get hasOutstandingCode(): boolean {
    return this.activeCode() !== null;
  }

  /** Withdraw the outstanding code without spending it (`/dashboard revoke`). */
  revoke(): void {
    this.outstanding = null;
  }

  /** `currentEpoch` is the web token's epoch NOW: a code issued under another token is gone. */
  revokeIfCurrent(issuanceId: string): void {
    if (this.outstanding?.issuanceId === issuanceId) this.outstanding = null;
  }

  revokeAudience(audience: string): void {
    if (this.outstanding?.audience === audience) this.outstanding = null;
  }

  redeem(input: string, currentEpoch: string, audience = "local"): LoginRedeemResult {
    const now = this.now();
    if (now < this.pausedUntil) return { kind: "paused", retryAfterMs: this.pausedUntil - now };

    const provided = normalizeOneTimeCode(input);
    // Nothing typed is not a guess; it costs nothing (same as the setup page).
    if (!provided) return { kind: "invalid" };

    let active = this.activeCode();
    if (active && active.epoch !== currentEpoch) {
      // The token was rotated after this code was issued: the rotation withdrew it.
      this.outstanding = null;
      active = null;
    }
    if (!active) {
      constantTimeMatches(provided, NO_CODE_PLACEHOLDER);
      return { kind: "invalid" };
    }

    if (constantTimeMatches(provided, active.code) && active.audience === audience) {
      this.outstanding = null;
      this.onEvent("spent");
      return { kind: "ok", tier: active.tier, ...(active.owner ? { owner: active.owner } : {}), ...(active.recipient ? { recipient: active.recipient } : {}) };
    }

    active.failures += 1;
    this.recordFailure(now);
    if (active.failures >= MAX_LOGIN_CODE_ATTEMPTS) {
      this.outstanding = null;
      this.onEvent("burned");
    }
    return { kind: "invalid" };
  }

  private activeCode(): Outstanding | null {
    if (!this.outstanding) return null;
    if (this.now() >= this.outstanding.expiresAt) { this.outstanding = null; return null; }
    return this.outstanding;
  }

  private recordFailure(now: number): void {
    this.failures.push(now);
    const cutoff = now - LOGIN_BREAKER_WINDOW_MS;
    this.failures = this.failures.filter(t => t > cutoff);
    if (this.failures.length >= LOGIN_BREAKER_THRESHOLD) {
      this.pausedUntil = now + LOGIN_BREAKER_PAUSE_MS;
      this.failures = [];
      this.onEvent("breaker-open");
    }
  }
}

/** #1920 step 4: at most this many guest codes outstanding at once; past it a new one is refused, never someone's evicted. */
export const MAX_GUEST_LOGIN_CODES = 32;

/**
 * #1920 step 4: guests' sign-in codes — the same rules as WebLoginCodes (single use, five minutes, a code dies with its
 * fifth wrong try, a breaker for the rest), but one outstanding code PER ACCOUNT: a new `/web` from an account replaces
 * only its own, so no guest can invalidate another's (#2093 review, leader). At most MAX_GUEST_LOGIN_CODES at once: past
 * that, issue() refuses rather than evict.
 *
 * A wrong code is not anyone's in particular, so it counts against every outstanding guest code (each still dies at its
 * fifth) and once against the breaker. `match` never counts: the caller tries it first, then the admins' codes, and only
 * a code neither knows is wrong (recordWrong) — so a guest signing in never counts against an admin's code, nor the
 * reverse.
 */
export class GuestLoginCodes {
  private readonly outstanding = new Map<string, Outstanding>();
  private failures: number[] = [];
  private pausedUntil = 0;
  private readonly now: () => number;
  private readonly generate: () => string;
  private readonly onEvent: (event: "issued" | "spent" | "burned" | "breaker-open") => void;

  constructor(opts: WebLoginCodesOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.generate = opts.generate ?? generateOneTimeCode;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  private key(r: { adapterId: string; userId: string }): string { return `${r.adapterId}\u0000${r.userId}`; }

  /** A code for this account, replacing its own outstanding one; null when MAX_GUEST_LOGIN_CODES others are outstanding. */
  issue(opts: { epoch: string; recipient: LoginCodeRecipient; audience?: string }): IssuedLoginCode | null {
    this.prune();
    const k = this.key(opts.recipient);
    if (!this.outstanding.has(k) && this.outstanding.size >= MAX_GUEST_LOGIN_CODES) return null;
    const code = this.generate();
    const expiresAt = this.now() + LOGIN_CODE_TTL_MS;
    const issuanceId = randomBytes(16).toString("hex");
    this.outstanding.set(k, { code, expiresAt, tier: "guest", epoch: opts.epoch, failures: 0, issuanceId, audience: opts.audience ?? "local", recipient: opts.recipient });
    this.onEvent("issued");
    return { display: formatOneTimeCode(code), expiresAt, tier: "guest", issuanceId };
  }

  pausedForMs(): number { return Math.max(0, this.pausedUntil - this.now()); }
  /** This account's code is outstanding. */
  hasCodeFor(r: { adapterId: string; userId: string }): boolean { this.prune(); return this.outstanding.has(this.key(r)); }
  get size(): number { this.prune(); return this.outstanding.size; }
  revokeAll(): void { this.outstanding.clear(); }
  /** A guest's own `/web revoke`: its code only. */
  revokeRecipient(r: { adapterId: string; userId: string }): void { this.outstanding.delete(this.key(r)); }
  revokeIfCurrent(issuanceId: string): void {
    for (const [k, o] of this.outstanding) if (o.issuanceId === issuanceId) this.outstanding.delete(k);
  }

  /**
   * The guest code `input` is, spent — or null (no count: the caller asks the admins' codes next, and reports a code
   * neither knows with recordWrong). Every outstanding code is compared, in constant time each. Paused: nothing matches.
   */
  match(input: string, currentEpoch: string, audience = "local"): LoginRedeemResult | null {
    if (this.now() < this.pausedUntil) return null;
    const provided = normalizeOneTimeCode(input);
    if (!provided) return null;
    this.prune();
    let hit: [string, Outstanding] | null = null;
    for (const entry of this.outstanding) {
      if (entry[1].epoch !== currentEpoch) { this.outstanding.delete(entry[0]); continue; }   // the token was rotated
      if (constantTimeMatches(provided, entry[1].code) && entry[1].audience === audience) hit = entry;
    }
    if (!hit) return null;
    this.outstanding.delete(hit[0]);
    this.onEvent("spent");
    return { kind: "ok", tier: "guest", recipient: hit[1].recipient! };
  }

  /**
   * A code that was neither a guest's nor an admin's: one wrong try against every outstanding guest code, and the
   * breaker. As WebLoginCodes: nothing typed is not a guess, and with no guest code outstanding there is nothing to
   * guess — it counts against nothing (#2093 review: else wrong codes could open this breaker, which pauses the admins'
   * sign-in too, before any code exists). The breaker's history stays across codes.
   */
  recordWrong(input: string): void {
    if (!normalizeOneTimeCode(input)) return;
    this.prune();
    if (!this.outstanding.size) return;
    const now = this.now();
    for (const [k, o] of this.outstanding) {
      o.failures += 1;
      if (o.failures >= MAX_LOGIN_CODE_ATTEMPTS) { this.outstanding.delete(k); this.onEvent("burned"); }
    }
    this.failures.push(now);
    const cutoff = now - LOGIN_BREAKER_WINDOW_MS;
    this.failures = this.failures.filter(t => t > cutoff);
    if (this.failures.length >= LOGIN_BREAKER_THRESHOLD) {
      this.pausedUntil = now + LOGIN_BREAKER_PAUSE_MS;
      this.failures = [];
      this.onEvent("breaker-open");
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [k, o] of this.outstanding) if (now >= o.expiresAt) this.outstanding.delete(k);
  }
}
