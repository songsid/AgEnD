/**
 * M-2403: #3030's queued hand-off tracking for native (Windows) and remote panes. A message handed to a busy native CLI's
 * own queue is on record with its runtime transcript reference (no local file), watched through the runner's reader
 * (✅ when a turn takes it; "not taken" when the CLI stayed idle with the transcript read to its end), and after a
 * restart settled by positive proof only: taken → ✅; the same launch still current → watched again under this CLI;
 * its launch gone → unverifiable. A runtime record is never redelivered (the runner may still hold the CLI's queue).
 * A real Daemon with a fake native lifecycle (the 2950 fixture's shape); no CLI, no local transcript.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { Daemon } from "../src/daemon.js";
import { createNativePaneBackend } from "../src/backend/native-pane.js";
import { PANE_TRANSCRIPT_EMPTY_ANCHOR, type RuntimeTranscriptReference } from "../src/runtime-pane-transcript-protocol.js";
import { CONSUMED_WATCH, ConsumedWatch, consumedWatches, type ConsumedWatchTarget } from "../src/delivery-consumed-watch.js";
import { QueuedHandoffStore, type QueuedHandoff } from "../src/queued-handoffs.js";
import type { TranscriptLook } from "../src/transcript-delta-reader.js";

const roots: string[] = [];
afterEach(() => { consumedWatches.stopAll(); vi.useRealTimers(); vi.restoreAllMocks(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function ref(): RuntimeTranscriptReference {
  return { version: 1, machineId: randomUUID(), hostBootId: randomUUID(), paneId: randomUUID(), launchId: randomUUID(), agentId: randomUUID(), provider: "codex",
    cursor: { sessionId: randomUUID(), fileId: null, offset: 0, anchor: PANE_TRANSCRIPT_EMPTY_ANCHOR } };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agend-native-handoff-")); roots.push(dir);
  const r = ref();
  const backend = createNativePaneBackend("codex", () => ({ sessionId: r.cursor.sessionId, contextPercentage: null, statusLineItems: ["context-remaining"], resumes: false }));
  const daemon: any = new Daemon("native-agent", { working_directory: "C:\\native-cwd", backend: "codex", runtime: "windows", log_level: "silent" } as never, dir, true, backend, undefined, pino({ level: "silent" }) as never);
  let position = 0;
  const reader = { look: vi.fn(async (): Promise<TranscriptLook> => "no-match"), get readPosition() { return position; }, close: vi.fn() };
  const native = { mcpProof: vi.fn(() => "unknown"), backend, host: { executionHost: "remote" }, observation: {}, current: vi.fn(() => true), proofReader: vi.fn(() => reader) };
  daemon.setNativePaneLifecycle(native as never);
  const monitor = { reconciliationRuntimeCheckpoint: vi.fn(async () => r), reconciliationCheckpoint: vi.fn(async () => { throw Error("a native pane never reads a coordinator-local path"); }) };
  daemon.transcriptMonitor = monitor;
  const events: Array<[string, unknown]> = [];
  for (const e of ["message_confirmed", "message_failed", "human_handoffs_unsettled"]) daemon.on(e, (d: unknown) => events.push([e, d]));
  const store = new QueuedHandoffStore(dir);
  return { dir, daemon, ref: r, native, reader, monitor, events, store, move: (n: number) => { position += n; } };
}
const META = { chat_id: "chat", message_id: "m1", user: "han", user_id: "1" };
const wire = (id: string) => `[agend-delivery-id:${id}] hello`;
const entry = (r: RuntimeTranscriptReference, over: Partial<QueuedHandoff> = {}): QueuedHandoff => ({
  id: "h1", marker: "[agend-delivery-id:d1]", backend: "codex", runtime: r, content: "hello", wire: wire("d1"), meta: META,
  holder: "old-boot:1", createdAt: Date.now(), redeliveries: 0, ...over,
} as QueuedHandoff);

describe("M-2403: the record of a native pane's hand-off", () => {
  it("keeps the runtime reference (no path) and reads back; a record with both, or a bad reference, is dropped", () => {
    const f = fixture();
    f.store.put(entry(f.ref));
    expect(f.store.list().map((e) => [e.id, e.runtime?.paneId, e.path])).toEqual([["h1", f.ref.paneId, undefined]]);
    f.store.put({ ...entry(f.ref, { id: "both" }), path: "/x", offset: 0 } as never);
    f.store.put(entry({ ...f.ref, version: 9 } as never, { id: "bad" }));
    expect(new QueuedHandoffStore(f.dir).list().map((e) => e.id)).toEqual(["h1"]);
  });

  it("a hand-off into a busy native CLI is on record with its runtime checkpoint; the local checkpoint is never asked", async () => {
    const f = fixture();
    const verdict: any = { trackHandoff: { content: "hello", meta: META } };
    await f.daemon.recordQueuedHandoff(wire("d1"), true, verdict, { deliveryId: "d1" }, undefined);
    const [rec] = f.store.list();
    expect([rec?.runtime?.launchId, rec?.path, rec?.marker, verdict.handoff?.id === rec?.id]).toEqual([f.ref.launchId, undefined, "[agend-delivery-id:d1]", true]);
    expect(f.monitor.reconciliationCheckpoint).not.toHaveBeenCalled();
  });

  it("the attempt's own runtime checkpoint is used when the verdict has it", async () => {
    const f = fixture(), other = { ...f.ref, launchId: randomUUID() };
    const verdict: any = { trackHandoff: { content: "hello", meta: META }, transcriptCheckpoint: { backend: "codex", runtime: other } };
    await f.daemon.recordQueuedHandoff(wire("d1"), true, verdict, { deliveryId: "d1" }, undefined);
    expect(f.store.list()[0]?.runtime?.launchId).toBe(other.launchId);
    expect(f.monitor.reconciliationRuntimeCheckpoint).not.toHaveBeenCalled();
  });
});

describe("M-2403: watching it", () => {
  it("through the runner's reader with the record's marker and wire — never a local path", () => {
    const f = fixture(), starts: ConsumedWatchTarget[] = [];
    vi.spyOn(consumedWatches, "start").mockImplementation((t) => { starts.push(t); return true; });
    f.daemon.watchQueuedHandoff(entry(f.ref));
    expect(f.native.proofReader).toHaveBeenCalledExactlyOnceWith(f.ref, { marker: "[agend-delivery-id:d1]", wire: wire("d1") });
    expect([starts[0]?.reader, "path" in (starts[0] ?? {}), typeof starts[0]?.notTaken]).toEqual([f.reader, false, "function"]);
  });

  it("its pane's transcript not readable now: unverifiable at once (reported, record gone)", () => {
    const f = fixture(); f.native.current.mockReturnValue(false);
    const e = entry(f.ref); f.store.put(e);
    vi.spyOn(consumedWatches, "start").mockReturnValue(true);
    f.daemon.watchQueuedHandoff(e);
    expect(f.store.list().length).toBe(0);
    expect(vi.mocked(consumedWatches.start)).not.toHaveBeenCalled();
  });

  it("the reader watch ends 'not taken' after a complete read that moved nothing with the CLI idle; a read in flight never does", async () => {
    let idle = 0, position = 0;
    const look = vi.fn(async (): Promise<TranscriptLook> => "pending");
    const notTaken = vi.fn(), end = vi.fn();
    const target: ConsumedWatchTarget = { deliveryId: "handoff:h1", attemptNo: 0, backend: "codex", current: () => true, consumed: vi.fn(),
      reader: { look, get readPosition() { return position; } }, idleForMs: () => idle, notTaken };
    const watch = new ConsumedWatch(target, end);
    vi.useFakeTimers();
    idle = CONSUMED_WATCH.notTakenIdleMs + 1;
    await watch.look();                                   // "pending": an unfinished read proves nothing
    expect(notTaken).not.toHaveBeenCalled();
    look.mockImplementationOnce(async () => { position += 64; return "no-match"; });
    await watch.look();                                   // the read moved on: not the end yet
    expect(notTaken).not.toHaveBeenCalled();
    idle = 1_000; look.mockResolvedValueOnce("no-match");
    await watch.look();                                   // the end, but not idle long enough
    expect(notTaken).not.toHaveBeenCalled();
    idle = CONSUMED_WATCH.notTakenIdleMs + 1; look.mockResolvedValueOnce("no-match");
    await watch.look();
    expect([notTaken.mock.calls.length, end.mock.calls.at(-1)?.[0]]).toEqual([1, "not-taken"]);
    watch.stop();
  });
});

describe("M-2403: after the coordinator came back (another holder) — positive proof only, never redelivered", () => {
  const push = (f: ReturnType<typeof fixture>) => vi.spyOn(f.daemon, "pushChannelMessage").mockImplementation(() => {});

  it("taken in its transcript: ✅, record gone, nothing pasted", async () => {
    const f = fixture(), pasted = push(f); f.store.put(entry(f.ref));
    f.reader.look.mockResolvedValueOnce("user");
    await f.daemon.reconcileQueuedHandoffs();
    expect([f.store.list().length, f.events.map(([e]) => e), pasted.mock.calls.length]).toEqual([0, ["message_confirmed"], 0]);
  });

  it("the same launch still current, not taken yet: watched again under this CLI, nothing pasted", async () => {
    const f = fixture(), pasted = push(f), starts: ConsumedWatchTarget[] = [];
    vi.spyOn(consumedWatches, "start").mockImplementation((t) => { starts.push(t); return true; });
    f.store.put(entry(f.ref));
    await f.daemon.reconcileQueuedHandoffs();
    const [rec] = f.store.list();
    expect([rec?.holder === f.daemon.handoffHolder(), rec?.redeliveries, starts.length, pasted.mock.calls.length]).toEqual([true, 0, 1, 0]);
  });

  it("its launch gone (or its transcript unreadable): unverifiable, reported, never pasted", async () => {
    vi.useFakeTimers();
    for (const why of ["gone", "unreadable"] as const) {
      const f = fixture(), pasted = push(f); f.store.put(entry(f.ref));
      if (why === "gone") f.native.current.mockReturnValue(false); else f.reader.look.mockResolvedValueOnce("unavailable");
      await f.daemon.reconcileQueuedHandoffs();
      await vi.advanceTimersByTimeAsync(60_000);
      expect([why, f.store.list().length, pasted.mock.calls.length, f.events.find(([e]) => e === "human_handoffs_unsettled")?.[1]])
        .toEqual([why, 0, 0, { reason: "unverifiable", messages: [{ chatId: "chat", messageId: "m1" }] }]);
    }
  });

  it.each(["removed", "changed"] as const)("the record %s while a read is in flight (a cancel, another settle): skipped — nothing put back, reported or watched", async (how) => {
    vi.useFakeTimers();
    const f = fixture(), pasted = push(f), start = vi.spyOn(consumedWatches, "start").mockReturnValue(true);
    f.store.put(entry(f.ref));
    let release!: (v: TranscriptLook) => void;
    f.reader.look.mockImplementationOnce(() => new Promise<TranscriptLook>((done) => { release = done; }));
    const run = f.daemon.reconcileQueuedHandoffs();
    await vi.advanceTimersByTimeAsync(0);
    if (how === "removed") f.store.remove("h1"); else f.store.put(entry(f.ref, { holder: "someone-else:9" }));
    release("user");
    await run;
    await vi.advanceTimersByTimeAsync(60_000);
    expect([how, f.store.list().map((e) => e.holder), f.events.length, start.mock.calls.length, pasted.mock.calls.length])
      .toEqual([how, how === "removed" ? [] : ["someone-else:9"], 0, 0, 0]);
  });

  it("a backlog the first bounded read did not reach: the next read finds it taken (the loop reads on while it moves)", async () => {
    const f = fixture(), pasted = push(f); f.store.put(entry(f.ref));
    f.reader.look.mockImplementationOnce(async () => { f.move(4096); return "no-match"; }).mockResolvedValueOnce("user");
    await f.daemon.reconcileQueuedHandoffs();
    expect([f.reader.look.mock.calls.length, f.store.list().length, f.events.map(([e]) => e), pasted.mock.calls.length]).toEqual([2, 0, ["message_confirmed"], 0]);
  });

  it("a local record next to it still goes the #3030 way (its own file is read)", async () => {
    const f = fixture(), pasted = push(f);
    f.store.put({ ...entry(f.ref, { id: "local" }), runtime: undefined, path: join(f.dir, "missing.jsonl"), offset: 0 } as never);
    vi.useFakeTimers();
    await f.daemon.reconcileQueuedHandoffs();
    await vi.advanceTimersByTimeAsync(60_000);
    expect([f.store.list().length, pasted.mock.calls.length]).toEqual([0, 0]);
    expect(f.native.proofReader).not.toHaveBeenCalled();
  });
});
