import { RequestContextPublication } from "../src/request-context-installation.js";
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
  const tmux = { getWindowId: () => "%fixture" }, ipc = { retired: () => ipcClosed }; d.tmux = tmux; d.ipcServer = ipc;
  Object.defineProperty(d, "paneHost", { value: { getPanePid: async () => 777123 } });
  vi.spyOn(TmuxManager, "listWindowsStrict").mockResolvedValue([]);
  const kill = vi.spyOn(process, "kill").mockImplementation((() => { if (gone) throw Object.assign(Error("gone"), { code: "ESRCH" }); return true; }) as any);
  const proof = await d.captureRequestContextRetirement();
  expect(proof.retiredCurrent()).toBe(false);
  expect(await proof.retired()).toBe(false); ipcClosed = true; expect(await proof.retired()).toBe(false);
  gone = true; expect(proof.retiredCurrent()).toBe(false); expect(await proof.retired()).toBe(true);
  expect(proof.retiredCurrent()).toBe(true);
  d.ipcServer = null; expect(await proof.retired()).toBe(true); // abortStartup clears its closed server reference.
  d.ipcServer = { retired: () => true }; expect(await proof.retired()).toBe(false);
  expect(proof.retiredCurrent()).toBe(false);
  d.ipcServer = ipc;
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
it("first On captures actual idle pane evidence and late calls invalidate it even after they finish", async () => {
  const d = daemon(), capture = vi.fn(async () => "synthetic idle composer");
  const publication = new RequestContextPublication({ owner: "fixture", current: () => true }, false);
  d.setRequestContextAdmission(publication.admission); expect(await d.captureRequestContextIdle()).toBeNull(); publication.fence();
  d.tmux = { getWindowId: () => "owned", capturePane: capture }; d.ipcServer = {};
  d.processStatus = "running"; d.instanceState = "idle"; d.workingBackgroundObservation = null; // No optional background parser on this backend.
  vi.spyOn(d, "paneAuthoritativelyIdle").mockReturnValue(true); vi.spyOn(d, "inputTransientInPane").mockReturnValue(false);
  const proof = await d.captureRequestContextIdle(); expect(proof?.current()).toBe(true); expect(capture).toHaveBeenCalledWith(2000);
  const finish = d.requestContextPendingWork.begin("worker"); finish(); expect(proof?.current()).toBe(false);
  const next = await d.captureRequestContextIdle(); expect(next?.current()).toBe(true);
  d.ipcServer = {}; expect(next?.current()).toBe(false);
});
it("cached idle cannot hide a busy pane, queued work, unknown background work or a changed owner across the read", async () => {
  const d = daemon(); const publication = new RequestContextPublication({ owner: "fixture", current: () => true }, false); publication.fence(); d.setRequestContextAdmission(publication.admission); d.processStatus = "running"; d.instanceState = "idle"; d.workingBackgroundObservation = false;
  const capture = vi.fn(async () => "synthetic pane"); d.tmux = { getWindowId: () => "owned", capturePane: capture };
  const idle = vi.spyOn(d, "paneAuthoritativelyIdle").mockReturnValue(false); vi.spyOn(d, "inputTransientInPane").mockReturnValue(false);
  expect(await d.captureRequestContextIdle()).toBeNull(); idle.mockReturnValue(true);
  d.workingBackgroundObservation = null; d.backend = { backgroundWorkRunning: () => null }; expect(await d.captureRequestContextIdle()).toBeNull(); expect(capture).toHaveBeenCalledTimes(2);
  d.workingBackgroundObservation = false; d.backend.backgroundWorkRunning = () => false;
  let release!: (pane: string) => void; capture.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
  const pending = d.captureRequestContextIdle(); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  d.spawnGeneration++; release("synthetic idle"); expect(await pending).toBeNull();
});

it("a candidate retirement receipt keeps physical resources after startup rejection removes its public fields",async()=>{
 const d=daemon(),receipt=d.prepareRequestContextStartupRetirement(),resources=d.requestContextStartupResources;
 expect(await receipt.retired()).toBe(false);d.startupAborted=true;expect(await receipt.retired()).toBe(true);
 let closed=false;const ipc={retired:()=>closed};resources.ipc.add(ipc);expect(await receipt.retired()).toBe(false);
 closed=true;resources.windows.push({session:"fixture",window:"%owned",pid:777123});
 const windows=vi.spyOn(TmuxManager,"listWindowsStrict").mockResolvedValue([]);
 const probe=vi.spyOn(process,"kill").mockImplementation((()=>{throw Object.assign(Error("gone"),{code:"ESRCH"});}) as any);
 expect(await receipt.retired()).toBe(true);expect(probe.mock.calls).toEqual([[777123,0],[-777123,0]]);
 resources.pending++;expect(await receipt.retired()).toBe(false);resources.pending--;
 windows.mockResolvedValue([{id:"%owned"}] as any);expect(await receipt.retired()).toBe(false);
 windows.mockResolvedValue([]);resources.unknown=true;expect(await receipt.retired()).toBe(false);
});
it("a candidate native retirement receipt needs the original exited launch, never a detached or replacement snapshot",async()=>{
 const d=daemon(),receipt=d.prepareRequestContextStartupRetirement();let state="running",launchId="original";
 const native:any={backend:{},host:{},observation:{},snapshot:()=>({state,launchId,hostBootId:"host",paneId:"pane",agentId:"agent",instance:"worker"})};
 d.setNativePaneLifecycle(native);d.startupAborted=true;expect(await receipt.retired()).toBe(false);
 state="exited";expect(await receipt.retired()).toBe(true);launchId="new";expect(await receipt.retired()).toBe(false);
});
