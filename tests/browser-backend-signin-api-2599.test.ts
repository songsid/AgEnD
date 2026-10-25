/** Real private HTTP/session gate; all login/native handlers are inert. */
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { BrowserBackendSignIns } from "../src/browser-backend-signins.js";
import { LoginWindowLock } from "../src/login-window-lock.js";
import { writePendingBackendSignIns, readPendingBackendSignIns } from "../src/backend-signin-pending.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
const rigs: { server: Server; service: BrowserBackendSignIns; dir: string }[] = [];
afterEach(async () => { for (const h of rigs.splice(0)) { await h.service.close(); h.server.closeAllConnections(); await new Promise<void>(r => h.server.close(() => r())); rmSync(h.dir, { recursive: true, force: true }); } vi.restoreAllMocks(); });
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
async function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agend-browser-login-")), token = "scratch-fleet-token", sessions = new WebSessionStore({}), lock = new LoginWindowLock();
  writePendingBackendSignIns(dir, { version: 1, selected: ["codex", "antigravity"], pending: ["codex", "antigravity"] });
  const state = { gateway: false, auth: "invalid" as "invalid" | "valid", pane: "https://auth.openai.com/codex/device\nTEST-CODE", alive: true };
  const transport = { start: vi.fn(async () => {}), capture: vi.fn(async () => state.pane), status: vi.fn(async () => ({ alive: state.alive })), write: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const installed = vi.fn(async () => ["codex", "kiro-cli", "claude-code", "antigravity"]);
  const service = new BrowserBackendSignIns({ dataDir: dir, lock, current: owner => {
    const r = owner as { handle: string }; return sessions.findByHandle(r.handle) === owner && (owner as any).tier === "admin" && (owner as any).surface === "local" && sessions.isCurrent(owner as any, tokenEpoch(token));
  }, installed, checkAuth: async () => state.auth, transport: () => transport });
  const context = { webToken: token, webSessions: sessions } as WebApiContext;
  const getter = vi.fn(() => service); Object.defineProperty(context, "browserBackendSignIns", { get: getter });
  const server = createServer((req, res) => {
    if (state.gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: origin, isCurrent: () => true });
    if (!handleWebRequest(req, res, new URL(req.url!, origin), context)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  rigs.push({ server, service, dir });
  const session = (tier: "admin" | "read" | "guest" = "admin", surface: "local" | "gateway" = "local") => {
    const made = sessions.create({ tier, surface, label: "scratch browser", tokenEpoch: tokenEpoch(token), ...(surface === "gateway" ? { exposureId: "e".repeat(32) } : {}), ...(tier === "guest" ? { owner: { adapterId: "web", userId: "guest" } } : {}) });
    return { ...made, headers: { cookie: `agend_session=${made.sessionId}`, origin, "x-agend-csrf": csrfTokenFor(made.sessionId), "content-type": "application/json" } as Record<string, string> };
  };
  const call = (headers: Record<string, string>, body?: unknown) => new Promise<{ status: number; body: any; raw: string; headers: any }>((resolve, reject) => {
    const req = request(origin + "/ui/browser-backend-signins", { method: body ? "POST" : "GET", headers }, res => {
      let raw = ""; res.on("data", c => { raw += c; }); res.on("end", () => { try { resolve({ status: res.statusCode!, body: JSON.parse(raw), raw, headers: res.headers }); } catch (e) { reject(e); } });
    }); req.on("error", reject); req.setTimeout(5_000, () => req.destroy(Error("private HTTP deadline"))); req.end(body ? JSON.stringify(body) : undefined);
  });
  const admin = session();
  return { dir, token, sessions, lock, state, transport, installed, service, getter, session, admin, call };
}
it("only a current local human admin can reach the service; header/read/guest/public are refused first", async () => {
  const h = await rig();
  for (const headers of [{}, { "x-agend-token": h.token }, h.session("read").headers, h.session("guest").headers, h.session("admin", "gateway").headers]) {
    expect([401, 403]).toContain((await h.call(headers)).status);
  }
  const gateway = h.session("admin", "gateway"); gateway.headers.cookie = `__Host-agend_session=${gateway.sessionId}`;
  h.state.gateway = true; expect((await h.call(gateway.headers)).status).toBe(404);
  expect((await h.call(gateway.headers, { operation: "start", backend: "codex" })).status).toBe(403);
  expect(h.getter).not.toHaveBeenCalled(); expect(h.transport.start).not.toHaveBeenCalled();
});
it("pending IDs for a backend without an agent survive into the authenticated dashboard", async () => {
  const h = await rig(), seen = h.admin.record.lastSeen; vi.spyOn(Date, "now").mockReturnValue(seen + 1000);
  const response = await h.call(h.admin.headers); expect(h.admin.record.lastSeen).toBe(seen);
  expect(response.status).toBe(200); expect(response.body.selected).toEqual(["codex", "antigravity"]); expect(response.body.pending).toEqual(["codex", "antigravity"]);
  expect(response.body.states.antigravity).toBe("console_only"); expect(response.headers["cache-control"]).toContain("no-store"); expect(h.transport.start).not.toHaveBeenCalled();
});
it("a second admin gets no hints and cannot answer the first admin's prompt", async () => {
  const h = await rig(); const started = await h.call(h.admin.headers, { operation: "start", backend: "codex" });
  expect(started.body.login.code).toBe("TEST-CODE"); const other = h.session(); const view = await h.call(other.headers);
  expect(view.body.login.mine).toBe(false); expect(view.raw).not.toMatch(/TEST-CODE|auth.openai/);
  const input = await h.call(other.headers, { operation: "input", id: started.body.login.id, revision: started.body.login.revision, action: { kind: "code", value: "nope" } });
  expect(input.status).toBe(409); expect(h.transport.write).not.toHaveBeenCalled();
});
it("CSRF, foreign origin and arbitrary input shapes cannot start the writer", async () => {
  const h = await rig();
  expect((await h.call({ ...h.admin.headers, "x-agend-csrf": "wrong" }, { operation: "start", backend: "codex" })).status).toBe(401);
  expect((await h.call({ ...h.admin.headers, origin: "https://foreign.invalid" }, { operation: "start", backend: "codex" })).status).toBe(401);
  expect((await h.call(h.admin.headers, { operation: "start", backend: "codex", command: "sh" })).status).toBe(400);
  expect(h.transport.start).not.toHaveBeenCalled();
});
it("revocation while installation is checked prevents a late child and a late hint", async () => {
  const h = await rig(), installed = deferred<string[]>(); h.installed.mockReturnValue(installed.promise);
  const response = h.call(h.admin.headers, { operation: "start", backend: "codex" }); await vi.waitFor(() => expect(h.installed).toHaveBeenCalled());
  h.sessions.revokeByHandle(h.admin.record.handle); installed.resolve(["codex"]);
  const result = await response; expect(result.status).toBe(409); expect(result.raw).not.toMatch(/TEST-CODE|auth.openai/); expect(h.transport.start).not.toHaveBeenCalled();
});
it("shares the legacy/install writer lock, and double-clicks still join one structured attempt", async () => {
  const h = await rig(), legacy = h.lock.tryClaim("install", "codex");
  const busy = await h.call(h.admin.headers, { operation: "start", backend: "codex" }); expect(busy.body.login.reason).toBe("busy"); expect(h.transport.start).not.toHaveBeenCalled();
  h.lock.release(legacy); const a = await h.call(h.admin.headers, { operation: "start", backend: "codex" }); const b = await h.call(h.admin.headers, { operation: "start", backend: "codex" });
  expect(a.body.login.id).toBe(b.body.login.id); expect(h.transport.start).toHaveBeenCalledOnce();
});
it("a verified auth check removes the pending hint; a screen/exit alone does not", async () => {
  const h = await rig(); h.state.alive = false;
  const failed = await h.call(h.admin.headers, { operation: "start", backend: "codex" }); expect(failed.body.login.reason).toBe("auth_unconfirmed"); expect(readPendingBackendSignIns(h.dir).pending).toContain("codex");
  h.state.auth = "valid"; const done = await h.call(h.admin.headers, { operation: "start", backend: "codex" }); expect(done.body.login.phase).toBe("done"); expect(readPendingBackendSignIns(h.dir).pending).toEqual(["antigravity"]);
});
