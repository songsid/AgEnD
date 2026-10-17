/**
 * #1995 follow-up: every registration says so (id, source, next run), so "never registered" can be told from "never
 * fired"; and a cron schedule that is enabled in the database but has no job in this process (a registration that
 * never happened or was lost) is registered by the steady-state check and its missed occurrence caught up as usual.
 * A schedule disabled outside this process (the CLI writes the database, then reloads) is never caught up for an
 * occurrence that fell while it was disabled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler, type SchedulerLog } from "../src/scheduler/scheduler.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import { DEFAULT_SCHEDULER_CONFIG, type Schedule } from "../src/scheduler/types.js";

const MIN = 60_000;
const T = Date.parse("2026-10-17T06:25:00.000Z"); // 14:25 Asia/Taipei
const iso = (ms: number) => new Date(ms).toISOString();

describe("#1995 cron registration: logged, and repaired when missing", () => {
  let dir: string;
  let scheduler: Scheduler;
  let runs: string[];
  let logs: Array<{ level: "info" | "warn"; fields: Record<string, unknown>; message: string }>;
  const log: SchedulerLog = {
    info: (fields, message) => { logs.push({ level: "info", fields, message }); },
    warn: (fields, message) => { logs.push({ level: "warn", fields, message }); },
  };
  const registered = () => logs.filter(l => l.message === "Cron schedule registered").map(l => `${l.fields.source}:${l.fields.next}`);
  const repaired = () => logs.filter(l => l.message === "Cron schedule was not registered — registering").map(l => l.fields.scheduleId);
  const missed = () => logs.filter(l => l.message === "Missed cron tick — catching up").map(l => l.fields.runId);
  const params = (cron: string) => ({ cron, message: "m", source: "w", target: "w", reply_chat_id: "1", reply_thread_id: null, timezone: "Asia/Taipei" });

  function start(wallMs: number) {
    vi.setSystemTime(new Date(wallMs));
    scheduler = new Scheduler(join(dir, "scheduler.db"), (schedule: Schedule, runId: string) => { runs.push(runId); scheduler.recordRun(schedule.id, "delivered"); },
      { ...DEFAULT_SCHEDULER_CONFIG, default_timezone: "Asia/Taipei" }, () => true, () => {}, log);
    scheduler.init();
  }
  /** What `agend schedule add|update` does: another process writes the database directly. */
  function cli<R>(fn: (db: SchedulerDb) => R): R {
    const db = new SchedulerDb(join(dir, "scheduler.db"));
    try { return fn(db); } finally { db.close(); }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    dir = mkdtempSync(join(tmpdir(), "scheduler-reg-1995-"));
    runs = []; logs = [];
  });
  afterEach(() => {
    scheduler?.shutdown();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("logs each registration with its source and next run: init, create, update, reload", async () => {
    start(T - 10 * MIN);
    const s = scheduler.create(params("25 14 17 10 *"));
    scheduler.update(s.id, { message: "edited" });
    cli(db => db.create(params("30 14 17 10 *"), 100));
    scheduler.reload();
    expect(registered()).toEqual([`create:${iso(T)}`, `update:${iso(T)}`, `reload:${iso(T)}`, `reload:${iso(T + 5 * MIN)}`]);
    scheduler.shutdown();
    start(T - 9 * MIN);
    expect(registered().slice(-2)).toEqual([`init:${iso(T)}`, `init:${iso(T + 5 * MIN)}`]);
  });

  it("a brand-new schedule written by the CLI with no reload is registered by the check and its missed tick caught up once", async () => {
    start(T - 2 * MIN);
    vi.setSystemTime(new Date(T - 67_000));
    const s = cli(db => db.create(params("25 14 17 10 *"), 100));   // 14:23:53, and the reload never arrives
    await vi.advanceTimersByTimeAsync(60_500);                      // 14:24:53.5: the first check, a minute after start
    expect(repaired()).toEqual([s.id]);                             // notices it is missing
    expect(registered()).toEqual([`repair:${iso(T)}`]);
    await vi.advanceTimersByTimeAsync(5 * MIN);                     // registered in time: the real tick runs it
    expect(runs).toEqual([iso(T)]);
    expect(missed()).toEqual([]);
  });

  it("a registration lost before the due time: re-registered, and the missed occurrence caught up once after the grace", async () => {
    start(T - 3 * MIN);
    const s = scheduler.create(params("25 14 17 10 *"));
    (scheduler as any).jobs.get(s.id).stop(); (scheduler as any).jobs.delete(s.id);   // lost before it could fire
    vi.setSystemTime(new Date(T + 400));                             // the check has not run since 14:25 passed
    await vi.advanceTimersByTimeAsync(6 * MIN);
    expect(repaired()).toEqual([s.id]);
    expect(runs).toEqual([iso(T)]);
    expect(missed()).toEqual([iso(T)]);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(runs).toEqual([iso(T)]);                                  // once
  });

  it("an occurrence before the schedule was created is never caught up by the repair", async () => {
    start(T - 10 * MIN);
    vi.setSystemTime(new Date(T + 2 * MIN));
    cli(db => db.create(params("25 14 17 10 *"), 100));              // created after 14:25: its next run is a year away
    await vi.advanceTimersByTimeAsync(8 * MIN);
    expect(repaired().length).toBe(1);
    expect(runs).toEqual([]);
    expect(missed()).toEqual([]);
  });

  it("disabled and re-enabled through the CLI with reloads: an occurrence from while it was disabled is not caught up", async () => {
    start(T - 12 * MIN);
    const s = scheduler.create(params("*/10 * * * *"));
    vi.setSystemTime(new Date(T - 5 * MIN + 30_000));                // 14:20:30 by the wall clock, before any check saw it
    cli(db => db.update(s.id, { enabled: false })); scheduler.reload();   // the reload is what forgets its history
    cli(db => db.update(s.id, { enabled: true })); scheduler.reload();    // re-enabled before the next check
    await vi.advanceTimersByTimeAsync(10 * MIN);                     // to 14:30:30
    expect(runs).toEqual([iso(T + 5 * MIN)]);
    expect(missed()).toEqual([]);
  });

  it("disabled through the CLI with no reload, then re-enabled with one: the check forgets it while it is disabled", async () => {
    start(T - 12 * MIN);
    const s = scheduler.create(params("*/10 * * * *"));
    cli(db => db.update(s.id, { enabled: false }));                 // no SIGHUP: the job stays registered
    await vi.advanceTimersByTimeAsync(9 * MIN);                      // 14:20 passes; its tick is "disabled"; checks see it
    cli(db => db.update(s.id, { enabled: true })); scheduler.reload();
    await vi.advanceTimersByTimeAsync(9 * MIN);
    expect(runs).toEqual([iso(T + 5 * MIN)]);
    expect(missed()).toEqual([]);
  });
});
