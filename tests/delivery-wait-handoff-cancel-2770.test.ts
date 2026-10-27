/**
 * #2770: a delivery waiting for idle held the daemon's paste queue, and every message behind it, for as long as the
 * pane kept moving (the leader, 2026-10-27: a schedule raw_paste waited 11 minutes behind background-agent clocks; three
 * human messages and a steer queued behind it; a Cancel freed nothing and later turned them into silent "uncertain").
 *
 * Now a waiting delivery hands off as soon as the busy pane can take it (asked every HANDOFF_RECHECK_MS), and stops at
 * once on a cancel; the person is told which of their messages a cancel dropped. The real Daemon runs every gate of
 * deliverMessage on the leader's replayed frames (tests/fixtures/claude-2.1.311-*); only the pane write itself
 * (writeMessageToPane) and the probes that need a live tmux are stubbed. Nothing starts a CLI or a tmux server.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { createBackend } from "../src/backend/factory.js";
import { InstanceLifecycle, type IncidentEventSource, type LifecycleContext } from "../src/instance-lifecycle.js";
import { Daemon, HANDOFF_RECHECK_MS } from "../src/daemon.js";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const THREE = fixture("claude-2.1.311-bg-agents-three-busy.pane.txt");
const ONE = fixture("claude-2.1.311-bg-agent-one-idle.pane.txt");
const NONE_BUSY = fixture("claude-2.1.293-busy-empty.pane.txt");
/** Three agents with the box unreadable (its lower rule gone) — how every frame read before #2771. */
const THREE_NO_BOX = THREE.replace(/\n─{20,}\n(?=  ok)/, "\n");

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } } as any;

