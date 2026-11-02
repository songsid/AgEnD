/** Real outbound WebSocket transport; process boundaries are inert, private fixtures. */
import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeClient } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { RuntimePaneHost, type RuntimePaneProcess, type RuntimePaneHostOptions } from "../src/runtime-pane-host.js";
import type { RuntimePaneSnapshot } from "../src/runtime-pane-protocol.js";
import { NativePaneTranscriptReader } from "../src/runtime-pane-transcript.js";
import { PANE_TRANSCRIPT_EMPTY_ANCHOR, validatePaneTranscriptWireBatch } from "../src/runtime-pane-transcript-protocol.js";

const roots: string[] = [], clients: RuntimeClient[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "agend-pane-transport-")); roots.push(path); return path; }
function fakeProcess() {
  let data: (value: string) => void = () => {}, exit: (value: { exitCode: number }) => void = () => {};
  return { pid: 12345, write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    kill: vi.fn(() => exit({ exitCode: 0 })), onData: (fn: typeof data) => { data = fn; return { dispose() {} }; },
    onExit: (fn: typeof exit) => { exit = fn; return { dispose() {} }; }, emit: (value: string) => data(value) };
}
async function fixture(overrides: Partial<RuntimePaneHostOptions> = {}) {
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
    createPaneHost: options => new RuntimePaneHost({ ...options, transcript: (launch, id) => new NativePaneTranscriptReader(launch.cli, launch.cwd, id, { codex: join(home, "codex"), claude: join(home, "claude") }),
      spawn: async () => { const process = fakeProcess(); processes.push(process); return process as RuntimePaneProcess; }, ...overrides }),
  }); clients.push(client); await client.start();
  await vi.waitFor(() => expect(client.online()).toBe(true));
  const launch = () => ({ paneId: randomUUID(), agentId: randomUUID(), instance: "pane-agent", cli: "codex" as const, cwd: "C:\\fixture", sandbox: "read-only" as const, columns: 80, rows: 24 });
  const transcript = (id: string, cwd = "C:\\fixture", content = "owned canary") => {
    const dir = join(home, "codex", "sessions", "2026", "11", "03"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-test-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, cwd } }) + "\n" + JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ text: content }] } }) + "\n");
  };
  return { store, client, processes, machineId: claim.machineId, launch,
    hub: () => hub, restart: () => { hub.close(); hub = new RuntimeCoordinator(home, { requestTimeoutMs: 250 }); hubs.push(hub); }, home, transcript };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.stop();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const cursor = (sessionId: string) => ({ sessionId, offset: 0, fileId: null, anchor: PANE_TRANSCRIPT_EMPTY_ANCHOR });
it("binds only a unique owned status id, reads its exact native transcript, and keeps paths out of the wire", async () => {
  const f = await fixture(), sessionId = randomUUID(), pane = await f.hub().callPane(f.machineId, { action: "open", operationId: randomUUID(), launch: f.launch() }) as RuntimePaneSnapshot;
  const target = { paneId: pane.paneId, launchId: pane.launchId };
  await expect(f.hub().callPane(f.machineId, { action: "bind-session", ...target, sessionId })).rejects.toThrow("no unique");
  f.processes[0].emit(`Session: ${sessionId}\r\n`);
  expect(await f.hub().callPane(f.machineId, { action: "bind-session", ...target, sessionId })).toMatchObject({ sessionId, commandSequence: 0 });
  f.transcript(sessionId); const result = validatePaneTranscriptWireBatch(await f.hub().callPane(f.machineId, { action: "transcript", ...target, cursor: cursor(sessionId) }), sessionId);
  expect(result).toMatchObject({ state: "ready", gap: false, complete: true }); expect(Buffer.from(result.data, "base64").toString()).toContain("owned canary"); expect(JSON.stringify(result)).not.toContain(f.home);
  await expect(f.hub().callPane(f.machineId, { action: "bind-session", ...target, sessionId: randomUUID() })).rejects.toThrow("pinned elsewhere");
  await expect(f.hub().callPane(f.machineId, { action: "transcript", ...target, cursor: cursor(randomUUID()) })).rejects.toThrow("differs from its owned pane");
  await expect(f.hub().callPane(f.machineId, { action: "transcript", ...target, cursor: cursor(sessionId), path: "/tmp/unowned" })).rejects.toThrow();
  expect(f.processes[0].write).not.toHaveBeenCalled(); expect(JSON.parse(readFileSync(join(f.home, "runtime-machines.json"), "utf8")).commands).toHaveLength(0);
});
it("refuses ambiguous status cards and a correct filename with another workspace's metadata", async () => {
  const f = await fixture(), id = randomUUID(), launch = f.launch(), pane = await f.hub().callPane(f.machineId, { action: "open", operationId: randomUUID(), launch }) as RuntimePaneSnapshot;
  const target = { paneId: pane.paneId, launchId: pane.launchId }; f.processes[0].emit(`Session: ${id}\r\nSession: ${randomUUID()}\r\n`);
  await expect(f.hub().callPane(f.machineId, { action: "bind-session", ...target, sessionId: id })).rejects.toThrow("no unique");
  expect((await f.hub().callPane(f.machineId, { action: "list" }) as any).panes[0].sessionId).toBeUndefined();
  f.processes[0].emit(`\x1b[2J\x1b[HSession: ${id}\r\n`); await f.hub().callPane(f.machineId, { action: "bind-session", ...target, sessionId: id });
  f.transcript(id, "C:\\another-workspace"); await expect(f.hub().callPane(f.machineId, { action: "transcript", ...target, cursor: cursor(id) })).rejects.toThrow("metadata differs");
});
it("retains the same pin and cursor across a coordinator reconnect without repeating input", async () => {
  const f = await fixture(), id = randomUUID(), launch = { ...f.launch(), sessionId: id }, operationId = randomUUID();
  const pane = await f.hub().callPane(f.machineId, { action: "open", operationId, launch }) as RuntimePaneSnapshot; f.transcript(id);
  const request = { action: "transcript" as const, paneId: pane.paneId, launchId: pane.launchId, cursor: cursor(id) }, first = validatePaneTranscriptWireBatch(await f.hub().callPane(f.machineId, request), id);
  f.restart(); await vi.waitFor(() => expect(f.hub().machine(f.machineId)?.status).toBe("online"));
  expect(await f.hub().callPane(f.machineId, { action: "open", operationId, launch })).toMatchObject({ launchId: pane.launchId, sessionId: id });
  const next = validatePaneTranscriptWireBatch(await f.hub().callPane(f.machineId, { ...request, cursor: first.cursor }), id); expect(next.data).toBe(""); expect(next.cursor).toEqual(first.cursor); expect(f.processes).toHaveLength(1); expect(f.processes[0].write).not.toHaveBeenCalled();
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
