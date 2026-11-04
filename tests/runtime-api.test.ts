import { IncomingMessage, ServerResponse, createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { handleRuntimeRequest, type RuntimeApiContext } from "../src/runtime-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { WEB_SESSION_COOKIE } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const token = "t".repeat(48), homes: string[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [];
function context() {
  const home = mkdtempSync(join(tmpdir(), "agend-runtime-api-")); homes.push(home); const hub = new RuntimeCoordinator(home); hubs.push(hub);
  const ctx: RuntimeApiContext = { webToken: token, runtimeCoordinator: () => hub }; return { hub, ctx };
}
function request(path: string, method = "GET", body: unknown = {}): IncomingMessage {
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  req.method = method; req.url = path; req.headers = { host: "localhost", "x-agend-token": token };
  Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" }, configurable: true }); return req;
}
class Response extends ServerResponse {
  status = 0; body = ""; bytes = Buffer.alloc(0); sentHeaders: Record<string, string | number | readonly string[] | undefined> = {};
  override writeHead(code: number, headers?: unknown): this { this.status = code; this.sentHeaders = headers && typeof headers === "object" && !Array.isArray(headers) ? headers as import("node:http").OutgoingHttpHeaders : {}; return this; }
  override end(chunk?: unknown): this { this.body += String(chunk ?? ""); if (chunk !== undefined) this.bytes = Buffer.concat([this.bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]); return this; }
}
function run(ctx: RuntimeApiContext, path: string, method = "GET", body: unknown = {}) {
  const req = request(path, method, body), res = new Response(req); const handled = handleRuntimeRequest(req, res, new URL(path, "http://localhost"), ctx); return { req, res, handled };
}
beforeEach(() => vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"));
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const h of hubs.splice(0)) h.close();
  for (const s of servers.splice(0)) await new Promise<void>(done => s.close(() => done()));
  for (const path of homes.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe test cleanup"); rmSync(path, { recursive: true, force: true }); }
});

describe("runtime administration API", () => {
  it("is opt-in and reads disabled state without creating the service", () => {
    vi.stubEnv("AGEND_REMOTE_RUNTIME", ""); const get = vi.fn(), ctx = { webToken: token, runtimeCoordinator: get };
    const list = run(ctx, "/ui/runtimes"); expect(list.res.status).toBe(200); expect(JSON.parse(list.res.body)).toEqual({ enabled: false, machines: [] });
    expect(run(ctx, "/ui/runtimes/pairing", "POST").res.status).toBe(404); expect(get).not.toHaveBeenCalled();
  });
  it("requires local administrator authorization and rejects public links and cross-origin writes", () => {
    const { ctx, hub } = context(), create = vi.spyOn(hub, "createPairing");
    for (const kind of ["missing", "origin", "gateway"]) {
      const req = request("/ui/runtimes/pairing", "POST"), res = new Response(req);
      if (kind === "missing") delete req.headers["x-agend-token"];
      if (kind === "origin") req.headers.origin = "https://foreign.example";
      if (kind === "gateway") bindGatewayRequest(req, { surface: "gateway", exposureId: "a".repeat(32), expectedOrigin: "https://public.example", isCurrent: () => true });
      handleRuntimeRequest(req, res, new URL(req.url!, "http://localhost"), ctx); expect(res.status).toBe(403);
    }
    expect(create).not.toHaveBeenCalled();
  });
  it("requires a session's CSRF proof and administrator tier", async () => {
    for (const tier of ["admin", "read", "guest"] as const) {
      const { ctx: base } = context(), store = new WebSessionStore(), ctx: RuntimeApiContext = { ...base, webSessions: store };
      const session = store.create({ tier, surface: "local", label: "test", tokenEpoch: tokenEpoch(token), ...(tier === "guest" ? { owner: { adapterId: "tg", userId: "1" } } : {}) });
      const make = (csrf: boolean) => { const req = request("/ui/runtimes/pairing", "POST"), res = new Response(req); delete req.headers["x-agend-token"]; req.headers.cookie = `${WEB_SESSION_COOKIE}=${session.sessionId}`; req.headers.origin = "http://localhost"; if (csrf) req.headers["x-agend-csrf"] = csrfTokenFor(session.sessionId); handleRuntimeRequest(req, res, new URL(req.url!, "http://localhost"), ctx); return res; };
      expect(make(false).status).toBe(403); const res = make(true); await vi.waitFor(() => expect(res.status).toBe(tier === "admin" ? 201 : 403));
    }
  });
  it("rechecks authorization after reading a mutation body", async () => {
    const { ctx, hub } = context(), create = vi.spyOn(hub, "createPairing"), { res } = run(ctx, "/ui/runtimes/pairing", "POST");
    (ctx as { webToken: string | null }).webToken = null; await vi.waitFor(() => expect(res.status).toBe(403)); expect(create).not.toHaveBeenCalled();
  });
  it("creates a single-use pairing code, lists pending machines, and approves/renames/revokes them", async () => {
    const { ctx, hub } = context(), create = run(ctx, "/ui/runtimes/pairing", "POST"); await vi.waitFor(() => expect(create.res.status).toBe(201));
    const p = JSON.parse(create.res.body), pending = hub.pair({ code: p.code, name: "Desk", platform: "win32" });
    const list = JSON.parse(run(ctx, "/ui/runtimes").res.body); expect(list.machines[0].status).toBe("pending"); expect(JSON.stringify(list)).not.toMatch(/Hash|credential|claimSecret/);
    for (const [op, body, expected] of [["approve", { fingerprint: hub.machine(pending.machineId)?.pairingFingerprint }, "offline"], ["rename", { name: "Work PC" }, "Work PC"], ["revoke", {}, "revoked"]] as const) {
      const result = run(ctx, `/ui/runtimes/machines/${pending.machineId}/${op}`, "POST", body); await vi.waitFor(() => expect(result.res.status).toBe(200)); const machine = JSON.parse(result.res.body).machine; expect(op === "rename" ? machine.name : machine.status).toBe(expected);
    }
  });
  it("returns inventory freshness without exposing credentials", () => {
    const { ctx, hub } = context(), p = hub.createPairing(), pending = hub.pair({ code: p.code, name: "Desk", platform: "win32" });
    const response = run(ctx, `/ui/runtimes/machines/${pending.machineId}/inventory`); expect(response.res.status).toBe(200); expect(JSON.parse(response.res.body)).toEqual({ machineId: pending.machineId, inventory: null, updatedAt: null, status: "pending" });
  });
  it.each([null, [], { unexpected: true }])("rejects malformed pairing input %j", async body => {
    const { ctx, hub } = context(), create = vi.spyOn(hub, "createPairing"), { res } = run(ctx, "/ui/runtimes/pairing", "POST", body);
    await vi.waitFor(() => expect(res.status).toBe(400)); expect(create).not.toHaveBeenCalled();
  });
});

