/**
 * #3008 (alpha.3; decision 28c2d3a3 rule 3, the user's simplified form hmsg-33c3d609, decision 0471da59): the
 * authenticator for connections from outside — src/web-remote-access.ts.
 *  - RFC 6238 (SHA-1, 6 digits, 30 s) against the RFC's own vectors; base32 both ways;
 *  - one time step either side accepted (the leader: WSL2's clock drifts), two refused; each step once (no replay);
 *  - 5 wrong codes → a wait of 15 minutes, doubling after each further 5 up to 24 h, reset by a correct code; never a
 *    permanent lock; the wait survives a restart (and is never longer than 24 h however the file reads);
 *  - setting up: only the session that began it, within 10 minutes, with a correct first code; a new one replaces the
 *    old; the switch can be on only with an app set up (a file that says otherwise reads as off);
 *  - a correct code whose step cannot be saved is refused (a restart would let it be used again);
 *  - a wrong code that matches 2 steps out says so (the host's clock offset, logged), and is still wrong;
 *  - the secret is never in a status;
 *  - AGEND-122 (per admin): each admin has their own record and their own "ask for my code" switch (`strict`, kept in the record, so
 *    removed with the app and kept on replacement): two admins' records are independent, a verify for one never advances the other's
 *    step, a non-host enrolment does not reset the fleet-wide limiter (a host one does), `remove(who)` with no app does not clear a
 *    pending set-up, pending set-ups are per session handle, and the file round-trips with garbled admin entries ignored;
 *  - Prism's second review (round 3): the fleet-wide wrong-code pause is reset by a host-operator enrolment ONLY when it is made on the
 *    AgEnD computer (`physicalHost: true`; P5), and there is room for at most ADMIN_AUTHENTICATORS_MAX admin records — the one after
 *    that is refused ("full") before anything is written, an existing record's replacement still works, and a file with that many
 *    records reopens with every app and every switch (P4).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminKey, base32Decode, base32Encode, hotp, matchTotp, otpauthUri, outsideDuration, OUTSIDE_SAVE_RETRY_MS, totpSkew, totpStep, TOTP_PAUSE_MAX_MS, TOTP_PAUSE_MS, TOTP_WRONG_LIMIT, WebRemoteAccess, WEB_REMOTE_ACCESS_FILE, ADMIN_AUTHENTICATORS_MAX, HOST_ADMIN_KEY } from "../src/web-remote-access.js";
import { setLocale } from "../src/locale.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { chmodSync(d, 0o700); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); } setLocale("en"); vi.useRealTimers(); });
const RFC_SECRET = Buffer.from("12345678901234567890");
const quiet = { warn: () => {} };

function rig(start = 1_800_000_000_000) {
  const dir = mkdtempSync(join(tmpdir(), "agend-3008-")); dirs.push(dir);
  const clock = { wall: start, mono: 0 };
  const path = join(dir, WEB_REMOTE_ACCESS_FILE);
  const open = () => new WebRemoteAccess(path, quiet, () => clock.wall, () => clock.mono);
  const store = open();
  /** Set up with a fresh secret; returns it decoded. */
  const enroll = (s = store, handle = "h1", who?: string, opts?: { physicalHost?: boolean }) => {
    const { secret } = s.beginEnrollment(handle, "pc", who);
    const key = base32Decode(secret)!;
    expect(s.confirmEnrollment(handle, hotp(key, totpStep(clock.wall)), opts)).toBe("ok");
    clock.wall += 30_000;                                         // the next step: the code just used cannot repeat
    return key;
  };
  const code = (key: Buffer, offsetSteps = 0) => hotp(key, totpStep(clock.wall) + offsetSteps);
  return { dir, path, clock, store, open, enroll, code };
}

describe("#3008 TOTP: RFC 6238 and the window", () => {
  it("matches the RFC 6238 SHA-1 vectors (6-digit tail) and base32 round-trips", () => {
    const at = (t: number) => hotp(RFC_SECRET, Math.floor(t / 30));
    expect([59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000].map(at)).toEqual(["287082", "081804", "050471", "005924", "279037", "353130"]);
    expect(hotp(RFC_SECRET, 1, 8)).toBe("94287082");
    expect(base32Encode(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")!.equals(RFC_SECRET)).toBe(true);
    expect(base32Decode("not base32!")).toBeNull();
    expect(otpauthUri("ABC", "my pc")).toBe("otpauth://totp/AgEnD%3Amy%20pc?secret=ABC&issuer=AgEnD&algorithm=SHA1&digits=6&period=30");
  });
  it("one step either side is accepted, two are not; a step at or before `after` never is", () => {
    const now = 1_800_000_000_000, step = totpStep(now);
    for (const d of [-1, 0, 1]) expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + d), now, -1)).toBe(step + d);
    for (const d of [-2, 2]) expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + d), now, -1)).toBeNull();
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step), now, step)).toBeNull();              // used already
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, step)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, ` ${hotp(RFC_SECRET, step).slice(0, 3)} ${hotp(RFC_SECRET, step).slice(3)} `, now, -1)).toBe(step);
    expect(matchTotp(RFC_SECRET, "12345", now, -1)).toBeNull();
    // Diagnosis only: 2 steps out is named (positive: the phone ahead), inside the window it is not.
    expect([totpSkew(RFC_SECRET, hotp(RFC_SECRET, step + 2), now), totpSkew(RFC_SECRET, hotp(RFC_SECRET, step - 2), now),
      totpSkew(RFC_SECRET, hotp(RFC_SECRET, step + 1), now)]).toEqual([2, -2, null]);
  });
});

