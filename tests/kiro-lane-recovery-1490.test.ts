import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KiroTranscriptLane, KIRO_TRANSCRIPT_BUDGET_MS, type KiroDbInput, type KiroDbReply, type KiroWorkerRequest } from "../src/kiro-transcript-lane.js";
import { KiroSessionSource } from "../src/transcript-sources.js";

const forbidden = vi.hoisted(() => vi.fn(() => { throw new Error("unexpected native boundary"); }));
vi.mock("node:worker_threads", () => ({ Worker: forbidden }));
vi.mock("better-sqlite3", () => ({ default: forbidden }));
vi.mock("node:child_process", () => ({ exec: forbidden, execFile: forbidden, execSync: forbidden, execFileSync: forbidden, spawn: forbidden, spawnSync: forbidden, fork: forbidden }));

class HeldWorker extends EventEmitter {
  sent: KiroWorkerRequest[] = [];
  postMessage = vi.fn((message: KiroWorkerRequest | { close: number }) => { if ("id" in message) this.sent.push(message); });
  // A native call holds exit AND the termination promise indefinitely.
  terminate = vi.fn(() => new Promise<number>(() => {}));
  ref = vi.fn();
  unref = vi.fn();
  ack(request = this.sent.at(-1)!, signature = "new", name = "read_tool"): void {
    this.emit("message", { id: request.id, reply: result(signature, name) });
  }
}
const input: KiroDbInput = { dbPath: "/private-fixture/not-opened", workingDirectory: "/private-fixture", createdAt: 0, baseline: false };
function result(signature = "new", name = "read_tool"): KiroDbReply {
  return { cursor: { conversationId: "fixture", historyCursor: 1, signature, toolNames: [] },
    events: { toolUses: name ? [{ name, input: {} }] : [], toolResults: [], assistantTexts: [] } };
}
const cleanup: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup.splice(0).reverse().forEach(close => close()); vi.useRealTimers(); expect(forbidden).not.toHaveBeenCalled(); });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
  let now = 0;
  const workers: HeldWorker[] = [];
  const factory = vi.fn(() => { const worker = new HeldWorker(); workers.push(worker); return worker; });
  const lane = new KiroTranscriptLane(factory, () => now);
  const lease = lane.acquire(); cleanup.push(() => lease.close());
  const expire = async () => { now += KIRO_TRANSCRIPT_BUDGET_MS; await vi.advanceTimersByTimeAsync(KIRO_TRANSCRIPT_BUDGET_MS); };
  return { lane, lease, workers, factory, expire, setNow: (value: number) => { now = value; } };
}

