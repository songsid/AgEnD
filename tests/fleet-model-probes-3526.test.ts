import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real fleet boot/save/reconciliation and bounded probe publication. All host,
// adapter, vendor and CLI effects remain inert, including worker construction.
vi.mock("node:worker_threads", async () => ({ Worker: (await import("./helpers/probe-worker.js")).FakeProbeWorker }));
vi.mock("../src/logger.js", async () => ({ createLogger: (await import("./helpers/probe-worker.js")).fakeProbeLogger, rotateLogIfNeeded: vi.fn() }));
vi.mock("../src/backend/factory.js", () => ({ createBackend: () => { throw Error("no backend on fleet loop"); } }));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const refuse = () => { throw Error("host child forbidden"); };
  return { ...real, spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});
vi.mock("../src/sd-notify.js", () => ({ sdNotify: vi.fn(), sdNotifyBlocking: vi.fn(), setSdNotifyWarn: vi.fn(), startSdWatchdog: () => setInterval(() => {}, 10_000) }));
vi.mock("../src/tmux-exec-helper.js", () => ({ tmuxExecHelper: { reopen() {}, start() {}, maintain() {}, async stop() {} } }));
vi.mock("../src/stall-reporter.js", () => ({ startStallReporter: () => null }));
vi.mock("../src/binary-probe.js", async original => {
  const real = await original<typeof import("../src/binary-probe.js")>();
  const inert = { answer: Promise.resolve<string | null>(null), kill() {}, exited: Promise.resolve() };
  return { ...real, spawnProbeCommand: () => inert, spawnWhich: () => inert, binaryProbe: new real.BinaryProbe(() => inert) };
});

import { FakeProbeWorker } from "./helpers/probe-worker.js";
import { FleetManager } from "../src/fleet-manager.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { TmuxControlClient } from "../src/tmux-control.js";
import { setUsageFetcherForTests } from "../src/usage/usage-api.js";

let dir: string, fm: any;
let signals: Map<NodeJS.Signals, Array<(...args: any[]) => void>>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fleet-models-3526-"));
  vi.stubEnv("AGEND_HOME", dir); vi.stubEnv("HOME", dir);
  signals = new Map(["SIGUSR1", "SIGUSR2"].map(s => [s as NodeJS.Signals, process.listeners(s as NodeJS.Signals)]));
  FakeProbeWorker.reset();
  FakeProbeWorker.answer = input => ({ models: [{ id: `${input.backend}-found`, label: "Discovered" }] });
  fm = new FleetManager(dir);
});
afterEach(async () => {
  await fm.stopAll(); fm.memoryPressure.stop(); fm.spawnGate.shutdown(); fm.stormWindow.shutdown();
  setUsageFetcherForTests(null);
  for (const [signal, previous] of signals) for (const l of process.listeners(signal)) if (!previous.includes(l)) process.removeListener(signal, l);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function config() {
  const work = join(dir, "workspaces/w"); mkdirSync(work, { recursive: true });
  const path = join(dir, "fleet.yaml");
  writeFileSync(path, `defaults:\n  backend: codex\n  locale: en\nweb:\n  preview: false\ninstances:\n  w:\n    working_directory: ${work}\n`);
  return path;
}
function isolateBoot() {
  vi.spyOn(TmuxManager, "ensureSession").mockResolvedValue(undefined);
  vi.spyOn(TmuxManager, "listWindows").mockResolvedValue([]);
  vi.spyOn(TmuxControlClient.prototype, "start").mockImplementation(() => {});
  vi.spyOn(TmuxControlClient.prototype, "stop").mockImplementation(() => {});
  vi.spyOn(fm.memoryPressure, "start").mockImplementation(() => {});
  vi.spyOn(fm.lifecycle, "primeAuthVerification").mockImplementation(() => {});
  for (const name of ["startAvailabilityRefresh", "ensureGeneralInstructions", "syncRoleSkills", "startSearchIndex", "startDiscordUsagePresence",
    "requestDiscordUsagePresenceRefresh", "startStatuslineWatcher", "resolveTopicIcons", "refreshAllGuestRooms", "startNeedsYou",
    "announceToolPermissionsChange", "sendFleetStartCompletionFallback", "startHealthServer"]) vi.spyOn(fm, name).mockImplementation(() => undefined);
  vi.spyOn(fm, "resolveKnowledgeWorkDir").mockImplementation((...args: unknown[]) => args[0]);
  vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
  vi.spyOn(fm.topicCommands, "autoCreateTopics").mockResolvedValue(undefined);
  vi.spyOn(fm.topicArchiver, "startPoller").mockImplementation(() => {});
  vi.spyOn(fm.lifecycle, "start").mockImplementation(async (...args: unknown[]) => {
    fm.daemons.set(args[0], { getProcessStatus: () => "running", getInteractionSnapshot: () => null });
  });
  setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [] }));
}
const ids = (backend = "codex", instance: string | null = "w") => fm.modelCatalogFor(backend, instance).map((m: any) => m.id);
async function settled() { await vi.waitFor(() => expect(fm.pendingCliEnvProbes.size + fm.webModelRefreshes.size).toBe(0)); }

