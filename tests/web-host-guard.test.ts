import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import {
  allowedHostNames,
  hostnameOf,
  isHostAllowed,
  LOOPBACK_HOST_NAMES,
  WEB_HOST_REJECTED_MESSAGE,
} from "../src/web-host-guard.js";
import { validateFleetConfig } from "../src/config-validator.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("hostnameOf", () => {
  it("strips the port and lower-cases", () => {
    expect(hostnameOf("Example.COM:8080")).toBe("example.com");
    expect(hostnameOf("localhost")).toBe("localhost");
    expect(hostnameOf("127.0.0.1:19280")).toBe("127.0.0.1");
    expect(hostnameOf("[::1]:19280")).toBe("[::1]");
    expect(hostnameOf("[::1]")).toBe("[::1]");
  });

  it("treats an absolute-FQDN trailing dot as the same name", () => {
    expect(hostnameOf("localhost.")).toBe("localhost");
    expect(hostnameOf("localhost.:19280")).toBe("localhost");
  });

  it("refuses anything that is not a plain name, so a value cannot merely contain an allowed one", () => {
    for (const bad of [
      "", " ", "localhost@evil.example", "user:pw@localhost", "localhost/evil", "http://localhost",
      "localhost evil.example", "localhost:99999x", "[::1", "[::1]x", "evil.example\r\nX: y", "a".repeat(300),
    ]) {
      expect(hostnameOf(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("allowedHostNames / isHostAllowed", () => {
  it("always allows the loopback names and nothing else by default", () => {
    const allowed = allowedHostNames(null);
    expect([...allowed].sort()).toEqual([...LOOPBACK_HOST_NAMES].sort());
    expect(isHostAllowed("localhost:19280", allowed)).toBe(true);
    expect(isHostAllowed("127.0.0.1:19280", allowed)).toBe(true);
    expect(isHostAllowed("[::1]:19280", allowed)).toBe(true);
    expect(isHostAllowed("evil.example", allowed)).toBe(false);
    expect(isHostAllowed("evil.example:19280", allowed)).toBe(false);
  });

  it("does not accept a name that merely starts or ends with an allowed one", () => {
    const allowed = allowedHostNames(null);
    expect(isHostAllowed("localhost.evil.example", allowed)).toBe(false);
    expect(isHostAllowed("evil-localhost", allowed)).toBe(false);
    expect(isHostAllowed("127.0.0.1.evil.example", allowed)).toBe(false);
    expect(isHostAllowed("notlocalhost", allowed)).toBe(false);
  });

  it("refuses a missing or non-string Host", () => {
    const allowed = allowedHostNames(null);
    expect(isHostAllowed(undefined, allowed)).toBe(false);
    expect(isHostAllowed(["localhost", "localhost"], allowed)).toBe(false);
    expect(isHostAllowed("", allowed)).toBe(false);
  });

  it("adds the configured hostname and web.allowed_hosts, ignoring their ports", () => {
    const allowed = allowedHostNames({ hostname: "Dash.Lan", web: { allowed_hosts: ["proxy.example:8443", "10.0.0.5"] } });
    expect(isHostAllowed("dash.lan:19280", allowed)).toBe(true);
    expect(isHostAllowed("proxy.example", allowed)).toBe(true);
    expect(isHostAllowed("10.0.0.5:19280", allowed)).toBe(true);
    expect(isHostAllowed("other.example", allowed)).toBe(false);
  });

  it("ignores junk configuration entries instead of widening the list", () => {
    const allowed = allowedHostNames({ web: { allowed_hosts: [42, null, "", "http://evil.example", "*", "ok.example"] } });
    expect(isHostAllowed("evil.example", allowed)).toBe(false);
    expect(isHostAllowed("*", allowed)).toBe(false);
    expect(isHostAllowed("ok.example", allowed)).toBe(true);
    expect(allowedHostNames({ web: { allowed_hosts: "evil.example" } }).has("evil.example")).toBe(false);
  });
});

describe("web.allowed_hosts validation", () => {
  const validate = (allowed_hosts: unknown) => validateFleetConfig({
    defaults: { backend: "claude-code" },
    instances: {},
    web: { allowed_hosts },
  });

  it("accepts bare names and IPs", () => {
    expect(validate(["proxy.example", "10.0.0.5:8443"]).errors.filter(e => e.path.startsWith("web"))).toEqual([]);
  });

  it("rejects a non-list and entries with a scheme, path or credentials", () => {
    expect(validate("proxy.example").errors.some(e => e.path === "web.allowed_hosts")).toBe(true);
    for (const bad of ["https://proxy.example", "proxy.example/x", "u@proxy.example", 42]) {
      expect(validate([bad]).errors.some(e => e.path === "web.allowed_hosts[0]"), String(bad)).toBe(true);
    }
  });
});

// ── Live server ──────────────────────────────────────────────────────────────

interface RawResponse { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function raw(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<RawResponse> {
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

/** HTTP/1.0 with no Host header at all — Node's client always adds one, so use a socket. */
function rawNoHost(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(`GET ${path} HTTP/1.0\r\n\r\n`));
    let data = "";
    socket.on("data", c => { data += c.toString(); });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

async function startFleet(config?: Record<string, unknown>): Promise<{ fm: FleetManager; port: number; warnings: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "agend-host-guard-"));
  tempDirs.push(dir);
  const fm = new FleetManager(dir);
  const warnings: string[] = [];
  fm.logger = {
    info: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
    warn: (obj: unknown, msg?: string) => { warnings.push(JSON.stringify(obj) + " " + (msg ?? "")); },
    child: () => fm.logger,
  } as unknown as typeof fm.logger;
  if (config) (fm as unknown as { fleetConfig: unknown }).fleetConfig = { instances: {}, defaults: {}, ...config };
  (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
  (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const server = (fm as unknown as { healthServer: Server }).healthServer;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  return { fm, port: address.port, warnings };
}

async function stopFleet(fm: FleetManager): Promise<void> {
  const server = (fm as unknown as { healthServer: Server | null }).healthServer;
  await new Promise<void>(resolve => server?.close(() => resolve()));
  (fm as unknown as { healthServer: Server | null }).healthServer = null;
}

describe("health server Host allowlist (live)", () => {
  it("refuses a rebinding host on every kind of route, including the ones that need no cookie", async () => {
    const { fm, port } = await startFleet();
    // The routes DNS rebinding is after: open GETs that hand back terminal
    // text and the roster, plus the ones that must never be reachable at all.
    const routes: Array<[string, string]> = [
      ["GET", "/view"], ["GET", "/api/pane/anything"], ["GET", "/api/profiles"], ["GET", "/api/ai-usage"],
      ["GET", "/health"], ["GET", "/ui"], ["GET", "/settings"], ["GET", "/status"],
      ["POST", "/agent"], ["POST", "/restart/x"], ["GET", "/favicon.ico"],
    ];
    for (const [method, path] of routes) {
      const res = await raw(port, method, path, { host: "rebound.evil.example" });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(JSON.parse(res.body).error).toBe(WEB_HOST_REJECTED_MESSAGE);
    }
    // Same name with the listening port on it is the same name.
    expect((await raw(port, "GET", "/api/profiles", { host: `rebound.evil.example:${port}` })).status).toBe(403);
    // A name that only contains an allowed one is not that name.
    expect((await raw(port, "GET", "/api/profiles", { host: "localhost.evil.example" })).status).toBe(403);
    await stopFleet(fm);
  }, 20_000);

  it("still serves the names a browser on this machine uses", async () => {
    const { fm, port } = await startFleet();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, "localhost"]) {
      const res = await raw(port, "GET", "/health", { host });
      expect([200, 503], host).toContain(res.status);
      expect(res.body).not.toContain(WEB_HOST_REJECTED_MESSAGE);
    }
    expect((await raw(port, "GET", "/view", { host: `localhost:${port}` })).status).toBe(200);
    await stopFleet(fm);
  }, 20_000);

  it("refuses a request that carries no Host at all", async () => {
    const { fm, port } = await startFleet();
    expect(await rawNoHost(port, "/health")).toContain("403");
    await stopFleet(fm);
  });

  it("answers to the configured hostname and to web.allowed_hosts, and to nothing beside them", async () => {
    const { fm, port } = await startFleet({ hostname: "dash.lan", web: { allowed_hosts: ["proxy.example"] } });
    expect((await raw(port, "GET", "/view", { host: `dash.lan:${port}` })).status).toBe(200);
    expect((await raw(port, "GET", "/view", { host: "proxy.example" })).status).toBe(200);
    expect((await raw(port, "GET", "/view", { host: "attacker.example" })).status).toBe(403);
    await stopFleet(fm);
  }, 20_000);

  it("says why once per refused name, and never logs the raw header", async () => {
    const { fm, port, warnings } = await startFleet();
    await raw(port, "GET", "/health", { host: "rebound.evil.example:1234" });
    await raw(port, "GET", "/health", { host: "rebound.evil.example:1234" });
    await raw(port, "GET", "/health", { host: "other.evil.example" });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("web.allowed_hosts");
    expect(warnings[0]).toContain("rebound.evil.example");
    expect(warnings[0]).not.toContain("1234");
    await stopFleet(fm);
  });
});

describe("health server response headers (live)", () => {
  it("cannot be framed, is not sniffed, and is not cached — on success, on 401 and on a refused Host", async () => {
    const { fm, port } = await startFleet();
    const responses = [
      await raw(port, "GET", "/health"),              // 200/503
      await raw(port, "GET", "/status"),              // 401 (no credential)
      await raw(port, "GET", "/view"),                // HTML
      await raw(port, "GET", "/health", { host: "evil.example" }), // 403
    ];
    expect(responses.map(r => r.status)).toContain(401);
    expect(responses.map(r => r.status)).toContain(403);
    for (const res of responses) {
      expect(res.headers["x-frame-options"]).toBe("DENY");
      const csp = String(res.headers["content-security-policy"]);
      // Cannot be framed, and script that does run has nowhere to send what it reads.
      for (const directive of ["frame-ancestors 'none'", "default-src 'self'", "connect-src 'self'", "img-src 'self' data: blob:",
        "form-action 'self'", "base-uri 'none'", "object-src 'none'"]) expect(csp, directive).toContain(directive);
      expect(csp).not.toMatch(/https?:|\*/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    await stopFleet(fm);
  }, 20_000);
});