function rig(screen: () => string, opts: { quiet?: boolean | (() => boolean); backend?: "claude-code" | "grok" } = {}) {
  const quiet = () => (typeof opts.quiet === "function" ? opts.quiet() : opts.quiet === true);
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "agend-2770b-")); roots.push(root);
  const dir = join(root, "instances", "leader");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "window-id"), "@1");
  // The pane never goes quiet: the agents' clocks repaint every second.
  const control = {
    isIdle: () => quiet(), getLastOutputAt: () => Date.now(), getObservationResetAt: () => 0, hasOutputSince: () => true,
    // As TmuxControlClient's: polls the silence, gives up when the caller abandons it or at the timeout.
    waitUntilIdle: vi.fn((_w: string, timeoutMs: number, abandoned?: () => boolean) => new Promise<boolean>(resolve => {
      if (quiet()) { resolve(true); return; }
      const started = Date.now();
      const check = setInterval(() => {
        if (quiet()) { clearInterval(check); resolve(true); return; }
        if (abandoned?.() || Date.now() - started >= timeoutMs) { clearInterval(check); resolve(false); }
      }, 200);
    })),
  };
  const d: any = new Daemon("leader", {
    working_directory: root, backend: "claude-code", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, dir, false, (opts.backend === "grok" ? createBackend("grok", dir) : new ClaudeCodeBackend(dir)) as any, control as any, logger);
  d.processStatus = "running";
  d.tmux = { capturePane: vi.fn(async () => screen()), getWindowId: () => "@1", isWindowAlive: async () => true };
  vi.spyOn(d, "wake").mockResolvedValue(undefined);
  vi.spyOn(d, "waitForSpawnToSettle").mockResolvedValue(true);
  vi.spyOn(d, "needsStartupInputProof").mockReturnValue(false);
  vi.spyOn(d, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
  vi.spyOn(d, "probeInputTransient").mockResolvedValue({ state: "clear" });
  vi.spyOn(d, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(d, "clearRestoredInputDraft").mockResolvedValue("clear");
  const writes: Array<{ text: string; handOff: boolean; at: number }> = [];
  vi.spyOn(d, "writeMessageToPane").mockImplementation(async (...args: unknown[]) => {
    writes.push({ text: String(args[0]), handOff: args[2] as boolean, at: Date.now() });
    return true;
  });
  const cancelled: Array<Array<{ messageId: string }>> = [];
  d.on("human_messages_cancelled", (e: { messages: Array<{ messageId: string }> }) => cancelled.push(e.messages));
  const human = (id: string, text: string) => ({ user: "hanhanv", user_id: "1", chat_id: "chat", thread_id: "topic", message_id: id, ts: new Date().toISOString(), text });
  return { d, writes, cancelled, human, control };
}

const order = (writes: Array<{ text: string }>) => writes.map(w => (/Follow-up/.test(w.text) ? "schedule" : /root cause/.test(w.text) ? "A" : /\?$|\? *$/.test(w.text) || /\bB-q\b/.test(w.text) ? "B" : /steer-C/.test(w.text) ? "C" : w.text.slice(0, 20)));

describe("tonight's shape: a schedule paste waiting, then a person's messages and a steer", () => {
  it("the box reads again: the waiting paste hands off within a re-check, and everyone behind it goes straight after — in order", async () => {
    let readable = false;
    const { d, writes, cancelled, human } = rig(() => (readable ? THREE : THREE_NO_BOX));
    const t0 = Date.now();
    d.queueRawPaste("Follow-up: re-arm one 5-min check");
    await vi.advanceTimersByTimeAsync(2_000);
    d.pushChannelMessage("so what's the root cause", human("m-A", ""));
    await vi.advanceTimersByTimeAsync(3_000);
    d.pushChannelMessage("B-q ?", human("m-B", ""));
    await vi.advanceTimersByTimeAsync(3_000);
    d.steerMessage("steer-C", human("m-C", ""));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toHaveLength(0);                     // nothing could read the box: nothing was written blind
    readable = true;                                   // what #2771 made true for the same frames
    const readableAt = Date.now();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(order(writes)).toEqual(["schedule", "A", "B", "C"]);
    expect(writes.every(w => w.handOff)).toBe(true);
    // the whole queue drained within a few seconds of the box reading — not when the agents end
    expect(writes[writes.length - 1]!.at - readableAt).toBeLessThanOrEqual(HANDOFF_RECHECK_MS + 1_500);
    expect(cancelled).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(60_000);
  });

  it.each([
    ["three agents (box reads, #2771)", THREE],
    ["one agent", ONE],
    ["no agents, a busy turn", NONE_BUSY],
  ])("%s: each delivery is handed off on arrival, within seconds", async (_name, pane) => {
    const { d, writes, cancelled, human } = rig(() => pane);
    d.queueRawPaste("Follow-up: re-arm one 5-min check");
    d.pushChannelMessage("so what's the root cause", human("m-A", ""));
    d.pushChannelMessage("B-q ?", human("m-B", ""));
    d.steerMessage("steer-C", human("m-C", ""));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(order(writes)).toEqual(["schedule", "A", "B", "C"]);
    expect(writes.every(w => w.handOff)).toBe(true);
    expect(cancelled).toEqual([]);
  });
});

describe("a hand-off whose box went unreadable at the last capture", () => {
  it("waits, and writes again as soon as the box reads — not when the pane goes quiet", async () => {
    const { d, writes, human } = rig(() => ONE);
    let first = true;
    (d.writeMessageToPane as any).mockImplementation(async (...args: unknown[]) => {
      if (first) { first = false; return "handoff-box-unread"; }
      writes.push({ text: String(args[0]), handOff: args[2] as boolean, at: Date.now() });
      return true;
    });
    d.pushChannelMessage("so what's the root cause", human("m-A", ""));
    await vi.advanceTimersByTimeAsync(HANDOFF_RECHECK_MS + 2_000);
    expect(order(writes)).toEqual(["A"]);
  });
});

describe("Cancel frees the lane, and says what it dropped", () => {
  it("the waiting paste stops at once; the person's queued messages are dropped AND told (one notice); the next message goes through", async () => {
    let readable = false;
    const { d, writes, cancelled, human, control } = rig(() => (readable ? ONE : THREE_NO_BOX));
    d.queueRawPaste("Follow-up: re-arm one 5-min check");
    d.pushChannelMessage("so what's the root cause", human("m-A", ""));
    d.pushChannelMessage("B-q ?", human("m-B", ""));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toHaveLength(0);
    const depthBefore = d.pasteQueueDepth;
    expect(depthBefore).toBe(2);
    expect(control.waitUntilIdle).toHaveBeenCalled();
    d.clearPendingDeliveries();                        // the person pressed Cancel
    await vi.advanceTimersByTimeAsync(1_000);
    expect(d.pasteQueueDepth).toBe(0);                 // the lane is free within a second, the pane still moving
    // …and the tmux-silence wait under it was told it is abandoned (no 30-minute poll left behind)
    for (const call of control.waitUntilIdle.mock.calls) expect((call[2] as () => boolean)()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(cancelled).toHaveLength(1);                 // one notice for both
    expect(cancelled[0]!.map(m => m.messageId).sort()).toEqual(["m-A", "m-B"]);
    expect(writes).toHaveLength(0);                    // nothing dropped was written
    readable = true;
    d.pushChannelMessage("after the cancel", human("m-D", ""));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(writes.map(w => w.text)).toEqual([expect.stringContaining("after the cancel")]);
  });

  it("agents' messages are not a person's: a cancel drops them without a notice (their durable rows retry)", async () => {
    const { d, cancelled } = rig(() => THREE_NO_BOX);
    d.pushChannelMessage("from a peer", { from_instance: "peer", user: "instance:peer", chat_id: "chat", thread_id: "", message_id: "x-1", ts: "" });
    await vi.advanceTimersByTimeAsync(2_000);
    d.clearPendingDeliveries();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(cancelled).toEqual([]);
  });

  it("a message that arrives just after the cancel, still under the old epoch, joins the same notice", async () => {
    const { d, cancelled, human } = rig(() => THREE_NO_BOX);
    const oldEpoch = d.deliveryEpoch;
    d.pushChannelMessage("so what's the root cause", human("m-A", ""));
    await vi.advanceTimersByTimeAsync(2_000);
    d.clearPendingDeliveries();
    await vi.advanceTimersByTimeAsync(400);
    d.pushChannelMessage("B-q ?", human("m-B", ""), undefined, oldEpoch);   // sent before the cancel, admitted after
    await vi.advanceTimersByTimeAsync(3_000);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.map(m => m.messageId).sort()).toEqual(["m-A", "m-B"]);
  });

  it("a delivery the cancel overtakes after it was written is not reported as dropped", async () => {
    const { d, writes, cancelled, human } = rig(() => ONE);
    (d.writeMessageToPane as any).mockImplementation(async (...args: unknown[]) => {
      writes.push({ text: String(args[0]), handOff: args[2] as boolean, at: Date.now() });
      d.clearPendingDeliveries();                      // Cancel lands as the write completes
      return true;
    });
    d.pushChannelMessage("so what's the root cause", human("m-A", ""));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(writes).toHaveLength(1);
    expect(cancelled).toEqual([]);
  });

  it("a cancel also ends the wait while the pane is quiet but its input is still loading", async () => {
    let n = 0;
    const { d, cancelled, human } = rig(() => ONE, { quiet: true });
    (d.probeInputTransient as any).mockImplementation(async () => ({ state: "active", pane: `loading ${n++}`, transient: { description: "loading" } }));
    vi.spyOn(d, "paneReadinessForDelivery").mockResolvedValue("transient");
    d.pushChannelMessage("so what's the root cause", human("m-A", ""));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(d.pasteQueueDepth).toBe(1);
    d.clearPendingDeliveries();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(d.pasteQueueDepth).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cancelled).toHaveLength(1);
  });
});

describe("a steer waiting on its own lane", () => {
  it("a cancel ends its wait and tells the person, like a queued message", async () => {
    const { d, writes, cancelled, human } = rig(() => THREE_NO_BOX);
    d.steerMessage("steer-C", human("m-C", ""));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(writes).toHaveLength(0);
    d.clearPendingDeliveries();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(cancelled).toEqual([[expect.objectContaining({ messageId: "m-C" })]]);
  });
});

describe("the fleet side of human_messages_cancelled", () => {
  it("marks each dropped message ❌ and posts ONE notice in the instance's chat", () => {
    const statuses: unknown[][] = [];
    const notices: string[] = [];
    const ctx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      eventLog: null,
      finishDeliveryStatus: (...a: unknown[]) => { statuses.push(a); },
      reactMessageStatus: () => { throw new Error("finishDeliveryStatus is the path"); },
      notifyInstanceTopic: (_name: string, text: string) => { notices.push(text); return true; },
    } as unknown as LifecycleContext;
    const daemon = new EventEmitter() as unknown as IncidentEventSource & EventEmitter;
    new InstanceLifecycle(ctx).attachDeliveryStatusHandlers("leader", daemon);
    daemon.emit("human_messages_cancelled", { messages: [
      { chatId: "chat", messageId: "m-A", threadId: "topic" }, { chatId: "chat", messageId: "m-B" },
    ] });
    expect(statuses).toEqual([["leader", "chat", "m-A", "failed", "topic"], ["leader", "chat", "m-B", "failed", undefined]]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/\b2\b/);
    expect(notices[0]).toContain("leader");
    daemon.emit("human_messages_cancelled", { messages: [] });     // nothing dropped: nothing said
    expect(notices).toHaveLength(1);
  });
});

