/**
 * M-3660 (user 11-24): a Hub question is submitted only into an idle pane, as a turn of its own — Claude merges input
 * written into a running turn (its native queue) into that turn's work, so a question must never land inside a busy
 * agent's other task. While the Hub answer turn runs, other deliveries wait for it too. The daemon tells the fleet when
 * that turn starts (hub_question_input, just before the write) and ends (its idle edge after work, or the next write),
 * which is exactly the span of the agent's contact window.
 *
 * The real Daemon runs every gate of deliverMessage on replayed Claude frames; only the pane write and the probes that
 * need a live tmux are stubbed (as tests/delivery-wait-handoff-cancel-2770.test.ts). Nothing starts a CLI or tmux.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { createBackend } from "../src/backend/factory.js";
import { Daemon, isHubQuestionMeta } from "../src/daemon.js";

const BUSY = readFileSync(join(__dirname, "fixtures", "claude-2.1.293-busy-empty.pane.txt"), "utf8");
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } } as any;

function rig(opts: { backend?: "claude-code" | "grok"; root?: string } = {}) {
  let quiet = false;
  vi.useFakeTimers();
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "agend-m3660-")); if (!opts.root) roots.push(root);
  const dir = join(root, "instances", "rep");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "window-id"), "@1");
  const control = {
    isIdle: () => quiet, getLastOutputAt: () => Date.now(), getObservationResetAt: () => 0, hasOutputSince: () => true,
    waitUntilIdle: vi.fn((_w: string, timeoutMs: number, abandoned?: () => boolean) => new Promise<boolean>(resolve => {
      if (quiet) { resolve(true); return; }
      const started = Date.now();
      const check = setInterval(() => {
        if (quiet) { clearInterval(check); resolve(true); return; }
        if (abandoned?.() || Date.now() - started >= timeoutMs) { clearInterval(check); resolve(false); }
      }, 200);
    })),
  };
  const d: any = new Daemon("rep", {
    working_directory: root, backend: "claude-code", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, dir, false, (opts.backend === "grok" ? createBackend("grok", dir) : new ClaudeCodeBackend(dir)) as any, control as any, logger);
  d.processStatus = "running";
  d.tmux = { capturePane: vi.fn(async () => (quiet ? BUSY.replace(/^✻.*$/m, "") : BUSY)), getWindowId: () => "@1", isWindowAlive: async () => true };
  vi.spyOn(d, "wake").mockResolvedValue(undefined);
  vi.spyOn(d, "waitForSpawnToSettle").mockResolvedValue(true);
  vi.spyOn(d, "needsStartupInputProof").mockReturnValue(false);
  vi.spyOn(d, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
  vi.spyOn(d, "probeInputTransient").mockResolvedValue({ state: "clear" });
  vi.spyOn(d, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(d, "clearRestoredInputDraft").mockResolvedValue("clear");
  // Busy until told otherwise; idle once quiet (the pane's own readiness gate, as the live pane's silence).
  vi.spyOn(d, "paneReadinessForDelivery").mockImplementation(async () => (quiet ? "ready" : "busy"));
  const events: string[] = [];
  vi.spyOn(d, "broadcastFleetMessage").mockImplementation((msg: any) => {
    if (msg.type === "hub_question_input" || msg.type === "hub_question_turn_ended") events.push(`${msg.type}:${msg.correlationId}${msg.contactLimit === false ? ":off" : ""}`);
  });
  vi.spyOn(d, "writeMessageToPane").mockImplementation(async (...args: unknown[]) => {
    (args[10] as (() => void) | undefined)?.();   // beforePaste: called right before the paste, as the real write does
    events.push(`write:${/Hub question/.test(String(args[0])) ? "hub" : "other"}:${args[2] ? "handoff" : "idle"}`);
    return true;
  });
  const hub = (cid: string) => ({ user: "instance:agend-hub", user_id: "instance:agend-hub", chat_id: "", thread_id: "", message_id: `hubmsg-${cid.slice(4)}`,
    ts: new Date().toISOString(), from_instance: "agend-hub", from_display: "Hub", correlation_id: cid, request_kind: "query", requires_reply: "true" });
  const human = (id: string) => ({ user: "owner", user_id: "1", chat_id: "chat", thread_id: "topic", message_id: id, ts: new Date().toISOString(), text: "" });
  const failures: string[] = [];
  vi.spyOn(d, "reportCrossInstanceDeliveryFailure").mockImplementation((meta: any) => { failures.push(meta.correlation_id ?? meta.message_id); });
  /** A turn that really worked: the working edge, transcript activity (Claude's evidence), then the idle edge. */
  const work = () => { d.noteTurnEdge("working"); d.hubRoomTranscriptActivity++; d.noteTurnEdge("idle"); };
  return { d, events, hub, human, failures, work, root, setQuiet: (v: boolean) => { quiet = v; } };
}

