import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { request, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import {
  buildSessionCookie,
  decideWebGate,
  isWebRequestAuthorized,
  loadOrCreateWebToken,
  readWebToken,
  rotateWebToken,
  WEB_CROSS_SITE_MESSAGE,
  WEB_SESSION_COOKIE,
  WEB_SESSION_REQUIRED_MESSAGE,
  WEB_TOKEN_INVALID_MESSAGE,
  WEB_URL_TOKEN_WRITE_MESSAGE,
  webSessionCookieValue,
  type WebGateRequest,
} from "../src/web-auth.js";

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
) {
  return decideWebGate(req(method, headers), new URL(path, "http://fleet.local"), token);
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

    expect(decision).toEqual({ kind: "reject", status: 401, message: WEB_URL_TOKEN_WRITE_MESSAGE });
  });

  it("stores a derivation in the cookie so a stolen cookie is not the token", () => {
    const cookie = webSessionCookieValue(TOKEN);

    expect(cookie).not.toBe(TOKEN);
    expect(cookie).toMatch(/^[0-9a-f]{64}$/);
    // The cookie must not be replayable through the paths that take the raw
    // token (X-Agend-Token, ?token=, and /view writes).
    expect(gate("POST", "/status", { "x-agend-token": cookie })).toMatchObject({ kind: "reject" });
  });

  it("accepts the issued cookie afterwards, and only that cookie", () => {
    const good = `${WEB_SESSION_COOKIE}=${webSessionCookieValue(TOKEN)}`;
    const wrong = `${WEB_SESSION_COOKIE}=${webSessionCookieValue("b".repeat(48))}`;

    expect(gate("POST", "/status", { cookie: `other=1; ${good}` })).toEqual({ kind: "allow" });
    expect(gate("POST", "/status", { cookie: wrong })).toEqual({
      kind: "reject", status: 401, message: WEB_TOKEN_INVALID_MESSAGE,
    });
  });

  it("keeps the header token working for every method, so the CLI is unaffected", () => {
    expect(gate("POST", "/stop/x", { "x-agend-token": TOKEN })).toEqual({ kind: "allow" });
    expect(gate("GET", "/status", { "x-agend-token": TOKEN })).toEqual({ kind: "allow" });
  });

  it("names the missing session separately from a rejected credential", () => {
    expect(gate("GET", "/status")).toEqual({
      kind: "reject", status: 401, message: WEB_SESSION_REQUIRED_MESSAGE,
    });
    expect(gate("GET", "/status?token=wrong")).toEqual({
      kind: "reject", status: 401, message: WEB_TOKEN_INVALID_MESSAGE,
    });
  });
});

describe("web gate — cross-site protection", () => {
  it("rejects a request whose Origin is not the Host it was sent to", () => {
    const cookie = `${WEB_SESSION_COOKIE}=${webSessionCookieValue(TOKEN)}`;

    expect(gate("POST", "/stop/x", { cookie, origin: "https://evil.example", host: "fleet.local" }))
      .toEqual({ kind: "reject", status: 403, message: WEB_CROSS_SITE_MESSAGE });
    expect(gate("POST", "/stop/x", { cookie, origin: "http://fleet.local", host: "fleet.local" }))
      .toEqual({ kind: "allow" });
  });

  it("rejects the opaque origin sent by sandboxed frames", () => {
    const cookie = `${WEB_SESSION_COOKIE}=${webSessionCookieValue(TOKEN)}`;

    expect(gate("POST", "/stop/x", { cookie, origin: "null", host: "fleet.local" }))
      .toMatchObject({ status: 403 });
  });

  it("allows a request with no Origin at all, which is every non-browser caller", () => {
    expect(gate("POST", "/stop/x", { "x-agend-token": TOKEN, host: "fleet.local" }))
      .toEqual({ kind: "allow" });
  });
});

describe("web gate — an unset token closes the panel", () => {
  it("rejects a credential-less request instead of matching null against null", () => {
    expect(gate("GET", "/status", {}, null)).toEqual({
      kind: "reject", status: 401, message: WEB_TOKEN_INVALID_MESSAGE,
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

    // Same request from our own origin reaches routing (no POST /status route).
    const sameSite = await raw(port, "POST", "/status", { cookie, origin: `http://127.0.0.1:${port}` });
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

  it("invalidates every cookie issued under the previous token", () => {
    const dir = tempDir();
    const before = loadOrCreateWebToken(dir);
    const cookie = buildSessionCookie(before, false).split(";")[0]!;

    const after = rotateWebToken(dir);

    expect(decideWebGate(req("GET", { cookie }), new URL("http://f/status"), after)).toMatchObject({
      status: 401,
    });
  });
});
