import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ root: "", journal: "", failure: false, hold: false, release: null as null | (() => void), reads: 0, procError: "",
  forbidden: vi.fn(() => { throw new Error("Forbidden host effect"); }) }));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readlink: async (path: any) => String(path).startsWith("/proc/") ? readFileSync(io.root + String(path).slice(5), "utf8") : fs.readlink(path), readFile: async (path: any, ...args: any[]) => {
    if (String(path).startsWith("/proc/") && io.procError && String(path).endsWith("/stat")) throw Object.assign(new Error("unreadable procfs"), { code: io.procError });
    if (String(path).startsWith("/proc/")) return readFileSync(io.root + String(path).slice(5), "utf8");
    return (fs.readFile as any)(path, ...args);
  } };
});
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  exec: io.forbidden, execSync: io.forbidden, execFileSync: io.forbidden, spawn: io.forbidden, spawnSync: io.forbidden, fork: io.forbidden,
  execFile: (file: string, args: string[], opts: any, callback: any) => {
    if (file !== "journalctl") return io.forbidden();
    io.reads++;
    expect(args).toContain("--boot=0");
    expect(opts).toMatchObject({ timeout: 1000, maxBuffer: 262144, killSignal: "SIGKILL" });
    const done = () => callback(io.failure ? new Error("journal unavailable") : null, io.journal, "");
    if (io.hold) io.release = done; else queueMicrotask(done);
    return new EventEmitter();
  },
}));
import { observeCliOomIdentity, confirmedCliOom, parseKernelOoms, consecutiveSessionOoms } from "../src/session-oom.js";
import { Daemon } from "../src/daemon.js";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { IpcServer } from "../src/channel/ipc-bridge.js";

let dir: string;
function proc(pid: number, comm: string, children = "", start = "123", parent = pid === 100 ? 1 : 100, executable = comm) {
  const d = join(io.root, String(pid));
  mkdirSync(join(d, "task", String(pid)), { recursive: true });
  mkdirSync(join(d, "ns"), { recursive: true });
  writeFileSync(join(d, "ns/pid"), "pid:[4026531836]");
  writeFileSync(join(d, "comm"), comm);
  writeFileSync(join(d, "exe"), `/usr/bin/${executable}`);
  const fields = Array.from({ length: 20 }, (_, i) => i === 0 ? "S" : i === 1 ? String(parent) : i === 19 ? start : "0");
  writeFileSync(join(d, "stat"), `${pid} (${comm}) ${fields.join(" ")}`);
  writeFileSync(join(d, "status"), `NSpid:\t${pid}\n`);
  writeFileSync(join(d, "task", String(pid), "children"), children);
}
function record(pid: number, comm = "claude", at = Date.now(), message?: string) {
  return JSON.stringify({ _TRANSPORT: "kernel", __REALTIME_TIMESTAMP: String(at * 1000),
    MESSAGE: message ?? `Out of memory: Killed process ${pid} (${comm}) total-vm:9999kB` });
}
beforeEach(() => {
  vi.useFakeTimers();
  // Linux procfs fixtures are modeled explicitly, including on non-Linux CI.
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  dir = mkdtempSync(join(tmpdir(), "agend-oom-2035-"));
  io.root = join(dir, "proc"); mkdirSync(io.root);
  io.journal = ""; io.failure = false; io.hold = false; io.release = null; io.reads = 0; io.procError = ""; io.forbidden.mockClear();
  vi.spyOn(TmuxManager, "getPanePid").mockResolvedValue(100);
  vi.spyOn(TmuxManager, "listWindows").mockResolvedValue([]);
  vi.spyOn(process, "kill").mockImplementation(io.forbidden as never);
});
afterEach(() => {
  expect(io.forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true });
});