describe("review fences (#2782)", () => {
  it("a backend that cannot take input mid-turn keeps waiting for idle, however long the gates pass", async () => {
    let quietNow = false;
    const { d, writes, human } = rig(() => ONE, { backend: "grok", quiet: () => quietNow });
    expect(d.backend.supportsQueuedInput?.()).toBeFalsy();
    vi.spyOn(d, "hasPositiveDeliveryInput").mockResolvedValue(true);
    vi.spyOn(d, "submitStrandedInputIfAny").mockResolvedValue("idle");
    d.pushChannelMessage("so what's the root cause", human("m-A", ""));
    await vi.advanceTimersByTimeAsync(10 * HANDOFF_RECHECK_MS);
    expect(writes).toHaveLength(0);                    // busy the whole time: no hand-off, however readable the box
    quietNow = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.handOff).toBe(false);            // delivered on idle, the ordinary way
  });

  it.each(["queue", "steer", "btw"] as const)("%s: a cancel after the paste began is not reported as dropped (a resend would duplicate it)", async kind => {
    const { d, cancelled, human } = rig(() => ONE);
    (d.writeMessageToPane as any).mockImplementation(async (...args: unknown[]) => {
      (args[5] as { paneWriteStarted?: boolean }).paneWriteStarted = true;   // the paste is on the pane
      d.clearPendingDeliveries();                      // Cancel lands before Enter / its confirmation
      return false;
    });
    if (kind === "queue") d.pushChannelMessage("so what's the root cause", human("m-A", ""));
    else if (kind === "steer") d.steerMessage("steer-C", human("m-A", ""));
    else d.btwMessage("a side question", human("m-A", ""));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(cancelled).toEqual([]);
  });

  it("a durable row (delivery_id) is the outbox's to retry: never told as dropped", async () => {
    const { d, cancelled, human } = rig(() => THREE_NO_BOX);
    d.pushChannelMessage("so what's the root cause", { ...human("m-A", ""), delivery_id: "d-1", delivery_attempt: "1" });
    await vi.advanceTimersByTimeAsync(2_000);
    d.clearPendingDeliveries();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(cancelled).toEqual([]);
  });
});
