import { createHash } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_MAX_ARCHIVE_BYTES, type RuntimeBundle } from "../src/runtime-bundle.js";
import { RUNTIME_BUNDLE_PATH, RUNTIME_INSTALL_SCRIPT_PATH, RUNTIME_INSTALL_SHA256_TOKEN, RUNTIME_INSTALL_VERSION_TOKEN,
  RuntimeInstallService, renderRuntimeInstallScript } from "../src/runtime-install.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { FleetManager } from "../src/fleet-manager.js";
import { WebSessionStore } from "../src/web-session.js";

const TEMPLATE = `# fixture installer\n$version = '${RUNTIME_INSTALL_VERSION_TOKEN}'\n$sha256 = '${RUNTIME_INSTALL_SHA256_TOKEN}'\n`;
function fixtureBundle(version = "2.3.5-alpha.7", size = 4096): RuntimeBundle {
  const bytes = Buffer.alloc(size, 7);
  return { bytes, filename: `agend-runtime-windows-${version}.zip`, sha256: createHash("sha256").update(bytes).digest("hex"), version };
}
function request(path: string, options: { method?: string; remote?: string; encrypted?: boolean; headers?: Record<string, string> } = {}): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.method = options.method ?? "GET"; req.url = path; req.headers = { host: "agend.example.test", ...options.headers };
  Object.defineProperty(req, "socket", { value: { remoteAddress: options.remote ?? "127.0.0.1", ...(options.encrypted ? { encrypted: true } : {}) }, configurable: true });
  return req;
}
class Response extends ServerResponse {
  status = 0; bytes = Buffer.alloc(0); sentHeaders: Record<string, string | number | readonly string[] | undefined> = {};
  override writeHead(code: number, headers?: unknown): this { this.status = code; this.sentHeaders = headers && typeof headers === "object" && !Array.isArray(headers) ? headers as import("node:http").OutgoingHttpHeaders : {}; return this; }
  override end(chunk?: unknown): this { if (chunk !== undefined) this.bytes = Buffer.concat([this.bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]); return this; }
  get body(): string { return this.bytes.toString("utf8"); }
}
function get(service: RuntimeInstallService, path: string, options: Parameters<typeof request>[1] = {}, mutate?: (req: IncomingMessage) => void) {
  const req = request(path, options); mutate?.(req);
  const res = new Response(req), handled = service.handle(req, res, new URL(req.url!, "http://localhost"));
  return { res, handled };
}
let clock = 1_000_000;
const make = (overrides: ConstructorParameters<typeof RuntimeInstallService>[0] = {}) => new RuntimeInstallService({ bundle: () => fixtureBundle(), template: () => TEMPLATE, now: () => clock, ...overrides });

