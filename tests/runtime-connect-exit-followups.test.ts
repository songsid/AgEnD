import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient, describeRuntimeStop, pairRuntime, type RuntimeBridge } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { RUNTIME_REINSTALL_CLOSE_REASON } from "../src/runtime-protocol.js";
import type { WindowsCliProbe } from "../src/windows-cli.js";

const directories: string[] = [], clients: RuntimeClient[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [];
const OTHER = "11111111-2222-3333-4444-555555555555";
function home(): string { const path = mkdtempSync(join(tmpdir(), "agend-runtime-followup-")); directories.push(path); return path; }
/** Idle bridge: these tests never run a CLI. */
function bridge(): RuntimeBridge {
  const probe: WindowsCliProbe = { home: "C:\\Users\\fixture", clis: [], probedAt: 1 };
  return { probe: async () => probe, prepareWorkspace: async (id: string) => `C:\\w\\${id}`, start: () => { throw Error("unused"); }, get: () => null, cancel: () => { throw Error("unused"); }, close() {}, releaseUnknown() {} } as unknown as RuntimeBridge;
}
async function listen(server: Server): Promise<string> {
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture port");
  return `http://127.0.0.1:${address.port}`;
}
async function fixture(options: ConstructorParameters<typeof RuntimeCoordinator>[1] = {}, report?: (text: string) => void, runtimeInfo?: unknown) {
  const hub = new RuntimeCoordinator(home(), options); hubs.push(hub);
  const pairing = hub.createPairing(), pending = hub.pair({ code: pairing.code, name: "Fixture Windows", platform: "win32" });
  hub.approve(pending.machineId, hub.machine(pending.machineId)?.pairingFingerprint);
  const claim = hub.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret }); if (claim.status !== "approved") throw Error("Pairing fixture failed");
  const base = await listen(createServer((req, res) => { if (!hub.handlePublicRequest(req, res, new URL(req.url ?? "/", "http://localhost"))) { res.writeHead(404); res.end(); } }).on("upgrade", (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); }));
  const store = new RuntimeClientStore(home());
  store.saveCredentials({ server: base, machineId: claim.machineId, credential: claim.credential, name: "Fixture Windows" });
  const client = new RuntimeClient({ store, bridge: bridge(), reconnectMs: 25, pollMs: 10, ...(report ? { report } : {}) }); clients.push(client);
  // An older or newer program than this AgEnD: what it reports in its hello (private, so only a test reaches it).
  if (runtimeInfo !== undefined) (client as unknown as { runtimeInfo: unknown }).runtimeInfo = runtimeInfo;
  await client.start();
  if (runtimeInfo === undefined) await vi.waitFor(() => expect(client.online()).toBe(true));
  const socket = () => (hub as unknown as { connections: Map<string, { ws: import("ws").WebSocket }> }).connections.get(claim.machineId)!.ws;
  return { hub, base, store, client, socket, machineId: claim.machineId, credential: claim.credential };
}
const unsettledJob = (store: RuntimeClientStore) => store.accept({ id: randomUUID(), cli: "codex", cwd: "C:\\w", sandbox: "read-only", status: "starting", startedAt: 1, output: "" }, "a".repeat(64));
async function pairingServer(onClaim: (count: number) => void) {
  const machineId = randomUUID(); let claims = 0, pairs = 0;
  const url = await listen(createServer((req, res) => {
    req.resume(); res.setHeader("Content-Type", "application/json");
    if (req.url?.endsWith("/pair")) { pairs++; res.writeHead(201); res.end(JSON.stringify({ machineId, claimSecret: "c".repeat(64), status: "pending", expiresAt: Date.now() + 10_000 })); return; }
    onClaim(++claims);
    if (claims === 1) { res.writeHead(202); res.end(JSON.stringify({ status: "pending" })); } else { res.writeHead(200); res.end(JSON.stringify({ machineId, status: "approved", credential: "d".repeat(64) })); }
  }));
  return { url, machineId, pairs: () => pairs };
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); }
});

