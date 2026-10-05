import { describe, expect, it } from "vitest";
import {
  LOGIN_BREAKER_PAUSE_MS,
  LOGIN_BREAKER_THRESHOLD,
  LOGIN_BREAKER_WINDOW_MS,
  LOGIN_CODE_TTL_MS,
  MAX_LOGIN_CODE_ATTEMPTS,
  WebLoginCodes,
} from "../src/web-login.js";
import { formatOneTimeCode, generateOneTimeCode, normalizeOneTimeCode } from "../src/auth/one-time-code.js";

/** The web token epoch the codes are issued and redeemed under (rotation is tested separately). */
const E = "epoch-1";

function harness(codes: string[] = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ", "ABCDEF22", "ABCDEF23", "ABCDEF24"]) {
  const clock = { now: 5_000_000 };
  const events: string[] = [];
  const queue = [...codes];
  const login = new WebLoginCodes({
    now: () => clock.now,
    generate: () => queue.shift() ?? generateOneTimeCode(),
    onEvent: e => events.push(e),
  });
  return { login, clock, events };
}

/** Wrong on purpose, and never equal to any code the harness hands out. */
const wrong = (i = 0) => `ZZZZ${String(i % 10000).padStart(4, "2")}`;

describe("issuing", () => {
  it("shows the code as XXXX-XXXX and takes it back in any casing or punctuation", () => {
    const { login } = harness();
    const issued = login.issue({ epoch: E });

    expect(issued.display).toBe("ABCD-EFGH");
    expect(formatOneTimeCode("ABCDEFGH")).toBe("ABCD-EFGH");
    for (const typed of ["abcd-efgh", "ABCD EFGH", " abcdefgh ", "ab cd-ef gh"]) {
      const h = harness();
      h.login.issue({ epoch: E });
      expect(h.login.redeem(typed, E), typed).toEqual({ kind: "ok", tier: "admin" });
    }
  });

  it("generates 8 characters from an alphabet without look-alike digits", () => {
    for (let i = 0; i < 200; i++) expect(generateOneTimeCode()).toMatch(/^[A-Z2-7]{8}$/);
    expect(normalizeOneTimeCode("a-b c")).toBe("ABC");
  });

  it("replaces the outstanding code: only the newest works", () => {
    const { login } = harness();
    login.issue({ epoch: E });
    login.issue({ epoch: E });

    expect(login.redeem("ABCD-EFGH", E)).toEqual({ kind: "invalid" });
    expect(login.redeem("JKLM-NPQR", E)).toEqual({ kind: "ok", tier: "admin" });
  });

  it("can hand out the read tier", () => {
    const { login } = harness();
    login.issue({ tier: "read", epoch: E });
    expect(login.redeem("ABCDEFGH", E)).toEqual({ kind: "ok", tier: "read" });
  });
});

describe("a code is single use and short lived", () => {
  it("cannot be redeemed twice", () => {
    const { login } = harness();
    login.issue({ epoch: E });

    expect(login.redeem("ABCDEFGH", E)).toEqual({ kind: "ok", tier: "admin" });
    expect(login.redeem("ABCDEFGH", E)).toEqual({ kind: "invalid" });
    expect(login.hasOutstandingCode).toBe(false);
  });

  it("expires after the TTL, exactly", () => {
    const { login, clock } = harness();
    login.issue({ epoch: E });

    clock.now += LOGIN_CODE_TTL_MS - 1;
    expect(login.hasOutstandingCode).toBe(true);
    clock.now += 1;
    expect(login.hasOutstandingCode).toBe(false);
    expect(login.redeem("ABCDEFGH", E)).toEqual({ kind: "invalid" });
  });

  it("can be withdrawn without being used", () => {
    const { login } = harness();
    login.issue({ epoch: E });
    login.revoke();

    expect(login.redeem("ABCDEFGH", E)).toEqual({ kind: "invalid" });
  });
});

