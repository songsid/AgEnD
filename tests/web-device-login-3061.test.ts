/**
 * Refs #3061 (P2a): the requests of device-code sign-in (src/web-device-login.ts), without HTTP — each rule on its own.
 *
 *  - a request is single-use and short-lived: the poll that finds it approved spends it; five minutes from asking, not
 *    from approving; a denied one is told once and forgotten; another web token withdraws it; `revokeAll` too;
 *  - the room is bounded and never evicts: eight at once, two per address; asking again from the same browser
 *    (`replaces`) does not count against the room but does count against the rate;
 *  - creation is rate-limited per address and for the whole fleet, on a sliding window;
 *  - the approving side has a breaker: wrong codes count only while something waits; ten pause every lookup and
 *    decision, right codes included, until the pause ends;
 *  - what the approver sees names no request id; the id is a 256-bit secret only the new browser holds;
 *  - the new browser's cookie: HttpOnly, SameSite=Strict, scoped to /auth/device-login, Secure when the request was.
 */
import { describe, expect, it } from "vitest";
import {
  buildDeviceLoginCookie, clearDeviceLoginCookie, DEVICE_APPROVE_PAUSE_MS, DEVICE_APPROVE_THRESHOLD, DEVICE_LOGIN_COOKIE, DEVICE_LOGIN_CREATE_WINDOW_MS,
  DEVICE_LOGIN_CREATES_GLOBAL, DEVICE_LOGIN_CREATES_PER_PEER, DEVICE_LOGIN_TTL_MS, DeviceLoginRequests, MAX_PENDING_DEVICE_LOGINS, MAX_PENDING_PER_PEER,
  readDeviceLoginCookie, type DeviceLoginCreate,
} from "../src/web-device-login.js";
import { fleetCookieName } from "../src/web-cookie-names.js";

const EPOCH = "e".repeat(64), OTHER_EPOCH = "f".repeat(64);
function setup(opts: { generate?: () => string } = {}) {
  let t = 1_800_000_000_000;
  const events: string[] = [];
  const r = new DeviceLoginRequests({ now: () => t, ...(opts.generate ? { generate: opts.generate } : {}), onEvent: e => events.push(e) });
  let n = 0;
  const ask = (over: Partial<Parameters<DeviceLoginRequests["create"]>[0]> = {}) => {
    const made = r.create({ epoch: EPOCH, peerKey: `10.0.0.${++n}`, label: "Chrome on Android", peer: "network", address: "10.0.0.9", ...over });
    if (made.kind !== "ok") throw new Error(`expected a request, got ${made.kind}`);
    return made;
  };
  return { r, events, ask, advance: (ms: number) => { t += ms; }, now: () => t };
}
const ok = (c: DeviceLoginCreate) => c as Extract<DeviceLoginCreate, { kind: "ok" }>;

