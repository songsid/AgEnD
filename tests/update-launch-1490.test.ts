import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundaries = vi.hoisted(() => ({ commands: [] as any[], reads: [] as any[], version: "systemd 255\n", cgroup: "0::/\n", fail: false }));
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, readFile: ((path: unknown, options: unknown) => {
    if (path !== "/proc/self/cgroup") return (real.readFile as any)(path, options);
    boundaries.reads.push({ path, options }); return boundaries.fail ? Promise.reject(Error("EACCES")) : Promise.resolve(boundaries.cgroup);
  }) as typeof real.readFile };
});
const effects = vi.hoisted(() => [] as Array<{ command: string; args: string[]; options: any; child: EventEmitter }>);
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const execFile = Object.assign(vi.fn(() => { throw Error("unexpected callback command"); }), {
    [Symbol.for("nodejs.util.promisify.custom")]: async (command: string, args: string[], options: unknown) => {
      if (command !== "systemd-run" || args.join(" ") !== "--version") throw Error("unexpected command");
      boundaries.commands.push({ command, args, options });
      if (boundaries.fail) throw Error("version unavailable");
      return { stdout: boundaries.version, stderr: "" };
    },
  });
  return { ...real, spawn: vi.fn((command: string, args: string[], options: unknown) => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    effects.push({ command, args, options, child }); return child;
  }), execFile };
});
vi.mock("../src/update-dispatch.js", async original => {
  const real = await original<typeof import("../src/update-dispatch.js")>();
  return { ...real, resolveInstalledAgend: vi.fn(async () => ({ ok: true, agend: "/test prefix/$HOME/agend", version: "2.2.0" })) };
});
// Shutdown notifications stay inert even if the test runner inherited a service environment.
vi.mock("../src/sd-notify.js", () => ({ sdNotify: vi.fn(), sdNotifyBlocking: vi.fn() }));
import { FleetManager } from "../src/fleet-manager.js";
import { TopicCommands } from "../src/topic-commands.js";
import { defaultUpdateLaunchDeps, inServiceCgroup, resolveUpdateLaunch, watchUpdateLaunch, type UpdateLaunchDeps } from "../src/update-launch.js";
import { DELAYED_UPDATE_SCRIPT } from "../src/update-dispatch.js";

const nativeNonce = defaultUpdateLaunchDeps.nonce;
const nativeCgroup = defaultUpdateLaunchDeps.cgroup;
const nativeVersion = defaultUpdateLaunchDeps.version;
const CGROUP = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/com.agend.fleet.service\n";
const ID = "0123456789abcdef0123456789abcdef";
const agend = "/test prefix/$HOME/agend";
const deps = (extra: Partial<UpdateLaunchDeps> = {}): UpdateLaunchDeps => ({ platform: "linux", cgroup: async () => CGROUP,
  version: async () => "systemd 255 (255.4-1ubuntu8)\n+PAM", nonce: () => ID, ...extra });

