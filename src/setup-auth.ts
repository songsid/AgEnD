/**
 * The credential model for the pre-fleet setup page.
 *
 * Three separate things, deliberately not one:
 *
 * - **The sid** is 128 bits in the URL path. It is NOT a credential. Its only
 *   job is that a scanner who finds the host cannot find the door, and
 *   therefore cannot reach the attempt counter and lock the page out of spite.
 *   Whoever receives the link has it, and that is fine.
 * - **The code** is 8 base32 characters the person types. It is only an
 *   exchange key: short enough to read off a terminal and type on a phone, and
 *   therefore too short to be anything that is checked more than a few times.
 * - **The session secret** is 256 bits, minted when the code is redeemed, and
 *   is what the cookie is derived from.
 *
 * That third one exists because deriving the cookie from the code would cap the
 * cookie's strength at the code's 40 bits — and a cookie can be guessed offline
 * (it is a hash of a known prefix) and then replayed, which the code's attempt
 * limit would not see. Every presented-and-wrong credential, code or cookie,
 * decrements the same budget, so testing a candidate always costs one of five.
 *
 * See `docs/design/setup-host-tunnel.zh-TW.md` §3.8 and envelope rule 28.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** RFC 4648 base32, minus nothing: the digits 0/1 are absent from it already. */
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const SETUP_CODE_LENGTH = 8;

/**
 * Five, not three.
 *
 * Someone typing eight characters on a phone will mistype; three is tight
 * enough that a legitimate person locks themselves out, and the difference
 * between `3/2^40` and `5/2^40` is nothing anyone can act on.
 */
export const MAX_SETUP_ATTEMPTS = 5;

export const SETUP_COOKIE_NAME = "agend_setup";

export function generateSetupCode(): string {
  let code = "";
  for (let i = 0; i < SETUP_CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** `ABCD-EFGH` — a shape that survives being read aloud and retyped. */
export function formatSetupCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * What the person typed, as the code it was meant to be.
 *
 * Case and the dash are presentation. Rejecting `abcd efgh` would be rejecting
 * a correct answer, and the person retyping it has no idea which detail was
 * wrong — so they spend attempts on formatting.
 */
export function normalizeSetupCode(input: string): string {
  return input.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/**
 * Fixed-length constant-time compare.
 *
 * Both sides are padded to the same length first: `timingSafeEqual` throws on a
 * mismatch, and returning early on one leaks the length through timing.
 */
export function constantTimeMatches(provided: string, expected: string): boolean {
  const width = Math.max(provided.length, expected.length, 1);
  const a = Buffer.alloc(width);
  const b = Buffer.alloc(width);
  a.write(provided, "utf8");
  b.write(expected, "utf8");
  return timingSafeEqual(a, b) && provided.length === expected.length;
}

/** The cookie carries a hash of the secret, never the secret itself. */
export function setupCookieValue(secret: string): string {
  return createHash("sha256").update(`agend-setup-session-v1:${secret}`).digest("hex");
}

export function buildSetupCookie(secret: string, opts: { path: string; secure: boolean; maxAgeSeconds: number }): string {
  const attrs = [
    `${SETUP_COOKIE_NAME}=${setupCookieValue(secret)}`,
    `Path=${opts.path}`,
    "HttpOnly",
    // Strict: this page writes a config file and starts a fleet, so a
    // cross-site navigation must not arrive already authenticated.
    "SameSite=Strict",
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}

export type SetupVerdict =
  /** Go ahead. */
  | { readonly kind: "ok" }
  /** Not authenticated, and nothing was presented — costs no attempt. */
  | { readonly kind: "unauthenticated" }
  /** Something was presented and it was wrong. An attempt is gone. */
  | { readonly kind: "rejected"; readonly attemptsLeft: number }
  /** The budget is spent; the host is finished. */
  | { readonly kind: "locked" };

/**
 * The page's credentials and the one counter they share.
 *
 * Deliberately has no idea what an HTTP request is: the rules here are the ones
 * worth testing directly, and a socket in the way of that would only make them
 * harder to see.
 */
export class SetupCredentials {
  readonly sid: string;
  readonly code: string;
  private secret: string | null = null;
  private failures = 0;

  constructor(opts: { sid?: string; code?: string } = {}) {
    this.sid = opts.sid ?? randomBytes(16).toString("hex");
    this.code = opts.code ?? generateSetupCode();
  }

  private revoked = false;

  /**
   * Take the page's credentials away, irreversibly.
   *
   * Called first in the shutdown, before the listener is closed: from this
   * instant nothing can authenticate, so anything still in flight — including a
   * request that arrives over a tunnel we have not torn down yet — is already
   * too late.
   */
  revoke(): void {
    this.revoked = true;
    this.secret = null;
  }

  get revokedNow(): boolean { return this.revoked; }

  get lockedOut(): boolean { return this.revoked || this.failures >= MAX_SETUP_ATTEMPTS; }
  get attemptsLeft(): number { return Math.max(0, MAX_SETUP_ATTEMPTS - this.failures); }
  /** True once the code has been exchanged; the code itself stops working then. */
  get redeemed(): boolean { return this.secret !== null; }

  /**
   * Does this path belong to this page?
   *
   * Compared in constant time and answered with nothing but yes/no: the 404 a
   * wrong sid gets has to be the same 404 anything else gets, or the sid can be
   * found by watching how the answers differ. A wrong sid also costs no
   * attempt — otherwise a scanner who cannot find the door could still spend
   * the budget behind it, which is the denial of setup the sid exists to stop.
   */
  matchesSid(candidate: string): boolean {
    return constantTimeMatches(candidate, this.sid);
  }

  /**
   * Something only this page can serve, for proving a tunnel reaches THIS
   * listener rather than merely returning a 200 from somewhere.
   */
  get readinessMarker(): string { return `agend-setup:${this.sid}`; }

  /** Exchange the code for a session. One-way: the code is spent either way. */
  redeem(providedCode: string): SetupVerdict & { secret?: string } {
    if (this.lockedOut) return { kind: "locked" };
    const normalized = normalizeSetupCode(providedCode);
    if (!normalized) return { kind: "unauthenticated" };
    if (!constantTimeMatches(normalized, this.code)) {
      this.failures += 1;
      return this.lockedOut ? { kind: "locked" } : { kind: "rejected", attemptsLeft: this.attemptsLeft };
    }
    // A second redemption of the same code would hand a second party its own
    // session. One exchange, then the code is dead.
    if (this.secret) return { kind: "rejected", attemptsLeft: this.attemptsLeft };
    this.secret = randomBytes(32).toString("hex");
    return { kind: "ok", secret: this.secret };
  }

  /**
   * Check a cookie against the minted session.
   *
   * An absent cookie is "not signed in yet" and costs nothing — otherwise a
   * stale tab polling in the background would lock the real person out. A
   * cookie that is present and wrong is somebody testing a candidate, and that
   * is exactly what the budget is for.
   */
  checkCookie(presented: string | undefined): SetupVerdict {
    if (this.lockedOut) return { kind: "locked" };
    if (presented === undefined || presented === "") return { kind: "unauthenticated" };
    if (!this.secret) {
      this.failures += 1;
      return this.lockedOut ? { kind: "locked" } : { kind: "rejected", attemptsLeft: this.attemptsLeft };
    }
    if (constantTimeMatches(presented, setupCookieValue(this.secret))) return { kind: "ok" };
    this.failures += 1;
    return this.lockedOut ? { kind: "locked" } : { kind: "rejected", attemptsLeft: this.attemptsLeft };
  }
}
