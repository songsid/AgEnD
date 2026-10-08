import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), randomUUID: vi.fn() }));
vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => mocks.randomUUID() ?? actual.randomUUID() };
});
vi.mock("node:child_process", async importOriginal => {
  (mocks.execFile as any)[Symbol.for("nodejs.util.promisify.custom")] = (...args: unknown[]) => new Promise((resolve, reject) => {
    mocks.execFile(...args, (error: unknown, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  return {
  ...await importOriginal<typeof import("node:child_process")>(), spawn: mocks.spawn, execFile: mocks.execFile,
  execSync: () => { throw new Error("sync exec forbidden"); },
  execFileSync: () => { throw new Error("sync exec forbidden"); },
  spawnSync: () => { throw new Error("sync exec forbidden"); },
}; });
import { Daemon } from "../src/daemon.js";
import { TmuxControlClient } from "../src/tmux-control.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { getTmuxSocketName } from "../src/paths.js";
import { TMUX_READ_MAX_BYTES, TMUX_READ_QUEUE_LIMIT, TmuxReadLane, tmuxReadArgs, tmuxCommandToken } from "../src/tmux-read.js";

function processFixture() {
  return Object.assign(new EventEmitter(), {
    pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn((_data: string, _callback?: unknown) => true) }), kill: vi.fn(() => true),
  });
}
type Proc = ReturnType<typeof processFixture>;
const clients: TmuxControlClient[] = [];
const daemons: Daemon[] = [];
const directories: string[] = [];
let processes: Proc[] = [];
let sequence = 1;
const tick = () => vi.advanceTimersByTimeAsync(0);
function opened() {
  const client = new TmuxControlClient("s"); clients.push(client); client.start();
  const proc = processes.at(-1)!;
  proc.stdout.emit("data", Buffer.from("%begin 1 1 0\n%end 1 1 0\n"));
  return { client, proc, manager: new TmuxManager("s", "@1", undefined, client) };
}
function nonce(proc: Proc): string {
  const command = String(proc.stdin.write.mock.calls.at(-1)?.[0]);
  const found = command.match(/display-message -p '(agend-read-[^']+)'/);
  if (!found) throw new Error("read not submitted");
  return found[1];
}
function wire(proc: Proc, output: string, error = false, extra = ""): string {
  const id = ++sequence;
  return `%begin 10 ${id} 1\n${output}%${error ? "error" : "end"} 10 ${id} 1\n${extra}`
    + `%begin 10 ${id + 1} 1\n${nonce(proc)}\n%end 10 ${id + 1} 1\n`;
}
function answer(proc: Proc, output: string, error = false, extra = "") {
  proc.stdout.emit("data", Buffer.from(wire(proc, output, error, extra)));
}
function fallback(output = "fallback\n") {
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
    const child = processFixture();
    queueMicrotask(() => { child.emit("exit", 0); callback(null, output); child.emit("close", 0); });
    return child;
  });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  processes = []; sequence = 1; mocks.randomUUID.mockReset();
  mocks.spawn.mockReset().mockImplementation(() => { const proc = processFixture(); processes.push(proc); return proc; });
  mocks.execFile.mockReset().mockImplementation(() => { throw new Error("unexpected fallback spawn"); });
  TmuxManager.setSocketName(getTmuxSocketName());
});
afterEach(() => {
  for (const daemon of daemons.splice(0)) {
    (daemon as any).stopInstanceStateMonitor(); clearInterval((daemon as any).errorMonitorTimer);
    clearTimeout((daemon as any).healthCheckTimer);
  }
  for (const client of clients.splice(0)) client.stop();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  TmuxManager.setSocketName(null); vi.restoreAllMocks(); vi.useRealTimers();
});