describe("with no code outstanding there is nothing to guess", () => {
  it("answers exactly as it answers a wrong code", () => {
    const { login } = harness();

    expect(login.redeem("ABCDEFGH", E)).toEqual({ kind: "invalid" });
    expect(login.redeem("", E)).toEqual({ kind: "invalid" });
    expect(login.redeem("---", E)).toEqual({ kind: "invalid" });
  });

  it("counts nothing, so a scanner cannot pre-load the breaker against the next real code", () => {
    const { login, events } = harness();

    // Far more than the breaker's threshold, with no code issued.
    for (let i = 0; i < LOGIN_BREAKER_THRESHOLD * 5; i++) expect(login.redeem(wrong(i), E)).toEqual({ kind: "invalid" });

    login.issue({ epoch: E });
    expect(login.redeem("ABCDEFGH", E)).toEqual({ kind: "ok", tier: "admin" });
    expect(events).not.toContain("breaker-open");
  });

  it("does not spend a wrong-attempt budget on the code issued later", () => {
    const { login } = harness();
    for (let i = 0; i < 50; i++) login.redeem(wrong(i), E);
    login.issue({ epoch: E });

    for (let i = 0; i < MAX_LOGIN_CODE_ATTEMPTS - 1; i++) login.redeem(wrong(i), E);
    expect(login.redeem("ABCDEFGH", E)).toEqual({ kind: "ok", tier: "admin" });
  });

  it("treats an empty entry as not a guess, even while a code is outstanding", () => {
    const { login } = harness();
    login.issue({ epoch: E });

    for (let i = 0; i < 20; i++) expect(login.redeem("  - ", E)).toEqual({ kind: "invalid" });
    // They did not eat into the code's budget: it still allows its full four wrong tries plus the right one.
    for (let i = 0; i < MAX_LOGIN_CODE_ATTEMPTS - 1; i++) login.redeem(wrong(i), E);
    expect(login.redeem("ABCDEFGH", E)).toEqual({ kind: "ok", tier: "admin" });
  });
});

describe("a code dies with its fifth wrong try — the code, not the fleet", () => {
  it("burns the code, so even the right answer then fails", () => {
    const { login, events } = harness();
    login.issue({ epoch: E });

    for (let i = 0; i < MAX_LOGIN_CODE_ATTEMPTS; i++) expect(login.redeem(wrong(i), E)).toEqual({ kind: "invalid" });
    expect(events).toContain("burned");
    expect(login.redeem("ABCDEFGH", E)).toEqual({ kind: "invalid" });
    expect(login.hasOutstandingCode).toBe(false);
  });

  it("allows the fifth attempt itself to be the right one", () => {
    const { login } = harness();
    login.issue({ epoch: E });

    for (let i = 0; i < MAX_LOGIN_CODE_ATTEMPTS - 1; i++) login.redeem(wrong(i), E);
    expect(login.redeem("ABCDEFGH", E)).toEqual({ kind: "ok", tier: "admin" });
  });

  it("leaves the next code untouched: asking again is the whole cost", () => {
    const { login } = harness();
    login.issue({ epoch: E });
    for (let i = 0; i < MAX_LOGIN_CODE_ATTEMPTS; i++) login.redeem(wrong(i), E);

    login.issue({ epoch: E });
    expect(login.redeem("JKLM-NPQR", E)).toEqual({ kind: "ok", tier: "admin" });
  });

  it("does not credit a wrong guess to a code that has since been replaced", () => {
    const { login } = harness();
    login.issue({ epoch: E });
    for (let i = 0; i < MAX_LOGIN_CODE_ATTEMPTS - 1; i++) login.redeem(wrong(i), E);
    login.issue({ epoch: E });

    // A fresh budget for the fresh code.
    for (let i = 0; i < MAX_LOGIN_CODE_ATTEMPTS - 1; i++) login.redeem(wrong(i), E);
    expect(login.redeem("JKLM-NPQR", E)).toEqual({ kind: "ok", tier: "admin" });
  });
});

