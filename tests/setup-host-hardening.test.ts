import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupHost } from "../src/setup-host.js";
import {
  constantTimeMatches,
  formatSetupCode,
  MAX_SETUP_ATTEMPTS,
  normalizeSetupCode,
  SetupCredentials,
  setupCookieValue,
} from "../src/setup-auth.js";
import { leasePath, reapStaleTunnel } from "../src/tunnel/lease.js";

const dirs: string[] = [];
const hosts: SetupHost[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-setup-hard-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown(false, "test cleanup").catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface Res { status: number; headers: IncomingHttpHeaders; body: string }

function call(port: number, method: string, path: string, opts: { headers?: Record<string, string>; json?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.json === undefined ? null : JSON.stringify(opts.json);
    const headers: Record<string, string> = { ...opts.headers };
    if (payload !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const req = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

async function startHost(over: Partial<ConstructorParameters<typeof SetupHost>[0]> = {}) {
  const dir = over.dataDir ?? tempDir();
  const spawnFleet = vi.fn();
  const host = new SetupHost({
    dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, spawnFleet, log: () => {}, ...over,
  });
  hosts.push(host);
  const started = await host.start();
  return { host, dir, spawnFleet, ...started };
}

async function signIn(port: number, path: string, code: string): Promise<string> {
  const res = await call(port, "POST", `${path}open`, { json: { code } });
  expect(res.status, res.body).toBe(200);
  return String(res.headers["set-cookie"]).split(";")[0]!;
}

// ── The credential model, without a socket in the way ───────────────────────

describe("the code is an exchange key, not the session", () => {
  it("mints a fresh 256-bit secret and derives the cookie from that", () => {
    const creds = new SetupCredentials({ code: "ABCD2345" });

    const verdict = creds.redeem("ABCD2345");

    expect(verdict.kind).toBe("ok");
    const secret = (verdict as { secret: string }).secret;
    // 256 bits as hex. The point of the length is that the cookie cannot be
    // enumerated offline the way a hash of an 8-character code can.
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    // And the cookie is derived from the secret, not from the code: a cookie
    // built from the code would be worth only the code's 40 bits.
    expect(creds.checkCookie(setupCookieValue(secret)).kind).toBe("ok");
    expect(creds.checkCookie(setupCookieValue("ABCD2345")).kind).not.toBe("ok");
  });

  it("spends one shared budget for a wrong code and for a wrong cookie", () => {
    // Both are someone testing a candidate. Counting only the code would leave
    // the cookie open to unlimited replay, which is the hole a short code
    // opens: its hash is computable offline from a known prefix.
    const creds = new SetupCredentials({ code: "ABCD2345" });

    expect(creds.redeem("WRONG111")).toMatchObject({ kind: "rejected", attemptsLeft: 4 });
    expect(creds.checkCookie("deadbeef")).toMatchObject({ kind: "rejected", attemptsLeft: 3 });
    expect(creds.redeem("WRONG222")).toMatchObject({ kind: "rejected", attemptsLeft: 2 });
    expect(creds.checkCookie("deadbeef")).toMatchObject({ kind: "rejected", attemptsLeft: 1 });
    expect(creds.checkCookie("deadbeef")).toMatchObject({ kind: "locked" });
    expect(creds.lockedOut).toBe(true);
    // Even the right code is too late now.
    expect(creds.redeem("ABCD2345")).toMatchObject({ kind: "locked" });
  });

  it("keeps counting wrong cookies once a session exists", () => {
    // The replay this is really about happens after someone has signed in:
    // the attacker is testing candidate hashes against a live session, which is
    // a different branch from "no session yet" and needs its own budget.
    const creds = new SetupCredentials({ code: "ABCD2345" });
    const secret = (creds.redeem("ABCD2345") as { secret: string }).secret;

    expect(creds.checkCookie("f".repeat(64))).toMatchObject({ kind: "rejected", attemptsLeft: 4 });
    expect(creds.checkCookie("e".repeat(64))).toMatchObject({ kind: "rejected", attemptsLeft: 3 });
    expect(creds.checkCookie("d".repeat(64))).toMatchObject({ kind: "rejected", attemptsLeft: 2 });
    expect(creds.checkCookie("c".repeat(64))).toMatchObject({ kind: "rejected", attemptsLeft: 1 });
    // The real cookie still works right up to the last attempt.
    expect(creds.checkCookie(setupCookieValue(secret)).kind).toBe("ok");
    expect(creds.checkCookie("b".repeat(64))).toMatchObject({ kind: "locked" });
  });

  it("compares the sid in constant time", () => {
    // Nothing observable distinguishes `===` from a constant-time compare, so
    // this is pinned where it lives. A sid recovered a character at a time is
    // a sid that stopped being a barrier.
    const source = readFileSync(new URL("../src/setup-auth.ts", import.meta.url), "utf8");
    const method = source.slice(source.indexOf("matchesSid("), source.indexOf("redeem("));

    expect(method).toContain("constantTimeMatches(candidate, this.sid)");
    expect(method).not.toMatch(/candidate\s*===\s*this\.sid/);
  });

  it("allows five attempts, not three", () => {
    const creds = new SetupCredentials({ code: "ABCD2345" });
    for (let i = 0; i < MAX_SETUP_ATTEMPTS - 1; i++) creds.redeem("WRONG000");

    expect(creds.lockedOut).toBe(false);
    expect(creds.redeem("WRONG000")).toMatchObject({ kind: "locked" });
    expect(MAX_SETUP_ATTEMPTS).toBe(5);
  });

  it("does not spend an attempt on a request that presented nothing", () => {
    // A tab left open polling in the background would otherwise lock out the
    // person who is actually setting the fleet up.
    const creds = new SetupCredentials({ code: "ABCD2345" });

    for (let i = 0; i < 10; i++) expect(creds.checkCookie(undefined)).toEqual({ kind: "unauthenticated" });

    expect(creds.lockedOut).toBe(false);
    expect(creds.redeem("ABCD2345").kind).toBe("ok");
  });

  it("reads the code the way a person types it", () => {
    const creds = new SetupCredentials({ code: "ABCD2345" });

    expect(normalizeSetupCode("abcd-2345")).toBe("ABCD2345");
    expect(normalizeSetupCode(" AbCd 2345 ")).toBe("ABCD2345");
    expect(creds.redeem("abcd-2345").kind).toBe("ok");
  });

  it("shows it in a shape that survives being read aloud", () => {
    expect(formatSetupCode("ABCD2345")).toBe("ABCD-2345");
  });

  it("compares without leaking length through timing", () => {
    // Both sides are padded to a common width before the constant-time compare;
    // an early return on a length mismatch is itself a length oracle.
    expect(constantTimeMatches("ABCD2345", "ABCD2345")).toBe(true);
    expect(constantTimeMatches("ABCD234", "ABCD2345")).toBe(false);
    expect(constantTimeMatches("ABCD23456", "ABCD2345")).toBe(false);
    expect(constantTimeMatches("", "ABCD2345")).toBe(false);
  });

  it("will not hand a second party its own session from the same code", () => {
    const creds = new SetupCredentials({ code: "ABCD2345" });
    const first = creds.redeem("ABCD2345");

    expect(first.kind).toBe("ok");
    expect(creds.redeem("ABCD2345").kind).not.toBe("ok");
  });
});

// ── The sid stops a scanner finding the door ────────────────────────────────

describe("everything that is not this page looks the same", () => {
  it("answers a wrong sid exactly as it answers any other path", async () => {
    const { port, sid, code } = await startHost();
    const wrongSid = "f".repeat(32);

    const cookie = await signIn(port, `/s/${sid}/`, code);
    const wrong = await call(port, "GET", `/s/${wrongSid}/`);
    const nonsense = await call(port, "GET", "/does-not-exist");
    const root = await call(port, "GET", "/");
    // A 404 from somewhere else entirely: the right sid, signed in, unknown
    // path. If the wrong-sid answer differs from this one, the sid is findable
    // by comparing replies.
    const insideThePage = await call(port, "GET", `/s/${sid}/no-such-thing`, { headers: { cookie } });

    // Byte for byte, header for header: any difference is how the sid is found.
    for (const res of [nonsense, root, insideThePage]) {
      expect(res.status).toBe(wrong.status);
      expect(res.body).toBe(wrong.body);
      expect(res.headers["content-type"]).toBe(wrong.headers["content-type"]);
    }
    expect(wrong.status).toBe(404);
    expect(wrong.body).not.toContain(sid);
  });

  it("does not spend an attempt on a wrong sid", async () => {
    // The sid is not a credential, and counting guesses at it would hand a
    // scanner the lockout it cannot otherwise reach — a remote denial of setup
    // aimed at the person whose only device is the phone they are setting up on.
    const { port, path, code } = await startHost();

    for (let i = 0; i < 20; i++) await call(port, "GET", `/s/${"a".repeat(32)}/`);

    // Still five attempts and a working code.
    await expect(signIn(port, path, code)).resolves.toMatch(/agend_setup=/);
  });

  it("does not let a wrong sid hold the page open", async () => {
    // Knocking is not use. With the idle timer refreshed by any request, a
    // scanner keeps a ten-minute window open indefinitely for free.
    const { port, host } = await startHost({ ttlMs: 60_000, idleMs: 150 });

    const keepKnocking = setInterval(() => { void call(port, "GET", "/s/deadbeef/").catch(() => {}); }, 30);
    await new Promise(r => setTimeout(r, 500));
    clearInterval(keepKnocking);

    // It closed on idle despite the traffic.
    await expect(call(port, "GET", "/")).rejects.toThrow();
    await host.shutdown(false, "already stopped");
  }, 10_000);
});

// ── Nothing about this machine before the code ──────────────────────────────

describe("the unauthenticated surface is two endpoints", () => {
  it("refuses the wizard API without a cookie", async () => {
    const { port, path } = await startHost();

    // `environment` reports which backends are installed and which channels
    // exist. That is a description of the machine, and it is behind the code.
    for (const [method, endpoint] of [
      ["GET", "api/settings/quickstart/environment"],
      ["POST", "api/settings/quickstart/probe"],
      ["POST", "api/settings/quickstart/plan"],
      ["POST", "api/settings/quickstart/commit"],
      ["POST", "setup/finish"],
      ["GET", "setup/status"],
    ] as const) {
      const res = await call(port, method, `${path}${endpoint}`, { json: method === "POST" ? {} : undefined });
      expect(res.status, `${method} ${endpoint}`).toBe(401);
      expect(res.body).not.toContain("backends");
    }
  });

  it("serves the two open endpoints and no more", async () => {
    const { port, path, code } = await startHost();

    expect((await call(port, "GET", path)).status).toBe(200);
    const opened = await call(port, "POST", `${path}open`, { json: { code } });
    expect(opened.status).toBe(200);
  });

  it("puts no-store on everything, not just the one redirect it used to", async () => {
    // A tunnel edge is a shared cache. A cached setup page or answer belongs to
    // whoever asks next.
    const { port, path, code } = await startHost();
    const cookie = await signIn(port, path, code);

    for (const res of [
      await call(port, "GET", path),
      await call(port, "GET", "/nope"),
      await call(port, "GET", `${path}setup/status`, { headers: { cookie } }),
      await call(port, "GET", `${path}api/settings/quickstart/environment`, { headers: { cookie } }),
    ]) {
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });
});

// ── The cookie ──────────────────────────────────────────────────────────────

describe("the cookie is scoped and its Secure flag is not taken on trust", () => {
  it("is HttpOnly, SameSite=Strict and bound to this page's path", async () => {
    const { port, path, code } = await startHost();

    const res = await call(port, "POST", `${path}open`, { json: { code } });
    const cookie = String(res.headers["set-cookie"]);

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain(`Path=${path}`);
  });

  it("does not become Secure because a header said so", async () => {
    // `X-Forwarded-Proto` is set by whatever is in front, including an
    // attacker. What decides Secure is what this process knows it is serving.
    const { port, path, code } = await startHost();

    const res = await call(port, "POST", `${path}open`, {
      json: { code }, headers: { "x-forwarded-proto": "https" },
    });

    expect(String(res.headers["set-cookie"])).not.toContain("Secure");
  });

  it("refuses a Host it does not recognise", async () => {
    const { port, path, code } = await startHost();
    const cookie = await signIn(port, path, code);

    const res = await call(port, "GET", `${path}setup/status`, {
      headers: { cookie, host: "attacker.example" },
    });

    expect(res.status).toBe(403);
  });

  it("answers the loopback names a browser actually sends", async () => {
    const { port, path, code } = await startHost();
    const cookie = await signIn(port, path, code);

    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const res = await call(port, "GET", `${path}setup/status`, { headers: { cookie, host } });
      expect(res.status, host).toBe(200);
    }
  });
});

// ── Lockout, end to end ─────────────────────────────────────────────────────

describe("five wrong answers ends the page", () => {
  it("counts wrong codes and wrong cookies against the same budget", async () => {
    const { port, path, code } = await startHost();

    // Sign in first, so the cookie attempts below hit the live-session branch —
    // which is the one an attacker replaying candidate hashes would use.
    await signIn(port, path, code);

    for (let i = 0; i < 3; i++) {
      const res = await call(port, "GET", `${path}setup/status`, { headers: { cookie: `agend_setup=${"f".repeat(64)}` } });
      expect(res.status).toBe(401);
    }
    expect((await call(port, "POST", `${path}open`, { json: { code: "ZZZZ7777" } })).status).toBe(401);
    const last = await call(port, "GET", `${path}setup/status`, { headers: { cookie: `agend_setup=${"e".repeat(64)}` } });
    expect(last.status).toBe(410);

    // And the real code no longer helps.
    await vi.waitFor(async () => {
      await expect(call(port, "POST", `${path}open`, { json: { code } })).rejects.toThrow();
    }, { timeout: 4_000 });
  }, 10_000);
});

// ── The idle window is now shorter than the whole window ────────────────────

describe("idle and TTL are different lengths", () => {
  it("closes on idle before the TTL would have", async () => {
    const { port, host } = await startHost({ ttlMs: 60_000, idleMs: 120 });

    await vi.waitFor(async () => {
      await expect(call(port, "GET", "/")).rejects.toThrow();
    }, { timeout: 4_000 });
    await host.shutdown(false, "already stopped");
  }, 10_000);

  it("ships defaults where the idle timer can actually fire", async () => {
    const { SETUP_HOST_IDLE_MS, SETUP_HOST_TTL_MS } = await import("../src/setup-host.js");

    // They were both fifteen minutes, so the idle timer never fired first and
    // an abandoned page stayed open for the full quarter hour.
    expect(SETUP_HOST_IDLE_MS).toBeLessThan(SETUP_HOST_TTL_MS);
  });
});

// ── An unreadable lease is not an absent one ────────────────────────────────

describe("the reaper does not take the caller down with it", () => {
  it("reports a lease it cannot read instead of throwing", async () => {
    const dir = tempDir();
    writeFileSync(leasePath(dir), "{}", { mode: 0o600 });
    chmodSync(leasePath(dir), 0o000);

    // Skip where the test process can read anything regardless (root, or a
    // filesystem without permissions).
    let readable = true;
    try { (await import("node:fs")).readFileSync(leasePath(dir), "utf8"); } catch { readable = false; }
    if (readable) return;

    const outcome = await reapStaleTunnel(dir, { probe: () => ({ kind: "gone" }) });

    expect(outcome.kind).toBe("manual");
    expect((outcome as { reason: string }).reason).toContain("could not be read");
    chmodSync(leasePath(dir), 0o600);
  });
});
