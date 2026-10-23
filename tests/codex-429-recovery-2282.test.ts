import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon } from "../src/daemon.js";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { setLocale } from "../src/locale.js";

const ROW = "■ exceeded retry limit, last status: 429 Too Many Requests";
const IDLE = "› Ask Codex to do anything\n  Context 100% left";
const NUDGE = "Continue only if the last request is unfinished; if it is done, reply that it is done.";
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/codex-429-2282", name + ".pane.txt"), "utf8");
const backend = new CodexBackend("/tmp/codex429-pattern");
const pattern = backend.getErrorPatterns().find(e => e.type === "rate_limit" && e.action === "nudge_continue")!;
const key = "rate_limit:" + pattern.pattern.source;
let root: string;
beforeEach(() => { vi.useFakeTimers(); setLocale("en"); root = mkdtempSync(join(tmpdir(), "agend429-")); });
afterEach(() => { vi.useRealTimers(); setLocale("en"); rmSync(root, { recursive: true, force: true }); });

function rig(start = IDLE) {
  const inst = join(root, "w"); mkdirSync(inst);
  const logger: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
  const d: any = new Daemon("w", { working_directory: root, backend: "codex", log_level: "silent", restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 } } as any, inst, false, new CodexBackend(inst), undefined, logger);
  d.processStatus = "running";
  const screen = { text: start };
  const sent: string[] = []; let enters = 0;
  d.tmux = { isWindowAlive: async () => true, capturePane: async () => screen.text, capturePaneWithHistory: async () => screen.text, sendSpecialKey: async (k: string) => { if (k === "Enter") enters++; return true; }, pasteBuffer: async (text: string) => { sent.push(text); return true; }, getLastSendSpecialKeyError: () => null, getWindowId: () => "@private-fake" };
  d.confirmSubmitted = async () => "submitted";
  const arm = vi.spyOn(d, "armCapacityNudge");
  const notify = vi.fn((_name: string, _text: string) => true), failover = vi.fn(), restart = vi.fn();
  const lc: any = new InstanceLifecycle({ fleetConfig: { defaults: { backend: "codex" }, instances: { w: { backend: "codex" }, general: { general_topic: true } } }, dataDir: root, getInstanceDir: () => inst, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, eventLog: { insert: vi.fn() }, isPlannedRestart: () => false, isClassicInstance: () => false, notifyInstanceTopic: notify, notifyFleetError: vi.fn(), webhookEmit: vi.fn(), clearCancelButton: vi.fn(), checkModelFailover: failover, restartSingleInstance: restart, setTopicIcon: vi.fn() } as unknown as LifecycleContext);
  lc.verifyCodexQuota = vi.fn(async () => "exhausted"); // no provider/network probe
  lc.pause = vi.fn(async () => { d.pauseWakeState = "paused"; return "paused"; });
  lc.daemons.set("w", d); lc.attachIncidentHandlers("w", d);
  const events: any[] = []; d.on("pty_error", (e: any) => events.push(e));
  d.startErrorMonitor();
  return { d, lc, screen, sent, arm, notify, failover, restart, events, enters: () => enters, poll: (ms = 5100) => vi.advanceTimersByTimeAsync(ms), stop: () => clearInterval(d.errorMonitorTimer) };
}

describe("#2282 real exhausted429 classifier and quota separation", () => {
  it("selects the bounded continuation and never also matches generic failover", () => {
    const p = fixture("exhausted429"); const matches = backend.getErrorPatterns().filter(e => e.pattern.test(p));
    expect(matches.map(e => [e.type, e.action])).toEqual([["rate_limit", "nudge_continue"]]);
    expect(backend.isPeriodicRedrawIdlePane(p)).toBe(true);
    expect(backend.getBusyPattern().test(p)).toBe(false);
  });
  it("preserves generic429 failover, while real rendered insufficient-quota is quota/pause", () => {
    expect(backend.getErrorPatterns().find(e => e.pattern.test('■ API error {"status":429,"code":"rate_limit_exceeded"}'))).toMatchObject({ type: "rate_limit", action: "failover" });
    const live = fixture("insufficient-quota").split("\n").find(r => r.includes("Quota exceeded."))!;
    expect(backend.getErrorPatterns().find(e => e.pattern.test(live))).toMatchObject({ type: "quota", action: "pause" });
    expect(backend.getErrorPatterns().some(e => e.pattern.test("    " + live))).toBe(false);
    expect(backend.getErrorPatterns().some(e => e.pattern.test("A report says Quota exceeded. Check your plan and billing details."))).toBe(false);
    for (const row of ['■ API error {"status":429,"code":"insufficient_quota"}', "You’ve hit your usage limit", "Your workspace is out of credits"]) expect(backend.getErrorPatterns().find(e => e.pattern.test(row))).toMatchObject({ type: "quota", action: "pause" });
  });
  it("does not classify a plain or indented quoted exhausted-row as a recoverable turn", () => {
    expect(pattern.pattern.test("A report says exceeded retry limit, last status: 429 Too Many Requests")).toBe(false);
    expect(pattern.pattern.test("    " + ROW)).toBe(false);
  });
});