describe("#3526 background model discovery", () => {
  it("a real no-channel boot discovers a host catalog without waiting for the worker", async () => {
    isolateBoot(); FakeProbeWorker.answer = undefined;
    await fm.startAll(config());
    expect(fm.adapter).toBeNull();
    expect(fm.startupComplete).toBe(true);
    expect(FakeProbeWorker.workers).toHaveLength(1);
    expect(ids()).toEqual([]);
    FakeProbeWorker.workers[0].reply({ models: [{ id: "codex-new", label: "New" }] });
    await settled(); expect(ids()).toEqual(["codex-new"]);
  });

  it("a committed new agent probes its backend; unrelated saves do not probe", async () => {
    fm.loadConfig(config());
    fm.fleetConfig.instances.new = { ...fm.fleetConfig.instances.w, backend: "antigravity" };
    fm.saveFleetConfig(); await settled();
    expect(ids("antigravity", "new")).toEqual(["antigravity-found"]);
    expect(FakeProbeWorker.workers.map(w => w.input.backend)).toEqual(["antigravity"]);
    fm.fleetConfig.instances.new.description = "a new description";
    fm.saveFleetConfig(); await settled();
    expect(FakeProbeWorker.workers).toHaveLength(1);
  });

  it("a CLI/profile switch probes the selected store, never a different account", async () => {
    fm.loadConfig(config());
    fm.fleetConfig.instances.w.backend = "claude-code";
    fm.fleetConfig.instances.w.backend_options = { "claude-code": { credential_profile: "work" } };
    fm.saveFleetConfig(); await settled();
    expect(ids("claude-code")).toEqual(["claude-code-found"]);
    expect(FakeProbeWorker.workers[0].input.config.credentialStoreHome).toBe(join(dir, "credential-profiles", "claude-code", "work"));
    expect(ids("claude-code", null)).toEqual([]);
    fm.fleetConfig.instances.w.backend_options["claude-code"].credential_profile = "other";
    fm.saveFleetConfig(); await settled();
    expect(FakeProbeWorker.workers[1].input.config.credentialStoreHome).toBe(join(dir, "credential-profiles", "claude-code", "other"));
  });

  it("empty background discovery preserves the selected account's good cache", async () => {
    fm.loadConfig(config());
    fm.fleetConfig.instances.w.backend = "antigravity";
    fm.saveFleetConfig(); await settled();
    FakeProbeWorker.answer = () => ({ models: [], currentModel: "new-default" });
    fm.probeCliEnvs(); await settled();
    expect(ids("antigravity")).toEqual(["antigravity-found"]);
  });

  it("a named Antigravity profile never borrows the default account's catalog", async () => {
    fm.loadConfig(config());
    await fm.probeBackendBounded("antigravity");
    expect(ids("antigravity", null)).toEqual(["antigravity-found"]);
    FakeProbeWorker.reset();
    FakeProbeWorker.answer = () => ({ models: [{ id: "ambient-account-only", label: "Wrong account" }] });
    fm.fleetConfig.instances.w.backend = "antigravity";
    fm.fleetConfig.instances.w.backend_options = { antigravity: { credential_profile: "work" } };
    fm.saveFleetConfig(); await settled();
    expect(ids("antigravity")).toEqual([]);
    expect(FakeProbeWorker.workers).toHaveLength(0);
  });

  it("a provider-bound change publishes only for the still-current target", async () => {
    fm.loadConfig(config()); FakeProbeWorker.answer = undefined;
    fm.fleetConfig.instances.w.backend_options = { codex: { provider: "one" } };
    fm.saveFleetConfig();
    expect(FakeProbeWorker.workers[0].input.config.backendOptions).toMatchObject({ provider: "one" });
    fm.fleetConfig.instances.w.backend_options.codex.provider = "two";
    fm.saveFleetConfig();
    FakeProbeWorker.workers[0].reply({ models: [{ id: "old-provider", label: "Old" }] });
    await vi.waitFor(() => expect(FakeProbeWorker.workers).toHaveLength(2));
    expect(ids()).toEqual([]);
    FakeProbeWorker.workers[1].reply({ models: [{ id: "new-provider", label: "New" }] });
    await settled(); expect(ids()).toEqual(["new-provider"]);
    expect(ids("codex", null)).toEqual([]);
  });

  it("inherited backend changes probe, but a failed save starts no discovery", async () => {
    fm.loadConfig(config());
    fm.fleetConfig.defaults.backend = "antigravity";
    fm.saveFleetConfig(); await settled();
    expect(ids("antigravity")).toEqual(["antigravity-found"]);
    const fsync = fm.fsyncForTest;
    fm.fsyncForTest = () => { throw Error("synthetic disk failure"); };
    fm.fleetConfig.instances.w.backend = "kiro-cli";
    expect(() => fm.saveFleetConfig()).toThrow("synthetic disk failure");
    fm.fsyncForTest = fsync;
    expect(FakeProbeWorker.workers.map(w => w.input.backend)).toEqual(["antigravity"]);
  });

  it("an accepted disk reload probes a new backend, a rejected reload does not", async () => {
    const path = config(); fm.loadConfig(path);
    const body = `defaults:\n  backend: antigravity\nweb:\n  preview: false\ninstances:\n  w:\n    working_directory: ${dir}/workspaces/w\n`;
    writeFileSync(path, body);
    await fm.reconcileInstances(); await settled();
    expect(ids("antigravity")).toEqual(["antigravity-found"]);
    writeFileSync(path, body.replace("antigravity", "nonexistent-backend"));
    expect((await fm.reconcileInstances()).rejected).toBeTruthy();
    expect(FakeProbeWorker.workers.map(w => w.input.backend)).toEqual(["antigravity"]);
  });
});
