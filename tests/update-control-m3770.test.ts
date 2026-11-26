// M-3770 slice 2.5, wiring part 2 (design update-wiring-m3770.md §4, §10.2; Fable's mailbox rules): the control mailbox
// in the attempt's 0700 directory — bound to the attempt and its stage, a live sender, the addressed fleet, and answered
// exactly once. The driver's wait is synchronous: these tests serve the mailbox from the injected `sleep`, as a fleet
// polling every 250 ms would. No fleet runs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { advance, finish, newAttemptId, openAttempt, type AttemptRecord } from "../src/update-journal.js";
import { askFleet, controlDir, serveControl, type ControlRequest, type ControlResult, type ServeDeps } from "../src/update-control.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ID = newAttemptId(new Date("2026-11-27T12:00:00Z"), "c0c0c0c0");
const OLD = { nonce: "a".repeat(32), pid: 5100 };
const DRIVER = { pid: 4343, token: "t".repeat(32) };

function opened() {
  const home = mkdtempSync(join(tmpdir(), "control-")); dirs.push(home);
  const r = openAttempt(home, { id: ID, kind: "update", updater: { pid: DRIVER.pid, start: { processStart: "x" } },
    from: { name: "@songsid/agend", version: "2.5.0", integrity: null }, to: { name: "@songsid/agend", version: "2.5.1", integrity: null } });
  if (!r.ok) throw new Error(r.reason);
  return { home, attempt: r.attempt };
}
const req = (over: Partial<ControlRequest> = {}): ControlRequest => ({ seq: 1, op: "status", attemptId: ID, stage: "opened", to: { nonce: OLD.nonce }, from: DRIVER, ...over });
function fleet(over: Partial<ServeDeps> = {}) {
  const calls: string[] = [];
  const deps: ServeDeps = {
    self: OLD, senderLive: s => s.pid === DRIVER.pid && s.token === DRIVER.token,
    handlers: {
      "status": (_r, a: AttemptRecord): ControlResult => { calls.push("status"); return { status: "ok", value: { pid: OLD.pid, stage: a.stage } }; },
      "barrier.arm": (): ControlResult => { calls.push("arm"); return { status: "ok", value: "held" }; },
    },
    ...over,
  };
  return { deps, calls };
}
/** The driver asks; the fleet answers during the driver's (injected) sleep. */
const ask = (home: string, r: ControlRequest, serve: () => void, timeoutMs = 1000) => {
  let t = 0;
  return askFleet(home, r, { timeoutMs, pollMs: 250, now: () => t, sleep: ms => { t += ms; serve(); } });
};

