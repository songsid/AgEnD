import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
const proof = vi.hoisted(() => ({ exited: true }));
vi.mock("../src/general-host-owner.js", () => ({ confirmGeneralHostExit: vi.fn(async () => proof.exited) }));
import { FleetManager } from "../src/fleet-manager.js";
import { DEFAULT_INSTANCE_CONFIG } from "../src/config.js";
import { GeneralManagedFileError } from "../src/runtime-general-protocol.js";
import { GeneralBindings, generalBindingRevision } from "../src/general-binding.js";
import { SettingsExecution } from "../src/settings-transaction.js";
import { SettingsRouteLifetime } from "../src/settings-route-lifetime.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { deriveNeedsYou } from "../src/needs-you.js";
import { windowsAgentsFor } from "../src/windows-agents.js";
import { request as httpRequest } from "node:http";
import { AccessManager } from "../src/channel/access-manager.js";
import { WEB_CSRF_HEADER, WEB_SESSION_COOKIE } from "../src/web-auth.js";
import { csrfTokenFor, tokenEpoch } from "../src/web-session.js";
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
  const start = vi.spyOn(fm, "startInstance").mockImplementation(async () => { fm.assertGeneralBindingStart("general", fm.fleetConfig.instances.general); fm.daemons.set("general", {
    getProcessStatus: () => "running", nativePaneCurrent: () => true, getInstanceStateSnapshot: () => ({ state: "idle" }),
    getWorkingRecoveryState: () => ({ idle: true }), getInteractionSnapshot: () => ({ phase: "clear" }),
  }); });
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
it.each(["busy", "interaction", "work-lease", "recent-delivery"])("the Fleet idle gate refuses %s before writing, stopping or saving", async condition => {
  const r = rig(), daemon = r.fm.daemons.get("general"), write = vi.spyOn(r.store, "write");
  if (condition === "busy") daemon.getInstanceStateSnapshot = () => ({ state: "working" });
  if (condition === "interaction") daemon.getInteractionSnapshot = () => ({ phase: "waiting" });
  if (condition === "work-lease") vi.spyOn(r.fm.lifecycle, "hasWorkLease").mockReturnValue(true);
  if (condition === "recent-delivery") r.fm.lastDeliveryAt.set("general", Date.now());
  await expect(r.fm.switchGeneralLocation(r.request(), () => true, r.execution())).rejects.toThrow("Wait for General to be idle");
  expect(write).not.toHaveBeenCalled(); expect(r.store.read("general")).toBeNull();
  expect(r.stop).not.toHaveBeenCalled(); expect(r.fm.saveFleetConfig).not.toHaveBeenCalled(); expect(r.start).not.toHaveBeenCalled();
});
it.each(["activeId", "paneLaunchId"])("switch-back holds visibly if Windows retains %s after Stop", async retained => {
  const r = rig(); await r.fm.switchGeneralLocation(r.request(), () => true, r.execution());
  const config = r.fm.fleetConfig.instances.general, windows = windowsAgentsFor(r.fm, r.fm.runtimeWindowsExecutor()), launchId = randomUUID();
  windows.reservePane(config.native_agent_id, launchId);
  // Exercise each reservation independently, even if a partial/interrupted writer left only one field.
  const get = windows.get.bind(windows);
  vi.spyOn(windows, "get").mockImplementation((id: string) => { const row = get(id); delete row.activeId; delete row.paneLaunchId; row[retained as "activeId" | "paneLaunchId"] = launchId; return row; });
  r.stop.mockClear(); r.start.mockClear(); r.fm.saveFleetConfig.mockClear();
  await expect(r.fm.switchGeneralLocation({ ...r.request(), target: { location: "host" } }, () => true, r.execution())).rejects.toThrow("No replacement was started");
  expect(r.stop).toHaveBeenCalledOnce(); expect(r.start).not.toHaveBeenCalled(); expect(r.fm.saveFleetConfig).not.toHaveBeenCalled();
  expect(r.fm.fleetConfig.instances.general).toBe(config); expect(r.store.read("general")).toMatchObject({ hold: "exit", pending: { phase: "prepared", to: "host" } });
  const attention = r.fm.generalLocationAttention("general");
  expect(attention).toMatchObject({ offline: false, detail: expect.stringContaining("No replacement was started") });
  expect(deriveNeedsYou({ instances: [{ name: "general", generalLocation: attention }], deliveries: [], prompts: [], ownerOf: () => "dc" }))
    .toMatchObject([{ generalLocation: true, reason: "general_location_hold" }]);
});
it("Windows preparation and the persisted fleet instance omit all host credential and shell settings", async () => {
  const r = rig(), host = r.fm.fleetConfig.instances.general;
  Object.assign(host, { backend_options: { cli_path: "/host/private/claude", env: { HOST_ONLY: "fixture" } }, credential_profile: "host-profile", pre_task_command: "host-only-hook" });
  r.fm.saveFleetConfig.mockImplementation((patches: any[]) => {
    const saved = patches.find(row => row.path.join(".") === "instances.general").value;
    for (const key of ["backend_options", "credential_profile", "pre_task_command"]) expect(saved).not.toHaveProperty(key);
  });
  await r.fm.switchGeneralLocation(r.request(), () => true, r.execution());
  const record = r.store.read("general")!, prepared = record.windows[0].config;
  for (const key of ["backend_options", "credential_profile", "pre_task_command"]) {
    expect(prepared).not.toHaveProperty(key); expect(r.fm.fleetConfig.instances.general).not.toHaveProperty(key);
    expect(record.host.config).toHaveProperty(key, host[key]);
  }
  expect(r.fm.saveFleetConfig).toHaveBeenCalledOnce();
});
it("a switch awaiting capture holds web, platform and durable input before a pending journal exists", async () => {
  const r = rig(), daemon = r.fm.daemons.get("general"), outbox = new DeliveryOutbox(join(r.home, "in-flight-outbox.db"));
  r.fm.deliveryOutbox = outbox;
  let unblock!: () => void, entered!: () => void;
  const captured = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { unblock = resolve; });
  const owner = daemon.generalHostOwner;
  daemon.generalHostOwner = async () => { entered(); await barrier; return owner(); };
  const deliver = vi.spyOn(r.fm, "deliverHumanToInstance").mockResolvedValue(true);
  const adapter = { id: "dc", type: "telegram", sendText: vi.fn(async () => ({})), react: vi.fn(async () => {}) };
  r.fm.adapter = adapter; r.fm.adapters.set("dc", adapter);
  const channel = { id: "dc", type: "telegram", mode: "topic", group_id: "-1003007", bot_token_env: "FIXTURE", access: { mode: "open", allowed_users: ["admin"] } };
  r.fm.fleetConfig.channels = [channel];
  r.fm.worlds.set("dc", { id: "dc", adapterId: "dc", adapter, groupId: channel.group_id, channelConfig: channel,
    accessManager: new AccessManager(channel.access as never, join(r.home, "access.json")) });
  vi.spyOn(r.fm, "findGeneralInstance").mockReturnValue("general");
  vi.spyOn(r.fm.topicCommands, "handleInstanceCommand").mockResolvedValue(false); vi.spyOn(r.fm.topicCommands, "handleGeneralCommand").mockResolvedValue(false);
  vi.spyOn(r.fm, "getInstanceStatus").mockReturnValue("running");
  r.fm.runtimeHub.handlePublicRequest = () => false;
  r.fm.initializeWebAuthTokens(); r.fm.startHealthServer(0);
  await vi.waitFor(() => expect(r.fm.getDashboardAccess().ready).toBe(true));
  const port = r.fm.healthServer.address().port;
  const sid = r.fm.webSessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(r.fm.getDashboardAccess().token) }).sessionId;
  const switching = r.fm.switchGeneralLocation(r.request(), () => true, r.execution());
  try {
    await captured;
    expect(r.store.read("general")).toBeNull(); expect(r.fm.daemons.get("general")).toBe(daemon);
    const hold = r.fm.generalLocationDeliveryHold("general"); expect(hold).toContain("No replacement was started");
    const web = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/ui/send", headers: {
        host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, cookie: `${WEB_SESSION_COOKIE}=${sid}`,
        [WEB_CSRF_HEADER]: csrfTokenFor(sid), "content-type": "application/json",
      } }, res => { let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(body) })); });
      req.on("error", reject); req.end(JSON.stringify({ instance: "general", message: "held web input", clientId: "c000000000000000000003007" }));
    });
    expect(web).toMatchObject({ status: 200, body: { serviceResponse: true } });
    expect(r.fm.emitSseEvent).toHaveBeenCalledWith("message", expect.objectContaining({ instance: "general", role: "status", text: hold }));
    await r.fm.handleInboundMessage({ source: "telegram", adapterId: "dc", chatId: channel.group_id, userId: "admin", username: "Admin",
      messageId: "flight-3007-platform-input", text: "held platform input", isBotMessage: false, timestamp: new Date() });
    expect(adapter.sendText).toHaveBeenCalledWith(channel.group_id, hold, { threadId: undefined });
    expect(() => r.fm.admitDurableDelivery({ operationId: "flight-durable", sourceInstance: "sender", sourceDaemonBootId: "sender-boot",
      targetInstance: "general", kind: "fleet_inbound", payload: { content: "held durable input" } })).toThrow(hold);
    expect(deliver).not.toHaveBeenCalled(); expect(outbox.countForTarget("general", ["queued", "delivering", "submission_started"])).toBe(0);
    expect(r.stop).not.toHaveBeenCalled(); expect(r.start).not.toHaveBeenCalled();
  } finally {
    unblock(); await switching;
    await new Promise<void>(resolve => r.fm.healthServer.close(() => resolve())); outbox.close();
  }
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