describe("the breaker", () => {
  function burnCodes(h: ReturnType<typeof harness>, count: number): void {
    for (let i = 0; i < count; i++) {
      h.login.issue({ epoch: E });
      for (let j = 0; j < MAX_LOGIN_CODE_ATTEMPTS; j++) h.login.redeem(wrong(i * 10 + j), E);
    }
  }

  it("opens after enough wrong tries across codes, and refuses even a correct code while open", () => {
    const h = harness();
    burnCodes(h, LOGIN_BREAKER_THRESHOLD / MAX_LOGIN_CODE_ATTEMPTS - 1);
    expect(h.events).not.toContain("breaker-open");

    // The last code's fifth wrong try trips it; a *new* code, correctly typed, is still refused.
    h.login.issue({ epoch: E });
    for (let j = 0; j < MAX_LOGIN_CODE_ATTEMPTS; j++) h.login.redeem(wrong(900 + j), E);
    expect(h.events).toContain("breaker-open");

    h.login.issue({ epoch: E });
    const result = h.login.redeem("ABCDEF23", E);
    expect(result.kind).toBe("paused");
    if (result.kind === "paused") expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(h.login.redeem(wrong(1), E).kind).toBe("paused");
  });

  it("closes again on its own, and the outstanding code is usable if it has not expired", () => {
    const h = harness();
    burnCodes(h, LOGIN_BREAKER_THRESHOLD / MAX_LOGIN_CODE_ATTEMPTS);
    h.login.issue({ epoch: E });
    expect(h.login.redeem("whatever", E).kind).toBe("paused");

    h.clock.now += LOGIN_BREAKER_PAUSE_MS;
    const next = h.login.issue({ epoch: E });
    expect(next.tier).toBe("admin");
    const outcome = h.login.redeem(next.display, E);
    expect(outcome).toEqual({ kind: "ok", tier: "admin" });
  });

  it("forgets old failures: spread out over more than the window, they never add up", () => {
    const h = harness();
    for (let round = 0; round < LOGIN_BREAKER_THRESHOLD * 2; round++) {
      h.login.issue({ epoch: E });
      h.login.redeem(wrong(round), E);
      h.clock.now += LOGIN_BREAKER_WINDOW_MS / 4 + 1;
    }
    expect(h.events).not.toContain("breaker-open");
  });
});


describe("a code dies with the token it was issued under (web-token rotate withdraws it)", () => {
  it("redeemed under another epoch: refused, and withdrawn — the right epoch afterwards does not revive it", () => {
    const login = new WebLoginCodes({ generate: () => "ABCDEFGH" });
    login.issue({ epoch: "old" });
    expect(login.redeem("ABCDEFGH", "new")).toEqual({ kind: "invalid" });
    expect(login.hasOutstandingCode).toBe(false);
    expect(login.redeem("ABCDEFGH", "old")).toEqual({ kind: "invalid" });
  });

  it("a code issued after the rotation works", () => {
    const login = new WebLoginCodes({ generate: () => "ABCDEFGH" });
    login.issue({ epoch: "old" });
    login.issue({ epoch: "new" });
    expect(login.redeem("ABCDEFGH", "new")).toEqual({ kind: "ok", tier: "admin" });
  });

  it("a wrong code under a stale epoch is not counted as a guess against a code that no longer exists", () => {
    const login = new WebLoginCodes({ generate: () => "ABCDEFGH" });
    login.issue({ epoch: "old" });
    for (let i = 0; i < MAX_LOGIN_CODE_ATTEMPTS + 2; i++) expect(login.redeem("ZZZZZZZZ", "new")).toEqual({ kind: "invalid" });
    login.issue({ epoch: "new" });
    expect(login.redeem("ABCDEFGH", "new")).toEqual({ kind: "ok", tier: "admin" });
  });
});