describe("runtime package download", () => {
  const path = "/ui/runtimes/download/windows";
  function setup() {
    const coordinator = vi.fn((): RuntimeCoordinator => { throw Error("Downloads must not create a coordinator"); });
    const ctx: RuntimeApiContext = { webToken: token, runtimeCoordinator: coordinator };
    const file = { bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]), filename: "agend-runtime-windows-2.3.3.zip", sha256: "a".repeat(64) };
    const bundle = vi.fn(() => file);
    const download = (req = request(path)) => {
      const res = new Response(req);
      expect(handleRuntimeRequest(req, res, new URL(req.url!, "http://localhost"), ctx, bundle)).toBe(true);
      return res;
    };
    return { ctx, file, bundle, coordinator, download };
  }
  it("serves an exact binary attachment, and HEAD metadata, without starting the execution service", () => {
    const { file, bundle, coordinator, download } = setup();
    const get = download();
    expect(get.status).toBe(200); expect(get.bytes).toEqual(file.bytes);
    expect(get.sentHeaders).toMatchObject({ "Content-Type": "application/zip", "Content-Length": file.bytes.length,
      "Content-Disposition": 'attachment; filename="agend-runtime-windows-2.3.3.zip"', "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", "X-Agend-SHA256": file.sha256 });
    const head = download(request(path, "HEAD")); expect(head.status).toBe(200); expect(head.bytes.length).toBe(0);
    expect(head.sentHeaders).toEqual(get.sentHeaders); expect(bundle).toHaveBeenCalledTimes(2); expect(coordinator).not.toHaveBeenCalled();
  });
  it("uses the local administrator session for ordinary browser downloads", () => {
    const { ctx, download } = setup(), store = new WebSessionStore(); Object.assign(ctx, { webSessions: store });
    const session = store.create({ tier: "admin", surface: "local", label: "download", tokenEpoch: tokenEpoch(token) });
    const req = request(path); delete req.headers["x-agend-token"]; req.headers.cookie = `${WEB_SESSION_COOKIE}=${session.sessionId}`;
    expect(download(req).status).toBe(200);
  });
  it("rejects unauthenticated, public gateway and read/guest sessions before reading program files", () => {
    const { ctx, bundle, coordinator, download } = setup(), store = new WebSessionStore(); Object.assign(ctx, { webSessions: store });
    const missing = request(path); delete missing.headers["x-agend-token"]; expect(download(missing).status).toBe(403);
    const gateway = request(path); bindGatewayRequest(gateway, { surface: "gateway", exposureId: "a".repeat(32), expectedOrigin: "https://public.example", isCurrent: () => true });
    expect(download(gateway).status).toBe(403);
    for (const tier of ["read", "guest"] as const) {
      const session = store.create({ tier, surface: "local", label: "denied", tokenEpoch: tokenEpoch(token), ...(tier === "guest" ? { owner: { adapterId: "tg", userId: "1" } } : {}) });
      const req = request(path); delete req.headers["x-agend-token"]; req.headers.cookie = `${WEB_SESSION_COOKIE}=${session.sessionId}`;
      expect(download(req).status).toBe(403);
    }
    expect(bundle).not.toHaveBeenCalled(); expect(coordinator).not.toHaveBeenCalled();
  });
  it("rejects caller-selected paths and remains unavailable when the preview is disabled", () => {
    const { bundle, coordinator, download } = setup();
    expect(download(request(path + "?path=connection.json")).status).toBe(400);
    vi.stubEnv("AGEND_REMOTE_RUNTIME", ""); expect(download().status).toBe(404);
    expect(bundle).not.toHaveBeenCalled(); expect(coordinator).not.toHaveBeenCalled();
  });
  it("creates a connection-ready download only from an authenticated bounded POST, never query or Host defaults",async()=>{
    const {bundle,coordinator,download,file}=setup();
    const ready=download(request(path,"POST",{server:"https://fleet.example.test:10443"}));await vi.waitFor(()=>expect(ready.status).toBe(200));expect(ready.bytes).toEqual(file.bytes);expect(bundle).toHaveBeenLastCalledWith({serverOrigin:"https://fleet.example.test:10443"});
    expect(coordinator).not.toHaveBeenCalled();bundle.mockClear();
    for(const body of [{server:"http://192.0.2.5"},{server:"https://user:password@fleet.example"},{server:"https://fleet.example/path"},{server:"https://fleet.example",code:"SECRET"},{server:"x".repeat(5000)}]){
      const bad=download(request(path,"POST",body));await vi.waitFor(()=>expect(bad.status).toBe(400));
    }
    expect(download(request(path+"?server=https://fleet.example")).status).toBe(400);expect(bundle).not.toHaveBeenCalled();
  });
  it("requires browser CSRF proof and rechecks authorization after reading connection-ready download input",async()=>{
    const {ctx,bundle,download}=setup(),store=new WebSessionStore();Object.assign(ctx,{webSessions:store});
    const session=store.create({tier:"admin",surface:"local",label:"download",tokenEpoch:tokenEpoch(token)});
    const req=request(path,"POST",{server:"https://fleet.example.test"});delete req.headers["x-agend-token"];req.headers.cookie=`${WEB_SESSION_COOKIE}=${session.sessionId}`;req.headers.origin="http://localhost";
    expect(download(req).status).toBe(403);expect(bundle).not.toHaveBeenCalled();
    req.headers["x-agend-csrf"]=csrfTokenFor(session.sessionId);const valid=download(req);await vi.waitFor(()=>expect(valid.status).toBe(200));
    bundle.mockClear();const held=download(request(path,"POST",{server:"https://fleet.example.test"}));(ctx as {webToken:string|null}).webToken=null;await vi.waitFor(()=>expect(held.status).toBe(403));expect(bundle).not.toHaveBeenCalled();
  });
  it("returns an actionable unavailable response without leaking host paths or a partial ZIP", () => {
    const { bundle, coordinator, download } = setup(); bundle.mockImplementation(() => { throw Error("ENOENT /private/profile/connection.json"); });
    const res = download(); expect(res.status).toBe(503); expect(res.sentHeaders["Content-Type"]).toContain("application/json");
    expect(JSON.parse(res.body).error).toContain("Update or reinstall AgEnD"); expect(res.body).not.toMatch(/private|connection\.json|ENOENT/);
    expect(coordinator).not.toHaveBeenCalled();
  });
});

