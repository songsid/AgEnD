/** What AgEnD keeps of a Runtime's inventory: only the fields it knows, with length limits, so nothing else is stored or served back by /ui/runtimes. */
import { IncomingMessage, ServerResponse, createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { handleRuntimeRequest } from "../src/runtime-api.js";

const token = "t".repeat(48), homes: string[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [], sockets: WebSocket[] = [];
const row = (over: Record<string, unknown> = {}) => ({ id: "claude-code", path: "C:\\claude.exe", version: "2.1.316", authenticated: true, runnable: true, readOnlySupport: true, permissionNote: "note",
  supports: { execution: true, resume: true, model: true, mcp: true }, models: [{ id: "m1", name: "Model 1", description: "d" }], ...over });
const inventory = (over: Record<string, unknown> = {}) => ({ home: "C:\\U", probedAt: 5, hostname: "DESK", clis: [row()], ...over });
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "agend-inventory-allowlist-")); homes.push(home);
  const hub = new RuntimeCoordinator(home); hubs.push(hub);
  const pairing = hub.createPairing(), pending = hub.pair({ code: pairing.code, name: "Desk", platform: "win32" });
  hub.approve(pending.machineId, hub.machine(pending.machineId)?.pairingFingerprint);
  const claim = hub.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret }); if (claim.status !== "approved") throw Error("pairing fixture failed");
  const server = createServer((req, res) => { if (!hub.handlePublicRequest(req, res, new URL(req.url ?? "/", "http://localhost"))) { res.writeHead(404); res.end(); } });
  servers.push(server); server.on("upgrade", (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = (server.address() as { port: number }).port;
  const send = async (inv: unknown): Promise<{ code: number; reason: string }> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/runtime/v1/connect`, { headers: { Authorization: `Bearer ${claim.credential}` } }); sockets.push(ws);
    await once(ws, "open"); const closed = once(ws, "close"), welcome = once(ws, "message");
    ws.send(JSON.stringify({ v: 1, type: "hello", bootId: `b-${Math.random()}`, inventory: inv }));
    const first = await Promise.race([closed.then(([code, reason]) => ({ code: code as number, reason: String(reason) })), welcome.then(() => ({ code: 0, reason: "" }))]);
    ws.terminate(); await vi.waitFor(() => expect(hub.machine(pending.machineId)?.status).not.toBe("online")).catch(() => {}); return first;
  };
  const listed = (): string => {
    const req = Readable.from(["{}"]) as unknown as IncomingMessage; req.method = "GET"; req.url = "/ui/runtimes"; req.headers = { host: "localhost", "x-agend-token": token };
    Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" }, configurable: true });
    class Res extends ServerResponse { body = ""; override writeHead(): this { return this; } override end(chunk?: unknown): this { this.body += String(chunk ?? ""); return this; } }
    const res = new Res(req); handleRuntimeRequest(req, res, new URL("/ui/runtimes", "http://localhost"), { webToken: token, runtimeCoordinator: () => hub }); return res.body;
  };
  return { hub, machineId: pending.machineId, send, listed, home };
}
beforeEach(() => vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"));
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const path of homes.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe test cleanup"); rmSync(path, { recursive: true, force: true }); }
});
const SECRET = "SMUGGLED-FIXTURE-TEXT";

describe("an inventory is copied from an allowlist", () => {
  it("keeps the known fields exactly as sent", async () => {
    const f = await fixture(); expect((await f.send(inventory())).code).toBe(0);
    expect(f.hub.machine(f.machineId)?.inventory).toEqual({ home: "C:\\U", probedAt: 5, hostname: "DESK", clis: [row()] });
  });
  it("drops a field AgEnD does not know, at the top, on a CLI row, on supports and on a model: it is neither stored nor served by /ui/runtimes", async () => {
    const f = await fixture();
    const sent = inventory({ extra: SECRET, env: { PATH: SECRET }, clis: [row({ smuggled: SECRET, nested: { a: SECRET }, supports: { execution: true, resume: true, model: true, mcp: true, shell: true, [SECRET]: true },
      models: [{ id: "m1", name: "Model 1", description: "d", hidden: SECRET }], modelsSource: SECRET, reason: "fine" })] });
    expect((await f.send(sent)).code).toBe(0);
    const stored = f.hub.machine(f.machineId)!.inventory!;
    expect(JSON.stringify(stored)).not.toContain(SECRET); expect(f.listed()).not.toContain(SECRET);
    expect(readFileSync(join(f.home, "runtime-machines.json"), "utf8")).not.toContain(SECRET);
    expect(stored.clis[0].supports).toEqual({ execution: true, resume: true, model: true, mcp: true }); expect(stored.clis[0].models).toEqual([{ id: "m1", name: "Model 1", description: "d" }]);
    expect(stored.clis[0].reason).toBe("fine"); expect(stored.clis[0]).not.toHaveProperty("modelsSource");
  });
  it("keeps the documented optional fields: a model source from the list, a reason, a mask-only identity", async () => {
    const f = await fixture();
    expect((await f.send(inventory({ clis: [row({ modelsSource: "official-catalog", reason: "why", identity: { maskedEmail: "ab***@example.com", plan: "team" } })] }))).code).toBe(0);
    expect(f.hub.machine(f.machineId)?.inventory?.clis[0]).toMatchObject({ modelsSource: "official-catalog", reason: "why", identity: { maskedEmail: "ab***@example.com", plan: "team" } });
  });
  it.each([
    ["home", { home: "x".repeat(1025) }], ["a path", { clis: [row({ path: "x".repeat(2049) })] }], ["a version", { clis: [row({ version: "x".repeat(257) })] }],
    ["a permission note", { clis: [row({ permissionNote: "x".repeat(2049) })] }], ["a reason", { clis: [row({ reason: "x".repeat(1025) })] }],
    ["a model name", { clis: [row({ models: [{ id: "m", name: "x".repeat(257) }] })] }], ["a model description", { clis: [row({ models: [{ id: "m", description: "x".repeat(2049) }] })] }],
    ["a non-text reason", { clis: [row({ reason: { a: 1 } })] }], ["a non-numeric probedAt", { probedAt: "yesterday" }],
  ])("refuses an over-long or mistyped %s", async (_what, over) => {
    const f = await fixture(); const result = await f.send(inventory(over)); expect(result.code).toBe(1008);
    expect(f.hub.machine(f.machineId)?.inventory).toBeUndefined();
  });
  it("still accepts a legacy report with no probedAt and no hostname", async () => {
    const f = await fixture(); expect((await f.send({ home: "C:\\U", clis: [] })).code).toBe(0);
    expect(f.hub.machine(f.machineId)?.inventory).toEqual({ home: "C:\\U", clis: [] });
  });
  it("a hostname that is empty, over-long or has control characters is not kept", async () => {
    const f = await fixture();
    for (const hostname of ["", "x".repeat(256), "DE\nSK"]) { expect((await f.send(inventory({ hostname }))).code).toBe(0); expect(f.hub.machine(f.machineId)?.inventory).not.toHaveProperty("hostname"); }
  });
});
