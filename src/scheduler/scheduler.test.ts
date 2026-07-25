import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler } from "./scheduler.js";
import { SchedulerDb } from "./db.js";
import type { Schedule } from "./types.js";
import { DEFAULT_SCHEDULER_CONFIG } from "./types.js";

describe("Scheduler", () => {
  let dir: string;
  let scheduler: Scheduler;
  let triggered: Schedule[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scheduler-engine-test-"));
    triggered = [];
    scheduler = new Scheduler(
      join(dir, "scheduler.db"),
      (schedule) => { triggered.push(schedule); },
      DEFAULT_SCHEDULER_CONFIG,
      (instanceName: string) => true,
    );
    scheduler.init();
  });

  afterEach(() => {
    scheduler.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a schedule and registers cron job", () => {
    const s = scheduler.create({
      cron: "0 7 * * *",
      message: "hello",
      source: "proj-a",
      target: "proj-a",
      reply_chat_id: "1",
      reply_thread_id: null,
    });
    expect(s.id).toBeTruthy();
    expect(scheduler.list()).toHaveLength(1);
  });

  it("rejects invalid cron expression", () => {
    expect(() =>
      scheduler.create({
        cron: "not a cron",
        message: "hello",
        source: "a",
        target: "a",
        reply_chat_id: "1",
        reply_thread_id: null,
      })
    ).toThrow(/cron/i);
  });

  it("rejects invalid target instance", () => {
    const s2 = new Scheduler(
      join(dir, "scheduler2.db"),
      () => {},
      DEFAULT_SCHEDULER_CONFIG,
      (name: string) => name === "proj-a",
    );
    s2.init();
    expect(() =>
      s2.create({
        cron: "0 7 * * *",
        message: "hello",
        source: "proj-a",
        target: "nonexistent",
        reply_chat_id: "1",
        reply_thread_id: null,
      })
    ).toThrow(/not found/i);
    s2.shutdown();
  });

  it("manual trigger calls onTrigger callback", () => {
    const s = scheduler.create({
      cron: "0 7 * * *",
      message: "hello",
      source: "proj-a",
      target: "proj-a",
      reply_chat_id: "1",
      reply_thread_id: null,
    });
    scheduler.trigger(s.id);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].id).toBe(s.id);
  });

  it("delete removes schedule and cron job", () => {
    const s = scheduler.create({
      cron: "0 7 * * *",
      message: "hello",
      source: "a",
      target: "a",
      reply_chat_id: "1",
      reply_thread_id: null,
    });
    scheduler.delete(s.id);
    expect(scheduler.list()).toHaveLength(0);
  });

  it("update reschedules cron job", () => {
    const s = scheduler.create({
      cron: "0 7 * * *",
      message: "hello",
      source: "a",
      target: "a",
      reply_chat_id: "1",
      reply_thread_id: null,
    });
    const updated = scheduler.update(s.id, { cron: "0 8 * * *" });
    expect(updated.cron).toBe("0 8 * * *");
  });

  it("reload clears and re-registers all jobs", () => {
    scheduler.create({
      cron: "0 7 * * *",
      message: "hello",
      source: "a",
      target: "a",
      reply_chat_id: "1",
      reply_thread_id: null,
    });
    scheduler.reload();
    expect(scheduler.list()).toHaveLength(1);
  });

  it("deleteByInstanceOrThread cleans up and removes cron jobs", () => {
    scheduler.create({
      cron: "0 7 * * *",
      message: "a",
      source: "a",
      target: "proj-a",
      reply_chat_id: "1",
      reply_thread_id: "42",
    });
    const count = scheduler.deleteByInstanceOrThread("proj-a", "42");
    expect(count).toBe(1);
    expect(scheduler.list()).toHaveLength(0);
  });
});

