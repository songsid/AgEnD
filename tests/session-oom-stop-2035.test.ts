import { selfEvidence, selfOomJournal, collateralOomJournal } from "./helpers/self-oom-evidence.js";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, readFileSync, existsSync } from "node:fs";
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
    expect(opts).toMatchObject({ timeout: 1000, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL" });
    const done = () => callback(io.failure ? new Error("journal unavailable") : null, io.journal, "");
    if (io.hold) io.release = done; else queueMicrotask(done);
    return new EventEmitter();
  },
}));
vi.mock("node:net", async original => ({ ...await original<typeof import("node:net")>(), createServer: io.forbidden, connect: io.forbidden, createConnection: io.forbidden }));
import { observeCliOomIdentity, confirmedCliOom, parseKernelOoms, consecutiveSessionOoms } from "../src/session-oom.js";
import { Daemon } from "../src/daemon.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { writeSessionOomStop, captureSessionOomRetry, clearSessionOomStopForRetry } from "../src/session-oom-stop.js";
import * as atomicWrites from "../src/atomic-write.js";

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
  vi.spyOn(TmuxManager, "listWindows").mockResolvedValue([]);
  vi.spyOn(process, "kill").mockImplementation(io.forbidden as never);
});
afterEach(() => {
  expect(io.forbidden).not.toHaveBeenCalled();
  vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true });
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
  it("rejects a matching PID with another comm inside the observation window", async () => {
    proc(100, "claude"); const identity = await observeCliOomIdentity(100, "claude");
    unlinkSync(join(io.root, "100/stat"));
    io.journal = record(100, "other-cli");
    expect(await confirmedCliOom(identity, Date.now())).toBeNull();
    io.journal = record(100, "claude");
    expect(await confirmedCliOom(identity, Date.now())).toMatchObject({ pid: 100 });
  });
  it("a reused PID that is itself a zombie does not prove the observed process is dead", async () => {
    proc(100, "claude"); const identity = await observeCliOomIdentity(100, "claude");
    const stat = join(io.root, "100/stat");
    proc(100, "claude", "", "999"); writeFileSync(stat, readFileSync(stat, "utf8").replace(") S ", ") Z "));
    io.journal = record(100);
    expect(await confirmedCliOom(identity, Date.now())).toBeNull();
    proc(100, "claude", "", "123"); writeFileSync(stat, readFileSync(stat, "utf8").replace(") S ", ") Z "));
    expect(await confirmedCliOom(identity, Date.now())).toMatchObject({ pid: 100 });
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


function harness(maxRetries = 10) {
  const instance = join(dir, "instance"); mkdirSync(instance);
  const transcript = join(dir, "original-transcript.jsonl"); writeFileSync(transcript, "original conversation\n");
  const session: { id: string | null } = { id: "old-session" };
  writeFileSync(join(instance, "session-id"), session.id!);
  const child = { alive: true, exitCode: 137, pid: 101 };
  proc(100, "bash", "101"); proc(101, "claude");
  const logger: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }; logger.child = () => logger;
  const backend: any = { binaryName: "claude", getSessionId: () => session.id, getContextUsage: () => 0,
    buildCommand: (config: any) => config.skipResume ? "inert --fresh" : `inert --resume ${session.id}` };
  const daemon: any = new Daemon("worker", { working_directory: dir, backend: "claude-code", workflow: false,
    restart_policy: { max_retries: maxRetries, backoff: "linear", reset_after: 0, health_check_interval_ms: 1000 },
    context_guardian: { grace_period_ms: 600000, max_age_hours: 0 }, hang_detector: { enabled: false }, log_level: "silent" } as any,
  instance, false, backend, undefined, logger);
  daemon.tmux = { getPaneStatus: vi.fn(async () => ({ alive: child.alive, ...(child.alive ? { pid: 100 } : { exitCode: child.exitCode }) })),
    getWindowId: () => "@fake", capturePaneWithHistory: vi.fn(async () => "fake killed child"), killWindow: vi.fn(async () => {}) };
  daemon.checkMcpServerAlive = vi.fn(); daemon.startInstanceStateMonitor = vi.fn(); daemon.stopInstanceStateMonitor = vi.fn();
  daemon.resetTranscriptBeforeAdmission = vi.fn(async () => true); daemon.injectSnapshotMessage = vi.fn(async () => {});
  const launches: string[] = [];
  // Actual spawnClaudeWindow/beginSpawn/endSpawn/config/session ownership; only physical CLI admission is inert.
  daemon.trySpawn = vi.fn(async () => {
    launches.push(backend.buildCommand(daemon.buildBackendConfig()));
    child.alive = true; child.pid++;
    proc(100, "bash", String(child.pid)); proc(child.pid, "claude");
    return true;
  });
  const notices: any[] = []; daemon.on("supervision_ended", (notice: any) => notices.push(notice));
  const die = async (oom: boolean | "collateral" | "unknown" = true, code = 137) => {
    child.alive = false; child.exitCode = code;
    unlinkSync(join(io.root, String(child.pid), "stat"));
    io.journal = oom === "unknown" ? record(child.pid) : oom === "collateral" ? collateralOomJournal(child.pid, "claude", Date.now()) : oom ? selfOomJournal(child.pid, "claude", Date.now()) : record(999);
    await vi.advanceTimersByTimeAsync(4000);
  };
  daemon.startHealthCheck();
  return { daemon, child, instance, transcript, launches, notices, die, session };
}

describe("bounded same-session recovery with a fake OOM-killed child", () => {
  it("daemon delivery and launch refusals name unreadable evidence without claiming an OOM", async () => {
    const h = harness();
    const path = join(h.instance, "session-oom-stop.json");
    writeFileSync(path, "truncated");
    expect(h.daemon.notAcceptingReason()).toContain("could not be read safely");
    await expect(h.daemon.wake()).rejects.toThrow("could not be read safely");
    unlinkSync(path);
    writeSessionOomStop(h.instance, { owner: h.daemon.getInteractionSnapshot().owner, sessionKey: "confirmed-stop",
      configuration: h.daemon.getWorkingStateObservation().configuration, stoppedAt: Date.now(), count: 2, victim: { pid: 999, at: Date.now() }, evidence: selfEvidence() });
    expect(h.daemon.notAcceptingReason()).toContain("session-OOM stop evidence");
    await expect(h.daemon.wake()).rejects.toThrow("session-OOM stop evidence");
  });
  it("a stop appearing during awaited tmux preparation prevents physical window creation", async () => {
    const h = harness(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    h.daemon.backend.writeConfig = vi.fn(); h.daemon.backend.preTrust = vi.fn();
    const preparingTmux = vi.spyOn(TmuxManager, "ensureSession").mockReturnValue(held);
    vi.spyOn(TmuxManager, "getServerPid").mockResolvedValue(123);
    const create = h.daemon.tmux.createWindow = vi.fn(async () => { throw Error("unexpected physical spawn"); });
    const preparing = h.daemon.trySpawnInsideGate();
    await vi.waitFor(() => expect(preparingTmux).toHaveBeenCalled());
    writeSessionOomStop(h.instance, { owner: h.daemon.getInteractionSnapshot().owner, sessionKey: "owned-session",
      configuration: h.daemon.getWorkingStateObservation().configuration, stoppedAt: Date.now(), count: 2, victim: { pid: 101, at: Date.now() }, evidence: selfEvidence() });
    const rejected = preparing.catch((error: unknown) => error); release(); const error = await rejected;
    expect(create).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: "SESSION_OOM_STOPPED" });
  });
  it("a stop appearing during backend preparation prevents config writes and physical spawning", async () => {
    const h = harness(); let release!: () => void; let entered = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    h.daemon.backend.prepareLaunch = () => { entered = true; return held; };
    h.daemon.backend.writeConfig = vi.fn(); h.daemon.backend.preTrust = vi.fn();
    const preparing = h.daemon.trySpawnInsideGate(); expect(entered).toBe(true);
    writeSessionOomStop(h.instance, { owner: h.daemon.getInteractionSnapshot().owner, sessionKey: "owned-session",
      configuration: h.daemon.getWorkingStateObservation().configuration, stoppedAt: Date.now(), count: 2, victim: { pid: 101, at: Date.now() }, evidence: selfEvidence() });
    const rejected = preparing.catch((error: unknown) => error); release(); const error = await rejected;
    expect(h.daemon.backend.writeConfig).not.toHaveBeenCalled(); expect(h.daemon.backend.preTrust).not.toHaveBeenCalled();
    expect(h.launches).toHaveLength(0);
    expect(error).toMatchObject({ code: "SESSION_OOM_STOPPED" });
  });
  it("a persistence failure keeps the current daemon held and reports the missing durability", async () => {
    const h = harness();
    writeSessionOomStop(h.instance, { owner: h.daemon.getInteractionSnapshot().owner, sessionKey: "prior-stop",
      configuration: h.daemon.getWorkingStateObservation().configuration, stoppedAt: Date.now(), count: 2, victim: { pid: 999, at: Date.now() }, evidence: selfEvidence() });
    clearSessionOomStopForRetry(h.instance, captureSessionOomRetry(h.instance));
    vi.spyOn(atomicWrites, "atomicWriteFileSync").mockImplementation(() => { throw Error("injected disk full"); });
    await vi.advanceTimersByTimeAsync(1000); await h.die(); await vi.advanceTimersByTimeAsync(2000); await h.die();
    expect(h.daemon.isSessionOomStopped()).toBe(true);
    await expect(h.daemon.wake()).rejects.toMatchObject({ code: "SESSION_OOM_STOPPED" });
    expect(h.notices).toHaveLength(1); expect(h.notices[0].remedy).toContain("could not be saved");
    expect(h.launches).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(h.instance, "session-oom-stop.json"), "utf8")).reason).toBe("session_oom_cleared");
    const replacement = new Daemon("worker", h.daemon.config, h.instance, true, h.daemon.backend, undefined, h.daemon.logger);
    await expect(replacement.start()).rejects.toMatchObject({ code: "SESSION_OOM_STOPPED" });
  });
  it("persists the terminal stop before notifying, so a replacement daemon cannot resume after fleet restart", async () => {
    const h = harness(); const persistedAtNotice: boolean[] = [];
    h.daemon.on("supervision_ended", () => persistedAtNotice.push(existsSync(join(h.instance, "session-oom-stop.json"))));
    await vi.advanceTimersByTimeAsync(1000); await h.die();
    expect(existsSync(join(h.instance, "session-oom-stop.json"))).toBe(false);
    await vi.advanceTimersByTimeAsync(2000); await h.die();
    expect(persistedAtNotice).toEqual([true]);
    const record = JSON.parse(readFileSync(join(h.instance, "session-oom-stop.json"), "utf8"));
    expect(record).toMatchObject({ reason: "session_oom", count: 2, sessionKey: JSON.stringify(["claude-code", "old-session"]),
      owner: h.daemon.getInteractionSnapshot().owner });
    const replacement = new Daemon("worker", h.daemon.config, h.instance, true, h.daemon.backend, undefined, h.daemon.logger) as any;
    await expect(replacement.start()).rejects.toMatchObject({ code: "SESSION_OOM_STOPPED" });
    await expect(replacement.wake()).rejects.toMatchObject({ code: "SESSION_OOM_STOPPED" });
    expect(readFileSync(join(h.instance, "session-id"), "utf8")).toBe("old-session");
    expect(h.launches).toHaveLength(1);
  });
  it("resumes once, then stops after the second confirmed OOM without starting fresh or changing the transcript", async () => {
    const h = harness(); await vi.advanceTimersByTimeAsync(1000);
    await h.die(); expect(h.launches).toEqual(["inert --resume old-session"]);
    // Alive again is not proof the resumed session is safe.
    await vi.advanceTimersByTimeAsync(2000);
    await h.die(); expect(h.launches).toEqual(["inert --resume old-session"]);
    expect(h.daemon.healthCheckPaused).toBe(true);
    expect(h.daemon.processStatus).toBe("crashed");
    expect(h.daemon.isPaused).toBe(false); // queued work cannot auto-wake this stopped supervisor
    expect(h.notices).toEqual([expect.objectContaining({ cause: "session_oom", exitCode: 137,
      reason: expect.stringContaining("two positively attributed OOMs"), remedy: expect.stringContaining("explicitly restart") })]);
    expect(readFileSync(join(h.instance, "session-id"), "utf8")).toBe("old-session");
    expect(readFileSync(h.transcript, "utf8")).toBe("original conversation\n");
    expect(existsSync(join(h.instance, "crash-state.json"))).toBe(false);
    expect(h.daemon.injectSnapshotMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000); expect(h.launches).toHaveLength(1);
  });
  it("an ordinary SIGKILL or a tool/sibling victim does not count as this session's OOM", async () => {
    const h = harness(); await vi.advanceTimersByTimeAsync(1000);
    await h.die(false); await h.die(false);
    expect(h.launches).toEqual(["inert --resume old-session", "inert --resume old-session"]);
    expect(h.notices).toEqual([]); expect(h.daemon.consecutiveOoms).toBeNull();
    h.daemon.healthCheckPaused = true;
  });
  it("an existing fresh launch clears the old streak before a delayed provider session update", async () => {
    const h = harness(); await vi.advanceTimersByTimeAsync(1000); await h.die();
    expect(h.daemon.consecutiveOoms?.count).toBe(1);
    h.daemon.skipResume = true;
    expect(await h.daemon.spawnClaudeWindow()).toBe(false);
    expect(h.session.id).toBe("old-session"); // provider has not rewritten it yet
    expect(h.daemon.consecutiveOoms).toBeNull();
    await vi.advanceTimersByTimeAsync(1000); await h.die();
    expect(h.notices).toEqual([]);
    expect(h.daemon.consecutiveOoms?.count).toBe(1);
    h.daemon.healthCheckPaused = true;
  });
  it("does not treat a cwd-selected backend getter as an owned session identity", async () => {
    const h = harness(); h.daemon.config.backend = "muse";
    const read = vi.fn(() => "cwd-selected-session"); h.daemon.backend.getSessionId = read;
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).not.toHaveBeenCalled();
    expect(h.daemon.cliOomObservation).toBeNull();
    expect(h.daemon.consecutiveOoms).toBeNull();
    h.daemon.healthCheckPaused = true;
  });
  it.each([1, 139])("exit %i with a matching-looking kernel record still uses ordinary recovery", async code => {
    const h = harness(); await vi.advanceTimersByTimeAsync(1000); await h.die();
    await h.die(true, code);
    expect(h.launches).toHaveLength(2); expect(h.notices).toEqual([]);
    expect(h.daemon.consecutiveOoms).toBeNull(); h.daemon.healthCheckPaused = true;
  });
  it.each(["owner", "tmux"])("an observation from a previous %s cannot count towards the current launch", async previous => {
    const h = harness(); await vi.advanceTimersByTimeAsync(1000);
    const old = h.daemon.cliOomObservation; expect(old).not.toBeNull();
    if (previous === "owner") { h.daemon.beginSpawn(); h.daemon.endSpawn(); }
    else h.daemon.tmux = { ...h.daemon.tmux };
    h.daemon.cliOomObservation = old;
    await h.die();
    expect(h.daemon.consecutiveOoms).toBeNull();
    expect(h.notices).toEqual([]); expect(h.launches).toHaveLength(1);
    h.daemon.healthCheckPaused = true;
  });
  it("a session change starts a new streak; unknown session ownership does not guess from the old session-id file", async () => {
    const h = harness(); await vi.advanceTimersByTimeAsync(1000); await h.die();
    h.session.id = "new-session"; await vi.advanceTimersByTimeAsync(1000); await h.die();
    expect(h.daemon.consecutiveOoms?.count).toBe(1); expect(h.launches).toHaveLength(2);
    h.daemon.crashTimestamps = []; h.session.id = null;
    await vi.advanceTimersByTimeAsync(1000); await h.die();
    expect(h.daemon.consecutiveOoms).toBeNull(); expect(h.launches).toHaveLength(3);
    expect(h.notices).toEqual([]); h.daemon.healthCheckPaused = true;
  });
  it.each(["stop", "replacement"])("a %s while the journal is pending revokes the old decision", async change => {
    const h = harness(); await vi.advanceTimersByTimeAsync(1000); await h.die();
    io.hold = true; h.child.alive = false; unlinkSync(join(io.root, String(h.child.pid), "stat")); io.journal = selfOomJournal(h.child.pid, "claude", Date.now());
    await vi.advanceTimersByTimeAsync(1000); expect(io.release).not.toBeNull();
    if (change === "stop") h.daemon.healthCheckPaused = true;
    else { h.daemon.beginSpawn(); h.daemon.endSpawn(); }
    io.release!(); await vi.advanceTimersByTimeAsync(1);
    expect(h.notices).toEqual([]); expect(h.launches).toHaveLength(1);
    expect(h.daemon.consecutiveOoms?.count).toBe(1); h.daemon.healthCheckPaused = true;
  });
  it("a session change during the journal read cannot stop the new session", async () => {
    const h = harness(); await vi.advanceTimersByTimeAsync(1000); await h.die();
    io.hold = true; h.child.alive = false; unlinkSync(join(io.root, String(h.child.pid), "stat")); io.journal = selfOomJournal(h.child.pid, "claude", Date.now());
    await vi.advanceTimersByTimeAsync(1000); expect(io.release).not.toBeNull();
    h.session.id = "replacement-session";
    io.hold = false; io.release!(); await vi.advanceTimersByTimeAsync(4000);
    expect(h.notices).toEqual([]); expect(h.daemon.consecutiveOoms).toBeNull();
    expect(h.launches).toEqual(["inert --resume old-session", "inert --resume replacement-session"]);
    h.daemon.healthCheckPaused = true;
  });
  it("a replacement during backoff cannot be followed by the old crash's resume", async () => {
    const h = harness(); await vi.advanceTimersByTimeAsync(1000);
    h.child.alive = false; unlinkSync(join(io.root, String(h.child.pid), "stat")); io.journal = selfOomJournal(h.child.pid, "claude", Date.now());
    await vi.advanceTimersByTimeAsync(1000); // classified; one second backoff is pending
    h.daemon.beginSpawn(); h.daemon.endSpawn();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.launches).toEqual([]); expect(h.notices).toEqual([]);
    expect(h.daemon.resetTranscriptBeforeAdmission).not.toHaveBeenCalled(); h.daemon.healthCheckPaused = true;
  });
  it("a death before any live PID observation uses ordinary recovery", async () => {
    const h = harness(); await h.die();
    expect(h.launches).toEqual(["inert --resume old-session"]); expect(h.notices).toEqual([]);
    expect(h.daemon.consecutiveOoms).toBeNull(); h.daemon.healthCheckPaused = true;
  });
});

