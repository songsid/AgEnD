import { installTmuxProcessFixture } from "./helpers/tmux-process-stub.js";
installTmuxProcessFixture();
/**
 * #1426: an occurrence the 5h rate limit deferred is retried once, after the window resets — at the statusline's reset
 * time when known, else looked at every 15 min — and never at or after the schedule's next occurrence (or a 5h15m cap).
 * The retry keeps the occurrence's run id, tells the agent it is a retry, survives a restart (persisted), and when it
 * cannot happen (superseded, deferred again, expired) the schedule's chat hears it with its admins @mentioned.
 *
 * Fake timers drive croner and the retry timers. Dates are in 2030 so the scheduler's catch-up, which reads SQLite's
 * real `datetime('now')` for last_triggered_at, never mistakes a test's past for a missed occurrence.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../src/scheduler/scheduler.js";
import type { Schedule, ScheduleRetry, ScheduleRetryDrop } from "../src/scheduler/types.js";
import { DEFAULT_SCHEDULER_CONFIG } from "../src/scheduler/types.js";
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { StatuslineWatcher } from "../src/statusline-watcher.js";

const at = (iso: string) => Date.parse(iso);
const T13 = "2030-10-08T13:00:00.000Z";      // 21:00 Asia/Taipei

let dir: string;
const schedulers: Scheduler[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(at("2030-10-08T12:59:00.000Z"));
  dir = mkdtempSync(join(tmpdir(), "agend-1426-"));
});
afterEach(() => {
  for (const s of schedulers.splice(0)) { try { s.shutdown(); } catch { /* already */ } }
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

type Call = { id: string; runId: string; retry?: ScheduleRetry };
function engine(onTrigger?: (s: Schedule, runId: string, retry: ScheduleRetry | undefined, sch: Scheduler) => void) {
  const calls: Call[] = [];
  const drops: Array<{ id: string; runId: string; reason: ScheduleRetryDrop }> = [];
  let self: Scheduler;
  self = new Scheduler(join(dir, "scheduler.db"), (s, runId, retry) => {
    calls.push({ id: s.id, runId, retry });
    onTrigger?.(s, runId, retry, self);
  }, DEFAULT_SCHEDULER_CONFIG, () => true, (s, retry, reason) => drops.push({ id: s.id, runId: retry.run_id, reason }));
  schedulers.push(self);
  self.init();
  return { scheduler: self, calls, drops };
}
const daily = (s: Scheduler, cron = "0 21 * * *") => s.create({
  cron, message: "check versions", source: "src", target: "dev", reply_chat_id: "chat", reply_thread_id: null,
  label: "cli-version-watch", timezone: "Asia/Taipei",
});