describe("#3008 TOTP: the store", () => {
  it("a sign-in code is accepted once; the next step's is accepted; the file is 0600 and the status never holds the secret", () => {
    const r = rig(), key = r.enroll();
    const c = r.code(key);
    expect(r.store.verify(c)).toEqual({ kind: "ok" });
    expect(r.store.verify(c).kind).toBe("wrong");                                        // replay
    r.clock.wall += 30_000;
    expect(r.store.verify(r.code(key))).toEqual({ kind: "ok" });
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    const status = JSON.stringify(r.store.status());
    expect(status).not.toContain(base32Encode(key));
    expect(r.store.status()).toMatchObject({ enrolled: true, outside: false, pausedForMs: 0 });
    // A restart keeps the last step: the code used before it is still refused.
    expect(r.open().verify(r.code(key)).kind).toBe("wrong");
  });
  it("5 wrong → 15 minutes; then 30 minutes, 1 h … capped at 24 h; a correct code resets it; never a permanent lock", () => {
    const r = rig(), key = r.enroll();
    const waits: number[] = [];
    for (let round = 0; round < 9; round++) {
      for (let n = 1; n <= 4; n++) expect(r.store.verify("000000")).toMatchObject({ kind: "wrong", paused: false });
      const fifth = r.store.verify("000000");
      expect(fifth).toMatchObject({ kind: "wrong", paused: true, wrong: 5 });
      waits.push((fifth as { retryAfterMs: number }).retryAfterMs);
      // Paused: even the right code waits (and does not count).
      expect(r.store.verify(r.code(key))).toMatchObject({ kind: "paused" });
      r.clock.wall += waits.at(-1)!;
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 64, 96, 96].map(m => Math.min(m * TOTP_PAUSE_MS, TOTP_PAUSE_MAX_MS)));
    expect(TOTP_PAUSE_MS).toBe(15 * 60_000);
    expect(r.store.verify(r.code(key))).toEqual({ kind: "ok" });                          // the wait over: the right code works
    for (let n = 1; n <= 4; n++) r.store.verify("000000");
    expect(r.store.verify("000000")).toMatchObject({ paused: true, retryAfterMs: TOTP_PAUSE_MS });   // reset to 15 minutes
  });
  it("a wait survives a restart, and is never read longer than 24 h", () => {
    const r = rig(); r.enroll();
    for (let n = 1; n <= 5; n++) r.store.verify("000000");
    expect(r.open().status().pausedForMs).toBe(TOTP_PAUSE_MS);
    const saved = JSON.parse(readFileSync(r.path, "utf8"));
    writeFileSync(r.path, JSON.stringify({ ...saved, pausedUntil: r.clock.wall + 10 * TOTP_PAUSE_MAX_MS }));
    expect(r.open().status().pausedForMs).toBe(TOTP_PAUSE_MAX_MS);
  });
  it("setting up: only the session that began it, within 10 minutes, with a right code; a new app replaces the old", () => {
    const r = rig();
    const { secret } = r.store.beginEnrollment("h1", "pc"), key = base32Decode(secret)!;
    expect(r.store.confirmEnrollment("other", r.code(key))).toBe("expired");
    expect(r.store.confirmEnrollment("h1", "000000")).toBe("wrong");
    expect(r.store.enrolled).toBe(false);
    r.clock.mono += 10 * 60_000 + 1;
    expect(r.store.confirmEnrollment("h1", r.code(key))).toBe("expired");
    const old = r.enroll();
    const fresh = r.enroll(r.store, "h2");
    expect(r.store.verify(r.code(old)).kind).toBe("wrong");
    expect(r.store.verify(r.code(fresh))).toEqual({ kind: "ok" });
  });
  it("the switch: on only with an app set up; removal turns it off; a file that says on without an app reads off", () => {
    const r = rig();
    expect(r.store.setOutside(true)).toBe("not_enrolled");
    r.enroll();
    expect([r.store.setOutside(true), r.store.outside, r.open().outside]).toEqual(["ok", true, true]);
    r.store.remove();
    expect([r.store.enrolled, r.store.outside, r.open().outside]).toEqual([false, false, false]);
    writeFileSync(r.path, JSON.stringify({ v: 1, outside: true, wrong: 0, level: 0, pausedUntil: 0 }));
    expect(r.open().outside).toBe(false);
    writeFileSync(r.path, "{not json");
    expect(r.open().status()).toMatchObject({ enrolled: false, outside: false });
  });
  it("a right code whose step cannot be saved is refused, and still cannot be used again in this run", () => {
    const r = rig(), key = r.enroll();
    rmSync(r.dir, { recursive: true, force: true });                                      // the folder gone: nothing can be written
    const c = r.code(key);
    expect(r.store.verify(c)).toEqual({ kind: "unavailable" });
    expect(r.store.verify(c).kind).toBe("wrong");
  });
  it("a wrong code 2 steps out names the offset (positive: the phone ahead) and is still wrong", () => {
    const r = rig(), key = r.enroll();
    expect(r.store.verify(r.code(key, 2))).toEqual({ kind: "wrong", paused: false, skewSteps: 2 });
    expect(r.store.verify(r.code(key, -2))).toEqual({ kind: "wrong", paused: false, skewSteps: -2 });
    expect(r.store.verify("123123")).toMatchObject({ kind: "wrong", skewSteps: null });
  });
  it("a wait as words, in the fleet's language", () => {
    expect([outsideDuration(TOTP_PAUSE_MS), outsideDuration(60_000), outsideDuration(60 * 60_000), outsideDuration(2 * 60 * 60_000), outsideDuration(61 * 60_000)])
      .toEqual(["15 minutes", "1 minute", "1 hour", "2 hours", "2 hours"]);
    setLocale("zh-TW");
    expect([outsideDuration(TOTP_PAUSE_MS), outsideDuration(2 * 60 * 60_000)]).toEqual(["15 分鐘", "2 小時"]);
  });
  it("#3015 review 1: Off and Remove that cannot be saved say so, are in force at once, and are written again (asked again, or by the timer)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r = rig(); r.enroll(); r.store.setOutside(true);
    chmodSync(r.dir, 0o500);                                                              // the disk refuses writes
    expect([r.store.setOutside(false), r.store.outside, r.store.unsaved]).toEqual(["unsaved", false, true]);
    expect(r.open().outside).toBe(true);                                                  // what a restart now would read
    expect(r.store.setOutside(false)).toBe("unsaved");                                    // asked again: written again (still refused)
    chmodSync(r.dir, 0o700);
    expect(r.store.setOutside(false)).toBe("ok");                                         // asked again once it works: saved
    expect(r.open().outside).toBe(false);
    // Remove: refused → in force → the timer writes it.
    r.store.setOutside(true);
    chmodSync(r.dir, 0o500);
    expect([r.store.remove(), r.store.enrolled]).toEqual([false, false]);
    expect(r.open().enrolled).toBe(true);
    chmodSync(r.dir, 0o700);
    vi.advanceTimersByTime(OUTSIDE_SAVE_RETRY_MS);
    expect([r.store.unsaved, r.open().enrolled, r.open().outside]).toEqual([false, false, false]);
  });
  it("#3015 review 2 (r3): sessions admitted from outside are forgotten by Off, a new app and removal — on the clock's word never; On admits none back", () => {
    const r = rig(), H1 = "a".repeat(16), H2 = "b".repeat(16), H3 = "c".repeat(16);
    r.enroll();
    expect(r.store.admit(H1)).toBe(false);                                                // the switch off: nobody is admitted
    r.store.setOutside(true);
    expect([r.store.admit(H1), r.store.admitted.has(H1), r.open().admitted.has(H1)]).toEqual([true, true, true]);
    r.clock.wall -= 60_000;                                                              // the clock set back meanwhile
    r.store.setOutside(false);
    expect(r.store.admitted.size).toBe(0);
    r.store.setOutside(true);
    expect([r.store.admitted.has(H1), r.open().admitted.has(H1)]).toEqual([false, false]);   // On again: never back
    r.store.admit(H2);
    r.clock.wall -= 60_000;
    r.enroll();                                                                          // a new app (the clock behind)
    expect([r.store.admitted.has(H2), r.open().admitted.has(H2)]).toEqual([false, false]);
    r.store.setOutside(true); r.store.admit(H3);
    expect(r.store.admitted.has(H3)).toBe(true);                                         // a freshly admitted control
    r.store.remove();
    expect([r.store.admitted.size, r.open().admitted.size]).toEqual([0, 0]);
  });
  it("#3015 review 2 (r3): a receipt from outside holds only while its session is admitted — the clock set back before a new app changes nothing", async () => {
    const { authorityNow } = await import("../src/authority/web-authority.js");
    const r = rig(), H = "d".repeat(16);
    r.enroll(); r.store.setOutside(true); r.store.admit(H);
    const receipt = { kind: "web-verified", actor: { adapter_id: "host", user_id: "operator" }, authority_epoch: 3,
      session: { handle: H, peer: "quick_link", signed_in_at: new Date(r.clock.wall).toISOString(), authorized_at: new Date(r.clock.wall).toISOString() } } as never;
    const reads = () => (authorityNow(receipt, { enabled: true, loopbackOnly: false, namedLink: false, quickLink: false, epoch: 3, outside: r.store.outside, outsideHandles: r.store.admitted }) as { kind: string }).kind;
    expect(reads()).toBe("web-verified");
    r.clock.wall -= 60_000;
    r.enroll();
    r.store.setOutside(true);
    expect(reads()).toBe("none");
    expect(new WebRemoteAccess(r.path, quiet, () => r.clock.wall).admitted.has(H)).toBe(false);   // …and after a restart
  });
  it("#3015 review 1 (r3): a failed new app keeps an Off still owed to the disk owed — it is written once writing works; a clean state stays clean", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r = rig(); r.enroll(); r.store.setOutside(true);
    chmodSync(r.dir, 0o500);
    expect(r.store.setOutside(false)).toBe("unsaved");
    const { secret } = r.store.beginEnrollment("h1", "pc");
    expect(r.store.confirmEnrollment("h1", hotp(base32Decode(secret)!, totpStep(r.clock.wall)))).toBe("unsaved");
    expect([r.store.unsaved, r.store.outside]).toEqual([true, false]);                    // still owed, still off
    chmodSync(r.dir, 0o700);
    vi.advanceTimersByTime(OUTSIDE_SAVE_RETRY_MS);
    expect([r.store.unsaved, r.open().outside]).toEqual([false, false]);
    // Control: nothing owed before → a failed new app leaves nothing owed (and no timer writing it).
    const c = rig(); c.enroll();
    chmodSync(c.dir, 0o500);
    const b = c.store.beginEnrollment("h1", "pc");
    expect(c.store.confirmEnrollment("h1", hotp(base32Decode(b.secret)!, totpStep(c.clock.wall)))).toBe("unsaved");
    expect(c.store.unsaved).toBe(false);
    chmodSync(c.dir, 0o700);
  });
  it("#3015 review r3: a sign-in whose handle cannot be saved is not admitted (and the state before is what stays)", () => {
    const r = rig(); r.enroll(); r.store.setOutside(true);
    chmodSync(r.dir, 0o500);
    expect([r.store.admit("e".repeat(16)), r.store.admitted.has("e".repeat(16)), r.store.unsaved]).toEqual([false, false, false]);
    chmodSync(r.dir, 0o700);
  });
});

