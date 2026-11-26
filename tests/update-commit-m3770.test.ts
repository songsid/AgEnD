// M-3770 slice 2.5, wiring part 4 (design update-wiring-m3770.md §5, §7, §13): the commit hands. The new fleet — the
// trial, asked over its mailbox by the updater, or a start that resumes an interrupted commit, from its own control pass —
// leaves the trial (admissions open, tmux set up, the Hub), starts the agents, delivers the attempt's ONE inbox in order
// (the hold comes down in the same turn; its own copies keep their receipts, the rest are stripped) and runs the held
// occurrences. The fleet is a FleetManager prototype with only the state these paths read; nothing is started.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { FleetManager } from "../src/fleet-manager.js";
import { commitHandsOverMailbox } from "../src/update-control.js";
import { ackGeneration, advance, listHandback, newAttemptId, openAttempt, planGeneration, readCurrent, substep, writeDeferred,
  writeInboxItem, type AttemptRecord, type Stage } from "../src/update-journal.js";
import { QuiescenceBarrier } from "../src/update-quiescence.js";

const dirs: string[] = [], outboxes: DeliveryOutbox[] = [];
afterEach(() => { for (const o of outboxes.splice(0)) o.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ID = newAttemptId(new Date("2026-11-27T16:00:00Z"), "c1c1c1c1");
const OLD = { nonce: "a".repeat(32), pid: 5100 };
const TRIAL = { nonce: "b".repeat(32), pid: process.pid };
const DRIVER = { pid: 4343, token: "t".repeat(32) };
const turn = (text: string, receipt?: string) => ({ type: "fleet_inbound", content: text,
  meta: { chat_id: "c1", message_id: text, user: "u", ...(receipt ? { human_receipt_id: receipt } : {}) } });

/** An attempt walked to `stage` (its trial acknowledged from trial on), with an ownership `identityOf` accepts. */
function attemptAt(stage: Stage) {
  const home = mkdtempSync(join(tmpdir(), "commit-")); dirs.push(home);
  const o = { uid: 1000, home, prefix: join(home, "p"), packagePath: join(home, "p", "pkg"), service: null,
    binLinks: { agend: join(home, "p", "bin", "agend"), "agend-agent": join(home, "p", "bin", "agend-agent") } };
  const tuple = { version: "2.5.0", integrity: null, bins: { agend: null, "agend-agent": null }, entry: "/e", interpreter: "/n", execStart: null };
  const opened = openAttempt(home, { id: ID, kind: "update", updater: { pid: DRIVER.pid, start: { processStart: "x" } },
    from: { name: "@songsid/agend", version: "2.5.0", integrity: null }, to: { name: "@songsid/agend", version: "2.5.1", integrity: null },
    extra: { ownership: o, expected: { old: tuple }, fleets: [{ gen: "old", nonce: OLD.nonce, pid: OLD.pid, plannedAt: new Date().toISOString(), consumed: true }] } });
  if (!opened.ok) throw new Error(opened.reason);
  let a: AttemptRecord = opened.attempt;
  const path: Stage[] = ["barrier", "stopping", "snapshotted", "installing", "trial", "proving", "committing"];
  for (const s of path.slice(0, path.indexOf(stage) + 1)) {
    a = advance(home, a, s);
    if (s === "trial") { a = planGeneration(home, a, "trial", TRIAL.nonce); a = ackGeneration(home, a, TRIAL.nonce, TRIAL.pid); }
  }
  return { home, attempt: a };
}

function newFleet(home: string) {
  const outbox = new DeliveryOutbox(join(home, "delivery-outbox.db"), "mgr"); outboxes.push(outbox);
  const fm = Object.create(FleetManager.prototype) as any;
  const scheduler = { setQuiescence: vi.fn(), scheduleInRun: () => false, runDeferredOccurrence: vi.fn(() => "ran"), recordInterruptedOccurrence: vi.fn(),
    db: { board: { setQuiescence: vi.fn() } } };
  const calls: string[] = [];
  Object.assign(fm, {
    dataDir: home, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, shuttingDown: false, startupComplete: true,
    fleetConfig: { instances: { general: { general_topic: true }, worker: {} } }, deliveryOutbox: outbox, scheduler, quiescence: null, tmuxHold: null,
    healthServerListening: true, updateBarrier: null, updateHandbackWalkedAt: -Infinity, updateTrial: null, updateHoldAttemptId: null,
    updateCommitRuns: new Map(), updateResume: null, updateTrialLeaving: false, managerBootId: "mgr", scheduleDeliveryOutboxPump: vi.fn(),
    updateControlSelf: () => TRIAL, updateSenderLive: () => true,
    // What leaving the trial and starting the agents do, as stand-ins (no tmux, no agents).
    setUpFleetTmuxServer: async () => { calls.push("tmux-server"); }, startTmuxControlClient: () => { calls.push("control-client"); },
    cleanUpFleetTmuxWindows: async () => { calls.push("tmux-windows"); }, observeHubSwitches: () => { calls.push("hub"); },
    startInstance: async (name: string) => { calls.push(`start:${name}`); },
    startInstancesWithConcurrency: async (entries: [string, unknown][]) => { calls.push(`start-rest:${entries.map(([n]) => n).join(",")}`); },
    announceUpdateCommitted: async () => { calls.push("ready-line"); }, classicChannels: { getAll: () => [] },
  });
  return { fm, outbox, scheduler, calls };
}
/** The trial's start, then the updater walks it to committing. */
function trialAtCommit() {
  const { home, attempt } = attemptAt("proving");
  const f = newFleet(home);
  f.fm.updateTrial = f.fm.detectUpdateTrial(TRIAL.nonce, null);
  f.fm.armUpdateTrial();
  const committing = advance(home, attempt, "committing");
  return { home, ...f, attempt: committing };
}
/** The updater's hands, the fleet serving its mailbox (and settling its async work) during the driver's sleep. */
async function hands(f: ReturnType<typeof trialAtCommit>) {
  let t = 0;
  const pending: Promise<void>[] = [];
  const h = commitHandsOverMailbox(f.home, ID, TRIAL, { from: DRIVER, askMs: 1000, pollMs: 250, boundsMs: { leaveTrial: 5000, startAgents: 5000, deliverInbox: 5000, runDeferred: 5000 },
    now: () => t, sleep: ms => { t += ms; f.fm.updateControlTick(); } });
  // The async steps settle on the microtask queue; a synchronous driver can't await them, so each hand runs twice:
  // once to start the step (it answers pending until its bound), then again after the microtasks ran.
  const run = async (step: keyof typeof h) => { if (h[step]()) return true; for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); return h[step](); };
  return { h, run, pending };
}

describe("M-3770 2.5 wiring part 4: the barrier through the commit", () => {
  it("leaving the trial opens admissions while the hold stays; a resumed commit holds without refusing; copies this barrier wrote are its own", () => {
    const { home, attempt } = attemptAt("proving");
    const b = new QuiescenceBarrier(home);
    b.armTrial(attempt);
    expect(b.refusesAdmission()).toBe(true);
    expect(b.commitTurn(turn("in trial"), "worker")).toBe(true);
    b.endTrial();
    expect(b.armed()).toBe(true);
    expect(b.refusesAdmission()).toBe(false);
    expect(b.commitTurn(turn("after leaving"), "worker")).toBe(true);
    expect([b.ownCopy(1), b.ownCopy(2), b.ownCopy(3)]).toEqual([true, true, false]);
    expect(() => new QuiescenceBarrier(home).armCommit(attempt)).toThrow("a resumed commit holds in committing, not proving");
    const c = attemptAt("committing");
    const r = new QuiescenceBarrier(c.home);
    r.armCommit(c.attempt);
    expect(r.armed() && !r.refusesAdmission()).toBe(true);
  });

  it("the inbox walk is committing's only, inbox entries only, in order; the occurrences are the second walk's", () => {
    const c = attemptAt("committing");
    writeInboxItem(c.home, ID, 1, "adapter", { kind: "copy", body: turn("old"), target: "worker" });
    writeDeferred(c.home, ID, 2, { scheduleId: "s1", runId: "r1" });
    writeInboxItem(c.home, ID, 3, "adapter", { kind: "copy", body: turn("trial"), target: "worker" });
    const admitted: string[] = [], ran: string[] = [];
    const ports = { log: vi.fn(), lookup: (id: string) => ({ state: "queued", target: "worker", id }), claim: () => "claimed" as const,
      admitCopy: (_k: string, body: unknown) => { admitted.push((body as { content: string }).content); return { deliveryId: `d${admitted.length}` }; },
      runDeferred: (job: { scheduleId: string }) => { ran.push(job.scheduleId); }, recordInterrupted: vi.fn() };
    const b = new QuiescenceBarrier(c.home);
    expect(b.runCommitInbox({ ...c.attempt, stage: "proving" }, ports, () => false)).toEqual({ walked: false, acked: 0 });
    expect(b.runCommitInbox(c.attempt, ports, () => false)).toEqual({ walked: true, acked: 2 });
    expect([admitted, ran]).toEqual([["old", "trial"], []]);
    expect(b.runCommitDeferred(c.attempt, ports)).toEqual({ walked: true, acked: 1 });
    expect(ran).toEqual(["s1"]);
    expect(listHandback(c.home, ID).every(e => e.acked)).toBe(true);
    expect(b.runCommitInbox(c.attempt, ports, () => false)).toEqual({ walked: true, acked: 0 });            // done: not again
  });
});

describe("M-3770 2.5 wiring part 4: the updater's commit hands over the mailbox", () => {
  it("in order: leave the trial (tmux, Hub, admissions), start the agents (General first), deliver the inbox (hold down in the same turn), run the occurrences", async () => {
    const f = trialAtCommit();
    // The old fleet held a turn with a receipt; the trial held one too (its own, this boot) and an occurrence.
    writeInboxItem(f.home, ID, 1, "adapter", { kind: "copy", body: turn("old", "hr-old"), target: "worker" });
    f.fm.updateBarrier.barrier.bind({ ...f.attempt, stage: "proving" });                              // reload the seq past the old file
    expect(f.fm.holdPaneSend("worker", turn("trial", "hr-trial"))).toBe(true);
    expect(f.fm.updateBarrier.barrier.holdSchedule("s1", "r1")).toBe(true);
    const { run } = await hands(f);
    expect(await run("leaveTrial")).toBe(true);
    expect(f.calls).toEqual(["tmux-server", "control-client", "tmux-windows", "hub"]);
    expect(f.fm.updateTrial).toBeNull();
    expect(f.fm.updateBarrier.barrier.armed() && !f.outbox.admissionsRefused()).toBe(true);
    expect(await run("startAgents")).toBe(true);
    expect(f.calls.slice(4)).toEqual(["start:general", "start-rest:worker", "ready-line"]);
    expect(await run("deliverInbox")).toBe(true);
    expect(f.fm.updateBarrier).toBeNull();
    expect(f.fm.quiescence).toBeNull();
    const copies = f.outbox.listPending().map(row => [row.payload.content, (row.payload.meta as Record<string, unknown>).human_receipt_id ?? null]);
    expect(copies).toEqual([["old", null], ["trial", "hr-trial"]]);                                  // the old fleet's is stripped
    expect(f.scheduler.runDeferredOccurrence).not.toHaveBeenCalled();
    expect(await run("runDeferred")).toBe(true);
    expect(f.scheduler.runDeferredOccurrence).toHaveBeenCalledWith("s1", "r1", expect.any(Function));
  });

  it("each step once: a re-ask after done answers done and does nothing again", async () => {
    const f = trialAtCommit();
    const { run } = await hands(f);
    expect(await run("leaveTrial")).toBe(true);
    expect(await run("leaveTrial")).toBe(true);
    expect(f.calls.filter(c => c === "tmux-server")).toHaveLength(1);
  });

  it("out of order is refused: agents before leaving the trial, occurrences before the inbox", async () => {
    const f = trialAtCommit();
    const { h } = await hands(f);
    expect(h.startAgents()).toBe(false);
    expect(h.runDeferred()).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.scheduler.runDeferredOccurrence).not.toHaveBeenCalled();
  });

  it("a failed async step runs again, whole, on the next ask; nothing after it starts until it succeeds", async () => {
    const f = trialAtCommit();
    let fail = true;
    f.fm.setUpFleetTmuxServer = async () => { f.calls.push("tmux-server"); if (fail) throw new Error("tmux said no"); };
    const { h, run } = await hands(f);
    expect(await run("leaveTrial")).toBe(false);
    expect(f.fm.updateTrial).toBeNull();                                                            // admissions are open
    expect(f.fm.updateTrialLeaving).toBe(true);                                                     // but tmux isn't set up
    expect(h.startAgents()).toBe(false);
    expect(f.calls.some(c => c.startsWith("start:"))).toBe(false);
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));                         // the last retry settles (failed)
    fail = false;
    expect(await run("leaveTrial")).toBe(true);
    expect(f.fm.updateTrialLeaving).toBe(false);
    expect(f.calls.filter(c => c === "tmux-server").length).toBeGreaterThanOrEqual(2);
    expect(f.calls.slice(-3)).toEqual(["control-client", "tmux-windows", "hub"]);
  });

  it("only in committing, and only the trial generation answers", async () => {
    const { home, attempt } = attemptAt("proving");
    const f = newFleet(home);
    f.fm.updateTrial = f.fm.detectUpdateTrial(TRIAL.nonce, null);
    f.fm.armUpdateTrial();
    expect(f.fm.updateCommitStep("leaveTrial", attempt)).toEqual({ status: "refused", why: "the attempt is proving, not committing" });
    const committing = advance(home, attempt, "committing");
    expect(f.fm.updateTrialGenerationIs(committing, { nonce: TRIAL.nonce, pid: 9999 })).toEqual({ status: "refused", why: `the trial was acknowledged as pid ${TRIAL.pid}, not 9999` });
    expect(f.fm.updateTrialGenerationIs(committing, OLD)).toEqual({ status: "refused", why: "this fleet isn't the attempt's trial" });
    f.fm.updateHoldAttemptId = null;
    expect(f.fm.updateCommitStep("leaveTrial", committing)).toEqual({ status: "refused", why: "this fleet isn't holding for this attempt" });
  });
});

