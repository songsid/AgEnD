// M-3770 slice 2.5, wiring part 3 (design update-wiring-m3770.md §5, §10.3–§10.6): the trial fleet. Trial mode is
// chosen by the journal (this start's handoff nonce is the open attempt's `trial` generation, in trial or proving); it
// starts no agents and holds from its start — adapter and web turns journaled as copies on the attempt's ONE inbox
// sequence (after the old fleet's last file), occurrences deferred, durable outbox rows left queued — and it answers
// `trial.prove` with its own health, adapters informational. The fleet is a FleetManager prototype with only the state
// these paths read; nothing is started.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { FleetManager } from "../src/fleet-manager.js";
import { askFleet, proveTrial } from "../src/update-control.js";
import { ackGeneration, advance, finish, listHandback, newAttemptId, openAttempt, planGeneration, type AttemptRecord, type Stage } from "../src/update-journal.js";
import { QuiescenceBarrier } from "../src/update-quiescence.js";

const dirs: string[] = [], outboxes: DeliveryOutbox[] = [];
afterEach(() => { for (const o of outboxes.splice(0)) o.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ID = newAttemptId(new Date("2026-11-27T15:00:00Z"), "f0f0f0f0");
const OLD = { nonce: "a".repeat(32), pid: 5100 };
const TRIAL = { nonce: "b".repeat(32), pid: process.pid };
const DRIVER = { pid: 4343, token: "t".repeat(32) };
const turn = (text: string) => ({ type: "fleet_inbound", content: text, meta: { chat_id: "c1", message_id: text, user: "u" } });

/** An attempt walked to `stage`, its old generation acknowledged and, from trial on, its trial generation acknowledged. */
function attemptAt(stage: Stage, opts: { trialDead?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "trial-")); dirs.push(home);
  const opened = openAttempt(home, { id: ID, kind: "update", updater: { pid: DRIVER.pid, start: { processStart: "x" } },
    from: { name: "@songsid/agend", version: "2.5.0", integrity: null }, to: { name: "@songsid/agend", version: "2.5.1", integrity: null },
    extra: { fleets: [{ gen: "old", nonce: OLD.nonce, pid: OLD.pid, plannedAt: new Date().toISOString(), consumed: true }] } });
  if (!opened.ok) throw new Error(opened.reason);
  let a: AttemptRecord = opened.attempt;
  const path: Stage[] = ["barrier", "stopping", "snapshotted", "installing", "trial", "proving", "committing"];
  for (const s of path.slice(0, path.indexOf(stage) + 1)) {
    a = advance(home, a, s);
    if (s === "trial") { a = planGeneration(home, a, "trial", TRIAL.nonce); a = ackGeneration(home, a, TRIAL.nonce, TRIAL.pid, { dead: opts.trialDead }); }
  }
  return { home, attempt: a };
}

function trialFleet(stage: Stage = "trial", opts: { listening?: boolean; adapters?: { total: number; connected: number }; nonce?: string } = {}) {
  const { home, attempt } = attemptAt(stage);
  const outbox = new DeliveryOutbox(join(home, "delivery-outbox.db"), "mgr"); outboxes.push(outbox);
  const fm = Object.create(FleetManager.prototype) as any;
  const scheduler = { setQuiescence: vi.fn(), scheduleInRun: () => false, db: { board: { setQuiescence: vi.fn() } } };
  Object.assign(fm, {
    dataDir: home, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, shuttingDown: false, startupComplete: true,
    fleetConfig: { instances: { worker: {} } }, deliveryOutbox: outbox, scheduler, quiescence: null, tmuxHold: null,
    healthServerListening: opts.listening ?? true, updateBarrier: null, updateHandbackWalkedAt: -Infinity, updateTrial: null,
    updateControlSelf: () => ({ nonce: opts.nonce ?? TRIAL.nonce, pid: TRIAL.pid }), updateSenderLive: () => true,
    getFleetHealth: () => ({ adapters: { total: opts.adapters?.total ?? 1, connected: opts.adapters?.connected ?? 1 } }),
  });
  return { home, fm, outbox, scheduler, attempt };
}
/** The trial's start: detection by its nonce, then the hold. */
const startTrial = (f: ReturnType<typeof trialFleet>, nonce = TRIAL.nonce) => { f.fm.updateTrial = f.fm.detectUpdateTrial(nonce); f.fm.armUpdateTrial(); };
/** The updater's proof, the trial serving its mailbox during the driver's (injected) sleep. */
const prove = (f: ReturnType<typeof trialFleet>, trial = TRIAL, timeoutMs = 2000) => {
  let t = 0;
  return proveTrial(f.home, f.attempt, trial, { from: DRIVER, timeoutMs, askMs: 1000, pollMs: 250, now: () => t, sleep: ms => { t += ms; f.fm.updateControlTick(); } });
};

describe("M-3770 2.5 wiring part 3: trial mode is chosen by the journal", () => {
  it("the open attempt's trial generation, in trial or proving, is a trial; its hold is the start's hold", () => {
    for (const stage of ["trial", "proving"] as const) {
      const f = trialFleet(stage);
      expect(f.fm.detectUpdateTrial(TRIAL.nonce)).toEqual({ attemptId: ID, nonce: TRIAL.nonce, detail: "Updating: checking the new version" });
    }
    const f = trialFleet();
    startTrial(f);
    expect(f.fm.startHold()).toEqual(f.fm.updateTrial);
  });

  it("anything else starts as it would have: the old generation, a voided trial, another stage, a closed attempt, no nonce", () => {
    expect(trialFleet().fm.detectUpdateTrial(OLD.nonce)).toBeNull();
    expect(trialFleet().fm.detectUpdateTrial("")).toBeNull();
    expect(trialFleet().fm.detectUpdateTrial("c".repeat(32))).toBeNull();
    expect(trialFleet("committing").fm.detectUpdateTrial(TRIAL.nonce)).toBeNull();
    const { home } = attemptAt("trial", { trialDead: true });
    expect(Object.assign(Object.create(FleetManager.prototype), { dataDir: home }).detectUpdateTrial(TRIAL.nonce)).toBeNull();
    const closed = trialFleet("proving");
    finish(closed.home, advance(closed.home, closed.attempt, "rolling-back"), { kind: "rolled-back", reason: "test" });
    expect(closed.fm.detectUpdateTrial(TRIAL.nonce)).toBeNull();
  });

  it("a trial starts no agent: startInstance is refused with the hold's reason", async () => {
    const f = trialFleet();
    startTrial(f);
    await expect(f.fm.startInstance("worker", {}, true)).rejects.toThrow("Updating: checking the new version");
  });
});

describe("M-3770 2.5 wiring part 3: the trial's hold", () => {
  it("is armed at the start on every gate, and continues the attempt's ONE inbox sequence after the old fleet's last file", () => {
    const f = trialFleet();
    // The old fleet held two things (a reference and a copy) before it was stopped.
    const old = new QuiescenceBarrier(f.home);
    const opened = { ...f.attempt, stage: "opened" as const };
    old.bind(opened);
    expect(old.secondCheck({ pin: false, inPause: false, startupComplete: true, shuttingDown: false, reconcileInFlight: false, anotherClaim: false,
      scheduleInRun: false, outboxInFlight: false, agents: [], pending: [{ deliveryId: "d-old", createdSeq: 1 }] })).toBe("held");
    expect(old.commitTurn(turn("held by old"), "worker")).toBe(true);
    startTrial(f);
    const barrier = f.fm.updateBarrier.barrier;
    expect(barrier.armed()).toBe(true);
    expect(f.fm.quiescence).toBe(barrier);
    expect(f.scheduler.setQuiescence).toHaveBeenLastCalledWith(barrier);
    expect(f.scheduler.db.board.setQuiescence).toHaveBeenLastCalledWith(barrier);
    expect((f.outbox as unknown as { quiescence: unknown }).quiescence).toBe(barrier);
    // A web or adapter turn for an agent is journaled as a copy (seq 3), never sent; an occurrence is deferred (seq 4).
    expect(f.fm.holdPaneSend("worker", turn("arrived in trial"))).toBe(true);
    expect(barrier.holdSchedule("s1", "r1")).toBe(true);
    const entries = listHandback(f.home, ID);
    expect(entries.map(e => [e.seq, e.kind === "inbox" ? e.item.kind : e.kind])).toEqual([[1, "reference"], [2, "copy"], [3, "copy"], [4, "deferred"]]);
    expect(entries[2]!.kind === "inbox" && entries[2]!.item.kind === "copy" && (entries[2]!.item.body as { content: string }).content).toBe("arrived in trial");
  });

  it("durable outbox rows from before the trial just stay queued: claims are held and no reference is journaled", () => {
    const f = trialFleet();
    const row = f.outbox.admit({ operationId: "o", sourceKey: "k", sourceInstance: "peer", sourceDaemonBootId: "b", targetInstance: "worker",
      kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "durable", meta: {} } }).delivery;
    startTrial(f);
    const barrier = f.fm.updateBarrier.barrier;
    expect(barrier.holdOutboxClaim(row.deliveryId, row.createdSeq)).toBe(true);
    barrier.noteAdmission(row.deliveryId, row.createdSeq);
    expect(listHandback(f.home, ID)).toEqual([]);
    expect(f.outbox.get(row.deliveryId)?.state).toBe("queued");
  });

  it("is only for trial or proving, and never armed twice", () => {
    const { home, attempt } = attemptAt("installing");
    expect(() => new QuiescenceBarrier(home).armTrial(attempt)).toThrow("a trial holds in trial or proving, not installing");
    const t = attemptAt("trial");
    const b = new QuiescenceBarrier(t.home);
    b.armTrial(t.attempt);
    expect(() => b.armTrial(t.attempt)).toThrow("the fence is already up");
  });

  it("a trial whose attempt closed before its hold is armed stays held (no agents), unproven", () => {
    const f = trialFleet("proving");
    f.fm.updateTrial = f.fm.detectUpdateTrial(TRIAL.nonce);
    finish(f.home, advance(f.home, f.attempt, "rolling-back"), { kind: "rolled-back", reason: "test" });
    f.fm.armUpdateTrial();
    expect(f.fm.updateBarrier).toBeNull();
    expect(f.fm.startHold()).not.toBeNull();
  });
});

