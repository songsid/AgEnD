import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_MAX_ARCHIVE_BYTES, createRuntimeBundle, type RuntimeBundle } from "../src/runtime-bundle.js";
import { runtimeBundleFixture, unzipStored } from "./support/runtime-bundle-fixture.js";
import { RUNTIME_BUNDLE_PATH, RUNTIME_BUNDLE_METADATA_PATH, RUNTIME_INSTALL_SCRIPT_PATH, RUNTIME_INSTALL_SHA256_TOKEN, RUNTIME_INSTALL_VERSION_TOKEN,
  RuntimeInstallService, renderRuntimeInstallScript } from "../src/runtime-install.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { FleetManager } from "../src/fleet-manager.js";
import { createPublicWebGateway, isPublicWebRoute } from "../src/public-web-gateway.js";
import { EventEmitter } from "node:events";
import { WebSessionStore } from "../src/web-session.js";

const INSTALL_ROUTES = [RUNTIME_INSTALL_SCRIPT_PATH, RUNTIME_BUNDLE_PATH, RUNTIME_BUNDLE_METADATA_PATH];
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
const cleanups: Array<() => void> = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });

describe("runtime installer routes", () => {
  it("answers 404 for all installer routes, whatever the method, and builds nothing, while remote runtimes are off", () => {
    vi.stubEnv("AGEND_REMOTE_RUNTIME", ""); const bundle = vi.fn(() => fixtureBundle()), template = vi.fn(() => TEMPLATE), service = make({ bundle, template });
    for (const path of INSTALL_ROUTES) for (const method of ["GET", "HEAD", "POST", "PUT"]) {
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
  it("does not exist on a public gateway link: 404 for all installer routes, and nothing is built", () => {
    const bundle = vi.fn(() => fixtureBundle()), service = make({ bundle });
    for (const path of INSTALL_ROUTES) {
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
    for (const path of INSTALL_ROUTES) {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) { const { res } = get(service, path, { method }); expect(res.status).toBe(405); expect(res.sentHeaders.Allow).toBe("GET, HEAD"); }
      for (const query of ["?code=secret", "?x=1"]) { const { res } = get(service, path + query); expect(res.status).toBe(400); }
      for (const remote of ["192.0.2.5", "10.0.0.8", "::ffff:192.0.2.5", "fe80::1"]) {
        const { res, handled } = get(service, path, { remote }); expect(handled).toBe(true); expect(res.status).toBe(403);
      }
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
    for (const path of INSTALL_ROUTES) { const { res } = get(service, path, { method: "HEAD" }); expect(res.status).toBe(200); expect(res.bytes.length).toBe(0); expect(Number(res.sentHeaders["Content-Length"])).toBeGreaterThan(0); }
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
  it("allows a small burst per client address, then holds it to the refill rate; each route has its own allowance", () => {
    const service = make();
    for (let i = 0; i < 4; i++) expect(get(service, RUNTIME_BUNDLE_PATH).res.status, `burst ${i}`).toBe(200);
    const limited = get(service, RUNTIME_BUNDLE_PATH).res; expect(limited.status).toBe(429); expect(limited.sentHeaders["Retry-After"]).toBe("30");
    // another address, and the other route for the same address, are not held
    expect(get(service, RUNTIME_BUNDLE_PATH, { remote: "::1" }).res.status).toBe(200);
    expect(get(service, RUNTIME_INSTALL_SCRIPT_PATH).res.status).toBe(200);
    // 12 a minute is one every five seconds: not yet, then one, then held again
    clock += 4_000; expect(get(service, RUNTIME_BUNDLE_PATH).res.status).toBe(429);
    clock += 1_001; expect(get(service, RUNTIME_BUNDLE_PATH).res.status).toBe(200); expect(get(service, RUNTIME_BUNDLE_PATH).res.status).toBe(429);
    // a long pause restores the whole burst, and no more than the burst
    clock += 120_000; for (let i = 0; i < 4; i++) expect(get(service, RUNTIME_BUNDLE_PATH).res.status).toBe(200); expect(get(service, RUNTIME_BUNDLE_PATH).res.status).toBe(429);
  });
  it("an address that hammers one route is held by its own bucket and costs the total nothing, so everyone else can still download (N1)", () => {
    const service = make(), total = () => (service as unknown as { buckets: Map<string, { tokens: number }> }).buckets.get("total")?.tokens;
    let served = 0, refused = 0;
    for (let i = 0; i < 300; i++) { const status = get(service, RUNTIME_BUNDLE_PATH, { remote: "203.0.113.9", encrypted: true }).res.status; if (status === 200) served++; else if (status === 429) refused++; }
    expect(served).toBe(4); expect(refused).toBe(296);
    // 4 admitted requests took 4 from the total (burst 60); the 296 refused ones took nothing
    expect(total()).toBeCloseTo(56, 5);
    // twenty other addresses, a script and an archive each, are all served while the first is still being held
    for (let i = 0; i < 20; i++) for (const path of [RUNTIME_INSTALL_SCRIPT_PATH, RUNTIME_BUNDLE_PATH]) expect(get(service, path, { remote: `198.51.100.${i + 1}`, encrypted: true }).res.status, `other address ${i} ${path}`).toBe(200);
    expect(get(service, RUNTIME_BUNDLE_PATH, { remote: "203.0.113.9", encrypted: true }).res.status).toBe(429);   // the hammering address is still held
  });
  it("lets a person run the installer a few times in a row: the script and the archive twice over", () => {
    const service = make();
    for (let i = 0; i < 2; i++) { expect(get(service, RUNTIME_INSTALL_SCRIPT_PATH).res.status).toBe(200); expect(get(service, RUNTIME_BUNDLE_PATH).res.status).toBe(200); }
  });
  it("bounds everything together, so a flood from many addresses (or one proxy) is held, and the table stays small", () => {
    const service = make(); let served = 0;
    for (let i = 0; i < 400; i++) if (get(service, RUNTIME_INSTALL_SCRIPT_PATH, { remote: `203.0.113.${i % 250}`, encrypted: true }).res.status === 200) served++;
    expect(served).toBe(60);
    const size = () => (service as unknown as { buckets: Map<string, unknown> }).buckets.size;
    expect(size()).toBeLessThanOrEqual(61);
    clock += 1_000; expect(get(service, RUNTIME_INSTALL_SCRIPT_PATH, { remote: "203.0.113.1", encrypted: true }).res.status).toBe(200);   // 4 a second refill
    clock += 600_000; get(service, RUNTIME_INSTALL_SCRIPT_PATH, { remote: "203.0.113.2", encrypted: true });
    expect(size()).toBeLessThanOrEqual(3);   // everything that refilled to full was forgotten
  });
  it("reports the SHA-256 of the exact script bytes it sends, and sends those same bytes every time, even from a template with CRLF line ends", () => {
    for (const template of [TEMPLATE, TEMPLATE.replace(/\n/g, "\r\n")]) {
      const service = make({ template: () => template }), bundle = fixtureBundle(), info = service.installer();
      const sent = get(service, RUNTIME_INSTALL_SCRIPT_PATH).res.bytes;
      expect(info.scriptSha256).toBe(createHash("sha256").update(sent).digest("hex"));
      expect(info).toEqual({ version: bundle.version, scriptSha256: info.scriptSha256, scriptBytes: sent.length, bundleSha256: bundle.sha256 });
      // not rewritten on the way out: the bytes are the rendered template, line ends included
      expect(sent.equals(Buffer.from(renderRuntimeInstallScript(template, bundle), "utf8"))).toBe(true);
      expect(sent.includes(0x0d)).toBe(template.includes("\r"));
      for (let i = 0; i < 3; i++) { clock += 10_000; expect(get(service, RUNTIME_INSTALL_SCRIPT_PATH).res.bytes.equals(sent)).toBe(true); expect(service.installer().scriptSha256).toBe(info.scriptSha256); }
      expect(Number(get(service, RUNTIME_INSTALL_SCRIPT_PATH, { method: "HEAD" }).res.sentHeaders["Content-Length"])).toBe(sent.length);
    }
  });
  it("reports a different script hash for a different server version, and cannot report one when the installer is unavailable", () => {
    expect(make({ bundle: () => fixtureBundle("2.3.5") }).installer().scriptSha256).not.toBe(make({ bundle: () => fixtureBundle("2.3.6") }).installer().scriptSha256);
    expect(() => make({ bundle: () => { throw new Error("missing"); } }).installer()).toThrow();
    expect(() => make({ template: () => "no placeholders" }).installer()).toThrow();
  });
  it("sends Cache-Control and an ETag keyed by the server version for the archive, answers a matching If-None-Match with 304 and no body, and never lets the script be cached", () => {
    const service = make(), bundle = fixtureBundle(), first = get(service, RUNTIME_BUNDLE_PATH).res, etag = `"${bundle.version}-${bundle.sha256}"`;
    expect(first.sentHeaders.ETag).toBe(etag); expect(first.sentHeaders["Cache-Control"]).toBe("no-cache");
    for (const header of [etag, `W/"other", ${etag}`, `"x" , ${etag}`]) {
      const again = get(service, RUNTIME_BUNDLE_PATH, { headers: { "if-none-match": header } }).res;
      expect(again.status, header).toBe(304); expect(again.bytes.length).toBe(0); expect(again.sentHeaders.ETag).toBe(etag);
    }
    for (const header of [`"other"`, `W/${etag}`, "*"]) { clock += 10_000; expect(get(service, RUNTIME_BUNDLE_PATH, { headers: { "if-none-match": header } }).res.status, header).toBe(200); }
    expect(make({ bundle: () => fixtureBundle("2.3.6") }).installer().version).toBe("2.3.6");
    expect(get(make({ bundle: () => fixtureBundle("2.3.6") }), RUNTIME_BUNDLE_PATH).res.sentHeaders.ETag).toBe(`"2.3.6-${fixtureBundle("2.3.6").sha256}"`);
    const script = get(make(), RUNTIME_INSTALL_SCRIPT_PATH).res;
    expect(script.sentHeaders["Cache-Control"]).toBe("no-store"); expect(script.sentHeaders.ETag).toBeUndefined();
    // a conditional request still counts against the limit
    const limited = make(); for (let i = 0; i < 4; i++) get(limited, RUNTIME_BUNDLE_PATH, { headers: { "if-none-match": etag } });
    expect(get(limited, RUNTIME_BUNDLE_PATH, { headers: { "if-none-match": etag } }).res.status).toBe(429);
  });
});

describe("runtime update bundle metadata", () => {
  it("describes the exact cached real ZIP and its installer pin even when the source changes after the first read", () => {
    const f = runtimeBundleFixture(); cleanups.push(f.cleanup);
    const first = createRuntimeBundle(f), later = fixtureBundle("2.3.6"), bundle = vi.fn().mockReturnValueOnce(first).mockReturnValue(later);
    const service = make({ bundle }), metadata = get(service, RUNTIME_BUNDLE_METADATA_PATH).res;
    expect(metadata.status).toBe(200);
    expect(metadata.sentHeaders["Content-Type"]).toBe("application/json; charset=utf-8");
    expect(metadata.sentHeaders["X-Content-Type-Options"]).toBe("nosniff");
    expect(metadata.sentHeaders["Content-Disposition"]).toBeUndefined();
    expect(metadata.bytes.length).toBeLessThan(256);
    expect(metadata.sentHeaders["Content-Length"]).toBe(metadata.bytes.length);
    const info = JSON.parse(metadata.body), zip = get(service, RUNTIME_BUNDLE_PATH).res;
    expect(info).toEqual({ version: first.version, sha256: createHash("sha256").update(zip.bytes).digest("hex"), bytes: zip.bytes.length });
    expect(zip.bytes.equals(first.bytes)).toBe(true);
    expect(metadata.sentHeaders.ETag).toBe(zip.sentHeaders.ETag);
    expect(metadata.sentHeaders.ETag).toBe(`"${info.version}-${info.sha256}"`);
    expect(metadata.sentHeaders["Cache-Control"]).toBe("no-cache");
    expect(get(service, RUNTIME_INSTALL_SCRIPT_PATH).res.body).toContain(`$sha256 = '${info.sha256}'`);
    expect(service.installer().bundleSha256).toBe(info.sha256);
    expect(get(service, RUNTIME_BUNDLE_METADATA_PATH).res.bytes.equals(metadata.bytes)).toBe(true);
    expect(bundle).toHaveBeenCalledTimes(1);
  });
  it("keeps metadata fixed across request identities and accepts direct TLS and each loopback representation", () => {
    const expected = get(make(), RUNTIME_BUNDLE_METADATA_PATH).res.bytes;
    for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "192.0.2.5"]) {
      const res = get(make(), RUNTIME_BUNDLE_METADATA_PATH, { remote, encrypted: remote === "192.0.2.5", headers: {
        host: "other.example.test", origin: "https://other.example.test", cookie: "sentinel-cookie", authorization: "Bearer sentinel-token",
        "x-forwarded-host": "untrusted.example.test", "x-forwarded-proto": "http"
      } }).res;
      expect(res.status, remote).toBe(200); expect(res.bytes.equals(expected), remote).toBe(true);
    }
    expect(expected.toString()).not.toMatch(/sentinel|other\.example|untrusted/);
    expect(get(make(), RUNTIME_BUNDLE_METADATA_PATH, { remote: "192.0.2.5", headers: { "x-forwarded-proto": "https" } }).res.status).toBe(403);
  });
  it("uses the same GET and HEAD identity and answers conditional metadata with 304 without a body", () => {
    const service = make(), first = get(service, RUNTIME_BUNDLE_METADATA_PATH).res, etag = String(first.sentHeaders.ETag);
    const head = get(service, RUNTIME_BUNDLE_METADATA_PATH, { method: "HEAD" }).res;
    expect(head.status).toBe(200); expect(head.bytes.length).toBe(0); expect(head.sentHeaders).toEqual(first.sentHeaders);
    for (const method of ["GET", "HEAD"]) {
      const res = get(service, RUNTIME_BUNDLE_METADATA_PATH, { method, headers: { "if-none-match": `"old", ${etag}` } }).res;
      expect(res.status).toBe(304); expect(res.bytes.length).toBe(0); expect(res.sentHeaders.ETag).toBe(etag);
    }
    clock += 10_000;
    expect(get(service, RUNTIME_BUNDLE_METADATA_PATH, { headers: { "if-none-match": '"different"' } }).res.bytes.equals(first.bytes)).toBe(true);
  });
  it("shares the ZIP rate bucket, charges HEAD and 304, and refills without letting metadata bypass the download limit", () => {
    const service = make(), etag = `"${fixtureBundle().version}-${fixtureBundle().sha256}"`;
    expect(get(service, RUNTIME_BUNDLE_PATH).res.status).toBe(200);
    expect(get(service, RUNTIME_BUNDLE_METADATA_PATH).res.status).toBe(200);
    expect(get(service, RUNTIME_BUNDLE_METADATA_PATH, { method: "HEAD" }).res.status).toBe(200);
    expect(get(service, RUNTIME_BUNDLE_METADATA_PATH, { headers: { "if-none-match": etag } }).res.status).toBe(304);
    for (const path of [RUNTIME_BUNDLE_METADATA_PATH, RUNTIME_BUNDLE_PATH]) {
      const held = get(service, path).res; expect(held.status).toBe(429); expect(held.sentHeaders["Retry-After"]).toBe("30");
    }
    expect(get(service, RUNTIME_INSTALL_SCRIPT_PATH).res.status).toBe(200);
    expect(get(service, RUNTIME_BUNDLE_METADATA_PATH, { remote: "::1" }).res.status).toBe(200);
    clock += 5_001;
    expect(get(service, RUNTIME_BUNDLE_METADATA_PATH).res.status).toBe(200);
    expect(get(service, RUNTIME_BUNDLE_PATH).res.status).toBe(429);
  });
  it("applies the global download bound to metadata from many peers", () => {
    const service = make();
    for (let i = 0; i < 60; i++) expect(get(service, RUNTIME_BUNDLE_METADATA_PATH, { remote: `192.0.2.${i + 1}`, encrypted: true }).res.status).toBe(200);
    expect(get(service, RUNTIME_BUNDLE_METADATA_PATH, { remote: "198.51.100.1", encrypted: true }).res.status).toBe(429);
    expect(get(service, RUNTIME_BUNDLE_PATH).res.status).toBe(429);
  });
  it("withholds metadata for empty, overlarge or unavailable artifacts and retries a later successful build", () => {
    for (const bytes of [0, RUNTIME_MAX_ARCHIVE_BYTES + 1]) {
      const service = make({ bundle: () => fixtureBundle("2.3.5", bytes) }), res = get(service, RUNTIME_BUNDLE_METADATA_PATH).res;
      expect(res.status, String(bytes)).toBe(503); expect(res.sentHeaders.ETag).toBeUndefined();
      expect(res.body).not.toContain('"sha256"');
    }
    const bundle = vi.fn().mockImplementationOnce(() => { throw Error("private fixture path"); }).mockReturnValue(fixtureBundle());
    const service = make({ bundle }), failed = get(service, RUNTIME_BUNDLE_METADATA_PATH).res;
    expect(failed.status).toBe(503); expect(failed.body).not.toContain("private fixture path");
    expect(get(service, RUNTIME_BUNDLE_METADATA_PATH).res.status).toBe(200);
    expect(bundle).toHaveBeenCalledTimes(2);
  });
});

describe("the public gateway link never carries the installer", () => {
  it("does not list any installer route among the public routes, for any method", () => {
    for (const path of [...INSTALL_ROUTES, "/runtime/v1/pair", "/runtime/v1/claim", "/ui/runtimes/installer"])
      for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE"]) expect(isPublicWebRoute(method, path), `${method} ${path}`).toBe(false);
  });
  it("refuses all installer routes at the gateway with a 404 before anything is dispatched, while remote runtimes are on", () => {
    let callback!: (req: IncomingMessage, res: ServerResponse) => void;
    const server = Object.assign(new EventEmitter(), { close: vi.fn(), closeAllConnections: vi.fn(), setTimeout: vi.fn() }), dispatch = vi.fn();
    const gateway = createPublicWebGateway({ exposureId: "e".repeat(32), isCurrent: () => true, isOpen: () => true, dispatch,
      create: ((handler: typeof callback) => { callback = handler; return server; }) as never });
    gateway.setHost("gateway-fixture.trycloudflare.com");
    for (const path of INSTALL_ROUTES) for (const method of ["GET", "HEAD"]) {
      const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "gateway-fixture.trycloudflare.com" }, socket: { remoteAddress: "198.51.100.7", encrypted: true } });
      let status = 0; const res = { headersSent: false, destroyed: false, writableEnded: false, setHeader: vi.fn(), writeHead: (code: number) => { status = code; }, end: vi.fn(), destroy: vi.fn() };
      callback(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      expect(status, `${method} ${path}`).toBe(404);
    }
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("what is served carries no token, pairing code or host-specific address", () => {
  const template = readFileSync("templates/runtime-install/install.ps1", "utf8");
  it("the script, rendered from the real template, holds only its own pins and fixed, public references", () => {
    const bundle = fixtureBundle(), script = renderRuntimeInstallScript(template, bundle);
    // the only 64-hex strings are the bundle's SHA-256 (twice at most: the pin), never a token
    expect([...new Set(script.match(/[a-f0-9]{32,}/gi) ?? [])]).toEqual([bundle.sha256]);
    // no pairing code, no bearer or authorization material, no secret-looking word used as a value
    expect(script).not.toMatch(/\b[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}\b/);
    // (words are checked in the code, not in comments that explain what the script refuses to accept)
    const code = script.split("\n").filter(line => !/^\s*#/.test(line) && !/^\s*\/\//.test(line)).join("\n");
    expect(code).not.toMatch(/\bBearer\b|\bAuthorization\b|X-Agend-Token|web\.token|claimSecret|password|secret|token/i);
    expect(code).not.toMatch(/\bpair(ing)?\s*(code)?\s*=|\/runtime\/v1\/(pair|claim|rotate|connect)/i);
    // no IP address, no host name, no tailnet name: the only URLs are the placeholder example and nodejs.org
    // (the loopback names the script accepts for http are the one fixed exception: they name this computer, not a host)
    const named = script.replace(/'(localhost|127\.0\.0\.1|\[::1\]|::1)'/g, "'loopback'");
    expect(named).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(named).not.toMatch(/\.ts\.net|trycloudflare|localhost|127\.0\.0\.1/i);
    const hosts = [...script.matchAll(/https?:\/\/([^\s'"\/)]+)/g)].map(match => match[1]);
    expect(hosts.every(host => ["your-agend-host", "nodejs.org"].includes(host))).toBe(true);
  });
  it("rendering puts nothing of the machine it runs on into the script: injected identity and secret sentinels never reach it, and the check does catch a real interpolation", () => {
    // The secret is a run of one repeated character, so it can never be mistaken for a credential by a scanner. Distinctive values that appear nowhere in the template (a real user or host name, such as a CI account called "runner", can: it is not evidence of anything). They are
    // injected where a careless render could pick them up (the environment, the AgEnD home, a token file) and must not come out.
    const sentinels = { user: "sentinel-user-7f3c9a1e", host: "sentinel-host-b52d08c4", secret: "Z".repeat(32), home: "sentinel-home-3c8e5b20" };
    const home = mkdtempSync(join(tmpdir(), `agend-${sentinels.home}-`)); cleanups.push(() => { if (!resolve(home).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe cleanup"); rmSync(home, { recursive: true, force: true }); });
    writeFileSync(join(home, "web.token"), sentinels.secret);
    for (const name of ["USER", "USERNAME", "LOGNAME"]) vi.stubEnv(name, sentinels.user);
    for (const name of ["HOSTNAME", "COMPUTERNAME"]) vi.stubEnv(name, sentinels.host);
    vi.stubEnv("AGEND_HOME", home); vi.stubEnv("AGEND_WEB_TOKEN", sentinels.secret); vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    const leaks = (text: string): string[] => Object.values(sentinels).filter(value => text.includes(value));
    const bundle = fixtureBundle(), rendered = renderRuntimeInstallScript(template, bundle);
    expect(leaks(rendered)).toEqual([]);
    expect(leaks(get(make({ template: () => template }), RUNTIME_INSTALL_SCRIPT_PATH).res.body)).toEqual([]);
    // control: the check is not blind. The one value a render does interpolate is the version, so a sentinel carried there must be found (a valid version, so it is accepted).
    const interpolated = renderRuntimeInstallScript(template, { ...bundle, version: `2.3.5-${sentinels.user}` });
    expect(leaks(interpolated)).toEqual([sentinels.user]);
  });
  it("the generic archive the route sends has no server address, no token and no pairing code in what AgEnD wrote", () => {
    // what the route serves is createRuntimeBundle()'s output without a server origin; its own files are scanned, not third-party licences
    const token = "T".repeat(48), home = mkdtempSync(join(tmpdir(), "agend-served-")); cleanups.push(() => { if (!resolve(home).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe cleanup"); rmSync(home, { recursive: true, force: true }); }); writeFileSync(join(home, "web.token"), token);
    vi.stubEnv("AGEND_HOME", home);
    const f = runtimeBundleFixture(); cleanups.push(f.cleanup);
    const bundle = createRuntimeBundle(f), served = get(make({ bundle: () => bundle }), RUNTIME_BUNDLE_PATH).res.bytes;
    expect(served.equals(bundle.bytes)).toBe(true);
    expect(served.includes(Buffer.from(token))).toBe(false);
    // injected identity sentinels (a real host or user name, such as a CI account called "runner", can legitimately occur in text and proves nothing)
    const user = "sentinel-user-5a1c88f3", host = "sentinel-host-d04b7e92";
    for (const name of ["USER", "USERNAME", "LOGNAME"]) vi.stubEnv(name, user);
    for (const name of ["HOSTNAME", "COMPUTERNAME"]) vi.stubEnv(name, host);
    const again = createRuntimeBundle(f), sent = get(make({ bundle: () => again }), RUNTIME_BUNDLE_PATH).res.bytes;
    for (const value of [user, host]) expect(sent.includes(Buffer.from(value)), value).toBe(false);
    // control: a bundle that is given a server address (the one thing a download may carry) does contain it, so the scan can see an interpolated value
    const withOrigin = createRuntimeBundle({ ...f, serverOrigin: `https://${host}.example.test` });
    expect(withOrigin.bytes.includes(Buffer.from(host))).toBe(true);
    const files = unzipStored(served);
    expect(files.has("agend-runtime/agend-server.json")).toBe(false);
    for (const name of ["README.txt", "connect-agend.bat", "agend-runtime.cmd", "package.json", "bundle-manifest.json"]) {
      const text = files.get(`agend-runtime/${name}`)!.toString();
      expect(text, name).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/); expect(text, name).not.toMatch(/\.ts\.net|trycloudflare|localhost|127\.0\.0\.1/i);
      expect(text, name).not.toMatch(/\b[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}\b/); expect(text, name).not.toMatch(/Bearer|X-Agend-Token|web\.token/);
      expect([...text.matchAll(/https?:\/\/([^\s'"\/)]+)/g)].every(match => ["your-agend-host", "example.com"].includes(match[1])), name).toBe(true);
    }
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
  it("serves the installer files and metadata with no sign-in, ahead of the web gate, while remote runtimes are on", () => {
    const dispatch = dispatcher(), script = dispatch(RUNTIME_INSTALL_SCRIPT_PATH), zip = dispatch(RUNTIME_BUNDLE_PATH), metadata = dispatch(RUNTIME_BUNDLE_METADATA_PATH);
    expect(script.status).toBe(200); expect(script.body.toString()).toContain(fixtureBundle().sha256);
    expect(zip.status).toBe(200); expect(zip.body.equals(fixtureBundle().bytes)).toBe(true);
    expect(metadata.status).toBe(200); expect(JSON.parse(metadata.body.toString())).toEqual({ version: fixtureBundle().version, sha256: createHash("sha256").update(zip.body).digest("hex"), bytes: zip.body.length });
  });
  it("is still behind the Host allow-list, so a rebinding page gets nothing", () => {
    for (const path of INSTALL_ROUTES) {
      const { status, body } = dispatcher()(path, { headers: { host: "evil.example" } });
      expect(status).toBe(403); expect(body.toString()).not.toContain("sha256");
    }
  });
  it("answers 404 for all installer routes when remote runtimes are off, with no sign-in prompt, and on a public gateway link", () => {
    vi.stubEnv("AGEND_REMOTE_RUNTIME", "");
    for (const path of INSTALL_ROUTES) { const off = dispatcher()(path); expect(off.status, path).toBe(404); expect(off.body.toString()).toContain("Not found"); }
    vi.stubEnv("AGEND_REMOTE_RUNTIME", "1");
    for (const path of INSTALL_ROUTES) {
      const gateway = dispatcher()(path, {}, req => bindGatewayRequest(req, { surface: "gateway", exposureId: "a".repeat(32), expectedOrigin: "https://public.example", isCurrent: () => true }));
      expect(gateway.status, path).toBe(404); expect(gateway.body.equals(fixtureBundle().bytes)).toBe(false);
    }
  });
  it("leaves every other path to the sign-in gate, so only these three routes are public", () => {
    expect(dispatcher()("/runtime/install.sh").status).toBe(401); expect(dispatcher()("/runtime/v1/bundle/linux.zip").status).toBe(401);
    vi.stubEnv("AGEND_REMOTE_RUNTIME", ""); expect(dispatcher()("/runtime/install.ps1.bak").status).toBe(401);
  });
});
