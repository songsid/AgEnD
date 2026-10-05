import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

// No constructor may discover a real CLI, no real socket, process, or lifecycle.
const hooks = vi.hoisted(() => ({
  forbidden: vi.fn((..._args: unknown[]): never => { throw new Error("Forbidden host IO in #812 sandbox"); }),
  http: null as null | ((req: any, res: any) => void),
}));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  exec: hooks.forbidden, execFile: hooks.forbidden, execSync: hooks.forbidden, execFileSync: hooks.forbidden,
  spawn: hooks.forbidden, spawnSync: hooks.forbidden, fork: hooks.forbidden,
}));
vi.mock("node:net", async original => ({ ...await original<typeof import("node:net")>(),
  createServer: hooks.forbidden, createConnection: hooks.forbidden, connect: hooks.forbidden,
}));
vi.mock("node:http", async original => ({ ...await original<typeof import("node:http")>(),
  createServer: (handler: (req: any, res: any) => void) => {
    hooks.http = handler; return { on: vi.fn(), listen: vi.fn() };
  },
}));
vi.mock("../src/backend/factory.js", () => ({ createBackend: hooks.forbidden }));
vi.mock("../src/topic-commands.js", async original => ({ ...await original<typeof import("../src/topic-commands.js")>(),
  resolveInstanceContext: () => ({ context: null, tokenRatio: null }),
}));
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
vi.mock("../src/logger.js", () => ({ createLogger: () => logger, rotateLogIfNeeded: hooks.forbidden, rotateLogIfNeededAsync: hooks.forbidden }));

import { Daemon, PaneStateMachine } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import { InstanceLifecycle } from "../src/instance-lifecycle.js";
import { ClaudeCodeBackend, claudeBashPermissionActive } from "../src/backend/claude-code.js";
import { OpenCodeBackend } from "../src/backend/opencode.js";
import { CodexBackend } from "../src/backend/codex.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { presentationState } from "../src/interaction-observation.js";
import { setLocale } from "../src/locale.js";

const PERMISSION = readFileSync(new URL("./fixtures/claude-2.1.287-bash-permission-prompt.pane.txt", import.meta.url), "utf8");
const DANGER = readFileSync(new URL("./fixtures/claude-2.1.288-bypass-bash-c-dangerous-rm-prompt.pane.txt", import.meta.url), "utf8");
const CODEX_PICKER = readFileSync(new URL("./fixtures/codex-0157-resume-cwd-picker.pane.txt", import.meta.url), "utf8");
const READY = "READY";
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => {
  hooks.forbidden.mockClear(); hooks.http = null;
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(1_000_000); setLocale("en");
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  const forbidden = hooks.forbidden.mock.calls.length;
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); setLocale("en");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(forbidden, "no real fleet/backend/process/socket/lifecycle").toBe(0);
});