describe("Scheduler: the one retry of a deferred occurrence", () => {
  it("waits for the window's reset (plus a minute) and runs the same occurrence once, with its retry", async () => {
    const { scheduler, calls } = engine();
    vi.setSystemTime(at(T13));
    const s = daily(scheduler);                   // created just after 21:00: its own next run is tomorrow
    const retry = scheduler.deferForRetry(s, T13, { deferredPct: 100, resetsAtMs: at("2030-10-08T15:00:00Z") });
    // daily: the cap (5h15m) comes before tomorrow's occurrence
    expect(retry).toMatchObject({ run_id: T13, due_at_ms: at("2030-10-08T15:01:00Z"), deadline_kind: "cap",
      deadline_ms: at("2030-10-08T18:15:00Z") });
    await vi.advanceTimersByTimeAsync(at("2030-10-08T15:00:59Z") - Date.now());
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual([{ id: s.id, runId: T13, retry: expect.objectContaining({ run_id: T13 }) }]);
  });

  it("with no reset time it looks again after 15 minutes", () => {
    const { scheduler } = engine();
    const s = daily(scheduler);
    vi.setSystemTime(at(T13));
    expect(scheduler.deferForRetry(s, T13, { deferredPct: 90, resetsAtMs: null })).toMatchObject({ due_at_ms: at("2030-10-08T13:15:00Z") });
  });

  it("no retry when the next occurrence comes first; and a cap when the reset is further than 5h15m", () => {
    const { scheduler } = engine();
    const half = daily(scheduler, "*/30 * * * *");
    vi.setSystemTime(at(T13));
    expect(scheduler.deferForRetry(half, T13, { deferredPct: 99, resetsAtMs: at("2030-10-08T15:00:00Z") }))
      .toMatchObject({ dropped: "superseded" });
    expect(scheduler.getRetry(half.id)).toBeNull();
    const day = daily(scheduler);
    expect(scheduler.deferForRetry(day, T13, { deferredPct: 99, resetsAtMs: at("2030-10-08T19:00:00Z") }))
      .toMatchObject({ dropped: "expired" });
  });

  it("the next occurrence supersedes a pending retry: reported, removed, never run", async () => {
    const { scheduler, calls, drops } = engine();
    const s = daily(scheduler, "0 * * * *");
    vi.setSystemTime(at(T13));
    // pending until 14:30, i.e. past the next occurrence (built directly: deferForRetry would never arm it so)
    scheduler.db.putRetry({ schedule_id: s.id, run_id: T13, deferred_at_ms: at(T13), deferred_pct: 100, resets_at_ms: null,
      due_at_ms: at("2030-10-08T14:30:00Z"), deadline_ms: at("2030-10-08T15:00:00Z"), deadline_kind: "cap" });
    scheduler.reload();
    await vi.advanceTimersByTimeAsync(at("2030-10-08T14:45:00Z") - Date.now());
    expect(drops).toEqual([{ id: s.id, runId: T13, reason: "superseded" }]);
    expect(calls.map(c => [c.runId, !!c.retry])).toEqual([["2030-10-08T14:00:00.000Z", false]]);
    expect(scheduler.getRetry(s.id)).toBeNull();
  });

  it("a manual trigger supersedes it too", () => {
    const { scheduler, drops } = engine();
    const s = daily(scheduler);
    vi.setSystemTime(at(T13));
    scheduler.deferForRetry(s, T13, { deferredPct: 100, resetsAtMs: null });
    scheduler.trigger(s.id);
    expect(drops).toEqual([{ id: s.id, runId: T13, reason: "superseded" }]);
  });

  it("postponing it to or past its deadline ends it", () => {
    const { scheduler } = engine();
    const s = daily(scheduler, "0 * * * *");
    vi.setSystemTime(at("2030-10-08T13:50:00Z"));
    const retry = scheduler.deferForRetry(s, T13, { deferredPct: 100, resetsAtMs: null, nowMs: at(T13) }) as ScheduleRetry;
    expect(scheduler.postponeRetry(retry, null)).toMatchObject({ dropped: "superseded" });   // 14:05 ≥ 14:00
    expect(scheduler.getRetry(s.id)).toBeNull();
  });

  it("survives a restart: the new scheduler re-arms it from the database and runs it", async () => {
    const first = engine();
    const s = daily(first.scheduler);
    vi.setSystemTime(at(T13));
    first.scheduler.deferForRetry(s, T13, { deferredPct: 100, resetsAtMs: at("2030-10-08T15:00:00Z") });
    first.scheduler.recordRun(s.id, "deferred");
    first.scheduler.shutdown();
    vi.setSystemTime(at("2030-10-08T14:00:00Z"));
    const second = engine();
    await vi.advanceTimersByTimeAsync(at("2030-10-08T15:01:01Z") - Date.now());
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual([{ id: s.id, runId: T13, retry: expect.objectContaining({ run_id: T13 }) }]);
  });

  it("a restart after its deadline does not run it: reported as superseded", async () => {
    const first = engine();
    const s = daily(first.scheduler, "0 * * * *");
    vi.setSystemTime(at(T13));
    first.scheduler.deferForRetry(s, T13, { deferredPct: 100, resetsAtMs: null });
    first.scheduler.recordRun(s.id, "deferred");
    first.scheduler.shutdown();
    vi.setSystemTime(at("2030-10-08T14:20:00Z"));
    const second = engine();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(second.calls.filter(c => c.retry)).toEqual([]);
    expect(second.drops).toEqual([{ id: s.id, runId: T13, reason: "superseded" }]);
  });

  it("a deferred one-shot stays until its retry has run, then is consumed", async () => {
    const { scheduler, calls } = engine((s, runId, retry, sch) => {
      if (!retry) sch.deferForRetry(s, runId, { deferredPct: 100, resetsAtMs: at("2030-10-08T14:00:00Z") });
      else sch.endRetry(retry);
    });
    const s = scheduler.create({ at: "2030-10-08T13:00:00Z", message: "once", source: "src", target: "dev",
      reply_chat_id: "chat", reply_thread_id: null, timezone: "Asia/Taipei" });
    await vi.advanceTimersByTimeAsync(at("2030-10-08T13:00:01Z") - Date.now());
    expect(calls).toHaveLength(1);
    expect(scheduler.get(s.id)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(at("2030-10-08T14:01:01Z") - Date.now());
    expect(calls.map(c => !!c.retry)).toEqual([false, true]);
    expect(scheduler.get(s.id)).toBeNull();
  });
});

describe("StatuslineWatcher keeps the 5h window's reset time", () => {
  it("resets_at (epoch seconds, as claude-code writes it) becomes epoch ms; absent is null", async () => {
    const inst = join(dir, "inst");
    mkdirSync(inst, { recursive: true });
    const ctx: any = { getInstanceDir: () => inst, logger: { info: vi.fn() }, costGuard: null, notifyInstanceTopic: vi.fn(), checkModelFailover: vi.fn() };
    const watcher = new StatuslineWatcher(ctx);
    try {
      writeFileSync(join(inst, "statusline.json"), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 97, resets_at: 1917716400 }, seven_day: { used_percentage: 3 } } }));
      watcher.watch("a");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(watcher.getRateLimits("a")).toEqual({ five_hour_pct: 97, seven_day_pct: 3, five_hour_resets_at_ms: 1917716400_000 });
      writeFileSync(join(inst, "statusline.json"), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 97 } } }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(watcher.getRateLimits("a")!.five_hour_resets_at_ms).toBeNull();
    } finally { watcher.stopAll(); }
  });
});

