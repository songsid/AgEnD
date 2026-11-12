/**
 * #3720 (user: 「ClassicBot 派工作也是 agent 派的」): a card handed out by a ClassicBot room's agent is told to that room
 * like any instance's — one `[Task board]` notice when its assignee stops, one "working again" line when it recovers.
 * A person dispatcher, and a room that is gone, still go to Needs you; a room that is not running gets the notice queued
 * and Needs you as well (as an instance dispatcher does). The real FleetManager wiring (tickDispatcherLiveness), a real
 * scheduler and ledger; the delivery outbox recorded.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVENESS_STARTUP_GRACE_MS } from "../src/dispatcher-liveness.js";

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }),
  rotateLogIfNeeded: () => {}, rotateLogIfNeededAsync: async () => {},
}));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ROOM = "classic-宋承翰的ai-4716";
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

async function fleet(dispatcher: { kind: "person" | "instance"; name: string }, opts: { roomListed?: boolean; roomRunning?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), "liveness-room-")); dirs.push(d);
  writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances:\n  dev-a:\n    working_directory: /tmp\n");
  const { FleetManager } = await import("../src/fleet-manager.js");
  const fm = new FleetManager(d) as unknown as Record<string, any>;
  fm.loadConfig(join(d, "fleet.yaml"));
  const { Scheduler } = await import("../src/scheduler/index.js");
  const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
  fm.scheduler = scheduler;
  // The ClassicBot room the card came from (classicBot.yaml's rooms, as the fleet reads them).
  fm.classicChannels = { getAll: () => (opts.roomListed === false ? [] : [{ instanceName: ROOM }]), hasChannel: () => false };
  if (opts.roomRunning !== false) fm.daemons.set(ROOM, {});
  // The delivery outbox: what is admitted, and its state.
  const notices: Array<{ to: string; key: string; text: string }> = [], state = new Map<string, string>();
  fm.deliveryOutbox = {
    isOpen: true,
    admitSystemNotice: (to: string, key: string, text: string) => { if (!state.has(key)) { notices.push({ to, key, text }); state.set(key, "queued"); } return true; },
    withdrawWaitingNotices: (prefix: string, stale: (k: string) => boolean) => [...state].filter(([k, v]) => k.startsWith(prefix) && stale(k) && v === "queued").map(([k]) => { state.set(k, "cancelled"); return k; }),
    noticeStateByKey: (k: string) => state.get(k) ?? null,
    workingObligations: () => ({ references: [] }),
  };
  fm.needsYou = { poke: vi.fn() };
  fm.startedAt = Date.now() - LIVENESS_STARTUP_GRACE_MS - 60_000;
  const card = (scheduler.db.board.createCards(dispatcher, { cards: [{ title: "Room job", assignee: "dev-a" }] }) as unknown as { cards: Array<{ uuid: string; code: string }> }).cards[0]!;
  scheduler.db.updateTask(card.uuid, { status: "claimed" }, { kind: "instance", name: "dev-a" });
  const tick = async () => { fm.tickDispatcherLiveness(); await settle(); };
  return { fm, scheduler, card, notices, state, tick };
}

describe("#3720: a ClassicBot room that handed out a card is told like an agent", { timeout: 60_000 }, () => {
  it("its assignee stops: exactly one [Task board] notice to the room's agent; recovering: one 'working again' line", async () => {
    const f = await fleet({ kind: "instance", name: ROOM });
    f.fm.onSupervisionGone("dev-a", "crash_loop", "respawn paused after repeated crashes");
    await f.tick(); await f.tick();
    expect(f.notices.map((n) => [n.to, n.text.startsWith("[Task board]"), n.text.includes(f.card.code)])).toEqual([[ROOM, true, true]]);
    expect(f.scheduler.db.liveness.get(f.card.uuid)).toMatchObject({ dispatcher: ROOM, dispatcherKind: "instance", needsYou: false });
    expect(f.fm.needsYouStalls()).toEqual([]);                                   // not a person's
    f.state.set(f.notices[0]!.key, "delivered");
    f.fm.cacheInstanceProcessStatus("dev-a", "running");                        // supervision runs it again
    await f.tick(); await f.tick();
    expect(f.notices.slice(1).map((n) => [n.to, n.text.startsWith("[Task board]") && n.text.includes(f.card.code) && n.text.includes("is working again")])).toEqual([[ROOM, true]]);
    expect(f.scheduler.db.liveness.get(f.card.uuid)).toBeFalsy();
    f.scheduler.db.close();
  });
  it("a room that is not running: the notice waits in its queue and Needs you is told too (as for an instance)", async () => {
    const f = await fleet({ kind: "instance", name: ROOM }, { roomRunning: false });
    f.fm.onSupervisionGone("dev-a", "crash_loop", "x");
    await f.tick();
    expect(f.notices.map((n) => n.to)).toEqual([ROOM]);
    expect(f.scheduler.db.liveness.get(f.card.uuid)).toMatchObject({ dispatcherKind: "instance", needsYou: true });
    f.scheduler.db.close();
  });
  it("a room that is gone (no longer in classicBot.yaml): Needs you, no chat notice", async () => {
    const f = await fleet({ kind: "instance", name: ROOM }, { roomListed: false, roomRunning: false });
    f.fm.onSupervisionGone("dev-a", "crash_loop", "x");
    await f.tick();
    expect(f.notices).toEqual([]);
    expect(f.scheduler.db.liveness.get(f.card.uuid)).toMatchObject({ dispatcherKind: "person" });
    f.scheduler.db.close();
  });
  it("a person dispatcher: still Needs you only", async () => {
    const f = await fleet({ kind: "person", name: "Ann" });
    f.fm.onSupervisionGone("dev-a", "crash_loop", "x");
    await f.tick();
    expect(f.notices).toEqual([]);
    expect(f.scheduler.db.liveness.get(f.card.uuid)).toMatchObject({ dispatcherKind: "person" });
    f.scheduler.db.close();
  });
});