describe("#2282 real daemon + lifecycle, all process/pane boundaries inert", () => {
  it("#2543 uses real offline0.164 redraw captures without repasting the failed request", async () => {
    const capture = (name: string) => readFileSync(join(__dirname, "fixtures/codex-nudge-2543", name + ".pane.txt"), "utf8");
    const before = capture("before"), after = capture("after-resize");
    expect(before).not.toBe(after);
    expect(backend.isPeriodicRedrawIdlePane(before)).toBe(true);
    expect(backend.isPeriodicRedrawIdlePane(after)).toBe(true);
    const r = rig(); await r.poll(); r.screen.text = before; await r.poll();
    r.screen.text = after; await r.poll(40_000);
    expect(r.sent).toEqual([NUDGE]); expect(r.enters()).toBe(1); r.stop();
  });
  it("#2543 settles an existing promise even during planned shutdown, in its original channel", async () => {
    const r = rig(); await r.poll(); r.screen.text = fixture("exhausted429"); await r.poll();
    r.lc.ctx.isPlannedRestart = () => true;
    setLocale("zh-TW"); r.d.freezeRuntimeMonitors(); r.d.freezeRuntimeMonitors();
    expect(r.notify).toHaveBeenLastCalledWith("w", expect.stringMatching(/重試已取消.*已停止、暫停或重新啟動/));
    expect(r.notify.mock.calls.filter(c => /重試已取消/.test(c[1]))).toHaveLength(1); r.stop();
  });
  it("#2543 keeps the shared 429 promise across a cosmetic redraw", async () => {
    const r = rig(); await r.poll(); r.screen.text = fixture("exhausted429"); await r.poll();
    r.screen.text = r.screen.text.replace("100% left", "99% left");
    await r.poll(40_000); expect(r.sent).toEqual([NUDGE]);
    expect(r.notify.mock.calls.filter(c => /retry cancelled/i.test(c[1]))).toHaveLength(0); r.stop();
  });
  it.each(["draft", "cancel", "freeze", "spawn", "write refusal"])("#2543 announces a dropped promise once: %s", async why => {
    const r = rig(); await r.poll(); r.screen.text = fixture("exhausted429"); await r.poll();
    expect(r.notify).toHaveBeenCalledWith("w", expect.stringMatching(/recovery 1\/3/));
    if (why === "draft") r.screen.text = r.screen.text.replace("› Ask Codex to do anything", "› unsent request");
    if (why === "cancel") r.d.clearPendingDeliveries();
    if (why === "freeze") r.d.freezeRuntimeMonitors();
    if (why === "spawn") { r.d.beginSpawn(); r.d.endSpawn(); }
    if (why === "write refusal") r.d.submitSystemPaste = vi.fn(async () => false);
    await r.poll(45_000);
    expect(r.notify.mock.calls.filter(c => /retry cancelled: .+/i.test(c[1]))).toHaveLength(1);
    expect(r.sent).toEqual([]); expect(r.enters()).toBe(0); r.stop();
  });
  it("#2543 does not announce cancellation when the original promise was not dispatched", async () => {
    const r = rig(); r.notify.mockReturnValue(false);
    await r.poll(); r.screen.text = fixture("exhausted429"); await r.poll();
    r.notify.mockClear(); r.notify.mockReturnValue(true); r.d.clearPendingDeliveries();
    await r.poll(45_000); expect(r.notify).not.toHaveBeenCalled(); r.stop();
  });
  it("without a fallback tells the user, waits30s and continues the retained context exactly once", async () => {
    const r = rig(); await r.poll(); r.screen.text = fixture("exhausted429"); await r.poll();
    expect(r.events).toHaveLength(1); expect(r.arm).toHaveBeenLastCalledWith(pattern.pattern, 30_000);
    expect(r.notify).toHaveBeenCalledWith("w", expect.stringMatching(/HTTP 429.*recovery 1\/3.*30s/));
    await r.poll(20_000); expect(r.sent).toEqual([]);
    await r.poll(15_000); expect(r.sent).toEqual([NUDGE]); expect(r.enters()).toBe(1);
    await r.poll(300_000); expect(r.sent).toEqual([NUDGE]); expect(r.events).toHaveLength(1);
    expect(r.restart).not.toHaveBeenCalled(); expect(r.lc.pause).not.toHaveBeenCalled(); r.stop();
  });
  it("three NEW failures use30/60/120s, then the fourth pauses and notifies without a fourth paste", async () => {
    const r = rig(); await r.poll(); let p = fixture("exhausted429");
    for (const delay of [30_000,60_000,120_000]) {
      r.screen.text = p; await r.poll(); expect(r.arm).toHaveBeenLastCalledWith(pattern.pattern, delay);
      await r.poll(delay+5100); p = p.replace(IDLE.split("\n")[0], `› retry failed request\n\n${ROW}\n\n${IDLE.split("\n")[0]}`);
    }
    expect(r.sent).toHaveLength(3); r.screen.text = p; await r.poll();
    expect(r.lc.pause).toHaveBeenCalledWith("w", "error", expect.objectContaining({ current: expect.any(Function) })); expect(r.sent).toHaveLength(3);
    expect(r.notify).toHaveBeenLastCalledWith("w", expect.stringMatching(/HTTP 429 persisted after 3 recovery attempts.*pausing/)); r.stop();
  });
  it.each(["first live history","startup then history"])("never nudges old scrollback: %s", async mode => {
    const r = rig(mode === "first live history" ? fixture("exhausted429") : ">_ OpenAI Codex\nResuming session…");
    await r.poll(); r.screen.text = fixture("exhausted429"); await r.poll(300_000);
    expect(r.events).toEqual([]); expect(r.d.nudgeBaselines.get(key)).toBe(1); expect(r.sent).toEqual([]); expect(r.lc.rateLimitNudgeAttempts.size).toBe(0); r.stop();
  });
  it("an exhausted budget cannot turn resumed old scrollback into a fresh pause or failover", async () => {
    const r = rig(fixture("exhausted429"));
    r.lc.rateLimitNudgeAttempts.set("w", { count:3,lastAt:Date.now() });
    await r.poll(180_000);
    expect(r.events).toEqual([]); expect(r.sent).toEqual([]); expect(r.lc.pause).not.toHaveBeenCalled(); expect(r.failover).not.toHaveBeenCalled(); r.stop();
  });
  it("a genuinely new occurrence after resumed history can recover, and scrolled-out history does not suppress it", async () => {
    const r = rig(fixture("exhausted429")); await r.poll(); r.screen.text = IDLE; await r.poll(); r.screen.text = fixture("exhausted429"); await r.poll(45_000);
    expect(r.sent).toEqual([NUDGE]); r.stop();
  });
  it.each(["draft","queued message","cancel","pause","working","replacement"])("cancels the pending continuation after %s", async why => {
    const r = rig(); await r.poll(); r.screen.text = fixture("exhausted429"); await r.poll();
    if (why === "draft") r.screen.text += "typed draft";
    if (why === "queued message") r.d.pasteQueueDepth = 1;
    if (why === "cancel") r.d.clearPendingDeliveries();
    if (why === "pause") r.d.pauseWakeState = "paused";
    if (why === "working") r.d.instanceState = "working";
    if (why === "replacement") r.d.freezeRuntimeMonitors();
    await r.poll(180_000); expect(r.sent).toEqual([]); expect(r.enters()).toBe(0); r.stop();
  });
  it("quota after older429 history pauses without arming or spending a transient retry", async () => {
    const r = rig(); await r.poll(); r.screen.text = fixture("insufficient-quota"); await r.poll();
    expect(r.events[0]).toMatchObject({ type: "quota", action: "pause" });
    expect(r.lc.pause).toHaveBeenCalledWith("w", "error"); expect(r.arm).not.toHaveBeenCalled();
    expect(r.lc.rateLimitNudgeAttempts.size).toBe(0); await r.poll(180_000); expect(r.sent).toEqual([]); r.stop();
  });
  it("a successful later turn makes the old error history, never another recovery", async () => {
    const r = rig(); await r.poll(); r.screen.text = fixture("exhausted429"); await r.poll(); r.screen.text = fixture("recovered"); await r.poll(180_000);
    expect(r.sent).toEqual([]); r.stop();
  });
  it("a delayed pause completion never requests a pause on the replacement owner", async () => {
    const r = rig(); await r.poll();
    r.lc.rateLimitNudgeAttempts.set("w", { count:3,lastAt:Date.now() });
    let release!: () => void;
    r.lc.pause.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve("busy"); }));
    r.screen.text = fixture("exhausted429"); await r.poll();
    expect(r.lc.pause).toHaveBeenCalledOnce();
    const next = { requestPauseWhenIdle: vi.fn() }; r.lc.daemons.set("w",next); release(); await r.poll(0);
    expect(next.requestPauseWhenIdle).not.toHaveBeenCalled(); r.stop();
  });
  it.each(["same launch", "new spawn"])("deferred exhaustion pause belongs to its launch: %s", async mode => {
    const r = rig(); await r.poll();
    r.lc.rateLimitNudgeAttempts.set("w", { count:3,lastAt:Date.now() });
    let release!: () => void;
    const pending = vi.spyOn(r.d, "requestPauseWhenIdle");
    r.lc.pause.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    r.screen.text = fixture("exhausted429"); await r.poll();
    expect(r.lc.pause).toHaveBeenCalledOnce();
    if (mode === "new spawn") { r.d.beginSpawn(); r.d.endSpawn(); }
    else {
      // A normal pause advances this fence itself, even if it later fails.
      r.d.freezeRuntimeMonitors(); r.d.runtimeMonitorsFrozen = false;
    }
    release(); await r.poll(0);
    expect(pending).toHaveBeenCalledTimes(mode === "same launch" ? 1 : 0);
    expect(r.d.pausePending).toBe(mode === "same launch"); r.stop();
  });
  it.each(["draft", "queued message"])("exhaustion cannot pause current input/work: %s", async why => {
    const r = rig(); await r.poll();
    r.lc.rateLimitNudgeAttempts.set("w", { count:3,lastAt:Date.now() });
    // Use real daemon pause if called: its queued-work no-op must not leave a deferred pause.
    // Even a mutation that wrongly admits the draft cannot reach process/tmux teardown.
    r.d.checkpointSessionId = vi.fn(async () => { throw new Error("inert teardown boundary"); });
    r.d.resumeRuntimeMonitors = vi.fn(() => { r.d.runtimeMonitorsFrozen = false; });
    r.lc.pause.mockImplementation((_: string, reason: any, admission: any) => r.d.pause(reason, admission));
    r.screen.text = fixture("exhausted429");
    if (why === "draft") r.screen.text = r.screen.text.replace("› Ask Codex to do anything", "› my unsent next request");
    else r.d.pasteQueueDepth = 1;
    await r.poll();
    expect(r.events).toHaveLength(1); expect(r.lc.pause).not.toHaveBeenCalled();
    expect(r.d.pausePending).toBe(false); expect(r.d.getPauseWakeState()).toBe("active");
    expect(r.sent).toEqual([]);
    expect(r.notify.mock.calls.some(([, text]: string[]) => /persisted.*pausing/.test(text))).toBe(false); r.stop();
  });
  it("new work during exhaustion admission cancels it after the pane await", async () => {
    const r = rig(); await r.poll(); r.lc.rateLimitNudgeAttempts.set("w", { count:3,lastAt:Date.now() });
    const prepare = r.d.prepareCapacityNudgePause.bind(r.d);
    let capture: any;
    vi.spyOn(r.d, "prepareCapacityNudgePause").mockImplementationOnce(() => {
      capture = vi.spyOn(r.d.tmux, "capturePane").mockImplementationOnce(async () => {
        r.d.pasteQueueDepth = 1; return r.screen.text;
      });
      return prepare();
    });
    r.screen.text = fixture("exhausted429"); await r.poll();
    expect(capture).toHaveBeenCalled(); expect(r.lc.pause).not.toHaveBeenCalled();
    expect(r.d.pausePending).toBe(false); r.stop();
  });
  it("a queue admitted just before real pause leaves no deferred pause", async () => {
    const r = rig(); await r.poll(); r.lc.rateLimitNudgeAttempts.set("w", { count:3,lastAt:Date.now() });
    const pause = vi.spyOn(r.d, "pause");
    r.lc.pause.mockImplementation((_: string, reason: any, admission: any) => {
      r.d.pasteQueueDepth = 1;
      return r.d.pause(reason, admission);
    });
    r.screen.text = fixture("exhausted429"); await r.poll();
    expect(pause).toHaveBeenCalledOnce(); expect(r.d.pausePending).toBe(false);
    expect(r.d.getPauseWakeState()).toBe("active"); expect(r.sent).toEqual([]); r.stop();
  });
  it("a draft during the real pause capture cancels both pause and deferred pause", async () => {
    const r = rig(); await r.poll(); r.lc.rateLimitNudgeAttempts.set("w", { count:3,lastAt:Date.now() });
    r.lc.pause.mockImplementation((_: string, reason: any, admission: any) => {
      vi.spyOn(r.d.tmux, "capturePane").mockImplementationOnce(async () => {
        r.screen.text = r.screen.text.replace("› Ask Codex to do anything", "› my unsent next request");
        return r.screen.text;
      });
      return r.d.pause(reason, admission);
    });
    r.screen.text = fixture("exhausted429"); await r.poll();
    expect(r.lc.pause).toHaveBeenCalledOnce(); expect(r.d.getPauseWakeState()).toBe("active");
    expect(r.d.pausePending).toBe(false); expect(r.sent).toEqual([]); r.stop();
  });
  it("an unchanged failed real pause can defer after its own monitor freeze", async () => {
    const r = rig(); await r.poll(); r.lc.rateLimitNudgeAttempts.set("w", { count:3,lastAt:Date.now() });
    r.lc.ctx.stopStatuslineWatcher = vi.fn(); r.lc.ctx.startStatuslineWatcher = vi.fn();
    r.lc.pause.mockImplementation((name: string, reason: any, admission: any) => InstanceLifecycle.prototype.pause.call(r.lc, name, reason, admission));
    r.d.checkpointSessionId = vi.fn(async () => { throw new Error("inert checkpoint failure after freeze"); });
    r.d.resumeRuntimeMonitors = vi.fn(() => { r.d.runtimeMonitorsFrozen = false; });
    r.screen.text = fixture("exhausted429"); await r.poll();
    expect(r.d.checkpointSessionId).toHaveBeenCalledOnce(); expect(r.d.launchFenceEpoch).toBe(1);
    expect(r.d.getPauseWakeState()).toBe("active"); expect(r.d.pausePending).toBe(true);
    expect(r.lc.ctx.startStatuslineWatcher).toHaveBeenCalledWith("w"); r.stop();
  });
  it("capacity and429 budgets are independent, and a retired owner cannot pause its replacement", async () => {
    const r = rig(); r.arm.mockReturnValue(true);
    const capacity = backend.getErrorPatterns().find(e => e.type === "model_error" && e.action === "nudge_continue")!;
    for (let i=0;i<3;i++) { r.d.emit("pty_error", { name:"w",...capacity }); await r.poll(0); }
    r.d.emit("pty_error", { name:"w",...pattern }); await r.poll(0);
    expect(r.arm).toHaveBeenLastCalledWith(pattern.pattern,30_000); expect(r.lc.pause).not.toHaveBeenCalled();
    r.lc.rateLimitNudgeAttempts.set("w",{ count:3,lastAt:Date.now() }); r.lc.daemons.set("w",new EventEmitter());
    r.d.emit("pty_error", { name:"w",...pattern }); await r.poll(0); expect(r.lc.pause).not.toHaveBeenCalled(); expect(r.failover).toHaveBeenCalledTimes(1); r.stop();
  });
});
