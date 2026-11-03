/** Closed protocol, real host/port/store and inert processes: no CLI, account or live fleet. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RuntimePaneHost, type RuntimePaneProcess } from "../src/runtime-pane-host.js";
import { RuntimePaneStore } from "../src/runtime-pane-store.js";
import { RuntimePanePort, type PaneEndpoint } from "../src/runtime-pane-port.js";
import { validateRuntimePaneRequest, validateRuntimePaneOpenResult, type RuntimePaneLaunch } from "../src/runtime-pane-protocol.js";
import { startPaneService } from "../src/runtime-pane-service.js";
import { RuntimePaneLink } from "../src/runtime-pane-link.js";
import { readPaneHostDescriptor } from "../src/runtime-pane-private.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function child() {
  let exit = (_value: { exitCode: number }) => {}, output = (_text: string) => {};
  return { pid: 12345, write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    kill: vi.fn(() => exit({ exitCode: 0 })), finish: () => exit({ exitCode: 0 }), emit: (text: string) => output(text),
    onData: (callback: typeof output) => { output = callback; return { dispose() {} }; },
    onExit: (callback: typeof exit) => { exit = callback; return { dispose() {} }; } };
}
function launch(): RuntimePaneLaunch {
  return { paneId: randomUUID(), launchId: randomUUID(), agentId: randomUUID(), instance: "scratch",
    cli: "codex", cwd: "C:\\scratch", sandbox: "read-only", sessionId: randomUUID(), columns: 80, rows: 24 };
}
function fixture(limit = 4) {
  const root = mkdtempSync(join(tmpdir(), "agend-host-recovery-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new RuntimePaneStore(join(root, "runner")), bootId = randomUUID(), processes: ReturnType<typeof child>[] = [];
  const spawn = vi.fn(async () => { const process = child(); processes.push(process); return process; });
  const host = new RuntimePaneHost({ store, bootId, online: () => true, maxAgents: () => limit, spawn }); cleanup.push(() => host.stop());
  const endpoint: PaneEndpoint = { machineId: "local", online: () => true, call: request => host.request(request), subscribe: () => () => {} };
  return { root, host, store, spawn, processes, endpoint, bootId, limit: (value: number) => { limit = value; },
    open: (config = launch(), operationId = randomUUID()) => host.request({ action: "open", launch: config, operationId }).then(validateRuntimePaneOpenResult) };
}

it("a lost open ACK returns the host's reattach disposition even without a coordinator snapshot", async () => {
  const f = fixture(), config = launch(), file = join(f.root, "coordinator.json"), call = f.endpoint.call;
  f.endpoint.call = async request => { const result = await call(request); if (request.action === "open") throw Error("ACK lost"); return result; };
  await expect(new RuntimePanePort(f.endpoint, file, config).open()).rejects.toThrow("ACK lost");
  expect(JSON.parse(readFileSync(file, "utf8")).snapshot).toBeUndefined();
  f.processes[0].emit("• Working (esc to interrupt)\r\n"); f.endpoint.call = call;
  const next = new RuntimePanePort(f.endpoint, file, config);
  expect((await next.open()).reattached).toBe(true);
  expect(f.spawn).toHaveBeenCalledOnce(); expect(f.processes[0].write).not.toHaveBeenCalled();
});
it("missing host disposition fails closed, even if the local receipt looks fresh", async () => {
  const f = fixture(), config = launch(), call = f.endpoint.call;
  f.endpoint.call = async request => { const value = await call(request); if (request.action === "open") { const { reattached, ...snapshot } = value as any; return snapshot; } return value; };
  await expect(new RuntimePanePort(f.endpoint, join(f.root, "receipt.json"), config).open()).rejects.toThrow("disposition");
  expect(f.processes[0].write).not.toHaveBeenCalled();
});
it("a durable no-launch receipt survives a lost ACK and capacity changes without ever launching its old identity", async () => {
  const f = fixture(1), admitted = await f.open(), config = launch(), operationId = randomUUID();
  const refused = await f.open(config, operationId);
  expect(refused).toMatchObject({ state: "exited", noLaunch: true, reattached: false, launchId: config.launchId });
  f.processes[0].finish(); f.limit(4);
  expect(await f.open(config, operationId)).toMatchObject({ state: "exited", noLaunch: true, reattached: true });
  expect(new RuntimePaneStore(join(f.root, "runner")).get(config.paneId)?.snapshot.noLaunch).toBe(true);
  expect(f.spawn).toHaveBeenCalledOnce(); expect(f.store.get(admitted.paneId)?.snapshot.state).toBe("exited");
});
it("no-launch receipt persistence failure never permits a spawn or a positive receipt", async () => {
  const f = fixture(1); await f.open(); vi.spyOn(f.store, "put").mockImplementationOnce(() => { throw Error("disk full"); });
  await expect(f.open()).rejects.toThrow("disk full"); expect(f.spawn).toHaveBeenCalledOnce();
});
it("a factory that throws after its launch boundary never gets a no-launch receipt", async () => {
  const f = fixture(); f.spawn.mockRejectedValueOnce(Error("native outcome unknown")); const config = launch();
  await expect(f.open(config)).rejects.toThrow("unknown");
  expect(f.store.get(config.paneId)?.snapshot).toMatchObject({ state: "unknown" });
  expect(f.store.get(config.paneId)?.snapshot.noLaunch).toBeUndefined();
  await expect(f.host.request({ action: "shutdown", hostBootId: f.bootId })).rejects.toThrow("unconfirmed");
});
it("shutdown is closed, boot-bound, and refuses a live or uncertain pane without sending any keys", async () => {
  const f = fixture(), pane = await f.open();
  expect(() => validateRuntimePaneRequest({ action: "shutdown", hostBootId: f.bootId, force: true })).toThrow();
  await expect(f.host.request({ action: "shutdown", hostBootId: randomUUID() })).rejects.toThrow();
  await expect(f.host.request({ action: "shutdown", hostBootId: f.bootId })).rejects.toThrow();
  expect(f.processes[0].kill).not.toHaveBeenCalled(); expect(f.processes[0].write).not.toHaveBeenCalled();
  f.processes[0].finish();
  expect(await f.host.request({ action: "shutdown", hostBootId: f.bootId })).toEqual({ hostBootId: f.bootId, shutdown: true });
  await expect(f.open()).rejects.toThrow("disconnected"); expect(f.store.get(pane.paneId)?.snapshot.state).toBe("exited");
});
it("shutdown cannot race a queued or in-flight open, including before its native process exists", async () => {
  const f = fixture(); let release!: (process: RuntimePaneProcess) => void;
  f.spawn.mockImplementationOnce(() => new Promise(done => { release = done; }) as any);
  const opening = f.open(); await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
  await expect(f.host.request({ action: "shutdown", hostBootId: f.bootId })).rejects.toThrow();
  const process = child(); release(process); expect((await opening).state).toBe("running"); process.finish();
});
it("normal relay detach preserves the host; explicit empty shutdown closes its listener and discovery, then a new boot starts", async () => {
  const f = fixture();
  const directory = join(f.root, "service"), scope = "a".repeat(64);
  const first = await startPaneService({ directory, scope }); cleanup.push(() => first.close());
  const link = await RuntimePaneLink.attach(first.descriptor, { online: () => true, maxAgents: () => 4 }); await link.stop();
  expect(readPaneHostDescriptor(directory, scope)?.hostBootId).toBe(first.descriptor.hostBootId);
  const next = await RuntimePaneLink.attach(first.descriptor, { online: () => true, maxAgents: () => 4 }); cleanup.push(() => next.stop());
  await next.retireOwned();
  await vi.waitFor(() => expect(readPaneHostDescriptor(directory, scope)).toBeNull()); await first.close();
  const second = await startPaneService({ directory, scope }); cleanup.push(() => second.close());
  expect(second.descriptor.hostBootId).not.toBe(first.descriptor.hostBootId);
});