describe("M-3770 2.5 wiring part 4: a start that resumes an interrupted commit (§7)", () => {
  it("holds as a trial would, then its own control pass finishes the commit: steps not yet journaled run, in order, and the attempt closes committed", async () => {
    const c = attemptAt("committing");
    let a = substep(c.home, c.attempt, "retained"); a = substep(c.home, a, "route-removed"); a = substep(c.home, a, "left-trial");
    writeInboxItem(c.home, ID, 1, "adapter", { kind: "copy", body: turn("held", "hr-before-crash"), target: "worker" });
    const f = newFleet(c.home);
    f.fm.updateTrial = f.fm.detectUpdateTrial("", ID);
    expect(f.fm.updateTrial).toMatchObject({ attemptId: ID, resume: true });
    f.fm.armUpdateTrial();
    expect(f.fm.updateBarrier.barrier.armed() && !f.outbox.admissionsRefused()).toBe(true);
    await f.fm.prepareUpdateResume();
    expect(f.fm.updateResume?.attemptId).toBe(ID);
    // left-trial was journaled by the process that died; this one starts held again, so it leaves its own hold first.
    for (let i = 0; i < 20 && readCurrent(c.home).state === "open"; i++) { f.fm.updateControlTick(); await new Promise(r => setTimeout(r, 0)); }
    expect(readCurrent(c.home).state).toBe("none");
    expect(f.calls).toEqual(["tmux-server", "control-client", "tmux-windows", "hub", "start:general", "start-rest:worker", "ready-line"]);
    // A copy from before the crash is another boot's: admitted stripped.
    expect(f.outbox.listPending().map(row => [row.payload.content, (row.payload.meta as Record<string, unknown>).human_receipt_id ?? null])).toEqual([["held", null]]);
    expect(f.fm.updateResume).toBeNull();
    expect(f.fm.updateBarrier).toBeNull();
    expect(a.history.at(-1)?.substep).toBe("left-trial");
  });

  it("every fleet step journaled before the crash: this process still does them (its hold comes down) and closes the commit", async () => {
    const c = attemptAt("committing");
    let a = c.attempt;
    for (const s of ["retained", "route-removed", "left-trial", "agents-started", "inbox-delivered", "deferred-run"]) a = substep(c.home, a, s);
    const f = newFleet(c.home);
    f.fm.updateTrial = f.fm.detectUpdateTrial("", ID);
    f.fm.armUpdateTrial();
    await f.fm.prepareUpdateResume();
    for (let i = 0; i < 20 && readCurrent(c.home).state === "open"; i++) { f.fm.updateControlTick(); await new Promise(r => setTimeout(r, 0)); }
    expect(readCurrent(c.home).state).toBe("none");
    expect(f.calls).toContain("start:general");
    expect(f.fm.updateBarrier).toBeNull();
  });

  it("a resume start only for the attempt the gate named, in committing", () => {
    const c = attemptAt("proving");
    const f = newFleet(c.home);
    expect(f.fm.detectUpdateTrial("", ID)).toBeNull();
    expect(f.fm.detectUpdateTrial("", newAttemptId(new Date(), "d2d2d2d2"))).toBeNull();
  });
});