describe("definitive evidence rather than pressure or an arbitrary SIGKILL", () => {
  it("observes the CLI under its shell and excludes its tool/MCP children", async () => {
    proc(100, "bash", "101"); proc(101, "claude", "102"); proc(102, "python");
    expect(await observeCliOomIdentity(100, "claude")).toMatchObject({ pid: 101, comm: "claude", start: "123" });
    proc(103, "claude"); proc(100, "bash", "101 103");
    expect(await observeCliOomIdentity(100, "claude")).toBeNull();
  });
  it("accepts only the exact victim in this observed lifetime; rejects a caller and sibling", async () => {
    proc(100, "claude"); const identity = await observeCliOomIdentity(100, "claude");
    unlinkSync(join(io.root, "100/stat")); await vi.advanceTimersByTimeAsync(100);
    io.journal = [record(100, "claude", Date.now(), "claude invoked oom-killer: pid=100"), record(999), record(100, "claude", identity!.observedAt - 1)].join("\n");
    expect(await confirmedCliOom(identity, Date.now())).toBeNull();
    io.journal = record(100);
    expect(await confirmedCliOom(identity, Date.now())).toMatchObject({ pid: 100 });
    proc(100, "claude", "", "999");
    expect(await confirmedCliOom(identity, Date.now())).toBeNull();
  });
  it("unknown namespaces, unreadable journals and unsupported macOS preserve ordinary behavior", async () => {
    proc(100, "claude");
    writeFileSync(join(io.root, "100/status"), "NSpid:\t100 1\n");
    expect(await observeCliOomIdentity(100, "claude")).toBeNull();
    writeFileSync(join(io.root, "100/status"), "NSpid:\t100\n");
    const identity = await observeCliOomIdentity(100, "claude"); unlinkSync(join(io.root, "100/stat"));
    io.failure = true; expect(await confirmedCliOom(identity, Date.now())).toBeNull();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const calls = io.reads;
    expect(await confirmedCliOom(identity, Date.now())).toBeNull(); expect(io.reads).toBe(calls);
  });
  it("shares a bounded physical journal reader among simultaneous deaths", async () => {
    proc(100, "claude"); const identity = await observeCliOomIdentity(100, "claude"); unlinkSync(join(io.root, "100/stat"));
    io.hold = true; io.journal = record(100);
    const reads = [confirmedCliOom(identity, Date.now()), confirmedCliOom(identity, Date.now())];
    await vi.waitFor(() => expect(io.reads).toBe(1)); io.release!();
    expect((await Promise.all(reads)).map(r => r?.pid)).toEqual([100, 100]);
  });
  it("invalidates the consecutive count on an ordinary crash or another session", () => {
    expect(consecutiveSessionOoms({ key: "a", count: 1 }, "a", true)).toEqual({ key: "a", count: 2 });
    expect(consecutiveSessionOoms({ key: "a", count: 1 }, "b", true)).toEqual({ key: "b", count: 1 });
    expect(consecutiveSessionOoms({ key: "a", count: 1 }, "a", false)).toBeNull();
    expect(parseKernelOoms('{"MESSAGE":"Killed process 100"}\nnot-json')).toEqual([]);
  });
});

async function harness() {
  const instance = join(dir, "instance"); mkdirSync(instance);
  const transcript = join(dir, "original-transcript.jsonl"); writeFileSync(transcript, "original conversation\n");
  const session = { id: "old-session" };
  writeFileSync(join(instance, "session-id"), session.id);
  const child = { alive: true, exitCode: 137, pid: 101 };
  proc(100, "bash", "101"); proc(101, "claude");
  const logger: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }; logger.child = () => logger;
  const backend: any = { binaryName: "claude", getSessionId: () => session.id, getContextUsage: () => 0,
    buildCommand: (config: any) => config.skipResume ? "inert --fresh" : `inert --resume ${session.id}` };
  const daemon: any = new Daemon("worker", { working_directory: dir, backend: "claude-code", workflow: false,
    restart_policy: { max_retries: 10, backoff: "linear", reset_after: 0, health_check_interval_ms: 1000 },
    context_guardian: { grace_period_ms: 600000, max_age_hours: 0 }, hang_detector: { enabled: false }, log_level: "silent" } as any,
  instance, false, backend, undefined, logger);
  daemon.tmux = { getPaneStatus: vi.fn(async () => ({ alive: child.alive, ...(child.alive ? {} : { exitCode: child.exitCode }) })),
    getWindowId: () => "@fake", capturePaneWithHistory: vi.fn(async () => "fake killed child"), killWindow: vi.fn(async () => {}) };
  daemon.checkMcpServerAlive = vi.fn(); daemon.startInstanceStateMonitor = vi.fn(); daemon.stopInstanceStateMonitor = vi.fn();
  daemon.resetTranscriptBeforeAdmission = vi.fn(async () => true); daemon.injectSnapshotMessage = vi.fn(async () => {});
  const launches: string[] = [];
  daemon.trySpawn = vi.fn(async () => {
    launches.push(backend.buildCommand(daemon.buildBackendConfig()));
    if (daemon.skipResume) session.id = "fresh-session";
    child.alive = true; child.pid++;
    proc(100, "bash", String(child.pid)); proc(child.pid, "claude");
    await daemon.observeOomIdentity();
    return true;
  });
  // The initial fake child is already ready, just like finishStartupScan.
  await daemon.observeOomIdentity();
  const notices: any[] = []; daemon.on("session_oom", (notice: any) => notices.push(notice));
  const die = async (oom = true, code = 137) => {
    child.alive = false; child.exitCode = code;
    unlinkSync(join(io.root, String(child.pid), "stat"));
    io.journal = oom ? record(child.pid) : record(999);
    await vi.advanceTimersByTimeAsync(4000);
  };
  return { daemon, child, instance, transcript, launches, notices, die, session };
}

