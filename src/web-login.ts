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
import type { SessionTier } from "./web-session.js";

export const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;
/** Same reasoning as setup: eight characters on a phone get mistyped. */
export const MAX_LOGIN_CODE_ATTEMPTS = 5;
export const LOGIN_BREAKER_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_BREAKER_THRESHOLD = 20;
export const LOGIN_BREAKER_PAUSE_MS = 5 * 60 * 1000;

/** Compared against when nothing is outstanding, so "no code" costs what "wrong code" costs. */
const NO_CODE_PLACEHOLDER = "AAAAAAAA";

export interface IssuedLoginCode {
  /** As typed: `ABCD-EFGH`. */
  readonly display: string;
  readonly expiresAt: number;
  readonly tier: SessionTier;
}

export type LoginRedeemResult =
  | { readonly kind: "ok"; readonly tier: SessionTier }
  /** Wrong, expired, spent, or none issued — deliberately indistinguishable. */
  | { readonly kind: "invalid" }
  /** The breaker is open. Even a correct code is refused until it closes. */
  | { readonly kind: "paused"; readonly retryAfterMs: number };

interface Outstanding {
  readonly code: string;
  readonly expiresAt: number;
  readonly tier: SessionTier;
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

  /** Issue a code, replacing any outstanding one. Only ever called from a channel the operator controls. */
  issue(opts: { tier?: SessionTier } = {}): IssuedLoginCode {
    const code = this.generate();
    const tier = opts.tier ?? "admin";
    const expiresAt = this.now() + LOGIN_CODE_TTL_MS;
    this.outstanding = { code, expiresAt, tier, failures: 0 };
    this.onEvent("issued");
    return { display: formatOneTimeCode(code), expiresAt, tier };
  }

  /** Whether a redemption right now would be compared against anything. */
  get hasOutstandingCode(): boolean {
    return this.activeCode() !== null;
  }

  /** Withdraw the outstanding code without spending it (`/dashboard revoke`). */
  revoke(): void {
    this.outstanding = null;
  }

  redeem(input: string): LoginRedeemResult {
    const now = this.now();
    if (now < this.pausedUntil) return { kind: "paused", retryAfterMs: this.pausedUntil - now };

    const provided = normalizeOneTimeCode(input);
    // Nothing typed is not a guess; it costs nothing (same as the setup page).
    if (!provided) return { kind: "invalid" };

    const active = this.activeCode();
    if (!active) {
      constantTimeMatches(provided, NO_CODE_PLACEHOLDER);
      return { kind: "invalid" };
    }

    if (constantTimeMatches(provided, active.code)) {
      this.outstanding = null;
      this.onEvent("spent");
      return { kind: "ok", tier: active.tier };
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
