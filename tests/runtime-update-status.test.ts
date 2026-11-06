/** Negotiated diagnostics on real authenticated loopback WebSockets; inert execution only. */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { RuntimeClient, type RuntimeBridge, type RuntimeClientOptions } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { parseRuntimeUpdateStatus, parseRuntimeUpdateReport, RUNTIME_UPDATE_STATUS_CAPABILITY } from "../src/runtime-update-status.js";
const roots: string[] = [], hubs: RuntimeCoordinator[] = [], clients: RuntimeClient[] = [], servers: Server[] = [], sockets: WebSocketServer[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "agend-update-status-")); roots.push(path); return path; }
const target = { version: "2.3.5-alpha.12", bundleSha256: "a".repeat(64) };
async function fixture(extra: Partial<RuntimeClientOptions> = {}, now = () => Date.now()) {
  const home = directory(), hub = new RuntimeCoordinator(home, { now }); hubs.push(hub);
  const pairing = hub.createPairing(), pending = hub.pair({ code: pairing.code, name: "Fake desktop", platform: "win32" });
  hub.approve(pending.machineId, hub.machine(pending.machineId)!.pairingFingerprint);
  const identity = hub.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret });
  if (identity.status !== "approved") throw Error("Fixture approval failed");
  const server = createServer(); servers.push(server);
  server.on("upgrade", (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const store = new RuntimeClientStore(directory());
  store.saveCredentials({ server: `http://127.0.0.1:${(server.address() as { port: number }).port}`, machineId: identity.machineId, credential: identity.credential, name: "Fake desktop" });
  const bridge: RuntimeBridge = { probe: vi.fn(async () => ({ home: "C:\\fixture", clis: [], probedAt: 1 })), prepareWorkspace: vi.fn(async () => "C:\\fixture"),
    start: () => { throw Error("No native fixture run"); }, get: () => null, cancel: vi.fn(), close: vi.fn(), releaseUnknown: vi.fn(), idleForUpdate: () => true };
  const client = new RuntimeClient({ store, bridge, updateStatus: { state: "unknown" }, reconnectMs: 60_000, ...extra }); clients.push(client);
  await client.start(); await vi.waitFor(() => expect((client as any).welcomed).toBe(true));
  return { hub, client, home, store, bridge, machineId: identity.machineId };
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const hub of hubs.splice(0)) hub.close();
  for (const ws of sockets.splice(0)) await new Promise<void>(done => ws.close(() => done()));
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
it.each([
  { state: "failed", target: { ...target, bundleSha256: "b" } }, { state: "pending", target: { ...target, version: "../other" } },
  { state: "current", command: "anything" }, { state: "manual", reason: "exception text" }, { state: "failed", target: { ...target, path: "C:\\private" } },
  { state: "manual", reason: "shared", origin: "https://other.example.test" }, { state: { toString: () => "current" } },
])("refuses fields outside the diagnostic schema: %j", value => { expect(() => parseRuntimeUpdateStatus(value)).toThrow(); });
it("copies validated reports independently and refuses invalid persisted bindings", () => {
  const input = { bootId: randomUUID(), generation: 2, reportedAt: 5, status: { state: "failed", target: { ...target } } };
  const parsed = parseRuntimeUpdateReport(input); input.status.target.version = "changed";
  expect(parsed.status).toEqual({ state: "failed", target });
  for (const change of [{ bootId: "other" }, { generation: 0 }, { reportedAt: -1 }, { path: "C:\\private" }])
    expect(() => parseRuntimeUpdateReport({ ...input, ...change })).toThrow();
});
it("negotiates reports, records the exact boot/generation, and returns independent machine views", async () => {
  const f = await fixture();
  f.client.setUpdateStatus({ state: "pending", target });
  await vi.waitFor(() => expect(f.hub.machine(f.machineId)?.updateReport?.status).toEqual({ state: "pending", target }));
  const machine = f.hub.machine(f.machineId)!;
  expect(machine.runtimeInfo?.capabilities).toContain(RUNTIME_UPDATE_STATUS_CAPABILITY);
  expect(machine.updateReport).toMatchObject({ bootId: machine.bootId, generation: machine.generation });
  (machine.updateReport!.status as any).target.version = "changed externally";
  expect(f.hub.machine(f.machineId)?.updateReport?.status).toEqual({ state: "pending", target });
  f.client.setUpdateStatus({ state: "failed", target });
  await vi.waitFor(() => expect(f.hub.machine(f.machineId)?.updateReport?.status.state).toBe("failed"));
  await f.client.stop(); f.hub.close();
  const restored = new RuntimeCoordinator(f.home); hubs.push(restored);
  expect(restored.machine(f.machineId)).toMatchObject({ status: "offline", updateReport: { status: { state: "failed", target } } });
});
it.each(["boot", "generation", "extra"] as const)("refuses a report with an invalid %s without changing the last report", async field => {
  const f = await fixture(); await vi.waitFor(() => expect(f.hub.machine(f.machineId)?.updateReport?.status.state).toBe("unknown"));
  const machine = f.hub.machine(f.machineId)!, socket = (f.client as any).socket as WebSocket, closed = once(socket, "close");
  let off = () => {}; const changed = new Promise<string>(done => { off = f.hub.subscribe(event => { if (event.type === "machine" && f.hub.machine(f.machineId)?.updateReport?.status.state === "failed") done("accepted"); }); });
  socket.send(JSON.stringify({ v: 1, type: "update.status", bootId: field === "boot" ? randomUUID() : machine.bootId,
    generation: machine.generation + (field === "generation" ? 1 : 0), status: { state: "failed", target }, ...(field === "extra" ? { command: "no" } : {}) }));
  try { expect(await Promise.race([closed.then(() => "closed"), changed])).toBe("closed"); } finally { off(); }
  expect(f.hub.machine(f.machineId)?.updateReport?.status).toEqual({ state: "unknown" });
});
it("a trial sends no diagnostic before activation and cannot turn a status into admission", async () => {
  const id = randomUUID(), f = await fixture({ managedUpdate: { trialId: id }, updateStatus: { state: "pending", target } });
  f.client.setUpdateStatus({ state: "failed", target });
  await new Promise<void>(done => setImmediate(done));
  expect(f.hub.machine(f.machineId)?.updateReport).toBeUndefined(); expect(f.client.online()).toBe(false);
  expect(f.bridge.probe).not.toHaveBeenCalled();
  expect(await f.client.activateTrial(id)).toBe(true);
  f.client.setUpdateStatus({ state: "current" });
  await vi.waitFor(() => expect(f.hub.machine(f.machineId)?.updateReport?.status).toEqual({ state: "current" }));
});
it("a trial that bypasses the local diagnostic fence is refused by the coordinator", async () => {
  const f = await fixture({ managedUpdate: { trialId: randomUUID() } }), socket = (f.client as any).socket as WebSocket;
  const closed = once(socket, "close"); let off = () => {};
  const changed = new Promise<string>(done => { off = f.hub.subscribe(event => { if (event.type === "machine" && f.hub.machine(f.machineId)?.updateReport) done("accepted"); }); });
  socket.send(JSON.stringify({ v: 1, type: "update.status", bootId: f.client.bootId, generation: (f.client as any).generation, status: { state: "current" } }));
  try { expect(await Promise.race([closed.then(() => "closed"), changed])).toBe("closed"); } finally { off(); }
  expect(f.hub.machine(f.machineId)?.status).toBe("offline"); expect(f.hub.machine(f.machineId)?.updateReport).toBeUndefined();
  expect(f.bridge.probe).not.toHaveBeenCalled();
});
it("bounds changed-report writes without stopping ordinary operations", async () => {
  let now = 1_000; const f = await fixture({}, () => now), changed = vi.fn(), off = f.hub.subscribe(changed);
  try {
    for (let n = 0; n < 20; n++) f.client.setUpdateStatus({ state: "pending", target: { ...target, bundleSha256: n.toString(16).padStart(64, "0") } });
    await f.hub.call(f.machineId, "workspace", { agentId: randomUUID() });
    expect(changed.mock.calls.filter(([event]) => event.type === "machine").length).toBeLessThanOrEqual(8);
    expect(f.hub.machine(f.machineId)?.updateReport?.status).not.toEqual({ state: "pending", target: { ...target, bundleSha256: (19).toString(16).padStart(64, "0") } });
    now += 5000; f.client.setUpdateStatus({ state: "failed", target });
    await vi.waitFor(() => expect(f.hub.machine(f.machineId)?.updateReport?.status).toEqual({ state: "failed", target }));
    expect(f.client.online()).toBe(true);
  } finally { off(); }
});
it("a damaged cached diagnostic cannot disable an otherwise valid paired Runtime", async () => {
  const f = await fixture(); await f.client.stop(); f.hub.close();
  const path = join(f.home, "runtime-machines.json"), state = JSON.parse(readFileSync(path, "utf8"));
  state.machines[0].machine.updateReport = { bad: "cached diagnostic" }; writeFileSync(path, JSON.stringify(state));
  const restored = new RuntimeCoordinator(f.home); hubs.push(restored);
  expect(restored.machine(f.machineId)?.updateReport).toBeUndefined(); expect(restored.machine(f.machineId)?.status).toBe("offline");
});
it("does not send the new diagnostic to an older peer without a positive welcome capability", async () => {
  const server = createServer(); servers.push(server); const ws = new WebSocketServer({ server }); sockets.push(ws);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const store = new RuntimeClientStore(directory()), machineId = randomUUID(), frames: any[] = [];
  store.saveCredentials({ server: `http://127.0.0.1:${(server.address() as { port: number }).port}`, machineId, credential: "a".repeat(64), name: "Legacy peer fixture" });
  ws.on("connection", socket => socket.on("message", bytes => {
    const frame = JSON.parse(String(bytes)); frames.push(frame);
    if (frame.type === "hello") socket.send(JSON.stringify({ v: 1, type: "welcome", machineId, generation: 1 }));
  }));
  const client = new RuntimeClient({ store, updateStatus: { state: "failed", target } }); clients.push(client);
  await client.start(); await vi.waitFor(() => expect(client.online()).toBe(true));
  client.setUpdateStatus({ state: "pending", target }); await new Promise<void>(done => setImmediate(done));
  expect(frames[0].runtimeInfo.capabilities).toContain(RUNTIME_UPDATE_STATUS_CAPABILITY);
  expect(frames.map(frame => frame.type)).not.toContain("update.status");
});

it("a replacement connection cannot inherit a previous boot's current report", async () => {
  const f = await fixture(); f.client.setUpdateStatus({ state: "current" });
  await vi.waitFor(() => expect(f.hub.machine(f.machineId)?.updateReport?.status.state).toBe("current"));
  const oldBoot = f.hub.machine(f.machineId)!.bootId; await f.client.stop();
  const replacement = new RuntimeClient({ store: f.store, bridge: f.bridge, reconnectMs: 60_000 }); clients.push(replacement);
  await replacement.start(); await vi.waitFor(() => expect(replacement.online()).toBe(true));
  expect(f.hub.machine(f.machineId)?.bootId).not.toBe(oldBoot);
  expect(f.hub.machine(f.machineId)?.updateReport).toBeUndefined();
});

it("a same-client reconnect invalidates cached current until a new positive check", async () => {
  const f = await fixture({ reconnectMs: 1 }); f.client.setUpdateStatus({ state: "current" });
  await vi.waitFor(() => expect(f.hub.machine(f.machineId)?.updateReport?.status.state).toBe("current"));
  const generation = (f.client as any).generation; ((f.client as any).socket as WebSocket).terminate();
  await vi.waitFor(() => expect((f.client as any).generation).toBeGreaterThan(generation));
  await f.hub.call(f.machineId, "workspace", { agentId: randomUUID() });
  expect(f.hub.machine(f.machineId)?.updateReport?.status).toEqual({ state: "unknown" });
  f.client.setUpdateStatus({ state: "current" });
  await vi.waitFor(() => expect(f.hub.machine(f.machineId)?.updateReport?.status).toEqual({ state: "current" }));
});