function harness(pane = PERMISSION, dialogs = ClaudeCodeBackend.prototype.getRuntimeDialogs.call({} as any), backendName = "claude-code") {
  const dir = mkdtempSync(join(tmpdir(), "agend-interaction-812-")); dirs.push(dir);
  const backend = {
    binaryName: backendName === "codex" ? "codex" : "claude",
    getRuntimeDialogs: () => dialogs, getErrorPatterns: () => [],
    // Intentionally broad: a menu cursor would look ready to the bare machine.
    getReadyPattern: () => /^(?:READY|[ \t]*❯|[ \t]*›)/m,
    getBusyPattern: () => /WORKING|Working \(/, getCancelKey: () => "Escape",
    cleanup: hooks.forbidden, buildCommand: hooks.forbidden,
  } as any;
  const d = new Daemon("worker", { working_directory: dir, backend: backendName, log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, dir, false, backend, undefined, logger as any) as any;
  const screen = { pane, error: false };
  d.tmux = { capturePane: vi.fn(async () => { if (screen.error) throw new Error("capture failed"); return screen.pane; }),
    isWindowAlive: vi.fn(async () => true), getWindowId: () => "@sandbox",
    sendSpecialKey: hooks.forbidden, sendKeys: hooks.forbidden, pasteText: hooks.forbidden, pasteBuffer: hooks.forbidden,
    createWindow: hooks.forbidden, killWindow: hooks.forbidden,
  };
  d.processStatus = "running";
  d.instanceStateMonitorActive = true;
  d.instanceStateReadyPattern = backend.getReadyPattern();
  d.instanceStateMachine = new PaneStateMachine(backend.getReadyPattern(), 600_000, Date.now(), backend.getBusyPattern());
  d.instanceStateMachine.recordOutput(); d.instanceState = "working";
  d.pendingWork.recordInbound(Date.now());
  d.maybeProxyReplyOnTurnEnd = vi.fn(); d.restart = hooks.forbidden; d.trySpawn = hooks.forbidden; d.pause = hooks.forbidden;
  d.hangDetector = new EventEmitter();
  vi.spyOn(d.hangDetector, "emit");
  const fm = new FleetManager(dir) as any;
  fm.getInstanceStatus = () => "running";
  fm.logger = logger; fm.fleetConfig = { instances: { worker: { working_directory: dir, backend: backendName } }, defaults: {} };
  fm.lifecycle.daemons.set("worker", d);
  vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(false);
  fm.lifecycle.start = hooks.forbidden; fm.lifecycle.restart = hooks.forbidden;
  fm.resolveInstanceModel = () => ({ model: "test", display: "test", source: "instance" });
  fm.effortStrategyFor = () => "unsupported"; fm.resolveInstanceEffort = () => ({ effort: null, source: "unset" });
  fm.cacheInstanceExecutionState("worker", d.getInstanceStateSnapshot());
  const messages: any[] = [];
  const receive = (msg: any) => {
    messages.push(msg);
    if (msg.type === "instance_state_response" || msg.type === "instance_state") fm.cacheInstanceExecutionState("worker", msg);
  };
  d.ipcServer = { broadcast: vi.fn(receive), send: vi.fn((_socket: any, msg: any) => receive(msg)) };
  const capture = () => d.captureAndEvaluateInstanceState("state_query");
  const query = (refresh = false) => d.respondToInstanceStateQuery({ requestId: "q", refresh }, {});
  const readTool = async (tool: "describe_instance" | "list_instances", args: any = { name: "worker" }) => {
    let result: any;
    await outboundHandlers.get(tool)!(fm, args, r => { result = r; }, { instanceName: "sender" } as any);
    return result;
  };
  cleanups.push(() => { d.stopInstanceStateMonitor(); clearInterval(d.errorMonitorTimer); fm.stormWindow.shutdown(); });
  return { d, fm, screen, messages, capture, query, readTool, dir };
}

async function confirm(h: ReturnType<typeof harness>) {
  await h.capture();
  expect(h.d.getInteractionSnapshot().phase).toBe("candidate");
  await vi.advanceTimersByTimeAsync(500);
  expect(h.d.getInteractionSnapshot().phase).toBe("waiting");
}

describe("native prompt observation through real Daemon / PaneStateMachine", () => {
  it("four-option permission is a passive hold, remains pending, and never sends keys", async () => {
    const h = harness();
    const hits = h.d.backend.getRuntimeDialogs().filter((d: any) => d.isActive ? d.isActive(PERMISSION) : d.pattern.test(PERMISSION));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ keys: [], holdOnly: true, blocksDelivery: true, inputBlocked: true });
    await confirm(h);
    expect(h.d.instanceStateMachine.snapshot().state).toBe("idle");
    expect(h.d.getInstanceState()).toBe("working");
    expect(h.d.getInstanceStateSnapshot().state).toBe("working");
    expect(h.d.pendingWork.hasPendingWork()).toBe(true);
    expect(h.d.maybeProxyReplyOnTurnEnd).not.toHaveBeenCalled();
    expect(h.d.notAcceptingReason()).toContain("CLI dialog needs attention");
    h.d.startErrorMonitor(); await vi.advanceTimersByTimeAsync(10_000);
    expect(h.d.getInteractionSnapshot()).toMatchObject({ phase: "waiting", kind: "permission" });
    expect(hooks.forbidden).not.toHaveBeenCalled();
  });
  it.each([
    ["missing title", PERMISSION.replace("Bash command", "Transcript")],
    ["missing footer", PERMISSION.replace("Esc to cancel · Tab to amend", "")],
    ["quoted above composer", `${PERMISSION}\n❯ READY`],
    ["extra option", PERMISSION.replace("4. No", "4. No\n5. Maybe")],
    ["wrong option", PERMISSION.replace("4. No", "4. Never")],
    ["busy below", `${PERMISSION}\nWORKING`],
  ])("rejects %s as permission evidence", async (_label, pane) => {
    expect(claudeBashPermissionActive(pane)).toBe(false);
    const h = harness(pane); await h.capture(); await vi.advanceTimersByTimeAsync(500);
    expect(h.d.getInteractionSnapshot().kind).not.toBe("permission");
    expect(h.d.inputBlockedDialogKey).toBeNull();
  });
  it("existing two-option safety handling still declines, while the observer itself writes nothing", async () => {
    const h = harness(DANGER); await confirm(h); expect(hooks.forbidden).not.toHaveBeenCalled();
    const keys: string[] = [];
    h.d.tmux.sendSpecialKey = vi.fn(async (key: string) => { keys.push(key); if (key === "Enter") h.screen.pane = READY; return true; });
    h.d.submitSystemPaste = vi.fn(async () => true);
    h.d.startErrorMonitor(); await vi.advanceTimersByTimeAsync(5600);
    expect(keys).toEqual(["Down", "Enter"]);
    expect(h.d.getInteractionSnapshot().phase).toBe("clear");
  });
  it("an old after-keys clear cannot release a newer permission hold", async () => {
    const h = harness(DANGER); await confirm(h);
    const gate = deferred<string>(); let reads = 0;
    h.d.tmux.capturePane.mockImplementation(async () => ++reads === 3 ? gate.promise : h.screen.pane);
    h.d.tmux.sendSpecialKey = vi.fn(async () => true); h.d.submitSystemPaste = vi.fn(async () => true);
    h.d.startErrorMonitor(); await vi.advanceTimersByTimeAsync(5600);
    h.screen.pane = PERMISSION; await vi.advanceTimersByTimeAsync(1); await h.capture();
    expect(h.d.getInteractionSnapshot().kind).toBe("permission");
    gate.resolve(READY); await flush();
    expect(h.d.inputBlockedDialogKey).not.toBeNull();
    expect(h.d.submitSystemPaste).not.toHaveBeenCalled();
  });
  it("missing cursor is still held, without authorizing a choice", async () => {
    const h = harness(PERMISSION.replace("❯ 1. Yes", "  1. Yes")); await confirm(h);
    expect(h.d.inputBlockedDialogKey).not.toBeNull(); expect(hooks.forbidden).not.toHaveBeenCalled();
  });
  it("an under-250ms transient never becomes awaiting_input", async () => {
    const h = harness(); await h.capture(); await vi.advanceTimersByTimeAsync(200);
    h.screen.pane = READY; await vi.advanceTimersByTimeAsync(300);
    expect(h.d.getInteractionSnapshot()).toMatchObject({ phase: "clear", kind: null });
    expect(presentationState(h.d.getInstanceState(), h.d.getInteractionSnapshot())).not.toBe("awaiting_input");
  });
  it("queries do not publish rejected modal idle, renew age, or widen the control cache", async () => {
    const h = harness(); await confirm(h); await h.query();
    expect(h.messages.at(-1)).toMatchObject({ type: "instance_state_response", state: "working", interaction: { phase: "waiting" } });
    expect(h.fm.getInstanceExecutionState("worker")).toBe("working");
    await vi.advanceTimersByTimeAsync(14_999); await h.query();
    expect(h.messages.at(-1).interaction.ageMs).toBe(14_999);
    await vi.advanceTimersByTimeAsync(1); await h.query();
    expect(h.messages.at(-1).interaction).toMatchObject({ phase: "unverified", ageMs: 15_000, stale: true });
    expect(h.d.inputBlockedDialogKey).not.toBeNull(); expect(h.d.pendingWork.hasPendingWork()).toBe(true);
  });
  it("capture failure is unverified, not clear/ready, and reconfirms with a new 500ms", async () => {
    const h = harness(); await confirm(h); h.screen.error = true;
    await h.query(true);
    expect(h.d.getInteractionSnapshot()).toMatchObject({ phase: "unverified", kind: "permission" });
    expect(h.d.inputBlockedDialogKey).not.toBeNull();
    h.screen.error = false; await vi.advanceTimersByTimeAsync(1); await h.capture();
    await vi.advanceTimersByTimeAsync(499); expect(h.d.getInteractionSnapshot().phase).toBe("candidate");
    await vi.advanceTimersByTimeAsync(1); expect(h.d.getInteractionSnapshot().phase).toBe("waiting");
  });
  it.each(["spawnGeneration", "launchAttempt", "launchFenceEpoch"])("late capture cannot publish across %s", async key => {
    const h = harness(); const gate = deferred<string>(); h.d.tmux.capturePane.mockImplementationOnce(() => gate.promise);
    const pending = h.capture(); await flush(); h.d[key]++;
    gate.resolve(PERMISSION); await pending;
    expect(h.d.getInteractionSnapshot()).toMatchObject({ phase: "unverified", kind: null });
    expect(h.messages.filter(m => m.type === "instance_interaction")).toEqual([]);
    expect(h.d.inputBlockedDialogKey).toBeNull();
  });
  it("stop/freeze invalidates the candidate and its scheduled confirmation", async () => {
    const h = harness(); await h.capture(); const captures = h.d.tmux.capturePane.mock.calls.length;
    h.d.freezeRuntimeMonitors(); expect(h.d.interactionConfirmationTimer).toBeNull(); await vi.advanceTimersByTimeAsync(600);
    expect(h.d.tmux.capturePane).toHaveBeenCalledTimes(captures);
    expect(h.d.getInteractionSnapshot()).toMatchObject({ phase: "unverified", kind: null });
  });
  it("ordinary capture overtaken by output cannot clear a hold or confirm the old timer", async () => {
    const h = harness(); await confirm(h);
    const gate = deferred<string>(); h.d.tmux.capturePane.mockImplementationOnce(() => gate.promise);
    const pending = h.capture(); await flush(); h.d.instanceStateLastOutputAt = Date.now() + 1;
    gate.resolve(READY); await pending;
    expect(h.d.getInteractionSnapshot()).toMatchObject({ phase: "unverified", kind: "permission" });
    expect(h.d.inputBlockedDialogKey).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2); await h.capture();
    await vi.advanceTimersByTimeAsync(499); expect(h.d.getInteractionSnapshot().phase).toBe("candidate");
    await vi.advanceTimersByTimeAsync(1); expect(h.d.getInteractionSnapshot().phase).toBe("waiting");
  });
  it("runtime monitor completion cannot overwrite a newer clear capture", async () => {
    const h = harness(); await confirm(h);
    h.d.startErrorMonitor(); const gate = deferred<string>(); h.d.tmux.capturePane.mockImplementationOnce(() => gate.promise);
    await vi.advanceTimersByTimeAsync(5_000); h.screen.pane = READY;
    await h.capture(); expect(h.d.getInteractionSnapshot().phase).toBe("clear");
    gate.resolve(PERMISSION); await flush();
    expect(h.d.getInteractionSnapshot().phase).toBe("clear");
    expect(h.d.inputBlockedDialogKey).toBeNull();
  });
  it("danger countdown/cursor redraw keeps request identity, while command change starts a new episode", async () => {
    const h = harness(DANGER); await h.capture(); const episode = h.d.getInteractionSnapshot().episode;
    h.screen.pane = DANGER.replace(/request in \d+:\d\d/, "request in 1:01").replace("❯ 1. Yes", "  1. Yes").replace("  2. No", "❯ 2. No");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.d.getInteractionSnapshot()).toMatchObject({ phase: "waiting", kind: "dangerous_command", episode });
    h.screen.pane = h.screen.pane.replaceAll("agend-safe-probe", "different-request"); await vi.advanceTimersByTimeAsync(1); await h.capture();
    expect(h.d.getInteractionSnapshot()).toMatchObject({ phase: "candidate", episode: episode + 1 });
  });
  it("Codex's native cwd picker is structural observation, and isActive replaces regex", async () => {
    const dialogs = Object.create(CodexBackend.prototype).getRuntimeDialogs();
    const h = harness(CODEX_PICKER, dialogs, "codex"); await confirm(h);
    expect(h.d.getInteractionSnapshot().kind).toBe("dialog");
    expect(hooks.forbidden).not.toHaveBeenCalled();
    const strong = dialogs.find((d: any) => d.isActive?.(CODEX_PICKER))!;
    strong.pattern = /NEVER_MATCH/; await h.capture();
    expect(h.d.getInteractionSnapshot().kind).toBe("dialog");
  });
  it("native login is a static category, and OAuth material never leaves the daemon", async () => {
    const login = readFileSync(new URL("./fixtures/claude-2.1.287-login.pane.txt", import.meta.url), "utf8");
    const h = harness(login); await confirm(h);
    expect(h.d.getInteractionSnapshot().kind).toBe("login");
    expect(JSON.stringify(h.messages)).not.toContain("Anthropic Console");
    const oauth = readFileSync(new URL("./fixtures/claude-2.1.286-onboarding-oauth-url.pane.txt", import.meta.url), "utf8");
    h.screen.pane = oauth; await vi.advanceTimersByTimeAsync(1); await h.capture();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.d.getInteractionSnapshot().kind).toBe("login");
    expect(JSON.stringify(h.messages)).not.toMatch(/https?:|Paste code here/);
  });
  it("OpenCode's native request identity is observed without running its existing answer policy", async () => {
    const pane = readFileSync(new URL("./fixtures/opencode-1.18.34-permission-external-directory.pane.txt", import.meta.url), "utf8");
    const backend = Object.create(OpenCodeBackend.prototype);
    const h = harness(pane, backend.getRuntimeDialogs(), "opencode"); await confirm(h);
    expect(h.d.getInteractionSnapshot().kind).toBe("dialog");
    expect(h.d.inputBlockedDialogKey).not.toBeNull();
    expect(hooks.forbidden).not.toHaveBeenCalled();
  });
  it("quiet weak observations do not reset their grace on synthetic working-heartbeat timestamps", async () => {
    const h = harness("Password:", []); await h.capture();
    await vi.advanceTimersByTimeAsync(5000); await h.capture();
    await vi.advanceTimersByTimeAsync(5000); await h.capture();
    expect(h.d.getInteractionSnapshot()).toMatchObject({ phase: "waiting", suspected: true });
    expect(h.d.inputBlockedDialogKey).toBeNull();
  });
  it("the existing delivery gate holds permission and user Cancel is still an explicit action", async () => {
    const h = harness(); await confirm(h);
    expect(await h.d.paneReadinessForDelivery("@sandbox")).toBe("dialog");
    const key = vi.fn(async () => true); h.d.tmux.sendSpecialKey = key;
    h.fm.clearCancelButton = vi.fn();
    expect(h.fm.cancelInstance("worker")).toBe(true); await flush();
    expect(key).toHaveBeenCalledExactlyOnceWith("Escape");
    expect(h.d.getInteractionSnapshot().kind).toBe("permission");
    expect(h.d.inputBlockedDialogKey).not.toBeNull();
    expect(hooks.forbidden).not.toHaveBeenCalled();
  });
  it("a new spawn invalidates the observation and confirmation without starting a process", async () => {
    const h = harness(); await h.capture(); const n = h.d.tmux.capturePane.mock.calls.length;
    h.d.beginSpawn(); await vi.advanceTimersByTimeAsync(1000);
    expect(h.d.getInteractionSnapshot()).toMatchObject({ phase: "unverified", kind: null });
    expect(h.d.tmux.capturePane).toHaveBeenCalledTimes(n); h.d.endSpawn();
  });
  it("an old runtime capture failure cannot unverify a newer confirmed observation", async () => {
    const h = harness(); await confirm(h); h.d.startErrorMonitor();
    let reject!: (e: Error) => void;
    const old = new Promise<string>((_r, no) => { reject = no; });
    h.d.tmux.capturePane.mockImplementationOnce(() => old);
    await vi.advanceTimersByTimeAsync(5000); await h.capture();
    expect(h.d.getInteractionSnapshot().phase).toBe("waiting");
    reject(new Error("old read failed")); await flush();
    expect(h.d.getInteractionSnapshot().phase).toBe("waiting");
  });
  it("a runtime isWindowAlive await cannot publish after a stop fence", async () => {
    const h = harness(); h.d.startErrorMonitor();
    const gate = deferred<boolean>(); h.d.tmux.isWindowAlive.mockImplementationOnce(() => gate.promise);
    await vi.advanceTimersByTimeAsync(5000); h.d.freezeRuntimeMonitors(); gate.resolve(true); await flush();
    expect(h.d.tmux.capturePane).not.toHaveBeenCalled();
    expect(h.d.getInteractionSnapshot().kind).toBeNull();
  });
  it("confirmation has a 1s capture bound and creates no permanent fast poll", async () => {
    const h = harness(); await confirm(h);
    expect(h.d.tmux.capturePane).toHaveBeenNthCalledWith(2, 1000);
    expect(h.d.interactionConfirmationTimer).toBeNull();
    const n = h.d.tmux.capturePane.mock.calls.length; await vi.advanceTimersByTimeAsync(14_999);
    expect(h.d.tmux.capturePane).toHaveBeenCalledTimes(n);
  });
  it("suspected terminal input does not suppress the real stuck/hang path", async () => {
    const h = harness("Password:", []); await h.capture();
    await vi.advanceTimersByTimeAsync(600_001); await h.capture();
    expect(h.d.getInstanceState()).toBe("stuck");
    expect(h.d.hangDetector.emit).toHaveBeenCalledWith("hang", expect.anything());
    expect(h.d.inputBlockedDialogKey).toBeNull();
  });
  it("weak tail notification dedup does not erase suspected metadata or suppress hang", async () => {
    const h = harness("Password:", []); h.d.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.d.getInteractionSnapshot()).toMatchObject({ phase: "waiting", suspected: true, kind: "suspected_terminal_input" });
    expect(h.d.inputBlockedDialogKey).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.d.getInteractionSnapshot()).toMatchObject({ phase: "waiting", suspected: true });
    expect(h.fm.getInstanceExecutionState("worker")).not.toBe("awaiting_input");
  });
});