describe("abandoned Kiro native worker recovery", () => {
  it("reads on a replacement while the old terminate/exit are still pending", async () => {
    const h = fixture(); const first = h.lease.read(input); await h.expire();
    expect(await first).toBeNull(); expect(h.workers[0].terminate).toHaveBeenCalledTimes(1);
    const second = h.lease.read(input); await flush();
    expect(h.factory).toHaveBeenCalledTimes(2);
    h.workers[1].ack(); expect(await second).toEqual(result());
    expect(h.workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it("the real source resumes from its accepted cursor without reset or lost events", async () => {
    const h = fixture();
    const root = mkdtempSync(join(tmpdir(), "agend-kiro-lane-recovery-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const source = new KiroSessionSource(root, join(root, "missing-sessions"), 0, join(root, "not-opened.sqlite3"), h.lane);
    cleanup.push(() => source.close());
    h.workers[0].ack(undefined, "baseline", ""); await source.initialize();
    const old = source.poll(); await flush(); await h.expire(); expect((await old).toolUses).toEqual([]);
    const fresh = source.poll(); await flush(); expect(h.factory).toHaveBeenCalledTimes(2);
    expect(h.workers[1].sent[0].input.cursor?.signature).toBe("baseline");
    h.workers[0].ack(undefined, "stale", "stale_tool");
    h.workers[1].ack(undefined, "fresh", "fresh_tool");
    expect((await fresh).toolUses.map(tool => tool.name)).toEqual(["fresh_tool"]);
    const next = source.poll(); await flush();
    expect(h.workers[1].sent.at(-1)?.input.cursor?.signature).toBe("fresh");
    h.workers[1].ack(undefined, "fresh", ""); expect((await next).toolUses).toEqual([]);
  });

  it.each(["reject", "throw", "resolved"])("%s termination without exit does not prevent the spare read or release a physical slot", async mode => {
    const h = fixture(); const old = h.lease.read(input); const first = h.workers[0];
    if (mode === "reject") first.terminate.mockImplementation(() => Promise.reject(new Error("native held")));
    if (mode === "throw") first.terminate.mockImplementation(() => { throw new Error("native held"); });
    if (mode === "resolved") first.terminate.mockImplementation(() => Promise.resolve(0));
    await h.expire(); expect(await old).toBeNull();
    const fresh = h.lease.read(input); expect(h.factory).toHaveBeenCalledTimes(2);
    h.workers[1].ack(); expect(await fresh).toEqual(result());
    const stuck = h.lease.read(input); await h.expire(); expect(await stuck).toBeNull();
    const queued = h.lease.read(input); expect(h.factory).toHaveBeenCalledTimes(2);
    await h.expire(); expect(await queued).toBeNull(); expect(h.factory).toHaveBeenCalledTimes(2);
  });

  it("late ACK/error/duplicate exit from the old worker cannot settle or retire the new worker", async () => {
    const h = fixture(); const first = h.lease.read(input); await h.expire(); await first;
    const fresh = h.lease.read(input); const old = h.workers[0], current = h.workers[1];
    let settled = false; void fresh.then(() => { settled = true; });
    old.ack(current.sent[0], "forged-old", "old_tool"); old.emit("error", new Error("late old error"));
    old.emit("exit", 0); old.emit("exit", 0); await flush();
    expect(settled).toBe(false); expect(h.factory).toHaveBeenCalledTimes(2);
    expect(current.terminate).not.toHaveBeenCalled(); expect(current.unref).toHaveBeenCalledTimes(1); // initial idle unref only
    current.ack(); await flush(); expect(settled).toBe(true); expect(await fresh).toEqual(result());
    const again = h.lease.read(input); current.ack(); await again; expect(h.factory).toHaveBeenCalledTimes(2);
  });

  it("two live native owners cap replacements; an exact old exit wakes the queued read once", async () => {
    const h = fixture(); const first = h.lease.read(input); await h.expire(); await first;
    const second = h.lease.read(input); await h.expire(); await second;
    const third = h.lease.read(input); const duplicate = h.lease.read(input); expect(duplicate).toBe(third);
    expect(h.factory).toHaveBeenCalledTimes(2);
    h.workers[0].emit("exit", 0); expect(h.factory).toHaveBeenCalledTimes(3);
    expect(h.workers[2].sent).toHaveLength(1);
    h.workers[0].emit("exit", 0); h.workers[1].emit("error", new Error("held old native"));
    expect(h.factory).toHaveBeenCalledTimes(3); expect(h.workers[2].terminate).not.toHaveBeenCalled();
    h.workers[2].ack(); expect(await third).toEqual(result());
    h.workers[1].emit("exit", 0); expect(h.factory).toHaveBeenCalledTimes(3);
  });

  it("capacity-waiting expiry does not refresh its deadline or create physical work after late exit", async () => {
    const h = fixture(); const first = h.lease.read(input); await h.expire(); await first;
    const second = h.lease.read(input); await h.expire(); await second;
    const queued = h.lease.read(input); h.setNow(3 * KIRO_TRANSCRIPT_BUDGET_MS);
    // Monotonic time moved but the timer callback has not run.
    h.workers[0].emit("exit", 0); expect(await queued).toBeNull(); expect(h.factory).toHaveBeenCalledTimes(2);
    const fresh = h.lease.read(input); expect(h.factory).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1); expect(h.workers[2].terminate).not.toHaveBeenCalled();
    h.workers[2].ack(); expect(await fresh).toEqual(result());
  });

  it("close/reacquire retains physical bounds; closing a queued owner prevents later dispatch", async () => {
    const h = fixture(); const first = h.lease.read(input); await h.expire(); await first; h.lease.close();
    const b = h.lane.acquire(); const second = b.read(input); b.close(); expect(await second).toBeNull();
    const c = h.lane.acquire(); const queued = c.read(input); c.close(); expect(await queued).toBeNull();
    expect(h.factory).toHaveBeenCalledTimes(2);
    h.workers[0].emit("exit", 0); h.workers[1].emit("exit", 0); expect(h.factory).toHaveBeenCalledTimes(2);
    const d = h.lane.acquire(); cleanup.push(() => d.close()); const fresh = d.read(input);
    expect(h.factory).toHaveBeenCalledTimes(3); h.workers[2].ack(); expect(await fresh).toEqual(result());
    expect(await c.read(input)).toBeNull();
  });

  it("a failed active request settles all its worker's callers, preserving per-source coalescing on replacement", async () => {
    const h = fixture(); const b = h.lane.acquire(); cleanup.push(() => b.close());
    const first = h.lease.read(input), sibling = b.read(input); await h.expire();
    expect(await first).toBeNull(); expect(await sibling).toBeNull(); expect(h.workers[0].terminate).toHaveBeenCalledTimes(1);
    const fresh = b.read(input), joined = b.read(input); expect(joined).toBe(fresh);
    expect(h.workers[1].sent).toHaveLength(1); h.workers[1].ack(); expect(await fresh).toEqual(result());
  });

  it("worker creation failure does not invent a physical owner or suppress the next attempt", async () => {
    const h = fixture(); const first = h.lease.read(input); await h.expire(); await first;
    h.factory.mockImplementationOnce(() => { throw new Error("no worker created"); });
    expect(await h.lease.read(input)).toBeNull();
    const fresh = h.lease.read(input); expect(h.workers).toHaveLength(2); h.workers[1].ack(); expect(await fresh).toEqual(result());
  });

  it("unrefs after the native termination API re-refs the held worker", async () => {
    const h = fixture(); const reading = h.lease.read(input); const worker = h.workers[0];
    const events: string[] = [];
    worker.ref.mockImplementation(() => { events.push("ref"); });
    worker.unref.mockImplementation(() => { events.push("unref"); });
    worker.terminate.mockImplementation(() => { worker.ref(); return new Promise<number>(() => {}); });
    await h.expire(); expect(await reading).toBeNull();
    expect(events.slice(-2)).toEqual(["ref", "unref"]);
    const fresh = h.lease.read(input); expect(h.factory).toHaveBeenCalledTimes(2);
    h.workers[1].ack(); expect(await fresh).toEqual(result());
  });

  it("checks the fresh read deadline after worker setup and rejects late receipts even before a timer runs", async () => {
    const h = fixture(); h.factory.mockImplementationOnce(() => {
      const worker = new HeldWorker(); h.workers.push(worker); h.setNow(KIRO_TRANSCRIPT_BUDGET_MS); return worker;
    });
    let settled = false;
    const expired = h.lease.read(input); void expired.then(() => { settled = true; });
    await flush(); expect(settled).toBe(true); expect(await expired).toBeNull(); expect(h.workers[0].sent).toHaveLength(0);
    const next = h.lease.read(input); expect(h.workers[0].sent).toHaveLength(1);
    h.setNow(2 * KIRO_TRANSCRIPT_BUDGET_MS); h.workers[0].ack(); expect(await next).toBeNull();
    const fresh = h.lease.read(input); expect(h.factory).toHaveBeenCalledTimes(2);
    h.workers[1].ack(); expect(await fresh).toEqual(result());
  });
});
