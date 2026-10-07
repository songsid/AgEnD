import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import * as fsAsync from "node:fs/promises";
import { join, dirname } from "node:path";
const io = vi.hoisted(() => ({ execFile: vi.fn(), sync: vi.fn(() => { throw new Error("synchronous child forbidden"); }) }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFile: io.execFile,
  execFileSync: io.sync, execSync: io.sync, spawnSync: io.sync, spawn: io.sync, exec: io.sync, fork: io.sync }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));
const sessions: Array<any> = [];
vi.mock("../src/login-manager.js", async original => ({ ...await original<typeof import("../src/login-manager.js")>(),
  LoginSession: class { state = "starting"; constructor(_flow: unknown, _tmux: unknown, public events: any) { sessions.push(this); } async start() {} async cancel() {} },
}));
import { resolveBinaryAsync, checkBinaryInstalledAsync } from "../src/backend/binary-discovery.js";
import { createBackendAsync } from "../src/backend/factory.js";
import { KiroBackend, probeKiroCliCompatibilityAsync, resetKiroCompatibilityCacheForTests } from "../src/backend/kiro.js";
import { InstanceLifecycle, SupersededStartError } from "../src/instance-lifecycle.js";
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { IpcServer } from "../src/channel/ipc-bridge.js";
let dir: string;
let binary: string;
const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
const help = readFileSync(new URL("./fixtures/kiro-help/chat-help-2.27.0.txt", import.meta.url), "utf8");
function respond(output: string, error?: Error) { return (_exe: string, _args: string[], _opts: unknown, cb: Function) => { queueMicrotask(() => cb(error ?? null, output, "")); }; }
function executable(path: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "not executed"); chmodSync(path, 0o755); return path; }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agend-1235-")); binary = executable(join(dir, "kiro-cli"));
  vi.stubEnv("AGEND_HOME", join(dir, "data")); vi.stubEnv("CODEX_HOME", join(dir, "codex")); vi.stubEnv("HOME", dir);
  sessions.length = 0; io.execFile.mockReset(); io.sync.mockClear(); resetKiroCompatibilityCacheForTests();
  vi.spyOn(TmuxManager, "ensureSession").mockImplementation(io.sync);
  vi.spyOn(IpcServer.prototype, "listen").mockImplementation(io.sync);
  vi.spyOn(Daemon.prototype, "start").mockImplementation(io.sync);
});
afterEach(() => {
  const calls = io.sync.mock.calls.length; vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true });
  expect(calls, "no real or synchronous process/tmux/IPC launch").toBe(0);
});
describe("async fleet binary/launch discovery", () => {
  it("uses bounded argv-only which and ordered executable fallback, never Sync", async () => {
    io.execFile.mockImplementation(respond("/private/bin/kiro-cli\n"));
    expect(await resolveBinaryAsync("kiro-cli")).toBe("/private/bin/kiro-cli");
    expect(io.execFile).toHaveBeenCalledWith("which", ["kiro-cli"], expect.objectContaining({ timeout: 2000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }), expect.any(Function));
    io.execFile.mockImplementation(respond("", new Error("missing")));
    const first = join(dir, "first"); const second = join(dir, "second"); executable(join(first, "grok")); executable(join(second, "grok"));
    expect(await resolveBinaryAsync("grok", [first, second])).toBe(join(first, "grok"));
    chmodSync(join(first, "grok"), 0o644); expect(await resolveBinaryAsync("grok", [first, second])).toBe(join(second, "grok"));
    expect(await checkBinaryInstalledAsync("missing")).toBe(false);
    expect(await resolveBinaryAsync("missing", [first])).toBe("missing");
  });
  it("keeps common directory order ahead of custom npm prefix", async () => {
    const prefix = join(dir, "prefix"); executable(join(prefix, "bin", "grok"));
    const local = executable(join(dir, ".local", "bin", "grok"));
    io.execFile.mockImplementation((exe, args, opts, cb) => respond(exe === "npm" ? `${prefix}\n` : "", exe === "which" ? new Error("missing") : undefined)(exe, args, opts, cb));
    expect(await resolveBinaryAsync("grok")).toBe(local);
    expect(io.execFile).toHaveBeenCalledWith("npm", ["prefix", "-g"], expect.objectContaining({ timeout: 3000 }), expect.any(Function));
    rmSync(local); expect(await resolveBinaryAsync("grok")).toBe(join(prefix, "bin", "grok"));
  });
  it.each(["claude-code", "codex", "opencode", "kiro-cli", "antigravity", "grok", "muse"])("the %s fleet constructor never discovers synchronously", async backend => {
    io.execFile.mockImplementation(respond(binary));
    expect((await createBackendAsync(backend, join(dir, "instance"))).binaryName).toBe(({ "claude-code": "claude", antigravity: "agy" } as Record<string,string>)[backend] ?? backend);
    expect(io.execFile).toHaveBeenCalledTimes(1);
  });
  it("Kiro prepareLaunch probes once per binary generation, shares flights and keeps engine flags", async () => {
    io.execFile.mockImplementation((exe, args, opts, cb) => respond(exe === "which" ? binary : args[0] === "--version" ? "kiro-cli 2.27.1\n" : help)(exe, args, opts, cb));
    const a = await createBackendAsync("kiro-cli", join(dir, "a")); const b = await createBackendAsync("kiro-cli", join(dir, "b"));
    await Promise.all([a.prepareLaunch!(), b.prepareLaunch!()]);
    expect(io.execFile.mock.calls.filter(c => c[1][0] === "--version")).toHaveLength(1);
    const config: any = { workingDirectory: dir, instanceDir: dir, instanceName: "a", mcpServers: {}, kiroUi: "tui", backendOptions: {} };
    expect(a.buildCommand(config)).toContain("--agent-engine=v2"); expect(a.replyCompletionGuard).toBe(true);
    expect(b.buildCommand({ ...config, kiroUi: "legacy" })).toContain("--agent-engine=v1");
    await a.prepareLaunch!(); expect(io.execFile.mock.calls.filter(c => c[1][0] === "--version")).toHaveLength(1);
    writeFileSync(binary, "changed binary generation"); await a.prepareLaunch!();
    expect(io.execFile.mock.calls.filter(c => c[1][0] === "--version")).toHaveLength(2);
  });
  it("joins an in-flight Kiro probe before either caller can populate the cache", async () => {
    const stats = vi.spyOn(fsAsync, "stat").mockResolvedValue({ dev: 1, ino: 2, size: 3, mtimeMs: 4 } as any);
    const replies: Function[] = [];
    io.execFile.mockImplementation((_exe, _args, _opts, cb) => { replies.push(cb); });
    const a = new KiroBackend(dir, undefined, binary); const b = new KiroBackend(dir, undefined, binary);
    const flights = [a.prepareLaunch(), b.prepareLaunch()];
    try {
      // Both stat awaits are already resolved; drain their continuations while
      // the version callback stays pending, so a warm cache cannot hide duplication.
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(stats).toHaveBeenCalledTimes(2);
      expect(io.execFile).toHaveBeenCalledTimes(1);
    } finally {
      for (const reply of replies) reply(null, "kiro-cli 2.26.0", "");
      await Promise.all(flights);
    }
  });
  it.each(["legacy", "tui", "v3"])("unknown/missing Kiro compatibility still refuses %s launch, no blind engine default", async kiroUi => {
    io.execFile.mockImplementation(respond("", new Error("timeout")));
    const backend = new KiroBackend(dir, undefined, binary); await backend.prepareLaunch();
    expect(() => backend.buildCommand({ kiroUi, instanceName: "a", instanceDir: dir, workingDirectory: dir, skipResume: true } as any)).toThrow(/not launching/);
    expect(backend.replyCompletionGuard).toBe(false);
    expect(io.execFile).toHaveBeenCalledTimes(2);
    expect(io.execFile.mock.calls.every(c => c[2].timeout === 5000)).toBe(true);
  });
  it("uses the old version table without a help subprocess and preserves newer help policy", async () => {
    io.execFile.mockImplementation(respond("kiro-cli 2.26.0\n"));
    expect((await probeKiroCliCompatibilityAsync(binary)).source).toBe("version"); expect(io.execFile).toHaveBeenCalledTimes(1);
  });
  it("real lifecycle drops a discovery result after stop/restart invalidates ownership, before construction", async () => {
    let release!: Function;
    io.execFile.mockImplementationOnce((_exe, _args, _opts, cb) => { release = cb; }).mockImplementation(respond(binary));
    const config: any = { backend: "kiro-cli", working_directory: dir, workflow: false };
    const lc = new InstanceLifecycle({ dataDir: dir, logger, controlClient: null, fleetConfig: { defaults: {}, instances: { a: config } },
      getInstanceDir: () => join(dir, "instance"), instanceIpcClients: new Map(), ipcStoppingInstances: new Set(), sessionRegistry: new Map(), eventLog: null } as any);
    const starting = lc.start("a", config, false); const outcome = starting.catch(e => e);
    await vi.waitFor(() => expect(io.execFile).toHaveBeenCalledOnce()); lc.invalidate("a"); release(null, binary, "");
    expect(await outcome).toBeInstanceOf(SupersededStartError); expect(lc.daemons.size).toBe(0); expect(Daemon.prototype.start).not.toHaveBeenCalled();
    expect(io.execFile).toHaveBeenCalledTimes(1);
  });
  it("checks a fence after binary resolution and before any backend constructor", async () => {
    let release!: Function; io.execFile.mockImplementation((_exe, _args, _opts, cb) => { release = cb; });
    const rejected = createBackendAsync("kiro-cli", dir, () => { throw new Error("superseded"); });
    const outcome = rejected.catch(e => e); await vi.waitFor(() => expect(io.execFile).toHaveBeenCalledOnce()); release(null, binary, "");
    expect((await outcome).message).toBe("superseded"); expect(io.execFile).toHaveBeenCalledTimes(1);
  });
  it("real install lookup stays asynchronous and validates the executable result", async () => {
    const fm = new FleetManager(join(dir, "fleet"));
    io.execFile.mockImplementation(respond(binary));
    expect(await (fm as any).locateBinaryOnLoginShell("kiro-cli")).toBe(binary);
    expect(io.execFile).toHaveBeenCalledWith("bash", ["-lc", "command -v kiro-cli"], expect.objectContaining({ timeout: 10_000 }), expect.any(Function));
    io.execFile.mockImplementation(respond("alias kiro-cli='echo nope'")); expect(await (fm as any).locateBinaryOnLoginShell("kiro-cli")).toBeNull();
    chmodSync(binary, 0o644); io.execFile.mockImplementation(respond(binary)); expect(await (fm as any).locateBinaryOnLoginShell("kiro-cli")).toBeNull();
  });
  it("unknown compatibility retries after its monotonic TTL, not a wall-clock change", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    io.execFile.mockImplementation(respond("", new Error("timeout")));
    const backend = new KiroBackend(dir, undefined, binary);
    await backend.prepareLaunch(); expect(io.execFile).toHaveBeenCalledTimes(2);
    vi.spyOn(Date, "now").mockReturnValue(9e15); await backend.prepareLaunch(); expect(io.execFile).toHaveBeenCalledTimes(2);
    now = 60_000; io.execFile.mockImplementation(respond("kiro-cli 2.26.0")); await backend.prepareLaunch();
    expect(io.execFile).toHaveBeenCalledTimes(3);
    expect(backend.buildCommand({ kiroUi: "legacy", instanceName: "a", instanceDir: dir, workingDirectory: dir, skipResume: true } as any)).toContain("--agent-engine=v1");
  });
  it.each(["stop", "restart", "replacement", "respawn", "pause", "shutdown"])("real fleet statusline fence discards a pending read after %s without relying on re-registration", async action => {
    vi.useFakeTimers(); const fm: any = new FleetManager(join(dir, "fleet")); let release!: (value: string) => void;
    const owner = { bootId: "boot", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 0 };
    const daemon: any = { isPaused: false, getInteractionSnapshot: () => ({ owner }) };
    fm.daemons.set("a", daemon);
    vi.spyOn(fsAsync, "readFile").mockImplementation(() => new Promise<string>(resolve => { release = resolve; }) as any);
    const failover = vi.spyOn(fm, "checkModelFailover").mockImplementation(io.sync);
    const notice = vi.spyOn(fm, "notifyInstanceTopic").mockImplementation(io.sync);
    const updateCost = vi.fn(); fm.costGuard = { updateCost };
    try {
      fm.startStatuslineWatcher("a"); await vi.advanceTimersByTimeAsync(10_000);
      expect(release).toBeTypeOf("function");
      if (action === "stop" || action === "restart") fm.lifecycle.invalidate("a");
      else if (action === "replacement") fm.daemons.set("a", { ...daemon, getInteractionSnapshot: () => ({ owner: { ...owner, bootId: "new-boot" } }) });
      else if (action === "respawn") owner.launchFenceEpoch++;
      else if (action === "pause") daemon.isPaused = true;
      else fm.shuttingDown = true;
      release(JSON.stringify({ cost: { total_cost_usd: 999 }, rate_limits: { five_hour: { used_percentage: 100 }, seven_day: { used_percentage: 0 } } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(fm.statuslineWatcher.getRateLimits("a")).toBeUndefined(); expect(updateCost).not.toHaveBeenCalled();
      expect(failover).not.toHaveBeenCalled(); expect(notice).not.toHaveBeenCalled();
    } finally { fm.statuslineWatcher.stopAll(); vi.useRealTimers(); }
  });
  it("real Daemon launch fence drops an async Kiro probe after stop", async () => {
    let release!: Function;
    io.execFile.mockImplementation((_exe, _args, _opts, cb) => { release = cb; });
    const backend = new KiroBackend(dir, undefined, binary);
    const write = vi.spyOn(backend, "writeConfig").mockImplementation(io.sync);
    const build = vi.spyOn(backend, "buildCommand");
    const daemon: any = new Daemon("a", { working_directory: dir, backend: "kiro-cli", log_level: "silent", workflow: false,
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600000, max_age_hours: 0 } } as any,
      join(dir, "instance"), false, backend, undefined, logger);
    const outcome = daemon.trySpawnInsideGate().catch((e: Error) => e);
    await vi.waitFor(() => expect(io.execFile).toHaveBeenCalledOnce());
    await daemon.stop(); release(null, "kiro-cli 2.26.0", "");
    expect((await outcome).message).toMatch(/Launch cancelled/);
    expect(write).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled(); expect(TmuxManager.ensureSession).not.toHaveBeenCalled();
  });
  it.each(["cancel", "shutdown"])("install verification cannot adopt PATH or sign in after %s", async action => {
    vi.mocked(TmuxManager.ensureSession).mockResolvedValue(undefined);
    io.execFile.mockImplementation(respond("", new Error("not installed")));
    const fm: any = new FleetManager(join(dir, "fleet"));
    const chat = { adapter: { sendText: vi.fn().mockResolvedValue({ messageId: "m" }) }, adapterId: "tg", chatId: "chat" };
    const signIn = vi.spyOn(fm, "launchSignIn").mockResolvedValue("signing in");
    const adopt = vi.spyOn(fm, "adoptBinaryDirectory");
    await fm.startInstallSession("grok", chat);
    let release!: Function; io.execFile.mockImplementation((_exe, _args, _opts, cb) => { release = cb; });
    const done = sessions[0]!.events.onDone({ ok: true, detail: "clean exit" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    if (action === "cancel") await fm.cancelLoginSession(); else await fm.shutdownLoginWindows();
    release(null, binary, ""); await done;
    expect(adopt).not.toHaveBeenCalled(); expect(signIn).not.toHaveBeenCalled(); expect(chat.adapter.sendText).not.toHaveBeenCalled();
    expect(fm.installHandoff).toBeNull();
  });
  it("a slow install-cleanup notice does not hold the claim or outlive shutdown into PATH adoption", async () => {
    vi.mocked(TmuxManager.ensureSession).mockResolvedValue(undefined);
    io.execFile.mockImplementation(respond("", new Error("not installed")));
    const fm: any = new FleetManager(join(dir, "fleet")); let finishNotice!: Function;
    const chat = { adapter: { sendText: vi.fn(() => new Promise(resolve => { finishNotice = resolve; })) }, adapterId: "tg", chatId: "chat" };
    const signIn = vi.spyOn(fm, "launchSignIn").mockResolvedValue("signing in"); const adopt = vi.spyOn(fm, "adoptBinaryDirectory");
    await fm.startInstallSession("grok", chat); io.execFile.mockImplementation(respond(binary));
    const done = sessions[0]!.events.onDone({ ok: true, detail: "clean exit", cleanupFailed: true });
    await vi.waitFor(() => expect(chat.adapter.sendText).toHaveBeenCalledOnce());
    const otherClaim = fm.loginWindow.tryClaim("login", "kiro-cli"); expect(otherClaim).not.toBeNull(); fm.loginWindow.release(otherClaim);
    await fm.shutdownLoginWindows(); finishNotice({ messageId: "m" }); await done;
    expect(adopt).not.toHaveBeenCalled(); expect(signIn).not.toHaveBeenCalled(); expect(fm.installHandoff).toBeNull();
  });

});
