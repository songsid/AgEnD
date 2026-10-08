import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KiroSessionSource, type TranscriptEvents, type TranscriptSource } from "../src/transcript-sources.js";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import { KiroTranscriptLane, KIRO_TRANSCRIPT_BUDGET_MS, type KiroDbInput, type KiroDbReply, type KiroDbLane } from "../src/kiro-transcript-lane.js";

// A main-thread regression cannot quietly open a fixture (or the live store).
// Native worker tests use only explicit private fixtures; mocks are not sent to
// the isolate, whose entire entry imports only the reader and worker protocol.
const mainSqlite = vi.hoisted(() => vi.fn(function () { throw new Error("synchronous SQLite on main thread"); }));
vi.mock("better-sqlite3", () => ({ default: mainSqlite }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw new Error("no processes"); }, execSync: () => { throw new Error("no CLI"); }, execFileSync: () => { throw new Error("no CLI"); } }));
const empty = (): TranscriptEvents => ({ toolUses: [], toolResults: [], assistantTexts: [] });
const reply = (signature = "old", names: string[] = []): KiroDbReply => ({
  events: { ...empty(), toolUses: names.map(name => ({ name, input: {} })) },
  cursor: { conversationId: "c", historyCursor: 1, signature, toolNames: [] },
});
const input: KiroDbInput = { dbPath: "/private-fixture-only", workingDirectory: "/fixture", createdAt: 0, baseline: false };
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
const closers: Array<() => void> = [];
afterEach(() => { closers.splice(0).forEach(close => close()); vi.useRealTimers(); vi.restoreAllMocks(); });

class FakeWorker extends EventEmitter {
  sent: any[] = [];
  postMessage = vi.fn((message: unknown) => { this.sent.push(message); });
  terminate = vi.fn(() => new Promise<number>(() => {}));
  ref = vi.fn(); unref = vi.fn();
  ack(value = reply()) { const request = [...this.sent].reverse().find(message => "id" in message); this.emit("message", { id: request.id, reply: value }); }
}

