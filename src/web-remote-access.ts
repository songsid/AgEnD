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
 * AGEND-122 (upstream #3486, per-admin): the authenticator is each admin's own. The record above is the HOST OPERATOR's — a
 * web-only fleet's one person, and the one connections from outside sign in with — and a chat fleet's other admins each have
 * their own under `admins`, keyed by connection and account. An admin enrols, replaces and removes only their own; each has
 * their own "ask for my code to confirm from other devices" switch (`strict`), kept with the record so removing the app removes
 * it. The wrong-code limiter stays fleet-wide.
 *
 * #3486: the same per-admin app also signs a new browser in as that admin (`signIn`): one use per step with the confirmations
 * (`lastStep`), its own limiters (per admin in the record, per typed name in memory, one fleet-wide), never the confirmations' own.
 *
 * The secret never leaves this module except once, to the host operator who is setting it up (beginEnrollment). It is
 * never logged, never in a status, a Notice or an error.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
/**
 * #3486 (new-device sign-in with an admin's own authenticator): the wrong-code limits of that sign-in, which are NOT the
 * confirmation limiter above — an unauthenticated route must not be able to pause the confirmations of admins already signed in.
 * The browser types the code alone (AGEND-155): a wrong code with no name belongs to no admin, so it is counted in the browser's
 * limiter and the whole sign-in's only (layers 1 and 4; plus a known device's own, below). Layers 2 and 3 are the legacy path where the
 * request still carries a name (`account`, accepted for compatibility). Four layers, so that one person's typos stop only that person,
 * and the shared ones are only ceilings:
 * 1. **this browser** (first to trip): SIGNIN_BROWSER_WRONG_LIMIT wrong codes pause that browser alone — 5 minutes, doubling up to
 *    an hour. Memory only; it counts every failure the same, whatever name was typed;
 * 2. **the admin**, 3. **the name typed** (a name that is no admin's is counted exactly like one that is: nothing tells them apart)
 *    and 4. **the whole sign-in**: shared ceilings (SIGNIN_WRONG_LIMIT, SIGNIN_WRONG_LIMIT, SIGNIN_FLEET_WRONG_LIMIT wrong codes →
 *    15 minutes, doubling up to a day). A browser the admin already signed in from (its "known device" mark) is not held by these.
 * A shared count forgets after a day of no wrong codes (this browser's after an hour), and the doubling level steps down once a day has
 * passed without one. A browser with a valid known-device mark is counted by the mark instead of its cookie id (so shedding cookies
 * resets nothing) and, with every other attempt carrying a mark for the same admin, in a fifth limiter (SIGNIN_KNOWN_WRONG_LIMIT).
 * Half-way through the admin's count (and the whole sign-in's) the admins are told once per cycle.
 */
export const SIGNIN_BROWSER_WRONG_LIMIT = 5;
export const SIGNIN_BROWSER_PAUSE_MS = 5 * 60_000;
export const SIGNIN_BROWSER_PAUSE_MAX_MS = 60 * 60_000;
export const SIGNIN_WRONG_LIMIT = 10;
/**
 * The whole sign-in's ceiling: wrong codes, from every browser and every way of typing (with a name or without), before a wait that
 * doubles. Tightened from 50 to 20 when the name went away (AGEND-155, #3486): a code with no name can match any of the N admins who
 * have an app, so one wrong guess is worth N times as much to a guesser — docs/SECURITY.md has the arithmetic.
 */
export const SIGNIN_FLEET_WRONG_LIMIT = 20;
/** A shared wrong-code count is forgotten after this long without one (a slow guesser must not escape by pacing); the doubling level drops one step per SIGNIN_LEVEL_QUIET_MS without one. */
export const SIGNIN_COUNT_QUIET_MS = 24 * 60 * 60_000;
/** This browser's own count forgets sooner: it only holds that browser. */
export const SIGNIN_BROWSER_QUIET_MS = 60 * 60_000;
/** Attempts that carry a valid known-device mark of one admin count together in one more limiter, whatever cookies they send. */
export const SIGNIN_KNOWN_WRONG_LIMIT = 30;
export const SIGNIN_LEVEL_QUIET_MS = 24 * 60 * 60_000;
/** How many typed names' limiters (saved) and browsers' (memory) are remembered; the shared ceilings bound how fast they can be made. */
const SIGNIN_IDENT_MAX = 4096;
const SIGNIN_BROWSER_MAX = 4096;
/**
 * #3486: whether a chat fleet's admin may sign a new browser in with their own authenticator over a PUBLIC link too (the
 * quick or named link). The one place that says so — the owner may veto it at acceptance: set this to `false` and a sign-in over
 * a link is refused (404, as if the route were not there) while direct connections (LAN, tailnet, the owner's own proxy) keep
 * working. A web-only fleet's link is another thing: only the outside link the owner opened with "Allow connections from outside".
 */
export const TOTP_SIGNIN_OVER_PUBLIC_LINK = true;
/** #3008 review (Prism P2 1): a state that could not be saved is written again this often until it is. */
export const OUTSIDE_SAVE_RETRY_MS = 30_000;
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

/** A wrong-code limiter's state: wrong codes since the last wait, how many waits in a row, the wall clock no code is tried before, and the last wrong code's time. */
interface Lim { wrong: number; level: number; pausedUntil: number; at: number; told: boolean }
const NO_LIM: Lim = Object.freeze({ wrong: 0, level: 0, pausedUntil: 0, at: 0, told: false });
const readLimWith = (v: unknown, limit: number): Lim | undefined => {
  const l = v as Partial<Lim> | null | undefined;
  if (!l || typeof l !== "object") return undefined;
  const n = (x: unknown): number => (Number.isSafeInteger(x) && (x as number) >= 0 ? x as number : 0);
  const lim = { wrong: Math.min(n(l.wrong), limit - 1), level: Math.min(n(l.level), 32), pausedUntil: n(l.pausedUntil), at: n(l.at), told: l.told === true };
  return lim.wrong || lim.level || lim.pausedUntil ? lim : undefined;
};
/** A limiter as it reads now: the count forgotten after a quiet spell (`quietMs`), the level one step down per quiet day (after any wait ended). */
function settle(l: Lim, now: number, quietMs: number = SIGNIN_COUNT_QUIET_MS): Lim {
  const quiet = now - Math.max(l.at, l.pausedUntil);
  if (quiet < quietMs) return l;
  return { ...l, wrong: 0, told: false, level: Math.max(0, l.level - Math.floor(quiet / SIGNIN_LEVEL_QUIET_MS)) };
}
/** One more wrong code in a limiter: its new state, the wait it started (0: none), and whether it just passed `halfAt` for the first time this cycle. */
function bumpLim(l: Lim, limit: number, baseMs: number, maxMs: number, now: number, quietMs: number = SIGNIN_COUNT_QUIET_MS, halfAt = Infinity): { lim: Lim; wait: number; half: boolean } {
  const s = settle(l, now, quietMs), wrong = s.wrong + 1, half = !s.told && wrong >= halfAt;
  if (wrong < limit) return { lim: { ...s, wrong, at: now, told: s.told || half }, wait: 0, half };
  const wait = Math.min(baseMs * 2 ** s.level, maxMs);
  return { lim: { wrong: 0, level: s.level + 1, pausedUntil: now + wait, at: now, told: s.told || half }, wait, half };
}
const limitsIdle = (l: Lim, now: number): boolean => { const s = settle(l, now); return !s.wrong && !s.level && s.pausedUntil <= now; };

/**
 * One admin's authenticator: the secret, when it was set up, the last step accepted (by a confirmation, a sign-in or the
 * switch — one step, one use, whichever asked), their own "ask for my code" switch, and their own sign-in limiter (`lim`).
 */
interface Rec { secret: string; enrolledAt: number; lastStep: number; strict?: boolean; lim?: Lim; klim?: Lim }
/** The host operator's key (a web-only fleet's one admin; also a chat fleet's host session). */
export const HOST_ADMIN_KEY = "host\u0000operator";
/** An admin's key: their connection and their account on it (ids are per platform). */
export const adminKey = (adapterId: string, userId: string): string => `${adapterId}\u0000${userId}`;
/** At most this many admins have an authenticator (a chat fleet's admin lists are short). */
export const ADMIN_AUTHENTICATORS_MAX = 64;
const readRec = (t: unknown): Rec | undefined => {
  const r = t as Partial<Rec> | null | undefined;
  return r && typeof r.secret === "string" && (base32Decode(r.secret)?.length ?? 0) >= 16 && Number.isSafeInteger(r.enrolledAt)
    && Number.isSafeInteger(r.lastStep) ? { secret: r.secret, enrolledAt: r.enrolledAt as number, lastStep: r.lastStep as number, ...(r.strict === true ? { strict: true } : {}),
      ...(readLimWith(r.lim, SIGNIN_WRONG_LIMIT) ? { lim: readLimWith(r.lim, SIGNIN_WRONG_LIMIT)! } : {}),
      ...(readLimWith(r.klim, SIGNIN_KNOWN_WRONG_LIMIT) ? { klim: readLimWith(r.klim, SIGNIN_KNOWN_WRONG_LIMIT)! } : {}) } : undefined;
};

interface Saved {
  v: 1;
  /** The host operator's authenticator (what connections from outside sign in with). */
  totp?: Rec;
  /** Every other admin's own (chat fleets), by adminKey. */
  admins?: Record<string, Rec>;
  outside: boolean;
  /** #3486: the fleet-wide sign-in limiter (any admin or identifier). */
  signin?: Lim;
  /** #3486: each typed name's sign-in limiter (known or not), by sha256 of the normalized name; at most SIGNIN_IDENT_MAX, saved so a restart changes nothing. */
  idents?: Record<string, Lim>;
  /** Wrong codes since the last wait (or the last correct code). */
  wrong: number;
  /** How many waits in a row (0: none since the last correct code): the next one is TOTP_PAUSE_MS × 2^level. */
  level: number;
  /** Wall clock: no code is tried before this. */
  pausedUntil: number;
  /**
   * #3015 review (Prism P2 2, r3): the sessions authorized from outside since the last revocation of remote authority —
   * the switch turned off (by hand or its link's lifetime), the app removed or replaced. Revoking empties it; a sign-in
   * is admitted only once its handle is saved here. A go-ahead receipt of this computer's admin from outside holds only
   * while its session's handle is in it (authorityNow `outsideHandles`): no clock is involved, so neither a clock set
   * back nor a restart can bring an old one back. The newest OUTSIDE_HANDLES_MAX are kept (an older one reads as none).
   */
  handles: string[];
}

/** How many sessions from outside one generation remembers (each is a sign-in with a code; older ones read as revoked). */
export const OUTSIDE_HANDLES_MAX = 64;

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
  /** This admin's own "ask for my code to confirm from other devices" switch. */
  strict: boolean;
  outside: boolean;
  /** A wait in force now (ms left), else 0. */
  pausedForMs: number;
}