it("rejects a nested PID namespace even when its procfs NSpid has one local entry", async () => {
  proc(100, "claude"); writeFileSync(join(io.root, "100/ns/pid"), "pid:[4026539999]");
  expect(await observeCliOomIdentity(100, "claude")).toBeNull();
});
it("unreadable procfs is not proof the observed PID disappeared", async () => {
  proc(100, "claude"); const identity = await observeCliOomIdentity(100, "claude");
  io.procError = "EACCES"; io.journal = record(100);
  expect(await confirmedCliOom(identity, Date.now())).toBeNull(); expect(io.reads).toBe(0);
});
it("does not walk through an unknown primary to find a tool named like the backend", async () => {
  proc(100, "bash", "101"); proc(101, "node", "102"); proc(102, "claude", "", "123", 101);
  expect(await observeCliOomIdentity(100, "claude")).toBeNull();
});


describe("#2446 collateral OOM recovery", () => {
  it.each([1, 10])("unknown cause retains the ordinary bounded budget (max_retries=%i) without a self-OOM stop", async max => {
    const h = harness(max);
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 4; i++) {
      if (h.daemon.healthCheckPaused) break;
      await h.die("unknown");
    }
    expect(h.launches).toHaveLength(max === 1 ? 1 : 2);
    expect(h.notices).toEqual([expect.objectContaining({ cause: "oom_unclear", reason: "crashed repeatedly (out of memory, cause unclear)" })]);
    expect(h.daemon.isUnclearOomStopped()).toBe(true);
    expect(h.daemon.isSessionOomStopped()).toBe(false);
    expect(h.daemon.consecutiveOoms).toBeNull();
    expect(existsSync(join(h.instance, "session-oom-stop.json"))).toBe(false);
    expect(existsSync(join(h.instance, "crash-state.json"))).toBe(false);
    expect(readFileSync(join(h.instance, "session-id"), "utf8")).toBe("old-session");
    h.daemon.beginSpawn(); h.daemon.endSpawn();
    expect(h.daemon.isUnclearOomStopped()).toBe(false);
  });
  it("a collateral victim does not abandon the session because of old conflict text", async () => {
    const h = harness(); await vi.advanceTimersByTimeAsync(1000);
    h.daemon.tmux.capturePaneWithHistory.mockResolvedValue("Session is currently running: background agent");
    await h.die("collateral");
    expect(h.launches).toEqual(["inert --resume old-session"]);
    expect(h.daemon.backgroundSessionRecoveryAttempted).toBe(false);
    expect(readFileSync(join(h.instance, "session-id"), "utf8")).toBe("old-session");
  });
  it("a first confirmed victim without self proof is not counted", async () => {
    const h = harness(); await vi.advanceTimersByTimeAsync(1000); await h.die("collateral");
    expect(h.daemon.consecutiveOoms).toBeNull(); expect(h.launches).toHaveLength(1);
    expect(h.daemon.crashTimestamps).toEqual([]);
  });
  it("does not stop or exhaust ordinary crash budgets after repeated collateral deaths", async () => {
    const h = harness(1); await vi.advanceTimersByTimeAsync(1000);
    h.daemon.trySpawn.mockImplementation(async () => {
      expect(h.daemon.collateralOomRecovery).toBe(true);
      h.launches.push("collateral recovery"); h.child.alive = true; h.child.pid++;
      proc(100, "bash", String(h.child.pid)); proc(h.child.pid, "claude"); return true;
    });
    for (let i = 0; i < 4; i++) await h.die("collateral");
    expect(h.launches).toHaveLength(4); expect(h.notices).toEqual([]);
    expect(h.daemon.consecutiveOoms).toBeNull(); expect(h.daemon.crashCount).toBe(0);
    expect(h.daemon.crashTimestamps).toEqual([]);
    expect(h.daemon.isSessionOomStopped()).toBe(false);
  });
  it("collateral separates two self-caused deaths instead of accumulating them", async () => {
    const h = harness(); await vi.advanceTimersByTimeAsync(1000); await h.die(); await h.die("collateral"); await h.die();
    expect(h.daemon.consecutiveOoms?.count).toBe(1);
    expect(h.notices).toEqual([]); expect(h.daemon.isSessionOomStopped()).toBe(false);
  });
  it("the actual daemon physical admission forwards its memory-recovery requirement", async () => {
    const h = harness(); const run = vi.fn(async (_task, operation) => operation());
    h.daemon.spawnGate = { run };
    h.daemon.trySpawnInsideGate = vi.fn(async () => true);
    h.daemon.ensureBackendAgent = vi.fn(async () => {});
    h.daemon.collateralOomRecovery = true;
    await (Daemon.prototype as any).trySpawn.call(h.daemon);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ requireNormalMemory: true }), expect.any(Function));
  });
});

it("a stop or replacement during pressure admission cannot start the old recovery", async () => {
  const h = harness();
  let enter!: () => Promise<boolean>;
  const held = new Promise<boolean>((resolve, reject) => {
    h.daemon.spawnGate = { run: (_task: unknown, operation: () => Promise<boolean>) => {
      enter = async () => { try { const value = await operation(); resolve(value); return value; } catch (error) { reject(error); throw error; } };
      return held;
    } };
  });
  h.daemon.trySpawnInsideGate = vi.fn(async () => true);
  h.daemon.ensureBackendAgent = vi.fn(async () => {});
  h.daemon.collateralOomRecovery = true;
  const pending = (Daemon.prototype as any).trySpawn.call(h.daemon);
  const failed = expect(pending).rejects.toThrow("OOM recovery cancelled");
  h.daemon.beginSpawn(); h.daemon.endSpawn();
  await expect(enter()).rejects.toThrow("OOM recovery cancelled"); await failed;
  expect(h.daemon.trySpawnInsideGate).not.toHaveBeenCalled();
});
