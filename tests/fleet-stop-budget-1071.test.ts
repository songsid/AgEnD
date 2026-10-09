import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { FLEET_STOP_TIMEOUT_MS, stopDetachedOwner, systemdStopTimeoutMs, type DetachedOwnerState } from "../src/fleet-stop-budget.js";
import { renderSystemdUnit, ensureSystemdUnitHardening } from "../src/service-installer.js";
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";
import { KiroBackend } from "../src/backend/kiro.js";
import { TEST_KIRO_COMPAT } from "./helpers/kiro-compat.js";
import pino from "pino";
import type { Logger } from "../src/logger.js";
vi.mock("../src/sd-notify.js", () => ({ sdNotify: vi.fn(), sdNotifyBlocking: vi.fn() }));
const roots: string[] = [];
function scratch() {
  const parent = join(process.cwd(), ".artifacts"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "stop1071-")); roots.push(root); return root;
}
const vars = { label: "agend-test-1071", execPath: "/private/agend/dist/cli.js", workingDirectory: "/private", logPath: "/private/log" };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("detached outer grace and physical exit", () => {
  async function expectStopSuccess(deps: import("../src/fleet-stop-budget.js").DetachedStopDeps) {
    const outcome = await stopDetachedOwner(deps).then(() => ({ ok: true }), error => ({ ok: false, error }));
    expect(outcome).toEqual({ ok: true });
  }
  async function expectStopFailure(deps: import("../src/fleet-stop-budget.js").DetachedStopDeps, message: string) {
    let failure: unknown;
    await stopDetachedOwner(deps).catch(error => { failure = error; });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(message);
  }
  function rig() {
    let now = 0, state: DetachedOwnerState = "fleet";
    const signal = vi.fn();
    const sleep = vi.fn(async (ms: number) => { now += ms; });
    return { deps: { inspect: () => state, now: () => now, sleep, signal }, signal, sleep,
      setState: (value: DetachedOwnerState) => { state = value; }, getNow: () => now };
  }
  it("allows a 66s multi-batch shutdown without a forced kill", async () => {
    const r = rig();
    // Use an independent monotonic clock: Date.now is never consulted.
    let clock = 0; r.deps.now = () => clock;
    r.sleep.mockImplementation(async ms => { clock += ms; if (clock >= 66_600) r.setState("gone"); });
    vi.spyOn(Date, "now").mockImplementation(() => { throw Error("wall clock budget"); });
    await expectStopSuccess(r.deps);
    expect(r.signal.mock.calls).toEqual([["SIGTERM"]]); expect(clock).toBe(67_000);
  });
  it("does not issue SIGKILL before the five-minute deadline; waits for actual exit afterward", async () => {
    const r = rig(); let killedAt = -1;
    r.signal.mockImplementation(signal => { if (signal === "SIGKILL") killedAt = r.getNow(); });
    const originalSleep = r.sleep.getMockImplementation()!;
    r.sleep.mockImplementation(async ms => { await originalSleep(ms); if (killedAt >= 0 && r.getNow() >= killedAt + 1_000) r.setState("gone"); });
    await expectStopSuccess(r.deps);
    expect(killedAt).toBe(300_000); expect(r.getNow()).toBe(301_000);
    expect(r.signal.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });
  it("held exit after a successful kill is not replacement admission", async () => {
    const r = rig(); await expectStopFailure(r.deps, "refusing to start a duplicate");
    expect(r.signal.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]); expect(r.getNow()).toBe(305_000);
  });
  it.each(["unknown", "other", "gone"] as const)("initial %s never receives a signal", async state => {
    const r = rig(); r.setState(state);
    if (state === "unknown") await expectStopFailure(r.deps, "Cannot confirm");
    else await expectStopSuccess(r.deps);
    expect(r.signal).not.toHaveBeenCalled();
  });
  it.each(["unknown", "other"] as const)("identity becomes %s while waiting: no late kill", async state => {
    const r = rig(); r.sleep.mockImplementation(async () => { r.setState(state); });
    if (state === "unknown") await expectStopFailure(r.deps, "Cannot confirm"); else await expectStopSuccess(r.deps);
    expect(r.signal.mock.calls).toEqual([["SIGTERM"]]);
  });
});

