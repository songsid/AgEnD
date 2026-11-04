/**
 * #3008 (alpha.3; decision 28c2d3a3 rule 3, the user's simplified form hmsg-33c3d609): connections from outside for a
 * web-only fleet. Its one person — this computer's admin, the host operator (`agend web --code` on this computer) — sets
 * up an authenticator app (TOTP, RFC 6238) here, then turns on "Allow connections from outside": the public link opens,
 * owned by this computer's admin, and signing in through it asks for the app's code. Turning it off closes the link.
 *
 * What this file holds, in `web-remote-access.json` beside the fleet (0600, written atomically — never fleet.yaml, so
 * neither an agent nor a hand edit of the config turns it on):
 * - the authenticator secret (160 bits, base32), when it was set up, and the last time step a code was accepted for
 *   (each step once: a code that was seen cannot be used again);
 * - the outside switch;
 * - the wrong-code limiter: 5 wrong codes → a wait (15 minutes, doubling after each further 5 up to a day; a correct
 *   code resets it — #3008 C(b), confirmed by the user, decision 0471da59). Never a permanent
 *   lock (the user's decision 4). It is fleet-wide: one guesser from many addresses is one guesser.
 *
 * The secret never leaves this module except once, to the host operator who is setting it up (beginEnrollment). It is
 * never logged, never in a status, a Notice or an error.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";
import { t } from "./locale.js";
import type { LoginCodeOwner } from "./web-login.js";

export const WEB_REMOTE_ACCESS_FILE = "web-remote-access.json";
/** RFC 6238 as every common authenticator app shows it: SHA-1, 6 digits, 30-second steps. */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/**
 * Steps accepted around now: one either side (#3008 C, the leader: this host is WSL2, whose clock drifts behind after
 * Windows sleeps — accepting only the current and previous code would refuse the phone's newest one).
 */
export const TOTP_PAST_STEPS = 1;
export const TOTP_FUTURE_STEPS = 1;
/** Diagnosis only (#3008 C): a wrong code is also compared this many steps out, to log how far this clock is off. */
export const TOTP_SKEW_PROBE_STEPS = 2;
/** 5 wrong codes → a wait. */
export const TOTP_WRONG_LIMIT = 5;
/** The first wait; #3008 C(b): each further one doubles, up to TOTP_PAUSE_MAX_MS. A correct code resets it. */
export const TOTP_PAUSE_MS = 15 * 60_000;
export const TOTP_PAUSE_MAX_MS = 24 * 60 * 60_000;
/** How long a secret being set up waits for its first code. */
export const TOTP_ENROLL_TTL_MS = 10 * 60_000;
const SECRET_BYTES = 20;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let out = "", bits = 0, value = 0;
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP: the code for one counter, as `digits` decimal digits (left-padded). */
export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac("sha1", secret).update(msg).digest();
  const off = mac[mac.length - 1]! & 15;
  const bin = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The RFC 6238 time step a wall-clock moment falls in. */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * The step `code` is valid for — the current one or one within the accepted window, newer than `after` — or null. Six
 * digits only (spaces ignored); compared in constant time.
 */
export function matchTotp(secret: Uint8Array, code: string, nowMs: number, after: number): number | null {
  const typed = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(typed)) return null;
  const now = totpStep(nowMs);
  let found: number | null = null;
  for (let step = now - TOTP_PAST_STEPS; step <= now + TOTP_FUTURE_STEPS; step++) {
    if (step <= after) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(typed)) && found === null) found = step;
  }
  return found;
}

/**
 * Diagnosis only, never acceptance: for a code that did not match, the step offset (beyond the accepted window, at most
 * TOTP_SKEW_PROBE_STEPS out) it would have matched — positive: the phone is ahead of this computer's clock. Else null.
 */
export function totpSkew(secret: Uint8Array, code: string, nowMs: number): number | null {
  const typed = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(typed)) return null;
  const now = totpStep(nowMs);
  for (let d = 1; d <= TOTP_SKEW_PROBE_STEPS; d++) {
    for (const offset of [d, -d]) {
      if (offset >= -TOTP_PAST_STEPS && offset <= TOTP_FUTURE_STEPS) continue;
      if (timingSafeEqual(Buffer.from(hotp(secret, now + offset)), Buffer.from(typed))) return offset;
    }
  }
  return null;
}

