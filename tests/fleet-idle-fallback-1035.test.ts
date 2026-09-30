import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon, PaneStateMachine, UNKNOWN_LAYOUT_STABLE_MS } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";
import { FleetManager } from "../src/fleet-manager.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const NO_CONTEXT = readFileSync(join(fixtures, "codex-0157-resumed-no-context-footer.pane.txt"), "utf8");
const LOADING = readFileSync(join(fixtures, "codex-0159-resume-loading.pane.txt"), "utf8");
const TRUST = readFileSync(join(fixtures, "codex-0156-trust-wide.pane.txt"), "utf8");
const CONTEXT_IDLE = readFileSync(join(fixtures, "codex-0159-idle.pane.txt"), "utf8");
const BUSY = NO_CONTEXT.replace("› Ask Codex to do anything", "• Planning the edit (esc to interrupt)\n\n› Ask Codex to do anything");
const QUEUED = NO_CONTEXT.replace("› Ask Codex to do anything", "  ↳ queued text\n› Ask Codex to do anything");
const MESSAGE = "[from:leader] start #1035";
const SUBMITTED = NO_CONTEXT.replace("› Ask Codex to do anything",
  `› ${MESSAGE}\n  (message_id: m)\n\n• Working (1s • esc to interrupt)\n\n› Ask Codex to do anything`);
