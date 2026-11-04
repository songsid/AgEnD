import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
const proof = vi.hoisted(() => ({ exited: true }));
vi.mock("../src/general-host-owner.js", () => ({ confirmGeneralHostExit: vi.fn(async () => proof.exited) }));
import { FleetManager } from "../src/fleet-manager.js";
import { DEFAULT_INSTANCE_CONFIG } from "../src/config.js";
import { GeneralBindings, generalBindingRevision } from "../src/general-binding.js";
import { SettingsExecution } from "../src/settings-transaction.js";
import { SettingsRouteLifetime } from "../src/settings-route-lifetime.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { deriveNeedsYou } from "../src/needs-you.js";
const roots: string[] = [], executions: SettingsExecution[] = [];
afterEach(() => { for (const e of executions.splice(0)) e.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); proof.exited = true; vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function rig() {
  const home = mkdtempSync(join(tmpdir(), "agend-test-general-fleet-")); roots.push(home); vi.stubEnv("AGEND_HOME", home); vi.stubEnv("AGEND_REMOTE_RUNTIME", "1");
  const fm = new FleetManager(home) as any, machineId = randomUUID(), pin = randomUUID(); let transport = "epoch1", allowed = true;
  const host = { ...structuredClone(DEFAULT_INSTANCE_CONFIG), general_topic: true, working_directory: join(home, "project"), backend: "claude-code", topic_id: 1, channel_id: "dc" };
  fm.fleetConfig = { instances: { general: host }, channels: [{ id: "dc", type: "discord" }], defaults: {} }; fm.configPath = join(home, "fleet.yaml");
  const machine = { id: machineId, name: "Scratch PC", status: "online", inventory: { clis: [{ id: "claude-code", runnable: true, version: "2.1.316" }] } };
  fm.runtimeHub = { machine: () => machine, listMachines: () => [machine], paneTransportEpoch: () => transport };
  fm.daemons.set("general", { getConfigSnapshot: () => host, getInstanceStateSnapshot: () => ({ state: "idle" }), getWorkingRecoveryState: () => ({ idle: true }),
    getInteractionSnapshot: () => ({ phase: "clear" }), generalHostOwner: async () => ({ kind: "tmux", windowId: "@99", pid: 90000, pin: { backend: "claude-code", sessionId: pin } }) });
  vi.spyOn(fm, "prepareWindowsGeneralWorkspace").mockImplementation(async () => ({ cwd: "C:\\scratch\\general" }));
  vi.spyOn(fm, "runtimeWindowsExecutor").mockReturnValue({ get: () => null, start: () => { throw Error("no actual process"); } });
  vi.spyOn(fm, "getSettingsConfigPath").mockReturnValue(fm.configPath);
  vi.spyOn(fm, "saveFleetConfig").mockImplementation(() => {}); vi.spyOn(fm.routing, "rebuild").mockImplementation(() => {});
  vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined); vi.spyOn(fm, "notifyInstanceTopic").mockImplementation(() => {}); vi.spyOn(fm, "emitSseEvent").mockImplementation(() => {}); vi.spyOn(fm, "getUiStatus").mockReturnValue({});
  const stop = vi.spyOn(fm, "stopInstance").mockImplementation(async () => { fm.explicitStopGeneration.set("general", (fm.explicitStopGeneration.get("general") ?? 0) + 1); fm.lifecycle.invalidate("general"); fm.daemons.delete("general"); });
  const start = vi.spyOn(fm, "startInstance").mockImplementation(async () => { fm.assertGeneralBindingStart("general", fm.fleetConfig.instances.general); fm.daemons.set("general", { getProcessStatus: () => "running", nativePaneCurrent: () => true }); });
  const store = new GeneralBindings(home);
  const request = () => ({ name: "general", revision: generalBindingRevision(store.read("general"), fm.fleetConfig.instances.general), target: { location: "windows", machineId, cli: "claude-code", model: "haiku" } });
  const execution = () => { const route = new SettingsRouteLifetime("general", () => allowed, () => fm.lifecycle.epochOf("general"), () => false);
    const e = new SettingsExecution({ current: () => allowed && route.current(), snapshot: () => fm.fleetConfig, followStop: (name, begin) => route.followStop(name, begin) }); executions.push(e); return e; };
  return { fm, store, home, pin, request, execution, stop, start, revoke: () => { allowed = false; }, changeTransport: () => { transport = "epoch2"; } };
}
it("the real Fleet switch crosses only its own route stop and retains the exact host pin", async () => {
  const r = rig(); const result = await r.fm.switchGeneralLocation(r.request(), () => true, r.execution());
  expect(result.started).toBe(true); expect(r.stop).toHaveBeenCalledOnce(); expect(r.start).toHaveBeenCalledOnce();
  expect(r.store.read("general")).toMatchObject({ host: { pin: { sessionId: r.pin } } }); expect(r.store.read("general")!.pending).toBeUndefined();
  expect(r.fm.generalLocationDeliveryHold("general")).toBeNull();
});
it("an unconfirmed old host exit is visible, retains host config and starts nothing", async () => {
  const r = rig(); proof.exited = false;
  await expect(r.fm.switchGeneralLocation(r.request(), () => true, r.execution())).rejects.toThrow();
  expect(r.fm.fleetConfig.instances.general.runtime).not.toBe("windows"); expect(r.start).not.toHaveBeenCalled();
  const attention = r.fm.generalLocationAttention("general"); expect(attention.detail).toContain("No replacement was started");
  const items = deriveNeedsYou({ instances: [{ name: "general", crashedAt: 1, paneRecovery: { key: "same", since: 1, detail: "duplicate" }, generalLocation: attention }], deliveries: [], prompts: [], ownerOf: () => "dc" });
  expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ generalLocation: true, reason: "general_location_hold" });
});
it("a reconnected target during publication invalidates the switch before any stop or config save", async () => {
  const r = rig(); r.fm.prepareWindowsGeneralWorkspace.mockImplementation(async () => { r.changeTransport(); return { cwd: "C:\\scratch\\general" }; });
  await expect(r.fm.switchGeneralLocation(r.request(), () => true, r.execution())).rejects.toThrow("superseded"); expect(r.stop).not.toHaveBeenCalled(); expect(r.start).not.toHaveBeenCalled();
});
it("offline attention is stable, clears on reconnect and starts a new episode later", async () => {
  const r = rig(); await r.fm.switchGeneralLocation(r.request(), () => true, r.execution());
  r.fm.runtimeHub.machine().status = "offline";
  const first = r.fm.generalLocationAttention("general"); expect(r.fm.generalLocationAttention("general")).toEqual(first); expect(first.offline).toBe(true);
  r.fm.runtimeHub.machine().status = "online"; expect(r.fm.generalLocationAttention("general")).toBeNull();
  r.fm.runtimeHub.machine().status = "offline"; expect(r.fm.generalLocationAttention("general").since).toBeGreaterThanOrEqual(first.since);
});

