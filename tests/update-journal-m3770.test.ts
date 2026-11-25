// M-3770 slice 2.1a (design docs/design/update-transaction-m3770.md §2, §2.6, §7): the update attempt journal on a real
// temporary home, with a crash injected after every durable step; every reader state; the stage table; marks; the
// fleet's hand-back files and cancel; and recoveryPlan's table.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  advance, appendMark, attemptDir, canAdvance, consumeCancel, defaultJournalIo, finish, finishClosing, handbackAction, handbackSourceKey,
  isMarked, journalDir, listHandback, markHandback, newAttemptId, openAttempt, readCurrent, readMarks, recoveryPlan, substep,
  writeCancel, writeDeferred, writeInboxItem, type AttemptRecord, type JournalIo, type Stage,
} from "../src/update-journal.js";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const home = () => { const h = mkdtempSync(join(tmpdir(), "journal-")); homes.push(h); return h; };

/** The real I/O, crashing (throwing) right after the named durable step. */
const crashAfter = (step: string): JournalIo => ({ ...defaultJournalIo, step: name => { if (name === step) throw new Error(`crash after ${name}`); } });
const ID1 = newAttemptId(new Date("2026-11-26T01:02:03.456Z"), "0a1b2c3d");
const ID2 = newAttemptId(new Date("2026-11-26T01:02:04Z"), "deadbeef");
const init = (id = ID1) => ({ id, kind: "update" as const, updater: { pid: 4242, start: { processStart: "Thu Nov 26 01:00:00 2026" } },
  from: { name: "@songsid/agend", version: "2.4.0", integrity: "sha512-old" }, to: { name: "@songsid/agend", version: "2.4.1", integrity: "sha512-new" } });
const opened = (h: string, id = ID1) => { const r = openAttempt(h, init(id)); if (!r.ok) throw new Error(r.reason); return r.attempt; };
const walk = (h: string, a: AttemptRecord, stages: Stage[]) => stages.reduce((x, s) => advance(h, x, s), a);

describe("M-3770 2.1a: attempt ids", () => {
  it("are time-sortable UTC stamps with 8 hex digits", () => {
    expect(ID1).toBe("20261126T010203Z-0a1b2c3d");
    expect([ID2, ID1].sort()).toEqual([ID1, ID2]);
    expect(() => newAttemptId(new Date(), "XYZ")).toThrow();
  });
});

describe("M-3770 2.1a: publication order and the readers (§2.4, §2.5)", () => {
  it("open writes the record, then current: a crash between them leaves no attempt (an orphan directory is never acted on)", () => {
    const h = home();
    expect(() => openAttempt(h, init(), crashAfter("record-written"))).toThrow(/crash/);
    expect(existsSync(join(attemptDir(h, ID1), "attempt.json"))).toBe(true);
    expect(readCurrent(h)).toEqual({ state: "none" });
    const second = openAttempt(h, init(ID2));
    expect(second.ok).toBe(true);
    expect(readCurrent(h)).toMatchObject({ state: "open", attempt: { id: ID2, stage: "opened" } });
  });

  it("only an absent current is none; anything present that can't be read is unknown", () => {
    const h = home();
    expect(readCurrent(h)).toEqual({ state: "none" });
    mkdirSync(journalDir(h), { recursive: true });
    writeFileSync(join(journalDir(h), "current"), "not an id\n");
    expect(readCurrent(h)).toMatchObject({ state: "unknown", reason: "current names no attempt" });
    writeFileSync(join(journalDir(h), "current"), `${ID1}\n`);
    expect(readCurrent(h)).toMatchObject({ state: "unknown", reason: "current names an attempt with no record" });
    mkdirSync(attemptDir(h, ID1), { recursive: true });
    writeFileSync(join(attemptDir(h, ID1), "attempt.json"), "{ not json");
    expect(readCurrent(h)).toMatchObject({ state: "unknown", reason: "the attempt record isn't valid" });
    writeFileSync(join(attemptDir(h, ID1), "attempt.json"), JSON.stringify({ schema: 1, id: ID2, stage: "opened", history: [], updater: { pid: 1, start: { processStart: "x" } } }));
    expect(readCurrent(h).state).toBe("unknown");                                                // a record for another id
    expect(openAttempt(h, init(ID2))).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown/) });
  });

  it("a crash after the terminal record but before current is cleared reads closing; finishing it, or the next open, clears it", () => {
    const h = home();
    const a = walk(h, opened(h), ["abandoning"]);
    expect(() => finish(h, a, { kind: "abandoned", reason: "cancelled" }, crashAfter("terminal-abandoned"))).toThrow(/crash/);
    const read = readCurrent(h);
    expect(read).toMatchObject({ state: "closing", attempt: { stage: "abandoned", outcome: { kind: "abandoned" } } });
    expect(recoveryPlan(read, "gone")).toEqual({ kind: "finish-closing", attemptId: ID1 });
    if (read.state === "closing") finishClosing(h, read.attempt);
    expect(readCurrent(h)).toEqual({ state: "none" });
    expect(existsSync(join(attemptDir(h, ID1), "current.closed"))).toBe(true);
    // And an open over a closing journal finishes it first.
    const b = walk(h, opened(h, ID2), ["abandoning"]);
    expect(() => finish(h, b, { kind: "abandoned" }, crashAfter("terminal-abandoned"))).toThrow(/crash/);
    const third = newAttemptId(new Date("2026-11-26T02:00:00Z"), "00000003");
    expect(openAttempt(h, init(third))).toMatchObject({ ok: true });
  });

  it("manual-recovery keeps current: the journal reads manual until a person resolves it", () => {
    const h = home();
    const a = walk(h, opened(h), ["barrier", "stopping", "snapshotted", "installing"]);
    finish(h, a, { kind: "manual-recovery", reason: "ownership unknown" });
    expect(readCurrent(h)).toMatchObject({ state: "manual", attempt: { stage: "manual-recovery" } });
    expect(openAttempt(h, init(ID2))).toMatchObject({ ok: false });
  });
});