const cleanups: Array<() => void> = [];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** Real fleet gate + IPC query handler + state machine + backend/paste gate. */
function harness(forwardToPaste = false) {
  const dir = mkdtempSync(join(tmpdir(), "agend-1035-"));
  writeFileSync(join(dir, "window-id"), "@19");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const backend = new CodexBackend(dir);
  const daemon = new Daemon("worker", {
    working_directory: "/tmp", backend: "codex",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 15, idle_debounce_ms: 2_000 },
    log_level: "silent",
  } as any, dir, false, backend, undefined, { child: () => logger } as any) as any;
  const state = {
    pane: NO_CONTEXT, mode: "raw" as "raw" | "cooked" | "unknown",
    captureFails: false, modeFails: false,
  };
  const paste = vi.fn(async () => true);
  daemon.tmux = {
    capturePane: vi.fn(async () => { if (state.captureFails) throw new Error("capture failed"); return state.pane; }),
    capturePaneWithHistory: async () => state.pane,
    getPaneInputMode: vi.fn(async () => { if (state.modeFails) throw new Error("mode failed"); return state.mode; }),
    pasteBuffer: paste,
    sendSpecialKey: vi.fn(async () => { state.pane = SUBMITTED; return true; }),
    sendKeys: vi.fn(async () => true),
    isWindowAlive: async () => true,
    getWindowId: () => "@19",
    getLastPasteError: () => null,
    isLastPasteFailureRecoverable: () => true,
    getLastSendSpecialKeyError: () => null,
  };
  daemon.controlClient = {
    isIdle: () => true, waitUntilIdle: async () => true, hasOutputSince: () => false,
    getLastOutputAt: () => 0, getObservationResetAt: () => 0,
  };
  daemon.spawnGeneration++;
  daemon.inputTransientGuardGeneration = daemon.spawnGeneration;
  daemon.instanceStateMachine = new PaneStateMachine(backend.getReadyPattern(), 15 * 60_000, Date.now(), backend.getBusyPattern());
  daemon.instanceStateMachine.observe(NO_CONTEXT);
  daemon.instanceState = "working";
  daemon.instanceStateMonitorActive = true;

  const fm = new FleetManager(dir) as any;
  fm.logger = logger;
  vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(false);
  fm.cacheInstanceExecutionState("worker", daemon.getInstanceStateSnapshot());
  const cache = (msg: Record<string, unknown>) => fm.cacheInstanceExecutionState("worker", msg);
  daemon.ipcServer = { send: (_socket: unknown, msg: Record<string, unknown>) => cache(msg), broadcast: cache };
  const query = vi.fn((msg: Record<string, unknown>) => {
    void daemon.respondToInstanceStateQuery(msg, {});
    return true;
  });
  fm.instanceIpcClients.set("worker", { connected: true, send: query });
  const submissions: Promise<boolean>[] = [];
  const handoff = vi.fn(async () => {
    if (forwardToPaste) submissions.push(daemon.deliverMessage(MESSAGE, { chatId: "c", messageId: "m" }, { submissionId: "m" }));
    return true;
  });
  fm.sendWhenConnected = handoff;
  const start = () => fm.deliverToInstance("worker", { type: "fleet_inbound", content: MESSAGE }, { waitForIdle: true });
  const h = { dir, backend, daemon, fm, state, paste, query, handoff, submissions, logger, start };
  cleanups.push(() => {
    daemon.stopInstanceStateMonitor();
    fm.stormWindow.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  return h;
}

describe("fleet's Context-less idle gate (#1035)", () => {
  it("hands off at 10s, not the 60s timeout, and the paste gate reuses the proof", async () => {
    const h = harness(true);
    const delivery = h.start();
    await vi.advanceTimersByTimeAsync(UNKNOWN_LAYOUT_STABLE_MS - 1);
    expect(h.handoff).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.handoff).toHaveBeenCalledOnce();
    await expect(delivery).resolves.toBe(true);
    expect(h.query).toHaveBeenCalledWith(expect.objectContaining({ type: "query_instance_state", deliveryIdle: true }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.paste, "the downstream #1032 gate must not start another 10s timer").toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(h.submissions[0]).resolves.toBe(true);
    expect(h.logger.warn).not.toHaveBeenCalledWith(expect.anything(), "Idle gate timed out; forcing delivery");
    expect(h.fm.instanceIdleWaiters.has("worker")).toBe(false);
    const queries = h.query.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.query).toHaveBeenCalledTimes(queries);
  });

  it.each(["busy", "queued", "dialog", "transient", "cooked", "unknown", "capture failure", "mode failure"])(
    "%s cannot satisfy the fallback while waiting for idle", async kind => {
      const h = harness();
      if (kind === "busy") h.state.pane = BUSY;
      if (kind === "queued") h.state.pane = QUEUED;
      if (kind === "dialog") h.state.pane = TRUST;
      if (kind === "transient") h.state.pane = LOADING;
      if (kind === "cooked" || kind === "unknown") h.state.mode = kind;
      if (kind === "capture failure") h.state.captureFails = true;
      if (kind === "mode failure") h.state.modeFails = true;
      void h.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.handoff).not.toHaveBeenCalled();
      expect(h.fm.getInstanceExecutionState("worker")).not.toBe("idle");
    },
  );

  it("preserves the existing 60s force handoff for a genuinely busy pane", async () => {
    const h = harness();
    h.state.pane = BUSY;
    const delivery = h.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.handoff).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(delivery).resolves.toBe(true);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.anything(), "Idle gate timed out; forcing delivery");
  });

  it.each(["busy", "dialog", "transient", "cooked", "capture failure", "mode failure", "pane change", "spawn", "retry"])(
    "%s interrupts the candidate and requires a fresh full stable window", async kind => {
      const h = harness();
      const delivery = h.start();
      await vi.advanceTimersByTimeAsync(6_000);
      if (kind === "busy") h.state.pane = BUSY;
      if (kind === "dialog") h.state.pane = TRUST;
      if (kind === "transient") h.state.pane = LOADING;
      if (kind === "cooked") h.state.mode = "cooked";
      if (kind === "capture failure") h.state.captureFails = true;
      if (kind === "mode failure") h.state.modeFails = true;
      if (kind === "pane change") h.state.pane = NO_CONTEXT + "\nnew text";
      if (kind === "spawn") h.daemon.spawnGeneration++;
      if (kind === "retry") h.daemon.launchAttempt++;
      await vi.advanceTimersByTimeAsync(1_000);
      h.state.pane = NO_CONTEXT;
      h.state.mode = "raw";
      h.state.captureFails = false;
      h.state.modeFails = false;
      await vi.advanceTimersByTimeAsync(1_000);
      // Epoch changes already start the new candidate at the 7s query; the
      // other interruptions return to the candidate at the 8s query.
      const alreadyStableMs = kind === "spawn" || kind === "retry" ? 1_000 : 0;
      const restartAt = Date.now() - alreadyStableMs;
      await vi.advanceTimersByTimeAsync(UNKNOWN_LAYOUT_STABLE_MS - alreadyStableMs - 1);
      expect(h.handoff).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(delivery).resolves.toBe(true);
      expect(Date.now() - restartAt).toBe(UNKNOWN_LAYOUT_STABLE_MS);
    },
  );

  it("a changing unknown screen never accumulates ten seconds", async () => {
    const h = harness();
    void h.start();
    for (let i = 0; i < 6; i++) {
      h.state.pane = NO_CONTEXT + `\nprogress ${i}`;
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(h.handoff).not.toHaveBeenCalled();
  });

  it.each([BUSY, TRUST, LOADING])("another state observer can interrupt the candidate between fleet polls (%#)", async pane => {
    const h = harness();
    const delivery = h.start();
    await vi.advanceTimersByTimeAsync(6_500);
    h.state.pane = pane;
    await h.daemon.respondToInstanceStateQuery({ requestId: "reply-grace", refresh: true }, {});
    h.state.pane = NO_CONTEXT;
    await vi.advanceTimersByTimeAsync(10_499);
    expect(h.handoff).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.handoff).toHaveBeenCalledOnce();
    await expect(delivery).resolves.toBe(true);
  });

  it.each(["state_query", "safety_sweep", "output_probe"].flatMap(reason =>
    [{ kind: "busy", pane: BUSY }, { kind: "dialog", pane: TRUST }, { kind: "transient", pane: LOADING }]
      .map(interruption => ({ reason, ...interruption })),
  ))("a stale $reason capture of a $kind pane resets both gates' stable window", async ({ reason, pane }) => {
    const h = harness();
    const delivery = h.start();
    await vi.advanceTimersByTimeAsync(6_500);
    let release!: (pane: string) => void;
    h.daemon.tmux.capturePane.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    h.state.pane = pane;
    const observation = h.daemon.captureAndEvaluateInstanceState(reason);
    await vi.advanceTimersByTimeAsync(1);
    // New output arrives while the ordinary observer awaits its capture.
    // The changed pane must invalidate the candidate even though the state
    // evaluation now returns early because this observation is stale.
    h.daemon.instanceStateLastOutputAt = Date.now();
    release(pane);
    await observation;
    h.state.pane = NO_CONTEXT;
    await vi.advanceTimersByTimeAsync(3_499); // old candidate's 10s deadline
    expect(h.handoff).not.toHaveBeenCalled();
    expect(await h.daemon.hasPositiveDeliveryInput(), "the paste gate shares the invalidated timer").toBe(false);
    await vi.advanceTimersByTimeAsync(6_999); // 9,999ms after the next fleet observation at 7s
    expect(h.handoff).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.handoff).toHaveBeenCalledOnce();
    await expect(delivery).resolves.toBe(true);
    expect(await h.daemon.hasPositiveDeliveryInput()).toBe(true);
  });

  it.each(["output", "spawn", "retry"])("%s during the async TTY probe invalidates the captured proof", async kind => {
    const h = harness();
    const delivery = h.start();
    await vi.advanceTimersByTimeAsync(9_000);
    let release!: (mode: string) => void;
    h.daemon.tmux.getPaneInputMode.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.handoff).not.toHaveBeenCalled();
    if (kind === "output") h.daemon.instanceStateLastOutputAt = Date.now();
    if (kind === "spawn") h.daemon.spawnGeneration++;
    if (kind === "retry") h.daemon.launchAttempt++;
    release("raw");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.handoff).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_999);
    expect(h.handoff).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(delivery).resolves.toBe(true);
  });

  it.each(["spawn", "retry"])("%s during pane capture cannot retire the new launch's transient guard", async kind => {
    const h = harness();
    const delivery = h.start();
    await vi.advanceTimersByTimeAsync(9_000);
    let release!: (pane: string) => void;
    h.daemon.tmux.capturePane.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(1_000);
    if (kind === "spawn") h.daemon.spawnGeneration++;
    h.daemon.launchAttempt++;
    h.daemon.inputTransientGuardGeneration = h.daemon.spawnGeneration;
    h.daemon.inputTransientSeenAttempt = h.daemon.launchAttempt;
    release(NO_CONTEXT);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.handoff).not.toHaveBeenCalled();
    expect(h.daemon.inputTransientRetiredAttempt).not.toBe(h.daemon.launchAttempt);
    await vi.advanceTimersByTimeAsync(10_999);
    expect(h.handoff).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(delivery).resolves.toBe(true);
  });

  it("canonical blocking dialogs veto even an optimistic structural backend check", async () => {
    const h = harness();
    vi.spyOn(h.backend, "isStableUnknownLayoutIdlePane").mockReturnValue(true);
    vi.spyOn(h.backend, "getRuntimeDialogs").mockReturnValue([{ name: "test-dialog", pattern: /BLOCKING/, keys: [], holdOnly: true }] as any);
    h.state.pane = NO_CONTEXT + "\nBLOCKING";
    void h.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.handoff).not.toHaveBeenCalled();
  });

  it("an active startup transient vetoes even an optimistic structural backend check", async () => {
    const h = harness();
    vi.spyOn(h.backend, "isStableUnknownLayoutIdlePane").mockReturnValue(true);
    h.state.pane = LOADING;
    void h.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.handoff).not.toHaveBeenCalled();
  });

  it("foreground activity vetoes even an optimistic structural backend check", async () => {
    const h = harness();
    vi.spyOn(h.backend, "isStableUnknownLayoutIdlePane").mockReturnValue(true);
    h.daemon.backend.getPaneActivity = () => ({ tool: "Running", detail: "foreground process" });
    void h.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.handoff).not.toHaveBeenCalled();
  });

  it("a pre-wake idle cache does not bypass the fresh structural proof", async () => {
    const h = harness();
    h.fm.cacheInstanceExecutionState("worker", { state: "idle", observedAt: Date.now() - 1_000 });
    vi.spyOn(h.fm.lifecycle, "isPaused").mockReturnValue(true);
    vi.spyOn(h.fm.lifecycle, "wake").mockResolvedValue(undefined);
    const delivery = h.start();
    await vi.advanceTimersByTimeAsync(UNKNOWN_LAYOUT_STABLE_MS - 1);
    expect(h.handoff).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.handoff).toHaveBeenCalledOnce();
    await expect(delivery).resolves.toBe(true);
  });

  it("cancellation cleans up the idle waiter and polling without a handoff", async () => {
    const h = harness();
    const delivery = h.start();
    await vi.advanceTimersByTimeAsync(6_000);
    h.fm.deliveryEpochs.set("worker", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(delivery).resolves.toBe(false);
    expect(h.handoff).not.toHaveBeenCalled();
    expect(h.fm.instanceIdleWaiters.has("worker")).toBe(false);
    const queries = h.query.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.query).toHaveBeenCalledTimes(queries);
  });

  it("ordinary queries remain cache-only", async () => {
    const h = harness();
    await h.daemon.respondToInstanceStateQuery({ requestId: "fleet-state-1" }, {});
    expect(h.daemon.tmux.capturePane).not.toHaveBeenCalled();
    expect(h.daemon.tmux.getPaneInputMode).not.toHaveBeenCalled();
  });

  it("native readiness retains its normal state reading without a fallback delay", async () => {
    const h = harness();
    h.daemon.backend = { getReadyPattern: () => /READY/ };
    h.daemon.instanceStateMachine = new PaneStateMachine(/READY/, 15 * 60_000);
    h.daemon.instanceStateMachine.observe("WORKING");
    h.state.pane = "READY";
    const delivery = h.start();
    await vi.advanceTimersByTimeAsync(0);
    await expect(delivery).resolves.toBe(true);
    expect(h.daemon.tmux.getPaneInputMode).not.toHaveBeenCalled();
  });

  it("a recognised Codex footer keeps its native readiness without ten seconds of fallback", async () => {
    const h = harness();
    h.state.pane = CONTEXT_IDLE;
    const delivery = h.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.handoff).toHaveBeenCalledOnce();
    await expect(delivery).resolves.toBe(true);
    expect(h.daemon.tmux.getPaneInputMode).not.toHaveBeenCalled();
  });
});