/** Whose shared limit a wrong code started, for the Notices (never part of an answer): `fleet`, or `admin` (their own or the name typed, when it is a real admin's). */
export interface SignInBegan { fleet: boolean; admin: boolean; waitMs: number; /** Half-way through the whole sign-in's / a real admin's count, first time this cycle: the admins are told once. */ halfFleet: boolean; halfAdmin: boolean }
export type SignInVerdict =
  /** `who`: the admin signed in (the one the typed name stood for; with no name, the one admin the code matched). */
  | { kind: "ok"; who: string }
  /** `skewSteps`: for a real admin, the code would have matched that many steps out — this computer's clock is likely off (logged, never answered). */
  | { kind: "wrong"; skewSteps?: number; began: SignInBegan }
  /** A wait is in force (or this wrong code started one): the same answer for every name. */
  | { kind: "paused"; retryAfterMs: number; began: SignInBegan }
  /** Right, but the step it used could not be saved: refused (else a restart would let it be used again). */
  | { kind: "unavailable" };

const blank = (): Saved => ({ v: 1, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] });

export class WebRemoteAccess {
  private state: Saved = blank();
  /** Set-ups waiting for their first code, per session handle: one session's start never replaces another's. */
  private pending = new Map<string, { secret: string; who: string; until: number }>();
  private warned = false;
  /** The state in memory is not on disk yet (a write failed): written again, by the next change or the retry timer. */
  private dirty = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** #3486: the limiter of each browser (memory only; bounded). Key: the caller's hash of its cookie id and address. */
  private browserLim = new Map<string, Lim>();
  /** #3486: what a sign-in for an identifier that is no admin's is compared with — a secret nobody has, so the work done is the same. */
  private readonly decoySecret = randomBytes(SECRET_BYTES);
  /** Test seam (AGEND-155): told of every comparison a code-only sign-in makes — the admin's key, or null for the decoy. Never set in production. */
  compareTrace?: (who: string | null) => void;

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
      const totp = readRec(v.totp);
      const admins: Record<string, Rec> = {};
      if (v.admins && typeof v.admins === "object" && !Array.isArray(v.admins)) {
        for (const [k, r] of Object.entries(v.admins).slice(0, ADMIN_AUTHENTICATORS_MAX)) { const rec = readRec(r); if (rec && k.length <= 400) admins[k] = rec; }
      }
      const count = (n: unknown): number => (Number.isSafeInteger(n) && (n as number) >= 0 ? n as number : 0);
      const signin = readLimWith(v.signin, SIGNIN_FLEET_WRONG_LIMIT);
      const idents: Record<string, Lim> = {};
      if (v.idents && typeof v.idents === "object" && !Array.isArray(v.idents)) {
        for (const [k, l] of Object.entries(v.idents).slice(-SIGNIN_IDENT_MAX)) { const lim = /^[0-9a-f]{64}$/.test(k) ? readLimWith(l, SIGNIN_WRONG_LIMIT) : undefined; if (lim) idents[k] = lim; }
      }
      this.state = { v: 1, ...(totp ? { totp } : {}), ...(Object.keys(admins).length ? { admins } : {}), ...(signin ? { signin } : {}), ...(Object.keys(idents).length ? { idents } : {}),
        // Never on without an app set up: a file that says otherwise is read as off.
        outside: v.outside === true && !!totp,
        wrong: Math.min(count(v.wrong), TOTP_WRONG_LIMIT - 1), level: Math.min(count(v.level), 32),
        // A wait never longer than the longest there is (a clock set back, or a hand edit).
        pausedUntil: Math.min(count(v.pausedUntil), this.now() + TOTP_PAUSE_MAX_MS),
        // A file without the list (or a garbled one) admits nobody: every older receipt from outside reads as none.
        handles: Array.isArray(v.handles) ? v.handles.filter((h): h is string => typeof h === "string" && /^[0-9a-f]{16}$/.test(h)).slice(-OUTSIDE_HANDLES_MAX) : [] };
    } catch {
      log.warn({ path }, "Outside connections state unreadable — off, nothing set up");
      this.state = blank();
    }
  }

  /** The keys (adminKey) of the chat admins that have an authenticator — never shown to anyone; the sign-in resolves a typed name among them. */
  get adminKeys(): string[] { return Object.keys(this.state.admins ?? {}); }

  /** One admin's record (the host operator's by default). */
  private rec(who: string): Rec | undefined { return who === HOST_ADMIN_KEY ? this.state.totp : this.state.admins?.[who]; }
  /** The state with `who`'s record set (undefined: removed). */
  private withRec(state: Saved, who: string, rec: Rec | undefined): Saved {
    if (who === HOST_ADMIN_KEY) { const { totp: _old, ...rest } = state; return { ...rest, ...(rec ? { totp: rec } : {}) }; }
    const { admins: _old, ...rest } = state, admins = { ...(state.admins ?? {}) };
    if (rec) admins[who] = rec; else delete admins[who];
    return { ...rest, ...(Object.keys(admins).length ? { admins } : {}) };
  }
  status(who: string = HOST_ADMIN_KEY): RemoteAccessStatus {
    const r = this.rec(who);
    return { enrolled: !!r, enrolledAt: r?.enrolledAt ?? null, outside: this.state.outside, strict: !!r?.strict,
      pausedForMs: Math.max(0, this.state.pausedUntil - this.now()) };
  }
  get enrolled(): boolean { return !!this.state.totp; }
  /** Whether `who` has an authenticator set up. */
  isEnrolled(who: string): boolean { return !!this.rec(who); }
  /** `who`'s own "ask for my code to confirm from other devices" switch (never on without an app). */
  strictOf(who: string): boolean { return !!this.rec(who)?.strict; }
  /**
   * #3355 review (Prism P2): which app is set up — an opaque id of this enrollment (its secret and when it was set up), null
   * when none. Replacing the app, or removing it and setting one up again, gives another id: what a code from the old one
   * authorized can tell it no longer holds. Never the secret itself.
   */
  get enrollment(): string | null { return this.enrollmentOf(HOST_ADMIN_KEY); }
  enrollmentOf(who: string): string | null {
    const t = this.rec(who);
    return t ? createHash("sha256").update(`agend-totp-enrollment\0${who}\0${t.secret}\0${t.enrolledAt}`).digest("hex").slice(0, 32) : null;
  }
  /** Turn `who`'s own switch on or off. On only with their app set up. "unsaved": in force in memory, not on disk yet. */
  setStrict(who: string, on: boolean): "ok" | "not_enrolled" | "unsaved" {
    const r = this.rec(who);
    if (!r) return "not_enrolled";
    if (!!r.strict === on && !this.dirty) return "ok";
    const { strict: _s, ...rest } = r;
    this.state = this.withRec(this.state, who, on ? { ...rest, strict: true } : rest);
    return this.flush() ? "ok" : "unsaved";
  }
  /** The sessions authorized from outside since the last revocation (their receipts hold). */
  get admitted(): ReadonlySet<string> { return new Set(this.state.handles); }

  /**
   * A session just signed in from outside: its handle is saved as admitted before it is authorized. False: not saved —
   * the sign-in must not go on (a restart would not know it, and the next revocation could not be proven to end it).
   */
  admit(handle: string): boolean {
    if (!/^[0-9a-f]{16}$/.test(handle) || !this.state.totp || !this.state.outside) return false;
    const before = this.state, wasDirty = this.dirty;
    this.state = { ...this.state, handles: [...this.state.handles.filter(h => h !== handle), handle].slice(-OUTSIDE_HANDLES_MAX) };
    if (this.flush()) return true;
    this.restore(before, wasDirty);
    return false;
  }

  /** Undo a change whose write failed, keeping whatever was already owed to the disk before it (#3015 review r3, P2 1). */
  private restore(before: Saved, wasDirty: boolean): void {
    this.state = before; this.dirty = wasDirty;
    if (!wasDirty && this.retry) { clearTimeout(this.retry); this.retry = null; }
    if (wasDirty) this.flush();                                                // still owed: keep trying (re-arms the timer)
  }
  get outside(): boolean { return this.state.outside && !!this.state.totp; }

  /** Whether `who` can have a record: they already do, or there is room (the host operator's is always allowed). */
  hasRoom(who: string): boolean {
    return who === HOST_ADMIN_KEY || !!this.state.admins?.[who] || Object.keys(this.state.admins ?? {}).length < ADMIN_AUTHENTICATORS_MAX;
  }
  /** Void the set-up the session `handle` began: its secret can never be finished (a fresh begin is the only way on). */
  cancelEnrollment(handle: string): void { this.pending.delete(handle); }
  /**
   * A new secret for the session `handle` to set up, as `who` (it replaces nothing until confirmEnrollment). Returned once:
   * the caller shows it to that session and forgets it.
   */
  beginEnrollment(handle: string, account: string, who: string = HOST_ADMIN_KEY): { secret: string; uri: string; expiresInMs: number } {
    const secret = base32Encode(randomBytes(SECRET_BYTES));
    this.pending.delete(handle);
    this.pending.set(handle, { secret, who, until: this.monotonic() + TOTP_ENROLL_TTL_MS });
    for (const [h, p] of this.pending) if (this.monotonic() > p.until) this.pending.delete(h);
    while (this.pending.size > 32) this.pending.delete(this.pending.keys().next().value!);
    return { secret, uri: otpauthUri(secret, account), expiresInMs: TOTP_ENROLL_TTL_MS };
  }

  /**
   * The first code from the app being set up, by the session that began it. "ok": it is now `who`'s (a previous one is
   * replaced, their switch kept). The host operator's also ends what was authorized from outside, and starts the limiter
   * afresh only when made on the AgEnD computer itself (`physicalHost`); another admin's does neither — enrolling must not be a way
   * to reset the fleet-wide wrong-code limit. "full": no room for another admin's record (a record is never accepted that a restart
   * would drop).
   */
  confirmEnrollment(handle: string, code: string, opts: { physicalHost?: boolean } = {}): "ok" | "wrong" | "expired" | "unsaved" | "full" {
    const p = this.pending.get(handle);
    if (!p || this.monotonic() > p.until) { this.pending.delete(handle); return "expired"; }
    // Capacity is enforced before a new record is acknowledged: one that would not survive a restart is never accepted.
    if (!this.hasRoom(p.who)) return "full";
    const step = matchTotp(base32Decode(p.secret)!, code, this.now(), -1);
    if (step === null) return "wrong";
    const before = this.state, wasDirty = this.dirty, old = this.rec(p.who);
    const rec: Rec = { secret: p.secret, enrolledAt: this.now(), lastStep: step, ...(old?.strict ? { strict: true } : {}) };
    // A new host app replaces the old one: what was authorized under it ends (the admitted sessions are forgotten). The fleet-wide
    // wrong-code pause is reset only by an enrolment made on the AgEnD computer itself (`physicalHost`, the caller's proof of where
    // it came from): the host operator's identity used remotely — a host cookie on another device — never clears it.
    const reset = p.who === HOST_ADMIN_KEY && opts.physicalHost === true;
    this.state = p.who === HOST_ADMIN_KEY ? { ...this.withRec(this.state, p.who, rec), ...(reset ? { wrong: 0, level: 0, pausedUntil: 0 } : {}), handles: [] } : this.withRec(this.state, p.who, rec);
    if (!this.flush()) {
      // Not set up: the state before stands — and if it was itself still owed to the disk (an unsaved Off), it still is.
      this.restore(before, wasDirty);
      return "unsaved";
    }
    this.pending.delete(handle);
    return "ok";
  }

  /**
   * Forget `who`'s app (their switch with it); the host operator's also turns the outside switch off and ends what was
   * authorized from outside. Nothing set up: nothing happens — in particular a set-up still waiting for its first code is left
   * alone (a recovery begun on the host must not be cleared by someone else's Remove). In force in memory at once; false: not
   * saved yet (retried — a restart before that would read the old file).
   */
  remove(who: string = HOST_ADMIN_KEY): boolean {
    if (!this.rec(who)) return true;
    this.state = who === HOST_ADMIN_KEY ? { ...blank(), ...(this.state.admins ? { admins: this.state.admins } : {}), ...(this.state.signin ? { signin: this.state.signin } : {}), ...(this.state.idents ? { idents: this.state.idents } : {}) } : this.withRec(this.state, who, undefined);
    return this.flush();
  }

  /**
   * The switch. On only with an app set up. Off ends what was authorized from outside (handles). "unsaved": in force in
   * memory, not on disk yet (retried; asking again writes it again).
   */
  setOutside(on: boolean): "ok" | "not_enrolled" | "unsaved" {
    if (on && !this.state.totp) return "not_enrolled";
    if (this.state.outside === on && !this.dirty) return "ok";
    if (this.state.outside !== on) this.state = { ...this.state, outside: on, ...(on ? {} : { handles: [] }) };
    return this.flush() ? "ok" : "unsaved";
  }

  /** A code typed at sign-in from outside. Each step is accepted once; wrong codes count toward a wait. */
  verify(code: string, who: string = HOST_ADMIN_KEY): TotpVerdict {
    const t = this.rec(who);
    if (!t) return { kind: "not_enrolled" };
    const now = this.now();
    if (now < this.state.pausedUntil) return { kind: "paused", retryAfterMs: this.state.pausedUntil - now };
    const step = matchTotp(base32Decode(t.secret)!, code, now, t.lastStep);
    if (step !== null) {
      const before = this.state;
      this.state = { ...this.withRec(this.state, who, { ...t, lastStep: step }), wrong: 0, level: 0, pausedUntil: 0 };
      if (!this.flush()) { this.state = this.withRec(before, who, { ...t, lastStep: step }); return { kind: "unavailable" }; }
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

  /**
   * #3486: a new browser signs in with an admin's OWN authenticator code. `who`: the admin the typed name resolved to (null: it
   * resolved to nobody — no such name, an admin with no app, one no longer an admin: the caller does not say which); `ident`: the
   * normalized text typed, whatever it is; `browser`: this browser's key, and whether it carries a valid "known device" mark for `who`.
   * A code is compared with that admin's secret when there is one and with a decoy secret when there is not — the same work — and
   * every failed attempt changes and saves the same counters, so neither the answer nor the time says whether a name is an admin who
   * has an app. What can pause an attempt: this browser's own limiter, the typed name's, the whole sign-in's (all three answer
   * identically for every name). The admin's own limiter is a ceiling that never changes an answer: while it is in force a
   * code is not tried and is answered as any wrong one (so using two names of one admin shows nothing either). A known device is
   * not held by the shared ceilings, only by its mark's own limiter and the known-path limiter of its admin (so shedding cookies resets nothing).
   * `browser.key` is the cookie-derived key, or — when `known` — the key of the mark itself.
   * - one use per time step: the same `lastStep` as the admin's confirmations and switch;
   * - success clears that admin's own count, that name's and this browser's — never the whole sign-in's, which only time lowers.
   */
  signIn(who: string | null, ident: string, code: string, browser: { key: string; known: boolean }): SignInVerdict {
    const now = this.now(), rec = who ? this.rec(who) : undefined, known = browser.known && !!rec;
    const identKey = createHash("sha256").update(`agend-signin-ident\0${ident}`).digest("hex");
    const fleet = settle(this.state.signin ?? NO_LIM, now), byIdent = settle(this.state.idents?.[identKey] ?? NO_LIM, now);
    const byAdmin = settle(rec?.lim ?? NO_LIM, now), byBrowser = settle(this.browserLim.get(browser.key) ?? NO_LIM, now, SIGNIN_BROWSER_QUIET_MS);
    const byKnown = settle(rec?.klim ?? NO_LIM, now);
    // A known device is held by its own mark's limiter and by the known-path limiter of its admin (every attempt carrying one of X's marks counts there), not by the shared ones.
    const waits = [byBrowser.pausedUntil, ...(known ? [byKnown.pausedUntil] : [fleet.pausedUntil, byIdent.pausedUntil])].map(p => Math.min(p - now, TOTP_PAUSE_MAX_MS));
    const wait = Math.max(...waits);
    const idle: SignInBegan = { fleet: false, admin: false, waitMs: 0, halfFleet: false, halfAdmin: false };
    if (wait > 0) return { kind: "paused", retryAfterMs: wait, began: idle };
    const secret = rec ? base32Decode(rec.secret)! : this.decoySecret;
    const step = matchTotp(secret, code, now, rec ? rec.lastStep : -1);
    const held = !known && byAdmin.pausedUntil > now;                            // the admin's ceiling: the code is not tried
    if (rec && who && step !== null && !held) {
      const before = this.state, beforeBrowser = this.browserLim.get(browser.key);
      const { lim: _lim, klim: _klim, ...clean } = rec;
      const idents = { ...(this.state.idents ?? {}) }; delete idents[identKey];
      const { idents: _idents, ...rest } = this.withRec(this.state, who, { ...clean, lastStep: step });
      this.state = { ...rest, ...(Object.keys(idents).length ? { idents } : {}) };
      this.browserLim.delete(browser.key);
      if (!this.flush()) {
        this.state = { ...this.withRec(before, who, { ...clean, lastStep: step }), ...(before.signin ? { signin: before.signin } : {}), ...(before.idents ? { idents: before.idents } : {}) };
        if (beforeBrowser) this.browserLim.set(browser.key, beforeBrowser);
        return { kind: "unavailable" };
      }
      return { kind: "ok", who };
    }
    // Wrong, or no such admin, or the admin's ceiling: the same counters, the same write — and the same clock-skew look (the decoy when there is no admin).
    const skew = totpSkew(secret, code, now);
    const f = bumpLim(fleet, SIGNIN_FLEET_WRONG_LIMIT, TOTP_PAUSE_MS, TOTP_PAUSE_MAX_MS, now, SIGNIN_COUNT_QUIET_MS, SIGNIN_FLEET_WRONG_LIMIT / 2);
    const i = bumpLim(byIdent, SIGNIN_WRONG_LIMIT, TOTP_PAUSE_MS, TOTP_PAUSE_MAX_MS, now);
    const a = rec ? bumpLim(byAdmin, SIGNIN_WRONG_LIMIT, TOTP_PAUSE_MS, TOTP_PAUSE_MAX_MS, now, SIGNIN_COUNT_QUIET_MS, SIGNIN_WRONG_LIMIT / 2) : { lim: NO_LIM, wait: 0, half: false };
    const k = known ? bumpLim(byKnown, SIGNIN_KNOWN_WRONG_LIMIT, TOTP_PAUSE_MS, TOTP_PAUSE_MAX_MS, now, SIGNIN_COUNT_QUIET_MS, SIGNIN_KNOWN_WRONG_LIMIT / 2) : { lim: byKnown, wait: 0, half: false };
    const w = bumpLim(byBrowser, SIGNIN_BROWSER_WRONG_LIMIT, SIGNIN_BROWSER_PAUSE_MS, SIGNIN_BROWSER_PAUSE_MAX_MS, now, SIGNIN_BROWSER_QUIET_MS);
    this.browserLim.delete(browser.key); this.browserLim.set(browser.key, w.lim);
    while (this.browserLim.size > SIGNIN_BROWSER_MAX) this.browserLim.delete(this.browserLim.keys().next().value!);
    const idents: Record<string, Lim> = {};
    for (const [k, l] of Object.entries(this.state.idents ?? {})) if (k !== identKey && !limitsIdle(l, now)) idents[k] = l;
    idents[identKey] = i.lim;
    for (const k of Object.keys(idents).slice(0, Math.max(0, Object.keys(idents).length - SIGNIN_IDENT_MAX))) delete idents[k];
    const { idents: _old, ...base } = rec && who ? this.withRec(this.state, who, { ...rec, lim: a.lim, ...(known ? { klim: k.lim } : {}) }) : this.state;
    this.state = { ...base, signin: f.lim, idents };
    this.flush();
    const began: SignInBegan = { fleet: f.wait > 0, admin: !!rec && (a.wait > 0 || i.wait > 0 || k.wait > 0), waitMs: Math.max(f.wait, i.wait, a.wait, k.wait),
      halfFleet: f.half, halfAdmin: !!rec && (a.half || k.half) };
    // Answered by what every name shares: this browser's wait, the name's, the whole sign-in's (a known device: its mark's and its admin's known-path wait).
    const started = Math.max(w.wait, ...(known ? [k.wait] : [f.wait, i.wait]));
    return started > 0 ? { kind: "paused", retryAfterMs: started, began } : { kind: "wrong", ...(rec && skew !== null ? { skewSteps: skew } : {}), began };
  }

  /**
   * AGEND-155 (#3486): a new browser types ONLY the code; the server works out whose it is. The code is compared with the app of EVERY
   * candidate — each one, every time, three time steps each, never stopping at a match — so the work is the same whoever (or nobody)
   * it belongs to. `candidates` is every admin with an app, `eligible` saying whether they are still an admin of their connection
   * (asked of each by the caller, so that does not stop early either); with none, one comparison with a decoy secret is made. `known`:
   * the admins whose "known device" mark this browser carries (valid as their app and the epoch stand now), `browser.key` the mark's
   * own key when there is one, else the cookie id's.
   * - exactly one candidate matches (eligible, a step newer than their `lastStep`, and — unless this
   *   browser is a known device of that admin — no wait in force for the whole sign-in): that admin is signed in and their step spent;
   * - none matches: a wrong code. The same answer — and the same counting — as a code that is right for no one;
   * - two or more match (for a right code, ≈ 3 in 10⁶ per other admin): nobody is signed in, **nothing is spent**, and it is a wrong code in every way: counted in the same
   *   counters, answered with the same 401, so neither the answer nor a count says "your code collided with someone's". Not spending the
   *   step means a collision cannot be used to burn an admin's step; the person waits for the next code.
   * Counting: a wrong code has no admin to blame, so it is counted in this browser's limiter, the whole sign-in's, and — for a known
   * device — in the known-path limiter of each admin whose mark it carries (by mark × admin, as with a name). The per-admin and per-name
   * counts do not apply to it (they stay for a request that still sends a name). What can pause an attempt: this browser's wait and the
   * whole sign-in's (a known device: its mark's and its admins' known-path waits), the same answer for any code. An admin's own ceiling
   * (started only by named attempts) does not apply here: otherwise anyone could block an admin's code-only sign-in by typing wrong
   * codes under that admin's name. A success clears that admin's own counts and
   * this browser's, never the whole sign-in's.
   */
  signInByCode(code: string, browser: { key: string }, candidates: { who: string; eligible: boolean }[], known: string[]): SignInVerdict {
    const now = this.now(), fleet = settle(this.state.signin ?? NO_LIM, now);
    const byBrowser = settle(this.browserLim.get(browser.key) ?? NO_LIM, now, SIGNIN_BROWSER_QUIET_MS);
    const marks = known.filter((w, i) => known.indexOf(w) === i && this.rec(w));
    const isKnown = marks.length > 0;
    const knownLim = (w: string): Lim => settle(this.rec(w)?.klim ?? NO_LIM, now);
    const waits = [byBrowser.pausedUntil, ...(isKnown ? marks.map(w => knownLim(w).pausedUntil) : [fleet.pausedUntil])].map(p => Math.min(p - now, TOTP_PAUSE_MAX_MS));
    const wait = Math.max(...waits);
    const idle: SignInBegan = { fleet: false, admin: false, waitMs: 0, halfFleet: false, halfAdmin: false };
    if (wait > 0) return { kind: "paused", retryAfterMs: wait, began: idle };
    // Every candidate, always: the comparison, the ceiling read and the step all happen for each, whether or not it will matter.
    const hits: string[] = [], skews: number[] = [];
    let compared = false;
    for (const c of candidates) {
      const rec = this.rec(c.who);
      if (!rec) continue;
      compared = true;
      this.compareTrace?.(c.who);
      const secret = base32Decode(rec.secret)!;
      const step = matchTotp(secret, code, now, rec.lastStep);
      // A known device is not held by the whole sign-in's wait for its own admin; for anyone else it is (the wait was not checked above).
      // The admin's own ceiling (started by named attempts) is not read: it holds the named path only.
      const open = marks.includes(c.who) || fleet.pausedUntil <= now;
      // The clock-skew look (log only) is made for every candidate, a hit or not, so the work does not depend on whether someone matched.
      const sk = totpSkew(secret, code, now);
      if (step !== null && c.eligible && open) hits.push(c.who); else if (sk !== null) skews.push(sk);
    }
    if (!compared) { this.compareTrace?.(null); matchTotp(this.decoySecret, code, now, -1); totpSkew(this.decoySecret, code, now); }
    if (hits.length === 1) {
      const who = hits[0]!, rec = this.rec(who)!;
      const step = matchTotp(base32Decode(rec.secret)!, code, now, rec.lastStep)!;
      const before = this.state, beforeBrowser = this.browserLim.get(browser.key);
      const { lim: _lim, klim: _klim, ...clean } = rec;
      this.state = this.withRec(this.state, who, { ...clean, lastStep: step });
      this.browserLim.delete(browser.key);
      if (!this.flush()) {
        this.state = this.withRec(before, who, { ...clean, lastStep: step });
        if (beforeBrowser) this.browserLim.set(browser.key, beforeBrowser);
        return { kind: "unavailable" };
      }
      return { kind: "ok", who };
    }
    // Wrong (or no one's, or a collision): the browser's own count, the whole sign-in's, a known device's known-path counts. Nothing else.
    const f = bumpLim(fleet, SIGNIN_FLEET_WRONG_LIMIT, TOTP_PAUSE_MS, TOTP_PAUSE_MAX_MS, now, SIGNIN_COUNT_QUIET_MS, SIGNIN_FLEET_WRONG_LIMIT / 2);
    const w = bumpLim(byBrowser, SIGNIN_BROWSER_WRONG_LIMIT, SIGNIN_BROWSER_PAUSE_MS, SIGNIN_BROWSER_PAUSE_MAX_MS, now, SIGNIN_BROWSER_QUIET_MS);
    this.browserLim.delete(browser.key); this.browserLim.set(browser.key, w.lim);
    while (this.browserLim.size > SIGNIN_BROWSER_MAX) this.browserLim.delete(this.browserLim.keys().next().value!);
    let next: Saved = this.state;
    const ks = marks.map(who => ({ who, ...bumpLim(knownLim(who), SIGNIN_KNOWN_WRONG_LIMIT, TOTP_PAUSE_MS, TOTP_PAUSE_MAX_MS, now, SIGNIN_COUNT_QUIET_MS, SIGNIN_KNOWN_WRONG_LIMIT / 2) }));
    for (const k of ks) next = this.withRec(next, k.who, { ...this.rec(k.who)!, klim: k.lim });
    this.state = { ...next, signin: f.lim };
    this.flush();
    const kWait = Math.max(0, ...ks.map(k => k.wait));
    const began: SignInBegan = { fleet: f.wait > 0, admin: kWait > 0, waitMs: Math.max(f.wait, kWait), halfFleet: f.half, halfAdmin: ks.some(k => k.half) };
    const started = Math.max(w.wait, isKnown ? kWait : f.wait);
    return started > 0 ? { kind: "paused", retryAfterMs: started, began }
      : { kind: "wrong", ...(hits.length === 0 && compared && skews.length === 1 ? { skewSteps: skews[0] } : {}), began };
  }

  /**
   * Saved: true. Not saved: false (warned once until it works again) — memory keeps the new state, and it is written
   * again by the next change or every OUTSIDE_SAVE_RETRY_MS until it is (#3008 review, Prism P2 1).
   */
  private flush(): boolean {
    try {
      atomicWriteFileSync(this.path, JSON.stringify(this.state) + "\n", { mode: 0o600 });
      this.warned = false; this.dirty = false;
      if (this.retry) { clearTimeout(this.retry); this.retry = null; }
      return true;
    } catch (err) {
      if (!this.warned) this.log.warn({ err: (err as Error).message, path: this.path }, "Outside connections state could not be saved; retrying");
      this.warned = true; this.dirty = true;
      if (!this.retry) {
        this.retry = setTimeout(() => { this.retry = null; if (this.dirty) this.flush(); }, OUTSIDE_SAVE_RETRY_MS);
        this.retry.unref?.();
      }
      return false;
    }
  }
  /** Whether the state in memory is still waiting to be saved. */
  get unsaved(): boolean { return this.dirty; }
  /** Fleet stop: one last write of an unsaved state, then no timer left. */
  close(): void {
    if (this.dirty) this.flush();
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
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