describe("M-3770 2.5 wiring part 2: the control mailbox", () => {
  it("a status request is answered once, by the addressed fleet, inside the attempt's control/ directory", () => {
    const { home } = opened();
    const f = fleet();
    const r = ask(home, req(), () => serveControl(home, f.deps));
    expect(r).toEqual({ ok: true, response: { seq: 1, op: "status", attemptId: ID, by: OLD, result: { status: "ok", value: { pid: OLD.pid, stage: "opened" } } } });
    expect(readdirSync(controlDir(home, ID)).sort()).toEqual(["00000001-status.req.json", "00000001.res.json"]);
    expect(serveControl(home, f.deps)).toBe(0);                                                      // answered already: not again
    expect(f.calls).toEqual(["status"]);
  });

  it("rule 1: a barrier arm that arrives after the attempt moved on (abandoning) is refused, and arms nothing", () => {
    const { home, attempt } = opened();
    advance(home, attempt, "abandoning", { note: "the updater gave up" });
    const f = fleet();
    const r = ask(home, req({ op: "barrier.arm" }), () => serveControl(home, f.deps));
    expect(r.ok && r.response.result).toEqual({ status: "refused", why: "barrier.arm isn't valid in abandoning (the request was for opened)" });
    expect(f.calls).toEqual([]);
  });

  it("rule 1: once the attempt is closed the mailbox isn't even read", () => {
    const { home, attempt } = opened();
    mkdirSync(controlDir(home, ID), { recursive: true });
    writeFileSync(join(controlDir(home, ID), "00000001-barrier.arm.req.json"), JSON.stringify(req({ op: "barrier.arm" })));
    const closing = advance(home, attempt, "abandoning");
    finish(home, closing, { kind: "abandoned", reason: "test" });
    const f = fleet();
    expect(serveControl(home, f.deps)).toBe(0);
    expect(existsSync(join(controlDir(home, ID), "00000001.res.json"))).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("rule 1: a request naming another attempt, found in this attempt's mailbox, is refused and runs nothing", () => {
    const { home } = opened();
    const dir = controlDir(home, ID);
    mkdirSync(dir, { recursive: true });
    const other = newAttemptId(new Date("2026-11-27T13:00:00Z"), "d1d1d1d1");
    writeFileSync(join(dir, "00000001-barrier.arm.req.json"), JSON.stringify(req({ op: "barrier.arm", attemptId: other })));
    const f = fleet();
    expect(serveControl(home, f.deps)).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "00000001.res.json"), "utf8")).result).toEqual({ status: "refused", why: `attempt ${other} isn't open` });
    expect(f.calls).toEqual([]);
  });

  it("rule 2: a request from a sender that no longer holds the update's service lock is answered stale and never runs", () => {
    const { home } = opened();
    const f = fleet({ senderLive: () => false });
    const r = ask(home, req({ op: "barrier.arm" }), () => serveControl(home, f.deps));
    expect(r.ok && r.response.result).toEqual({ status: "stale", why: `the sender (pid ${DRIVER.pid}) no longer holds the update's service lock` });
    expect(f.calls).toEqual([]);
  });

  it("rule 3: a request addressed to another generation is ignored (no answer); the driver times out, never assuming success", () => {
    const { home } = opened();
    const f = fleet();
    const r = ask(home, req({ to: { nonce: "b".repeat(32) } }), () => serveControl(home, f.deps), 500);
    expect(r).toEqual({ ok: false, reason: "the fleet didn't answer request 1 (status) in time" });
    expect(f.calls).toEqual([]);
  });

  it("rule 3: an answer from another generation is rejected by the driver", () => {
    const { home } = opened();
    const imposter = fleet({ self: { nonce: OLD.nonce, pid: 9999 } });
    const dir = controlDir(home, ID);
    const r = ask(home, req(), () => {
      // A different fleet answers under the addressed nonce's file name but with its own nonce in `by`.
      if (!existsSync(join(dir, "00000001.res.json"))) writeFileSync(join(dir, "00000001.res.json"), JSON.stringify({ seq: 1, op: "status", attemptId: ID, by: { nonce: "c".repeat(32), pid: 9999 }, result: { status: "ok", value: null } }));
    });
    expect(r).toEqual({ ok: false, reason: "the answer to request 1 isn't from the fleet it was sent to" });
    expect(imposter.calls).toEqual([]);
  });

  it("rule 4: an existing answer is never overwritten, and a fleet restarted mid-request answers from the durable request", () => {
    const { home } = opened();
    const dir = controlDir(home, ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "00000001-status.req.json"), JSON.stringify(req()));
    // The first fleet process died before answering; a restarted one finds the request and answers it.
    const restarted = fleet();
    expect(serveControl(home, restarted.deps)).toBe(1);
    const first = readFileSync(join(dir, "00000001.res.json"), "utf8");
    // A second pass (or another process) never rewrites it.
    writeFileSync(join(dir, "00000002-status.req.json"), JSON.stringify(req({ seq: 2 })));
    expect(serveControl(home, fleet().deps)).toBe(1);
    expect(readFileSync(join(dir, "00000001.res.json"), "utf8")).toBe(first);
    expect(restarted.calls).toEqual(["status"]);
  });

  it("unknown ops are refused; an oversized or malformed request is never read as one, and never answered", () => {
    const { home } = opened();
    const f = fleet();
    const r = ask(home, req({ op: "commit.startAgents" }), () => serveControl(home, f.deps));
    expect(r.ok && r.response.result).toEqual({ status: "refused", why: "unknown op commit.startAgents" });
    const dir = controlDir(home, ID);
    writeFileSync(join(dir, "00000009-status.req.json"), JSON.stringify({ ...req({ seq: 9 }), args: { pad: "x".repeat(5000) } }));
    writeFileSync(join(dir, "00000010-status.req.json"), "{ not json");
    writeFileSync(join(dir, "00000011-status.req.json"), JSON.stringify(req({ seq: 12 })));      // its name and seq disagree
    expect(serveControl(home, f.deps)).toBe(0);
    expect(readdirSync(dir).filter(n => n.endsWith(".res.json")).sort()).toEqual(["00000001.res.json"]);
    expect(f.calls).toEqual([]);
  });

  it("a request already sent (the same seq) isn't sent twice", () => {
    const { home } = opened();
    const f = fleet();
    expect(ask(home, req(), () => serveControl(home, f.deps)).ok).toBe(true);
    expect(ask(home, req(), () => serveControl(home, f.deps))).toEqual({ ok: false, reason: "request 1 was already sent" });
  });
});
