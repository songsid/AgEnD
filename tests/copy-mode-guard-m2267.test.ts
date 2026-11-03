/**
 * M-2267 (the user, hmsg-b8a170c0; leader xmsg-1793679613589): a pane a person left in tmux copy-mode (scrolling it from
 * an attached client) must never take a delivery's keys. Reproduced first in a private tmux with delivery's exact
 * sequence: the paste reaches the CLI, but copy-mode takes the Enter — the message sits unsent while delivery believes it
 * submitted. Now, with `#{pane_in_mode}` read before every delivery key:
 *  - the readiness wait holds while the pane is in a mode (and never takes it out of it);
 *  - a pane that went into a mode before the paste: nothing begun or written — wait for readiness, try again;
 *  - a pane in a mode at the Enter (the text already in the box): the Enter waits for the mode to end, then goes, once;
 *    still in it at the bound: withheld — never reported delivered;
 *  - TmuxManager.paneInMode against a real tmux (the isolated private socket).
 * Real Daemon and DeliveryOutbox, stub tmux serving Claude captures; nothing starts a CLI or a fleet.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { getTmuxSocketName } from "../src/paths.js";

const pane = (name: string) => readFileSync(join(__dirname, "fixtures", `claude-2.1.293-${name}.pane.txt`), "utf8");
const BUSY_EMPTY = pane("busy-empty"), BUSY_PASTED = pane("long-busy-pasted"), BUSY_QUEUED = pane("long-busy-queued");

interface Screen { pasted: number; enters: number; inMode: boolean; waited: number; modeReads: number; keysInMode: number; pasteAttempts: number; modeEnded: boolean }
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;

function makeDaemon(root: string, screen: (s: Screen) => string, modeAt: (s: Screen) => boolean, opts: { failFirstPaste?: boolean } = {}) {
  const instanceDir = join(root, "instances", "worker");
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "window-id"), "@worker");
  const s: Screen = { pasted: 0, enters: 0, inMode: false, waited: 0, modeReads: 0, keysInMode: 0, pasteAttempts: 0, modeEnded: false };
  const control = { getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => false, hasOutputSince: () => true, waitUntilIdle: vi.fn(async () => true) };
  const backend = new ClaudeCodeBackend(instanceDir);
  const daemon: any = new Daemon("worker", {
    working_directory: root, log_level: "error", backend: "claude-code",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, instanceDir, false, backend as any, control as any, logger);
  const tmux = {
    capturePane: vi.fn(async () => screen(s)),
    capturePaneWithHistory: vi.fn(async () => screen(s)),
    // A key or a paste while the pane is in a mode is what this guard exists to prevent: counted.
    pasteBuffer: vi.fn(async () => {
      const inMode = modeAt(s);                                        // the pane's mode at this write, whoever asked
      s.pasteAttempts++;
      if (inMode) s.keysInMode++;
      if (opts.failFirstPaste && s.pasteAttempts === 1) return false;          // a recoverable paste failure (a stale window)
      s.pasted++; return true;
    }),
    sendSpecialKey: vi.fn(async (key: string) => { if (modeAt(s)) { s.keysInMode++; return true; } if (key === "Enter") s.enters++; return true; }),
    paneInMode: vi.fn(async () => { s.modeReads++; const was = s.inMode; s.inMode = modeAt(s); if (was && !s.inMode) s.modeEnded = true; return s.inMode; }),
    getLastPasteError: vi.fn(), isLastPasteFailureRecoverable: vi.fn(() => true), getLastSendSpecialKeyError: vi.fn(),
    getWindowId: () => "@worker",
  };
  daemon.tmux = tmux;
  vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
  vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("busy");
  vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockImplementation(async () => { s.waited++; return true; });
  vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
  vi.spyOn(daemon, "recoverWindow").mockResolvedValue("@worker");
  return { daemon, tmux, s };
}

async function deliver(screen: (s: Screen) => string, modeAt: (s: Screen) => boolean, runMs = 120_000, withDaemon?: (d: any) => void, opts: { failFirstPaste?: boolean } = {}) {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "agend-copy-mode-")); roots.push(root);
  const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-test");
  const { daemon, tmux, s } = makeDaemon(root, screen, modeAt, opts);
  daemon.setDeliveryOutboxPort(outbox);
  withDaemon?.(daemon);
  const row = outbox.admit({
    operationId: "op", sourceKey: "s:op:w:fleet_inbound", sourceInstance: "source", sourceDaemonBootId: "sb",
    targetInstance: "worker", kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "hello", meta: {} },
  }).delivery;
  const claimed = outbox.claimNext("manager-test", () => daemon.bootId, new Set())!;
  const failed = vi.fn(); daemon.on("message_failed", failed);
  daemon.pushChannelMessage("hello", {
    delivery_id: row.deliveryId, delivery_attempt: String(claimed.attemptNo), from_instance: "source", correlation_id: "c",
    user: "instance:source", user_id: "instance:source", message_id: "xmsg-copy-mode", chat_id: "chat", thread_id: "", ts: new Date().toISOString(),
  });
  const final = () => ["delivered", "failed", "retry_wait", "uncertain", "aborted"].includes(String(outbox.get(row.deliveryId)?.state));
  for (let t = 0; t < runMs && !final(); t += 1_000) await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(3_000);
  return { state: outbox.get(row.deliveryId)?.state, tmux, failed, s };
}
// The screen as delivery sees it: the box, then our paste in it, then Claude's queue taking it (after the Enter).
const claude = (s: Screen) => (!s.pasted ? BUSY_EMPTY : s.enters === 0 ? BUSY_PASTED : BUSY_QUEUED);

describe("a delivery to a pane left in copy-mode", () => {
  it("in a mode at the Enter (the text in the box): no key while it lasts; once it ends, one Enter — delivered", async () => {
    let since = -1;
    const r = await deliver(claude, (s) => {
      if (!s.pasted) return false;                                   // the person scrolls up right after the paste…
      if (since < 0) since = s.modeReads;
      return s.modeReads - since < 20;                               // …for ~10 s (20 reads, 500 ms apart), then leaves it
    });
    expect(r.state).toBe("delivered");
    expect([r.s.keysInMode, r.s.pasted, r.s.enters]).toEqual([0, 1, 1]);
    expect(r.s.modeReads).toBeGreaterThanOrEqual(20);
    expect(r.failed).not.toHaveBeenCalled();
  });
  it("in a mode before the paste: nothing pasted while it lasts; the delivery waits for readiness and tries again", async () => {
    // In the mode until the second readiness wait (the real wait holds while it lasts: this one is a stub).
    const r = await deliver(claude, (s) => s.waited < 2);
    expect(r.state).toBe("delivered");
    expect([r.s.keysInMode, r.s.pasted, r.s.enters]).toEqual([0, 1, 1]);
    expect(r.s.waited).toBeGreaterThanOrEqual(2);
  });
  it("a mode that outlasts every retry round before the paste: nothing written, and not delivered — tried again later", async () => {
    const r = await deliver(claude, () => true);
    expect([r.s.keysInMode, r.s.pasted, r.s.enters]).toEqual([0, 0, 0]);
    expect(r.state).not.toBe("delivered");
  });
  it("never in a mode: exactly as before (one paste, one Enter, delivered)", async () => {
    const r = await deliver(claude, () => false);
    expect([r.state, r.s.pasted, r.s.enters, r.s.keysInMode]).toEqual(["delivered", 1, 1, 0]);
  });
  it("an unreadable mode (tmux did not answer) is not a mode: the delivery's own reads decide, as before", async () => {
    const r = await deliver(claude, () => false);
    expect(r.state).toBe("delivered");
  });
  // beta.5 (decision f57474aa): "a dialog that appeared during the Enter's wait is never answered" relied on #2958's
  // composer proof, which is reverted; #2957 is open again and its redesign brings that case back.
  it("#2971 review: the pane went back into a mode at the second look: wait again, look again, then one Enter", async () => {
    let since = -1;
    const r = await deliver(claude, (s) => {
      if (!s.pasted) return false;
      if (since < 0) since = s.modeReads;
      const look = s.modeReads - since;
      return look >= 1 && look <= 4;                                 // clear for the wait; in a mode at the check after the proof
    });
    expect([r.s.keysInMode, r.s.enters, r.state]).toEqual([0, 1, "delivered"]);
    expect(r.s.modeReads - since).toBeGreaterThanOrEqual(5);          // it looked again after the mode ended
  });
  it("#2971 review: a paste retry after a failed paste never writes into a mode that began during the backoff", async () => {
    // The first paste fails (recoverably); the person scrolls for 5 s from then — through the 2 s backoff and the retry.
    let failedAt = -1;
    const r = await deliver(claude, (s) => {
      if (s.pasteAttempts < 1) return false;
      if (failedAt < 0) failedAt = Date.now();
      return Date.now() - failedAt < 5_000;
    }, 120_000, undefined, { failFirstPaste: true });
    expect(r.s.keysInMode).toBe(0);                                    // the retry waited the mode out, in place
    expect([r.s.pasteAttempts, r.s.pasted, r.s.enters, r.state]).toEqual([2, 1, 1, "delivered"]);
  });
  it("#2971 review: a paste retry whose mode outlasts the wait fails unwritten — never pasted into it, never delivered", async () => {
    const r = await deliver(claude, (s) => s.pasteAttempts >= 1, 12 * 60_000, undefined, { failFirstPaste: true });
    expect([r.s.keysInMode, r.s.pasted, r.s.enters]).toEqual([0, 0, 0]);
    expect(r.state).not.toBe("delivered");
  }, 30_000);
  it("#2971 re-review: a pane flickering in and out of a mode at every look is held at the deadline — never past it, never an Enter", async () => {
    let since = -1, heldAt = -1, startedAt = -1;
    const r = await deliver(claude, (s) => {
      if (!s.pasted) return false;
      if (since < 0) { since = s.modeReads; startedAt = performance.now(); }
      return (s.modeReads - since) % 2 === 1;                        // clear at the wait's look, in a mode at the post-proof look
    }, 14 * 60_000, (d) => {
      const warn = d.logger.warn.bind(d.logger);
      d.logger = { ...d.logger, warn: (o: any, m?: string) => { if (heldAt < 0 && /Enter withheld/.test(String(m))) heldAt = performance.now(); return warn(o, m); } };
    });
    expect([r.s.keysInMode, r.s.enters]).toEqual([0, 0]);
    expect(r.state).not.toBe("delivered");
    expect(heldAt).toBeGreaterThan(0);                                 // the loop ended: held…
    expect(heldAt - startedAt).toBeLessThan(10 * 60_000 + 5_000);      // …at the 10-min bound, not past it
    expect(heldAt - startedAt).toBeGreaterThanOrEqual(10 * 60_000 - 5_000);
  }, 60_000);
  it("stopped while the Enter waits for the mode (a cancel, a pause, a respawn): no Enter when the mode ends", async () => {
    let daemonRef: any = null, since = -1;
    const r = await deliver(claude, (s) => {
      if (!s.pasted) return false;
      if (since < 0) since = s.modeReads;
      if (s.modeReads - since === 4 && daemonRef) daemonRef.deliveryWritesStopping = true;   // the delivery's writes stop
      return s.modeReads - since < 10;
    }, 60_000, (d) => { daemonRef = d; });
    expect([r.s.keysInMode, r.s.enters]).toEqual([0, 0]);
    expect(r.state).not.toBe("delivered");
  });
  it("still in a mode when the Enter's wait runs out: the Enter is withheld — never reported delivered", async () => {
    const r = await deliver(claude, (s) => s.pasted > 0, 12 * 60_000);
    expect(r.s.keysInMode).toBe(0);
    expect(r.s.enters).toBe(0);
    expect(r.state).not.toBe("delivered");
    // beta.5: the pasted text may still be in the box — kept uncertain, never a failure that a retry re-pastes.
    expect([r.state, r.failed.mock.calls.length, r.s.pasted]).toEqual(["uncertain", 0, 1]);
  }, 30_000);
});

describe("the readiness wait holds while the pane is in a mode", () => {
  it("held while in it, ready once it ends — the pane never taken out of it", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "agend-copy-mode-ready-")); roots.push(root);
    let reads = 0;
    const { daemon, tmux } = makeDaemon(root, () => BUSY_EMPTY, () => ++reads <= 6);
    (daemon.waitForPaneReadyForDelivery as any).mockRestore();
    vi.spyOn(daemon, "waitForPaneIdleForDelivery").mockResolvedValue(true);
    vi.spyOn(daemon, "probeInputTransient").mockResolvedValue({ state: "none" });
    vi.spyOn(daemon, "isPaneReadyForDelivery").mockResolvedValue(true);
    const ready = daemon.waitForPaneReadyForDelivery("@worker", 60_000);
    let settled: unknown = "pending"; ready.then((v: unknown) => { settled = v; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(true);
    expect(tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(tmux.pasteBuffer).not.toHaveBeenCalled();
  });
});

describe("TmuxManager.paneInMode, against a real tmux", () => {
  it("1 in copy-mode, 0 out of it; a read only (the mode is the person's)", () => {
    // Its own private socket (never the live server): the AGEND_HOME socket is every test worker's, and another file's
    // real-tmux test (view-scrollback-api) ends that server with kill-server — run together, they raced (#2991).
    expect(getTmuxSocketName()).toBeTruthy();
    const socket = `agend-test-copy-mode-unit-${process.pid}`;
    TmuxManager.setSocketName(socket);
    try { execFileSync("tmux", ["-L", "agend-test-availability", "-V"], { stdio: "ignore" }); } catch { return; }
    const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket!, ...args], { encoding: "utf8" });
    try {
      tmux("new-session", "-d", "-s", "cm", "-x", "80", "-y", "10", "cat");
      const wid = tmux("list-windows", "-t", "cm", "-F", "#{window_id}").trim();
      const m = new TmuxManager("cm", wid);
      return (async () => {
        expect(await m.paneInMode()).toBe(false);
        tmux("copy-mode", "-t", "cm");
        expect(await m.paneInMode()).toBe(true);
        expect(tmux("display-message", "-p", "-t", "cm", "#{pane_in_mode}").trim()).toBe("1");   // still the person's
        tmux("send-keys", "-t", "cm", "-X", "cancel");
        expect(await m.paneInMode()).toBe(false);
        expect(await new TmuxManager("cm", "").paneInMode()).toBeNull();
      })().finally(() => { TmuxManager.setSocketName(null); try { tmux("kill-server"); } catch { /* gone */ } });
    } catch (e) { try { tmux("kill-server"); } catch { /* gone */ } throw e; }
  });
});
