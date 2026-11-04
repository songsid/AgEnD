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
 *  - the secret is never in a status.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base32Decode, base32Encode, hotp, matchTotp, otpauthUri, outsideDuration, totpSkew, totpStep, TOTP_PAUSE_MAX_MS, TOTP_PAUSE_MS, WebRemoteAccess, WEB_REMOTE_ACCESS_FILE } from "../src/web-remote-access.js";
import { setLocale } from "../src/locale.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); setLocale("en"); });
const RFC_SECRET = Buffer.from("12345678901234567890");
const quiet = { warn: () => {} };

function rig(start = 1_800_000_000_000) {
  const dir = mkdtempSync(join(tmpdir(), "agend-3008-")); dirs.push(dir);
  const clock = { wall: start, mono: 0 };
  const path = join(dir, WEB_REMOTE_ACCESS_FILE);
  const open = () => new WebRemoteAccess(path, quiet, () => clock.wall, () => clock.mono);
  const store = open();
  /** Set up with a fresh secret; returns it decoded. */
  const enroll = (s = store, handle = "h1") => {
    const { secret } = s.beginEnrollment(handle, "pc");
    const key = base32Decode(secret)!;
    expect(s.confirmEnrollment(handle, hotp(key, totpStep(clock.wall)))).toBe("ok");
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
    expect(r.store.setOutside(true)).toBe(false);
    r.enroll();
    expect([r.store.setOutside(true), r.store.outside, r.open().outside]).toEqual([true, true, true]);
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
});
