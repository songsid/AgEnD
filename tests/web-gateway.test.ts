import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import {
  gatewayConfigured, gatewayHostNames, gatewaySourceHint, isGatewayRoute, GATEWAY_MAX_CONNECTIONS, GATEWAY_REQUEST_TIMEOUT_MS,
} from "../src/web-gateway.js";
import { decideWebGate, evaluateWebRequest, isWebRequestAuthorized, markRequestSurface, WEB_SESSION_COOKIE, WEB_SESSION_COOKIE_SECURE } from "../src/web-auth.js";
import { csrfTokenFor, tokenEpoch, WebSessionStore } from "../src/web-session.js";
import { bypassesWebGate } from "../src/auth-api.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { TopicCommands } from "../src/topic-commands.js";

const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("isGatewayRoute — what exists on the gateway", () => {
  const yes = (method: string, path: string) => expect(isGatewayRoute(method, path), `${method} ${path}`).toBe(true);
  const no = (method: string, path: string) => expect(isGatewayRoute(method, path), `${method} ${path}`).toBe(false);

  it("serves the panels, the sign-in surface and the routes those pages call", () => {
    for (const path of ["/", "/signin", "/favicon.ico"]) yes("GET", path);
    yes("GET", "/assets/shell.js");
    yes("POST", "/auth/login"); yes("GET", "/auth/session"); yes("POST", "/auth/logout");
    yes("GET", "/auth/sessions"); yes("DELETE", "/auth/sessions"); yes("DELETE", "/auth/sessions/0123456789abcdef");
    for (const path of ["/ui", "/ui/events", "/ui/poll", "/ui/send", "/settings", "/view"]) { yes("GET", path); yes("POST", path); }
    for (const path of ["/api/settings/fleet", "/api/settings/apply", "/api/settings/quickstart/plan"]) yes("POST", path);
    for (const path of ["/api/pane/alpha", "/api/profiles", "/api/profile/alpha", "/api/avatar/alpha", "/api/sort-order", "/api/ai-usage"]) yes("GET", path);
    yes("GET", "/api/fleet"); yes("POST", "/stop/alpha"); yes("POST", "/api/instance/alpha/start");
  });

  it("does not serve what must never cross a tunnel", () => {
    for (const path of ["/agent", "/health", "/status", "/activity", "/api/activity", "/api/activity?x=1", "/restart/alpha", "/auth/issue-code", "/t/abc/"]) {
      for (const method of ["GET", "POST"]) no(method, path);
    }
    // Only the method each route is for.
    no("GET", "/auth/login"); no("POST", "/auth/session"); no("GET", "/auth/logout"); no("POST", "/api/fleet");
    no("GET", "/stop/alpha"); no("GET", "/api/instance/alpha/start"); no("POST", "/assets/shell.js"); no("POST", "/signin");
  });

  it("does not let a path pretend to be a route by carrying one inside it", () => {
    for (const path of ["/auth/sessions/a/b", "/stop/a/b", "/api/instance/a/b/start", "/api/instance//start", "/api/instance/a/start/x",
      "/uix", "/settingsx", "/viewer", "/api/settingsx", "/api/pane", "/api/profile", "/ui../agent", "//agent", "/assets", "/auth", "/auth/"]) {
      for (const method of ["GET", "POST", "DELETE"]) no(method, path);
    }
  });
});