it("an unreadable binding journal holds visibly and cannot erase the fleet inbox", async () => {
  const r = rig(); await r.fm.switchGeneralLocation(r.request(), () => true, r.execution());
  vi.spyOn(GeneralBindings.prototype, "read").mockImplementation(() => { throw Error("unreadable"); });
  expect(r.fm.generalLocationAttention("general")).toMatchObject({ offline: false, detail: expect.stringContaining("could not start") });
  expect(r.fm.generalLocationDeliveryHold("unrelated")).toBeNull();
});

it("the positive-stop boundary terminates old queued input and holds begun input as uncertain, never a new launch queue", () => {
  const r = rig(), outbox = new DeliveryOutbox(join(r.home, "outbox.db")); r.fm.deliveryOutbox = outbox;
  const admit = (key: string, targetInstance = "general") => outbox.admit({ sourceKey: key, operationId: key, sourceInstance: "sender", sourceDaemonBootId: "source", targetInstance, kind: "fleet_inbound", payload: { type: "fleet_inbound", content: key } }).delivery;
  try {
    const begun = admit("begun"), claimed = outbox.claimNext("manager", () => "old-boot", new Set())!;
    expect(outbox.begin(claimed.deliveryId, claimed.targetDaemonBootId, claimed.attemptNo)).toBe("begun");
    const queued = admit("queued"), other = admit("other", "worker");
    r.fm.holdGeneralOldDeliveries("general");
    expect(outbox.get(begun.deliveryId)!.state).toBe("uncertain"); expect(outbox.get(queued.deliveryId)!.state).toBe("failed");
    expect(outbox.get(other.deliveryId)!.state).toBe("queued");
    expect(outbox.claimNext("new-manager", () => "new-boot", new Set())!.targetInstance).toBe("worker");
    expect(outbox.needsAttention("2000-01-01T00:00:00Z").map(row => row.deliveryId).sort()).toEqual([begun.deliveryId, queued.deliveryId].sort());
  } finally { outbox.close(); }
});

