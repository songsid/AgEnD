import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { IdleUpdateQueue, IDLE_UPDATE_MIGRATION, IDLE_UPDATE_WAIT_MS, type IdleUpdateLaunch, type IdleUpdate } from "../src/update-idle.js";
const dbs: Database.Database[] = [], queues: IdleUpdateQueue[] = [];
afterEach(() => { for (const q of queues.splice(0)) q.close(); for (const db of dbs.splice(0)) db.close(); vi.useRealTimers(); });
function world() {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  const db = new Database(":memory:"); dbs.push(db); IDLE_UPDATE_MIGRATION.up(db);
  let idle = false, allowed = true, current = true;
  const spawn = vi.fn(), changed = vi.fn();
  const launch = vi.fn(async (_r: IdleUpdate, control: IdleUpdateLaunch) => { if (!control.claim()) return false; spawn(); return true; });
  const host = { db, now: Date.now, current: () => current, allowed: () => allowed, idle: () => idle, launch, changed };
  const queue = new IdleUpdateQueue(host); queues.push(queue);
  const request = { id: randomUUID(), version: "2.4.0-beta.5" };
  return { queue, host, request, spawn, launch, changed, idle: (v = true) => { idle = v; }, allowed: (v: boolean) => { allowed = v; }, fence: () => { current = false; } };
}
it("waits while busy, claims one durable launch once idle, and never replays after restart", async () => {
  const w = world(); expect(w.queue.request(w.request).state).toBe("waiting"); await w.queue.pump(); expect(w.spawn).not.toHaveBeenCalled();
  w.idle(); await w.queue.pump(); expect(w.spawn).toHaveBeenCalledTimes(1); expect(w.queue.get(w.request.id)?.state).toBe("updating");
  await w.queue.pump(); expect(w.spawn).toHaveBeenCalledTimes(1);
  w.queue.close(); const reopened = new IdleUpdateQueue(w.host); queues.push(reopened); await reopened.start(); expect(w.spawn).toHaveBeenCalledTimes(1);
  expect(reopened.settle(w.request.id, "done")).toBe(true); expect(reopened.get(w.request.id)?.state).toBe("done");
});
it("expires exactly at 24 hours without a launch, even if no idle event arrives", async () => {
  const w = world(); w.queue.request(w.request);
  await vi.advanceTimersByTimeAsync(IDLE_UPDATE_WAIT_MS - 1); expect(w.queue.get(w.request.id)?.state).toBe("waiting");
  await vi.advanceTimersByTimeAsync(1); expect(w.queue.get(w.request.id)?.state).toBe("expired"); expect(w.spawn).not.toHaveBeenCalled();
});
it("cancel during preparation invalidates the final launch claim", async () => {
  const w = world(); let release!: () => void;
  w.launch.mockImplementation(async (_r: IdleUpdate, control) => { await new Promise<void>(r => { release = r; }); if (!control.claim()) return false; w.spawn(); return true; });
  w.idle(); w.queue.request(w.request); const pumping = w.queue.pump(); await Promise.resolve(); await Promise.resolve();
  expect(w.launch).toHaveBeenCalledTimes(1); expect(w.queue.cancel(w.request.id)).toBe(true); release(); await pumping;
  expect(w.spawn).not.toHaveBeenCalled(); expect(w.queue.get(w.request.id)).toMatchObject({ state: "cancelled", reason: "owner" });
});

