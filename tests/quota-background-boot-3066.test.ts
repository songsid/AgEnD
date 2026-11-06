/**
 * #3066 §1d (Fable r1, blocking): the 30-minute quota read is started by the fleet's real startup on a web-only fleet
 * (#2910: no chat connection at all) — the clearest case with no Discord bot reading. Real startAll, every
 * process/tmux/provider boundary inert (as classic-start-with-fleet-2642).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ children: [] as string[] }));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const refuse = (...args: unknown[]) => { calls.children.push(String(args[0])); throw Error("native children forbidden in startup tests"); };
  return { ...real, spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});
vi.mock("../src/logger.js", async original => {
  const silent: any = { info() {}, debug() {}, warn() {}, error() {}, child: () => silent };
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
vi.mock("../src/sd-notify.js", () => ({ sdNotify: () => {}, sdNotifyBlocking: vi.fn(), setSdNotifyWarn: vi.fn(), startSdWatchdog: () => setInterval(() => {}, 10_000) }));
vi.mock("../src/tmux-exec-helper.js", () => ({ tmuxExecHelper: { reopen() {}, start() {}, maintain() {}, async stop() {} } }));
vi.mock("../src/binary-probe.js", async original => {
  const real = await original<typeof import("../src/binary-probe.js")>();
  const inert = { answer: Promise.resolve<string | null>(null), kill() {}, exited: Promise.resolve() };
  return { ...real, spawnProbeCommand: () => inert, spawnWhich: () => inert, binaryProbe: new real.BinaryProbe(() => inert) };
});

const { FleetManager } = await import("../src/fleet-manager.js");
const { TmuxManager } = await import("../src/tmux-manager.js");
const { TmuxControlClient } = await import("../src/tmux-control.js");
const { setUsageFetcherForTests } = await import("../src/usage/usage-api.js");

const fleets: Array<{ fm: any; dir: string; boot: Promise<void> }> = [];
const savedSignals = new Map(["SIGUSR1", "SIGUSR2"].map(s => [s, process.listeners(s as NodeJS.Signals)] as const));
afterEach(async () => {
  for (const f of fleets.splice(0)) {
    await f.boot.catch(() => {});
    await f.fm.stopAll();
    f.fm.memoryPressure.stop(); f.fm.spawnGate.shutdown(); f.fm.stormWindow.shutdown();
    rmSync(f.dir, { recursive: true, force: true });
  }
  setUsageFetcherForTests(null);
  for (const [signal, previous] of savedSignals) {
    for (const l of process.listeners(signal as NodeJS.Signals)) if (!previous.includes(l)) process.removeListener(signal, l);
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  expect(calls.children.splice(0)).toEqual([]);
});

describe("#3066 §1d: the background quota read on every fleet", () => {
  it("a web-only fleet (no chat connection): startup starts the 30-minute read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-boot-3066-"));
    vi.stubEnv("AGEND_HOME", dir); vi.stubEnv("HOME", dir);
    const general = join(dir, "g"); mkdirSync(general, { recursive: true });
    const config = join(dir, "fleet.yaml");
    writeFileSync(config, `defaults:
  locale: en
  startup:
    concurrency: 1
    stagger_delay_ms: 0
web:
  preview: false
instances:
  general:
    working_directory: ${general}
    general_topic: true
`);
    const fm: any = new FleetManager(dir);
    vi.spyOn(TmuxManager, "ensureSession").mockResolvedValue(undefined);
    vi.spyOn(TmuxManager, "listWindows").mockResolvedValue([]);
    vi.spyOn(TmuxControlClient.prototype, "start").mockImplementation(() => {});
    vi.spyOn(TmuxControlClient.prototype, "stop").mockImplementation(() => {});
    vi.spyOn(fm.memoryPressure, "start").mockImplementation(() => {});
    vi.spyOn(fm.lifecycle, "primeAuthVerification").mockImplementation(() => {});
    for (const name of ["startAvailabilityRefresh", "ensureGeneralInstructions", "syncRoleSkills", "startSearchIndex",
      "startDiscordUsagePresence", "requestDiscordUsagePresenceRefresh", "startStatuslineWatcher", "resolveTopicIcons",
      "refreshAllGuestRooms", "startNeedsYou", "announceToolPermissionsChange", "sendFleetStartCompletionFallback",
      "notifyAdapterFailure", "scheduleAdapterRetry"]) {
      vi.spyOn(fm, name).mockImplementation(() => undefined);
    }
    vi.spyOn(fm, "resolveKnowledgeWorkDir").mockImplementation((...args: unknown[]) => args[0]);
    vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
    vi.spyOn(fm, "startHealthServer").mockResolvedValue(undefined);
    vi.spyOn(fm.topicArchiver, "startPoller").mockImplementation(() => {});
    vi.spyOn(fm.lifecycle, "start").mockImplementation(async (...args: unknown[]) => {
      fm.daemons.set(args[0], { getProcessStatus: () => "running", getInteractionSnapshot: () => null });
    });
    vi.spyOn(fm.lifecycle, "stop").mockImplementation(async (...args: unknown[]) => { fm.daemons.delete(args[0]); });
    setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [] }));
    const started = vi.spyOn(fm, "startQuotaBackgroundReads");
    const booted = fm.startAll(config) as Promise<void>;
    fleets.push({ fm, dir, boot: booted });
    await booted;
    expect(fm.fleetConfig.channels ?? []).toEqual([]);                          // web-only indeed
    expect(fm.fleetConfig.channel).toBeUndefined();
    expect(started).toHaveBeenCalledOnce();
    expect(fm.quotaReadTimer).not.toBeNull();
  }, 30_000);
});