// ── AGEND-122 (per admin) ──
const A = adminKey("a", "100"), B = adminKey("a", "200");
describe("AGEND-122: each admin's own authenticator and switch", () => {
  it("two admins' records are independent: their own secret, their own app (a code of one is wrong for the other), and the host operator's is a third", () => {
    const r = rig(), host = r.enroll(r.store, "hh"), a = r.enroll(r.store, "ha", A), b = r.enroll(r.store, "hb", B);
    expect([r.store.isEnrolled(HOST_ADMIN_KEY), r.store.isEnrolled(A), r.store.isEnrolled(B), r.store.isEnrolled(adminKey("a", "300"))]).toEqual([true, true, true, false]);
    expect(r.store.verify(r.code(a), B).kind).toBe("wrong");
    expect(r.store.verify(r.code(host), A).kind).toBe("wrong");
    expect(r.store.verify(r.code(a), A)).toEqual({ kind: "ok" });
    expect(r.store.verify(r.code(b), B)).toEqual({ kind: "ok" });
    expect(r.store.verify(r.code(host))).toEqual({ kind: "ok" });                         // no `who`: the host operator's
    expect(r.store.verify("000000", adminKey("a", "300"))).toEqual({ kind: "not_enrolled" });
    // Each is its own enrolment id (and never the secret).
    const ids = [r.store.enrollmentOf(HOST_ADMIN_KEY), r.store.enrollmentOf(A), r.store.enrollmentOf(B)];
    expect(new Set(ids).size).toBe(3);
    expect(r.store.enrollmentOf(adminKey("a", "300"))).toBeNull();
    expect(r.store.enrollment).toBe(ids[0]);
    expect(JSON.stringify(r.store.status(A))).not.toContain(base32Encode(a));
  });
  it("a verify for one admin never advances another's lastStep: the same time step still works for each app once", () => {
    const r = rig(), a = r.enroll(r.store, "ha", A), b = r.enroll(r.store, "hb", B);
    const ca = r.code(a), cb = r.code(b);
    expect(r.store.verify(ca, A)).toEqual({ kind: "ok" });
    expect(r.store.verify(ca, A).kind).toBe("wrong");                                     // A's step is spent…
    expect(r.store.verify(cb, B)).toEqual({ kind: "ok" });                                // …B's is not
    const saved = JSON.parse(readFileSync(r.path, "utf8"));
    expect(saved.admins[A].lastStep).toBeGreaterThan(0);
    expect(saved.admins[A].lastStep).toBe(saved.admins[B].lastStep);                      // same step, each kept in its own record
    r.clock.wall += 30_000;
    const reopened = r.open();
    expect([reopened.verify(r.code(a), A).kind, reopened.verify(r.code(b), B).kind]).toEqual(["ok", "ok"]);
    expect(r.open().verify(ca, A).kind).toBe("wrong");                                    // and the spent one stays spent after a restart
  });
  it("the strict switch lives in the record: off by default, on only with the app, removed with the app, kept on replacement, never the host's for another admin", () => {
    const r = rig();
    expect([r.store.strictOf(A), r.store.setStrict(A, true), r.store.strictOf(A)]).toEqual([false, "not_enrolled", false]);   // never on without an app
    r.enroll(r.store, "ha", A); r.enroll(r.store, "hb", B); r.enroll(r.store, "hh");
    expect([r.store.strictOf(A), r.store.status(A).strict]).toEqual([false, false]);
    expect(r.store.setStrict(A, true)).toBe("ok");
    expect([r.store.strictOf(A), r.store.strictOf(B), r.store.strictOf(HOST_ADMIN_KEY), r.store.status(A).strict, r.store.status(B).strict]).toEqual([true, false, false, true, false]);
    expect(JSON.parse(readFileSync(r.path, "utf8")).admins[A].strict).toBe(true);        // in the record itself
    expect(JSON.parse(readFileSync(r.path, "utf8")).admins[B].strict).toBeUndefined();
    expect([r.open().strictOf(A), r.open().strictOf(B)]).toEqual([true, false]);          // survives a restart
    // Replacement keeps it (a new secret, the switch stays); a different admin's replacement does not touch it.
    const before = r.store.enrollmentOf(A);
    r.enroll(r.store, "ha2", A);
    expect([r.store.strictOf(A), r.store.enrollmentOf(A) !== before]).toEqual([true, true]);
    r.enroll(r.store, "hb2", B);
    expect(r.store.strictOf(A)).toBe(true);
    // Off, and on the host operator's own record the same.
    expect([r.store.setStrict(A, false), r.store.strictOf(A), r.open().strictOf(A)]).toEqual(["ok", false, false]);
    expect(JSON.parse(readFileSync(r.path, "utf8")).admins[A].strict).toBeUndefined();
    expect([r.store.setStrict(HOST_ADMIN_KEY, true), r.store.strictOf(HOST_ADMIN_KEY), r.open().strictOf(HOST_ADMIN_KEY), r.store.strictOf(A)]).toEqual(["ok", true, true, false]);
    expect(JSON.parse(readFileSync(r.path, "utf8")).totp.strict).toBe(true);
    // Removed with the app: gone, and a new app starts with it off.
    r.store.setStrict(A, true);
    expect(r.store.remove(A)).toBe(true);
    expect([r.store.strictOf(A), r.store.isEnrolled(A), r.open().strictOf(A)]).toEqual([false, false, false]);
    r.enroll(r.store, "ha3", A);
    expect(r.store.strictOf(A)).toBe(false);
    r.store.remove();                                                                     // the host operator's too
    expect([r.store.strictOf(HOST_ADMIN_KEY), r.store.strictOf(B)]).toEqual([false, false]);
  });
  it("removing one admin's app leaves everyone else's, and the host operator's removal leaves the other admins' (it only ends the outside switch)", () => {
    const r = rig(); r.enroll(r.store, "hh"); r.enroll(r.store, "ha", A); r.enroll(r.store, "hb", B); r.store.setOutside(true);
    expect(r.store.remove(A)).toBe(true);
    expect([r.store.isEnrolled(A), r.store.isEnrolled(B), r.store.isEnrolled(HOST_ADMIN_KEY), r.store.outside]).toEqual([false, true, true, true]);
    expect(r.store.remove()).toBe(true);
    expect([r.store.isEnrolled(B), r.store.isEnrolled(HOST_ADMIN_KEY), r.store.outside, r.open().isEnrolled(B), r.open().outside]).toEqual([true, false, false, true, false]);
  });
  it("a non-host enrolment does not reset the fleet-wide limiter or end sessions from outside; the host operator's does", () => {
    const r = rig(), H = "a".repeat(16);
    r.enroll(); r.store.setOutside(true); r.store.admit(H);
    for (let n = 1; n < TOTP_WRONG_LIMIT; n++) r.store.verify("000000");                  // 4 wrong, one short of a wait
    r.enroll(r.store, "ha", A);                                                           // another admin sets up their app
    expect(r.store.admitted.has(H)).toBe(true);                                           // sessions from outside stay
    expect(r.store.verify("000000")).toMatchObject({ kind: "wrong", paused: true });      // the count was not reset: the 5th wrong pauses
    expect(r.store.status().pausedForMs).toBe(TOTP_PAUSE_MS);
    r.clock.wall += TOTP_PAUSE_MS;
    // The wait is fleet-wide: it also holds for an admin's own app, and a replacement by that admin does not lift it.
    for (let n = 1; n < TOTP_WRONG_LIMIT; n++) r.store.verify("000000", A);
    r.enroll(r.store, "ha2", A);
    expect(r.store.verify("000000", A)).toMatchObject({ kind: "wrong", paused: true, retryAfterMs: 2 * TOTP_PAUSE_MS });
    expect(r.store.verify(r.code(base32Decode(JSON.parse(readFileSync(r.path, "utf8")).admins[A].secret)!), A).kind).toBe("paused");
    // Control: the host operator's enrolment made on the AgEnD computer starts the limiter afresh and forgets the admitted sessions.
    r.enroll(r.store, "hp", undefined, { physicalHost: true });
    expect([r.store.status().pausedForMs, r.store.admitted.size]).toEqual([0, 0]);
    for (let n = 1; n < TOTP_WRONG_LIMIT; n++) r.store.verify("000000", A);
    expect(r.store.verify("000000", A)).toMatchObject({ paused: true, retryAfterMs: TOTP_PAUSE_MS });   // back to the first wait
  });
  it("P5: a host-operator enrolment used REMOTELY (physicalHost false or absent) never clears the fleet-wide pause (wrong/level/pausedUntil), yet still ends the admitted outside sessions; a physical-host one resets all three", () => {
    const r = rig(), H = "a".repeat(16);
    r.enroll(); r.store.setOutside(true);
    const pause = () => { for (let n = 1; n <= TOTP_WRONG_LIMIT; n++) r.store.verify("000000"); };
    r.store.admit(H);
    pause();
    expect(r.store.status().pausedForMs).toBe(TOTP_PAUSE_MS);
    expect(r.store.verify("000000")).toMatchObject({ kind: "paused" });
    const stateOf = () => { const s = JSON.parse(readFileSync(r.path, "utf8")); return [s.wrong, s.level, s.pausedUntil, s.handles.length]; };
    const paused = stateOf();
    expect(paused).toEqual([0, 1, r.clock.wall + TOTP_PAUSE_MS, 1]);
    // A host enrolment with no proof of being on the computer (absent, then false), twice: nothing of the limiter moves, the sessions end.
    for (const opts of [undefined, { physicalHost: false }]) {
      r.store.admit(H);
      r.enroll(r.store, "hr", undefined, opts);
      const [wrong, level, until, handles] = stateOf();
      expect([wrong, level, until, handles]).toEqual([paused[0], paused[1], paused[2], 0]);   // pause fields untouched in the file…
      expect(r.open().status().pausedForMs).toBe(paused[2]! - r.clock.wall);                  // …and after a restart
      expect(r.store.verify("000000")).toMatchObject({ kind: "paused" });                     // A (any app) is still paused
      expect(r.store.verify("000000", A)).toMatchObject({ kind: "not_enrolled" });
    }
    // Control: a physical-host enrolment resets the fleet-wide pause and the admitted sessions.
    r.store.admit(H);
    r.enroll(r.store, "hp", undefined, { physicalHost: true });
    expect(stateOf()).toEqual([0, 0, 0, 0]);
    expect(r.store.status().pausedForMs).toBe(0);
    // A non-host admin's enrolment never resets it, even when asserted as physical (it is the host operator's proof only).
    pause();
    expect(r.store.status().pausedForMs).toBeGreaterThan(0);
    const before = stateOf();
    r.enroll(r.store, "ha", A, { physicalHost: true });
    expect(stateOf()).toEqual(before);
    expect(r.store.status().pausedForMs).toBeGreaterThan(0);
  });
  it("remove(who) with no app does nothing: a pending set-up (the host's recovery) is not cleared by another admin's Remove, and nothing is written", () => {
    const r = rig(); r.enroll();
    const { secret } = r.store.beginEnrollment("recover", "pc", A), pending = base32Decode(secret)!;
    expect(r.store.remove(B)).toBe(true);                                                 // B has no app
    expect(r.store.remove(A)).toBe(true);                                                 // neither has A (still being set up)
    expect(r.store.isEnrolled(HOST_ADMIN_KEY)).toBe(true);
    expect(r.store.confirmEnrollment("recover", r.code(pending))).toBe("ok");             // the set-up begun before still finishes
    expect(r.store.isEnrolled(A)).toBe(true);
    // The same with the host's: Remove with no host app leaves a begun set-up alone.
    const q = rig(), begun = q.store.beginEnrollment("mine", "pc");
    expect(q.store.remove()).toBe(true);
    expect(q.store.confirmEnrollment("mine", hotp(base32Decode(begun.secret)!, totpStep(q.clock.wall)))).toBe("ok");
  });
  it("pending set-ups are per session handle: a second session's begin does not replace the first's, each finishes as the admin it began for, and a handle's own begin replaces its own", () => {
    const r = rig();
    const first = r.store.beginEnrollment("s1", "pc", A), second = r.store.beginEnrollment("s2", "pc", B);
    expect(first.secret).not.toBe(second.secret);
    expect(r.store.confirmEnrollment("s2", r.code(base32Decode(second.secret)!))).toBe("ok");
    expect([r.store.isEnrolled(B), r.store.isEnrolled(A)]).toEqual([true, false]);
    expect(r.store.confirmEnrollment("s1", r.code(base32Decode(first.secret)!))).toBe("ok");   // s1's still waits, and sets up A (who it began for)
    expect([r.store.isEnrolled(A), r.store.verify(r.code(base32Decode(first.secret)!, 1), A).kind]).toEqual([true, "ok"]);
    // The same handle beginning again replaces its own earlier secret only.
    const again = r.store.beginEnrollment("s3", "pc", A), newer = r.store.beginEnrollment("s3", "pc", A);
    expect(r.store.confirmEnrollment("s3", r.code(base32Decode(again.secret)!))).toBe("wrong");
    expect(r.store.confirmEnrollment("s3", r.code(base32Decode(newer.secret)!))).toBe("ok");
    // A pending set-up cannot be finished by another handle, or after its ten minutes.
    const late = r.store.beginEnrollment("s4", "pc", B);
    expect(r.store.confirmEnrollment("s5", r.code(base32Decode(late.secret)!))).toBe("expired");
    r.clock.mono += 10 * 60_000 + 1;
    expect(r.store.confirmEnrollment("s4", r.code(base32Decode(late.secret)!))).toBe("expired");
  });
  it("the file round-trips: every admin's record and switch come back after a restart; garbled admin entries are ignored (the rest read), and none is read into the host's", () => {
    const r = rig(); r.enroll(); r.enroll(r.store, "ha", A); r.enroll(r.store, "hb", B);
    r.store.setStrict(B, true); r.store.setStrict(HOST_ADMIN_KEY, true);
    const back = r.open();
    expect([back.isEnrolled(HOST_ADMIN_KEY), back.isEnrolled(A), back.isEnrolled(B), back.strictOf(HOST_ADMIN_KEY), back.strictOf(A), back.strictOf(B)]).toEqual([true, true, true, true, false, true]);
    expect([back.enrollmentOf(A), back.enrollmentOf(B)]).toEqual([r.store.enrollmentOf(A), r.store.enrollmentOf(B)]);
    // Garbled: a secret too short, a missing field, a non-object, a string where a number goes, a non-boolean switch.
    const saved = JSON.parse(readFileSync(r.path, "utf8")), good = saved.admins[B];
    const noise: Record<string, unknown> = { [adminKey("a", "1")]: { ...good, secret: "AAAA" }, [adminKey("a", "2")]: { secret: good.secret },
      [adminKey("a", "3")]: "nope", [adminKey("a", "4")]: null, [adminKey("a", "5")]: { ...good, enrolledAt: "1" }, [adminKey("a", "6")]: { ...good, lastStep: 1.5 },
      [adminKey("a", "7")]: { ...good, strict: "yes" }, ["x".repeat(401)]: good };
    writeFileSync(r.path, JSON.stringify({ ...saved, admins: { ...saved.admins, ...noise } }));
    const garbled = r.open();
    expect([1, 2, 3, 4, 5, 6].map(n => garbled.isEnrolled(adminKey("a", String(n))))).toEqual(Array(6).fill(false));
    expect([garbled.isEnrolled("x".repeat(401)), garbled.isEnrolled(A), garbled.isEnrolled(B), garbled.strictOf(B), garbled.isEnrolled(HOST_ADMIN_KEY)]).toEqual([false, true, true, true, true]);
    expect([garbled.isEnrolled(adminKey("a", "7")), garbled.strictOf(adminKey("a", "7"))]).toEqual([true, false]);   // a strict that is not `true` reads as off
    // `admins` that is not an object, or a list, is no admins; the host's own record still reads.
    for (const admins of ["x", [good], 7, null]) { writeFileSync(r.path, JSON.stringify({ ...saved, admins })); const o = r.open(); expect([o.isEnrolled(A), o.isEnrolled(HOST_ADMIN_KEY)]).toEqual([false, true]); }
    // A host record that is garbled is no host app (the outside switch reads off), the admins' are unaffected.
    writeFileSync(r.path, JSON.stringify({ ...saved, totp: { ...saved.totp, secret: "AAAA" }, outside: true }));
    const noHost = r.open();
    expect([noHost.isEnrolled(HOST_ADMIN_KEY), noHost.outside, noHost.isEnrolled(A), noHost.strictOf(B)]).toEqual([false, false, true, true]);
    // An older file (no `admins`, no `strict`) reads as the host's app with the switch off.
    writeFileSync(r.path, JSON.stringify({ v: 1, totp: { secret: saved.totp.secret, enrolledAt: 1, lastStep: 0 }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }));
    const old = r.open();
    expect([old.isEnrolled(HOST_ADMIN_KEY), old.strictOf(HOST_ADMIN_KEY), old.isEnrolled(A)]).toEqual([true, false, false]);
  });
  it("at most ADMIN_AUTHENTICATORS_MAX admins are read from a file (a chat fleet's admin list is short)", () => {
    const r = rig(); r.enroll(r.store, "ha", A);
    const saved = JSON.parse(readFileSync(r.path, "utf8")), rec = saved.admins[A], admins: Record<string, unknown> = {};
    for (let n = 0; n < ADMIN_AUTHENTICATORS_MAX + 5; n++) admins[adminKey("a", `u${n}`)] = rec;
    writeFileSync(r.path, JSON.stringify({ ...saved, admins }));
    const o = r.open();
    expect([o.isEnrolled(adminKey("a", "u0")), o.isEnrolled(adminKey("a", `u${ADMIN_AUTHENTICATORS_MAX - 1}`)), o.isEnrolled(adminKey("a", `u${ADMIN_AUTHENTICATORS_MAX}`))]).toEqual([true, true, false]);
  });
  it("P4: with ADMIN_AUTHENTICATORS_MAX admin records the next NEW admin is refused (\"full\") before anything is written; an existing record's replacement still works; a reopen keeps every app and every switch", () => {
    const r = rig(); r.enroll(); r.enroll(r.store, "ha", A);
    const saved = JSON.parse(readFileSync(r.path, "utf8")), rec = saved.admins[A], admins: Record<string, unknown> = {};
    const key = (n: number) => adminKey("a", `u${n}`);
    for (let n = 0; n < ADMIN_AUTHENTICATORS_MAX; n++) admins[key(n)] = n % 2 ? { ...rec, strict: true } : rec;    // a mix of switches
    writeFileSync(r.path, JSON.stringify({ ...saved, admins }));
    const full = r.open(), file = () => readFileSync(r.path, "utf8");
    expect([...Array(ADMIN_AUTHENTICATORS_MAX).keys()].every(n => full.isEnrolled(key(n)) && full.strictOf(key(n)) === (n % 2 === 1))).toBe(true);
    const before = file(), NEW = adminKey("a", "newcomer");
    // Room: the host always has it, an existing admin has it, a new one does not (and positive control: with 63 records they do).
    expect([full.hasRoom(HOST_ADMIN_KEY), full.hasRoom(key(0)), full.hasRoom(NEW)]).toEqual([true, true, false]);
    const { secret } = full.beginEnrollment("hn", "pc", NEW);
    expect(full.confirmEnrollment("hn", hotp(base32Decode(secret)!, totpStep(r.clock.wall)))).toBe("full");
    expect([full.isEnrolled(NEW), file()]).toEqual([false, before]);                       // nothing saved, nothing changed
    const again = r.open();
    expect([again.isEnrolled(NEW), ...[...Array(ADMIN_AUTHENTICATORS_MAX).keys()].map(n => again.isEnrolled(key(n)) && again.strictOf(key(n)) === (n % 2 === 1))]).toEqual([false, ...Array(ADMIN_AUTHENTICATORS_MAX).fill(true)]);
    // An existing record's replacement still works at the cap, keeps its switch, and the count stays.
    const old = full.enrollmentOf(key(1));
    const rep = full.beginEnrollment("hr", "pc", key(1));
    expect(full.confirmEnrollment("hr", hotp(base32Decode(rep.secret)!, totpStep(r.clock.wall)))).toBe("ok");
    expect([full.enrollmentOf(key(1)) !== old, full.strictOf(key(1)), Object.keys(JSON.parse(file()).admins).length]).toEqual([true, true, ADMIN_AUTHENTICATORS_MAX]);
    // The host operator's own set-up never counts against the cap, and removing one record makes room for the newcomer.
    r.clock.wall += 30_000;
    expect(full.remove(key(0))).toBe(true);
    const retry = full.beginEnrollment("hn2", "pc", NEW);
    expect(full.confirmEnrollment("hn2", hotp(base32Decode(retry.secret)!, totpStep(r.clock.wall)))).toBe("ok");
    expect([full.isEnrolled(NEW), r.open().isEnrolled(NEW), Object.keys(JSON.parse(file()).admins).length]).toEqual([true, true, ADMIN_AUTHENTICATORS_MAX]);
  });
  it("an admin's change that cannot be saved is in force at once and written again (their switch and their app), like the host's", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r = rig(); r.enroll(r.store, "ha", A);
    chmodSync(r.dir, 0o500);
    expect([r.store.setStrict(A, true), r.store.strictOf(A), r.store.unsaved]).toEqual(["unsaved", true, true]);
    expect(r.open().strictOf(A)).toBe(false);                                             // what a restart now would read
    chmodSync(r.dir, 0o700);
    vi.advanceTimersByTime(OUTSIDE_SAVE_RETRY_MS);
    expect([r.store.unsaved, r.open().strictOf(A)]).toEqual([false, true]);
  });
});