describe("the real daemon health + respawn decision with a fake OOM'd child", () => {
  it("resumes once, then starts fresh after the second OOM and stops if that fresh child OOMs", async () => {
    const h = await harness(); h.daemon.startHealthCheck(); await vi.advanceTimersByTimeAsync(1000);
    await h.die(); expect(h.launches).toEqual(["inert --resume old-session"]);
    await h.die(); expect(h.launches).toEqual(["inert --resume old-session", "inert --fresh"]);
    expect(h.notices).toContainEqual(expect.objectContaining({ action: "fresh", session: "old-session" }));
    const archived = readdirSync(h.instance).filter(f => f.startsWith("session-id.oom-"));
    expect(archived).toHaveLength(1); expect(readFileSync(join(h.instance, archived[0]!), "utf8")).toBe("old-session");
    expect(readFileSync(h.transcript, "utf8")).toBe("original conversation\n");
    await h.die(); expect(h.launches).toHaveLength(2); expect(h.daemon.healthCheckPaused).toBe(true);
    expect(h.notices).toContainEqual(expect.objectContaining({ action: "stopped", reason: "fresh_oom" }));
  });
  it("a SIGKILL with no matching OOM evidence retains normal resume behavior", async () => {
    const h = await harness(); h.daemon.startHealthCheck(); await vi.advanceTimersByTimeAsync(1000);
    await h.die(false); await h.die(false);
    expect(h.launches).toEqual(["inert --resume old-session", "inert --resume old-session"]);
    expect(h.notices).toEqual([]);
  });
  it("a stop during the evidence read revokes the decision and cannot launch a replacement", async () => {
    const h = await harness(); h.daemon.startHealthCheck(); await vi.advanceTimersByTimeAsync(1000);
    io.hold = true; h.child.alive = false; unlinkSync(join(io.root, String(h.child.pid), "stat")); io.journal = record(h.child.pid);
    await vi.advanceTimersByTimeAsync(1000); expect(io.release).not.toBeNull();
    h.daemon.healthCheckPaused = true; io.release!(); await vi.advanceTimersByTimeAsync(4000);
    expect(h.launches).toEqual([]); expect(h.notices).toEqual([]);
    expect(h.daemon.oomCount).toBeNull();
    expect(h.daemon.tmux.killWindow).not.toHaveBeenCalled();
  });
  it("discards an old OOM recovery after an operator replaces its launch during backoff", async () => {
    const h = await harness(); h.daemon.startHealthCheck(); await vi.advanceTimersByTimeAsync(1000);
    await h.die();
    h.child.alive = false; unlinkSync(join(io.root, String(h.child.pid), "stat")); io.journal = record(h.child.pid);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.daemon.oomCount.count).toBe(2);
    h.session.id = "operator-new-session";
    await h.daemon.spawnClaudeWindow();
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.launches).toEqual(["inert --resume old-session", "inert --resume operator-new-session"]);
    expect(h.notices).toEqual([]);
    expect(existsSync(join(h.instance, "crash-state.json"))).toBe(false);
    expect(readdirSync(h.instance).filter(f => f.startsWith("session-id.oom-"))).toEqual([]);
    expect(h.daemon.injectSnapshotMessage).not.toHaveBeenCalled();
  });
  it("does not give a later launch the old replacement's snapshot or OOM identity", async () => {
    const h = await harness(); h.daemon.startHealthCheck(); await vi.advanceTimersByTimeAsync(1000); await h.die();
    let release!: () => void;
    let admit!: () => void;
    h.daemon.injectSnapshotMessage.mockImplementation(async (admission: () => void) => {
      admit = admission;
      await new Promise<void>(resolve => { release = resolve; });
      admission();
    });
    await h.die();
    expect(release).toBeTypeOf("function");
    const newer = JSON.stringify({ resumeDisabled: true, reason: "operator-request" });
    writeFileSync(join(h.instance, "crash-state.json"), newer);
    h.session.id = "operator-new-session";
    await h.daemon.spawnClaudeWindow();
    expect(admit).toThrow(/superseded/);
    release(); await vi.advanceTimersByTimeAsync(1000);
    expect(h.daemon.oomFreshGeneration).not.toBe(h.daemon.spawnGeneration);
    expect(existsSync(join(h.instance, "crash-state.json"))).toBe(true);
    expect(readFileSync(join(h.instance, "crash-state.json"), "utf8")).toBe(newer);
  });
});