it("the real Fleet can reverse a config-save interruption while Windows is offline without recapturing the stopped host", async () => {
  const r = rig(); r.fm.saveFleetConfig.mockImplementationOnce(() => { throw Error("config save interrupted"); });
  await expect(r.fm.switchGeneralLocation(r.request(), () => true, r.execution())).rejects.toThrow("config save interrupted");
  expect(r.fm.daemons.has("general")).toBe(false); expect(r.fm.fleetConfig.instances.general.runtime).not.toBe("windows");
  r.fm.runtimeHub.machine().status = "offline";
  const retry = { ...r.request(), target: { location: "host" } };
  expect((await r.fm.switchGeneralLocation(retry, () => true, r.execution())).started).toBe(true);
  expect(r.fm.fleetConfig.instances.general.runtime).not.toBe("windows"); expect(r.start).toHaveBeenCalledOnce();
  expect(r.store.read("general")!.active).toBe("host");
});

it("revocation during selected startup reaches the production startup capability and leaves a visible start hold", async () => {
  const r = rig(); r.fm.startInstance.mockImplementation(async (...args: any[]) => {
    const capability = args[6]; expect(capability).toBeInstanceOf(SettingsExecution); expect(capability.current()).toBe(true);
    r.revoke(); await Promise.resolve(); capability.assert(); throw Error("must not publish");
  });
  expect((await r.fm.switchGeneralLocation(r.request(), () => true, r.execution())).started).toBe(false);
  expect(r.fm.daemons.has("general")).toBe(false); expect(r.store.read("general")).toMatchObject({ hold: "start", pending: { phase: "selected" } });
});

it("the runtime disconnect callback immediately holds only that Windows General's old waiting input", async () => {
  const r = rig(), machineId = r.request().target.machineId;
  r.fm.fleetConfig.instances.general = { ...r.fm.fleetConfig.instances.general, runtime: "windows", machine_id: machineId };
  r.fm.fleetConfig.instances.worker = { ...r.fm.fleetConfig.instances.general, general_topic: false };
  r.fm.runtimeHub = null; const hub = r.fm.runtimeCoordinator();
  const hold = vi.spyOn(r.fm, "holdGeneralOldDeliveries").mockImplementation(() => {}), cancel = vi.spyOn(r.fm, "cancelPendingDeliveries").mockImplementation(() => {});
  try {
    hub.options.changed({ type: "machine", machineId }); await Promise.resolve();
    expect(hold).toHaveBeenCalledExactlyOnceWith("general"); expect(cancel).toHaveBeenCalledExactlyOnceWith("general"); expect(r.start).not.toHaveBeenCalled();
  } finally { hub.close(); }
});
