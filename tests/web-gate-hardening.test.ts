import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { request, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import {
  decideWebGate,
  isWebRequestAuthorized,
  loadOrCreateWebToken,
  readWebToken,
  rotateWebToken,
  WEB_CROSS_SITE_MESSAGE,
  WEB_CSRF_HEADER,
  WEB_CSRF_MESSAGE,
  WEB_SESSION_COOKIE,
  WEB_SESSION_EXPIRED_MESSAGE,
  WEB_SESSION_REQUIRED_MESSAGE,
  WEB_TOKEN_INVALID_MESSAGE,
  WEB_URL_TOKEN_WRITE_MESSAGE,
  type WebGateRequest,
} from "../src/web-auth.js";
import { csrfTokenFor, tokenEpoch, WebSessionStore } from "../src/web-session.js";
import { createHash } from "node:crypto";

const TOKEN = "a".repeat(48);
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-web-gate-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function req(method: string, headers: Record<string, string> = {}): WebGateRequest {
  return { method, headers };
}

function gate(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  token: string | null = TOKEN,
  sessions: WebSessionStore = new WebSessionStore(),
) {
  return decideWebGate(req(method, headers), new URL(path, "http://fleet.local"), token, sessions);
}

/** A signed-in browser: the cookie header it sends and the CSRF value its page would add to a write. */
function signedIn(sessions: WebSessionStore, token: string = TOKEN): { cookie: string; csrf: string } {
  const { sessionId } = sessions.create({ tier: "admin", surface: "local", label: "test", tokenEpoch: tokenEpoch(token) });
  return { cookie: `${WEB_SESSION_COOKIE}=${sessionId}`, csrf: csrfTokenFor(sessionId) };
}

/** Headers of a same-origin browser write from that session. */
function browserWrite(browser: { cookie: string; csrf: string }, host = "fleet.local"): Record<string, string> {
  return { cookie: browser.cookie, origin: `http://${host}`, host, [WEB_CSRF_HEADER]: browser.csrf };
}

describe("web gate — token redemption", () => {
  it("redeems a URL token on GET for an HttpOnly SameSite=Strict cookie and drops it from the URL", () => {
    const decision = gate("GET", `/settings?theme=dark&token=${TOKEN}`);

    expect(decision.kind).toBe("exchange");
    if (decision.kind !== "exchange") return;
    expect(decision.location).toBe("/settings?theme=dark");
    expect(decision.location).not.toContain(TOKEN);
    expect(decision.setCookie).toContain("HttpOnly");
    expect(decision.setCookie).toContain("SameSite=Strict");
    expect(decision.setCookie).toContain("Path=/");
  });

  it("keeps the redirect target relative so a forged Host cannot redirect elsewhere", () => {
    const decision = gate("GET", `/ui?token=${TOKEN}`, { host: "attacker.example" });

    expect(decision.kind).toBe("exchange");
    if (decision.kind !== "exchange") return;
    expect(decision.location).toBe("/ui");
    expect(decision.location.startsWith("/")).toBe(true);
    expect(decision.location).not.toContain("//");
  });

  it("marks the cookie Secure only when the request reached us over TLS", () => {
    const plain = gate("GET", `/ui?token=${TOKEN}`);
    const tunneled = gate("GET", `/ui?token=${TOKEN}`, { "x-forwarded-proto": "https" });

    expect(plain.kind === "exchange" && plain.setCookie.includes("Secure")).toBe(false);
    expect(tunneled.kind === "exchange" && tunneled.setCookie.includes("Secure")).toBe(true);
  });

  it("refuses a URL token as a write credential", () => {
    const decision = gate("POST", `/api/settings/reload?token=${TOKEN}`);

    expect(decision).toEqual({ kind: "reject", status: 401, message: WEB_URL_TOKEN_WRITE_MESSAGE, reason: "invalid" });
  });

  it("hands out an opaque session id that has nothing to do with the token", () => {
    const sessions = new WebSessionStore();
    const decision = gate("GET", `/ui?token=${TOKEN}`, {}, TOKEN, sessions);
    expect(decision.kind).toBe("exchange");
    if (decision.kind !== "exchange") return;

    const id = /agend_session=([^;]+)/.exec(decision.setCookie)![1]!;
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toBe(TOKEN);
    expect(decision.setCookie).not.toContain(TOKEN);
    // Not the old derivation either: a cookie anyone holding the token could compute.
    expect(id).not.toBe(createHash("sha256").update(`agend-web-session-v1:${TOKEN}`).digest("hex"));
    expect(sessions.size).toBe(1);
    // ...and the id cannot be replayed through the paths that take the raw token.
    expect(gate("POST", "/status", { "x-agend-token": id })).toMatchObject({ kind: "reject" });
  });

  it("no longer accepts the old deterministic cookie", () => {
    const legacy = createHash("sha256").update(`agend-web-session-v1:${TOKEN}`).digest("hex");

    expect(gate("GET", "/status", { cookie: `${WEB_SESSION_COOKIE}=${legacy}` })).toMatchObject({
      kind: "reject", status: 401, message: WEB_SESSION_EXPIRED_MESSAGE, reason: "no-credential",
    });
  });

  it("accepts a session the server issued, and only that one", () => {
    const sessions = new WebSessionStore();
    const mine = signedIn(sessions);
    const foreign = signedIn(new WebSessionStore());

    expect(gate("GET", "/status", { cookie: `other=1; ${mine.cookie}` }, TOKEN, sessions))
      .toMatchObject({ kind: "allow", via: "session" });
    // A cookie the server does not know is a session that ended, not a credential guessed wrong.
    expect(gate("GET", "/status", { cookie: foreign.cookie }, TOKEN, sessions)).toEqual({
      kind: "reject", status: 401, message: WEB_SESSION_EXPIRED_MESSAGE, reason: "no-credential",
    });
  });

  it("keeps the header token working for every method, so the CLI is unaffected", () => {
    expect(gate("POST", "/stop/x", { "x-agend-token": TOKEN })).toEqual({ kind: "allow", via: "header-token" });
    expect(gate("GET", "/status", { "x-agend-token": TOKEN })).toEqual({ kind: "allow", via: "header-token" });
  });

  it("names the missing session separately from a rejected credential", () => {
    expect(gate("GET", "/status")).toEqual({
      kind: "reject", status: 401, message: WEB_SESSION_REQUIRED_MESSAGE, reason: "no-credential",
    });
    expect(gate("GET", "/status?token=wrong")).toEqual({
      kind: "reject", status: 401, message: WEB_TOKEN_INVALID_MESSAGE, reason: "invalid",
    });
  });
});

describe("web gate — cross-site protection", () => {
  it("rejects a request whose Origin is not the Host it was sent to", () => {
    const sessions = new WebSessionStore();
    const browser = signedIn(sessions);

    expect(gate("POST", "/stop/x", { ...browserWrite(browser), origin: "https://evil.example" }, TOKEN, sessions))
      .toEqual({ kind: "reject", status: 403, message: WEB_CROSS_SITE_MESSAGE, reason: "cross-site" });
    expect(gate("POST", "/stop/x", browserWrite(browser), TOKEN, sessions))
      .toMatchObject({ kind: "allow", via: "session" });
  });

  it("rejects the opaque origin sent by sandboxed frames", () => {
    const sessions = new WebSessionStore();
    const browser = signedIn(sessions);

    expect(gate("POST", "/stop/x", { ...browserWrite(browser), origin: "null" }, TOKEN, sessions))
      .toMatchObject({ status: 403 });
  });

  it("allows a header-token request with no Origin at all, which is every non-browser caller", () => {
    expect(gate("POST", "/stop/x", { "x-agend-token": TOKEN, host: "fleet.local" }))
      .toEqual({ kind: "allow", via: "header-token" });
  });
});

describe("web gate — a cookie is not enough for a write", () => {
  it("rejects a cookie-authenticated write with no Origin, whatever else it carries", () => {
    const sessions = new WebSessionStore();
    const browser = signedIn(sessions);
    const { origin: _origin, ...withoutOrigin } = browserWrite(browser);

    expect(gate("POST", "/stop/x", withoutOrigin, TOKEN, sessions)).toEqual({
      kind: "reject", status: 403, message: WEB_CSRF_MESSAGE, reason: "csrf",
    });
  });

  it("rejects a write without the CSRF header, or with someone else's", () => {
    const sessions = new WebSessionStore();
    const browser = signedIn(sessions);
    const other = signedIn(sessions);

    const { [WEB_CSRF_HEADER]: _csrf, ...without } = browserWrite(browser);
    expect(gate("POST", "/stop/x", without, TOKEN, sessions)).toMatchObject({ status: 403, reason: "csrf" });
    expect(gate("POST", "/stop/x", { ...without, [WEB_CSRF_HEADER]: other.csrf }, TOKEN, sessions))
      .toMatchObject({ status: 403, reason: "csrf" });
    // The cookie value itself is not the CSRF value.
    const id = browser.cookie.split("=")[1]!;
    expect(gate("POST", "/stop/x", { ...without, [WEB_CSRF_HEADER]: id }, TOKEN, sessions))
      .toMatchObject({ status: 403, reason: "csrf" });
  });

  it("rejects a write the browser itself labels cross-site, even with everything else right", () => {
    const sessions = new WebSessionStore();
    const browser = signedIn(sessions);

    for (const site of ["cross-site", "same-site", "none"]) {
      expect(gate("POST", "/stop/x", { ...browserWrite(browser), "sec-fetch-site": site }, TOKEN, sessions), site)
        .toMatchObject({ status: 403, reason: "csrf" });
    }
    expect(gate("POST", "/stop/x", { ...browserWrite(browser), "sec-fetch-site": "same-origin" }, TOKEN, sessions))
      .toMatchObject({ kind: "allow" });
  });

  it("does not ask a read for any of it", () => {
    const sessions = new WebSessionStore();
    const browser = signedIn(sessions);

    expect(gate("GET", "/status", { cookie: browser.cookie }, TOKEN, sessions)).toMatchObject({ kind: "allow" });
  });

  it("does not ask the CLI's header token for any of it", () => {
    expect(gate("DELETE", "/x", { "x-agend-token": TOKEN })).toEqual({ kind: "allow", via: "header-token" });
  });
});

describe("web gate — an unset token closes the panel", () => {
  it("rejects a credential-less request instead of matching null against null", () => {
    expect(gate("GET", "/status", {}, null)).toEqual({
      kind: "reject", status: 401, message: WEB_TOKEN_INVALID_MESSAGE, reason: "closed",
    });
    expect(isWebRequestAuthorized(req("GET"), new URL("http://fleet.local/ui"), null)).toBe(false);
  });
});

// ── Live server: the gate as the health server actually applies it ──────────

interface RawResponse { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function raw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let body = "";
      res.on("data", (c: Buffer) => { body += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", reject);
    r.end();
  });
}

async function startFleet(dir: string): Promise<{ fm: FleetManager; port: number; logged: string[] }> {
  const fm = new FleetManager(dir);
  const logged: string[] = [];
  fm.logger = {
    info: (obj: unknown, msg?: string) => { logged.push(JSON.stringify(obj) + " " + (msg ?? "")); },
    warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
    child: () => fm.logger,
  } as unknown as typeof fm.logger;
  (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
  (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const server = (fm as unknown as { healthServer: Server }).healthServer;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  return { fm, port: address.port, logged };
}

async function stopFleet(fm: FleetManager): Promise<void> {
  const server = (fm as unknown as { healthServer: Server | null }).healthServer;
  await new Promise<void>(resolve => server?.close(() => resolve()));
  (fm as unknown as { healthServer: Server | null }).healthServer = null;
}

function sessionCookieFrom(res: RawResponse): string {
  const setCookie = res.headers["set-cookie"];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(first).toBeTruthy();
  return first!.split(";")[0]!;
}

describe("health server gate (live)", () => {
  it("exchanges a dashboard link for a cookie, then serves the panel without any token in the URL", async () => {
    const dir = tempDir();
    const { fm, port } = await startFleet(dir);
    const token = fm.getDashboardAccess().token!;

    const exchange = await raw(port, "GET", `/status?token=${token}`);
    expect(exchange.status).toBe(302);
    expect(exchange.headers.location).toBe("/status");
    expect(exchange.headers["cache-control"]).toBe("no-store");

    const cookie = sessionCookieFrom(exchange);
    expect(cookie).not.toContain(token);

    const authorized = await raw(port, "GET", "/status", { cookie });
    expect(authorized.status).toBe(200);
    expect(JSON.parse(authorized.body)).toHaveProperty("instances");

    const anonymous = await raw(port, "GET", "/status");
    expect(anonymous.status).toBe(401);

    await stopFleet(fm);
  });

  it("serves the Settings panel and the dashboard from the cookie alone", async () => {
    const dir = tempDir();
    const { fm, port } = await startFleet(dir);
    const token = fm.getDashboardAccess().token!;

    for (const path of ["/settings", "/ui"]) {
      const exchange = await raw(port, "GET", `${path}?token=${token}`);
      expect(exchange.status).toBe(302);
      expect(exchange.headers.location).toBe(path);

      const page = await raw(port, "GET", path, { cookie: sessionCookieFrom(exchange) });
      expect(page.status).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      // The page must not hand the token back to the browser it was just
      // removed from.
      expect(page.body).not.toContain(token);
    }

    // web-api re-checks auth behind the gate; the cookie has to satisfy it too.
    const cookie = sessionCookieFrom(await raw(port, "GET", `/ui?token=${token}`));
    expect((await raw(port, "GET", "/ui/backends", { cookie })).status).toBe(200);
    expect((await raw(port, "GET", "/ui/backends")).status).toBe(401);

    await stopFleet(fm);
  }, 20_000);

  it("blocks a cross-site write that carries a valid session cookie", async () => {
    const dir = tempDir();
    const { fm, port } = await startFleet(dir);
    const token = fm.getDashboardAccess().token!;
    const cookie = sessionCookieFrom(await raw(port, "GET", `/status?token=${token}`));

    const crossSite = await raw(port, "POST", "/status", { cookie, origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);

    // Our own origin but no CSRF value: still not a write a page of ours made.
    const noCsrf = await raw(port, "POST", "/status", { cookie, origin: `http://127.0.0.1:${port}` });
    expect(noCsrf.status).toBe(403);

    // Same request from our own origin, carrying the value only our page can fetch, reaches routing (no POST /status route).
    const csrf = csrfTokenFor(cookie.split("=")[1]!);
    const sameSite = await raw(port, "POST", "/status", { cookie, origin: `http://127.0.0.1:${port}`, [WEB_CSRF_HEADER]: csrf });
    expect(sameSite.status).toBe(404);

    await stopFleet(fm);
  });

  it("sends Referrer-Policy: no-referrer on authorized and rejected responses alike", async () => {
    const dir = tempDir();
    const { fm, port } = await startFleet(dir);
    const token = fm.getDashboardAccess().token!;
    const cookie = sessionCookieFrom(await raw(port, "GET", `/status?token=${token}`));

    expect((await raw(port, "GET", "/status", { cookie })).headers["referrer-policy"]).toBe("no-referrer");
    expect((await raw(port, "GET", "/status")).headers["referrer-policy"]).toBe("no-referrer");
    expect((await raw(port, "GET", "/health")).headers["referrer-policy"]).toBe("no-referrer");
    // Authorization depends on a cookie now, so responses must not be shared.
    expect((await raw(port, "GET", "/status", { cookie })).headers.vary).toBe("Cookie");

    await stopFleet(fm);
  });

  it("never writes a token-bearing URL to the log", async () => {
    const dir = tempDir();
    const { fm, logged } = await startFleet(dir);
    const token = fm.getDashboardAccess().token!;

    expect(logged.join("\n")).toContain("Web UI available");
    for (const line of logged) expect(line).not.toContain(token);

    await stopFleet(fm);
  });

  it("stops accepting a live session the moment the token is rotated", async () => {
    const dir = tempDir();
    const { fm, port } = await startFleet(dir);
    const oldToken = fm.getDashboardAccess().token!;
    const oldCookie = sessionCookieFrom(await raw(port, "GET", `/status?token=${oldToken}`));
    expect((await raw(port, "GET", "/status", { cookie: oldCookie })).status).toBe(200);

    const newToken = rotateWebToken(dir);

    expect((await raw(port, "GET", "/status", { cookie: oldCookie })).status).toBe(401);
    expect((await raw(port, "GET", `/status?token=${oldToken}`)).status).toBe(401);
    expect(fm.getDashboardAccess().token).toBe(newToken);

    const fresh = await raw(port, "GET", `/status?token=${newToken}`);
    expect(fresh.status).toBe(302);
    expect((await raw(port, "GET", "/status", { cookie: sessionCookieFrom(fresh) })).status).toBe(200);

    await stopFleet(fm);
  });
});

describe("web-token rotation", () => {
  it("writes a new 0600 token that replaces the previous one", () => {
    const dir = tempDir();
    const first = loadOrCreateWebToken(dir);

    const rotated = rotateWebToken(dir);

    expect(rotated).toMatch(/^[0-9a-f]{48}$/);
    expect(rotated).not.toBe(first);
    expect(readFileSync(join(dir, "web.token"), "utf8")).toBe(rotated);
    expect(readWebToken(dir)).toBe(rotated);
    expect(statSync(join(dir, "web.token")).mode & 0o777).toBe(0o600);
  });

  it("is reachable as `agend web-token rotate`", () => {
    const dir = tempDir();
    const before = loadOrCreateWebToken(dir);

    execFileSync(
      join(process.cwd(), "node_modules", ".bin", "tsx"),
      [join(process.cwd(), "src", "cli.ts"), "web-token", "rotate"],
      { encoding: "utf8", env: { ...process.env, AGEND_HOME: dir } },
    );

    const after = readWebToken(dir);
    expect(after).toMatch(/^[0-9a-f]{48}$/);
    expect(after).not.toBe(before);
  }, 30_000);

  it("closes the panel instead of throwing when the token file cannot be read", () => {
    const dir = tempDir();
    // A directory in place of the file reproduces an unreadable token without
    // depending on the test user not being root.
    mkdirSync(join(dir, "web.token"));

    expect(() => readWebToken(dir)).not.toThrow();
    expect(readWebToken(dir)).toBeNull();
  });

  it("invalidates every session issued under the previous token", () => {
    const dir = tempDir();
    const before = loadOrCreateWebToken(dir);
    const sessions = new WebSessionStore();
    const browser = signedIn(sessions, before);
    expect(decideWebGate(req("GET", { cookie: browser.cookie }), new URL("http://f/status"), before, sessions))
      .toMatchObject({ kind: "allow" });

    const after = rotateWebToken(dir);

    expect(decideWebGate(req("GET", { cookie: browser.cookie }), new URL("http://f/status"), after, sessions)).toMatchObject({
      status: 401,
    });
    // Gone for good, not merely refused this once: putting the old token back does not revive it.
    expect(decideWebGate(req("GET", { cookie: browser.cookie }), new URL("http://f/status"), before, sessions)).toMatchObject({
      status: 401,
    });
  });
});