it("keeps a changed session out of the old session's consecutive OOM count", async () => {
  const h = await harness(); h.daemon.startHealthCheck(); await vi.advanceTimersByTimeAsync(1000);
  await h.die(); h.session.id = "user-new-session";
  await h.die();
  expect(h.launches).toEqual(["inert --resume old-session", "inert --resume user-new-session"]);
  expect(h.notices).toEqual([]);
});

it("stops rather than resuming when fresh intent cannot be saved", async () => {
  const h = await harness(); h.daemon.startHealthCheck(); await vi.advanceTimersByTimeAsync(1000);
  await h.die(); mkdirSync(join(h.instance, "crash-state.json"));
  await h.die();
  expect(h.launches).toEqual(["inert --resume old-session"]);
  expect(h.daemon.healthCheckPaused).toBe(true);
  expect(h.notices).toContainEqual(expect.objectContaining({ action: "stopped", reason: "intent_failed" }));
  expect(readFileSync(h.transcript, "utf8")).toBe("original conversation\n");
});

it("rejects PID reuse that happens while the bounded journal query is pending", async () => {
  proc(100, "claude"); const identity = await observeCliOomIdentity(100, "claude"); unlinkSync(join(io.root, "100/stat"));
  io.hold = true; io.journal = record(100);
  const evidence = confirmedCliOom(identity, Date.now());
  await vi.waitFor(() => expect(io.release).not.toBeNull());
  proc(100, "claude", "", "999"); io.release!();
  expect(await evidence).toBeNull();
});

it("notifies the instance and General and leaves a web Log event with the exact recovery reason", () => {
  const notify = vi.fn(); const insert = vi.fn(); const icon = vi.fn();
  const logger: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const lifecycle = new InstanceLifecycle({ dataDir: dir, logger, isPlannedRestart: () => false,
    fleetConfig: { defaults: {}, instances: { general: { general_topic: true }, worker: {} } },
    eventLog: { insert }, notifyInstanceTopic: notify, setTopicIcon: icon } as unknown as LifecycleContext);
  const source = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn() });
  lifecycle.attachIncidentHandlers("worker", source as any);
  const notice = { name: "worker", action: "fresh", reason: "repeated_oom", session: "old-session" };
  source.emit("session_oom", notice);
  expect(insert).toHaveBeenCalledWith("worker", "session_oom", notice);
  expect(notify.mock.calls.map(c => c[0])).toEqual(["worker", "general"]);
  expect(notify.mock.calls[0]![1]).toContain("old-session");
  source.emit("session_oom", { ...notice, action: "stopped", reason: "fresh_oom" });
  expect(icon).toHaveBeenCalledWith("worker", "red");
});

it("treats unreadable procfs as unknown rather than proof the observed PID disappeared", async () => {
  proc(100, "claude"); const identity = await observeCliOomIdentity(100, "claude");
  io.procError = "EACCES"; io.journal = record(100);
  expect(await confirmedCliOom(identity, Date.now())).toBeNull();
  expect(io.reads).toBe(0);
});

