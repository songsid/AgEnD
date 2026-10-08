import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSessionStore, tokenEpoch, csrfTokenFor } from "../src/web-session.js";
import { WebLoginCodes } from "../src/web-login.js";
import { decideWebGate } from "../src/web-auth.js";
import { handleAuthRequest } from "../src/auth-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { createPublicWebGateway, isPublicWebRoute } from "../src/public-web-gateway.js";
import { handleViewRequest } from "../src/view-api.js";
import { handleSettingsRequest } from "../src/settings-api.js";
const id = "a".repeat(32), second = "b".repeat(32), token = "c".repeat(48), origin = "https://sample.trycloudflare.com";
const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() };
function request(path: string, method = "GET", headers: Record<string, string> = {}) {
  const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "sample.trycloudflare.com", ...headers } as Record<string, string>, destroy: vi.fn() });
  let status = 0, body = ""; const out: any = {};
  const res = { destroyed: false, headersSent: false, setHeader: (k: string, v: any) => { out[k] = v; }, writeHead: (code: number, h = {}) => { status = code; Object.assign(out, h); }, end: (text = "") => { body = text; }, destroy: vi.fn() };
  return { req, res, out, status: () => status, body: () => body, json: () => JSON.parse(body), feed: (value: unknown) => { req.emit("data", Buffer.from(JSON.stringify(value))); req.emit("end"); } };
}
function bind(req: object, current = () => true, exposureId = id) { bindGatewayRequest(req, { surface: "gateway", exposureId, expectedOrigin: origin, isCurrent: current }); }
async function flush() { for (let n = 0; n < 20; n++) await Promise.resolve(); }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("public credential scopes, real auth handlers", () => {
  it("local/header credentials never cross public surface; exact public cookie only", () => {
    const store = new WebSessionStore();
    const local = store.create({ tier: "admin", surface: "local", label: "fixture", tokenEpoch: tokenEpoch(token) });
    const pub = store.create({ tier: "admin", surface: "gateway", exposureId: id, label: "fixture", tokenEpoch: tokenEpoch(token) });
    const h = request("/ui", "GET", { "x-agend-token": token, cookie: `__Host-agend_session=${local.sessionId}` }); bind(h.req);
    expect(decideWebGate(h.req, new URL("/ui", origin), token, store).kind).toBe("reject");
    h.req.headers.cookie = `__Host-agend_session=${pub.sessionId}`;
    expect(decideWebGate(h.req, new URL("/ui", origin), token, store).kind).toBe("allow");
    const next = request("/ui", "GET", { cookie: h.req.headers.cookie }); bind(next.req, () => true, second);
    expect(decideWebGate(next.req, new URL("/ui", origin), token, store).kind).toBe("reject");
    const normal = request("/ui", "GET", { cookie: h.req.headers.cookie });
    expect(decideWebGate(normal.req, new URL("/ui", origin), token, store).kind).toBe("reject");
  });
  it("scope mismatch does not touch idle lifetime; legacy gateway record fails closed", () => {
    let now = 0; const store = new WebSessionStore({ now: () => now });
    const p = store.create({ tier: "admin", surface: "gateway", exposureId: id, label: "fixture", tokenEpoch: tokenEpoch(token) });
    now = 100; expect(store.authenticate(p.sessionId, tokenEpoch(token))).toBeNull(); expect(p.record.lastSeen).toBe(0);
    expect(store.authenticate(p.sessionId, tokenEpoch(token), { surface: "gateway", exposureId: id })?.lastSeen).toBe(100);
    const legacy = store.create({ tier: "admin", surface: "gateway", label: "fixture", tokenEpoch: tokenEpoch(token) });
    expect(store.authenticate(legacy.sessionId, tokenEpoch(token), { surface: "gateway", exposureId: id })).toBeNull();
  });
  it("a candidate session is unusable even with its id until activation", () => {
    const store = new WebSessionStore(); const candidate = store.create({ tier: "admin", surface: "gateway", exposureId: id, label: "fixture", tokenEpoch: tokenEpoch(token), pending: true });
    const scope = { surface: "gateway" as const, exposureId: id };
    expect(store.authenticate(candidate.sessionId, tokenEpoch(token), scope)).toBeNull(); expect(store.list()).toEqual([]);
    expect(store.activate(candidate.sessionId)).toBe(true); expect(store.authenticate(candidate.sessionId, tokenEpoch(token), scope)).not.toBeNull();
  });
  it("pending public credentials never reach disk, including a concurrent local save", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-public-session-"));
    try {
      const store = new WebSessionStore({ dataDir: dir });
      const local = store.create({ tier: "admin", surface: "local", label: "local", tokenEpoch: tokenEpoch(token) });
      const candidate = store.create({ tier: "admin", surface: "gateway", exposureId: id, label: "phone", tokenEpoch: tokenEpoch(token), pending: true });
      store.flush();
      const path = join(dir, "web-sessions.json");
      expect(JSON.parse(readFileSync(path, "utf8")).sessions.map((r: any) => r.idHash)).toEqual([local.record.idHash]);
      const reloaded = new WebSessionStore({ dataDir: dir });
      expect(reloaded.authenticate(candidate.sessionId, tokenEpoch(token), { surface: "gateway", exposureId: id })).toBeNull();
      expect(store.activate(candidate.sessionId)).toBe(true); store.flush();
      expect(JSON.parse(readFileSync(path, "utf8")).sessions.map((r: any) => r.idHash)).toContain(candidate.record.idHash);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("single code audience, same breaker; stale failure cannot withdraw newer issuance", () => {
    const codes = new WebLoginCodes({ generate: () => "ABCDEFGH" });
    const local = codes.issue({ epoch: tokenEpoch(token) }); expect(codes.redeem(local.display, tokenEpoch(token), id).kind).toBe("invalid");
    expect(codes.redeem(local.display, tokenEpoch(token)).kind).toBe("ok");
    const a = codes.issue({ epoch: tokenEpoch(token), audience: id }); const b = codes.issue({ epoch: tokenEpoch(token), audience: second });
    codes.revokeIfCurrent(a.issuanceId); expect(codes.redeem(b.display, tokenEpoch(token), second).kind).toBe("ok");
    codes.issue({ epoch: tokenEpoch(token), audience: id }); for (let n = 0; n < 5; n++) codes.redeem("ZZZZZZZZ", tokenEpoch(token), id);
    expect(codes.hasOutstandingCode).toBe(false);
  });
  it("awaits required public notice before activation/cookie; close after await cannot revive", async () => {
    const store = new WebSessionStore(), codes = new WebLoginCodes(); let current = true, finish!: () => void;
    const notice = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const issued = codes.issue({ epoch: tokenEpoch(token), audience: id, owner: { adapterId: "owner", userId: "admin", chatId: "G" } });
    const h = request("/auth/login", "POST", { origin, "content-type": "application/json", "x-forwarded-proto": "http" }); bind(h.req, () => current);
    handleAuthRequest(h.req as never, h.res as never, new URL(h.req.url, origin), { webToken: token, webSessions: store, webLoginCodes: codes, logger: logger as never, confirmPublicWebLogin: notice });
    h.feed({ code: issued.display }); await flush(); expect(notice).toHaveBeenCalledTimes(1); expect(h.status()).toBe(0);
    expect(store.list()).toEqual([]); expect(h.out["Set-Cookie"]).toBeUndefined();
    current = false; finish(); await flush(); expect(h.status()).toBe(503); expect(store.size).toBe(0); expect(h.out["Set-Cookie"]).toBeUndefined();
  });
  it("confirmed public sign-in produces Secure cookie despite forwarded headers, public notice even notify=false", async () => {
    const store = new WebSessionStore(), codes = new WebLoginCodes(); const notice = vi.fn(async () => {}), localNotice = vi.fn();
    const issued = codes.issue({ epoch: tokenEpoch(token), audience: id, owner: { adapterId: "owner", userId: "admin", chatId: "G" } });
    const h = request("/auth/login", "POST", { origin, "content-type": "application/json", "x-forwarded-proto": "http" }); bind(h.req);
    handleAuthRequest(h.req as never, h.res as never, new URL(h.req.url, origin), { webToken: token, webSessions: store, webLoginCodes: codes, logger: logger as never, confirmPublicWebLogin: notice, onWebLogin: localNotice });
    h.feed({ code: issued.display }); await flush(); expect(h.status()).toBe(200); expect(notice).toHaveBeenCalled(); expect(localNotice).not.toHaveBeenCalled();
    expect(h.out["Set-Cookie"]).toMatch(/^__Host-agend_session=.*; Secure$/); expect(store.list()[0]?.surface).toBe("gateway");
  });
  it("never-settling notice fails at 5 seconds and late ACK cannot activate", async () => {
    vi.useFakeTimers(); let mono = 0; vi.spyOn(performance, "now").mockImplementation(() => mono);
    const store = new WebSessionStore(), codes = new WebLoginCodes(); let finish!: () => void;
    const issued = codes.issue({ epoch: tokenEpoch(token), audience: id, owner: { adapterId: "owner", userId: "admin", chatId: "G" } });
    const h = request("/auth/login", "POST", { origin, "content-type": "application/json" }); bind(h.req);
    handleAuthRequest(h.req as never, h.res as never, new URL(h.req.url, origin), { webToken: token, webSessions: store, webLoginCodes: codes, logger: logger as never, confirmPublicWebLogin: () => new Promise(resolve => { finish = resolve; }) });
    h.feed({ code: issued.display }); await flush(); mono = 5000; await vi.advanceTimersByTimeAsync(5000);
    expect(h.status()).toBe(503); finish(); await flush(); expect(store.size).toBe(0); expect(h.out["Set-Cookie"]).toBeUndefined();
  });
  it("public Origin must include the right HTTPS scheme; writes retain CSRF checks", () => {
    const store = new WebSessionStore(); const p = store.create({ tier: "admin", surface: "gateway", exposureId: id, label: "fixture", tokenEpoch: tokenEpoch(token) });
    const h = request("/ui/send", "POST", { origin: origin.replace("https", "http"), cookie: `__Host-agend_session=${p.sessionId}`, "x-agend-csrf": csrfTokenFor(p.sessionId) }); bind(h.req);
    expect(decideWebGate(h.req, new URL("/ui/send", origin), token, store).kind).toBe("reject"); h.req.headers.origin = origin;
    expect(decideWebGate(h.req, new URL("/ui/send", origin), token, store).kind).toBe("allow");
    delete (h.req.headers as any)["x-agend-csrf"]; expect(decideWebGate(h.req, new URL("/ui/send", origin), token, store).kind).toBe("reject");
  });
  it("direct public View reads are gated even when local View is open", () => {
    const h = request("/api/profiles"); bind(h.req); const read = vi.fn();
    handleViewRequest(h.req as never, h.res as never, new URL(h.req.url, origin), { webToken: token, webSessions: new WebSessionStore(), fleetConfig: { web: { view_access: "open" } }, listInstanceProfiles: read } as never);
    expect(h.status()).toBe(401); expect(read).not.toHaveBeenCalled();
  });
  it("a public Settings body buffered across close cannot save config", async () => {
    const store = new WebSessionStore(); const p = store.create({ tier: "admin", surface: "gateway", exposureId: id, label: "fixture", tokenEpoch: tokenEpoch(token) }); let current = true;
    const h = request("/api/settings/fleet/web", "PUT", { origin, cookie: `__Host-agend_session=${p.sessionId}`, "x-agend-csrf": csrfTokenFor(p.sessionId) }); bind(h.req, () => current);
    const cfg = { defaults: {}, instances: {} }, save = vi.fn();
    handleSettingsRequest(h.req as never, h.res as never, new URL(h.req.url, origin), { webToken: token, webSessions: store, fleetConfig: cfg, saveFleetConfig: save } as never);
    current = false; h.feed({ public_link: { allow_public: false } }); await flush(); expect(save).not.toHaveBeenCalled(); expect(h.status()).toBe(401);
  });
  it("exposure revocation never signs out local sessions", () => {
    const store = new WebSessionStore(); const local = store.create({ tier: "admin", surface: "local", label: "local", tokenEpoch: tokenEpoch(token) });
    const pub = store.create({ tier: "admin", surface: "gateway", exposureId: id, label: "public", tokenEpoch: tokenEpoch(token) });
    expect(store.revokeExposure(id).count).toBe(1); expect(store.authenticate(local.sessionId, tokenEpoch(token))).not.toBeNull(); expect(store.authenticate(pub.sessionId, tokenEpoch(token), { surface: "gateway", exposureId: id })).toBeNull();
  });
});
describe("dedicated gateway manifest and sockets", () => {
  it.each(["/health", "/agent", "/status", "/activity", "/api/activity", "/auth/issue-code", "/ui/events", "/restart/worker", "/frame", "/api/settings/unknown"])("excludes %s", path => { for (const method of ["GET", "POST", "PUT"]) expect(isPublicWebRoute(method, path)).toBe(false); });
  it("real gateway rejects foreign hosts, pre-open data, absolute and malformed targets; closes tracked upgrades after listener", async () => {
    let callback!: (req: any, res: any) => void; const order: string[] = []; let open = false, current = true;
    const server: any = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), listen: (_p: number, host: string, cb: () => void) => { expect(host).toBe("127.0.0.1"); cb(); }, address: () => ({ port: 321 }), close: () => order.push("listener"), closeAllConnections: () => order.push("connections") });
    const dispatch = vi.fn(); const g = createPublicWebGateway({ exposureId: id, isCurrent: () => current, isOpen: () => open, dispatch, create: ((cb: any) => { callback = cb; return server; }) as never });
    await g.listen(); g.setHost("sample.trycloudflare.com");
    const ready = request("/signin"); callback(ready.req, ready.res); expect(ready.status()).toBe(200); expect(ready.body()).toContain(g.readinessMarker);
    const data = request("/view"); callback(data.req, data.res); expect(data.status()).toBe(503); open = true;
    const foreign = request("/ui", "GET", { host: "localhost" }); callback(foreign.req, foreign.res); expect(foreign.status()).toBe(403);
    for (const path of ["http://sample.trycloudflare.com/ui", "//sample.trycloudflare.com/ui", "/api/profile/%ZZ"]) { const h = request(path); callback(h.req, h.res); expect(h.status()).toBe(400); }
    const h = request("/view"); callback(h.req, h.res); expect(dispatch).toHaveBeenCalledTimes(1);
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(() => order.push("socket")) }); server.emit("connection", socket); server.emit("upgrade", {}, socket); expect(socket.destroy).toHaveBeenCalled();
    order.length = 0; current = false; g.close(); expect(order).toEqual(["listener", "connections", "socket"]);
    const old = request("/view"); callback(old.req, old.res); expect(old.status()).toBe(403);
  });
});