describe("M-3770 2.1a: the stage table (§2.3)", () => {
  it("allows the designed path and refuses every other move; terminal stages only through finish()", () => {
    const h = home();
    let a = walk(h, opened(h), ["barrier", "stopping", "snapshotted", "installing", "trial", "proving", "committing"]);
    expect(a.history.map(x => x.stage)).toEqual(["opened", "barrier", "stopping", "snapshotted", "installing", "trial", "proving", "committing"]);
    expect(() => advance(h, a, "rolling-back")).toThrow(/not allowed/);                         // never roll back after agents started
    expect(() => advance(h, a, "committed")).toThrow(/finish/);
    a = finish(h, a, { kind: "committed" });
    expect(readCurrent(h)).toEqual({ state: "none" });
    expect(() => advance(h, a, "barrier")).toThrow(/not allowed/);
    expect(canAdvance("snapshotted", "abandoning")).toBe(false);                                // after the snapshot: roll back, never abandon
    expect(canAdvance("stopping", "abandoning")).toBe(true);
    expect(canAdvance("trial", "manual-recovery")).toBe(true);
    expect(canAdvance("committed", "manual-recovery")).toBe(false);
  });

  it("substeps are journaled inside a stage and cleared by the next stage", () => {
    const h = home();
    let a = walk(h, opened(h), ["abandoning"]);
    a = substep(h, a, "restart-old");
    a = substep(h, a, "hand-back");
    expect(readCurrent(h)).toMatchObject({ state: "open", attempt: { stage: "abandoning", substep: "hand-back" } });
    expect(recoveryPlan(readCurrent(h), "gone")).toEqual({ kind: "resume-abandoning", attemptId: ID1, substep: "hand-back" });
    a = finish(h, a, { kind: "abandoned" });
    expect(a.substep).toBeUndefined();
  });
});