describe("runtime non-browser public pairing endpoints", () => {
  it("does not accept browser credentials, queries or plain remote HTTP", () => {
    const { hub } = context();
    for (const kind of ["origin", "cookie", "remote", "query"]) {
      const req = request("/runtime/v1/pair", "POST"), res = new Response(req);
      if (kind === "origin") req.headers.origin = "http://localhost";
      if (kind === "cookie") req.headers.cookie = "session=anything";
      if (kind === "remote") Object.defineProperty(req, "socket", { value: { remoteAddress: "192.0.2.8" } });
      expect(hub.handlePublicRequest(req, res, new URL(req.url! + (kind === "query" ? "?code=secret" : ""), "http://localhost"))).toBe(true); expect(res.status).toBe(403);
    }
  });
  it("pairs and polls approval over actual loopback HTTP without browser cookies", async () => {
    const { hub } = context(), p = hub.createPairing(), server = createServer((req, res) => { if (!hub.handlePublicRequest(req, res, new URL(req.url!, "http://localhost"))) { res.writeHead(404); res.end(); } }); servers.push(server);
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw Error("No port"); const base = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const response = await post("/runtime/v1/pair", { code: p.code, name: "Desk", platform: "win32" }); expect(response.status).toBe(201); const paired = await response.json() as { machineId: string; claimSecret: string };
    const body = { machineId: paired.machineId, claimSecret: paired.claimSecret };
    expect((await post("/runtime/v1/claim", body)).status).toBe(202); hub.approve(paired.machineId, hub.machine(paired.machineId)?.pairingFingerprint);
    const claim = await post("/runtime/v1/claim", body); expect(claim.status).toBe(200); const identity = await claim.json() as { credential: string }; expect(identity.credential).toMatch(/^[a-f0-9]{64}$/);
    expect((await post("/runtime/v1/claim", body)).status).toBe(400);
  });
});