beforeEach(() => { vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"); clock = 1_000_000; });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("runtime installer routes", () => {
  it("answers 404 for both routes, whatever the method, and builds nothing, while remote runtimes are off", () => {
    vi.stubEnv("AGEND_REMOTE_RUNTIME", ""); const bundle = vi.fn(() => fixtureBundle()), template = vi.fn(() => TEMPLATE), service = make({ bundle, template });
    for (const path of [RUNTIME_INSTALL_SCRIPT_PATH, RUNTIME_BUNDLE_PATH]) for (const method of ["GET", "HEAD", "POST", "PUT"]) {
      const { res, handled } = get(service, path, { method }); expect(handled, `${method} ${path}`).toBe(true); expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body).toBe(JSON.stringify({ error: "Not found" })); expect(res.sentHeaders["Content-Type"]).toBe("application/json; charset=utf-8");
    }
    // Off is off even from loopback and even with a query: the same 404, never a different answer that says why.
    expect(get(service, RUNTIME_INSTALL_SCRIPT_PATH + "?x=1", { remote: "::1" }).res.status).toBe(404);
    expect(bundle).not.toHaveBeenCalled(); expect(template).not.toHaveBeenCalled();
  });
  it("is the same 404 an unknown route gets, and turns on as soon as the switch does, with no restart", () => {
    const service = make();
    vi.stubEnv("AGEND_REMOTE_RUNTIME", ""); expect(get(service, RUNTIME_BUNDLE_PATH).res.status).toBe(404);
    vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"); expect(get(service, RUNTIME_BUNDLE_PATH).res.status).toBe(200);
    vi.stubEnv("AGEND_REMOTE_RUNTIME", "0"); expect(get(service, RUNTIME_BUNDLE_PATH).res.status).toBe(404);
  });
  it("does not exist on a public gateway link: 404 for both routes, and nothing is built", () => {
    const bundle = vi.fn(() => fixtureBundle()), service = make({ bundle });
    for (const path of [RUNTIME_INSTALL_SCRIPT_PATH, RUNTIME_BUNDLE_PATH]) {
      const { res, handled } = get(service, path, {}, req => bindGatewayRequest(req, { surface: "gateway", exposureId: "a".repeat(32), expectedOrigin: "https://public.example", isCurrent: () => true }));
      expect(handled).toBe(true); expect(res.status).toBe(404); expect(res.body).toBe(JSON.stringify({ error: "Not found" }));
    }
    expect(bundle).not.toHaveBeenCalled();
  });
  it("leaves every other path to the normal gate", () => {
    for (const path of ["/runtime/install.sh", "/runtime/v1/bundle/linux.zip", "/runtime/v1/pair", "/ui/runtimes/download/windows", "/runtime/install.ps1/extra"]) {
      const { res, handled } = get(make(), path); expect(handled).toBe(false); expect(res.status).toBe(0);
    }
  });
  it("is read-only, takes no options, and refuses plain HTTP from anywhere but loopback", () => {
    const bundle = vi.fn(() => fixtureBundle()), service = make({ bundle });
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) { const { res } = get(service, RUNTIME_BUNDLE_PATH, { method }); expect(res.status).toBe(405); expect(res.sentHeaders.Allow).toBe("GET, HEAD"); }
    for (const query of ["?code=secret", "?x=1"]) { const { res } = get(service, RUNTIME_INSTALL_SCRIPT_PATH + query); expect(res.status).toBe(400); }
    for (const remote of ["192.0.2.5", "10.0.0.8", "::ffff:192.0.2.5", "fe80::1"]) {
      const { res, handled } = get(service, RUNTIME_INSTALL_SCRIPT_PATH, { remote }); expect(handled).toBe(true); expect(res.status).toBe(403);
    }
    expect(bundle).not.toHaveBeenCalled();
    for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(get(service, RUNTIME_INSTALL_SCRIPT_PATH, { remote }).res.status).toBe(200);
    expect(get(service, RUNTIME_INSTALL_SCRIPT_PATH, { remote: "192.0.2.5", encrypted: true }).res.status).toBe(200);
  });
  it("serves the script as inert text that pins the version and the hash of the archive it will fetch", () => {
    const service = make(), bundle = fixtureBundle(), script = get(service, RUNTIME_INSTALL_SCRIPT_PATH), zip = get(service, RUNTIME_BUNDLE_PATH);
    expect(script.res.status).toBe(200); expect(script.res.sentHeaders["Content-Type"]).toBe("text/plain; charset=utf-8");
    expect(script.res.sentHeaders["Cache-Control"]).toBe("no-store"); expect(script.res.sentHeaders["X-Content-Type-Options"]).toBe("nosniff");
    expect(script.res.sentHeaders["Content-Length"]).toBe(script.res.bytes.length);
    expect(script.res.body).toBe(`# fixture installer\n$version = '${bundle.version}'\n$sha256 = '${bundle.sha256}'\n`);
    // The pinned hash is of the bytes the archive route really sends, not something read back from that response.
    expect(zip.res.status).toBe(200); expect(createHash("sha256").update(zip.res.bytes).digest("hex")).toBe(/\$sha256 = '([a-f0-9]{64})'/.exec(script.res.body)![1]);
    expect(script.res.sentHeaders["X-Agend-SHA256"]).toBeUndefined();
  });
  it("serves the archive that createRuntimeBundle produced, unchanged", () => {
    const { res } = get(make(), RUNTIME_BUNDLE_PATH), bundle = fixtureBundle();
    expect(res.status).toBe(200); expect(res.bytes.equals(bundle.bytes)).toBe(true);
    expect(res.sentHeaders["Content-Type"]).toBe("application/zip"); expect(res.sentHeaders["Content-Length"]).toBe(bundle.bytes.length);
    expect(res.sentHeaders["Content-Disposition"]).toBe(`attachment; filename="${bundle.filename}"`);
    expect(res.sentHeaders["X-Agend-SHA256"]).toBe(bundle.sha256); expect(res.sentHeaders["X-Content-Type-Options"]).toBe("nosniff");
  });
  it("answers HEAD with the headers and no body", () => {
    const service = make();
    for (const path of [RUNTIME_INSTALL_SCRIPT_PATH, RUNTIME_BUNDLE_PATH]) { const { res } = get(service, path, { method: "HEAD" }); expect(res.status).toBe(200); expect(res.bytes.length).toBe(0); expect(Number(res.sentHeaders["Content-Length"])).toBeGreaterThan(0); }
  });
  it("never lets the request shape what is served: the same bytes for any Host, cookie, origin, peer or header", () => {
    const service = make(), plain = get(service, RUNTIME_INSTALL_SCRIPT_PATH).res.bytes;
    for (const headers of <Array<Record<string, string>>>[{ host: "evil.example" }, { host: "agend.example.test:8445", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" }, { cookie: "agend_session=abc" }, { origin: "https://evil.example", referer: "https://evil.example/" }, { authorization: "Bearer " + "a".repeat(64) }]) {
      expect(get(service, RUNTIME_INSTALL_SCRIPT_PATH, { headers }).res.bytes.equals(plain)).toBe(true);
    }
    expect(get(service, RUNTIME_INSTALL_SCRIPT_PATH, { remote: "198.51.100.9", encrypted: true }).res.bytes.equals(plain)).toBe(true);
    expect(plain.toString("utf8")).not.toMatch(/evil|agend\.example|localhost|session|bearer/i);
  });
  it("builds the generic bundle once per server version, so its hash stays stable, and retries a failed build", () => {
    let calls = 0, fail = true;
    const service = make({ bundle: () => { calls++; if (fail) { fail = false; throw new Error("not built"); } return fixtureBundle(); } });
    expect(get(service, RUNTIME_BUNDLE_PATH).res.status).toBe(503);
    const first = get(service, RUNTIME_INSTALL_SCRIPT_PATH).res.body;
    for (let i = 0; i < 5; i++) { clock += 61_000; get(service, RUNTIME_BUNDLE_PATH); expect(get(service, RUNTIME_INSTALL_SCRIPT_PATH).res.body).toBe(first); }
    expect(calls).toBe(2);
  });
  it("says why when the installer is unavailable, without leaking the cause", () => {
    const { res } = get(make({ bundle: () => { throw new Error("ENOENT /srv/agend/dist/secret-path"); } }), RUNTIME_BUNDLE_PATH);
    expect(res.status).toBe(503); expect(res.body).toContain("unavailable"); expect(res.body).not.toContain("secret-path");
    expect(get(make({ template: () => { throw new Error("missing"); } }), RUNTIME_INSTALL_SCRIPT_PATH).res.status).toBe(503);
  });
  it("never serves more than the bundle's own archive cap", () => {
    const { res } = get(make({ bundle: () => fixtureBundle("2.3.5", RUNTIME_MAX_ARCHIVE_BYTES + 1) }), RUNTIME_BUNDLE_PATH);
    expect(res.status).toBe(503); expect(res.bytes.length).toBeLessThan(1024);
  });
  it("rate limits each route per peer, and everything in total, then recovers", () => {
    const service = make();
    for (let i = 0; i < 12; i++) expect(get(service, RUNTIME_BUNDLE_PATH).res.status).toBe(200);
    const limited = get(service, RUNTIME_BUNDLE_PATH).res; expect(limited.status).toBe(429); expect(limited.sentHeaders["Retry-After"]).toBe("60");
    expect(get(service, RUNTIME_BUNDLE_PATH, { remote: "::1" }).res.status).toBe(200);
    clock += 60_001; expect(get(service, RUNTIME_BUNDLE_PATH).res.status).toBe(200);
    const total = make();
    let refused = 0;
    for (let i = 0; i < 130; i++) if (get(total, i % 2 ? RUNTIME_BUNDLE_PATH : RUNTIME_INSTALL_SCRIPT_PATH, { remote: `::ffff:127.0.0.1`, encrypted: true, headers: {} }).res.status === 429) refused++;
    expect(refused).toBeGreaterThan(0);
  });
  it("charges the total first, so a flood of different peers cannot grow the table past one window's worth", () => {
    const service = make(); let served = 0;
    for (let i = 0; i < 400; i++) if (get(service, RUNTIME_INSTALL_SCRIPT_PATH, { remote: `203.0.113.${i % 250}`, encrypted: true }).res.status === 200) served++;
    expect(served).toBe(120);
    expect((service as unknown as { limits: Map<string, unknown> }).limits.size).toBeLessThanOrEqual(121);
    clock += 61_000; expect(get(service, RUNTIME_INSTALL_SCRIPT_PATH, { remote: "203.0.113.1", encrypted: true }).res.status).toBe(200);
    expect((service as unknown as { limits: Map<string, unknown> }).limits.size).toBe(2);
  });
});

