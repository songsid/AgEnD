/**
 * #1995: a cron occurrence that never ran left no trace — no run row, no log line — and a running fleet never caught it
 * up (only startup did). Every tick and every tick that does not run is now logged with its reason, a rejected run is
 * logged, and a steady-state check runs an occurrence that came due and was not run with the same single catch-up as
 * startup: after a grace of the process's own (monotonic) time, under the occurrence's own run id, so a late but real
 * tick and the check never both run it. Wall clock is only cron math; the timers are monotonic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler, type SchedulerLog } from "../src/scheduler/scheduler.js";
import { DEFAULT_SCHEDULER_CONFIG, type Schedule } from "../src/scheduler/types.js";

const MIN = 60_000;
const T = Date.parse("2026-10-13T00:50:00.000Z"); // 08:50 in Asia/Taipei, a */5 occurrence
const iso = (ms: number) => new Date(ms).toISOString();

describe("#1995 cron ticks: logged, and a missed one caught up once", () => {
  let dir: string;
  let scheduler: Scheduler;
  let runs: string[];
  let logs: Array<{ level: "info" | "warn"; fields: Record<string, unknown>; message: string }>;
  /** What the next run does; the default settles at once and records like the fleet does. */
  let onRun: (schedule: Schedule, runId: string) => void | Promise<void>;

  const log: SchedulerLog = {
    info: (fields, message) => { logs.push({ level: "info", fields, message }); },
    warn: (fields, message) => { logs.push({ level: "warn", fields, message }); },
  };
  const reasons = () => logs.filter(l => l.message === "Cron tick not run").map(l => `${l.fields.reason}@${l.fields.runId}`);
  const missed = () => logs.filter(l => l.message === "Missed cron tick — catching up").map(l => l.fields.runId);

  function start(wallMs: number) {
    vi.setSystemTime(new Date(wallMs));
    scheduler = new Scheduler(join(dir, "scheduler.db"), (schedule, runId) => { runs.push(runId); return onRun(schedule, runId); },
      { ...DEFAULT_SCHEDULER_CONFIG, default_timezone: "Asia/Taipei" }, () => true, () => {}, log);
    scheduler.init();
  }
  const every5 = () => scheduler.create({ cron: "*/5 * * * *", message: "m", source: "w", target: "w", reply_chat_id: "1", reply_thread_id: null, timezone: "Asia/Taipei" });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    dir = mkdtempSync(join(tmpdir(), "scheduler-1995-"));
    runs = []; logs = [];
    onRun = (schedule) => { scheduler.recordRun(schedule.id, "delivered"); };
  });
  afterEach(() => {
    scheduler?.shutdown();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("steady state: every occurrence once, one log line per tick, nothing caught up", async () => {
    start(T - 2 * MIN);
    every5();
    await vi.advanceTimersByTimeAsync(31 * MIN);
    const want = [0, 1, 2, 3, 4, 5].map(k => iso(T + k * 5 * MIN));
    expect(runs).toEqual(want);
    expect(logs.filter(l => l.message === "Cron tick").map(l => l.fields.runId)).toEqual(want);
    expect(reasons()).toEqual([]);
    expect(missed()).toEqual([]);
  });

  it("a tick lost to a reload at its due instant is run once, by the check, after the grace", async () => {
    start(T - 2 * MIN);
    every5();
    await vi.advanceTimersByTimeAsync(2 * MIN - 1);            // 1 ms before the occurrence; its timer is still pending
    vi.setSystemTime(new Date(T + 400));                          // the wall clock is past it, the timer has not run yet
    scheduler.reload();                                           // ...and the jobs are re-created before it does
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(runs).toEqual([]);                                     // not before the grace
    await vi.advanceTimersByTimeAsync(2 * MIN);                   // T+4: due and not run for the grace
    expect(runs).toEqual([iso(T)]);                               // caught up once, under its own run id
    expect(missed()).toEqual([iso(T)]);
    await vi.advanceTimersByTimeAsync(6 * MIN);
    expect(runs).toEqual([iso(T), iso(T + 5 * MIN), iso(T + 10 * MIN)]);
    expect(missed()).toEqual([iso(T)]);
  });

  it("a late real tick after the catch-up does not run the occurrence again", async () => {
    start(T - 2 * MIN);
    const s = every5();
    await vi.advanceTimersByTimeAsync(2 * MIN - 1);
    vi.setSystemTime(new Date(T + 400));
    scheduler.reload();
    await vi.advanceTimersByTimeAsync(5 * MIN - 1000);           // caught up, still before the next occurrence
    expect(runs).toEqual([iso(T)]);
    await (scheduler as any).jobs.get(s.id).trigger();           // croner's own callback arriving late, for the same instant
    expect(runs).toEqual([iso(T)]);
    expect(reasons()).toEqual([`already_ran@${iso(T)}`]);
  });

  it("wall clock jumping forward: one run for the jump (the latest occurrence), no extra catch-up", async () => {
    start(T - 1 * MIN);
    every5();
    await vi.advanceTimersByTimeAsync(2 * MIN);                   // T ran
    vi.setSystemTime(new Date(Date.now() + 12 * MIN));            // T+5 and T+10 are now past by the wall clock
    await vi.advanceTimersByTimeAsync(8 * MIN);
    expect(runs.slice(0, 2)).toEqual([iso(T), iso(T + 10 * MIN)]);
    expect(missed()).toEqual([]);
    expect(new Set(runs).size).toBe(runs.length);
  });

  it("wall clock jumping back right after a tick: that occurrence is not run again", async () => {
    start(T - 1 * MIN);
    every5();
    await vi.advanceTimersByTimeAsync(1 * MIN + 2000);            // T ran at T+~0
    expect(runs).toEqual([iso(T)]);
    vi.setSystemTime(new Date(T - 3 * MIN));                     // NTP / a VM resync sets the clock back across T
    await vi.advanceTimersByTimeAsync(9 * MIN);                   // the wall clock passes T again, then reaches T+5
    expect(runs).toEqual([iso(T), iso(T + 5 * MIN)]);
    expect(missed()).toEqual([]);
  });

  it("a rejected run is logged instead of vanishing", async () => {
    start(T - 1 * MIN);
    every5();
    onRun = () => Promise.reject(new Error("database is locked"));
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(runs).toEqual([iso(T)]);
    expect(logs.filter(l => l.message === "Schedule run failed").map(l => l.fields)).toEqual([
      { scheduleId: expect.any(String), runId: iso(T), err: "database is locked" },
    ]);
    // ...and the check does not run it a second time: this process already started that occurrence.
    onRun = (schedule) => { scheduler.recordRun(schedule.id, "delivered"); };
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(runs).toEqual([iso(T), iso(T + 5 * MIN)]);
    expect(missed()).toEqual([]);
  });

  it("an occurrence skipped while the previous run is still in flight is logged, and not replayed later", async () => {
    start(T - 1 * MIN);
    every10();
    let settle!: () => void;
    onRun = (schedule) => new Promise<void>(r => { settle = () => { scheduler.recordRun(schedule.id, "delivered"); r(); }; });
    await vi.advanceTimersByTimeAsync(2 * MIN);                   // T starts and keeps running
    onRun = (schedule) => { scheduler.recordRun(schedule.id, "delivered"); };
    await vi.advanceTimersByTimeAsync(10 * MIN);                  // T+10 arrives while T is in flight
    expect(reasons()).toEqual([`still_running@${iso(T + 10 * MIN)}`]);
    settle();
    await vi.advanceTimersByTimeAsync(7 * MIN);                   // T+19: far past the grace, before T+20
    expect(runs).toEqual([iso(T)]);
    expect(missed()).toEqual([]);
  });

  const every10 = () => scheduler.create({ cron: "*/10 * * * *", message: "m", source: "w", target: "w", reply_chat_id: "1", reply_thread_id: null, timezone: "Asia/Taipei" });

  it("an occurrence before the schedule was re-enabled is not caught up", async () => {
    start(T - 2 * MIN);
    const s = every10();
    scheduler.update(s.id, { enabled: false });
    await vi.advanceTimersByTimeAsync(3 * MIN);                   // T passes while disabled
    scheduler.update(s.id, { enabled: true });
    await vi.advanceTimersByTimeAsync(10 * MIN);                  // well past the grace, and past T+10
    expect(runs).toEqual([iso(T + 10 * MIN)]);
    expect(missed()).toEqual([]);
  });

  it("the grace is this process's own time: a wall-clock jump does not shorten it", async () => {
    start(T - 2 * MIN);
    every10();
    await vi.advanceTimersByTimeAsync(2 * MIN - 1);
    vi.setSystemTime(new Date(T + 400));
    scheduler.reload();                                           // T lost, as above
    vi.setSystemTime(new Date(Date.now() + 150_000));             // and the wall clock jumps 2.5 min ahead
    await vi.advanceTimersByTimeAsync(2 * MIN);                   // T is 4.5 min old by the wall clock, not by ours
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(runs).toEqual([iso(T)]);
  });

  it("a missed occurrence waits while an earlier run is still in flight, then runs once", async () => {
    start(T - 7 * MIN);
    every10();
    let settle!: () => void;
    onRun = (schedule) => new Promise<void>(r => { settle = () => { scheduler.recordRun(schedule.id, "delivered"); r(); }; });
    await vi.advanceTimersByTimeAsync(7 * MIN - 1);               // T-10 is long past; nothing in flight yet
    expect(runs).toEqual([]);
    await (scheduler as any).runWithLock(scheduler.list()[0], "manual-run");   // a manual trigger that keeps running
    vi.setSystemTime(new Date(T + 400));
    scheduler.reload();                                           // T lost while that run is in flight
    onRun = (schedule) => { scheduler.recordRun(schedule.id, "delivered"); };
    await vi.advanceTimersByTimeAsync(4 * MIN);                   // past the grace, still in flight
    expect(runs).toEqual(["manual-run"]);                         // never an overlapping run
    settle();
    await vi.advanceTimersByTimeAsync(4.5 * MIN);                 // then the grace again, before T+10
    expect(runs).toEqual(["manual-run", iso(T)]);
    expect(missed()).toEqual([iso(T)]);
  });
});