describe("managed systemd grace", () => {
  it("shares the five-minute outer budget with the real rendered unit", () => {
    expect(FLEET_STOP_TIMEOUT_MS).toBe(300_000);
    const unit = renderSystemdUnit(vars); expect(unit).toMatch(/^TimeoutStopSec=300$/m); expect(unit).toMatch(/^KillMode=mixed$/m);
  });
  it.each(["60", "60s", "1min"])("upgrades the shipped legacy %s on disk", legacy => {
    const path = join(scratch(), "unit.service"); writeFileSync(path, renderSystemdUnit(vars).replace("TimeoutStopSec=300", `TimeoutStopSec=${legacy}`));
    const result = ensureSystemdUnitHardening(path, { dropInPaths: [] });
    expect(result).toMatchObject({ kind: "ok", directives: { TimeoutStopSec: "upgraded" } });
    expect(readFileSync(path, "utf8")).toMatch(/^TimeoutStopSec=300$/m);
  });
  it("preserves a custom timeout, a drop-in, and duplicate assignments", () => {
    for (const mode of ["custom", "drop", "duplicate"]) {
      const root = scratch(), path = join(root, "unit.service"), drop = join(root, "override.conf");
      const text = renderSystemdUnit(vars).replace("TimeoutStopSec=300", mode === "custom" ? "TimeoutStopSec=90" : mode === "duplicate" ? "TimeoutStopSec=60\nTimeoutStopSec=90" : "TimeoutStopSec=60");
      writeFileSync(path, text); writeFileSync(drop, "[Service]\nTimeoutStopSec=30\n");
      expect(ensureSystemdUnitHardening(path, { dropInPaths: mode === "drop" ? [drop] : [] })).toMatchObject({ kind: "ok", directives: { TimeoutStopSec: "custom" } });
      expect(readFileSync(path, "utf8")).toBe(text);
    }
  });
  it.each([["5min", 300_000], ["5min 500ms", 300_500], ["1h 2min 3s", 3_723_000], ["300s", 300_000], ["500us", 0.5], ["infinity", Infinity]] as const)("parses loaded %s", (input, expected) => { expect(systemdStopTimeoutMs(input)).toBe(expected); });
  it.each(["", "300", "5min junk", "-1s", "NaN", "1e6s", "5minutes", "5 min"])("rejects unproven loaded value %s", input => { expect(systemdStopTimeoutMs(input)).toBeNull(); });
});