describe("bounded physical transcript lane", () => {
  it("shares a warm isolate and coalesces one request per source", async () => {
    const worker = new FakeWorker(), factory = vi.fn(() => worker), lane = new KiroTranscriptLane(factory);
    const a = lane.acquire(), b = lane.acquire(); closers.push(() => { a.close(); b.close(); });
    const first = a.read(input), duplicate = a.read(input); expect(duplicate).toBe(first);
    const second = b.read(input); expect(factory).toHaveBeenCalledTimes(1); expect(worker.sent).toHaveLength(2);
    worker.emit("message", { id: worker.sent[0].id, reply: reply() }); worker.ack();
    expect(await first).not.toBeNull(); expect(await second).not.toBeNull();
    const again = a.read(input); worker.ack(); await again; expect(factory).toHaveBeenCalledTimes(1);
  });
  it("timeout resolves without freeing the physical reservation before exit; old exit preserves waiting work", async () => {
    vi.useFakeTimers(); let now = 0;
    const first = new FakeWorker(), second = new FakeWorker(), factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const lane = new KiroTranscriptLane(factory, () => now), lease = lane.acquire(); closers.push(() => lease.close());
    const reading = lease.read(input); now = KIRO_TRANSCRIPT_BUDGET_MS; await vi.advanceTimersByTimeAsync(KIRO_TRANSCRIPT_BUDGET_MS);
    expect(await reading).toBeNull(); expect(first.terminate).toHaveBeenCalledTimes(1);
    const retry = lease.read(input); await flush(); expect(factory).toHaveBeenCalledTimes(1);
    first.emit("exit", 0); await flush(); expect(factory).toHaveBeenCalledTimes(2);
    expect(second.sent).toHaveLength(1); second.ack(); expect(await retry).not.toBeNull();
  });
  it("a late ACK checks monotonic deadline even if its timer has not fired", async () => {
    vi.useFakeTimers(); let now = 0; const worker = new FakeWorker(), lane = new KiroTranscriptLane(() => worker, () => now);
    const lease = lane.acquire(); closers.push(() => lease.close()); const reading = lease.read(input);
    now = KIRO_TRANSCRIPT_BUDGET_MS; worker.ack(); expect(await reading).toBeNull(); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it("work that expired while awaiting old physical exit never starts another worker", async () => {
    vi.useFakeTimers(); let now = 0; const worker = new FakeWorker(), factory = vi.fn(() => worker), lane = new KiroTranscriptLane(factory, () => now);
    const lease = lane.acquire(); closers.push(() => lease.close()); const first = lease.read(input);
    now = KIRO_TRANSCRIPT_BUDGET_MS; worker.ack(); await first;
    const next = lease.read(input); now += KIRO_TRANSCRIPT_BUDGET_MS; worker.emit("exit", 0); await flush();
    expect(await next).toBeNull(); expect(factory).toHaveBeenCalledTimes(1);
  });
  it("a rejected terminate retains its physical slot while retries still have a deadline", async () => {
    vi.useFakeTimers(); let now = 0; const worker = new FakeWorker();
    worker.terminate.mockImplementation(() => Promise.reject(new Error("native exit pending")));
    const factory = vi.fn(() => worker), lane = new KiroTranscriptLane(factory, () => now), lease = lane.acquire();
    closers.push(() => lease.close());
    const first = lease.read(input); now = KIRO_TRANSCRIPT_BUDGET_MS; worker.ack(); expect(await first).toBeNull();
    const second = lease.read(input); now += KIRO_TRANSCRIPT_BUDGET_MS;
    await vi.advanceTimersByTimeAsync(KIRO_TRANSCRIPT_BUDGET_MS);
    expect(await second).toBeNull(); expect(factory).toHaveBeenCalledTimes(1); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it("last close cancels pending work and a late reply cannot restore it", async () => {
    const worker = new FakeWorker(), lane = new KiroTranscriptLane(() => worker), lease = lane.acquire();
    const result = lease.read(input); lease.close(); expect(await result).toBeNull(); worker.ack(); expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(await lease.read(input)).toBeNull();
  });
});

describe("source/monitor ownership, no synchronous SQLite", () => {
  function fakeLane() {
    const leases: Array<{ read: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
    const lane: KiroDbLane = { acquire: () => { const lease = { read: vi.fn(async (_input: KiroDbInput) => reply()), close: vi.fn() }; leases.push(lease); return lease; } };
    const source = new KiroSessionSource("/fixture", "/missing", 0, "/fixture/store", lane); closers.push(() => source.close());
    return { source, leases };
  }
  it("baseline and polls use the asynchronous lane; only cursors/events return to main", async () => {
    const { source, leases } = fakeLane(); await source.initialize(); await source.poll();
    expect(leases[0].read.mock.calls[0][0]).toMatchObject({ baseline: true, dbPath: "/fixture/store" });
    expect(leases[0].read.mock.calls[1][0]).toMatchObject({ baseline: false, cursor: reply().cursor });
    expect(mainSqlite).not.toHaveBeenCalled();
  });
  it.each(["close", "reset"] as const)("%s rejects stale poll and never commits its cursor", async action => {
    const { source, leases } = fakeLane(); await source.initialize();
    const pending = deferred<KiroDbReply>(); leases[0].read.mockReturnValueOnce(pending.promise);
    const polling = source.poll(); await flush(); source[action]();
    if (action === "reset") await source.initialize();
    pending.resolve(reply("stale", ["stale_tool"])); expect(await polling).toEqual(empty());
    expect((source as any).cursor?.signature).not.toBe("stale"); expect(leases[0].close).toHaveBeenCalledTimes(1);
  });
  it("initialization waits for the baseline and drops it after reset", async () => {
    const baseline = deferred<KiroDbReply>();
    const first = { read: vi.fn(() => baseline.promise), close: vi.fn() };
    const next = { read: vi.fn(async () => reply("new")), close: vi.fn() };
    const lane = { acquire: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(next) };
    const source = new KiroSessionSource("/fixture", "/missing", 0, "/fixture/store", lane);
    closers.push(() => source.close());
    const monitor = new TranscriptMonitor("/not-used", { debug: vi.fn() } as never, source);
    let ready = false; const initializing = monitor.initialize().then(() => { ready = true; });
    await flush(); expect(ready).toBe(false);
    source.reset(); await source.initialize();
    baseline.resolve(reply("obsolete")); await initializing;
    expect((source as any).cursor.signature).toBe("new");
    expect(first.close).toHaveBeenCalledTimes(1);
  });
  it("stopping from the first event does not emit the rest of a completed batch", async () => {
    const source: TranscriptSource = { poll: async () => reply("x", ["a", "b"]).events!, reset: vi.fn() };
    const monitor = new TranscriptMonitor("/not-used", { debug: vi.fn() } as never, source);
    const seen: string[] = []; monitor.on("tool_use", name => { seen.push(name); monitor.stop(); });
    await monitor.pollIncrement(); expect(seen).toEqual(["a"]);
  });
  it("wake after close carries the last accepted cursor instead of baselining away new work", async () => {
    const { source, leases } = fakeLane(); await source.initialize(); source.close(); await source.poll();
    expect(leases[1].read).toHaveBeenCalledTimes(1);
    expect(leases[1].read.mock.calls[0][0]).toMatchObject({ baseline: false, cursor: reply().cursor });
  });
  it.each(["stop", "resetOffset"] as const)("real monitor %s rejects a late result from the old generation", async action => {
    const result = deferred<TranscriptEvents>(); const source: TranscriptSource = { poll: () => result.promise, reset: vi.fn(), close: vi.fn() };
    const monitor = new TranscriptMonitor("/not-used", { debug: vi.fn() } as never, source); closers.push(() => monitor.stop());
    const seen = vi.fn(); monitor.on("tool_use", seen); const polling = monitor.pollIncrement(); monitor[action]();
    result.resolve(reply("stale", ["tool"]).events!); await polling; expect(seen).not.toHaveBeenCalled();
  });
});

describe("real compiled/TS worker, explicit private SQLite only", () => {
  it("baselines once, uses keyed history and sends each new event once; main timers keep running", async () => {
    const { default: Database } = await vi.importActual<{ default: typeof import("better-sqlite3") }>("better-sqlite3");
    const dir = mkdtempSync(join(tmpdir(), "agend-kiro-worker-")), path = join(dir, "store.sqlite3");
    const db = new Database(path); const lane = new KiroTranscriptLane();
    let source: KiroSessionSource | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      db.exec("CREATE TABLE conversations_v2 (key TEXT,conversation_id TEXT,value TEXT,created_at INTEGER,updated_at INTEGER,PRIMARY KEY(key,conversation_id))");
      const history = (name: string) => ({ assistant: { ToolUse: { tool_uses: [{ id: name, name, args: {} }] } } });
      db.prepare("INSERT INTO conversations_v2 VALUES(?,?,?,?,?)").run(dir, "same-id", JSON.stringify({ history: [history("old")] }), Date.now() - 1000, 1);
      db.prepare("INSERT INTO conversations_v2 VALUES(?,?,?,?,?)").run("/foreign", "same-id", JSON.stringify({ history: [history("foreign"), history("foreign2")] }), 0, 10000);
      source = new KiroSessionSource(dir, join(dir, "missing"), Date.now(), path, lane);
      let ticks = 0; timer = setInterval(() => { ticks++; }, 1);
      await source.initialize(); expect((await source.poll()).toolUses).toEqual([]);
      db.prepare("UPDATE conversations_v2 SET value=?,updated_at=2 WHERE key=?").run(JSON.stringify({ history: [history("old"), history("live")] }), dir);
      expect((await source.poll()).toolUses.map(x => x.name)).toEqual(["live"]);
      expect((await source.poll()).toolUses).toEqual([]); clearInterval(timer); expect(ticks).toBeGreaterThan(0);
    } finally { clearInterval(timer); source?.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