describe("#3061 P2a device login requests: a request's life", () => {
  it("asked for → pending (code as ABCD-EFGH, five minutes) → approved → claimed ONCE → the same id finds nothing", () => {
    const { r, ask, now } = setup();
    const made = ask();
    expect(made.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(made.requestId).toMatch(/^[0-9a-f]{64}$/);
    expect(made.expiresAt).toBe(now() + DEVICE_LOGIN_TTL_MS);
    expect(DEVICE_LOGIN_TTL_MS).toBe(5 * 60_000);
    expect(r.poll(made.requestId, EPOCH)).toEqual({ kind: "pending", expiresAt: made.expiresAt });
    expect(r.decide(made.code, "approved", "handle-1", EPOCH)).toMatchObject({ kind: "ok", view: { state: "approved", label: "Chrome on Android" } });
    expect(r.poll(made.requestId, EPOCH)).toEqual({ kind: "claimed", label: "Chrome on Android", approvedBy: "handle-1" });
    expect(r.poll(made.requestId, EPOCH)).toEqual({ kind: "expired" });          // spent
    expect(r.lookup(made.code, EPOCH).kind).toBe("invalid");                       // and gone for the approver too
    expect(r.size).toBe(0);
  });

  it("the code is typed forgivingly (case, dash, spaces) — presentation is not a guess", () => {
    const { r, ask } = setup({ generate: () => "ABCDEFGH" });
    ask();
    expect(r.lookup("abcd efgh", EPOCH).kind).toBe("ok");
    expect(r.lookup("abcd-efgh", EPOCH).kind).toBe("ok");
  });

  it("five minutes from ASKING — approving does not extend it; an expired request is neither found, decided nor claimed", () => {
    const { r, ask, advance } = setup();
    const made = ask();
    advance(4 * 60_000);
    expect(r.decide(made.code, "approved", "h", EPOCH).kind).toBe("ok");
    advance(60_000 + 1);                                                           // 5 min and a moment after asking
    expect(r.poll(made.requestId, EPOCH)).toEqual({ kind: "expired" });
    const late = ask();
    advance(DEVICE_LOGIN_TTL_MS);
    expect(r.lookup(late.code, EPOCH).kind).toBe("invalid");
    expect(r.decide(late.code, "approved", "h", EPOCH).kind).toBe("invalid");
    expect(r.poll(late.requestId, EPOCH)).toEqual({ kind: "expired" });
  });

  it("denied: the device is told once, then it is forgotten; a second decision on a decided code says what it is", () => {
    const { r, ask } = setup();
    const a = ask(), b = ask();
    expect(r.decide(a.code, "denied", "h", EPOCH).kind).toBe("ok");
    expect(r.decide(a.code, "approved", "h", EPOCH)).toEqual({ kind: "decided", state: "denied" });   // never approved after a denial
    expect(r.poll(a.requestId, EPOCH)).toEqual({ kind: "denied" });
    expect(r.poll(a.requestId, EPOCH)).toEqual({ kind: "expired" });
    expect(r.decide(b.code, "approved", "h", EPOCH).kind).toBe("ok");
    expect(r.decide(b.code, "approved", "h2", EPOCH)).toEqual({ kind: "decided", state: "approved" });   // no second approval
    expect(r.decide(b.code, "denied", "h2", EPOCH)).toEqual({ kind: "decided", state: "approved" });   // and no taking it back after the fact
    expect(r.poll(b.requestId, EPOCH)).toMatchObject({ kind: "claimed", approvedBy: "h" });
  });

  it("another web token withdraws every request (as an unused login code); so does revokeAll", () => {
    const { r, ask } = setup();
    const a = ask(), b = ask(), c = ask();
    expect(r.decide(a.code, "approved", "h", EPOCH).kind).toBe("ok");
    expect(r.lookup(b.code, OTHER_EPOCH).kind).toBe("invalid");
    expect(r.poll(a.requestId, OTHER_EPOCH)).toEqual({ kind: "expired" });          // even an approved one
    expect(r.poll(c.requestId, OTHER_EPOCH)).toEqual({ kind: "expired" });
    const d = ask();
    r.revokeAll();
    expect(r.poll(d.requestId, EPOCH)).toEqual({ kind: "expired" });
    expect(r.size).toBe(0);
  });

  it("a malformed, unknown or missing request id is `expired` — never an error, never a hint", () => {
    const { r, ask } = setup();
    ask();
    for (const id of [undefined, "", "nope", "0".repeat(64), "g".repeat(64), "A".repeat(64), "0".repeat(63)]) expect(r.poll(id, EPOCH)).toEqual({ kind: "expired" });
    r.cancel("nope"); r.cancel(undefined);
    expect(r.size).toBe(1);
  });

  it("the approver sees the label, where it came from, its address and the time — and nothing that is the request id", () => {
    const { r, ask } = setup({ generate: () => "ABCDEFGH" });
    const made = ask({ peer: "host", address: "127.0.0.1", label: "Safari on iOS" });
    const looked = r.lookup("ABCD-EFGH", EPOCH);
    expect(looked).toEqual({ kind: "ok", view: { code: "ABCD-EFGH", label: "Safari on iOS", peer: "host", address: "127.0.0.1", expiresAt: made.expiresAt, state: "pending" } });
    expect(JSON.stringify([looked, r.decide("ABCD-EFGH", "approved", "h", EPOCH)])).not.toContain(made.requestId);
  });

  it("two waiting requests never share a code (a clash is redrawn)", () => {
    const codes = ["AAAAAAAA", "AAAAAAAA", "BBBBBBBB"];
    const { r, ask } = setup({ generate: () => codes.shift() ?? "CCCCCCCC" });
    const a = ask(), b = ask();
    expect([a.code, b.code]).toEqual(["AAAA-AAAA", "BBBB-BBBB"]);
    expect(r.size).toBe(2);
  });
});

describe("#3061 P2a: the room is bounded and never evicts", () => {
  it(`${MAX_PENDING_DEVICE_LOGINS} at once (from different addresses); the ninth is refused, nobody's is evicted`, () => {
    const { r, ask } = setup();
    const made = Array.from({ length: MAX_PENDING_DEVICE_LOGINS }, () => ask());
    expect(r.create({ epoch: EPOCH, peerKey: "10.9.9.9", label: "x", peer: "network", address: "10.9.9.9" })).toEqual({ kind: "full" });
    for (const m of made) expect(r.poll(m.requestId, EPOCH).kind).toBe("pending");
  });

  it(`${MAX_PENDING_PER_PEER} per address: a third from the same one is refused — a stranger cannot fill the room alone`, () => {
    const { r, ask } = setup();
    ask({ peerKey: "10.1.1.1" }); ask({ peerKey: "10.1.1.1" });
    expect(r.create({ epoch: EPOCH, peerKey: "10.1.1.1", label: "x", peer: "network", address: "10.1.1.1" })).toEqual({ kind: "full" });
    expect(r.create({ epoch: EPOCH, peerKey: "10.1.1.2", label: "x", peer: "network", address: "10.1.1.2" }).kind).toBe("ok");
  });

  it("asking again with the old id (the same browser's cookie) withdraws the old request: it never costs the room a place", () => {
    const { r, ask } = setup();
    const first = ask({ peerKey: "10.1.1.1" }), second = ask({ peerKey: "10.1.1.1" });
    const third = r.create({ epoch: EPOCH, peerKey: "10.1.1.1", label: "x", peer: "network", address: "10.1.1.1", replaces: first.requestId });
    expect(third.kind).toBe("ok");
    expect(r.poll(first.requestId, EPOCH)).toEqual({ kind: "expired" });
    expect(r.poll(second.requestId, EPOCH).kind).toBe("pending");
    expect(r.size).toBe(2);
  });

  it("a withdrawn (cancelled) request frees its place at once", () => {
    const { r, ask } = setup();
    const many = Array.from({ length: MAX_PENDING_DEVICE_LOGINS }, () => ask());
    r.cancel(many[3]!.requestId);
    expect(r.create({ epoch: EPOCH, peerKey: "10.9.9.9", label: "x", peer: "network", address: "10.9.9.9" }).kind).toBe("ok");
  });
});

describe("#3061 P2a: asking for codes is rate-limited, per address and for the fleet, on a sliding window", () => {
  it(`${DEVICE_LOGIN_CREATES_PER_PEER} per address per ${DEVICE_LOGIN_CREATE_WINDOW_MS / 60_000} minutes; the seventh says how long to wait; the window slides`, () => {
    const { r, advance, now } = setup();
    const t0 = now();
    for (let i = 0; i < DEVICE_LOGIN_CREATES_PER_PEER; i++) {
      const made = r.create({ epoch: EPOCH, peerKey: "10.2.2.2", label: "x", peer: "network", address: "10.2.2.2" });
      expect(made.kind).toBe("ok");
      if (made.kind === "ok") r.cancel(made.requestId);                           // not the room's cap we are testing
      advance(1000);
    }
    const limited = r.create({ epoch: EPOCH, peerKey: "10.2.2.2", label: "x", peer: "network", address: "10.2.2.2" });
    expect(limited).toEqual({ kind: "limited", retryAfterMs: t0 + DEVICE_LOGIN_CREATE_WINDOW_MS - now() });
    expect(r.create({ epoch: EPOCH, peerKey: "10.2.2.3", label: "x", peer: "network", address: "10.2.2.3" }).kind).toBe("ok");   // another address is not held back
    advance(DEVICE_LOGIN_CREATE_WINDOW_MS);
    expect(r.create({ epoch: EPOCH, peerKey: "10.2.2.2", label: "x", peer: "network", address: "10.2.2.2" }).kind).toBe("ok");
  });

  it(`${DEVICE_LOGIN_CREATES_GLOBAL} for the whole fleet per window, whoever asks`, () => {
    const { r } = setup();
    for (let i = 0; i < DEVICE_LOGIN_CREATES_GLOBAL; i++) {
      const made = r.create({ epoch: EPOCH, peerKey: `10.3.${i}.1`, label: "x", peer: "network", address: "10.3.0.1" });
      expect(made.kind).toBe("ok");
      if (made.kind === "ok") r.cancel(made.requestId);
    }
    expect(r.create({ epoch: EPOCH, peerKey: "10.4.4.4", label: "x", peer: "network", address: "10.4.4.4" }).kind).toBe("limited");
  });

  it("a refusal (room full) does not spend the address's allowance", () => {
    const { r, ask } = setup();
    for (let i = 0; i < MAX_PENDING_DEVICE_LOGINS; i++) ask();
    for (let i = 0; i < 20; i++) expect(r.create({ epoch: EPOCH, peerKey: "10.5.5.5", label: "x", peer: "network", address: "10.5.5.5" }).kind).toBe("full");
  });
});

describe("#3061 P2a: the approving side's breaker", () => {
  it("with nothing waiting there is nothing to guess: wrong codes count against nothing", () => {
    const { r, events } = setup();
    for (let i = 0; i < DEVICE_APPROVE_THRESHOLD * 3; i++) expect(r.lookup("ZZZZZZZZ", EPOCH).kind).toBe("invalid");
    expect(r.approvePausedForMs()).toBe(0);
    expect(events).not.toContain("breaker-open");
  });

  it(`${DEVICE_APPROVE_THRESHOLD} wrong codes while something waits pause every lookup and decision — a right code too — until it ends`, () => {
    const { r, ask, advance, events } = setup({ generate: () => "ABCDEFGH" });
    const made = ask();
    for (let i = 0; i < DEVICE_APPROVE_THRESHOLD; i++) expect(r.lookup("ZZZZZZZZ", EPOCH).kind).toBe("invalid");
    expect(events).toContain("breaker-open");
    expect(r.lookup("ABCDEFGH", EPOCH)).toEqual({ kind: "paused", retryAfterMs: DEVICE_APPROVE_PAUSE_MS });
    expect(r.decide("ABCDEFGH", "approved", "h", EPOCH).kind).toBe("paused");
    expect(r.poll(made.requestId, EPOCH).kind).toBe("pending");                    // the new device's own polling is not the approver's
    advance(DEVICE_APPROVE_PAUSE_MS);
    expect(r.lookup("ABCDEFGH", EPOCH).kind).toBe("ok");
  });

  it("nothing typed is not a guess; wrong tries older than the window are forgotten", () => {
    const { r, ask, advance } = setup({ generate: () => "ABCDEFGH" });
    ask();
    for (let i = 0; i < DEVICE_APPROVE_THRESHOLD * 2; i++) expect(r.lookup("  - ", EPOCH).kind).toBe("invalid");
    expect(r.approvePausedForMs()).toBe(0);
    for (let i = 0; i < DEVICE_APPROVE_THRESHOLD - 1; i++) r.lookup("ZZZZZZZZ", EPOCH);
    advance(16 * 60_000);
    r.lookup("ZZZZZZZZ", EPOCH);
    expect(r.approvePausedForMs()).toBe(0);
  });
});

describe("#3061 P2a: the new browser's cookie", () => {
  const id = "a".repeat(64), token = "tok";
  it("HttpOnly, SameSite=Strict, scoped to /auth/device-login, five minutes; Secure only when the request was", () => {
    const plain = buildDeviceLoginCookie(id, false, token, 300);
    expect(plain).toBe(`${fleetCookieName(DEVICE_LOGIN_COOKIE, token)}=${id}; Path=/auth/device-login; HttpOnly; SameSite=Strict; Max-Age=300`);
    expect(buildDeviceLoginCookie(id, true, token, 300)).toMatch(/; Secure$/);
  });
  it("read back only when well formed and under this fleet's name; cleared with Max-Age=0", () => {
    const name = fleetCookieName(DEVICE_LOGIN_COOKIE, token);
    expect(readDeviceLoginCookie(`a=b; ${name}=${id}; c=d`, token)).toBe(id);
    expect(readDeviceLoginCookie(`${name}=${id}`, "another-token")).toBeUndefined();
    expect(readDeviceLoginCookie(`${name}=${id.slice(1)}`, token)).toBeUndefined();
    expect(readDeviceLoginCookie(`${DEVICE_LOGIN_COOKIE}=${id}`, token)).toBeUndefined();
    expect(readDeviceLoginCookie(undefined, token)).toBeUndefined();
    expect(clearDeviceLoginCookie(false, token)).toContain("Max-Age=0");
  });
});
