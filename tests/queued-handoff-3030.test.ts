/**
 * #3030: a message handed to a busy CLI's own queue (Claude Code, Codex) is on record until a turn takes it. The CLI's
 * queue lives only in its process: a stop/restart before the turn ends dropped it, and AgEnD had already said ✅.
 *
 * - the record is written before the paste; ✅ waits for the transcript to show the message taken;
 * - an idle CLI that never took it: reported (❌ + one notice), never re-pasted live;
 * - after a restart, each record of a CLI that is gone is judged by its transcript: taken → ✅, nothing pasted; proven
 *   not taken → redelivered once (same marker); not judgeable → never pasted, reported.
 *
 * Real Daemon with a stub tmux serving Claude 2.1.293 captures and a stub transcript checkpoint; real transcript files
 * in a scratch dir. Nothing starts a CLI, a fleet or a tmux server.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { ConsumedWatch, consumedWatches, type ConsumedWatchTarget } from "../src/delivery-consumed-watch.js";
import { QUEUED_HANDOFFS_FILE, QUEUED_HANDOFFS_MAX, QueuedHandoffStore, type QueuedHandoff } from "../src/queued-handoffs.js";

const FIX = join(__dirname, "fixtures");
const pane = (name: string) => readFileSync(join(FIX, `claude-2.1.293-${name}.pane.txt`), "utf8");
const BUSY_EMPTY = pane("busy-empty");
const BUSY_PASTED = pane("long-busy-pasted");
const BUSY_QUEUED = pane("long-busy-queued");

const VID = "hmsg-0b5f2a6e-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
const MARKER = `[agend-human-id:${VID}]`;
const claudeUser = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
const claudeEnqueue = (text: string) => JSON.stringify({ type: "queue-operation", operation: "enqueue", content: text }) + "\n";
const codexUser = (text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }) + "\n";

const roots: string[] = [];
const scratch = (tag: string) => { const r = mkdtempSync(join(tmpdir(), `agend-3030-${tag}-`)); roots.push(r); return r; };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); consumedWatches.stopAll(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;

function entry(over: Partial<QueuedHandoff> = {}): QueuedHandoff {
  return { id: "h1", marker: MARKER, backend: "claude-code", path: "/nonexistent", offset: 0, content: "hello",
    meta: { user: "han", user_id: "1", chat_id: "chat", message_id: "m1", verification_id: VID }, holder: "gone:1",
    createdAt: 1, redeliveries: 0, ...over };
}

describe("the record store", () => {
  it("puts, replaces by id, removes; an unreadable file or a malformed entry reads as none", () => {
    const dir = scratch("store");
    const store = new QueuedHandoffStore(dir);
    expect(store.list()).toEqual([]);
    store.put(entry());
    store.put(entry({ offset: 7 }));
    expect(store.list()).toEqual([entry({ offset: 7 })]);
    expect(store.remove("h1")).toBe(true);
    expect(store.remove("h1")).toBe(false);
    writeFileSync(join(dir, QUEUED_HANDOFFS_FILE), "{ nope");
    expect(store.list()).toEqual([]);
    writeFileSync(join(dir, QUEUED_HANDOFFS_FILE), JSON.stringify([entry(), { id: "x" }]));
    expect(store.list()).toEqual([entry()]);
  });

  it("keeps at most QUEUED_HANDOFFS_MAX, dropping the oldest", () => {
    const store = new QueuedHandoffStore(scratch("cap"));
    let dropped: QueuedHandoff[] = [];
    for (let i = 0; i <= QUEUED_HANDOFFS_MAX; i++) dropped = store.put(entry({ id: `h${i}` }));
    expect(dropped.map(e => e.id)).toEqual(["h0"]);
    expect(store.list()).toHaveLength(QUEUED_HANDOFFS_MAX);
  });
});

describe("the consumed watch, for a marker and for a CLI that went idle without it", () => {
  function watch(path: string, over: Partial<ConsumedWatchTarget> = {}) {
    const consumed = vi.fn(), notTaken = vi.fn(), ended = vi.fn();
    const w = new ConsumedWatch({ deliveryId: "handoff:h1", attemptNo: 0, backend: "claude-code", path, offset: 0, marker: MARKER,
      current: () => true, consumed, notTaken, idleForMs: () => null, ...over }, ended);
    return { w, consumed, notTaken, ended };
  }

  it("a person's marker at the start of a Claude user entry, or a Codex user item: taken", async () => {
    const dir = scratch("watch");
    const path = join(dir, "t.jsonl");
    writeFileSync(path, claudeEnqueue(`${MARKER}\nhello`) + claudeUser(`${MARKER}\nhello`));
    const a = watch(path);
    await a.w.look();
    expect(a.consumed).toHaveBeenCalledWith("turn", "transcript-consumed:user-entry");
    expect(a.ended).toHaveBeenCalledWith("consumed");
    writeFileSync(path, codexUser(`${MARKER}\nhello`));
    const b = watch(path, { backend: "codex" });
    await b.w.look();
    expect(b.consumed).toHaveBeenCalledTimes(1);
  });

  it("only enqueued, the whole file read and the CLI idle long enough: not taken", async () => {
    const path = join(scratch("idle"), "t.jsonl");
    writeFileSync(path, claudeEnqueue(`${MARKER}\nhello`));
    const busy = watch(path);
    await busy.w.look();
    expect(busy.notTaken).not.toHaveBeenCalled();             // busy: the queue is waiting for the turn
    const shortIdle = watch(path, { idleForMs: () => 89_999 });
    await shortIdle.w.look();
    expect(shortIdle.notTaken).not.toHaveBeenCalled();
    const idle = watch(path, { idleForMs: () => 90_000 });
    await idle.w.look();
    expect(idle.notTaken).toHaveBeenCalledTimes(1);
    expect(idle.ended).toHaveBeenCalledWith("not-taken");
    expect(idle.consumed).not.toHaveBeenCalled();
  });

  it("an unfinished last line is not a verdict: idle or not, it waits for the line", async () => {
    const path = join(scratch("partial"), "t.jsonl");
    writeFileSync(path, claudeUser(`${MARKER}\nhello`).slice(0, 40));
    const w = watch(path, { idleForMs: () => 600_000 });
    await w.w.look();
    expect(w.notTaken).not.toHaveBeenCalled();
    expect(w.ended).not.toHaveBeenCalled();
    w.w.stop();
  });

  it("its own lifetime, when given", async () => {
    const path = join(scratch("life"), "t.jsonl");
    writeFileSync(path, "");
    const w = watch(path, { lifetimeMs: 0 });
    await w.w.look();
    expect(w.ended).toHaveBeenCalledWith("expired");
  });
});

interface Screen { pasted: boolean; enters: number }

function makeDaemon(root: string, screen: (s: Screen) => string, transcript: string | null) {
  const instanceDir = join(root, "instances", "worker");
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "window-id"), "@worker");
  const s: Screen = { pasted: false, enters: 0 };
  const control = {
    getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => false, hasOutputSince: () => true,
    waitUntilIdle: vi.fn(async () => true),
  };
  const backend = new ClaudeCodeBackend(instanceDir);
  const daemon: any = new Daemon("worker", {
    working_directory: root, log_level: "error", backend: "claude-code",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, instanceDir, false, backend as any, control as any, logger);
  const tmux = {
    capturePane: vi.fn(async () => screen(s)),
    capturePaneWithHistory: vi.fn(async () => screen(s)),
    pasteBuffer: vi.fn(async () => { s.pasted = true; return true; }),
    sendSpecialKey: vi.fn(async (key: string) => { if (key === "Enter") s.enters++; return true; }),
    getLastPasteError: vi.fn(), isLastPasteFailureRecoverable: vi.fn(() => true), getLastSendSpecialKeyError: vi.fn(),
    getWindowId: () => "@worker",
  };
  daemon.tmux = tmux;
  if (transcript !== null) daemon.transcriptMonitor = { reconciliationCheckpoint: async () => ({ path: transcript, offset: 0, sessionId: "s" }) };
  vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
  vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("busy");
  vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockResolvedValue(true);
  vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
  const events: Array<[string, unknown]> = [];
  for (const e of ["message_confirmed", "message_failed", "human_handoffs_unsettled"]) daemon.on(e, (d: unknown) => events.push([e, d]));
  return { daemon, tmux, s, instanceDir, events };
}

const personMeta = (over: Record<string, string> = {}) => ({
  user: "han", user_id: "1", chat_id: "chat", message_id: "m1", verification_id: VID, ts: new Date().toISOString(), ...over,
});
const busyScreen = (s: Screen) => (!s.pasted ? BUSY_EMPTY : s.enters === 0 ? BUSY_PASTED : BUSY_QUEUED);

async function handOff(meta: Record<string, string>, transcript: string | null = "/scratch/t.jsonl") {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const root = scratch("daemon");
  const h = makeDaemon(root, busyScreen, transcript);
  const watches: ConsumedWatchTarget[] = [];
  vi.spyOn(consumedWatches, "start").mockImplementation((t: ConsumedWatchTarget) => { watches.push(t); return true; });
  h.daemon.pushChannelMessage("hello", meta);
  for (let i = 0; i < 60 && !(h.tmux.pasteBuffer.mock.calls.length > 0 && watches.length + h.events.length > 0); i++) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  await vi.advanceTimersByTimeAsync(5_000);
  return { ...h, watches, store: new QueuedHandoffStore(h.instanceDir) };
}

describe("a person's message handed to a busy Claude", () => {
  it("is on record before ✅; ✅ comes when the transcript shows it taken, and the record goes", async () => {
    const r = await handOff(personMeta());
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.store.list()).toEqual([expect.objectContaining({ marker: MARKER, backend: "claude-code", path: "/scratch/t.jsonl",
      offset: 0, content: "hello", redeliveries: 0, meta: expect.objectContaining({ verification_id: VID, message_id: "m1" }) })]);
    expect(r.events.filter(([e]) => e === "message_confirmed")).toEqual([]);
    expect(r.watches).toHaveLength(1);
    expect(r.watches[0]).toMatchObject({ marker: MARKER, path: "/scratch/t.jsonl", offset: 0 });
    // The running turn's interrupted-turn marker is not overwritten by a message only queued (#1209).
    expect(existsSync(join(r.instanceDir, "in-flight-turn.json"))).toBe(false);
    r.watches[0].consumed("turn", "transcript-consumed:user-entry");
    expect(r.events).toEqual([["message_confirmed", { chatId: "chat", messageId: "m1" }]]);
    expect(r.store.list()).toEqual([]);
  });

  it("never taken by an idle CLI: ❌ and one notice (not-taken), the record goes, nothing pasted again", async () => {
    const r = await handOff(personMeta());
    r.watches[0].notTaken!();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(r.events).toEqual([["human_handoffs_unsettled", { reason: "not-taken", messages: [{ chatId: "chat", messageId: "m1" }] }]]);
    expect(r.store.list()).toEqual([]);
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
  });

  it("controls: no marker, or no transcript to judge it by — no record, ✅ at the hand-off as before", async () => {
    const { verification_id: _v, ...noMarker } = personMeta();
    const a = await handOff(noMarker);
    expect(a.store.list()).toEqual([]);
    expect(a.events.filter(([e]) => e === "message_confirmed")).toHaveLength(1);
    vi.restoreAllMocks(); vi.useRealTimers();
    const b = await handOff(personMeta(), null);
    expect(b.store.list()).toEqual([]);
    expect(b.events.filter(([e]) => e === "message_confirmed")).toHaveLength(1);
  });

  it("a cancel clears the records: nothing of it is redelivered or reported later", async () => {
    const r = await handOff(personMeta());
    expect(r.store.list()).toHaveLength(1);
    r.daemon.clearPendingDeliveries();
    expect(r.store.list()).toEqual([]);
  });
});

describe("after a restart: the records of a CLI that is gone", () => {
  function fresh(entries: QueuedHandoff[]) {
    const root = scratch("restart");
    const h = makeDaemon(root, () => BUSY_EMPTY, null);
    const store = new QueuedHandoffStore(h.instanceDir);
    for (const e of entries) store.put(e);
    const push = vi.spyOn(h.daemon, "pushChannelMessage").mockImplementation(() => {});
    const broadcast = vi.fn();
    h.daemon.ipcServer = { broadcast };
    return { ...h, store, push, broadcast, root };
  }

  it("taken in its transcript: ✅, the record goes, nothing pasted", async () => {
    const path = join(scratch("t"), "t.jsonl");
    writeFileSync(path, claudeEnqueue(`${MARKER}\nhello`) + claudeUser(`${MARKER}\nhello`));
    const r = fresh([entry({ path })]);
    await r.daemon.reconcileQueuedHandoffs();
    expect(r.push).not.toHaveBeenCalled();
    expect(r.events).toEqual([["message_confirmed", { chatId: "chat", messageId: "m1" }]]);
    expect(r.store.list()).toEqual([]);
  });

  it("proven not taken (the whole delta read; only enqueued, or absent): redelivered once with its marker, receipt binding stripped", async () => {
    const path = join(scratch("t"), "t.jsonl");
    writeFileSync(path, claudeUser("[agend-human-id:hmsg-other]\nearlier") + claudeEnqueue(`${MARKER}\nhello`));
    const meta = { ...entry().meta, human_receipt_id: "r", human_owner_key: "k", human_daemon_owner: "o", human_wire_sha256: "w" };
    const r = fresh([entry({ path, meta })]);
    await r.daemon.reconcileQueuedHandoffs();
    expect(r.push).toHaveBeenCalledTimes(1);
    const [content, pushed] = r.push.mock.calls[0] as [string, Record<string, string>];
    expect(content).toBe("hello");
    expect(pushed).toEqual({ ...entry().meta, handoff_redelivery: "h1", handoff_redeliveries: "1", handoff_holder: r.daemon.handoffHolder() });
    expect(r.store.list()).toEqual([expect.objectContaining({ id: "h1", holder: r.daemon.handoffHolder(), redeliveries: 1 })]);
    expect(r.events).toEqual([]);
  });

  it("not judgeable (no transcript), or redelivered too often: never pasted, ❌ + one notice (unverifiable)", async () => {
    const path = join(scratch("t"), "t.jsonl");
    writeFileSync(path, claudeEnqueue(`${MARKER}\nhello`));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r = fresh([entry({ id: "gone" }), entry({ id: "tired", path, meta: { ...entry().meta, message_id: "m2" }, redeliveries: 3 })]);
    await r.daemon.reconcileQueuedHandoffs();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(r.push).not.toHaveBeenCalled();
    expect(r.events).toEqual([["human_handoffs_unsettled", { reason: "unverifiable",
      messages: [{ chatId: "chat", messageId: "m1" }, { chatId: "chat", messageId: "m2" }] }]]);
    expect(r.store.list()).toEqual([]);
  });

  it("an agent's message not judgeable: its sender gets the delivery failure (handoff-not-consumed), no person's notice", async () => {
    const r = fresh([entry({ marker: "[agend-delivery-id:d1]", meta: { from_instance: "lead", correlation_id: "c1", user: "instance:lead", chat_id: "", message_id: "x1" } })]);
    await r.daemon.reconcileQueuedHandoffs();
    expect(r.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "cross_instance_delivery_failed", senderSession: "lead",
      correlationId: "c1", error: "delivery failed: phase=handoff-not-consumed; proof=unverifiable" }));
    expect(r.push).not.toHaveBeenCalled();
  });

  it("a CLI replaced while its reconciliation reads a transcript: the next CLI's reconciliation alone redelivers — one push", async () => {
    const path = join(scratch("t"), "t.jsonl");
    writeFileSync(path, claudeEnqueue(`${MARKER}\nhello`));
    const r = fresh([entry({ path })]);
    const first = r.daemon.reconcileQueuedHandoffs();      // its scan is pending
    r.daemon.spawnGeneration++;                             // the CLI crashed and was respawned meanwhile
    const second = r.daemon.reconcileQueuedHandoffs();
    await Promise.all([first, second]);
    expect(r.push).toHaveBeenCalledTimes(1);
    expect((r.push.mock.calls[0] as [string, Record<string, string>])[1].handoff_holder).toBe(r.daemon.handoffHolder());
    expect(r.store.list()).toEqual([expect.objectContaining({ holder: r.daemon.handoffHolder(), redeliveries: 1 })]);
  });

  it("a cancel while its transcript is read: nothing redelivered, no record left for a later restart", async () => {
    const path = join(scratch("t"), "t.jsonl");
    writeFileSync(path, claudeEnqueue(`${MARKER}\nhello`));
    const r = fresh([entry({ path })]);
    const pending = r.daemon.reconcileQueuedHandoffs();
    r.daemon.clearPendingDeliveries();
    await pending;
    expect(r.push).not.toHaveBeenCalled();
    expect(r.store.list()).toEqual([]);
  });

  it("the current CLI's own records are not judged (it still holds them)", async () => {
    const r = fresh([]);
    r.store.put(entry({ holder: r.daemon.handoffHolder() }));
    await r.daemon.reconcileQueuedHandoffs();
    expect(r.push).not.toHaveBeenCalled();
    expect(r.store.list()).toHaveLength(1);
  });
});

describe("the idle clock the not-taken end reads", () => {
  it("starts at the first idle snapshot and keeps running through repeated ones; any other state stops it", () => {
    const h = makeDaemon(scratch("idleclock"), () => BUSY_EMPTY, null);
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const snap = (state: string) => ({ state, unchangedForMs: 0, observedAt: Date.now(), stateChangedAt: Date.now() });
    h.daemon.applyInstanceStateSnapshot(snap("working"));
    expect(h.daemon.instanceIdleSinceMono).toBeNull();
    h.daemon.applyInstanceStateSnapshot(snap("idle"));
    expect(h.daemon.instanceIdleSinceMono).toBe(1_000);
    for (now = 2_000; now <= 200_000; now += 50_000) h.daemon.applyInstanceStateSnapshot(snap("idle"));
    expect(h.daemon.instanceIdleSinceMono).toBe(1_000);   // still the stretch's start: 90 s can be reached
    h.daemon.applyInstanceStateSnapshot(snap("working"));
    expect(h.daemon.instanceIdleSinceMono).toBeNull();
  });
});

describe("a redelivery is written only by the CLI it was issued for", () => {
  it("one queued for a CLI that was replaced meanwhile is dropped before any write; its record stays for the next judgement", async () => {
    const root = scratch("stale");
    const h = makeDaemon(root, () => BUSY_EMPTY, null);
    const store = new QueuedHandoffStore(h.instanceDir);
    store.put(entry({ holder: "replaced:9" }));
    const deliver = vi.spyOn(h.daemon, "deliverMessage");
    h.daemon.pushChannelMessage("hello", { ...entry().meta, handoff_redelivery: "h1", handoff_redeliveries: "1", handoff_holder: "replaced:9" });
    await h.daemon.pasteLock;
    expect(deliver).not.toHaveBeenCalled();
    expect(store.list()).toEqual([entry({ holder: "replaced:9" })]);
    expect(h.daemon.redeliveryStillOurs({ handoff_redelivery: "h1", handoff_holder: h.daemon.handoffHolder() })).toBe(false);
    store.put(entry({ holder: h.daemon.handoffHolder() }));
    expect(h.daemon.redeliveryStillOurs({ handoff_redelivery: "h1", handoff_holder: h.daemon.handoffHolder() })).toBe(true);
    // The record was re-issued to this CLI, but this push was queued for the replaced one: still dropped (one paste).
    expect(h.daemon.redeliveryStillOurs({ handoff_redelivery: "h1", handoff_holder: "replaced:9" })).toBe(false);
  });

  it("after its write: an ordinary submission settles it; a stop before the write keeps it; a cancel drops it", () => {
    const h = makeDaemon(scratch("after"), () => BUSY_EMPTY, null);
    const store = new QueuedHandoffStore(h.instanceDir);
    const meta = { ...entry().meta, handoff_redelivery: "h1" };
    store.put(entry());
    h.daemon.afterTrackedWrite(meta, { reached: true }, true, h.daemon.deliveryEpoch);
    expect(store.list()).toEqual([]);
    store.put(entry());
    const epoch = h.daemon.deliveryEpoch;
    h.daemon.fenceDeliveryWritesForStop();
    h.daemon.afterTrackedWrite(meta, { reached: false }, false, epoch);
    expect(store.list()).toHaveLength(1);
    h.daemon.deliveryWritesStopping = false;
    h.daemon.afterTrackedWrite(meta, { reached: false }, false, epoch);
    expect(store.list()).toEqual([]);
  });
});