it("real stopAll + real busy-Kiro stop takes three batches, within the rendered outer grace", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  const root = scratch(); const fm = new FleetManager(root), log = pino({ level: "silent" }) as Logger;
  const keyCalls: Array<{ name: string; key: string }> = [];
  const kills: Array<{ name: string; signal: string }> = [];
  for (let i = 0; i < 33; i++) {
    const name = `kiro-${i}`, dir = join(root, name); mkdirSync(dir);
    const backend = new KiroBackend(dir, TEST_KIRO_COMPAT);
    vi.spyOn(backend, "cleanup").mockImplementation(() => {});
    const daemon = new Daemon(name, { backend: "kiro-cli", working_directory: dir, log_level: "error", restart_policy: { max_retries: 1, backoff: "exponential", reset_after: 300 } }, dir, false, backend, undefined, log);
    (daemon as any).tmux = { getWindowId: () => `@${i}`, getPaneStatus: vi.fn(async () => ({ alive: true })),
      sendKeys: vi.fn(async (key: string) => { keyCalls.push({ name, key }); return true; }), sendSpecialKey: vi.fn(async () => true), killWindow: vi.fn(async () => {}) };
    vi.spyOn(daemon as any, "checkpointSessionId").mockResolvedValue(undefined);
    vi.spyOn(daemon as any, "paneReadinessForDelivery").mockResolvedValue("busy");
    vi.spyOn(daemon as any, "waitForPaneReadyForDelivery").mockImplementation(async () => { await new Promise(r => setTimeout(r, 15_000)); return true; });
    vi.spyOn(daemon as any, "killProcessTree").mockImplementation(async (signal: unknown) => { kills.push({ name, signal: String(signal) }); });
    (fm as any).daemons.set(name, daemon);
  }
  const began = performance.now(); let done = false;
  const stopping = fm.stopAll().then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(done).toBe(false); expect((fm as any).daemons.size).toBe(3);
  await vi.runAllTimersAsync(); await stopping;
  const elapsed = performance.now() - began;
  writeFileSync(join(process.cwd(), ".artifacts/multi-batch-stop-proof.json"), JSON.stringify({ instances: 33, concurrency: 15, batches: 3, elapsedMs: elapsed, realMethods: ["FleetManager.stopAll", "Daemon.stop", "KiroBackend quit"], inertBoundaries: ["tmux", "checkpoint", "process tree signals", "15s readiness wait"] }, null, 2));
  expect(elapsed).toBeGreaterThan(60_000);
  const stopSeconds = Number(/^TimeoutStopSec=(\d+)$/m.exec(renderSystemdUnit(vars))![1]);
  expect(elapsed).toBeLessThan(stopSeconds * 1000);
  expect(keyCalls.filter(c => c.key === "/quit")).toHaveLength(33);
  expect(kills.filter(c => c.signal === "SIGTERM")).toHaveLength(33);
  expect(kills.filter(c => c.signal === "SIGKILL")).toHaveLength(33);
  expect((fm as any).daemons.size).toBe(0);
});

