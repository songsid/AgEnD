import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest } from "../src/web-api.js";
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } });
async function rig(refresh = vi.fn(async (_b: string, _i: string | null): Promise<any> => ({ models: [{ id: "new", label: "New" }], refreshed: true }))) {
  const token = "a".repeat(48); const ctx: any = { webToken: token, refreshModelCatalogFor: refresh, logger: { info() {}, error() {}, warn() {}, debug() {} } };
  const server = createServer((req, res) => { handleWebRequest(req, res, new URL(req.url!, `http://${req.headers.host}`), ctx); });
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (body: any, auth = token) => fetch(base + "/ui/models/refresh", { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { "x-agend-token": auth } : {}) }, body: JSON.stringify(body) });
  return { post, ctx, refresh, base, token };
}
describe("explicit model rediscovery route", () => {
  it("requires admin admission and valid identifiers before discovery", async () => {
    const r = await rig();
    expect((await r.post({ backend: "codex" }, "")).status).toBe(401);
    for (const body of [null, [], { backend: "Bad Name" }, { backend: "codex", instance: "../x" }, { backend: "codex", runtime: "unknown" }]) expect((await r.post(body)).status).toBe(400);
    expect(r.refresh).not.toHaveBeenCalled();
    const answer = await r.post({ backend: "claude-code", instance: "w" });
    expect(answer.status).toBe(200); expect(await answer.json()).toMatchObject({ backend: "claude-code", refreshed: true });
    expect(r.refresh).toHaveBeenCalledWith("claude-code", "w");
  });
  it("cookie refresh checks Origin/CSRF and refuses read sessions before discovery", async () => {
    const r = await rig(); r.ctx.webSessions = new WebSessionStore();
    const admin = r.ctx.webSessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(r.token) });
    const reader = r.ctx.webSessions.create({ tier: "read", surface: "local", label: "read", tokenEpoch: tokenEpoch(r.token) });
    const call = (id: string, origin: string, csrf: boolean) => fetch(r.base + "/ui/models/refresh", { method: "POST", headers: { "content-type": "application/json", cookie: `agend_session=${id}`, origin, ...(csrf ? { "x-agend-csrf": csrfTokenFor(id) } : {}) }, body: JSON.stringify({ backend: "codex" }) });
    expect([401, 403]).toContain((await call(admin.sessionId, "https://evil.example", true)).status);
    expect([401, 403]).toContain((await call(admin.sessionId, r.base, false)).status);
    expect([401, 403]).toContain((await call(reader.sessionId, r.base, true)).status);
    expect(r.refresh).not.toHaveBeenCalled();
    expect((await call(admin.sessionId, r.base, true)).status).toBe(200); expect(r.refresh).toHaveBeenCalledTimes(1);
  });
  it("revocation during discovery sends no model rows", async () => {
    let resolve!: (v: any) => void, started!: () => void;
    const entered = new Promise<void>(r => { started = r; });
    const r = await rig(vi.fn(async () => { started(); return new Promise(resolve2 => { resolve = resolve2; }); }));
    const pending = r.post({ backend: "codex", instance: "w" }); await entered; r.ctx.webToken = "b".repeat(48);
    resolve({ models: [{ id: "private", label: "Private" }], refreshed: true });
    const result = await pending; expect(result.status).toBe(403); expect(await result.text()).not.toContain("private");
  });
});