describe("renderRuntimeInstallScript", () => {
  const bundle = fixtureBundle();
  it("stamps only a validated version and hash", () => {
    expect(renderRuntimeInstallScript(TEMPLATE, bundle)).toContain(bundle.sha256);
    for (const version of ["1.2.3'; Remove-Item C:\\ -Recurse #", "1.2.3\r\nInjected", "", "latest"]) expect(() => renderRuntimeInstallScript(TEMPLATE, { ...bundle, version })).toThrow(/identity/);
    for (const sha256 of ["A".repeat(64), "abc", `${"a".repeat(63)}'`]) expect(() => renderRuntimeInstallScript(TEMPLATE, { ...bundle, sha256 })).toThrow(/identity/);
  });
  it("refuses a template that lacks its placeholders or leaves one behind", () => {
    expect(() => renderRuntimeInstallScript("no placeholders", bundle)).toThrow(/placeholders/);
    expect(() => renderRuntimeInstallScript(`${TEMPLATE}@@AGEND_RUNTIME_OTHER@@`, bundle)).toThrow(/invalid/);
    expect(() => renderRuntimeInstallScript(TEMPLATE + "x".repeat(70 * 1024), bundle)).toThrow(/invalid/);
  });
});

describe("runtime installer routes inside the web dispatcher", () => {
  /** An inert FleetManager prototype, as other dispatcher tests use: no listener, fleet, adapter or database. */
  function dispatcher(service = make()) {
    const fm = Object.create(FleetManager.prototype);
    Object.assign(fm, { fleetConfig: { defaults: {}, instances: {} }, webSessions: new WebSessionStore(), webLoginCodes: null, rejectedHostsLogged: new Set(),
      logger: { warn: vi.fn(), error: vi.fn() }, settingsGate: () => ({ handle: () => false }), runtimeInstall: service,
      runtimeCoordinator: () => ({ handlePublicRequest: () => false }) });
    Object.defineProperty(fm, "webToken", { value: "t".repeat(48) });
    return (path: string, options: Parameters<typeof request>[1] = {}, mutate?: (req: IncomingMessage) => void) => {
      const req = request(path, { ...options, headers: { host: "localhost", ...options.headers } }); mutate?.(req);
      const out: Record<string, string | number | readonly string[]> = {}; let status = 0, body = Buffer.alloc(0);
      const res = { headersSent: false, destroyed: false, writableEnded: false, setHeader: (key: string, value: string) => { out[key.toLowerCase()] = value; },
        writeHead: (code: number, values: Record<string, string> = {}) => { status = code; for (const [key, value] of Object.entries(values)) out[key.toLowerCase()] = value; },
        end: (value?: string | Buffer) => { body = Buffer.from(value ?? ""); }, destroy: vi.fn() } as unknown as ServerResponse;
      (fm as unknown as { dispatchWebHttp(req: IncomingMessage, res: ServerResponse, port: number): void }).dispatchWebHttp(req, res, 19280);
      return { status, headers: out, body };
    };
  }
  it("serves both files with no sign-in, ahead of the web gate, while remote runtimes are on", () => {
    const dispatch = dispatcher(), script = dispatch(RUNTIME_INSTALL_SCRIPT_PATH), zip = dispatch(RUNTIME_BUNDLE_PATH);
    expect(script.status).toBe(200); expect(script.body.toString()).toContain(fixtureBundle().sha256);
    expect(zip.status).toBe(200); expect(zip.body.equals(fixtureBundle().bytes)).toBe(true);
  });
  it("is still behind the Host allow-list, so a rebinding page gets nothing", () => {
    const { status, body } = dispatcher()(RUNTIME_INSTALL_SCRIPT_PATH, { headers: { host: "evil.example" } });
    expect(status).toBe(403); expect(body.toString()).not.toContain("sha256");
  });
  it("answers 404 for both routes when remote runtimes are off, with no sign-in prompt, and on a public gateway link", () => {
    vi.stubEnv("AGEND_REMOTE_RUNTIME", "");
    for (const path of [RUNTIME_INSTALL_SCRIPT_PATH, RUNTIME_BUNDLE_PATH]) { const off = dispatcher()(path); expect(off.status, path).toBe(404); expect(off.body.toString()).toContain("Not found"); }
    vi.stubEnv("AGEND_REMOTE_RUNTIME", "1");
    for (const path of [RUNTIME_INSTALL_SCRIPT_PATH, RUNTIME_BUNDLE_PATH]) {
      const gateway = dispatcher()(path, {}, req => bindGatewayRequest(req, { surface: "gateway", exposureId: "a".repeat(32), expectedOrigin: "https://public.example", isCurrent: () => true }));
      expect(gateway.status, path).toBe(404); expect(gateway.body.equals(fixtureBundle().bytes)).toBe(false);
    }
  });
  it("leaves every other path to the sign-in gate, so only these two routes are public", () => {
    expect(dispatcher()("/runtime/install.sh").status).toBe(401); expect(dispatcher()("/runtime/v1/bundle/linux.zip").status).toBe(401);
    vi.stubEnv("AGEND_REMOTE_RUNTIME", ""); expect(dispatcher()("/runtime/install.ps1.bak").status).toBe(401);
  });
});