describe("a failed pairing never eats the one-time credential", () => {
  it("checks the job ledger before spending the pairing code", async () => {
    const store = new RuntimeClientStore(home()); store.adoptMachine(OTHER); unsettledJob(store);
    const server = await pairingServer(() => {});
    await expect(pairRuntime({ server: server.url, code: "interactive-code", name: "Fixture", store, pollMs: 1 })).rejects.toThrow(/different AgEnD pairing.*pairing code is still unused/);
    expect(server.pairs()).toBe(0); expect(store.credentials()).toBeNull();
  });
  it("keeps the credential when the ledger becomes unusable after approval, and says no new code is needed", async () => {
    const store = new RuntimeClientStore(home()); store.adoptMachine(OTHER);
    const server = await pairingServer(count => { if (count === 1) unsettledJob(store); });
    await expect(pairRuntime({ server: server.url, code: "interactive-code", name: "Fixture", store, pollMs: 1 })).rejects.toThrow(/paired and its credential is saved.*No new pairing code is needed/);
    expect(store.credentials()).toMatchObject({ machineId: server.machineId, credential: "d".repeat(64) });
  });
  it("start() refuses another pairing's unsettled ledger and releases the profile lock each time", async () => {
    const f = await fixture(); await f.client.stop();
    const store = new RuntimeClientStore(home());
    store.saveCredentials({ server: f.base, machineId: f.machineId, credential: f.credential, name: "Owned" });
    store.adoptMachine(OTHER); unsettledJob(store);
    for (let attempt = 0; attempt < 2; attempt++) {
      const again = new RuntimeClient({ store, bridge: bridge(), reconnectMs: 25, pollMs: 10 }); clients.push(again);
      await expect(again.start()).rejects.toThrow(/different AgEnD pairing.*No new pairing code is needed/);
      expect(store.lockHolder()).toBeUndefined();
    }
  });
});

describe("what AgEnD tells a Runtime when it closes the connection", () => {
  it("never sends a path or internal error when AgEnD cannot save, but logs the full cause", async () => {
    const warn = vi.fn(), f = await fixture({ warn });
    // Only the save made while handling the runtime's message fails; the later save on disconnect is the real one.
    const hub = f.hub as unknown as { save: () => void }, real = (RuntimeCoordinator.prototype as unknown as { save: () => void }).save; let failed = false;
    hub.save = () => { if (!failed) { failed = true; throw new Error("EACCES: permission denied, open '/data/runtime-machines.json'"); } real.call(hub); };
    await f.client.operation("probe", { force: true }).catch(() => {}); await f.client.waitUntilStopped();
    expect(f.client.stopReason).toEqual({ kind: "rejected", detail: "Invalid runtime message" });
    expect(JSON.stringify(f.client.stopReason)).not.toMatch(/data|EACCES|\//);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "Invalid runtime message", detail: expect.stringContaining("/data/runtime-machines.json") }), expect.any(String));
  });
  it("forwards a deliberate validation message so the terminal can name it", async () => {
    const warn = vi.fn(), f = await fixture({ warn });
    f.socket().emit("message", Buffer.from(JSON.stringify({ v: 1, type: "task", seq: 1, task: { id: randomUUID() } })), false);
    await f.client.waitUntilStopped();
    expect(f.client.stopReason).toMatchObject({ kind: "rejected", detail: "Invalid runtime message: Runtime task does not belong to this machine" });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ code: 1008 }), expect.any(String));
  });
  it("prints a close reason sanitised: ASCII only, at most 120 characters", async () => {
    const report = vi.fn(), f = await fixture({}, report);
    f.socket().close(1008, "Invalid runtime message: \u00e9\u00e9 " + "x".repeat(93));
    await f.client.waitUntilStopped();
    const line = String(report.mock.calls.find(call => String(call[0]).includes("code 1008"))![0]);
    expect(line).toMatch(/^AgEnD closed the connection \(code 1008: Invalid runtime message: \?+ x+\)\.$/);
    expect(f.client.stopReason!.detail!.length).toBeLessThanOrEqual(120); expect(f.client.stopReason!.detail).not.toMatch(/[^\x20-\x7e]/);
  });
});