describe("M-3770 2.5 wiring part 3: trial.prove", () => {
  it("a healthy trial proves itself: its nonce and pid, no problems; a disconnected adapter is informational only", () => {
    const f = trialFleet("proving", { adapters: { total: 2, connected: 0 } });
    startTrial(f);
    expect(prove(f)).toEqual({ ok: true });
    expect(f.fm.proveUpdateTrial(f.attempt, TRIAL)).toEqual({ status: "ok",
      value: { nonce: TRIAL.nonce, pid: TRIAL.pid, healthy: true, problems: [], adapters: { total: 2, connected: 0 } } });
  });

  it("unhealthy until the bound: the last problems are the reason", () => {
    const f = trialFleet("proving", { listening: false });
    startTrial(f);
    f.fm.startupComplete = false;
    expect(prove(f)).toEqual({ ok: false, reason: "the trial fleet isn't healthy: the web listener isn't listening; startup has not completed" });
  });

  it("becomes healthy within the bound: proven", () => {
    const f = trialFleet("proving");
    startTrial(f);
    f.fm.startupComplete = false;
    let passes = 0;
    const tick = f.fm.updateControlTick.bind(f.fm);
    f.fm.updateControlTick = () => { if (++passes === 6) f.fm.startupComplete = true; tick(); };
    expect(prove(f, TRIAL, 10_000)).toEqual({ ok: true });
  });

  it("the hold being down, or no scheduler on a topic-mode fleet, or no outbox, is unhealthy", () => {
    const f = trialFleet("proving");
    startTrial(f);
    f.fm.setUpdateBarrier(null);
    f.fm.deliveryOutbox = null;
    f.fm.scheduler = null;
    f.fm.fleetConfig = { instances: {}, channel: { type: "discord", mode: "topic" } };
    const r = f.fm.proveUpdateTrial(f.attempt, TRIAL);
    expect(r.value.problems).toEqual(["the delivery outbox isn't open", "the scheduler isn't running", "the trial's hold isn't up"]);
    // A barrier for this attempt that isn't armed is no hold either.
    const g = trialFleet("proving");
    startTrial(g);
    const unarmed = new QuiescenceBarrier(g.home);
    unarmed.bind(g.attempt);
    g.fm.setUpdateBarrier({ attemptId: ID, barrier: unarmed });
    expect(g.fm.proveUpdateTrial(g.attempt, TRIAL).value.problems).toEqual(["the trial's hold isn't up"]);
  });

  it("the stage must be proving: a proof asked in trial is refused, and the updater fails at once", () => {
    const f = trialFleet("trial");
    startTrial(f);
    let t = 0;
    const r = proveTrial(f.home, f.attempt, TRIAL, { from: DRIVER, timeoutMs: 5000, now: () => t, sleep: ms => { t += ms; f.fm.updateControlTick(); } });
    expect(r).toEqual({ ok: false, reason: "the trial refused the proof (refused): trial.prove isn't valid in trial (the request was for proving)" });
    // Asked for trial while in trial: still not the op's stage.
    let u = 0;
    const asked = askFleet(f.home, { seq: 9, op: "trial.prove", attemptId: ID, stage: "trial", to: { nonce: TRIAL.nonce }, from: DRIVER },
      { timeoutMs: 1000, pollMs: 250, now: () => u, sleep: ms => { u += ms; f.fm.updateControlTick(); } });
    expect(asked.ok && asked.response.result).toEqual({ status: "refused", why: "trial.prove isn't valid in trial (the request was for trial)" });
  });

  it("only the trial generation answers: a fleet that isn't the trial refuses, another nonce is ignored, another pid is rejected", () => {
    const f = trialFleet("proving");
    startTrial(f);
    // Asked as the trial but recorded with another pid: the fleet itself refuses.
    expect(f.fm.proveUpdateTrial(f.attempt, { nonce: TRIAL.nonce, pid: 9999 })).toEqual({ status: "refused", why: `the trial was acknowledged as pid ${TRIAL.pid}, not 9999` });
    // A fleet that isn't in trial mode (no updateTrial) refuses.
    const g = trialFleet("proving");
    expect(g.fm.proveUpdateTrial(g.attempt, TRIAL)).toEqual({ status: "refused", why: "this fleet isn't the attempt's trial" });
    // Addressed to another generation's nonce: nobody answers; the bound runs out.
    expect(prove(f, { nonce: OLD.nonce, pid: TRIAL.pid })).toEqual({ ok: false, reason: "the fleet didn't answer request 2 (trial.prove) in time" });
    // The driver expects another pid than the one that answers.
    expect(prove(f, { nonce: TRIAL.nonce, pid: 7777 })).toEqual({ ok: false, reason: `the trial's answer came from pid ${TRIAL.pid}, not 7777` });
  });
});