describe("Scheduler one-shot schedules", () => {
  let dir: string;
  let dbPath: string;
  let scheduler: Scheduler;
  let triggered: Schedule[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T00:00:00.000Z"));
    dir = mkdtempSync(join(tmpdir(), "scheduler-at-test-"));
    dbPath = join(dir, "scheduler.db");
    triggered = [];
    scheduler = new Scheduler(
      dbPath,
      schedule => { triggered.push(schedule); },
      DEFAULT_SCHEDULER_CONFIG,
      () => true,
    );
    scheduler.init();
  });

  afterEach(() => {
    scheduler.shutdown();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const createAt = (at: string): Schedule => scheduler.create({
    at,
    message: "one shot",
    source: "test",
    target: "general",
    reply_chat_id: "chat",
    reply_thread_id: null,
  });

  it("fires once at the requested instant and auto-deletes the row", () => {
    const schedule = createAt("2026-07-26T00:00:10.000Z");

    vi.advanceTimersByTime(9_999);
    expect(triggered).toHaveLength(0);
    expect(scheduler.get(schedule.id)).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(triggered.map(item => item.id)).toEqual([schedule.id]);
    expect(scheduler.get(schedule.id)).toBeNull();

    vi.advanceTimersByTime(60_000);
    expect(triggered).toHaveLength(1);
  });

  it("keeps the row until an async delivery can record its run", async () => {
    scheduler.shutdown();
    let release!: () => void;
    const delivered = new Promise<void>(resolve => { release = resolve; });
    scheduler = new Scheduler(
      dbPath,
      async schedule => {
        scheduler.recordRun(schedule.id, "delivered");
        await delivered;
      },
      DEFAULT_SCHEDULER_CONFIG,
      () => true,
    );
    scheduler.init();
    const schedule = createAt("2026-07-26T00:00:01.000Z");

    vi.advanceTimersByTime(1_000);
    expect(scheduler.get(schedule.id)).not.toBeNull();
    expect(scheduler.getRuns(schedule.id)).toHaveLength(1);

    release();
    await delivered;
    await Promise.resolve();
    expect(scheduler.get(schedule.id)).toBeNull();
  });

  it("re-registers the remaining delay after a fleet restart", () => {
    const schedule = createAt("2026-07-26T00:01:00.000Z");
    vi.advanceTimersByTime(20_000);
    scheduler.shutdown();

    scheduler = new Scheduler(
      dbPath,
      item => { triggered.push(item); },
      DEFAULT_SCHEDULER_CONFIG,
      () => true,
    );
    scheduler.init();

    vi.advanceTimersByTime(39_999);
    expect(triggered).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(triggered.map(item => item.id)).toEqual([schedule.id]);
    expect(scheduler.get(schedule.id)).toBeNull();
  });

  it("chunks delays beyond Node's maximum timeout instead of firing early", () => {
    const schedule = createAt("2026-08-25T00:00:00.000Z"); // 30 days

    vi.advanceTimersByTime(29 * 24 * 60 * 60 * 1_000);
    expect(triggered).toHaveLength(0);
    expect(scheduler.get(schedule.id)).not.toBeNull();

    vi.advanceTimersByTime(24 * 60 * 60 * 1_000);
    expect(triggered.map(item => item.id)).toEqual([schedule.id]);
    expect(scheduler.get(schedule.id)).toBeNull();
  });

  it("fires an already-expired one-shot immediately on init", () => {
    scheduler.shutdown();
    const seed = new SchedulerDb(dbPath);
    const schedule = seed.create({
      at: "2026-07-25T23:59:00.000Z",
      message: "overdue",
      source: "test",
      target: "general",
      reply_chat_id: "chat",
      reply_thread_id: null,
    });
    seed.close();

    scheduler = new Scheduler(
      dbPath,
      item => { triggered.push(item); },
      DEFAULT_SCHEDULER_CONFIG,
      () => true,
    );
    scheduler.init();
    vi.advanceTimersByTime(0);

    expect(triggered.map(item => item.id)).toEqual([schedule.id]);
    expect(scheduler.get(schedule.id)).toBeNull();
  });

  it("rejects missing, conflicting, or timezone-less timing", () => {
    const base = {
      message: "bad",
      source: "test",
      target: "general",
      reply_chat_id: "chat",
      reply_thread_id: null,
    };
    expect(() => scheduler.create(base)).toThrow(/exactly one/i);
    expect(() => scheduler.create({
      ...base,
      cron: "0 7 * * *",
      at: "2026-07-26T14:00:00+08:00",
    })).toThrow(/exactly one/i);
    expect(() => scheduler.create({
      ...base,
      at: "2026-07-26T14:00:00",
    })).toThrow(/ISO-8601/i);
  });

  it("switches between recurring and one-shot timing on update", () => {
    const recurring = scheduler.create({
      cron: "0 7 * * *",
      message: "switch",
      source: "test",
      target: "general",
      reply_chat_id: "chat",
      reply_thread_id: null,
    });

    const oneShot = scheduler.update(recurring.id, { at: "2026-07-26T00:00:05.000Z" });
    expect(oneShot).toMatchObject({ cron: null, at: "2026-07-26T00:00:05.000Z" });

    const recurringAgain = scheduler.update(recurring.id, { cron: "0 8 * * *" });
    expect(recurringAgain).toMatchObject({ cron: "0 8 * * *", at: null });
  });
});
