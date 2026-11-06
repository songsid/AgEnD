/**
 * Who is shown the account (masked e-mail and plan) on the routes that also serve the CLI's header token: /ui/runtimes* and /ui/windows-cli/probe.
 * A local administrator SESSION sees it; every other caller gets the same answer without it (names and signed-in state stay).
 */
import { IncomingMessage, ServerResponse, createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { handleRuntimeRequest, type RuntimeApiContext } from "../src/runtime-api.js";
import { handleWindowsCliRequest, probeWithoutAccountIdentity } from "../src/windows-cli-api.js";
import type { WindowsCliBridge, WindowsCliProbe } from "../src/windows-cli.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { WEB_SESSION_COOKIE } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const token = "t".repeat(48), homes: string[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [], sockets: WebSocket[] = [];
const identity = { maskedEmail: "al***@example.com", plan: "team" as const }, profileIdentity = { maskedEmail: "bo***@example.org", plan: "max" as const };
const probe = (): WindowsCliProbe => ({ home: "C:\\U", probedAt: 1, clis: [{ id: "claude-code", path: "C:\\claude.exe", version: "2.1.316", authenticated: true, runnable: true, readOnlySupport: true, permissionNote: "", models: [], supports: { execution: true, resume: true, model: true, mcp: true }, identity }] as never,
  credentialProfiles: { default: "work", profiles: [{ name: "work", loggedIn: true, identity: profileIdentity }, { name: "out", loggedIn: false }] } });
class Response extends ServerResponse {
  status = 0; body = "";
  override writeHead(code: number): this { this.status = code; return this; }
  override end(chunk?: unknown): this { this.body += String(chunk ?? ""); return this; }
}
type Who = "header-token" | "admin" | "read" | "guest" | "gateway";
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "agend-identity-redaction-")); homes.push(home);
  const hub = new RuntimeCoordinator(home); hubs.push(hub);
  const pairing = hub.createPairing(), pending = hub.pair({ code: pairing.code, name: "Desk", platform: "win32" });
  hub.approve(pending.machineId, hub.machine(pending.machineId)?.pairingFingerprint);
  const claim = hub.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret }); if (claim.status !== "approved") throw Error("pairing fixture failed");
  const server = createServer((req, res) => { if (!hub.handlePublicRequest(req, res, new URL(req.url ?? "/", "http://localhost"))) { res.writeHead(404); res.end(); } });
  servers.push(server); server.on("upgrade", (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address() as { port: number };
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/runtime/v1/connect`, { headers: { Authorization: `Bearer ${claim.credential}` } }); sockets.push(ws);
  await once(ws, "open"); const welcome = once(ws, "message"); ws.send(JSON.stringify({ v: 1, type: "hello", bootId: "redaction-boot", inventory: probe() })); await welcome;
  const store = new WebSessionStore(), ctx: RuntimeApiContext = { webToken: token, webSessions: store, runtimeCoordinator: () => hub };
  const session = (tier: "admin" | "read" | "guest") => store.create({ tier, surface: "local", label: "test", tokenEpoch: tokenEpoch(token), ...(tier === "guest" ? { owner: { adapterId: "tg", userId: "1" } } : {}) });
  const sessions = { admin: session("admin"), read: session("read"), guest: session("guest") };
  const gatewayAdmin = store.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "gateway", tokenEpoch: tokenEpoch(token) });
  const request = (who: Who, path: string, method = "GET", body: unknown = {}): { req: IncomingMessage; res: Response } => {
    const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage; req.method = method; req.url = path;
    req.headers = { host: "localhost" }; Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" }, configurable: true });
    if (who === "header-token") req.headers["x-agend-token"] = token;
    else if (who === "gateway") { req.headers.cookie = `${WEB_SESSION_COOKIE}=${gatewayAdmin.sessionId}`; bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://public.example", isCurrent: () => true }); }
    else { const s = sessions[who]; req.headers.cookie = `${WEB_SESSION_COOKIE}=${s.sessionId}`; if (method !== "GET") { req.headers.origin = "http://localhost"; req.headers["x-agend-csrf"] = csrfTokenFor(s.sessionId); } }
    return { req, res: new Response(req) };
  };
  const call = async (who: Who, path: string, method = "GET", body: unknown = {}) => {
    const { req, res } = request(who, path, method, body); handleRuntimeRequest(req, res, new URL(path, "http://localhost"), ctx);
    await vi.waitFor(() => expect(res.status).not.toBe(0)); return { status: res.status, body: res.body };
  };
  const cli = async (who: Who, bridge: WindowsCliBridge) => {
    const { req, res } = request(who, "/ui/windows-cli/probe", "POST", { force: true }); handleWindowsCliRequest(req, res, new URL("/ui/windows-cli/probe", "http://localhost"), ctx, bridge);
    await vi.waitFor(() => expect(res.status).not.toBe(0)); return { status: res.status, body: res.body };
  };
  return { hub, ctx, machineId: pending.machineId, call, cli };
}
beforeEach(() => { vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"); vi.stubEnv("AGEND_WINDOWS_CLI", "1"); });
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const path of homes.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe test cleanup"); rmSync(path, { recursive: true, force: true }); }
});
const SHOWS = /maskedEmail|"identity"|\*\*\*@/;

describe("/ui/runtimes shows the account to a local administrator session only", () => {
  const routes = (id: string) => ["/ui/runtimes", `/ui/runtimes/machines/${id}`, `/ui/runtimes/machines/${id}/inventory`];
  it("a local administrator session gets it, on the list, the machine and its inventory", async () => {
    const f = await fixture();
    for (const path of routes(f.machineId)) { const answer = await f.call("admin", path); expect(answer.status, path).toBe(200); expect(answer.body, path).toMatch(/al\*\*\*@example\.com/); expect(answer.body, path).toMatch(/bo\*\*\*@example\.org/); }
  });
  it("the agent's header token still gets the routes, with names and signed-in state and without the account", async () => {
    const f = await fixture();
    for (const path of routes(f.machineId)) {
      const answer = await f.call("header-token", path); expect(answer.status, path).toBe(200); expect(answer.body, path).not.toMatch(SHOWS);
      expect(answer.body, path).toMatch(/"claude-code"/);
    }
    const list = JSON.parse((await f.call("header-token", "/ui/runtimes")).body).machines[0];
    expect(list.inventory.credentialProfiles.profiles).toEqual([{ name: "work", loggedIn: true }, { name: "out", loggedIn: false }]);
    expect(list.inventory.clis[0].authenticated).toBe(true); expect(list.inventory.clis[0]).not.toHaveProperty("identity");
    expect(list.inventory.credentialProfiles.default).toBe("work");
  });
  it("a read session, a guest session and a bound gateway request get nothing of it (and are refused as before)", async () => {
    const f = await fixture();
    for (const who of ["read", "guest", "gateway"] as const) for (const path of routes(f.machineId)) {
      const answer = await f.call(who, path); expect(answer.status, `${who} ${path}`).toBe(403); expect(answer.body, `${who} ${path}`).not.toMatch(SHOWS);
    }
  });
  it("the mutations' answers carry it the same way: rename and refresh for the administrator, none of it for the header token", async () => {
    const f = await fixture();
    f.hub.call = vi.fn(async () => probe()) as never;
    const adminRename = await f.call("admin", `/ui/runtimes/machines/${f.machineId}/rename`, "POST", { name: "Desk 2" }); expect(adminRename.status).toBe(200); expect(adminRename.body).toMatch(/al\*\*\*@example\.com/);
    const tokenRename = await f.call("header-token", `/ui/runtimes/machines/${f.machineId}/rename`, "POST", { name: "Desk 3" }); expect(tokenRename.status).toBe(200); expect(tokenRename.body).not.toMatch(SHOWS);
    const adminRefresh = await f.call("admin", `/ui/runtimes/machines/${f.machineId}/refresh`, "POST"); expect(adminRefresh.status).toBe(200); expect(adminRefresh.body).toMatch(/al\*\*\*@example\.com/);
    const tokenRefresh = await f.call("header-token", `/ui/runtimes/machines/${f.machineId}/refresh`, "POST"); expect(tokenRefresh.status).toBe(200); expect(tokenRefresh.body).not.toMatch(SHOWS);
    expect(JSON.parse(tokenRefresh.body).inventory.clis[0].authenticated).toBe(true);
  });
  it("what AgEnD stores is untouched by a redacted answer: the administrator still sees it afterwards", async () => {
    const f = await fixture(); await f.call("header-token", "/ui/runtimes");
    expect((await f.call("admin", "/ui/runtimes")).body).toMatch(/al\*\*\*@example\.com/);
  });
});

describe("/ui/windows-cli/probe (this PC's own Windows CLIs)", () => {
  const bridge = () => ({ probe: vi.fn(async () => probe()) }) as unknown as WindowsCliBridge;
  it("shows the account to a local administrator session, and to no one else", async () => {
    const f = await fixture();
    expect((await f.cli("admin", bridge())).body).toMatch(/al\*\*\*@example\.com/);
    const token = await f.cli("header-token", bridge()); expect(token.status).toBe(200); expect(token.body).not.toMatch(SHOWS); expect(JSON.parse(token.body).clis[0].id).toBe("claude-code");
    for (const who of ["read", "guest", "gateway"] as const) { const answer = await f.cli(who, bridge()); expect(answer.status, who).toBe(403); expect(answer.body, who).not.toMatch(SHOWS); }
  });
  it("the redaction keeps everything else and does not touch its input", () => {
    const original = probe(), copy = probeWithoutAccountIdentity(original);
    expect(copy.clis[0]).toMatchObject({ id: "claude-code", authenticated: true, version: "2.1.316" }); expect(copy.clis[0]).not.toHaveProperty("identity");
    expect(copy.credentialProfiles?.profiles).toEqual([{ name: "work", loggedIn: true }, { name: "out", loggedIn: false }]);
    expect((original.clis[0] as { identity?: unknown }).identity).toEqual(identity);
  });
});