describe("M-3770 2.5 wiring part 3: the trial admits nothing durable (Fable (a))", () => {
  const row = (key: string) => ({ operationId: key, sourceKey: key, sourceInstance: "peer", sourceDaemonBootId: "b", targetInstance: "worker",
    kind: "fleet_inbound", payload: { type: "fleet_inbound", content: key, meta: {} } });

  it("the outbox refuses an admission with a retryable error while the trial holds, writes nothing, and admits it once the hold is down", () => {
    const f = trialFleet();
    startTrial(f);
    let caught: unknown;
    try { f.outbox.admit(row("during-trial")); } catch (err) { caught = err; }
    expect(caught).toMatchObject({ code: "update-trial", retryAfterMs: 10_000, message: "AgEnD is updating; try again shortly" });
    expect(f.outbox.listPending()).toEqual([]);
    expect(listHandback(f.home, ID)).toEqual([]);
    f.fm.setUpdateBarrier(null);                                                                     // leaveTrial's hold coming down
    expect(f.outbox.admit(row("during-trial")).inserted).toBe(true);
  });

  it("an old fleet's barrier still admits (and journals a reference): only the trial refuses", () => {
    const { home, attempt } = attemptAt("trial");
    const outbox = new DeliveryOutbox(join(home, "delivery-outbox.db"), "mgr"); outboxes.push(outbox);
    const old = new QuiescenceBarrier(home);
    old.bind({ ...attempt, stage: "opened" });
    expect(old.secondCheck({ pin: false, inPause: false, startupComplete: true, shuttingDown: false, reconcileInFlight: false, anotherClaim: false,
      scheduleInRun: false, outboxInFlight: false, agents: [], pending: [] })).toBe("held");
    outbox.setQuiescence(old);
    expect(old.refusesAdmission()).toBe(false);
    expect(outbox.admit(row("old")).inserted).toBe(true);
  });

  it("an HTTP caller gets 503 with Retry-After; any other error is not answered here", () => {
    const res = { headersSent: false, writeHead: vi.fn(), end: vi.fn() };
    const f = trialFleet();
    startTrial(f);
    let caught: unknown;
    try { f.outbox.admit(row("http")); } catch (err) { caught = err; }
    expect(FleetManager.answerUpdateTrialRefusal(caught, res as never)).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(503, { "Retry-After": "10" });
    expect(JSON.parse(res.end.mock.calls[0]![0])).toEqual({ error: "updating", detail: "AgEnD is updating; try again shortly" });
    expect(FleetManager.answerUpdateTrialRefusal(new Error("other"), { ...res, writeHead: vi.fn() } as never)).toBe(false);
  });

  it("nothing of the Hub starts in a trial (it keeps its deliveries and retries after the commit)", async () => {
    const f = trialFleet();
    startTrial(f);
    const created = vi.fn(async () => { throw new Error("must not start"); });
    Object.assign(f.fm, { hubEffectsReady: true, rawFleetConfig: { hub_member: { enabled: true } }, hubRuntime: null, hubRuntimeInit: null, hubRuntimeCreated: created });
    await f.fm.applyHubSwitches();
    expect(created).not.toHaveBeenCalled();
    f.fm.updateTrial = null;                                                                        // after leaveTrial
    await f.fm.applyHubSwitches().catch(() => undefined);
    expect(created).toHaveBeenCalled();
  });

  it("a trial without its hold takes no inbound (Fable (b)); with it, or outside a trial, adapters start", () => {
    const f = trialFleet("proving");
    f.fm.updateTrial = f.fm.detectUpdateTrial(TRIAL.nonce);
    expect(f.fm.updateTrialUnheld()).toBe(true);
    f.fm.armUpdateTrial();
    expect(f.fm.updateTrialUnheld()).toBe(false);
    f.fm.updateTrial = null;
    expect(f.fm.updateTrialUnheld()).toBe(false);
  });
});