// Execute the exact detached branch of the CLI. Process, files, selected runtime
// and spawn are inert; it cannot launch a fleet or inspect the host's processes.
function detachedCliRig(stop: (deps: import("../src/fleet-stop-budget.js").DetachedStopDeps) => Promise<void>, changedPidFile = false) {
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const begin = source.indexOf("    // 4. Detached process tracked"), end = source.indexOf('\n  });', begin);
  const branch = source.slice(begin, end);
  const ast = ts.createSourceFile("cli.ts", source, ts.ScriptTarget.ES2022, true);
  let refuses: ts.Expression | undefined;
  function find(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "refuses") refuses = node.initializer;
    ts.forEachChild(node, find);
  }
  find(ast); if (!refuses) throw Error("Restart refusal helper moved");
  const start = vi.fn(() => ({ unref: vi.fn() })), unlink = vi.fn();
  const process = { execPath: "/private/node", exitCode: 0, kill: vi.fn() }, guard = { guardDetached: vi.fn<() => { ok: true } | { ok: false; reason: string }>(() => ({ ok: true })) };
  let reads = 0; let birth: string | null = "birth-1", command = "node /private/cli.js fleet start", exited = () => false; const console = { log: vi.fn(), error: vi.fn() };
  const context = createContext({ process, console, performance, FLEET_STOP_TIMEOUT_MS, stopDetachedOwner: stop,
    pidPath: "/private/fleet.pid", existsSync: () => true, readFileSync: () => ++reads > 2 && changedPidFile ? "999" : "123",
    detachedProcessStart: () => birth, detachedProcessExited: () => exited(), readProcessCommandLine: () => command, isFleetStartCommandLine: (value: string) => value === "node /private/cli.js fleet start",
    guard, expectation: { ok: true, expected: {} }, guardDeps: {}, opts: { force: false }, unlinkSync: unlink,
    selfCommand: () => ({ command: "/private/node", args: ["/private/cli.js", "fleet", "start"] }), spawn: start, setTimeout });
  runInContext(ts.transpileModule(`const refuses = ${refuses.getText(ast)}; async function action() { ${branch} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, context);
  return { action: runInContext("action", context) as () => Promise<void>, start, unlink, process, guard, setBirth: (next: string | null) => { birth = next; }, setCommand: (next: string) => { command = next; }, setExitProof: (next: () => boolean) => { exited = next; }, console, context };
}
it("CLI awaits the proven physical exit, then rechecks runtime before spawning once", async () => {
  let release!: () => void; const wait = new Promise<void>(r => { release = r; }); const h = detachedCliRig(() => wait);
  const running = h.action(); await Promise.resolve(); expect(h.start).not.toHaveBeenCalled(); expect(h.unlink).not.toHaveBeenCalled();
  release(); await running; expect(h.start).toHaveBeenCalledOnce(); expect(h.guard.guardDetached).toHaveBeenCalledTimes(2);
});
it("CLI failure or a new PID-file owner never unlinks or starts", async () => {
  for (const h of [detachedCliRig(async () => { throw Error("still alive"); }), detachedCliRig(async () => {}, true)]) {
    await h.action(); expect(h.process.exitCode).toBe(1); expect(h.start).not.toHaveBeenCalled(); expect(h.unlink).not.toHaveBeenCalled();
  }
});

it("CLI's real wait rejects a recycled PID now occupied by another fleet", async () => {
  let clock = 0;
  const h = detachedCliRig(async deps => {
    await stopDetachedOwner({ ...deps, now: () => clock, sleep: async ms => { clock += ms; h.setBirth("birth-2"); } });
  });
  await h.action(); expect(h.process.exitCode).toBe(1); expect(h.start).not.toHaveBeenCalled(); expect(h.unlink).not.toHaveBeenCalled();
  expect(h.process.kill.mock.calls.filter(c => c[1] !== 0)).toEqual([[123, "SIGTERM"]]);
});

it("CLI cannot treat a changed command on the same live process as physical exit", async () => {
  let clock = 0;
  const h = detachedCliRig(async deps => {
    await stopDetachedOwner({ ...deps, now: () => clock, sleep: async ms => { clock += ms; h.setCommand("inert unrelated command"); } });
  });
  await h.action(); expect(h.process.exitCode).toBe(1); expect(h.start).not.toHaveBeenCalled(); expect(h.unlink).not.toHaveBeenCalled();
  expect(h.process.kill.mock.calls.filter(c => c[1] !== 0)).toEqual([[123, "SIGTERM"]]);
});

it("a recycled PID with an unrelated new birth does prove the original fleet exited", async () => {
  let clock = 0;
  const h = detachedCliRig(async deps => {
    await stopDetachedOwner({ ...deps, now: () => clock, sleep: async ms => { clock += ms; h.setBirth("birth-2"); h.setCommand("inert unrelated command"); } });
  });
  await h.action(); expect(h.process.exitCode).toBe(0); expect(h.start).toHaveBeenCalledOnce();
  expect(h.process.kill.mock.calls.filter(c => c[1] !== 0)).toEqual([[123, "SIGTERM"]]);
});

function startProbe(platform: string, raw: string | Error, ps: string | Error = "", functionName = "detachedProcessStart") {
  const source = readFileSync(new URL("../src/fleet-stop-budget.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("budget.ts", source, ts.ScriptTarget.ES2022, true);
  const fn = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === functionName)!;
  const read = vi.fn(() => { if (raw instanceof Error) throw raw; return raw; });
  const execute = vi.fn(() => { if (ps instanceof Error) throw ps; return ps; });
  const context = createContext({ process: { platform }, readFileSync: read, execFileSync: execute });
  const text = fn.getText(ast).replace(/^export /, "");
  runInContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { value: runInContext(`${functionName}(123)`, context), read, execute };
}
it("Linux birth proof parses comm parentheses and exact start ticks without spawning ps", () => {
  const raw = `123 (a b)c) S ${Array.from({ length: 18 }, () => "0").join(" ")} 98765 0`;
  const p = startProbe("linux", raw); expect(p.value).toBe("98765"); expect(p.execute).not.toHaveBeenCalled();
  expect(startProbe("linux", "bad stat").value).toBeNull(); expect(startProbe("linux", Error("unreadable")).value).toBeNull();
});
it("macOS birth proof uses bounded ps and keeps an unreadable identity unknown", () => {
  const p = startProbe("darwin", "never read", " Fri Oct 9 14:00:00 2026\n");
  expect(p.value).toBe("Fri Oct 9 14:00:00 2026"); expect(p.read).not.toHaveBeenCalled();
  expect(p.execute).toHaveBeenCalledWith("ps", ["-p", "123", "-o", "lstart="], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] });
  expect(startProbe("darwin", "unused", " ").value).toBeNull(); expect(startProbe("darwin", "unused", Error("unreadable")).value).toBeNull();
});

it("only readable Linux Z/X is exit proof; live, malformed and unreadable status remain unproven", () => {
  const stat = (state: string, pid = 123) => `${pid} (a b)c) ${state} ${Array.from({ length: 18 }, () => "0").join(" ")} 98765 0`;
  for (const state of ["Z", "X"]) expect(startProbe("linux", stat(state), "", "detachedProcessExited").value).toBe(true);
  for (const raw of [stat("S"), stat("Z", 999), "123 (a) Z", "malformed", Error("unreadable")]) expect(startProbe("linux", raw, "", "detachedProcessExited").value).toBe(false);
  const darwin = startProbe("darwin", "unused", "", "detachedProcessExited");
  expect(darwin.value).toBe(false); expect(darwin.read).not.toHaveBeenCalled(); expect(darwin.execute).not.toHaveBeenCalled();
});

it.each(["start", "command"] as const)("a process exiting between liveness and unreadable %s is rechecked as gone", async field => {
  let clock = 0, afterWait = false, probes = 0;
  const h = detachedCliRig(async deps => {
    await stopDetachedOwner({ ...deps, now: () => clock, sleep: async ms => {
      clock += ms; afterWait = true;
      if (field === "start") h.setBirth(null); else h.setCommand("");
    } });
  });
  h.process.kill.mockImplementation((...args) => {
    if (afterWait && args[1] === 0 && ++probes >= 2) throw Object.assign(Error("exited"), { code: "ESRCH" });
  });
  await h.action(); expect(h.start).toHaveBeenCalledOnce(); expect(h.process.exitCode).toBe(0);
});

it.each(["start", "command"] as const)("an unreaped zombie emerging during the %s read is rechecked as exited", async field => {
  let clock = 0, exitReads = 0;
  const h = detachedCliRig(async deps => {
    await stopDetachedOwner({ ...deps, now: () => clock, sleep: async ms => {
      clock += ms;
      if (field === "start") h.setBirth(null); else h.setCommand("");
      h.setExitProof(() => ++exitReads >= 2);
    } });
  });
  await h.action(); expect(h.start).toHaveBeenCalledOnce(); expect(h.process.exitCode).toBe(0);
  expect(h.process.kill.mock.calls.filter(c => c[1] !== 0)).toEqual([[123, "SIGTERM"]]);
});

it("an empty command on the captured birth only waits until readable exit proof", async () => {
  let clock = 0;
  const h = detachedCliRig(async deps => {
    await stopDetachedOwner({ ...deps, now: () => clock, sleep: async ms => {
      clock += ms; h.setCommand(""); h.setExitProof(() => clock >= 1500);
    } });
  });
  await h.action(); expect(clock).toBe(1500); expect(h.start).toHaveBeenCalledOnce(); expect(h.process.exitCode).toBe(0);
  expect(h.process.kill.mock.calls.filter(c => c[1] !== 0)).toEqual([[123, "SIGTERM"]]);
});

it("a permanently unreadable command on the captured birth never authorizes KILL or replacement", async () => {
  let clock = 0;
  const h = detachedCliRig(async deps => {
    await stopDetachedOwner({ ...deps, now: () => clock, sleep: async ms => { clock += ms; h.setCommand(""); } });
  });
  await h.action(); expect(clock).toBe(FLEET_STOP_TIMEOUT_MS); expect(h.start).not.toHaveBeenCalled(); expect(h.process.exitCode).toBe(1);
  expect(h.process.kill.mock.calls.filter(c => c[1] !== 0)).toEqual([[123, "SIGTERM"]]);
});

it("waiting has no initial signal authority and still needs physical exit after a KILL", async () => {
  const noSignal = vi.fn();
  const initial = await stopDetachedOwner({ inspect: () => "waiting", signal: noSignal, now: () => 0, sleep: async () => {} }).then(() => null, e => e);
  expect(initial instanceof Error).toBe(true); expect(noSignal).not.toHaveBeenCalled();
  let clock = 0, killed = false; const signals: string[] = [];
  const held = await stopDetachedOwner({ inspect: () => killed ? "waiting" : "fleet", signal: signal => { signals.push(signal); if (signal === "SIGKILL") killed = true; }, now: () => clock, sleep: async ms => { clock += ms; } }).then(() => null, e => e);
  expect(held instanceof Error).toBe(true); expect(clock).toBe(FLEET_STOP_TIMEOUT_MS + 5000); expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});

it("CLI's selected runtime changing during the shutdown wait refuses replacement", async () => {
  const h = detachedCliRig(async () => {});
  h.guard.guardDetached.mockReturnValueOnce({ ok: true }).mockReturnValueOnce({ ok: false, reason: "runtime replaced" });
  await h.action(); expect(h.process.exitCode).toBe(1); expect(h.start).not.toHaveBeenCalled(); expect(h.unlink).not.toHaveBeenCalled();
});

it("CLI refuses an unreadable birth identity or EPERM instead of deleting the owner file", async () => {
  const missing = detachedCliRig(async () => {}); missing.setBirth(null);
  const denied = detachedCliRig(async () => {}); denied.process.kill.mockImplementation(() => { throw Object.assign(Error("denied"), { code: "EPERM" }); });
  for (const h of [missing, denied]) {
    await h.action(); expect(h.process.exitCode).toBe(1); expect(h.unlink).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
    expect(h.process.kill.mock.calls.every(c => c[1] === 0)).toBe(true);
  }
});


it("CLI does not signal a recycled owner appearing during the potentially blocking KILL log", async () => {
  let clock = 0;
  const h = detachedCliRig(async deps => {
    await stopDetachedOwner({ ...deps, now: () => clock, sleep: async ms => { clock += ms; } });
  });
  h.console.log.mockImplementation(message => {
    if (String(message).includes("Grace expired")) { h.setBirth("birth-2"); h.setCommand("inert unrelated command"); }
  });
  await h.action();
  expect(h.process.kill.mock.calls.filter(c => c[1] !== 0)).toEqual([[123, "SIGTERM"]]);
  expect(h.start).toHaveBeenCalledOnce(); // captured owner is gone, no new PID publication; recycled process is untouched
});

it("CLI refuses unknown ownership appearing during the KILL log (unchanged live owner control signals once)", async () => {
  for (const revoked of [true, false]) {
    let clock = 0, killed = false;
    const h = detachedCliRig(async deps => {
      await stopDetachedOwner({ ...deps, now: () => clock, sleep: async ms => { clock += ms; } });
    });
    h.setExitProof(() => killed);
    h.console.log.mockImplementation(message => { if (revoked && String(message).includes("Grace expired")) h.setBirth(null); });
    h.process.kill.mockImplementation((_pid, signal) => { if (signal === "SIGKILL") killed = true; });
    await h.action();
    expect(h.process.kill.mock.calls.filter(c => c[1] !== 0)).toEqual(revoked ? [[123, "SIGTERM"]] : [[123, "SIGTERM"], [123, "SIGKILL"]]);
    expect(h.start.mock.calls).toHaveLength(revoked ? 0 : 1);
    expect(h.process.exitCode).toBe(revoked ? 1 : 0);
  }
});

it.each(["changed", "unreadable"] as const)("CLI rechecks %s PID publication after the actual runtime guard's file lookups", async state => {
  const root = scratch(), publication = join(root, "fleet.pid"); writeFileSync(publication, "123");
  const h = detachedCliRig(async () => {});
  h.context.pidPath = publication;
  h.context.existsSync = (path: string) => path === publication;
  h.context.readFileSync = (path: string, encoding: BufferEncoding) => readFileSync(path, encoding);
  const { guardDetached } = await import("../src/restart-guard.js");
  let probes = 0;
  h.guard.guardDetached.mockImplementation(() => guardDetached("/private/node", { node: "/private/node", entry: "/private/cli.js" }, {
    realpath: path => {
      if (++probes === 2) {
        writeFileSync(publication, "999");
        if (state === "unreadable") h.context.readFileSync = () => { throw new Error("publication no longer readable"); };
      }
      return path;
    },
  }));
  await h.action();
  expect(probes).toBe(2); expect(h.process.exitCode).toBe(1);
  expect(h.unlink).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
  expect(readFileSync(publication, "utf8")).toBe("999");
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("CLI refuses a real inaccessible PID publication after the runtime guard", async () => {
  const root = scratch(), publication = join(root, "fleet.pid"); writeFileSync(publication, "123");
  const h = detachedCliRig(async () => {});
  h.context.pidPath = publication;
  h.context.existsSync = existsSync;
  h.context.readFileSync = readFileSync;
  const { guardDetached } = await import("../src/restart-guard.js");
  let probes = 0;
  h.guard.guardDetached.mockImplementation(() => guardDetached("/private/node", { node: "/private/node", entry: "/private/cli.js" }, {
    realpath: path => {
      if (++probes === 2) {
        writeFileSync(publication, "999");
        chmodSync(root, 0o000);
        expect(existsSync(publication)).toBe(false);
        expect(() => readFileSync(publication, "utf8")).toThrow(expect.objectContaining({ code: "EACCES" }));
      }
      return path;
    },
  }));
  try {
    await h.action();
    expect(probes).toBe(2); expect(h.process.exitCode).toBe(1);
    expect(h.unlink).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
  } finally { chmodSync(root, 0o700); }
  expect(readFileSync(publication, "utf8")).toBe("999");
});

it.each(["ENOENT", "unchanged"] as const)("CLI permits a %s PID publication at the final boundary", async state => {
  const root = scratch(), publication = join(root, "fleet.pid"); writeFileSync(publication, "123");
  const h = detachedCliRig(async () => {});
  h.context.pidPath = publication;
  h.context.existsSync = existsSync;
  h.context.readFileSync = readFileSync;
  const { guardDetached } = await import("../src/restart-guard.js");
  let probes = 0;
  h.guard.guardDetached.mockImplementation(() => guardDetached("/private/node", { node: "/private/node", entry: "/private/cli.js" }, {
    realpath: path => { if (++probes === 2 && state === "ENOENT") unlinkSync(publication); return path; },
  }));
  await h.action();
  expect(probes).toBe(2); expect(h.process.exitCode).toBe(0);
  expect(h.unlink).toHaveBeenCalledOnce(); expect(h.start).toHaveBeenCalledOnce();
  expect(existsSync(publication)).toBe(state === "unchanged");
});

it.each(["EACCES", "ENOTDIR", undefined])("CLI refuses failed PID lookup %s even when existsSync returns false", async code => {
  const h = detachedCliRig(async () => {});
  let probes = 0;
  h.guard.guardDetached.mockImplementation(() => {
    if (++probes === 2) {
      h.context.existsSync = () => false;
      h.context.readFileSync = () => { throw Object.assign(new Error("lookup failed"), { code }); };
    }
    return { ok: true };
  });
  await h.action();
  expect(probes).toBe(2); expect(h.process.exitCode).toBe(1);
  expect(h.unlink).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
});