describe("gateway configuration", () => {
  it("has no gateway unless both a host list and a port are set", () => {
    expect(gatewayConfigured(null)).toBeNull();
    expect(gatewayConfigured({ web: {} })).toBeNull();
    expect(gatewayConfigured({ web: { external_hosts: ["a.example"] } })).toBeNull();
    expect(gatewayConfigured({ web: { gateway_port: 19281 } })).toBeNull();
    expect(gatewayConfigured({ web: { external_hosts: [], gateway_port: 19281 } })).toBeNull();
    expect(gatewayConfigured({ web: { external_hosts: ["a.example"], gateway_port: 19281 } })).toBe(19281);
    for (const port of [0, -1, 70000, 1.5, "19281", null]) {
      expect(gatewayConfigured({ web: { external_hosts: ["a.example"], gateway_port: port as never } }), String(port)).toBeNull();
    }
  });

  it("answers to exactly the listed names — no loopback name, no junk", () => {
    const names = gatewayHostNames({ web: { external_hosts: ["Agend.Example:8443", "http://evil.example", "", 42 as never, "ok.example"] } });
    expect([...names].sort()).toEqual(["agend.example", "ok.example"]);
    expect(names.has("localhost")).toBe(false);
    expect(names.has("127.0.0.1")).toBe(false);
  });

  it("is validated: both keys together, sane values, and not the health port", () => {
    const check = (web: Record<string, unknown>, health_port?: number) =>
      validateFleetConfig({ defaults: { backend: "claude-code" }, instances: {}, web, ...(health_port ? { health_port } : {}) }).errors
        .filter(e => e.path.startsWith("web.")).map(e => e.path);
    expect(check({ external_hosts: ["a.example"], gateway_port: 19281 })).toEqual([]);
    expect(check({ external_hosts: ["a.example"] })).toContain("web.gateway_port");
    expect(check({ gateway_port: 19281 })).toContain("web.external_hosts");
    expect(check({ external_hosts: ["a.example"], gateway_port: 19280 })).toContain("web.gateway_port");
    expect(check({ external_hosts: ["a.example"], gateway_port: 7000 }, 7000)).toContain("web.gateway_port");
    expect(check({ external_hosts: ["a.example"], gateway_port: 0 })).toContain("web.gateway_port");
    expect(check({ external_hosts: ["a.example"], gateway_port: "x" })).toContain("web.gateway_port");
    expect(check({ external_hosts: ["https://a.example"], gateway_port: 19281 })).toContain("web.external_hosts[0]");
    expect(check({ external_hosts: "a.example", gateway_port: 19281 })).toContain("web.external_hosts");
  });

  it("shows where a request came from only when it is a well-formed IP", () => {
    expect(gatewaySourceHint({ "cf-connecting-ip": "203.0.113.9" })).toBe("203.0.113.9");
    expect(gatewaySourceHint({ "cf-connecting-ip": "2001:db8::1" })).toBe("2001:db8::1");
    for (const bad of ["<script>", "1.2.3", "203.0.113.9, 10.0.0.1", "", "example.com"]) expect(gatewaySourceHint({ "cf-connecting-ip": bad }), bad).toBeNull();
    expect(gatewaySourceHint({})).toBeNull();
  });

  it("is bounded", () => {
    expect(GATEWAY_MAX_CONNECTIONS).toBeGreaterThan(0);
    expect(GATEWAY_MAX_CONNECTIONS).toBeLessThanOrEqual(256);
    expect(GATEWAY_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("credentials on the gateway", () => {
  const TOKEN = "a".repeat(48);
  const EPOCH = tokenEpoch(TOKEN);
  const gw = (headers: Record<string, string>, method = "GET") => {
    const req = { method, headers };
    markRequestSurface(req, "gateway");
    return req;
  };
  const local = (headers: Record<string, string>, method = "GET") => ({ method, headers });
  const url = (path: string) => new URL(path, "http://x");

  it("ignores the header token and the URL token — only a session counts", () => {
    const sessions = new WebSessionStore();
    expect(decideWebGate(gw({ "x-agend-token": TOKEN }), url("/ui"), TOKEN, sessions)).toMatchObject({ kind: "reject", status: 401 });
    expect(decideWebGate(gw({}), url(`/ui?token=${TOKEN}`), TOKEN, sessions)).toMatchObject({ kind: "reject", status: 401 });
    expect(sessions.size).toBe(0);            // and nothing was minted
    expect(isWebRequestAuthorized(gw({ "x-agend-token": TOKEN }), url("/ui/backends"), TOKEN, sessions)).toBe(false);
    expect(evaluateWebRequest(gw({}), url(`/ui/backends?token=${TOKEN}`), TOKEN, sessions).kind).toBe("reject");
    // The same requests on the local listener are exactly what they were.
    expect(decideWebGate(local({ "x-agend-token": TOKEN }), url("/ui"), TOKEN, sessions)).toMatchObject({ kind: "allow", via: "header-token" });
    expect(decideWebGate(local({}), url(`/ui?token=${TOKEN}`), TOKEN, sessions).kind).toBe("exchange");
  });

  it("does not present a wrong header token as a wrong password: on the gateway it is simply not a credential", () => {
    const decision = decideWebGate(gw({ "x-agend-token": "0".repeat(48) }), url("/ui"), TOKEN, new WebSessionStore());
    expect(decision).toMatchObject({ kind: "reject", reason: "no-credential" });
  });

  it("honours a gateway session on the gateway and a local session on the local listener, and neither on the other", () => {
    const sessions = new WebSessionStore();
    const g = sessions.create({ tier: "admin", surface: "gateway", label: "g", tokenEpoch: EPOCH });
    const l = sessions.create({ tier: "admin", surface: "local", label: "l", tokenEpoch: EPOCH });
    const withCookie = (id: string) => ({ cookie: `${WEB_SESSION_COOKIE}=${id}` });

    expect(decideWebGate(gw(withCookie(g.sessionId)), url("/ui"), TOKEN, sessions).kind).toBe("allow");
    expect(decideWebGate(local(withCookie(l.sessionId)), url("/ui"), TOKEN, sessions).kind).toBe("allow");
    expect(decideWebGate(gw(withCookie(l.sessionId)), url("/ui"), TOKEN, sessions).kind).toBe("reject");
    expect(decideWebGate(local(withCookie(g.sessionId)), url("/ui"), TOKEN, sessions).kind).toBe("reject");
    // A refusal for the wrong surface does not spend the session.
    expect(decideWebGate(gw(withCookie(g.sessionId)), url("/ui"), TOKEN, sessions).kind).toBe("allow");
  });

  it("applies the same write checks on the gateway", () => {
    const sessions = new WebSessionStore();
    const g = sessions.create({ tier: "admin", surface: "gateway", label: "g", tokenEpoch: EPOCH });
    const base = { cookie: `${WEB_SESSION_COOKIE_SECURE}=${g.sessionId}`, host: "gw.example" };

    expect(decideWebGate(gw(base, "POST"), url("/api/profile/a"), TOKEN, sessions)).toMatchObject({ status: 403, reason: "csrf" });
    expect(decideWebGate(gw({ ...base, origin: "https://gw.example", "x-agend-csrf": csrfTokenFor(g.sessionId) }, "POST"), url("/api/profile/a"), TOKEN, sessions))
      .toMatchObject({ kind: "allow", via: "session" });
  });

  it("does not open /view's reads, or /health and /agent, on the gateway", () => {
    const open = { web: undefined };
    const isView = (p: string) => p.startsWith("/api/") || p === "/view";
    const localGet = { method: "GET", url: "/api/profiles" };
    expect(bypassesWebGate(localGet, "/api/profiles", open, isView)).toBe(true);
    const gwGet = { method: "GET", url: "/api/profiles" };
    markRequestSurface(gwGet, "gateway");
    expect(bypassesWebGate(gwGet, "/api/profiles", open, isView)).toBe(false);
    for (const [method, target] of [["GET", "/health"], ["POST", "/agent"]] as const) {
      const req = { method, url: target };
      markRequestSurface(req, "gateway");
      expect(bypassesWebGate(req, target, open, isView), target).toBe(false);
    }
    // ...but the way in is still open there.
    const signin = { method: "GET", url: "/signin" };
    markRequestSurface(signin, "gateway");
    expect(bypassesWebGate(signin, "/signin", open, isView)).toBe(true);
  });
});

describe("the /view handler on the gateway", () => {
  it("refuses an anonymous read even though view_access is open — without leaning on the gate", async () => {
    const { handleViewRequest } = await import("../src/view-api.js");
    const dir = mkdtempSync(join(tmpdir(), "agend-view-gw-"));
    tempDirs.push(dir);
    const ctx = {
      webToken: "w".repeat(48), dataDir: dir,
      fleetConfig: { instances: { alpha: {} }, web: { view_access: "open" } },
      logger: { debug() {}, info() {}, warn() {}, error() {} }, classicChannels: null,
      getInstanceStatus: () => "running", getUiStatus: () => ({ instances: [] }),
    } as never;
    const call = (surface: "local" | "gateway") => {
      let status = 0;
      const res = { writeHead(c: number) { status = c; return res; }, end() {} } as never;
      const req = { method: "GET", headers: {} };
      markRequestSurface(req, surface);
      handleViewRequest(req as never, res, new URL("http://x/api/profiles"), ctx);
      return status;
    };
    expect(call("gateway")).toBe(401);
    expect(call("local")).not.toBe(401);
  });
});

describe("sessions know which listener made them", () => {
  it("authenticate(surface) refuses a session from the other surface without ending it", () => {
    const store = new WebSessionStore();
    const epoch = tokenEpoch("a".repeat(48));
    const { sessionId } = store.create({ tier: "admin", surface: "gateway", label: "g", tokenEpoch: epoch });
    expect(store.authenticate(sessionId, epoch, { surface: "local" })).toBeNull();
    expect(store.authenticate(sessionId, epoch, { surface: "gateway" })).not.toBeNull();
    expect(store.authenticate(sessionId, epoch)).not.toBeNull();
  });
});

// ── live ────────────────────────────────────────────────────────────────────

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = "";
      res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
function rawSocket(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(payload));
    let data = "";
    socket.on("data", c => { data += c.toString(); });
    socket.on("end", () => resolve(data));
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
    setTimeout(() => { socket.destroy(); resolve(data); }, 3000);
  });
}

const GW = "gw.example";

interface Harness { fm: FleetManager; local: number; gateway: number; dir: string; token: string; localOrigin: string; gwOrigin: string }

async function startFleet(web: Record<string, unknown> = { external_hosts: [GW], gateway_port: 19999 }): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "agend-gateway-"));
  tempDirs.push(dir);
  const fm = new FleetManager(dir);
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => {});
  (fm as unknown as { fleetConfig: unknown }).fleetConfig = { instances: { alpha: { working_directory: "/tmp" } }, defaults: {}, web };
  (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
  (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
  (fm as unknown as { startGatewayServer(port: number): void }).startGatewayServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const localAddr = ((fm as unknown as { healthServer: Server }).healthServer).address();
  await vi.waitFor(() => expect(((fm as unknown as { gatewayServer: Server }).gatewayServer).address()).not.toBeNull());
  const gwAddr = ((fm as unknown as { gatewayServer: Server }).gatewayServer).address();
  if (!localAddr || typeof localAddr === "string" || !gwAddr || typeof gwAddr === "string") throw new Error("missing TCP address");
  return {
    fm, dir, local: localAddr.port, gateway: gwAddr.port, token: fm.getDashboardAccess().token!,
    localOrigin: `http://127.0.0.1:${localAddr.port}`, gwOrigin: `https://${GW}`,
  };
}

async function stop(h: Harness): Promise<void> {
  for (const key of ["healthServer", "gatewayServer"] as const) {
    const server = (h.fm as unknown as Record<string, Server | null>)[key];
    server?.closeAllConnections();
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    (h.fm as unknown as Record<string, Server | null>)[key] = null;
  }
}

const viaGateway = (h: Harness, method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
  raw(h.gateway, method, path, { host: GW, ...headers }, body);

async function gatewaySignIn(h: Harness, extra: Record<string, string> = {}): Promise<{ cookie: string; csrf: string; setCookie: string }> {
  const res = await viaGateway(h, "POST", "/auth/login", { "content-type": "application/json", origin: h.gwOrigin, ...extra },
    JSON.stringify({ code: h.fm.issueDashboardLogin()!.display }));
  expect(res.status).toBe(200);
  const setCookie = String(res.headers["set-cookie"]);
  const cookie = setCookie.split(";")[0]!;
  return { cookie, csrf: csrfTokenFor(cookie.split("=")[1]!), setCookie };
}

async function localSignIn(h: Harness): Promise<{ cookie: string; csrf: string }> {
  const res = await raw(h.local, "POST", "/auth/login", { "content-type": "application/json", origin: h.localOrigin },
    JSON.stringify({ code: h.fm.issueDashboardLogin()!.display }));
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  return { cookie, csrf: csrfTokenFor(cookie.split("=")[1]!) };
}

describe("the gateway listener (live)", () => {
  it("answers only to the listed Host, and the local listener does not answer to it", async () => {
    const h = await startFleet();
    expect((await raw(h.gateway, "GET", "/signin", { host: GW })).status).toBe(200);
    expect((await raw(h.gateway, "GET", "/signin", { host: `${GW}:8443` })).status).toBe(200);
    for (const host of ["127.0.0.1", `127.0.0.1:${h.gateway}`, "localhost", "other.example", "gw.example.evil.example"]) {
      expect((await raw(h.gateway, "GET", "/signin", { host })).status, host).toBe(403);
    }
    // The external name is not a name of the local listener, and its loopback names are not the gateway's.
    expect((await raw(h.local, "GET", "/signin", { host: GW })).status).toBe(403);
    expect((await raw(h.local, "GET", "/signin", { host: "127.0.0.1" })).status).toBe(200);
    await stop(h);
  }, 30_000);

  it("routes nothing but the panels — /agent, /health, /status, /restart, /api/activity and the code-issuing route do not exist", async () => {
    const h = await startFleet();
    const s = await gatewaySignIn(h);
    const authed = { cookie: s.cookie, origin: h.gwOrigin, "x-agend-csrf": s.csrf };
    for (const [method, path] of [
      ["POST", "/agent"], ["GET", "/health"], ["GET", "/status"], ["POST", "/restart/alpha"], ["GET", "/api/activity"], ["GET", "/activity"],
      ["POST", "/auth/issue-code"], ["GET", "/t/anything/"], ["GET", "/nope"],
    ] as const) {
      expect((await viaGateway(h, method, path, authed)).status, `${method} ${path} with a session`).toBe(404);
      expect((await viaGateway(h, method, path, { "x-agend-token": h.token })).status, `${method} ${path} with the token`).toBe(404);
    }
    // ...while the same ones exist on the local listener.
    expect((await raw(h.local, "GET", "/health", { host: "127.0.0.1" })).status).not.toBe(404);
    expect((await raw(h.local, "GET", "/status", { host: "127.0.0.1", "x-agend-token": h.token })).status).toBe(200);
    for (const path of ["/ui", "/settings", "/view", "/api/profiles", "/api/fleet", "/ui/poll"]) {
      expect((await viaGateway(h, "GET", path, { cookie: s.cookie })).status, path).not.toBe(404);
    }
    await stop(h);
  }, 40_000);

  it("takes a session and nothing else: the web token, in a header or a URL, opens nothing", async () => {
    const h = await startFleet();
    for (const path of ["/ui/backends", "/status-not-routed", "/settings", "/api/fleet", "/api/settings/fleet"]) {
      const res = await viaGateway(h, "GET", path, { "x-agend-token": h.token });
      expect([401, 404], path).toContain(res.status);
      expect(res.body, path).not.toContain("instances");
    }
    const viaUrl = await viaGateway(h, "GET", `/ui?token=${h.token}`);
    expect(viaUrl.status).toBe(401);
    expect(viaUrl.headers["set-cookie"]).toBeUndefined();
    expect(viaUrl.headers.location).toBeUndefined();
    const post = await viaGateway(h, "POST", "/api/profile/alpha", { "x-agend-token": h.token, "content-type": "application/json" }, "{}");
    expect(post.status).toBe(401);
    // The same header does work on the local listener.
    expect((await raw(h.local, "GET", "/ui/backends", { host: "127.0.0.1", "x-agend-token": h.token })).status).toBe(200);
    await stop(h);
  }, 30_000);

  it("signs in with a code and issues a Secure __Host- cookie whatever X-Forwarded-Proto says", async () => {
    const h = await startFleet();
    for (const proto of [undefined, "http", "https"]) {
      const s = await gatewaySignIn(h, proto ? { "x-forwarded-proto": proto } : {});
      expect(s.setCookie, String(proto)).toMatch(/^__Host-agend_session=[0-9a-f]{64};/);
      for (const attr of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"]) expect(s.setCookie).toContain(attr);
      expect(s.setCookie).not.toMatch(/Domain=/i);
      expect(s.setCookie).toMatch(/Max-Age=14400\b/);   // the gateway's four hours, not the local twelve
    }
    await stop(h);
  }, 30_000);

  it("keeps a session on the listener it was made on", async () => {
    const h = await startFleet();
    const g = await gatewaySignIn(h);
    const l = await localSignIn(h);

    expect((await viaGateway(h, "GET", "/ui", { cookie: g.cookie })).status).toBe(200);
    expect((await raw(h.local, "GET", "/ui", { host: "127.0.0.1", cookie: l.cookie })).status).toBe(200);
    // Replayed at the other one, the same values are just strangers.
    expect((await raw(h.local, "GET", "/ui", { host: "127.0.0.1", cookie: g.cookie.replace("__Host-", "") })).status).toBe(401);
    expect((await viaGateway(h, "GET", "/ui", { cookie: l.cookie.replace("agend_session", "__Host-agend_session") })).status).toBe(401);
    expect((await viaGateway(h, "GET", "/ui", { cookie: l.cookie })).status).toBe(401);
    // The session endpoints themselves apply the same rule: a local session is nobody at the gateway, and back.
    const gwCookieAtLocal = g.cookie.replace("__Host-", "");
    for (const path of ["/auth/session", "/auth/sessions"]) {
      expect((await raw(h.local, "GET", path, { host: "127.0.0.1", cookie: gwCookieAtLocal })).status, `local ${path}`).toBe(401);
      expect((await viaGateway(h, "GET", path, { cookie: l.cookie.replace("agend_session", "__Host-agend_session") })).status, `gateway ${path}`).toBe(401);
      expect((await viaGateway(h, "GET", path, { cookie: g.cookie })).status, `gateway ${path} own`).toBe(200);
    }
    await stop(h);
  }, 30_000);

  it("requires a session for /view's reads even though the local listener leaves them open", async () => {
    const h = await startFleet();
    for (const path of ["/api/profiles", "/api/pane/alpha", "/api/sort-order", "/api/ai-usage", "/api/profile/alpha"]) {
      expect((await raw(h.local, "GET", path, { host: "127.0.0.1" })).status, `local ${path}`).toBe(200);
      const res = await viaGateway(h, "GET", path);
      expect(res.status, `gateway ${path}`).toBe(401);
      expect(res.body).not.toContain("instance_name");
    }
    const page = await viaGateway(h, "GET", "/view", { accept: "text/html" });
    expect(page.status).toBe(401);
    expect(page.body).toContain("/assets/signin.js");
    const s = await gatewaySignIn(h);
    for (const path of ["/view", "/api/profiles", "/api/pane/alpha"]) expect((await viaGateway(h, "GET", path, { cookie: s.cookie })).status, path).toBe(200);
    await stop(h);
  }, 30_000);

  it("keeps the write checks, and the code-based sign-in, exactly as they are on the local listener", async () => {
    const h = await startFleet();
    const s = await gatewaySignIn(h);
    const body = JSON.stringify({ display_name: "G", role: "r", description: "d" });
    const headers = { "content-type": "application/json" };
    expect((await viaGateway(h, "POST", "/api/profile/alpha", { ...headers, cookie: s.cookie }, body)).status).toBe(403);
    expect((await viaGateway(h, "POST", "/api/profile/alpha", { ...headers, cookie: s.cookie, origin: "https://evil.example", "x-agend-csrf": s.csrf }, body)).status).toBe(403);
    expect((await viaGateway(h, "POST", "/api/profile/alpha", { ...headers, cookie: s.cookie, origin: h.gwOrigin, "x-agend-csrf": s.csrf }, body)).status).toBe(200);
    // A wrong code is refused the same way, and login needs a same-origin JSON POST here too.
    const wrong = await viaGateway(h, "POST", "/auth/login", { ...headers, origin: h.gwOrigin }, JSON.stringify({ code: "ZZZZ-ZZZZ" }));
    expect(wrong.status).toBe(401);
    expect((await viaGateway(h, "POST", "/auth/login", headers, JSON.stringify({ code: "ZZZZ-ZZZZ" }))).status).toBe(403);
    await stop(h);
  }, 30_000);

  it("labels a gateway session with the IP the edge reports, only when it is one", async () => {
    const h = await startFleet();
    const s = await gatewaySignIn(h, { "cf-connecting-ip": "203.0.113.9", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17 Safari/605.1.15" });
    const list = JSON.parse((await viaGateway(h, "GET", "/auth/sessions", { cookie: s.cookie })).body).sessions;
    expect(list[0].label).toBe("Safari on macOS · 203.0.113.9");
    expect(list[0].surface).toBe("gateway");
    const s2 = await gatewaySignIn(h, { "cf-connecting-ip": "<script>alert(1)</script>" });
    const list2 = JSON.parse((await viaGateway(h, "GET", "/auth/sessions", { cookie: s2.cookie })).body).sessions;
    expect(JSON.stringify(list2)).not.toContain("script");
    await stop(h);
  }, 30_000);

  it("survives a request target that makes new URL throw, on both listeners", async () => {
    const h = await startFleet();
    for (const [port, host] of [[h.gateway, GW], [h.local, "127.0.0.1"]] as const) {
      const reply = await rawSocket(port, `GET http://[bad/ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      expect(reply, String(port)).toMatch(/^HTTP\/1\.1 400/);
    }
    // Still up afterwards.
    expect((await raw(h.gateway, "GET", "/signin", { host: GW })).status).toBe(200);
    expect((await raw(h.local, "GET", "/signin", { host: "127.0.0.1" })).status).toBe(200);
    await stop(h);
  }, 30_000);

  it("is bounded", async () => {
    const h = await startFleet();
    const server = (h.fm as unknown as { gatewayServer: Server }).gatewayServer;
    expect(server.maxConnections).toBe(GATEWAY_MAX_CONNECTIONS);
    expect(server.requestTimeout).toBe(GATEWAY_REQUEST_TIMEOUT_MS);
    expect(server.address()).toMatchObject({ address: "127.0.0.1" });
    await stop(h);
  }, 30_000);

  it("ends an open stream when its session is revoked, on the gateway too", async () => {
    // The heartbeat re-check is in web-api and reads the surface the same way; here, the pieces it depends on.
    const h = await startFleet();
    const s = await gatewaySignIn(h);
    expect((await viaGateway(h, "GET", "/ui/poll", { cookie: s.cookie })).status).toBe(200);
    h.fm.revokeWebSessions();
    expect((await viaGateway(h, "GET", "/ui/poll", { cookie: s.cookie })).status).toBe(401);
    await stop(h);
  }, 30_000);
});

describe("without a gateway", () => {
  it("opens no port and revokes any session that was made on one", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-nogateway-"));
    tempDirs.push(dir);
    const fm = new FleetManager(dir);
    const quiet = () => {};
    fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
    (fm as unknown as { fleetConfig: unknown }).fleetConfig = { instances: {}, defaults: {} };
    (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
    const sessions = (fm as unknown as { webSessions: WebSessionStore }).webSessions;
    const epoch = tokenEpoch(fm.getDashboardAccess().token!);
    const g = sessions.create({ tier: "admin", surface: "gateway", label: "g", tokenEpoch: epoch });
    const l = sessions.create({ tier: "admin", surface: "local", label: "l", tokenEpoch: epoch });

    (fm as unknown as { startGatewayIfConfigured(): void }).startGatewayIfConfigured();

    expect((fm as unknown as { gatewayServer: Server | null }).gatewayServer).toBeNull();
    expect(sessions.authenticate(g.sessionId, epoch)).toBeNull();
    expect(sessions.authenticate(l.sessionId, epoch)).not.toBeNull();
  });

  it("does not open a port for half a configuration", () => {
    for (const web of [{ external_hosts: ["a.example"] }, { gateway_port: 19281 }]) {
      const dir = mkdtempSync(join(tmpdir(), "agend-halfgateway-"));
      tempDirs.push(dir);
      const fm = new FleetManager(dir);
      const quiet = () => {};
      fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
      (fm as unknown as { fleetConfig: unknown }).fleetConfig = { instances: {}, defaults: {}, web };
      (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
      (fm as unknown as { startGatewayIfConfigured(): void }).startGatewayIfConfigured();
      expect((fm as unknown as { gatewayServer: Server | null }).gatewayServer, JSON.stringify(web)).toBeNull();
    }
  });
});

describe("/dashboard names the remote sign-in page only when there is one", () => {
  const text = (fleetConfig: object) => new TopicCommands({
    fleetConfig: { health_port: 19280, ...fleetConfig },
    getDashboardAccess: () => ({ ready: true, token: "a".repeat(48) }),
    issueDashboardLogin: () => ({ display: "ABCD-EFGH", expiresAt: Date.now() + 300_000, ttlMinutes: 5 }),
  } as never).getDashboardText(true);

  it("adds the link, unspoilered, when a gateway is configured", () => {
    const out = text({ web: { external_hosts: ["agend.example"], gateway_port: 19281 } });
    expect(out).toContain("https://agend.example/signin");
    expect(out).not.toMatch(/<tg-spoiler>[^<]*agend\\.example/);
  });

  it("says nothing about one otherwise", () => {
    expect(text({})).not.toContain("https://");
    expect(text({ web: { external_hosts: ["agend.example"] } })).not.toContain("https://");
  });
});