describe("independent chat updater plan", () => {
  it.each([CGROUP, "1:name=systemd:/system.slice/com.agend.fleet.service\n2:cpu:/\n", "0::/fleet.service/nested\n"])("service containment requires a scope: %s", async cgroup => {
    const plan = await resolveUpdateLaunch(agend, deps({ cgroup: async () => cgroup }));
    expect(plan).toEqual({ ok: true, command: "systemd-run", scope: `agend-updater-${ID}.scope`, args: [
      "--user", "--scope", "--quiet", "--collect", "--no-ask-password", `--unit=agend-updater-${ID}.scope`,
      "--expand-environment=no", "--", "sh", "-c", DELAYED_UPDATE_SCRIPT, "sh", agend,
    ] });
    expect(plan).not.toHaveProperty("env");
  });
  it.each(["0::/\n", "0::/user.slice/user-1000.slice/session-1.scope\n", "0::/user.slice/user-1000.slice/user@1000.service/app.slice/terminal.scope\n"])("proven detached owner keeps positional shell argv: %s", async cgroup => {
    const version = vi.fn();
    expect(await resolveUpdateLaunch(agend, deps({ cgroup: async () => cgroup, version }))).toEqual({ ok: true, command: "sh", args: ["-c", DELAYED_UPDATE_SCRIPT, "sh", agend] });
    expect(version).not.toHaveBeenCalled();
  });
  it.each(["darwin", "freebsd"])("non-Linux behavior is unchanged: %s", async platform => {
    const cgroup = vi.fn();
    expect((await resolveUpdateLaunch(agend, deps({ platform, cgroup }))).ok).toBe(true);
    expect(cgroup).not.toHaveBeenCalled();
  });
  it.each(["", "garbage", "0::relative", "0::/bad\0path", "0::/../fleet.service", "x".repeat(65537)])("unknown cgroup refuses: %s", async cgroup => {
    expect(inServiceCgroup(cgroup)).toBeNull();
    expect((await resolveUpdateLaunch(agend, deps({ cgroup: async () => cgroup }))).ok).toBe(false);
  });
  it("unreadable cgroup and changed publication refuse", async () => {
    expect((await resolveUpdateLaunch(agend, deps({ cgroup: async () => { throw Error("EACCES"); } }))).ok).toBe(false);
    const cgroup = vi.fn().mockResolvedValueOnce(CGROUP).mockResolvedValueOnce("0::/another.service\n");
    expect((await resolveUpdateLaunch(agend, deps({ cgroup }))).ok).toBe(false);
  });
  it.each([null, "not-systemd 255", "systemd 239"])("unverified scope capability refuses: %s", async version => {
    expect((await resolveUpdateLaunch(agend, deps({ version: async () => version }))).ok).toBe(false);
  });
  it.each([240, 249, 252, 253])("old systemd %i retains literal scope argv without unsupported flag", async version => {
    const plan = await resolveUpdateLaunch(agend, deps({ version: async () => `systemd ${version}\n` }));
    expect(plan.ok).toBe(true);
    if (plan.ok) { expect(plan.args).not.toContain("--expand-environment=no"); expect(plan.args.slice(-5)).toEqual(["sh", "-c", DELAYED_UPDATE_SCRIPT, "sh", agend]); }
  });
  it("scope ids are fresh and restricted", async () => {
    const a = await resolveUpdateLaunch(agend, deps({ nonce: nativeNonce }));
    const b = await resolveUpdateLaunch(agend, deps({ nonce: nativeNonce }));
    expect(a.ok && b.ok && a.scope !== b.scope).toBe(true);
    expect((await resolveUpdateLaunch(agend, deps({ nonce: () => "../fleet.service" }))).ok).toBe(false);
  });
  it.each([0, 75])("successful/pending exit %i adds no failure", code => {
    const child = new EventEmitter(), fail = vi.fn(); watchUpdateLaunch(child as any, fail);
    child.emit("exit", code, null); expect(fail).not.toHaveBeenCalled();
  });
  it.each(["error", "exit", "signal"])("launcher refusal %s is visible once without fallback", event => {
    const child = new EventEmitter(), fail = vi.fn(); watchUpdateLaunch(child as any, fail);
    if (event === "error") child.emit("error", Error("private manager detail"));
    else child.emit("exit", event === "exit" ? 1 : null, event === "signal" ? "SIGTERM" : null);
    child.emit("exit", 1, null); expect(fail).toHaveBeenCalledOnce();
    expect(fail.mock.calls[0][0]).toContain("host shell"); expect(fail.mock.calls[0][0]).not.toContain("private manager detail");
  });
});

const dirs: string[] = [], managers: FleetManager[] = [];
const scratch = () => { const p = mkdtempSync(join(tmpdir(), "agend-update-scope-")); dirs.push(p); return p; };
beforeEach(() => {
  effects.length = 0; boundaries.commands = []; boundaries.reads = []; boundaries.fail = false;
  vi.spyOn(defaultUpdateLaunchDeps, "cgroup").mockResolvedValue(CGROUP);
  vi.spyOn(defaultUpdateLaunchDeps, "version").mockResolvedValue("systemd 255\n");
  vi.spyOn(defaultUpdateLaunchDeps, "nonce").mockReturnValue(ID);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const fm of managers.splice(0)) { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); }
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true });
});

