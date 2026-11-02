/** Real outbound WebSocket transport; process boundaries are inert, private fixtures. */
import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeClient } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { RuntimePaneHost, type RuntimePaneProcess } from "../src/runtime-pane-host.js";
import type { RuntimePaneSnapshot } from "../src/runtime-pane-protocol.js";

const roots: string[] = [], clients: RuntimeClient[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "agend-pane-transport-")); roots.push(path); return path; }
function fakeProcess() {
  let data: (value: string) => void = () => {}, exit: (value: { exitCode: number }) => void = () => {};
  return { pid: 12345, write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    kill: vi.fn(() => exit({ exitCode: 0 })), onData: (fn: typeof data) => { data = fn; return { dispose() {} }; },
    onExit: (fn: typeof exit) => { exit = fn; return { dispose() {} }; }, emit: (value: string) => data(value) };
}
async function fixture() {
  const home = directory(), store = new RuntimeClientStore(directory());
  let hub = new RuntimeCoordinator(home, { requestTimeoutMs: 250 }); hubs.push(hub);
  const pairing = hub.createPairing(), pending = hub.pair({ code: pairing.code, name: "Pane fixture", platform: "win32" });
  hub.approve(pending.machineId, hub.machine(pending.machineId)!.pairingFingerprint);
  const claim = hub.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret });
  if (claim.status !== "approved") throw Error("Fixture pairing failed");
  const server = createServer(); servers.push(server);
  server.on("upgrade", (request, socket, head) => { if (!hub.handleUpgrade(request, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture port");
  store.saveCredentials({ server: `http://127.0.0.1:${address.port}`, name: "Pane fixture", machineId: claim.machineId, credential: claim.credential });
  const processes: ReturnType<typeof fakeProcess>[] = [];
  const client = new RuntimeClient({ store, reconnectMs: 10, pollMs: 10,
    bridge: { probe: async () => ({ home: "C:\\fixture", clis: [] }), prepareWorkspace: async () => { throw Error("unused"); },
      start: () => { throw Error("no exec launch"); }, get: () => null, cancel: () => { throw Error("unused"); }, close() {}, releaseUnknown() {} },
    createPaneHost: options => new RuntimePaneHost({ ...options, spawn: async () => { const process = fakeProcess(); processes.push(process); return process as RuntimePaneProcess; } }),
  }); clients.push(client); await client.start();
  await vi.waitFor(() => expect(client.online()).toBe(true));
  const launch = () => ({ paneId: randomUUID(), agentId: randomUUID(), instance: "pane-agent", cli: "codex" as const, cwd: "C:\\fixture", sandbox: "read-only" as const, columns: 80, rows: 24 });
  return { store, client, processes, machineId: claim.machineId, launch,
    hub: () => hub, restart: () => { hub.close(); hub = new RuntimeCoordinator(home, { requestTimeoutMs: 250 }); hubs.push(hub); }, home };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.stop();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("uses independent persistent panes and keeps high-frequency captures out of the exec journal", async () => {
  const f = await fixture();
  expect(f.hub().machine(f.machineId)?.paneProtocol).toBe(1);
  const first = await f.hub().callPane(f.machineId, { action: "open", operationId: randomUUID(), launch: f.launch() }, 2) as RuntimePaneSnapshot;
  const second = await f.hub().callPane(f.machineId, { action: "open", operationId: randomUUID(), launch: f.launch() }, 2) as RuntimePaneSnapshot;
  expect(second.launchId).not.toBe(first.launchId);
  expect(f.processes).toHaveLength(2);
  f.processes[0].emit("READY 第一個\r\n"); f.processes[1].emit("READY 第二個\r\n");
  for (let index = 0; index < 10; index++) {
    const result = await f.hub().callPane(f.machineId, { action: "capture", paneId: first.paneId, launchId: first.launchId }) as any;
    expect(result.text).toContain("READY 第一個");
    expect(result.text).not.toContain("第二個");
  }
  expect(JSON.parse(readFileSync(join(f.home, "runtime-machines.json"), "utf8")).commands).toHaveLength(0);
});
it("lost reply and coordinator reconnect never replay Enter or open a second process", async () => {
  const f = await fixture(), launch = f.launch(), operationId = randomUUID();
  const first = await f.hub().callPane(f.machineId, { action: "open", operationId, launch }) as RuntimePaneSnapshot;
  const key = { action: "key" as const, paneId: first.paneId, launchId: first.launchId, key: "Enter" as const, operationId: randomUUID(), sequence: 1 };
  const send = (f.client as any).send.bind(f.client);
  let dropped = false;
  const spy = vi.spyOn(f.client as any, "send").mockImplementation((value: any) => {
    if (value.type === "pane.response" && !dropped) { dropped = true; return; }
    send(value);
  });
  await expect(f.hub().callPane(f.machineId, key)).rejects.toThrow("timed out");
  spy.mockRestore();
  expect(f.processes[0].write).toHaveBeenCalledExactlyOnceWith("\r");
  f.restart();
  await vi.waitFor(() => expect(f.hub().machine(f.machineId)?.status).toBe("online"));
  await f.hub().callPane(f.machineId, key);
  const resumed = await f.hub().callPane(f.machineId, { action: "open", operationId, launch }) as RuntimePaneSnapshot;
  expect(resumed.launchId).toBe(first.launchId);
  expect(resumed.commandSequence).toBe(1);
  expect(f.processes).toHaveLength(1);
  expect(f.processes[0].write).toHaveBeenCalledOnce();
});
