/** Both real authenticated websocket endpoints, private profiles and inert bridges; no native CLI. */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeClient, type RuntimeClientOptions, type RuntimeBridge } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import type { NativeMcpConnection } from "../src/windows-cli-providers.js";
import type { WindowsCliTask } from "../src/windows-cli.js";
const roots: string[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [], clients: RuntimeClient[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "agend-update-client-")); roots.push(path); return path; }
function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(extra: Partial<RuntimeClientOptions> = {}) {
  const hub = new RuntimeCoordinator(directory()); hubs.push(hub);
  const pairing = hub.createPairing(), pending = hub.pair({ code: pairing.code, name: "Fixture", platform: "win32" });
  hub.approve(pending.machineId, hub.machine(pending.machineId)!.pairingFingerprint);
  const identity = hub.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret });
  if (identity.status !== "approved") throw Error("Fixture approval failed");
  const server = createServer(); servers.push(server);
  server.on("upgrade", (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port, store = new RuntimeClientStore(directory());
  store.saveCredentials({ server: `http://127.0.0.1:${port}`, name: "Fixture", machineId: identity.machineId, credential: identity.credential });
  const bridge: RuntimeBridge = {
    probe: vi.fn(async () => ({ home: "C:\\fixture", clis: [], probedAt: 1 })), prepareWorkspace: vi.fn(async () => "C:\\fixture"),
    start: vi.fn(() => { throw Error("No fixture run"); }), get: () => null, cancel: vi.fn(() => { throw Error("No fixture run"); }), close: vi.fn(), releaseUnknown: vi.fn(), idleForUpdate: () => true,
  };
  const authenticated = held<void>();
  const client = new RuntimeClient({ store, bridge, reconnectMs: 10, pollMs: 10, ...extra,
    managedUpdate: { ...extra.managedUpdate, authenticated: value => { extra.managedUpdate?.authenticated?.(value); authenticated.resolve(); } },
  });
  clients.push(client); await client.start();
  await authenticated.promise;
  return { hub, client, bridge, store, machineId: identity.machineId };
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it("negotiates both idle fences, proves a never-created pane host absent and completes stop before returning", async () => {
  const f = await fixture();
  expect(await f.client.prepareUpdate(randomUUID())).toBe(true);
  expect(f.bridge.close).toHaveBeenCalledOnce(); expect(f.bridge.cancel).not.toHaveBeenCalled();
  expect(existsSync(join(f.store.directory, "runtime.lock"))).toBe(false);
  expect(existsSync(join(f.store.directory, "pane-host"))).toBe(false);
  await vi.waitFor(() => expect(f.hub.machine(f.machineId)?.status).toBe("offline"));
});
it("defers a held operation before its callback can create native work", async () => {
  const f = await fixture(), work = held<string>();
  vi.mocked(f.bridge.prepareWorkspace).mockReturnValue(work.promise);
  const operation = f.client.operation("workspace", { agentId: randomUUID() });
  expect(await f.client.prepareUpdate(randomUUID())).toBe(false);
  expect(f.bridge.close).not.toHaveBeenCalled(); expect(f.client.online()).toBe(true);
  work.resolve("C:\\fixture"); await operation;
  expect(await f.client.prepareUpdate(randomUUID())).toBe(true);
});
it("requires the bridge's positive physical-idle proof, including optional old bridge refusal", async () => {
  const f = await fixture();
  delete f.bridge.idleForUpdate; expect(await f.client.prepareUpdate(randomUUID())).toBe(false);
  f.bridge.idleForUpdate = () => false; expect(await f.client.prepareUpdate(randomUUID())).toBe(false);
  f.bridge.idleForUpdate = () => true; expect(await f.client.prepareUpdate(randomUUID())).toBe(true);
});
it("an unsuccessful host proof cancels the exact server fence and resumes without cancelling a task", async () => {
  const f = await fixture({ drainPaneHostForUpdate: async () => { throw Error("Busy fixture host"); } });
  expect(await f.client.prepareUpdate(randomUUID())).toBe(false);
  expect(f.bridge.cancel).not.toHaveBeenCalled(); expect(f.bridge.close).not.toHaveBeenCalled();
  expect(await f.hub.call(f.machineId, "workspace", { agentId: randomUUID() })).toEqual({ agentId: expect.any(String), cwd: "C:\\fixture" });
});
it("does not mistake an injected persistent link for an absent production host", async () => {
  const f = await fixture({ openPaneLink: async () => { throw Error("Not opened by this test"); } });
  expect(await f.client.prepareUpdate(randomUUID())).toBe(false);
  expect(f.client.online()).toBe(true); expect(f.bridge.close).not.toHaveBeenCalled();
});
it("connection loss during a held host proof never grants replacement or stops the old client", async () => {
  const proof = held<void>(), entered = held<void>();
  const f = await fixture({ drainPaneHostForUpdate: async () => { entered.resolve(); await proof.promise; } });
  const preparing = f.client.prepareUpdate(randomUUID()); await entered.promise;
  const disconnected = once((f.client as any).socket, "close");
  (f.hub as any).connections.get(f.machineId).ws.terminate(); await disconnected; proof.resolve();
  expect(await preparing).toBe(false); expect(f.bridge.close).not.toHaveBeenCalled();
  expect(existsSync(join(f.store.directory, "runtime.lock"))).toBe(true);
});
it("a trial publishes nothing or probes no CLI until activation and then accepts the next ordered work", async () => {
  const id = randomUUID(), f = await fixture({ managedUpdate: { trialId: id } });
  expect(f.client.online()).toBe(false); expect(f.bridge.probe).not.toHaveBeenCalled();
  expect(f.hub.machine(f.machineId)?.status).toBe("offline");
  await expect(f.client.operation("workspace", { agentId: randomUUID() })).rejects.toThrow(/holding/);
  expect(await f.client.activateTrial(randomUUID())).toBe(false);
  expect(await f.client.activateTrial(id)).toBe(true); expect(f.client.online()).toBe(true);
  expect(await f.hub.call(f.machineId, "workspace", { agentId: randomUUID() })).toMatchObject({ cwd: "C:\\fixture" });
  expect(f.bridge.probe).toHaveBeenCalled();
});
it("concurrent stop and waitUntilStopped share cleanup through profile unlock", async () => {
  const f = await fixture(), work = held<void>(), entered = held<void>();
  // The production stop waits for a potentially opening persistent link before releasing the profile.
  (f.client as any).paneOpening = work.promise.then(() => ({ stop: async () => {} }));
  vi.mocked(f.bridge.close).mockImplementation(() => { entered.resolve(); expect(f.client.stop()).toBe(stopping); });
  const stopping = f.client.stop(); await entered.promise;
  expect(f.client.stop()).toBe(stopping); expect(f.client.waitUntilStopped()).toBe(stopping);
  expect(existsSync(join(f.store.directory, "runtime.lock"))).toBe(true);
  work.resolve(); await stopping;
  expect(existsSync(join(f.store.directory, "runtime.lock"))).toBe(false);
});
it("a partial authenticated MCP body stays owned after its run has physically completed", async () => {
  const f = await fixture(); let task: WindowsCliTask | null = null, connection!: NativeMcpConnection;
  vi.mocked(f.bridge.start).mockImplementation((raw: any, _authorized, options) => {
    connection = options!.mcp!; task = { id: raw.requestId, cli: raw.cli, cwd: raw.cwd, sandbox: raw.sandbox, status: "running", output: "", startedAt: 1 }; return task;
  });
  f.bridge.get = () => task;
  const input = { requestId: randomUUID(), cli: "codex", cwd: "C:\\fixture", prompt: "Fixture", sandbox: "read-only" };
  await f.hub.call(f.machineId, "run", { task: input, mcp: { tools: ["task"] } });
  const response = held<number>(), req = request(connection.endpoint, { method: "POST", headers: { "X-Agend-Native-Token": connection.token } }, res => {
    res.resume(); res.on("end", () => response.resolve(res.statusCode!));
  }); req.on("error", () => response.resolve(0));
  req.write('{"op":"native-mcp",');
  // A direct barrier observes acceptance of the partial body, before the native task ends.
  await vi.waitFor(() => expect((f.client as any).activity.pending).toBe(1));
  task = { ...task!, status: "completed", finishedAt: 2, outcomeConfirmed: true };
  await vi.waitFor(() => expect(f.hub.hasActiveTask(f.machineId)).toBe(false));
  expect(await f.client.prepareUpdate(randomUUID())).toBe(false);
  req.end('"method":"tools/list","params":{}}'); expect(await response.promise).toBe(403);
  await vi.waitFor(() => expect((f.client as any).activity.pending).toBe(0));
  expect(await f.client.prepareUpdate(randomUUID())).toBe(true);
});