describe("isHubQuestionMeta", () => {
  it("is a query from agend-hub on a hub-… correlation id; never a room notification or another sender", () => {
    const base = { from_instance: "agend-hub", request_kind: "query", correlation_id: `hub-${randomUUID()}` };
    expect(isHubQuestionMeta(base)).toBe(true);
    expect(isHubQuestionMeta({ ...base, correlation_id: `hub-room-${randomUUID()}` })).toBe(true);
    expect(isHubQuestionMeta({ ...base, request_kind: "notification", correlation_id: "hub-room-post-answer-1" })).toBe(false);
    expect(isHubQuestionMeta({ ...base, from_instance: "agend-leader" })).toBe(false);
    expect(isHubQuestionMeta({ ...base, correlation_id: "cid-123" })).toBe(false);
  });
});

describe("a Hub question is a turn of its own (M-3660)", () => {
  it("into a busy Claude pane it is never handed to the native queue: it waits for idle, then the turn's window opens just before its write", async () => {
    const { d, events, hub, human, setQuiet } = rig();
    // Baseline: an ordinary message into the same busy pane is handed into the running turn at once.
    d.pushChannelMessage("an owner's message", human("m-1"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events).toEqual(["write:other:handoff"]);
    events.length = 0;
    const cid = `hub-${randomUUID()}`;
    d.pushChannelMessage("A Hub question", hub(cid));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(events).toEqual([]);                               // the busy turn is not the Hub's: nothing written, no window
    setQuiet(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events).toEqual([`hub_question_input:${cid}`, "write:hub:idle"]);
  });

  it("while the Hub answer turn runs, other deliveries wait for it; the next write ends that turn first", async () => {
    const { d, events, hub, human, setQuiet } = rig();
    setQuiet(true);
    const cid = `hub-${randomUUID()}`;
    d.pushChannelMessage("A Hub question", hub(cid));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events).toEqual([`hub_question_input:${cid}`, "write:hub:idle"]);
    setQuiet(false); d.noteTurnEdge("working");               // the agent works on its answer
    d.pushChannelMessage("an owner's message", human("m-2"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(events).toHaveLength(2);                           // not handed into the Hub turn
    setQuiet(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events.slice(2)).toEqual([`hub_question_turn_ended:${cid}`, "write:other:idle"]);
  });

  it("the turn's idle edge after work ends it; an idle edge before any work (the previous turn settling) does not", async () => {
    const { d, events, hub, setQuiet, work } = rig();
    setQuiet(true);
    const cid = `hub-${randomUUID()}`;
    d.noteTurnEdge("idle");                                   // the previous turn's idle edge, still settling
    d.pushChannelMessage("A Hub question", hub(cid));
    await vi.advanceTimersByTimeAsync(10_000);                // that settle fires after the write
    expect(events).toEqual([`hub_question_input:${cid}`, "write:hub:idle"]);
    work();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.slice(2)).toEqual([`hub_question_turn_ended:${cid}`]);
  });

  it("a compaction flicker mid-turn (working → idle with no transcript work) does not end it; the next real work does", async () => {
    const { d, events, hub, setQuiet, work } = rig();
    setQuiet(true);
    const cid = `hub-${randomUUID()}`;
    d.pushChannelMessage("A Hub question", hub(cid));
    await vi.advanceTimersByTimeAsync(3_000);
    d.noteTurnEdge("working"); d.noteTurnEdge("idle");        // a compaction spinner: no tool call, no text
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toEqual([`hub_question_input:${cid}`, "write:hub:idle"]);
    d.noteTurnEdge("idle");                                   // re-armed: an idle edge alone ends nothing
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toHaveLength(2);
    work();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.slice(2)).toEqual([`hub_question_turn_ended:${cid}`]);
  });

  it("a daemon restarted mid-turn takes the turn up again: deliveries still wait behind it, and its end is announced", async () => {
    const first = rig();
    first.setQuiet(true);
    const cid = `hub-${randomUUID()}`;
    first.d.pushChannelMessage("A Hub question", first.hub(cid));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(first.events).toEqual([`hub_question_input:${cid}`, "write:hub:idle"]);
    const next = rig({ root: first.root });                   // a new daemon on the same instance directory
    expect(next.d.hubAnswerTurnStateMessage()).toEqual({ type: "hub_question_turn_state", correlationId: cid, contactLimit: true });
    next.d.pushChannelMessage("an owner's message", next.human("m-3"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(next.events).toEqual([]);                          // the pane is still busy with the Hub turn: no hand-off into it
    next.d.noteTurnEdge("working"); next.d.noteTurnEdge("idle");   // restored: its first idle edge ends it (no transcript proof needed)
    await vi.advanceTimersByTimeAsync(10_000);
    expect(next.events).toEqual([`hub_question_turn_ended:${cid}`]);   // ended by the edge itself, before any write
    next.setQuiet(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(next.events).toEqual([`hub_question_turn_ended:${cid}`, "write:other:idle"]);
    expect(next.d.hubAnswerTurnStateMessage()).toEqual({ type: "hub_question_turn_state", correlationId: null });
  });

  it("Lumen R2-A: a turn taken up from the record ends at once on an idle pane, and at a launch that starts a new CLI (not on a reattach)", async () => {
    const first = rig();
    first.setQuiet(true);
    const cid = `hub-${randomUUID()}`;
    first.d.pushChannelMessage("A Hub question", first.hub(cid));
    await vi.advanceTimersByTimeAsync(3_000);
    const idle = rig({ root: first.root });                   // the daemon came back; its pane is idle
    idle.d.noteTurnEdge("idle");                              // no working edge, no settle wait
    expect(idle.events).toEqual([`hub_question_turn_ended:${cid}`]);
    const cid2 = `hub-${randomUUID()}`;
    first.d.hubAnswerTurnBegins(cid2);                        // a record again (another turn of the first daemon)
    const reattached = rig({ root: first.root });
    reattached.d.settleHubAnswerTurnAtLaunch(true);           // a native reattach: the pane may still be answering
    expect(reattached.events).toEqual([]);
    expect(reattached.d.hubAnswerTurnStateMessage()).toMatchObject({ correlationId: cid2 });
    const relaunched = rig({ root: first.root });
    relaunched.d.settleHubAnswerTurnAtLaunch(false);          // a new CLI: the old turn is over
    expect(relaunched.events).toEqual([`hub_question_turn_ended:${cid2}`]);
    expect(relaunched.d.hubAnswerTurnStateMessage()).toEqual({ type: "hub_question_turn_state", correlationId: null });
  });

  it("a fleet (re)connecting asks for sessions and is told the current Hub turn, or none", async () => {
    const { d, hub, setQuiet } = rig();
    const told: any[] = [];
    d.handleFleetMessage({ type: "query_sessions" }, (reply: any) => told.push(reply));
    expect(told).toContainEqual({ type: "hub_question_turn_state", correlationId: null });
    setQuiet(true);
    const cid = `hub-${randomUUID()}`;
    d.pushChannelMessage("A Hub question", hub(cid));
    await vi.advanceTimersByTimeAsync(3_000);
    told.length = 0;
    d.handleFleetMessage({ type: "query_sessions" }, (reply: any) => told.push(reply));
    expect(told).toContainEqual({ type: "hub_question_turn_state", correlationId: cid, contactLimit: true });
  });

  it("Prism P2-2: an unreadable turn record is unknown, never 'none' — deliveries wait, the fleet is told unknown, and the next idle edge resolves it", async () => {
    const { d, events, human, setQuiet, root } = rig();
    writeFileSync(join(root, "instances", "rep", "hub-answer-turn.json"), "{ not json");
    expect(d.hubAnswerTurnStateMessage()).toEqual({ type: "hub_question_turn_state", correlationId: null, unknown: true });
    const states: any[] = [];
    (d.broadcastFleetMessage as any).mockImplementation((msg: any) => { if (msg.type === "hub_question_turn_state") states.push(msg); });
    d.pushChannelMessage("an owner's message", human("m-4"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(events).toEqual([]);                               // a turn may be running: nothing is handed into it
    d.noteTurnEdge("idle");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states).toEqual([{ type: "hub_question_turn_state", correlationId: null }]);   // resolved: the fleet hears "none"
    setQuiet(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events).toEqual(["write:other:idle"]);
  });

  it("Prism P2-2: a turn that cannot be recorded is not begun — the Hub question is not written and its delivery fails (reported)", async () => {
    const { d, events, hub, failures, setQuiet, root } = rig();
    mkdirSync(join(root, "instances", "rep", "hub-answer-turn.json"));   // the record's path cannot be written
    expect(d.hubAnswerTurnStateMessage()).toMatchObject({ unknown: true });   // nor read (EISDIR): unknown, not "none"
    setQuiet(true);
    const cid = `hub-${randomUUID()}`;
    d.pushChannelMessage("A Hub question", hub(cid));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events).toEqual([]);                               // no hub_question_input, no write
    expect(failures).toEqual([cid]);
  });

  it("the share's opt-out travels in the delivery meta to the daemon's hub_question_input", async () => {
    const { d, events, hub, setQuiet } = rig();
    setQuiet(true);
    const cid = `hub-${randomUUID()}`;
    d.pushChannelMessage("A Hub question", { ...hub(cid), hub_contact_limit: "off" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events).toEqual([`hub_question_input:${cid}:off`, "write:hub:idle"]);
  });

  it("a non-Claude backend (grok: no transcript evidence needed) reports working through the pane state, and its turn ends on idle", async () => {
    const { d, events, hub, setQuiet } = rig({ backend: "grok" });
    setQuiet(true);
    const cid = `hub-${randomUUID()}`;
    d.pushChannelMessage("A Hub question", hub(cid));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events).toEqual([`hub_question_input:${cid}`, "write:hub:idle"]);
    d.noteTurnEdge("working"); d.noteTurnEdge("idle");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.slice(2)).toEqual([`hub_question_turn_ended:${cid}`]);
  });

  it("an owner's turn that outlasts the 30-minute idle wait: the question is never written and its failure is reported (the asker gets a status line, the owner a Needs-you item)", async () => {
    const { d, events, hub, failures } = rig();
    const cid = `hub-${randomUUID()}`;
    d.pushChannelMessage("A Hub question", hub(cid));
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(events).toEqual([]);                               // no write, no window
    expect(failures).toEqual([cid]);                          // → the fleet's hubDeliveryFailed → held as uncertain
  });
});
