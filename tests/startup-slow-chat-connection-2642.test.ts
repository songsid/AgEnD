/**
 * #2642: fleet startup reaches the ClassicBot starts and READY even when the main chat connection's login never
 * settles (or fails); the connection is recorded when it does settle. Real boot ordering, every process/tmux/provider
 * boundary inert (the early-dashboard-2398 harness).
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
vi.mock("../src/sd-notify.js", () => ({ sdNotify: (s: string) => { calls.notify.push(s); }, sdNotifyBlocking: vi.fn(), setSdNotifyWarn: vi.fn() }));
vi.mock("../src/tmux-exec-helper.js", () => ({ tmuxExecHelper: { reopen() {}, start() {}, maintain() {}, async stop() {} } }));

const { FleetManager } = await import("../src/fleet-manager.js");
const { TmuxManager } = await import("../src/tmux-manager.js");
const { TmuxControlClient } = await import("../src/tmux-control.js");
const { ClassicChannelManager } = await import("../src/classic-channel-manager.js");
const { setUsageFetcherForTests } = await import("../src/usage/usage-api.js");

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
function boot(main: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "startup-slow-chat-2642-"));
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
    "refreshAllGuestRooms", "announceWebChatOnce", "startNeedsYou", "announceToolPermissionsChange", "sendFleetStartCompletionFallback",
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
  const booted = fm.startAll(config) as Promise<void>;
  fleets.push({ fm, dir, boot: booted });
  return { fm, booted, classicStarts };
}

describe("#2642 fleet startup with a slow main chat connection", () => {
  it("a main bot login that never settles: ClassicBot instances start and READY is sent after the bounded wait", async () => {
    FleetManager.ADAPTER_STARTUP_WAIT_MS = 50;
    const { fm, booted, classicStarts } = boot(() => new Promise<void>(() => {}));
    await booted;
    expect(classicStarts).toEqual(["classic-room"]);
    expect(calls.notify).toContain("READY=1");
    expect(fm.startupComplete).toBe(true);
    expect(calls.warns).toContain("Chat connection still connecting — fleet startup continues without waiting for it");
  });

  it("a login that settles after the wait is still recorded (connected)", async () => {
    FleetManager.ADAPTER_STARTUP_WAIT_MS = 20;
    let finish!: () => void;
    const { fm, booted } = boot(() => new Promise<void>(r => { finish = r; }));
    await booted;
    expect(fm.adapterState.get("main")).toBeUndefined();
    expect(fm.adapterState.get("second")).toMatchObject({ status: "connected" });
    finish();
    await vi.waitFor(() => expect(fm.adapterState.get("main")).toMatchObject({ status: "connected" }));
  });

  it("a late failure is recorded as retrying with its retry scheduled", async () => {
    FleetManager.ADAPTER_STARTUP_WAIT_MS = 20;
    let fail!: (e: Error) => void;
    const { fm, booted } = boot(() => new Promise<void>((_, reject) => { fail = reject; }));
    await booted;
    fail(new Error("gateway down"));
    await vi.waitFor(() => expect(fm.adapterState.get("main")).toMatchObject({ status: "retrying", lastError: "gateway down" }));
    expect(fm.scheduleAdapterRetry).toHaveBeenCalledWith("main");
  });

  it("a connection that comes up in time keeps the old order: no warning, classic start after it", async () => {
    const { booted, classicStarts } = boot(async () => {});
    await booted;
    expect(classicStarts).toEqual(["classic-room"]);
    expect(calls.warns).not.toContain("Chat connection still connecting — fleet startup continues without waiting for it");
  });
});
