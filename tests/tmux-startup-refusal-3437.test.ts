import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the real early FleetManager startup and CLI boundary; all host,
// backend, adapter and watchdog effects are inert. The detector has its own
// real-private-socket coverage in bundled-tmux-guard-2457.test.ts.
const guard = vi.hoisted(() => ({ hit: { socket: "agend-owned-b", confirmed: true } }));
vi.mock("../src/bundled-tmux-guard.js", async original => ({
  ...await original<typeof import("../src/bundled-tmux-guard.js")>(), newerTmuxServer: async () => guard.hit,
}));
vi.mock("node:worker_threads", async () => ({ Worker: (await import("./helpers/probe-worker.js")).FakeProbeWorker }));
vi.mock("../src/logger.js", async () => ({ createLogger: (await import("./helpers/probe-worker.js")).fakeProbeLogger, rotateLogIfNeeded: vi.fn() }));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const refuse = () => { throw Error("host child forbidden"); };
  return { ...real, spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});
vi.mock("../src/sd-notify.js", () => ({ sdNotify: vi.fn(), sdNotifyBlocking: vi.fn(), setSdNotifyWarn: vi.fn(), startSdWatchdog: () => null }));
vi.mock("../src/tmux-exec-helper.js", () => ({ tmuxExecHelper: { reopen() {}, start() {}, maintain() {}, async stop() {} } }));
vi.mock("../src/stall-reporter.js", () => ({ startStallReporter: () => null }));
vi.mock("../src/binary-probe.js", async original => {
  const real = await original<typeof import("../src/binary-probe.js")>();
  const inert = { answer: Promise.resolve(null), kill() {}, exited: Promise.resolve() };
  return { ...real, spawnProbeCommand: () => inert, spawnWhich: () => inert, binaryProbe: new real.BinaryProbe(() => inert) };
});

import { FleetManager } from "../src/fleet-manager.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { guardMessage } from "../src/bundled-tmux-guard.js";
import { installFleetProcessHandlers, startFleetOrExit } from "../src/fleet-process-handlers.js";

let dir: string, fm: any;
let signals: Map<NodeJS.Signals, Array<(...args: any[]) => void>>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tmux-refusal-3437-"));
  vi.stubEnv("AGEND_HOME", dir); vi.stubEnv("HOME", dir);
  signals = new Map(["SIGUSR1", "SIGUSR2"].map(s => [s as NodeJS.Signals, process.listeners(s as NodeJS.Signals)]));
  fm = new FleetManager(dir);
  vi.spyOn(fm.memoryPressure, "start").mockImplementation(() => {});
});
afterEach(async () => {
  await fm.stopAll(); fm.memoryPressure.stop(); fm.spawnGate.shutdown(); fm.stormWindow.shutdown();
  for (const [signal, previous] of signals) for (const l of process.listeners(signal)) if (!previous.includes(l)) process.removeListener(signal, l);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("#3437 deliberate tmux startup refusal", () => {
  it.each([true, false])("handles the real startup refusal (confirmed=%s) once, without a generic notice", async confirmed => {
    guard.hit = { socket: "agend-owned-b", confirmed };
    const path = join(dir, "fleet.yaml");
    writeFileSync(path, "defaults:\n  locale: en\ninstances: {}\n");
    const ensure = vi.spyOn(TmuxManager, "ensureSession").mockResolvedValue(undefined);
    const start = vi.spyOn(fm.lifecycle, "start");
    const notify = vi.spyOn(fm, "notifyFleetError");
    const stop = vi.spyOn(fm, "stopAll");
    const output = { log: vi.fn(), error: vi.fn() }, exit = vi.fn() as any;
    const events = new Map<string, (...args: any[]) => unknown>();
    const runtime = { exit, on: (name: string, listener: (...args: any[]) => unknown) => events.set(name, listener) } as any;
    installFleetProcessHandlers({ manager: fm, runtime, console: output, dataDir: dir, describeSignal: () => "test" });
    await expect(startFleetOrExit(fm, path, runtime, output)).resolves.toBeUndefined();
    expect(output.error.mock.calls).toEqual([[guardMessage(guard.hit)]]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(stop).toHaveBeenCalledOnce();
    expect(ensure).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(fm.logger.error).not.toHaveBeenCalled(); // no second copy of the refusal through the logger
    expect(fm.startupComplete).toBe(false);
    // Unrelated runtime failures still use the installed handler.
    events.get("unhandledRejection")!(new Error("unrelated runtime failure"));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Fleet caught an unhandled error"));
  });

  it("does not treat an unrelated error with identical text as a handled guard refusal", async () => {
    const error = new Error(guardMessage("agend-owned-b"));
    const manager = { startAll: vi.fn(async () => { throw error; }), stopAll: vi.fn(async () => {}) };
    const runtime = { exit: vi.fn() as any }, output = { error: vi.fn() };
    await expect(startFleetOrExit(manager, "unused", runtime, output)).rejects.toBe(error);
    expect(output.error).not.toHaveBeenCalled(); expect(runtime.exit).not.toHaveBeenCalled();
    expect(manager.stopAll).not.toHaveBeenCalled();
  });
});