describe("FleetManager: deferral, retry, escalation", () => {
  let fm: FleetManager;
  let limits: { five_hour_pct: number; seven_day_pct: number; five_hour_resets_at_ms: number | null } | undefined;
  let deliver: ReturnType<typeof vi.fn>;
  let topic: ReturnType<typeof vi.fn>;
  let sent: Array<{ text: string; opts: any }>;

  function fleet(type: "telegram" | "discord" = "telegram") {
    fm = new FleetManager(dir);
    const config = { id: "main", type, group_id: "group-1", access: { allowed_users: ["111"] } } as any;
    sent = [];
    const adapter = { id: "main", type, sendText: vi.fn(async (_c: string, text: string, opts: any) => { sent.push({ text, opts }); return { messageId: "m" }; }) } as any;
    fm.fleetConfig = { defaults: {}, channels: [config], instances: { dev: { working_directory: dir } } } as any;
    fm.worlds.set("main", { id: "main", adapter, channelConfig: config, groupId: "group-1" } as any);
    limits = undefined;
    vi.spyOn((fm as any).statuslineWatcher, "getRateLimits").mockImplementation(() => limits);
    deliver = vi.spyOn(fm, "deliverToInstance").mockResolvedValue(undefined) as any;
    topic = vi.spyOn(fm as any, "notifyInstanceTopic").mockImplementation(() => {}) as any;
    vi.spyOn(fm as any, "sendCancelButton").mockResolvedValue(undefined);
    const scheduler = new Scheduler(join(dir, "scheduler.db"),
      (s, runId, retry) => (fm as any).handleScheduleTrigger(s, runId, retry), DEFAULT_SCHEDULER_CONFIG, () => true,
      (s, retry, reason) => (fm as any).scheduleRetryDropped(s, retry, reason));
    schedulers.push(scheduler);
    (fm as any).scheduler = scheduler;
    scheduler.init();
    return scheduler;
  }
  const create = (scheduler: Scheduler, cron = "0 21 * * *", silent = false) => scheduler.create({
    cron, message: "check versions", source: "dev", target: "dev", reply_chat_id: "group-1", reply_thread_id: "7",
    label: "cli<watch>", timezone: "Asia/Taipei", silent,
  });
  const messages = () => deliver.mock.calls.map(c => (c[1] as any).payload.message as string);

  it("deferred at 100%: says when it will run; after the reset it runs once, labelled, and last_status says so", async () => {
    const scheduler = fleet();
    const s = create(scheduler);
    limits = { five_hour_pct: 100, seven_day_pct: 10, five_hour_resets_at_ms: at("2030-10-08T15:00:00Z") };
    await vi.advanceTimersByTimeAsync(at("2030-10-08T13:00:01Z") - Date.now());
    expect(deliver).not.toHaveBeenCalled();
    expect(scheduler.get(s.id)!.last_status).toBe("deferred");
    expect(topic).toHaveBeenCalledWith("dev", expect.stringContaining("runs once after the window resets (around 23:01)"));
    // after the reset the file still says 100% — claude-code has not rendered since — but its window is over
    await vi.advanceTimersByTimeAsync(at("2030-10-08T15:01:01Z") - Date.now());
    expect(messages()).toEqual([
      "[Scheduled] [retry] originally due 21:00 (Asia/Taipei), deferred by the 5h rate limit at 100%\ncheck versions",
    ]);
    expect(scheduler.get(s.id)!.last_status).toBe("deferred → delivered (retry)");
    expect(scheduler.getRetry(s.id)).toBeNull();
    expect(sent).toEqual([]);
  });

  it("no double run: the next occurrence wins — the retry is dropped with an @admin notice, the occurrence runs once unlabelled", async () => {
    const scheduler = fleet();
    const s = create(scheduler, "0 * * * *");
    limits = { five_hour_pct: 99, seven_day_pct: 10, five_hour_resets_at_ms: null };   // no reset time: polled
    await vi.advanceTimersByTimeAsync(at("2030-10-08T13:00:01Z") - Date.now());
    await vi.advanceTimersByTimeAsync(at("2030-10-08T13:59:00Z") - Date.now());
    limits = undefined;                                                                  // recovered just before 14:00
    await vi.advanceTimersByTimeAsync(at("2030-10-08T14:00:01Z") - Date.now());
    expect(messages()).toEqual(["[Scheduled] check versions"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.opts).toMatchObject({ format: "html", threadId: "7" });
    expect(sent[0]!.text).toContain(`<a href="tg://user?id=111">admin</a>`);
    expect(sent[0]!.text).toContain("cli&lt;watch&gt;");
    expect(sent[0]!.text).toContain("its 21:00 run was deferred by the 5h rate limit (99%)");
    expect(sent[0]!.text).toContain("its next run (22:00) came before the window reset");
    const statuses = scheduler.getRuns(s.id).map(r => r.status).reverse();
    expect(statuses).toEqual(["deferred", "deferred → skipped (superseded)", "delivered"]);
  });

  it("deferred again after the reset: given up, the admins told (Discord mention)", async () => {
    const scheduler = fleet("discord");
    const s = create(scheduler);
    limits = { five_hour_pct: 100, seven_day_pct: 10, five_hour_resets_at_ms: at("2030-10-08T15:00:00Z") };
    await vi.advanceTimersByTimeAsync(at("2030-10-08T13:00:01Z") - Date.now());
    limits = { five_hour_pct: 95, seven_day_pct: 10, five_hour_resets_at_ms: at("2030-10-08T20:00:00Z") };   // a new window, over again
    await vi.advanceTimersByTimeAsync(at("2030-10-08T15:01:01Z") - Date.now());
    expect(deliver).not.toHaveBeenCalled();
    expect(scheduler.get(s.id)!.last_status).toBe("deferred → skipped (deferred again)");
    expect(sent.map(m => m.text)).toEqual([expect.stringMatching(/^<@111> ⚠️ Schedule "cli<watch>" did not run: .* it was deferred again after the window reset\.$/)]);
    expect(sent[0]!.opts.format).toBeUndefined();
  });

  it("a fresh occurrence is not deferred on a window that has already reset (a stale 100%)", async () => {
    const scheduler = fleet();
    create(scheduler);
    limits = { five_hour_pct: 100, seven_day_pct: 10, five_hour_resets_at_ms: at("2030-10-08T12:00:00Z") };
    await vi.advanceTimersByTimeAsync(at("2030-10-08T13:00:01Z") - Date.now());
    expect(messages()).toEqual(["[Scheduled] check versions"]);
  });

  it("a silent schedule's retry pastes the raw command unchanged, under the occurrence's run id", async () => {
    const scheduler = fleet();
    (fm as any).shuttingDown = true;   // keep the outbox dispatcher idle
    const outbox = new DeliveryOutbox(join(dir, "delivery-outbox.db"), fm.managerBootId);
    fm.deliveryOutbox = outbox;
    const s = create(scheduler, "0 21 * * *", true);
    limits = { five_hour_pct: 100, seven_day_pct: 10, five_hour_resets_at_ms: at("2030-10-08T15:00:00Z") };
    await vi.advanceTimersByTimeAsync(at("2030-10-08T13:00:01Z") - Date.now());
    expect(outbox.listPending()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(at("2030-10-08T15:01:01Z") - Date.now());
    expect(outbox.listPending().map(r => [r.operationId, r.payload.content])).toEqual([[`schedule:${s.id}:${T13}`, "check versions"]]);
    expect(scheduler.get(s.id)!.last_status).toBe("deferred → queued (retry)");
    outbox.close();
  });
});
