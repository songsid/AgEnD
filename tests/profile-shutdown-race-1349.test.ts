import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

const native = vi.hoisted(() => ({ sessions: 0, post: vi.fn(), disconnect: vi.fn() }));
vi.mock("node:inspector", () => ({ Session: class {
  constructor() { native.sessions++; }
  connect() {} post = native.post; disconnect = native.disconnect;
} }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No processes"); }, execFile: () => { throw Error("No CLI"); },
  execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", () => ({ TmuxManager: new Proxy({}, { get: () => () => { throw Error("No live tmux"); } }) }));
vi.mock("../src/sd-notify.js", () => ({ sdNotify: vi.fn(), sdNotifyBlocking: vi.fn() }));
vi.mock("../src/fleet-lock.js", async original => ({ ...await original<typeof import("../src/fleet-lock.js")>(), releaseProcessFleetLock: vi.fn() }));
import { FleetManager } from "../src/fleet-manager.js";
import { RuntimeCpuProfiler } from "../src/runtime-cpu-profile.js";
import { startCpuProfileFromEnvironment } from "../src/cpu-profile.js";
import { setLocale, t } from "../src/locale.js";

/** Exact production CLI callback, never import/execute the self-starting CLI. */
function cli(manager: FleetManager) {
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const begin = source.indexOf("  .action(async (instance?: string) => {", source.indexOf('.description("Start fleet or specific instance")'));
  const end = source.indexOf('\n  });\n\nfleet\n  .command("stop")', begin);
  if (begin < 0 || end < 0) throw Error("CLI callback boundary changed");
  const callback = source.slice(begin + "  .action(".length, end) + "\n  }";
  const script = ts.transpileModule(`const action = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replaceAll('import("./fleet-manager.js")', "loadFleetManager()");
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const exited = deferred<number>();
  const process = { env: { AGEND_CPU_PROFILE_SECONDS: "60" }, getuid: () => 1000,
    on: (name: string, handler: (...args: unknown[]) => unknown) => events.set(name, handler),
    exit: vi.fn((code: number) => { exited.resolve(code); }) };
  const context = createContext({ process, console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    DATA_DIR: "/private-unused", FLEET_CONFIG_PATH: "/private-unused/fleet.yaml",
    claimFleetSingleton: () => true, describeSignalSource: () => "fake signal", Promise,
    loadFleetManager: async () => ({ FleetManager: class { constructor() { return manager; } } }),
  });
  runInContext(script, context);
  return { action: runInContext("action", context) as () => Promise<void>, events, process, exited };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const rigs: Array<{ directory: string; fm: FleetManager; owner: RuntimeCpuProfiler; saved: ReturnType<typeof deferred<string>>; savedPath: string }> = [];
function rig(platform: "telegram" | "discord") {
  const directory = mkdtempSync(join(tmpdir(), "agend-profile-shutdown-"));
  const fm = new FleetManager(directory), any = fm as any;
  const savedPath = join(directory, "fixture.cpuprofile");
  writeFileSync(savedPath, "{}");
  const saving = deferred<void>(), saved = deferred<string>();
  const save = vi.fn(() => { saving.resolve(); return saved.promise; });
  const start = vi.fn((options: Parameters<typeof startCpuProfileFromEnvironment>[0]) => startCpuProfileFromEnvironment({ ...options, save }));
  const owner = new RuntimeCpuProfiler({ dataDir: directory, logger: { info: vi.fn(), warn: vi.fn() }, start });
  any.runtimeCpuProfiler = owner;
  const control = { close: vi.fn(async () => {}) };
  any.cpuProfileControl = control;
  // Only lifecycle/transport startup is stubbed. The env owner, General
  // admission, stopAll/doStopAll and native CPU helper remain production code.
  vi.spyOn(fm, "startCpuProfileControl").mockResolvedValue();
  vi.spyOn(fm, "startAll").mockResolvedValue();
  vi.spyOn(fm, "startEnvironmentCpuProfile").mockImplementation(() => owner.startFromEnvironment({ AGEND_CPU_PROFILE_SECONDS: "60" }));
  any.shutdownLoginWindows = async () => {};
  const adapter = { id: "owner", type: platform, sendText: vi.fn(async (_chat: string, _text: string, _opts: unknown) => ({ messageId: "out", chatId: "G" })) };
  const config = { id: "owner", type: platform, group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin"] } };
  fm.fleetConfig = { defaults: {}, channel: config, channels: [config], instances: {
    general: { working_directory: directory, general_topic: true, topic_id: "T0", channel_id: "owner" },
  } } as never;
  fm.routing.rebuild(fm.fleetConfig!);
  any.adapter = adapter; any.adapters.set("owner", adapter);
  const worldStop = vi.fn(async () => {});
  any.worlds.set("owner", { adapter, groupId: "G", channelConfig: config, botUsername: "fleetbot", botUserId: "fleetbot-id",
    accessManager: { isAllowed: () => true }, stop: worldStop });
  any.classicChannels = { isClassicChannel: () => false, hasChannel: () => false };
  const respond = vi.fn(async (_text: string) => undefined);
  async function general() {
    if (platform === "discord") {
      await any.dispatchSlash({ command: "profile", guildId: "G", channelId: "T0", userId: "admin", username: "admin", options: {}, respond }, "owner", adapter);
    } else {
      const consumed = await any.topicCommands.handleGeneralCommand({ source: "telegram", chatId: "G", threadId: "T0", adapterId: "owner",
        text: "/profile", userId: "admin", username: "admin", messageId: "fixture", timestamp: new Date() });
      expect(consumed).toBe(true);
    }
  }
  const h = { directory, fm, any, owner, control, saving, saved, savedPath, save, start, adapter, worldStop, respond, general, cli: cli(fm) };
  rigs.push(h); return h;
}
beforeEach(() => {
  vi.useFakeTimers(); setLocale("en"); native.sessions = 0;
  native.post.mockReset().mockImplementation((method, _params, callback) => callback(null, method === "Profiler.stop" ? { profile: { nodes: [], startTime: 0, endTime: 1 } } : {}));
  native.disconnect.mockReset();
});
afterEach(async () => {
  for (const h of rigs.splice(0)) {
    h.saved.resolve(h.savedPath);
    await h.owner.shutdown();
    // A reverse mutant can replace the owner. Still drain only fake inspector
    // sessions/private artifacts rather than leaking its native timers.
    await (h.fm as any).runtimeCpuProfiler?.shutdown(); await h.fm.stopAll();
    rmSync(h.directory, { recursive: true, force: true });
  }
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe("CLI shutdown fences General before awaiting the env profile save", () => {
  for (const platform of ["telegram", "discord"] as const) {
    it.each(["SIGINT", "SIGTERM", "uncaughtException"])("%s immediately refuses a new %s General profile while save is held", async signal => {
      const h = rig(platform); await h.cli.action();
      expect(native.sessions).toBe(1); expect(h.start).toHaveBeenCalledTimes(1);
      h.cli.events.get(signal)!(new Error("fake crash"));
      // Snapshot before ANY await after the actual CLI callback, but exercise
      // the General handler before assertions so the broken path is not hidden.
      const fencedAtSignalReturn = h.any.shuttingDown;
      await h.saving.promise;
      expect(h.owner.closed).toBe(true); expect(h.cli.process.exit).not.toHaveBeenCalled();
      expect(h.control.close).not.toHaveBeenCalled(); expect(h.worldStop).not.toHaveBeenCalled();
      await h.general();
      const notice = platform === "discord" ? h.respond.mock.calls.at(-1)?.[0] : h.adapter.sendText.mock.calls.at(-1)?.[1];
      expect(notice).toBe(t("profile.unavailable"));
      expect(h.any.runtimeCpuProfiler).toBe(h.owner); expect(h.any.cpuProfileControl).toBe(h.control);
      expect(native.sessions).toBe(1); expect(h.start).toHaveBeenCalledTimes(1);
      expect(fencedAtSignalReturn).toBe(true);
      // Repeated signals still join one shutdown and one native stop/save.
      h.cli.events.get("SIGINT")!();
      expect(h.save).toHaveBeenCalledTimes(1);
      h.saved.resolve(h.savedPath);
      expect(await h.cli.exited.promise).toBe(signal === "uncaughtException" ? 1 : 0);
      expect(h.control.close).toHaveBeenCalledTimes(1); expect(h.worldStop).toHaveBeenCalledTimes(1);
      expect(h.any.cpuProfileControl).toBeNull(); expect(native.disconnect).toHaveBeenCalledTimes(1);
      expect(native.post.mock.calls.filter(([method]) => method === "Profiler.stop")).toHaveLength(1);
    });
  }
});