it("does not consume a newer fresh-start intent written while its replacement was starting", async () => {
  const h = await harness(); h.daemon.startHealthCheck(); await vi.advanceTimersByTimeAsync(1000); await h.die();
  const start = h.daemon.trySpawn.getMockImplementation();
  const newer = JSON.stringify({ resumeDisabled: true, reason: "operator-request" });
  h.daemon.trySpawn.mockImplementation(async () => {
    const result = await start(); writeFileSync(join(h.instance, "crash-state.json"), newer); return result;
  });
  await h.die(); expect(h.launches.at(-1)).toBe("inert --fresh");
  expect(existsSync(join(h.instance, "crash-state.json"))).toBe(true);
  expect(readFileSync(join(h.instance, "crash-state.json"), "utf8")).toBe(newer);
});

it("does not walk through an unknown primary to misidentify its tool or subagent", async () => {
  proc(100, "bash", "101"); proc(101, "node", "102"); proc(102, "claude", "", "123", 101);
  expect(await observeCliOomIdentity(100, "claude")).toBeNull();
  proc(100, "bash", "101 102");
  expect(await observeCliOomIdentity(100, "claude")).toBeNull();
  proc(100, "bash", "101");
  // The same named shell script is just a launcher; the real direct CLI is its child.
  proc(101, "claude", "102", "123", 100, "bash");
  expect(await observeCliOomIdentity(100, "claude")).toMatchObject({ pid: 102, comm: "claude" });
});

it("rejects a container procfs view even when NSpid contains only one local PID", async () => {
  proc(100, "claude");
  writeFileSync(join(io.root, "100/ns/pid"), "pid:[4026539999]");
  expect(await observeCliOomIdentity(100, "claude")).toBeNull();
});

it.each([false, true])("booted session-OOM intent remains until successful fresh recovery (startup succeeds=%s)", async success => {
  const h = await harness();
  h.daemon.config.lightweight = true;
  const intent = JSON.stringify({ resumeDisabled: true, reason: "session_oom", session: "old-session" });
  writeFileSync(join(h.instance, "crash-state.json"), intent);
  vi.spyOn(IpcServer.prototype, "listen").mockResolvedValue(undefined);
  vi.spyOn(TmuxManager, "ensureSession").mockResolvedValue(undefined);
  vi.spyOn(TmuxManager.prototype, "getPaneStatus").mockImplementation(async () => ({
    alive: h.child.alive, ...(h.child.alive ? {} : { exitCode: h.child.exitCode }),
  }));
  vi.spyOn(TmuxManager.prototype, "killWindow").mockResolvedValue(undefined);
  vi.spyOn(TmuxManager.prototype, "capturePaneWithHistory").mockResolvedValue("fake killed child");
  h.daemon.maybeResumeInterruptedTurn = vi.fn(async () => {});
  h.daemon.runWarmupInstructionNotice = vi.fn(async () => {});
  if (!success) {
    const failed = new Error("inert CLI startup interrupted");
    h.daemon.trySpawn.mockRejectedValue(failed);
    await expect(h.daemon.start()).rejects.toBe(failed);
    expect(h.daemon.oomFreshGeneration).toBe(-1);
    expect(existsSync(join(h.instance, "crash-state.json"))).toBe(true);
    expect(readFileSync(join(h.instance, "crash-state.json"), "utf8")).toBe(intent);
    return;
  }
  let release!: () => void;
  h.daemon.injectSnapshotMessage.mockImplementation(async (admission: () => void) => {
    expect(existsSync(join(h.instance, "crash-state.json"))).toBe(true);
    await new Promise<void>(resolve => { release = resolve; });
    admission();
  });
  const startup = h.daemon.start();
  void startup.catch(() => {}); // observe a reversal failure while the snapshot is held
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(h.launches).toEqual(["inert --fresh"]);
  expect(existsSync(join(h.instance, "crash-state.json"))).toBe(true);
  release(); await startup;
  expect(existsSync(join(h.instance, "crash-state.json"))).toBe(false);
  expect(h.daemon.oomFreshGeneration).toBe(h.daemon.spawnGeneration);
  await h.die();
  expect(h.launches).toEqual(["inert --fresh"]);
  expect(h.notices).toContainEqual(expect.objectContaining({ action: "stopped", reason: "fresh_oom" }));
});