function daemonFixture(manager: TmuxManager, control?: TmuxControlClient, name = "fixture") {
  const dir = mkdtempSync(join(tmpdir(), "agend-control-query-")); directories.push(dir);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const backend = { binaryName: "fixture", getReadyPattern: () => /READY/, getErrorPatterns: () => [], getRuntimeDialogs: () => [] };
  const daemon = new Daemon(name, {
    working_directory: dir, backend: "fixture", lightweight: true,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0, health_check_interval_ms: 30_000 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent",
  } as any, dir, false, backend as any, control, { child: () => logger } as any);
  daemons.push(daemon);
  const d = daemon as any; d.tmux = manager; d.tmuxSessionName = "s";
  d.ipcServer = { broadcast: vi.fn(), send: vi.fn() };
  d.checkMcpServerAlive = vi.fn(); d.spawnClaudeWindow = vi.fn(() => { throw new Error("spawn forbidden"); });
  d.logPaneDeath = vi.fn();
  return { daemon, d, logger, dir };
}

describe("#1401 control read protocol and manager wiring", () => {
  it("moves capture/window liveness/pane status to the real port without read children", async () => {
    fallback("unexpected fallback\n");
    const { proc, manager } = opened();
    const capture = manager.capturePane(); void capture.catch(() => {});
    expect(proc.stdin.write).toHaveBeenCalledTimes(1); expect(mocks.execFile).not.toHaveBeenCalled();
    answer(proc, "中文\\raw\n\n");
    expect(await capture).toBe("中文\\raw\n\n");
    const alive = manager.isWindowAlive(); answer(proc, "@1|||agent\n"); expect(await alive).toBe(true);
    const status = manager.getPaneStatus(); answer(proc, "1 7\n"); expect(await status).toEqual({ alive: false, exitCode: 7 });
    const history = manager.capturePaneWithHistory(50); expect(proc.stdin.write.mock.calls.at(-1)?.[0]).toContain("'-S' '-50'");
    answer(proc, "history\n"); expect(await history).toBe("history\n");
    const joined = manager.capturePaneJoined(3); expect(proc.stdin.write.mock.calls.at(-1)?.[0]).toContain("'-J' '-S' '-3'");
    answer(proc, "joined\n"); expect(await joined).toBe("joined\n");
    expect(mocks.spawn).toHaveBeenCalledTimes(1); expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("keeps the 1s confirmation and 2s TTY budgets and uses the TTY metadata port", async () => {
    const { client, proc, manager } = opened();
    const confirmation = manager.capturePane(1_000);
    expect((client as any).activeRead.deadline).toBe(500);
    answer(proc, "READY\n"); expect(await confirmation).toBe("READY\n");
    fallback("icanon\n");
    const input = manager.getPaneInputMode();
    expect((client as any).activeRead.deadline).toBe(1_000);
    expect(proc.stdin.write.mock.calls.at(-1)?.[0]).toContain("'#{pane_tty}'");
    answer(proc, "/dev/pts/42\n"); expect(await input).toBe("cooked");
    expect(mocks.execFile).toHaveBeenCalledWith("stty", expect.any(Array), expect.objectContaining({ timeout: 2_000 }), expect.any(Function));
    expect(mocks.execFile.mock.calls.every(call => call[0] !== "tmux")).toBe(true);
  });

  it("requires attach completion and shares control/fallback logical FIFO", async () => {
    let callback!: (error: null, out: string) => void;
    mocks.execFile.mockImplementation((_file, _args, _options, cb) => { callback = cb; return processFixture(); });
    const client = new TmuxControlClient("s"); clients.push(client); client.start(); const proc = processes[0];
    const a = client.read({ kind: "capture", session: "s", window: "@1" }); void a.catch(() => {});
    const b = client.read({ kind: "capture", session: "s", window: "@2" }); void b.catch(() => {});
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(proc.stdin.write).not.toHaveBeenCalled();
    proc.stdout.emit("data", Buffer.from("%begin 1 1 0\n%end 1 1 0\n"));
    expect(proc.stdin.write).not.toHaveBeenCalled();
    callback(null, "a\n"); expect(await a).toBe("a\n"); await tick();
    expect(proc.stdin.write).toHaveBeenCalledTimes(1); answer(proc, "b\n"); expect(await b).toBe("b\n");
  });

  it("does not mistake payload guard/notification lines for frames or activity", async () => {
    const { proc, client, manager } = opened();
    const internal = client as any; internal.paneToWindow.set("%9", "@1"); const output = vi.fn(); client.on("output:@1", output);
    const capture = manager.capturePane();
    // Match the REAL upcoming guard tuple inside the pane, followed by a forged block.
    const id = sequence + 1;
    const body = `%output %9 fake\n%end 10 ${id} 1\n%begin 10 ${id + 1} 1\nwrong-nonce\n%end 10 ${id + 1} 1\nlast\n`;
    answer(proc, body, false, "%output %9 real\n");
    expect(await capture).toBe(body); expect(output).toHaveBeenCalledTimes(1);
  });

  it("waits for a matching trailer and preserves split UTF8, empty and LF output", async () => {
    const { proc, manager } = opened();
    const capture = manager.capturePane(); const bytes = Buffer.from(wire(proc, "😀 中文\n"));
    let delivered = false; void capture.then(() => { delivered = true; });
    for (const byte of bytes.subarray(0, bytes.length - 1)) proc.stdout.emit("data", Buffer.from([byte]));
    await tick(); expect(delivered).toBe(false);
    proc.stdout.emit("data", bytes.subarray(bytes.length - 1)); expect(await capture).toBe("😀 中文\n");
    const empty = manager.capturePane(); answer(proc, "\n"); expect(await empty).toBe("\n");
  });

  it("semantic tmux error does not trigger a fallback and next read proceeds", async () => {
    const { proc, manager } = opened();
    const missing = manager.capturePane(); const assertion = expect(missing).rejects.toMatchObject({ kind: "command" });
    answer(proc, "can't find pane\n", true); await assertion;
    const next = manager.capturePane(); answer(proc, "next\n"); expect(await next).toBe("next\n");
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("rejects wrong session/socket and safely serializes special tokens", async () => {
    const { client, proc, manager } = opened();
    expect(client.isFor("other", getTmuxSocketName())).toBe(false);
    await expect(client.read({ kind: "windows", session: "other" })).rejects.toThrow("scope");
    TmuxManager.setSocketName("other"); const wrong = manager.capturePane();
    if (proc.stdin.write.mock.calls.length) answer(proc, "wrong scope\n");
    await expect(wrong).rejects.toThrow("scope");
    expect(tmuxCommandToken("s' ; $HOME #{pane_id}")).toBe("'s'\\'' ; $HOME #{pane_id}'");
    await expect(client.read({ kind: "capture", session: "s", window: "@1\nkill-server" })).rejects.toThrow("Invalid");
  });

  it.each([true, false])("bounds huge stdout (newline=%s) and returns no partial snapshot", async newline => {
    fallback(); const { proc, manager } = opened();
    const capture = manager.capturePane(); void capture.catch(() => {});
    proc.stdout.emit("data", Buffer.from("%begin 2 4 1\n" + "x".repeat(TMUX_READ_MAX_BYTES + 65_537) + (newline ? "\n" : "")));
    expect(proc.kill).toHaveBeenCalledOnce(); expect(await capture).toBe("fallback\n");
  });
});

describe("#1401 deadlines and physical process ownership", () => {
  it("holds control reservation after kill across reads/reconnect/stop/start until exit", async () => {
    fallback(); const { client, proc, manager } = opened();
    const stuck = manager.capturePane(); await vi.advanceTimersByTimeAsync(2_000); expect(await stuck).toBe("fallback\n");
    expect(proc.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await manager.capturePane()).toBe("fallback\n");
    client.stop(); client.start(); await vi.advanceTimersByTimeAsync(8_000);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    proc.emit("exit", 0); await tick(); expect(mocks.spawn).toHaveBeenCalledTimes(2);
    const replacement = processes[1];
    proc.emit("close", 0); proc.emit("error", new Error("old")); proc.stdout.emit("data", Buffer.from("%exit\n"));
    await vi.advanceTimersByTimeAsync(2_000); expect(mocks.spawn).toHaveBeenCalledTimes(2); expect(replacement.kill).not.toHaveBeenCalled();
  });

  it.each(["stdout", "stdin-write"])("%s transport error retires only its owner and keeps bounded fallback", async kind => {
    fallback(); const { proc, manager } = opened();
    if (kind === "stdin-write") proc.stdin.write.mockImplementation((_data, callback) => {
      (callback as (error: Error) => void)(new Error("EPIPE")); return false;
    });
    const result = manager.capturePane(); void result.catch(() => {});
    if (kind === "stdout") proc.stdout.emit("error", new Error("read failure"));
    expect(proc.kill).toHaveBeenCalledOnce(); expect(await result).toBe("fallback\n");
    await vi.advanceTimersByTimeAsync(4_000); expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("respects minimum reconnect delay after natural close and no-child failure", async () => {
    const { proc } = opened(); proc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(1_999); expect(mocks.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(mocks.spawn).toHaveBeenCalledTimes(2);
    const failed = processes[1]; (failed as any).pid = undefined; failed.emit("error", new Error("ENOENT"));
    await vi.advanceTimersByTimeAsync(2_000); expect(mocks.spawn).toHaveBeenCalledTimes(3);
  });

  it("validates attempt deadline at receipt even when timer has not run", async () => {
    fallback(); const { proc, manager } = opened(); const result = manager.capturePane();
    const now = vi.spyOn(performance, "now").mockReturnValue(2_001); answer(proc, "late\n");
    expect(await result).toBe("fallback\n"); expect(proc.kill).toHaveBeenCalled(); now.mockRestore();
  });

  it.each([500, 501])("does not write a read if nonce preparation reaches its attempt deadline (%sms)", async now => {
    fallback(); const { proc, manager } = opened();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    mocks.randomUUID.mockImplementationOnce(() => { clock.mockReturnValue(now); return "expired"; });
    const result = manager.capturePane(1_000); void result.catch(() => {});
    expect(proc.stdin.write).not.toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalledOnce();
    expect(await result).toBe("fallback\n");
    expect(mocks.execFile.mock.calls[0][2].timeout).toBe(1_000 - now);
    clock.mockRestore();
  });

  it("still writes a read prepared just before its deadline", async () => {
    const { proc, manager } = opened(); const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    mocks.randomUUID.mockImplementationOnce(() => { clock.mockReturnValue(499); return "fresh"; });
    const result = manager.capturePane(1_000);
    expect(proc.stdin.write).toHaveBeenCalledOnce(); answer(proc, "fresh\n");
    expect(await result).toBe("fresh\n"); expect(proc.kill).not.toHaveBeenCalled(); clock.mockRestore();
  });

  it("retains original queued deadline and never submits expired work", async () => {
    fallback(); const { proc, manager } = opened(); const first = manager.capturePane();
    const short = manager.capturePane(100); const rejected = expect(short).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(100); await rejected;
    answer(proc, "first\n"); expect(await first).toBe("first\n"); expect(proc.stdin.write).toHaveBeenCalledTimes(1);
  });

  it("rejects a fallback ACK at the total deadline before the timer callback", async () => {
    let complete!: (error: null, stdout: string) => void;
    mocks.execFile.mockImplementation((_f, _a, _o, callback) => { complete = callback; return processFixture(); });
    const client = new TmuxControlClient("s"); clients.push(client);
    const result = client.read({ kind: "windows", session: "s" }, 100);
    const rejection = expect(result).rejects.toMatchObject({ kind: "timeout" });
    const clock = vi.spyOn(performance, "now").mockReturnValue(100); complete(null, "late\n");
    await rejection; clock.mockRestore();
  });

  it("holds two timed-out fallback children until exit, drops late results", async () => {
    const children: Proc[] = []; const callbacks: Array<(error: null, out: string) => void> = [];
    mocks.execFile.mockImplementation((_f, _a, _o, cb) => { const child = processFixture(); children.push(child); callbacks.push(cb); return child; });
    const client = new TmuxControlClient("s"); clients.push(client);
    for (let i = 0; i < 2; i++) {
      const result = client.read({ kind: "windows", session: "s" }, 100); const assertion = expect(result).rejects.toMatchObject({ kind: "timeout" });
      await vi.advanceTimersByTimeAsync(100); await assertion;
    }
    const third = client.read({ kind: "windows", session: "s" }, 1_000); void third.catch(() => {});
    await vi.advanceTimersByTimeAsync(100); expect(mocks.execFile).toHaveBeenCalledTimes(2);
    children[0].emit("exit", 0); expect(mocks.execFile).toHaveBeenCalledTimes(3);
    callbacks[0](null, "stale\n"); callbacks[2](null, "third\n"); expect(await third).toBe("third\n");
    expect(mocks.execFile.mock.calls[2][2]).toMatchObject({ timeout: 900, maxBuffer: TMUX_READ_MAX_BYTES });
  });

  it.each(["error", "timeout"])("retains live fallback owners after %s callbacks across stop/start and late events", async mode => {
    const children: Proc[] = []; const callbacks: Array<(error: Error | null, out: string) => void> = [];
    mocks.execFile.mockImplementation((_f, _a, _o, callback) => {
      const child = processFixture(); children.push(child); callbacks.push(callback); return child;
    });
    const client = new TmuxControlClient("s"); clients.push(client);
    const failure = Object.assign(new Error("kill denied"), { code: "EPERM" });
    for (let i = 0; i < 2; i++) {
      const result = client.read({ kind: "windows", session: "s" }, 100);
      const assertion = expect(result).rejects.toMatchObject({ kind: mode === "timeout" ? "timeout" : "transport" });
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(100);
      callbacks[i](failure, ""); await assertion;
    }
    expect((client as any).reads.physical.size).toBe(2);
    const queued = client.read({ kind: "windows", session: "s" }); void queued.catch(() => {});
    const stopped = expect(queued).rejects.toMatchObject({ kind: "stopped" });
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
    client.stop(); await stopped; client.start();
    const next = client.read({ kind: "windows", session: "s" }); void next.catch(() => {});
    callbacks[0](null, "late\n"); children[1].emit("error", failure);
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
    children[0].emit("exit", 0); expect(mocks.execFile).toHaveBeenCalledTimes(3);
    callbacks[2](null, "next\n"); expect(await next).toBe("next\n");
    const fourth = client.read({ kind: "windows", session: "s" }); void fourth.catch(() => {});
    children[0].emit("close", 0); callbacks[0](failure, "late\n");
    expect(mocks.execFile).toHaveBeenCalledTimes(3);
    expect((client as any).reads.physical.size).toBe(2);
    children[1].emit("close", 0); expect(mocks.execFile).toHaveBeenCalledTimes(4);
    callbacks[3](null, "fourth\n"); expect(await fourth).toBe("fourth\n");
  });

  it("frees a confirmed no-child spawn failure without needing an exit event", async () => {
    const failure = Object.assign(new Error("spawn denied"), { code: "EMFILE" });
    mocks.execFile.mockImplementation((_f, _a, _o, callback) => {
      const child = processFixture(); (child as any).pid = undefined;
      queueMicrotask(() => callback(failure, "")); return child;
    });
    const client = new TmuxControlClient("s"); clients.push(client);
    for (let i = 0; i < 4; i++) {
      await expect(client.read({ kind: "windows", session: "s" })).rejects.toMatchObject({ kind: "transport", code: "EMFILE", cause: failure });
      expect((client as any).reads.physical.size).toBe(0);
    }
    expect(mocks.execFile).toHaveBeenCalledTimes(4);
  });

  it("bounds the queue and rejects reads at stop without rearming on old ACK", async () => {
    const { client, proc } = opened(); const results: Promise<unknown>[] = [];
    for (let i = 0; i < TMUX_READ_QUEUE_LIMIT; i++) results.push(client.read({ kind: "windows", session: "s" }).catch(error => error));
    await expect(client.read({ kind: "windows", session: "s" })).rejects.toMatchObject({ kind: "limit" });
    client.stop(); expect((await Promise.all(results)).every((result: any) => result.kind === "stopped")).toBe(true);
    await expect(client.read({ kind: "windows", session: "s" })).rejects.toMatchObject({ kind: "stopped" });
    proc.stdout.emit("data", Buffer.from("%begin 1 1 0\n%end 1 1 0\n")); expect(proc.stdin.write).toHaveBeenCalledTimes(1);
  });
});

describe("#1401 real daemon handlers and registration fences", () => {
  it("real lane saturation defers a real health tick without crash, kill or respawn", async () => {
    const { client, manager } = opened(); const { d, logger } = daemonFixture(manager, client);
    d.config.restart_policy.max_retries = 2;
    const lane = new TmuxReadLane(getTmuxSocketName(), {
      ready: () => true, execute: () => new Promise(() => {}), retire: vi.fn(),
    });
    (client as any).reads = lane;
    const publish = vi.spyOn(d, "setProcessStatus");
    const kill = vi.spyOn(TmuxManager.prototype, "killWindow").mockResolvedValue();
    d.checkpointSessionId = vi.fn().mockResolvedValue(undefined);
    d.resetTranscriptBeforeAdmission = vi.fn().mockResolvedValue(true);
    d.writeRotationSnapshot = vi.fn(); d.appendCrashHistory = vi.fn();
    d.spawnClaudeWindow = vi.fn().mockResolvedValue(true);
    // Cold server probes and potential orphan cleanup are inert. The health
    // port itself remains real and is saturated, rather than mocked rejected.
    mocks.execFile.mockImplementation((...args: any[]) => {
      const argv = args[1] as string[]; const callback = args.at(-1); const child = processFixture();
      const output = argv.includes("list-windows") ? "@1|||fixture\n" : argv.includes("display-message") ? "123\n" : "";
      queueMicrotask(() => { child.emit("exit", 0); callback(null, output, ""); child.emit("close", 0); });
      return child;
    });
    d.startHealthCheck(); await vi.advanceTimersByTimeAsync(29_999);
    const pending = Array.from({ length: TMUX_READ_QUEUE_LIMIT }, () => lane.read(tmuxReadArgs({ kind: "windows", session: "s" }), 120_000).catch(error => error));
    await vi.advanceTimersByTimeAsync(5_001);
    expect(logger.warn).toHaveBeenCalledWith({ failures: 1 }, expect.stringContaining("window list unavailable"));
    expect(publish).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
    expect(d.spawnClaudeWindow).not.toHaveBeenCalled(); expect(d.appendCrashHistory).not.toHaveBeenCalled();
    expect(d.windowQueryFailureTicks).toBe(1);
    client.stop(); await Promise.all(pending);
  });

  it.each([
    ["EMFILE", "transport"], ["EAGAIN", "transport"], ["ENOENT", "transport"],
    ["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "limit"], ["killed", "timeout"], ["no-code", "transport"],
  ])("fallback %s keeps errno/cause and never retires a healthy registration", async (code, kind) => {
    const failure = Object.assign(new Error("query uncertain"), {
      ...(code === "killed" ? { killed: true, signal: "SIGTERM" } : code === "no-code" ? {} : { code }), stderr: "inert diagnostic",
    });
    mocks.execFile.mockImplementation((_f, _a, _o, callback) => {
      const child = processFixture();
      if (["EMFILE", "EAGAIN", "ENOENT", "no-code"].includes(code)) (child as any).pid = undefined;
      queueMicrotask(() => { if (child.pid !== undefined) child.emit("exit", 1); callback(failure, ""); });
      return child;
    });
    const client = new TmuxControlClient("s"); clients.push(client);
    const error = await client.read({ kind: "windows", session: "s" }).catch(error => error);
    expect(error).toMatchObject({ kind, cause: failure });
    if ("code" in failure) expect(error.code).toBe(code);
    for (let i = 0; i < 3; i++) await client.registerWindow("@1");
    expect((client as any).registeredWindows.has("@1")).toBe(true);
    expect((client as any).resolveFailures.has("@1")).toBe(false);
  });

  it("real error monitor and state capture use control reads without children", async () => {
    const { client, proc, manager } = opened(); const { d } = daemonFixture(manager, client);
    d.startErrorMonitor(); await vi.advanceTimersByTimeAsync(5_000);
    answer(proc, "@1|||fixture\n"); await tick(); answer(proc, "READY\n"); await tick();
    expect(d.getInteractionSnapshot().observedAt).not.toBeNull();
    d.startInstanceStateMonitor(); answer(proc, "READY\n"); await tick();
    expect(d.getInstanceState()).toBe("idle");
    expect(mocks.execFile).not.toHaveBeenCalled(); expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it.each(["spawnGeneration", "launchFenceEpoch", "tmux"])("drops stale health result after %s changes", async field => {
    const { client, proc, manager } = opened(); const { d } = daemonFixture(manager, client);
    const publish = vi.spyOn(d, "setProcessStatus"); const kill = vi.spyOn(manager, "killWindow");
    d.startHealthCheck(); await vi.advanceTimersByTimeAsync(30_000);
    if (field === "tmux") d.tmux = {};
    else d[field]++;
    answer(proc, "1 137\n"); await tick();
    if (proc.stdin.write.mock.calls.length > 1) { answer(proc, "old crash output\n"); await tick(); }
    expect(publish).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled(); expect(d.logPaneDeath).not.toHaveBeenCalled();
  });

  it.each(["launchFenceEpoch", "tmux"])("drops stale state capture after %s changes and preserves a healthy control", async field => {
    const { client, proc, manager } = opened(); const { d } = daemonFixture(manager, client);
    d.startInstanceStateMonitor(); const publish = vi.spyOn(d, "applyInstanceStateSnapshot");
    if (field === "tmux") d.tmux = {}; else d.launchFenceEpoch++;
    answer(proc, "READY\n"); await tick(); expect(publish).not.toHaveBeenCalled();
    const next = manager.capturePane(1_000); answer(proc, "new\n"); expect(await next).toBe("new\n");
  });

  it("registration ABA cannot apply the first mapping to a re-registered window", async () => {
    const { client, proc } = opened(); const first = client.registerWindow("@1");
    client.unregisterWindow("@1"); const second = client.registerWindow("@1");
    answer(proc, "%old\n"); await first; await tick();
    expect((client as any).paneToWindow.has("%old")).toBe(false);
    answer(proc, "%new\n"); await second;
    expect((client as any).paneToWindow.get("%new")).toBe("@1");
  });

  it("registration transport uncertainty does not count as a missing window", async () => {
    const { client, proc } = opened();
    for (let i = 0; i < 3; i++) {
      const request = client.registerWindow("@1"); client.stop(); await request; client.start();
    }
    expect((client as any).registeredWindows.has("@1")).toBe(true);
    expect((client as any).resolveFailures.has("@1")).toBe(false);
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it("three genuine command failures still retire a dead registration", async () => {
    const { client, proc } = opened();
    for (let i = 0; i < 3; i++) {
      const request = client.registerWindow("@1"); answer(proc, "no pane\n", true); await request;
    }
    expect((client as any).registeredWindows.has("@1")).toBe(false);
  });

  it("recovery result after launch change cannot rebind the manager", async () => {
    const { client, proc, manager } = opened(); const { d } = daemonFixture(manager, client);
    const result = d.recoverWindow(); d.launchFenceEpoch++;
    answer(proc, "@2|||fixture\n"); await tick();
    if (proc.stdin.write.mock.calls.length > 1) answer(proc, "%old\n");
    expect(await result).toBeUndefined(); expect(d.tmux).toBe(manager);
  });

  it("health recheck cannot accept a new generation after its delay", async () => {
    const { client, proc, manager } = opened(); const { d } = daemonFixture(manager, client);
    d.startHealthCheck(); await vi.advanceTimersByTimeAsync(30_000);
    answer(proc, ""); await tick(); d.spawnGeneration++;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(proc.stdin.write).toHaveBeenCalledTimes(1); expect(d.logPaneDeath).not.toHaveBeenCalled();
  });

  it("window recovery constructs a manager with the same port", async () => {
    fallback("unexpected fallback\n");
    const { client, proc, manager } = opened(); const { d, dir } = daemonFixture(manager, client);
    const recover = d.recoverWindow(); answer(proc, "@2|||fixture\n"); await tick();
    answer(proc, "%2\n"); expect(await recover).toBe("@2");
    const capture = d.tmux.capturePane(); answer(proc, "recovered\n"); expect(await capture).toBe("recovered\n");
    expect(mocks.execFile).not.toHaveBeenCalled(); expect(dir).toContain("agend-control-query-");
  });
});

describe("#1401 deterministic 60s monitor benchmark", () => {
  it("counts read spawns and synchronous submission stretches over a whole staggered sweep", async () => {
    const n = 40;
    const results: Array<{ mode: string; instances: number; windowMs: number; readSpawns: number; maxSubmissionMs: number; medianSubmissionMs: number; p95SubmissionMs: number }> = [];
    for (const mode of ["legacy", "control"] as const) {
      const { client, proc } = opened();
      const windows = Array.from({ length: n }, (_, i) => `@${i + 1}|||fixture-${i}\n`).join("");
      let spawns = 0, maximum = 0, measuring = false;
      const timings: number[] = [];
      // Simulated native fork cost. hrtime measures wall time independently of fake timers.
      const startCostNs = 1_000_000n;
      mocks.execFile.mockImplementation((...args: unknown[]) => {
        if (measuring) spawns++;
        const started = process.hrtime.bigint();
        while (process.hrtime.bigint() - started < startCostNs) { /* inert injected native-start cost */ }
        const argv = args[1] as string[];
        const callback = args.at(-1) as (e: null, out: string, stderr: string) => void;
        queueMicrotask(() => callback(null, argv.includes("list-windows") ? windows : argv.includes("list-panes") ? "0 \n" : "READY\n", ""));
        return processFixture();
      });
      proc.stdin.write.mockImplementation((command: string) => {
        const out = command.includes("'list-windows'") ? windows : command.includes("'list-panes'") ? "0 \n" : "READY\n";
        queueMicrotask(() => answer(proc, out));
        return true;
      });
      const group: any[] = [];
      for (let i = 0; i < n; i++) {
        const manager = new TmuxManager("s", `@${i + 1}`, undefined, mode === "control" ? client : undefined);
        for (const name of ["capturePane", "isWindowAlive", "getPaneStatus"] as const) {
          const original = manager[name].bind(manager) as (...args: any[]) => any;
          vi.spyOn(manager, name).mockImplementation(((...args: any[]) => {
            const before = process.hrtime.bigint(); const result = original(...args);
            if (measuring) {
              const duration = Number(process.hrtime.bigint() - before) / 1e6;
              maximum = Math.max(maximum, duration); timings.push(duration);
            }
            return result;
          }) as any);
        }
        const { d } = daemonFixture(manager, client, `fixture-${i}`); group.push(d);
        d.startErrorMonitor(); d.startHealthCheck(); d.startInstanceStateMonitor();
      }
      await vi.advanceTimersByTimeAsync(30_001);
      measuring = true;
      // Six declared output-driven captures per instance, not a production rate estimate.
      const outputTimer = setInterval(() => {
        for (const d of group) void d.captureAndEvaluateInstanceState("output_probe");
      }, 10_000);
      await vi.advanceTimersByTimeAsync(60_000);
      clearInterval(outputTimer); measuring = false;
      timings.sort((a, b) => a - b);
      results.push({ mode, instances: n, windowMs: 60_000, readSpawns: spawns, maxSubmissionMs: maximum,
        medianSubmissionMs: timings[Math.floor(timings.length / 2)], p95SubmissionMs: timings[Math.floor(timings.length * .95)] });
      for (const d of group) { d.stopInstanceStateMonitor(); clearInterval(d.errorMonitorTimer); clearTimeout(d.healthCheckTimer); }
      client.stop();
    }
    expect(results[0].readSpawns).toBe(n * (24 + 2 + 1 + 6));
    expect(results[1].readSpawns).toBe(0);
    if (process.env.AGEND_1401_BENCHMARK_PATH) writeFileSync(process.env.AGEND_1401_BENCHMARK_PATH, JSON.stringify({
      fixtureNativeStartMs: 1, phase: "(30.001s,90.001s]; sweep60–89.25s included", results,
      note: "maxSubmissionMs is real wall time of one synchronous API submission, not production loop/CPU attribution",
    }, null, 2));
  });
});