/** The `otpauth://` URI an authenticator app reads from the QR code (or the key typed in by hand). */
export function otpauthUri(secretBase32: string, account: string): string {
  const label = encodeURIComponent(`AgEnD:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=AgEnD&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

interface Saved {
  v: 1;
  totp?: { secret: string; enrolledAt: number; lastStep: number };
  outside: boolean;
  /** Wrong codes since the last wait (or the last correct code). */
  wrong: number;
  /** How many waits in a row (0: none since the last correct code): the next one is TOTP_PAUSE_MS × 2^level. */
  level: number;
  /** Wall clock: no code is tried before this. */
  pausedUntil: number;
}

export type TotpVerdict =
  | { kind: "ok" }
  /** `skewSteps`: the code would have matched that many steps out — this computer's clock is likely off (logged). */
  | { kind: "wrong"; paused: false; skewSteps: number | null }
  /** This wrong code started a wait (a Notice says so): the `wrong` codes that led to it. */
  | { kind: "wrong"; paused: true; retryAfterMs: number; wrong: number; skewSteps: number | null }
  | { kind: "paused"; retryAfterMs: number }
  | { kind: "not_enrolled" }
  /** Right, but the step it used could not be saved: refused (else a restart would let it be used again). */
  | { kind: "unavailable" };

export interface RemoteAccessStatus {
  enrolled: boolean;
  enrolledAt: number | null;
  outside: boolean;
  /** A wait in force now (ms left), else 0. */
  pausedForMs: number;
}

const blank = (): Saved => ({ v: 1, outside: false, wrong: 0, level: 0, pausedUntil: 0 });

export class WebRemoteAccess {
  private state: Saved = blank();
  private pending: { secret: string; handle: string; until: number } | null = null;
  private warned = false;

  constructor(private readonly path: string, private readonly log: { warn(obj: object, msg?: string): void },
    private readonly now: () => number = Date.now, private readonly monotonic: () => number = () => performance.now()) {
    let raw: string;
    try { raw = readFileSync(path, "utf8"); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn({ path }, "Outside connections state unreadable — off, nothing set up");
      return;
    }
    try {
      const v = JSON.parse(raw) as Partial<Saved>;
      if (v.v !== 1) throw new Error("shape");
      const t = v.totp;
      const totp = t && typeof t.secret === "string" && (base32Decode(t.secret)?.length ?? 0) >= 16 && Number.isSafeInteger(t.enrolledAt)
        && Number.isSafeInteger(t.lastStep) ? { secret: t.secret, enrolledAt: t.enrolledAt, lastStep: t.lastStep } : undefined;
      const count = (n: unknown): number => (Number.isSafeInteger(n) && (n as number) >= 0 ? n as number : 0);
      this.state = { v: 1, ...(totp ? { totp } : {}),
        // Never on without an app set up: a file that says otherwise is read as off.
        outside: v.outside === true && !!totp,
        wrong: Math.min(count(v.wrong), TOTP_WRONG_LIMIT - 1), level: Math.min(count(v.level), 32),
        // A wait never longer than the longest there is (a clock set back, or a hand edit).
        pausedUntil: Math.min(count(v.pausedUntil), this.now() + TOTP_PAUSE_MAX_MS) };
    } catch {
      log.warn({ path }, "Outside connections state unreadable — off, nothing set up");
      this.state = blank();
    }
  }

  status(): RemoteAccessStatus {
    return { enrolled: !!this.state.totp, enrolledAt: this.state.totp?.enrolledAt ?? null, outside: this.state.outside,
      pausedForMs: Math.max(0, this.state.pausedUntil - this.now()) };
  }
  get enrolled(): boolean { return !!this.state.totp; }
  get outside(): boolean { return this.state.outside && !!this.state.totp; }

  /**
   * A new secret for the session `handle` to set up (it replaces nothing until confirmEnrollment). Returned once: the
   * caller shows it to that session and forgets it.
   */
  beginEnrollment(handle: string, account: string): { secret: string; uri: string; expiresInMs: number } {
    const secret = base32Encode(randomBytes(SECRET_BYTES));
    this.pending = { secret, handle, until: this.monotonic() + TOTP_ENROLL_TTL_MS };
    return { secret, uri: otpauthUri(secret, account), expiresInMs: TOTP_ENROLL_TTL_MS };
  }

  /**
   * The first code from the app being set up, by the session that began it. "ok": it is now the one (a previous one is
   * replaced; the limiter starts afresh). The caller then ends the sessions signed in with the old one.
   */
  confirmEnrollment(handle: string, code: string): "ok" | "wrong" | "expired" | "unsaved" {
    const p = this.pending;
    if (!p || p.handle !== handle || this.monotonic() > p.until) { if (p && this.monotonic() > p.until) this.pending = null; return "expired"; }
    const step = matchTotp(base32Decode(p.secret)!, code, this.now(), -1);
    if (step === null) return "wrong";
    const before = this.state;
    this.state = { ...this.state, totp: { secret: p.secret, enrolledAt: this.now(), lastStep: step }, wrong: 0, level: 0, pausedUntil: 0 };
    if (!this.flush()) { this.state = before; return "unsaved"; }
    this.pending = null;
    return "ok";
  }

  /** Forget the app; the outside switch goes off with it. */
  remove(): void {
    this.pending = null;
    this.state = { ...blank() };
    this.flush();
  }

  /** The switch. On only with an app set up (false: refused). */
  setOutside(on: boolean): boolean {
    if (on && !this.state.totp) return false;
    if (this.state.outside !== on) { this.state = { ...this.state, outside: on }; this.flush(); }
    return true;
  }

  /** A code typed at sign-in from outside. Each step is accepted once; wrong codes count toward a wait. */
  verify(code: string): TotpVerdict {
    const t = this.state.totp;
    if (!t) return { kind: "not_enrolled" };
    const now = this.now();
    if (now < this.state.pausedUntil) return { kind: "paused", retryAfterMs: this.state.pausedUntil - now };
    const step = matchTotp(base32Decode(t.secret)!, code, now, t.lastStep);
    if (step !== null) {
      const before = this.state;
      this.state = { ...this.state, totp: { ...t, lastStep: step }, wrong: 0, level: 0, pausedUntil: 0 };
      if (!this.flush()) { this.state = { ...before, totp: { ...t, lastStep: step } }; return { kind: "unavailable" }; }
      return { kind: "ok" };
    }
    const skewSteps = totpSkew(base32Decode(t.secret)!, code, now);
    const wrong = this.state.wrong + 1;
    if (wrong < TOTP_WRONG_LIMIT) { this.state = { ...this.state, wrong }; this.flush(); return { kind: "wrong", paused: false, skewSteps }; }
    const wait = Math.min(TOTP_PAUSE_MS * 2 ** this.state.level, TOTP_PAUSE_MAX_MS);
    this.state = { ...this.state, wrong: 0, level: this.state.level + 1, pausedUntil: now + wait };
    this.flush();
    return { kind: "wrong", paused: true, retryAfterMs: wait, wrong: TOTP_WRONG_LIMIT, skewSteps };
  }

  /** Saved: true. Not saved: false (warned once until it works again); memory keeps the new state either way. */
  private flush(): boolean {
    try {
      atomicWriteFileSync(this.path, JSON.stringify(this.state) + "\n", { mode: 0o600 });
      this.warned = false;
      return true;
    } catch (err) {
      if (!this.warned) this.log.warn({ err: (err as Error).message, path: this.path }, "Outside connections state could not be saved");
      this.warned = true;
      return false;
    }
  }
}

// ── The outside link (FleetManager): its owner, its retries, and the closes that are its own ──

/**
 * #3008: whose the outside link is — this computer's admin, not a chat account. Never matches a chat owner (those carry
 * a live adapter binding); FleetManager.publicOwnerCurrent permits it only while the switch is on, on a web-only fleet.
 */
export const OUTSIDE_LINK_OWNER: LoginCodeOwner = Object.freeze({ adapterId: "host", userId: "operator", chatId: "host" });
export function isOutsideLinkOwner(owner: LoginCodeOwner): boolean {
  return owner.adapterId === OUTSIDE_LINK_OWNER.adapterId && owner.userId === OUTSIDE_LINK_OWNER.userId
    && owner.chatId === OUTSIDE_LINK_OWNER.chatId && owner.binding === undefined && owner.threadId === undefined;
}
/** #3008 B: a dropped link is reopened twice at most — after 30 s, then 2 minutes. */
export const OUTSIDE_LINK_RETRY_MS: readonly number[] = [30_000, 120_000];
/** Closes the switch itself made (or the fleet stopping, or its own failed start): nothing to reopen or announce. */
export const OUTSIDE_OWN_CLOSES: ReadonlySet<string> = new Set(["outside off", "outside removed", "fleet shutdown", "unattended start failed"]);

export function outsideTimer(fn: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

/** A wait as words: "15 minutes" / 「15 分鐘」, "2 hours" / 「2 小時」 (whole minutes under an hour, else whole hours, rounded up). */
export function outsideDuration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return minutes === 1 ? t("outside.duration_minute") : t("outside.duration_minutes", minutes);
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? t("outside.duration_hour") : t("outside.duration_hours", hours);
}