async function handler(platform: "discord" | "telegram", admin = () => true) {
  const failed = vi.fn();
  if (platform === "discord") {
    const fm = new FleetManager(scratch()); managers.push(fm);
    Object.assign(fm, { fleetAdminGate: () => admin() ? "ok" : "denied", failUpdateProgress: failed });
    await (fm as any).handleUpdateSlash({ channelId: "general", userId: "admin", respond: vi.fn().mockResolvedValue(undefined) }, "discord-main");
  } else {
    const adapter = { id: "telegram-main", type: "telegram", sendText: vi.fn().mockResolvedValue({ messageId: "m" }) };
    const commands = new TopicCommands({ adapter, adapters: new Map([[adapter.id, adapter]]), dataDir: scratch(),
      hasFleetAdmins: () => true, isFleetAdmin: admin, isFleetStopping: () => false, failUpdateProgress: failed, fleetConfig: { channel: {} } } as any);
    await (commands as any).handleUpdateCommand({ chatId: "group", threadId: "1", userId: "admin", adapterId: adapter.id });
  }
  return failed;
}

describe.each(["discord", "telegram"] as const)("real %s update entry", platform => {
  it("uses the independent scope, literal verified path, inherited env and detached handles", async () => {
    await handler(platform);
    expect(effects).toHaveLength(1);
    expect(effects[0].command).toBe("systemd-run");
    expect(effects[0].args).toContain("--scope"); expect(effects[0].args).toContain("--user");
    expect(effects[0].args.slice(-5)).toEqual(["sh", "-c", DELAYED_UPDATE_SCRIPT, "sh", agend]);
    expect(effects[0].options.detached).toBe(true); expect(effects[0].options.stdio).toBe("ignore");
    expect(effects[0].options.env.PATH).toBe(process.env.PATH);
    expect(effects[0].options).not.toHaveProperty("cwd");
    expect((effects[0].child as any).unref).toHaveBeenCalledOnce();
  });
  it("unknown cgroup does not dispatch", async () => {
    vi.mocked(defaultUpdateLaunchDeps.cgroup).mockRejectedValue(Error("EACCES"));
    const failed = await handler(platform); expect(effects).toHaveLength(0); expect(failed).toHaveBeenCalledOnce();
  });
  it("scope refusal cannot fall back to the fleet cgroup", async () => {
    const failed = await handler(platform); effects[0].child.emit("exit", 1, null);
    expect(failed).toHaveBeenCalledOnce(); expect(effects).toHaveLength(1);
    expect(failed.mock.calls[0][0]).toContain("host shell");
  });
  it("revoked admin during the async plan cannot launch", async () => {
    let allowed = true; vi.mocked(defaultUpdateLaunchDeps.version).mockImplementation(async () => { allowed = false; return "systemd 255\n"; });
    const failed = await handler(platform, () => allowed); expect(effects).toHaveLength(0); expect(failed).toHaveBeenCalledOnce();
  });
  it("a non-admin never reaches any scope preparation", async () => {
    await handler(platform, () => false); expect(effects).toHaveLength(0); expect(defaultUpdateLaunchDeps.cgroup).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

/** Actual FleetManager context, handlers and admin gate; no fleet or adapter is started. */
function fleetHandler(platform: "discord" | "telegram") {
  const fm = new FleetManager(scratch()); managers.push(fm);
  const adapter = { id: `${platform}-main`, type: platform, sendText: vi.fn().mockResolvedValue({ messageId: "m" }) };
  const config = { channel: { id: adapter.id, type: platform, group_id: "group", access: { allowed_users: ["admin"] } }, instances: {} };
  const failed = vi.fn();
  Object.assign(fm, { adapter, fleetConfig: config, beginUpdateProgress: vi.fn(), failUpdateProgress: failed });
  fm.adapters.set(adapter.id, adapter as any);
  // There are no login windows/listeners in this fixture. Keep those native teardown boundaries inert too.
  vi.spyOn(fm as any, "shutdownLoginWindows").mockResolvedValue(undefined);
  vi.spyOn(fm as any, "stopPreviewListener").mockReturnValue(undefined);
  const run = () => platform === "discord"
    ? (fm as any).handleUpdateSlash({ channelId: "general", userId: "admin", respond: vi.fn().mockResolvedValue("m") }, adapter.id)
    : (fm as any).topicCommands.handleUpdateCommand({ chatId: "group", threadId: "1", userId: "admin", adapterId: adapter.id });
  return { fm, config, adapter, failed, run };
}

describe.each(["discord", "telegram"] as const)("%s update with the actual fleet context", platform => {
  it("shutdown during the planner await prevents the independent updater from escaping", async () => {
    const h = fleetHandler(platform), entered = deferred<void>(), version = deferred<string>(), saved = deferred<void>();
    const shutdown = vi.fn(() => saved.promise);
    Object.assign(h.fm, { runtimeCpuProfiler: { shutdown } });
    vi.mocked(defaultUpdateLaunchDeps.version).mockImplementation(() => { entered.resolve(); return version.promise; });
    const request = h.run();
    let stopped: Promise<void> | undefined;
    try {
      await entered.promise;
      stopped = h.fm.stopAll(); // The real synchronous shutdown fence, with the save await held.
      expect(shutdown).toHaveBeenCalledOnce();
      expect(h.fm.isPlannedRestart()).toBe(true);
      expect(h.fm.isFleetAdmin("admin", h.adapter.id)).toBe(true);
      version.resolve("systemd 255\n");
      await request;
      expect(effects).toHaveLength(0);
      expect(h.failed).toHaveBeenCalledOnce();
    } finally {
      version.resolve("systemd 255\n"); saved.resolve();
      await request; await stopped;
    }
  });
  it("an admitted live fleet still launches once", async () => {
    const h = fleetHandler(platform);
    expect(h.fm.isFleetStopping()).toBe(false);
    await h.run();
    expect(effects).toHaveLength(1); expect(effects[0].command).toBe("systemd-run");
    expect(h.failed).not.toHaveBeenCalled();
  });
  it("authority revoked during the planner await still refuses", async () => {
    const h = fleetHandler(platform), entered = deferred<void>(), version = deferred<string>();
    vi.mocked(defaultUpdateLaunchDeps.version).mockImplementation(() => { entered.resolve(); return version.promise; });
    const request = h.run();
    try {
      await entered.promise;
      h.config.channel.access.allowed_users = [];
      version.resolve("systemd 255\n"); await request;
      expect(effects).toHaveLength(0); expect(h.failed).toHaveBeenCalledOnce();
    } finally { version.resolve("systemd 255\n"); await request; }
  });
});


describe("bounded native seams (inert FS/exec)", () => {
  it("reads only proc asynchronously with an abort budget", async () => {
    expect(await nativeCgroup()).toBe("0::/\n");
    expect(boundaries.reads).toHaveLength(1);
    expect(boundaries.reads[0].options.encoding).toBe("utf8");
    expect(boundaries.reads[0].options.signal).toBeInstanceOf(AbortSignal);
  });
  it("uses a bounded version probe and preserves unknown", async () => {
    expect(await nativeVersion()).toBe("systemd 255\n");
    expect(boundaries.commands).toEqual([{ command: "systemd-run", args: ["--version"], options: { encoding: "utf8", timeout: 2000, maxBuffer: 65536 } }]);
    boundaries.fail = true; expect(await nativeVersion()).toBeNull();
  });
  it("late cgroup receipt is rejected even before a delayed timer fires", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(2000);
    const outcome = await nativeCgroup().then(() => ({ accepted: true, reason: "" }),
      error => ({ accepted: false, reason: error.message }));
    expect(outcome).toEqual({ accepted: false, reason: "cgroup read deadline" });
  });
  it("late version receipt is unknown", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(2000);
    expect(await nativeVersion()).toBeNull();
  });
  it("the real manager rehearsal has only an explicit Linux dispatch trigger", async () => {
    const { load } = await import("js-yaml");
    const config = load(readFileSync(new URL("../.github/workflows/updater-cgroup-rehearsal.yml", import.meta.url), "utf8")) as any;
    expect(Object.keys(config.on)).toEqual(["workflow_dispatch"]);
    expect(config.jobs.probe["runs-on"]).toBe("ubuntu-latest");
    expect(config.jobs.probe.steps.find((step: any) => step.env?.AGEND_DISPOSABLE_CGROUP_PROBE).run).toContain("node scripts/ci/cgroup-updater-1490.mjs");
  });
});
