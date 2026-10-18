import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEffectBootstrap, effectBootstrapResponse, EFFECT_BOOTSTRAP_PATH } from "../src/web-effect-bootstrap.js";
import { createPublicWebGateway, isPublicWebRoute } from "../src/public-web-gateway.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const refuse = () => { throw Error("bootstrap fixture must never start a process"); };
  return { ...real, spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});
const { FleetManager } = await import("../src/fleet-manager.js");
const boot = "c".repeat(32), servers: Server[] = [], dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
interface Response { status: number; headers: IncomingHttpHeaders; body: string }
function raw(port: number, method = "GET", path = EFFECT_BOOTSTRAP_PATH, headers: Record<string, string> = {}, body?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = ""; res.on("data", c => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject); req.end(body);
  });
}
async function listener() {
  const dir = mkdtempSync(join(tmpdir(), "agend-bootstrap-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any, quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  fm.fleetConfig = { instances: {}, web: { preview: false, allowed_hosts: ["lan.example"] } };
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  const server = fm.healthServer as Server; servers.push(server);
  await vi.waitFor(() => expect(server.listening).toBe(true));
  return { fm, port: (server.address() as { port: number }).port };
}

describe("#2118 fixed same-listener bootstrap", () => {
  it("hashes only trusted script/style, with an opaque sandbox and a closed network policy", () => {
    const r = effectBootstrapResponse(boot), html = r.body.toString(), csp = r.headers["Content-Security-Policy"]!;
    for (const tag of ["script", "style"]) {
      const text = new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">").exec(html)![1]!;
      expect(csp).toContain(tag + "-src 'sha256-" + createHash("sha256").update(text).digest("base64") + "'");
    }
    for (const directive of ["sandbox allow-scripts", "frame-ancestors 'self'", "connect-src 'none'", "worker-src blob:", "frame-src 'none'", "form-action 'none'", "object-src 'none'"]) expect(csp).toContain(directive);
    expect(csp).not.toMatch(/allow-same-origin|unsafe-inline|unsafe-eval|https?:|[ *]\*/);
    expect(html).toContain("ORIGINS=[new URL(window.location.href).origin]");
    expect(r.headers).toMatchObject({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin" });
    expect(r.headers).not.toHaveProperty("X-Frame-Options");
    expect(r.headers["Content-Length"]).toBe(String(r.body.byteLength));
    expect(() => effectBootstrapResponse("not-a-boot")).toThrow();
  });

  it("uses a stable independent boot without a preview listener", () => {
    const a = createEffectBootstrap(), b = createEffectBootstrap();
    expect(a.boot).toMatch(/^[0-9a-f]{32}$/); expect(b.boot).not.toBe(a.boot);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("serves on the actual listener without preview or auth; credentials/Origin/body change nothing", async () => {
    const { fm, port } = await listener();
    expect(fm.previewListener).toBeNull();
    const authenticate = vi.spyOn(fm.webSessions, "authenticate").mockImplementation(() => { throw Error("must not inspect a session"); });
    const a = await raw(port);
    const body = "private-body-marker";
    const b = await raw(port, "GET", EFFECT_BOOTSTRAP_PATH, { cookie: "agend_session=private-cookie-marker", authorization: "Bearer private-auth-marker", "x-agend-token": "private-token-marker", origin: "https://evil.example", "x-forwarded-proto": "https", "content-length": String(Buffer.byteLength(body)) }, body);
    const lan = await raw(port, "GET", EFFECT_BOOTSTRAP_PATH, { host: "lan.example:" + port });
    for (const r of [a, b, lan]) {
      expect(r.status).toBe(200); expect(r.body).toBe(a.body);
      expect(r.headers["set-cookie"]).toBeUndefined(); expect(r.headers["x-frame-options"]).toBeUndefined();
      expect(r.body).not.toMatch(/private-(body|cookie|auth|token)-marker/);
    }
    expect(authenticate).not.toHaveBeenCalled();
    expect((await raw(port, "GET", EFFECT_BOOTSTRAP_PATH, { host: "rebind.evil" })).status).toBe(403);
  });

  it.each([["POST", EFFECT_BOOTSTRAP_PATH], ["HEAD", EFFECT_BOOTSTRAP_PATH], ["GET", EFFECT_BOOTSTRAP_PATH + "?code=evil"], ["GET", EFFECT_BOOTSTRAP_PATH + "/"], ["GET", "/effect%2Dbootstrap"]])("never serves variant %s %s", async (method, path) => {
    const { port } = await listener();
    const r = await raw(port, method, path);
    expect(r.status).not.toBe(200); expect(r.body).not.toContain("ORIGINS=");
  });

  it("admits only the fixed GET through a real current gateway, without library, owner or Trial grants", async () => {
    const { fm, port } = await listener();
    let current = true;
    const gateway = createPublicWebGateway({ exposureId: "private-fixture", isCurrent: () => current, isOpen: () => true,
      dispatch: (req, res) => fm.dispatchWebHttp(req, res, port) });
    const address = await gateway.listen(); gateway.setHost("demo.trycloudflare.com"); servers.push(gateway.server);
    const r = await raw(Number(address.port), "GET", EFFECT_BOOTSTRAP_PATH, { host: "demo.trycloudflare.com" });
    expect(r.status).toBe(200); expect(r.body).toBe((await raw(port)).body);
    expect(r.headers["set-cookie"]).toBeUndefined(); expect(r.headers["x-frame-options"]).toBeUndefined();
    current = false;
    expect((await raw(Number(address.port), "GET", EFFECT_BOOTSTRAP_PATH, { host: "demo.trycloudflare.com" })).status).toBe(403);
    expect(isPublicWebRoute("GET", EFFECT_BOOTSTRAP_PATH)).toBe(true);
    for (const method of ["HEAD", "POST", "PUT", "DELETE"]) expect(isPublicWebRoute(method, EFFECT_BOOTSTRAP_PATH)).toBe(false);
    for (const path of ["/effect-bootstrap/extra", "/ui/effects", "/ui/effects/owner", "/ui/effect-trials/start"]) expect(isPublicWebRoute("GET", path)).toBe(false);
  });

  it("a stale bound context cannot bypass the handler's exposure fence", () => {
    const req = { method: "GET", url: EFFECT_BOOTSTRAP_PATH } as any;
    bindGatewayRequest(req, { surface: "gateway", exposureId: "ended", expectedOrigin: "https://demo.trycloudflare.com", isCurrent: () => false });
    const res = { writeHead: vi.fn(), end: vi.fn(), removeHeader: vi.fn() } as any;
    expect(createEffectBootstrap(boot).handle(req, res)).toBe(true);
    expect(res.writeHead.mock.calls[0][0]).toBe(404); expect(res.end).toHaveBeenCalledWith();
  });
});