it("a later managed-file startup failure names the file and offers a same-binding confirmed retry without another stop", async () => {
  const r = rig(); await r.fm.switchGeneralLocation(r.request(), () => true, r.execution());
  r.fm.daemons.delete("general"); vi.spyOn(r.fm, "nativePanes").mockResolvedValue({ prepare: async () => { throw new GeneralManagedFileError("CLAUDE.md"); } });
  await expect(r.fm.nativePaneFor("general", r.fm.fleetConfig.instances.general, () => {})).rejects.toThrow("could not start");
  expect(r.store.read("general")).toMatchObject({ hold: "start" }); expect(r.store.read("general")!.pending).toBeUndefined(); expect(r.fm.generalLocationAttention("general").detail).toContain("could not start");
  const stopped = r.stop.mock.calls.length;
  expect((await r.fm.switchGeneralLocation(r.request(), () => true, r.execution())).started).toBe(true);
  expect(r.stop).toHaveBeenCalledTimes(stopped); expect(r.store.read("general")!.hold).toBeUndefined();
});

it("a published same-binding Start clears a later file hold, but a stale daemon cannot clear it", async () => {
  const r = rig(); await r.fm.switchGeneralLocation(r.request(), () => true, r.execution());
  const record = r.store.read("general")!; record.hold = "start"; r.store.write(record);
  const daemon = { bootId: "published", getProcessStatus: () => "running", nativePaneCurrent: () => true }; r.fm.daemons.set("general", daemon);
  r.fm.onDaemonReady("general", "old-boot"); expect(r.store.read("general")!.hold).toBe("start");
  r.fm.onDaemonReady("general", daemon.bootId); expect(r.store.read("general")!.hold).toBeUndefined();
});
