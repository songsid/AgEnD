/**
 * M-2738 (Fable #3504 review 4): the new fleet's boot after a WEB-started update adopts no chat message — the marker's
 * target is the web (no adapter has it): the boot is announced as any restart (RestartProgress.start), never resumed onto
 * a chat message (RestartProgress.resume), and the marker is cleared. Control: a chat /update's marker is resumed onto
 * its own message. Real boot ordering, every process/tmux/provider boundary inert (the #2642 harness).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ children: [] as string[], notify: [] as string[], warns: [] as string[] }));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const refuse = (...args: unknown[]) => { calls.children.push(String(args[0])); throw Error("native children forbidden in startup tests"); };
  return { ...real, spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});
vi.mock("../src/logger.js", async original => {
  const silent: any = { info() {}, debug() {}, warn(_o: unknown, m?: string) { if (m) calls.warns.push(m); }, error() {}, child: () => silent };
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
vi.mock("../src/sd-notify.js", () => ({ sdNotify: (s: string) => { calls.notify.push(s); }, sdNotifyBlocking: vi.fn(), setSdNotifyWarn: vi.fn(), startSdWatchdog: () => setInterval(() => {}, 10_000) }));
// The fleet's tmux server boundary (M-2457 §6): inert too, as in alpha's #2642 harness.
vi.mock("../src/tmux-server.js", async original => ({
  ...await original<typeof import("../src/tmux-server.js")>(),
  reconcileServer: async () => null,
  recordServer: async () => ({ socket: "agend-test", binary: "", version: "", sha256: "0".repeat(64), serverPid: 1, serverStart: 1 }),
  readServerRecord: () => null,
  sha256File: () => "0".repeat(64),
}));
vi.mock("../src/tmux-exec-helper.js", () => ({ tmuxExecHelper: { reopen() {}, start() {}, maintain() {}, async stop() {} } }));
// startInstance now awaits resolveBackendBinary before lifecycle.start (#3029). The probe is a child; this suite forbids those.
vi.mock("../src/binary-probe.js", async original => {
  const real = await original<typeof import("../src/binary-probe.js")>();
  const inert = { answer: Promise.resolve<string | null>(null), kill() {}, exited: Promise.resolve() };
  return { ...real, spawnProbeCommand: () => inert, spawnWhich: () => inert, binaryProbe: new real.BinaryProbe(() => inert) };
});

const { FleetManager } = await import("../src/fleet-manager.js");
const { TmuxManager } = await import("../src/tmux-manager.js");
const { TmuxControlClient } = await import("../src/tmux-control.js");
const { ClassicChannelManager } = await import("../src/classic-channel-manager.js");
const { setUsageFetcherForTests } = await import("../src/usage/usage-api.js");
const { RestartProgress } = await import("../src/restart-progress.js");
const { beginUpdateProgress, setUpdateProgressStage, readUpdateProgress } = await import("../src/update-marker.js");
const { webUpdateTarget } = await import("../src/web-update.js");

const fleets: Array<{ fm: any; dir: string; boot: Promise<void> }> = [];
const savedWait = FleetManager.ADAPTER_STARTUP_WAIT_MS;
const savedSignals = new Map(["SIGUSR1", "SIGUSR2"].map(s => [s, process.listeners(s as NodeJS.Signals)] as const));
afterEach(async () => {
  for (const f of fleets.splice(0)) {
    await f.boot.catch(() => {});
    await f.fm.stopAll();
    f.fm.memoryPressure.stop(); f.fm.spawnGate.shutdown(); f.fm.stormWindow.shutdown();
    rmSync(f.dir, { recursive: true, force: true });
  }
  FleetManager.ADAPTER_STARTUP_WAIT_MS = savedWait;
  setUsageFetcherForTests(null);
  for (const [signal, previous] of savedSignals) {
    for (const l of process.listeners(signal as NodeJS.Signals)) if (!previous.includes(l)) process.removeListener(signal, l);
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  calls.notify.length = 0; calls.warns.length = 0;
  expect(calls.children.splice(0)).toEqual([]);
});

/** A fleet with a main Discord bot carrying a ClassicBot channel, plus a second bot. `main` is the main bot's login. */
function boot(main: () => Promise<void>, beforeStart: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "web-update-boot-2738-"));
  vi.stubEnv("AGEND_HOME", dir); vi.stubEnv("HOME", dir);
  vi.stubEnv("MAIN_TOKEN", "t1"); vi.stubEnv("SECOND_TOKEN", "t2");
  const general = join(dir, "workspaces/general"), worker = join(dir, "workspaces/worker");
  mkdirSync(general, { recursive: true }); mkdirSync(worker, { recursive: true });
  const config = join(dir, "fleet.yaml");
  writeFileSync(config, `defaults:
  locale: en
  startup:
    concurrency: 2
    stagger_delay_ms: 0
web:
  preview: false
channels:
  - id: main
    type: discord
    mode: topic
    bot_token_env: MAIN_TOKEN
    group_id: "111111111111111111"
  - id: second
    type: discord
    mode: topic
    bot_token_env: SECOND_TOKEN
    group_id: "111111111111111111"
instances:
  general:
    working_directory: ${general}
    general_topic: true
    channel_id: main
    topic_id: "222222222222222222"
  worker:
    working_directory: ${worker}
    topic_id: "333333333333333333"
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
  vi.spyOn(fm, "startSingleAdapter").mockImplementation(() => main());
  vi.spyOn(fm, "startAdditionalAdapter").mockResolvedValue(undefined);
  vi.spyOn(fm, "resolveKnowledgeWorkDir").mockImplementation((...args: unknown[]) => args[0]);
  vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
  vi.spyOn(fm, "startHealthServer").mockResolvedValue(undefined);
  vi.spyOn(fm.topicCommands, "autoCreateTopics").mockResolvedValue(undefined);
  vi.spyOn(fm.topicArchiver, "startPoller").mockImplementation(() => {});
  vi.spyOn(fm.lifecycle, "start").mockImplementation(async (...args: unknown[]) => {
    fm.daemons.set(args[0], { getProcessStatus: () => "running", getInteractionSnapshot: () => null });
  });
  vi.spyOn(fm.lifecycle, "stop").mockImplementation(async (...args: unknown[]) => { fm.daemons.delete(args[0]); });
  vi.spyOn(ClassicChannelManager.prototype, "getAll").mockReturnValue([
    { channelId: "444444444444444444", adapterId: "main", instanceName: "classic-room", channelName: "room" } as any,
  ]);
  const classicStarts: string[] = [];
  vi.spyOn(fm, "startClassicInstanceUnattended").mockImplementation(async (...args: unknown[]) => {
    classicStarts.push((args[0] as { instanceName: string }).instanceName); return true;
  });
  setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [] }));
  beforeStart(dir);
  const booted = fm.startAll(config) as Promise<void>;
  fleets.push({ fm, dir, boot: booted });
  return { fm, booted, classicStarts };
}

describe("M-2738: the boot after a web-started update", () => {
  it("adopts no chat message for a web target: a plain restart notice, the marker cleared", async () => {
    FleetManager.ADAPTER_STARTUP_WAIT_MS = 50;
    const resume = vi.spyOn(RestartProgress.prototype, "resume").mockResolvedValue(true as never);
    const start = vi.spyOn(RestartProgress.prototype, "start").mockResolvedValue(true as never);
    let dataDir = "";
    const { fm, booted } = boot(async () => {}, dir => {
      dataDir = dir; const at = Date.now();
      beginUpdateProgress(dir, webUpdateTarget(at), at);
      setUpdateProgressStage(dir, "stopping", { version: "2.3.5-beta.3" });
    });
    await booted;
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    expect(resume).not.toHaveBeenCalled();
    expect(fm.dataDir).toBe(dataDir);
    await vi.waitFor(() => expect(readUpdateProgress(dataDir)).toBeNull());
  });

  it("control: a chat /update's marker is resumed onto its own message", async () => {
    FleetManager.ADAPTER_STARTUP_WAIT_MS = 50;
    const resume = vi.spyOn(RestartProgress.prototype, "resume").mockResolvedValue(true as never);
    const start = vi.spyOn(RestartProgress.prototype, "start").mockResolvedValue(true as never);
    const { booted } = boot(async () => {}, dir => {
      beginUpdateProgress(dir, { adapterId: "main", chatId: "111111111111111111", threadId: "222222222222222222", messageId: "m-1" });
      setUpdateProgressStage(dir, "stopping", { version: "2.3.5-beta.3" });
    });
    await booted;
    await vi.waitFor(() => expect(resume).toHaveBeenCalled());
    expect(resume.mock.calls[0]![1]).toBe("m-1");
    expect(start).not.toHaveBeenCalled();
  });
});
