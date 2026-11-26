import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createConnection } from "node:net";
import { once } from "node:events";
import { Daemon } from "../src/daemon.js";
import { IpcServer } from "../src/channel/ipc-bridge.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { RequestContextLocalTurns } from "../src/request-context-turns.js";
import { requestContextProcessGroupGone } from "../src/request-context-retirement.js";
const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home() { const path = mkdtempSync(join(tmpdir(), "retire-")); homes.push(path); return path; }
const logger: any = { info() {}, error() {}, warn() {}, debug() {}, child() { return logger; } };
function daemon() {
  const root = home(), dir = join(root, "worker"); mkdirSync(dir);
  return new Daemon("worker", { working_directory: root, backend: "claude-code", log_level: "silent" } as any, dir, true, undefined, undefined, logger) as any;
}
it("PID or process-group survival and unknown probes never count as exit; probes send no signals", () => {
  const missing = () => { throw Object.assign(Error("gone"), { code: "ESRCH" }); };
  const probe = vi.fn(missing); expect(requestContextProcessGroupGone(777123, probe)).toBe(true);
  expect(probe.mock.calls).toEqual([[777123, 0], [-777123, 0]]);
  expect(requestContextProcessGroupGone(777123, id => { if (id > 0) return missing(); return true; })).toBe(false);
  expect(requestContextProcessGroupGone(777123, () => { throw Object.assign(Error("unknown"), { code: "EPERM" }); })).toBe(false);
  expect(requestContextProcessGroupGone(1, probe)).toBe(false);
});
it("the exact IPC server proves callback closure and socket retirement, including concurrent close requests", async () => {
  const path = join(home(), "ipc.sock"), server = new IpcServer(path); await server.listen();
  const client = createConnection(path); await once(client, "connect");
  try {
    expect(server.retired()).toBe(false); await Promise.all([server.close(), server.close()]);
    expect(server.retired()).toBe(true);
    writeFileSync(path, "replacement socket marker"); expect(server.retired()).toBe(false);
  } finally { client.destroy(); await server.close(); }
});
it("local retirement needs the captured window, process group and exact IPC closure", async () => {
  const d = daemon(); let ipcClosed = false, gone = false;
  const tmux = { getWindowId: () => "%fixture" }; d.tmux = tmux; d.ipcServer = { retired: () => ipcClosed };
  Object.defineProperty(d, "paneHost", { value: { getPanePid: async () => 777123 } });
  vi.spyOn(TmuxManager, "listWindowsStrict").mockResolvedValue([]);
  const kill = vi.spyOn(process, "kill").mockImplementation((() => { if (gone) throw Object.assign(Error("gone"), { code: "ESRCH" }); return true; }) as any);
  const proof = await d.captureRequestContextRetirement();
  expect(await proof.retired()).toBe(false); ipcClosed = true; expect(await proof.retired()).toBe(false);
  gone = true; expect(await proof.retired()).toBe(true);
  expect(kill.mock.calls.every(call => call[1] === 0)).toBe(true);
  d.tmux = { getWindowId: () => "%fixture" }; expect(await proof.retired()).toBe(false);
});
it("unknown window state, IPC replacement or a respawn invalidates the old retirement proof", async () => {
  const d = daemon(), ipc = { retired: () => true }; d.tmux = { getWindowId: () => "%fixture" }; d.ipcServer = ipc;
  Object.defineProperty(d, "paneHost", { value: { getPanePid: async () => 777123 } });
  const windows = vi.spyOn(TmuxManager, "listWindowsStrict").mockRejectedValue(Error("unknown"));
  vi.spyOn(process, "kill").mockImplementation((() => { throw Object.assign(Error("gone"), { code: "ESRCH" }); }) as any);
  const proof = await d.captureRequestContextRetirement(); expect(await proof.retired()).toBe(false);
  windows.mockResolvedValue([]); d.ipcServer = { retired: () => true }; expect(await proof.retired()).toBe(false);
  d.ipcServer = ipc; d.spawnGeneration++; expect(await proof.retired()).toBe(false);
});
it("native retirement requires an exited snapshot for the exact captured launch; detach is insufficient", async () => {
  const d = daemon(); let state = "running", launchId = "old-launch";
  d.tmux = { getWindowId: () => "native-pane" };
  d.nativePaneLifecycle = { snapshot: () => ({ state, launchId, hostBootId: "host", paneId: "native-pane", agentId: "agent", instance: "worker" }) };
  const proof = await d.captureRequestContextRetirement(); expect(await proof.retired()).toBe(false);
  state = "exited"; expect(await proof.retired()).toBe(true);
  launchId = "replacement-launch"; expect(await proof.retired()).toBe(false);
});
it("a replacement reserves later generations pre-start and the setter stays closed on a live launch", () => {
  const d = daemon(); d.seedRequestContextReplacement({ spawnGeneration: 7, launchFenceEpoch: 11 });
  const turns = new RequestContextLocalTurns({ input: () => null, context: () => null, retain() {}, canManage: () => false, recovery: () => null, saveRecovery() {} });
  d.setRequestContextLocalLifecycle(turns, () => ({ incarnation: "fixture", workGeneration: "fixture" }));
  expect(d.requestContextOwner()).toMatchObject({ spawnGeneration: 8, launchFenceEpoch: 12 });
  expect(() => d.seedRequestContextReplacement({ spawnGeneration: 0, launchFenceEpoch: 0 })).toThrow(/before startup/);
  const live = daemon(); live.ipcServer = {}; expect(() => live.setRequestContextLocalLifecycle(turns, () => ({ incarnation: "fixture", workGeneration: "fixture" }))).toThrow(/before/);
});