describe("M-3770 2.1a: marks (§2.4 terminal, §2.5)", () => {
  it("a rollback's mark lands before its terminal record; a retry after a crash between them adds no second mark", () => {
    const h = home();
    const a = walk(h, opened(h), ["barrier", "stopping", "snapshotted", "installing", "rolling-back"]);
    expect(() => finish(h, a, { kind: "rolled-back" }, crashAfter("mark-written"))).toThrow(/crash/);
    expect(readCurrent(h)).toMatchObject({ state: "open", attempt: { stage: "rolling-back" } });
    expect(isMarked(h, { version: "2.4.1", integrity: "sha512-new" })).toBe(true);
    finish(h, a, { kind: "rolled-back" });
    const marks = readMarks(h);
    expect(marks.ok && marks.marks.map(m => m.attemptId)).toEqual([ID1]);
    expect(readCurrent(h)).toEqual({ state: "none" });
    expect(isMarked(h, { version: "2.4.1", integrity: "sha512-other" })).toBe(false);
  });

  it("unreadable marks are unknown, never 'no marks', and nothing is written over them", () => {
    const h = home();
    mkdirSync(journalDir(h), { recursive: true });
    writeFileSync(join(journalDir(h), "marks.json"), "[{ broken");
    expect(isMarked(h, { version: "2.4.1", integrity: null })).toBe("unknown");
    expect(() => appendMark(h, { version: "2.4.1", integrity: null, attemptId: ID1 })).toThrow(/can't be read/);
    expect(readFileSync(join(journalDir(h), "marks.json"), "utf8")).toBe("[{ broken");
  });
});

describe("M-3770 2.1a: the fleet's files (§2.6)", () => {
  it("inbox items and deferred jobs share one sequence, handed back in that order with their acks and starts", () => {
    const h = home();
    opened(h);
    writeInboxItem(h, ID1, 1, "outbox", { kind: "reference", deliveryId: "d-1", createdSeq: 41 });
    writeDeferred(h, ID1, 2, { scheduleId: "s-1", runId: "r-1" });
    writeInboxItem(h, ID1, 3, "web", { kind: "copy", body: { text: "hi" } });
    writeDeferred(h, ID1, 4, { scheduleId: "s-2", runId: "r-2" });
    let list = listHandback(h, ID1);
    expect(list.map(e => [e.seq, e.kind, handbackAction(e)])).toEqual([
      [1, "inbox", "claim"], [2, "deferred", "run"], [3, "inbox", "admit-then-claim"], [4, "deferred", "run"]]);
    markHandback(list[0]!, "acked");
    markHandback(list[1]!, "started");                                                          // a crash after the start, before the run
    list = listHandback(h, ID1);
    expect(list.map(e => handbackAction(e))).toEqual(["skip", "record-interrupted", "admit-then-claim", "run"]);   // at most once
    expect(() => markHandback(list[0]!, "started")).toThrow(/only a deferred job/);
    expect(handbackSourceKey(ID1, 3)).toBe(`update-handback:${ID1}:000000000003`);
    expect(readdirSync(join(attemptDir(h, ID1), "inbox")).sort()).toEqual(["000000000001-outbox.json", "000000000001-outbox.json.acked", "000000000003-web.json"]);
  });

  it("an item that can't be read, or two items with one sequence number, stop the walk (never skipped)", () => {
    const h = home();
    opened(h);
    writeInboxItem(h, ID1, 1, "hub", { kind: "copy", body: 1 });
    writeDeferred(h, ID1, 1, { scheduleId: "s", runId: "r" });
    expect(() => listHandback(h, ID1)).toThrow(/share a sequence/);
    const g = home();
    opened(g);
    mkdirSync(join(attemptDir(g, ID1), "inbox"), { recursive: true });
    writeFileSync(join(attemptDir(g, ID1), "inbox", "000000000005-adapter.json"), "{\"kind\":\"reference\"}");
    expect(() => listHandback(g, ID1)).toThrow(/isn't valid/);
  });

  it("a cancel is honoured through stopping without a snapshot, and set aside as too late after it", () => {
    const cases: Array<[Stage[], boolean, string]> = [
      [[], false, "honoured"], [["barrier"], false, "honoured"], [["barrier", "stopping"], false, "honoured"],
      [["barrier", "stopping"], true, "too-late"], [["barrier", "stopping", "snapshotted", "installing", "trial"], true, "too-late"],
      [["barrier", "stopping", "snapshotted", "installing", "trial", "proving", "committing"], true, "too-late"]];
    for (const [stages, snapshot, want] of cases) {
      const h = home();
      const a = walk(h, opened(h), stages);
      expect(consumeCancel(h, a, snapshot)).toBe("none");
      writeCancel(h, ID1, { reason: "the admin cancelled", by: "admin" });
      expect(consumeCancel(h, a, snapshot)).toBe(want);
      const files = readdirSync(attemptDir(h, ID1));
      expect(files).toContain(want === "honoured" ? "cancel.consumed" : `cancel.ignored-${a.stage}`);
      expect(files).not.toContain("cancel");
    }
  });
});

describe("M-3770 2.1a: recoveryPlan (§7)", () => {
  it("covers every row: none, unknown, manual, closing, live, unknown updater, and each stage with a gone updater", () => {
    expect(recoveryPlan({ state: "none" }, "gone")).toEqual({ kind: "start" });
    expect(recoveryPlan({ state: "unknown", reason: "x", path: "p" }, "gone")).toEqual({ kind: "refuse", reason: "unknown" });
    const h = home();
    const a = opened(h);
    const open = (stage: Stage, sub?: string) => ({ state: "open" as const, attempt: { ...a, stage, ...(sub ? { substep: sub } : {}) } });
    expect(recoveryPlan(open("trial"), "live")).toMatchObject({ kind: "refuse", reason: "in-progress", stage: "trial" });
    expect(recoveryPlan(open("trial"), "live", true)).toEqual({ kind: "start" });                // the attempt's own planned start
    expect(recoveryPlan(open("trial"), "unknown")).toMatchObject({ kind: "refuse", reason: "updater-unknown" });
    for (const s of ["opened", "barrier", "stopping", "abandoning"] as Stage[]) expect(recoveryPlan(open(s), "gone").kind).toBe("resume-abandoning");
    for (const s of ["snapshotted", "installing", "trial", "proving", "rolling-back"] as Stage[]) expect(recoveryPlan(open(s, "pkg-staged"), "gone")).toEqual({ kind: "resume-rolling-back", attemptId: ID1, substep: "pkg-staged" });
    expect(recoveryPlan(open("committing", "deliver-inbox"), "gone")).toEqual({ kind: "resume-committing", attemptId: ID1, substep: "deliver-inbox" });
    expect(recoveryPlan({ state: "manual", attempt: { ...a, stage: "manual-recovery" } }, "gone")).toMatchObject({ kind: "refuse", reason: "manual" });
  });
});