it.each(["approval", "delivery"])("new %s activity while preparing returns to waiting without consuming another 24h", async () => {
  const w = world(); let release!: () => void;
  w.launch.mockImplementationOnce(async (_r: IdleUpdate, c) => { await new Promise<void>(r => { release = r; }); if (!c.claim()) return false; w.spawn(); return true; });
  w.idle(); const admitted = w.queue.request(w.request), pumping = w.queue.pump(); await Promise.resolve(); await Promise.resolve();
  w.idle(false); release(); await pumping; expect(w.spawn).not.toHaveBeenCalled();
  expect(w.queue.get(w.request.id)).toMatchObject({ state: "waiting", expiresAt: admitted.expiresAt });
  w.idle(); await w.queue.pump(); expect(w.spawn).toHaveBeenCalledTimes(1);
});
it("revoking permission or the selected host while preparation awaits prevents the launch", async () => {
  const w = world(); let release!: () => void;
  w.launch.mockImplementation(async (_r: IdleUpdate, c) => { await new Promise<void>(r => { release = r; }); if (!c.claim()) return false; w.spawn(); return true; });
  w.idle(); w.queue.request(w.request); const pumping = w.queue.pump(); await Promise.resolve(); await Promise.resolve();
  w.allowed(false); release(); await pumping;
  expect(w.spawn).not.toHaveBeenCalled(); expect(w.queue.get(w.request.id)).toMatchObject({ state: "cancelled", reason: "permission-revoked" });
});
it("expires preparation at the deadline even while the launcher is awaiting", async () => {
  const w = world(); let release!: () => void;
  w.launch.mockImplementation(async (_r: IdleUpdate, c) => { await new Promise<void>(r => { release = r; }); if (!c.claim()) return false; w.spawn(); return true; });
  w.idle(); w.queue.request(w.request); const pumping = w.queue.pump(); await Promise.resolve(); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(IDLE_UPDATE_WAIT_MS); expect(w.queue.get(w.request.id)?.state).toBe("expired");
  release(); await pumping; expect(w.spawn).not.toHaveBeenCalled();
});
it("deduplicates the exact request, refuses changes/concurrent requests, and cannot cancel a claimed update", async () => {
  const w = world(); const saved = w.queue.request(w.request); expect(w.queue.request(w.request)).toEqual(saved); expect(w.changed).toHaveBeenCalledTimes(1);
  expect(() => w.queue.request({ ...w.request, version: "9.0.0" })).toThrow("conflict");
  expect(() => w.queue.request({ ...w.request, id: randomUUID() })).toThrow("busy");
  w.idle(); await Promise.all([w.queue.pump(), w.queue.pump(), w.queue.pump()]);
  expect(w.spawn).toHaveBeenCalledTimes(1); expect(w.queue.cancel(w.request.id)).toBe(false);
  expect(w.queue.settle(w.request.id, "rolled-back")).toBe(true); expect(w.queue.settle(w.request.id, "done")).toBe(false);
  expect(w.queue.request(w.request).state).toBe("rolled-back");
});
it("keeps a request waiting across restart, and never launches through a retired host", async () => {
  const w = world(); w.queue.request(w.request); w.queue.close();
  const next = new IdleUpdateQueue(w.host); queues.push(next); await next.start(); expect(next.pending()?.state).toBe("waiting");
  w.idle(); w.fence(); await next.pump(); expect(w.spawn).not.toHaveBeenCalled(); expect(next.pending()?.state).toBe("waiting");
});
it("reports a refused/failed launch without retry, and never treats a launcher that forgot claim as success", async () => {
  const w = world(); w.launch.mockResolvedValue(true); w.idle(); w.queue.request(w.request); await w.queue.pump();
  expect(w.queue.get(w.request.id)).toMatchObject({ state: "failed", reason: "launch-failed" }); expect(w.spawn).not.toHaveBeenCalled();
  await w.queue.pump(); expect(w.launch).toHaveBeenCalledTimes(1);
});

it("does not spawn if the durable launch claim cannot be saved", async () => {
  const w = world(); w.host.db.exec("CREATE TRIGGER refuse_claim BEFORE UPDATE ON fleet_idle_updates WHEN NEW.state='updating' BEGIN SELECT RAISE(ABORT,'disk failure'); END");
  w.idle(); w.queue.request(w.request); await w.queue.pump();
  expect(w.spawn).not.toHaveBeenCalled(); expect(w.queue.get(w.request.id)).toMatchObject({ state: "failed", reason: "launch-failed" });
});
it("resumes an unclaimed preparation after restart while the retired preparation cannot claim it", async () => {
  const w = world(); let release!: () => void;
  w.launch.mockImplementationOnce(async (_r: IdleUpdate, c) => { await new Promise<void>(r => { release = r; }); if (!c.claim()) return false; w.spawn(); return true; });
  w.idle(); const first = w.queue.request(w.request), pumping = w.queue.pump(); await Promise.resolve(); await Promise.resolve();
  expect(w.queue.get(w.request.id)?.state).toBe("starting"); w.queue.close(); w.idle(false);
  const next = new IdleUpdateQueue(w.host); queues.push(next); await next.start();
  expect(next.pending()).toMatchObject({ state: "waiting", expiresAt: first.expiresAt });
  release(); await pumping; expect(w.spawn).not.toHaveBeenCalled(); w.idle(); await next.pump(); expect(w.spawn).toHaveBeenCalledTimes(1);
});
it("an unreadable idle observation cannot admit an update", async () => {
  const w = world(); w.host.idle = () => { throw Error("unknown activity"); };
  w.queue.request(w.request); await w.queue.pump(); expect(w.queue.pending()?.state).toBe("waiting"); expect(w.spawn).not.toHaveBeenCalled();
});

it("a launch control can claim only once, even inside the same preparation", async () => {
  const w = world(); w.launch.mockImplementationOnce(async (_r: IdleUpdate, c) => {
    expect(c.claim()).toBe(true); expect(c.current()).toBe(true); expect(c.claim()).toBe(false); w.spawn(); return true;
  });
  w.idle(); w.queue.request(w.request); await w.queue.pump(); expect(w.spawn).toHaveBeenCalledTimes(1);
});