describe("version skew: a Runtime installed earlier meets a newer AgEnD", () => {
  it("is refused, stops with a plain 'run the install command again', and keeps its pairing", async () => {
    const report = vi.fn(), f = await fixture({}, report, { version: "1.0.0", protocolVersions: [2], capabilities: ["exec"] });
    await f.client.waitUntilStopped();
    expect(f.client.stopReason).toEqual({ kind: "reinstall", detail: RUNTIME_REINSTALL_CLOSE_REASON });
    expect(report).toHaveBeenCalledWith(expect.stringContaining("re-run the install command"));
    const message = describeRuntimeStop(f.client.stopReason!);
    expect(message).toMatch(/not compatible with this AgEnD/); expect(message).toMatch(/Re-run the install command shown in AgEnD Settings -> Runtime -> Connect a computer/);
    expect(message).toMatch(/next to this one and never deletes the version that is running/); expect(message).toMatch(/agend-runtime run/); expect(message).toMatch(/ZIP/);
    expect(message).toMatch(/pairing is kept/i); expect(message).not.toMatch(/pairing code|disconnect/);   // not told to pair again
    expect(f.hub.machine(f.machineId)).toMatchObject({ status: "offline", runtimeCompatibility: "incompatible" });
    expect(f.store.credentials()).not.toBeNull();
  });
  it("reconnects on the same pairing, with no new code, once the matching Runtime is installed", async () => {
    const f = await fixture({}, undefined, { version: "1.0.0", protocolVersions: [2], capabilities: ["exec"] });
    await f.client.waitUntilStopped();
    const matching = new RuntimeClient({ store: f.store, bridge: bridge(), reconnectMs: 25, pollMs: 10 }); clients.push(matching); await matching.start();
    await vi.waitFor(() => expect(matching.online()).toBe(true));
    expect(f.hub.machine(f.machineId)).toMatchObject({ status: "online", runtimeCompatibility: "compatible" });
  });
  it("does not blame the version for a plain close that has another reason", async () => {
    const f = await fixture();
    f.socket().close(1008, "Something else entirely");
    await f.client.waitUntilStopped();
    expect(f.client.stopReason).toEqual({ kind: "rejected", detail: "Something else entirely" });
  });
});

describe("only AgEnD-caused stops set a stop reason", () => {
  it("reconnects by itself after a dropped connection (1006) and records no stop reason", async () => {
    const f = await fixture(), before = f.hub.machine(f.machineId)!.generation; f.socket().terminate();
    await vi.waitFor(() => expect(f.hub.machine(f.machineId)!.generation).toBeGreaterThan(before));
    await vi.waitFor(() => expect(f.client.online()).toBe(true));
    expect(f.client.stopReason).toBeUndefined();
  });
  it("blames the Runtime, not AgEnD, when it cannot read AgEnD's frame", async () => {
    const report = vi.fn(), f = await fixture({}, report);
    f.socket().send("not json");
    await f.client.waitUntilStopped();
    expect(f.client.stopReason).toEqual({ kind: "incompatible" });
    expect(report).toHaveBeenCalledWith("This Runtime could not read a message from AgEnD and closed the connection.");
    expect(describeRuntimeStop(f.client.stopReason!)).toMatch(/different versions.*Download the Windows Runtime again/);
  });
  it("adds a proxy hint to an HTTP 403 refusal, and clears the previous stop reason when started again", async () => {
    const server = createServer().on("upgrade", (_req, socket) => { socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); });
    const url = await listen(server), store = new RuntimeClientStore(home());
    store.saveCredentials({ server: url, machineId: randomUUID(), credential: "e".repeat(64), name: "Proxy" });
    const client = new RuntimeClient({ store, bridge: bridge(), reconnectMs: 25, pollMs: 10 }); clients.push(client);
    await client.start(); await client.waitUntilStopped();
    expect(client.stopReason).toEqual({ kind: "refused", detail: "HTTP 403" });
    expect(describeRuntimeStop(client.stopReason!)).toMatch(/HTTP 403.*proxy/);
    expect(describeRuntimeStop({ kind: "refused" })).not.toMatch(/proxy/);
    await client.start(); expect(client.stopReason).toBeUndefined();
  });
});