describe("outward presentation and incident privacy", () => {
  it("describe/list/SSE/API project awaiting_input and include the original execution state", async () => {
    const h = harness(); await confirm(h); await h.query();
    expect(await h.readTool("describe_instance")).toMatchObject({ instance_state: "awaiting_input", execution_state: "working", interaction: { phase: "waiting" } });
    expect((await h.readTool("list_instances", {})).instances[0]).toMatchObject({ instance_state: "awaiting_input", execution_state: "working" });
    expect(h.fm.getUiStatus().instances[0]).toMatchObject({ state: "awaiting_input", execution_state: "working" });
    vi.spyOn(h.fm, "webToken", "get").mockReturnValue("test-token"); vi.spyOn(h.fm, "viewToken", "get").mockReturnValue("test-view"); h.fm.startHealthServer(12345);
    h.fm.getSysInfo = () => ({ instances: [{ name: "worker", status: "running" }] });
    let result = "";
    hooks.http!({ method: "GET", url: "/api/fleet", headers: { host: "localhost:12345", "x-agend-token": "test-token" } },
      { setHeader: vi.fn(), writeHead: vi.fn(), end: (s: string) => { result = s; }, headersSent: false });
    expect(JSON.parse(result), result).toHaveProperty("instances");
    expect(JSON.parse(result).instances[0]).toMatchObject({ state: "awaiting_input", execution_state: "working" });
    const exported = JSON.stringify(h.messages) + JSON.stringify(await h.readTool("describe_instance"));
    expect(exported).not.toContain("agend-safe-probe"); expect(exported).not.toContain("TARGET=");
  });
  it("compact list retains active observations and Classic uses the same presentation boundary", async () => {
    const h = harness(); await confirm(h); await h.query();
    h.fm.fleetConfig.instances.worker.description = "x".repeat(9000);
    h.fm.fleetConfig.defaults.list_instances_output_budget = 2000;
    const compact = await h.readTool("list_instances", {});
    expect(compact.instances[0]).toMatchObject({ instance_state: "awaiting_input", execution_state: "working", interaction: { kind: "permission" } });
    expect(compact.instances[0].description).toBeUndefined();
    h.fm.fleetConfig.instances = {};
    h.fm.classicChannels = { getChannelIdByInstance: () => "room", getAll: () => [{ instanceName: "worker", channelId: "room", name: "classic" }],
      getBackendByInstance: () => "claude-code", getModel: () => "test" };
    expect(await h.readTool("describe_instance")).toMatchObject({ kind: "classic", instance_state: "awaiting_input" });
    expect((await h.readTool("list_instances", {})).instances[0].instance_state).toBe("awaiting_input");
  });
  it("a live positive observation is visible even before execution-cache hydration", async () => {
    const h = harness(); await confirm(h); h.fm.instanceStateCache.clear();
    expect(await h.readTool("describe_instance")).toMatchObject({ instance_state: "awaiting_input", execution_state: null });
    expect(h.fm.getInstanceExecutionState("worker")).toBeNull();
    h.d.processStatus = "crashed";
    expect(h.fm.getInstanceInteraction("worker")).toBeNull();
  });
  it("paused/dead target hides old observations and stale presentation explains age", async () => {
    const h = harness(); await confirm(h); await h.query();
    await vi.advanceTimersByTimeAsync(15_000);
    const stale = await h.readTool("describe_instance");
    expect(stale).toMatchObject({ instance_state: "working", interaction: { phase: "unverified", stale: true } });
    expect(stale.interaction_summary).toContain("cannot confirm");
    vi.spyOn(h.fm.lifecycle, "isPaused").mockReturnValue(true);
    expect(h.fm.getInstanceInteraction("worker")).toBeNull();
    vi.spyOn(h.fm.lifecycle, "isPaused").mockReturnValue(false);
    h.fm.instanceProcessStatus.set("worker", "crashed");
    expect(h.fm.getInstanceInteraction("worker")).toBeNull();
  });
  it("parked reports reuse incident routing once per request, with category only", async () => {
    const h = harness(); await confirm(h);
    const notices: string[] = [];
    const lifecycle = new InstanceLifecycle({ logger, isPlannedRestart: () => false,
      notifyFleetError: (s: string) => notices.push(s), eventLog: { insert: vi.fn() },
    } as any) as any;
    lifecycle.notifyIncident = (_n: string, _event: string, text: string) => notices.push(text);
    lifecycle.attachIncidentHandlers("worker", h.d);
    h.d.startErrorMonitor(); await vi.advanceTimersByTimeAsync(70_000);
    expect(notices).toHaveLength(2); expect(notices.join(" ")).toContain("permission confirmation");
    expect(notices.join(" ")).not.toMatch(/TARGET=|agend-safe-probe|rm -rf|https?:/);
    await vi.advanceTimersByTimeAsync(60_000); expect(notices).toHaveLength(2);
    h.screen.pane = PERMISSION.replaceAll("agend-safe-probe", "new-command");
    await vi.advanceTimersByTimeAsync(70_000); expect(notices).toHaveLength(4);
  });
});
