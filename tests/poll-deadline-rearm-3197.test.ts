/**
 * #3197 (regression on 2.3.5-beta.1): a 10 s poll, bound on time with no other poll open, closed 255 s late — when the
 * next poll's deadline swept. The one deadline timer was dropped at its own deadline:
 *  - Node fires a timer up to 1 ms before the Date.now() target it was armed for (measured: ~3.5% of timers). The sweep
 *    read `now` one millisecond short of the deadline (nothing due), then arm() read the clock again, already past it —
 *    and nextExpiry() looked only ahead, so the poll was in neither: no timer was left for it.
 *  - Likewise any arm() between a deadline and the sweep for it (another reply's bind while the loop is busy) replaced
 *    the pending timer and skipped the deadline that had just passed.
 * The real store (scratch sqlite) and controller; a wall clock and a recording timer under the test's control.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReplyButtonStore } from "../src/reply-buttons.js";
import { ReplyButtonsController } from "../src/reply-buttons-controller.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agend-3197r-"));
  const store = new ReplyButtonStore(join(dir, "buttons.db"));
  let wall = 1_000_000;
  /** Clock readings still to hand out before `wall` again: a sweep's first read lands before the ms boundary. */
  const reads: number[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const closed: string[] = [];
  const ctl = new ReplyButtonsController({
    store, now: () => reads.shift() ?? wall, monotonic: () => wall,
    adapterFor: () => ({ renderPoll: async () => {}, settleReplyButtons: async () => {} }) as never,
    mayClick: () => true, deliver: async () => true, publish: () => {},
    admitResults: () => true,
    logger: { info: (o, m) => { if (m === "Poll closed") closed.push((o as { set: string }).set); }, warn() {} },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
  });
  cleanup.push(() => { ctl.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const where = { instance: "quiz", adapterId: "dc", chatId: "guild", threadId: "room" };
  const poll = (message: string) => {
    const p = ctl.prepare(where, [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      { seconds: 10, multi: false, reveal: "close", showVoters: false, question: message });
    ctl.bind(p.id, message);
    return p.id;
  };
  const buttons = (message: string) => { const p = ctl.prepare(where, [{ label: "OK", value: "ok" }]); ctl.bind(p.id, message); return p.id; };
  /** Run the one deadline timer (there is only ever one besides poll ticks; this rig's adapter draws no ticks). */
  const fire = () => { const t = timers.shift(); if (!t) return false; t.fn(); return true; };
  return { store, ctl, timers, closed, poll, buttons, fire, reads, set: (ms: number) => { wall = ms; } };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise(r => setImmediate(r)); };

describe("#3197 regression: the deadline timer is never dropped at its own deadline", () => {
  it("a timer that fires 1 ms early, with the clock crossing the deadline mid-sweep, still closes the poll", async () => {
    const h = rig();
    const id = h.poll("B");
    const deadline = h.store.get(id)!.expiresAt;
    expect(h.timers).toHaveLength(1);
    // Node ran the timer at deadline − 1 ms (Date.now terms); the sweep's later reads are already at the deadline.
    // (sweep()'s own read and sweepPolls()'s pollsDue read land before it; arm()'s reads after it).
    h.set(deadline);
    h.reads.push(deadline - 1, deadline - 1);
    h.fire();
    await flush();
    expect(h.closed).toEqual([]);                                // too early to close — fine, if something is armed
    expect(h.timers).toHaveLength(1);                            // beta.1: nothing — the poll waited for an unrelated sweep
    expect(h.timers[0].ms).toBeLessThanOrEqual(1_000);
    h.set(deadline + h.timers[0].ms);
    h.fire();
    await flush();
    expect(h.closed).toEqual([id]);
    expect(h.store.get(id)!.closedAt).toBeLessThanOrEqual(deadline + 1_000);
  });

  it("another reply bound after a poll's deadline, before its sweep ran, does not take the poll's timer away", async () => {
    const h = rig();
    const id = h.poll("B");
    const deadline = h.store.get(id)!.expiresAt;
    h.set(deadline + 5);                                         // the loop was busy; the deadline timer has not run yet
    h.buttons("C");                                              // its bind re-arms the one timer
    const due = h.timers.filter(t => t.ms <= 1_000);
    expect(due).toHaveLength(1);                                 // beta.1: re-armed for C's expiry only (hours ahead)
    h.set(deadline + 5 + due[0].ms);
    h.timers.splice(h.timers.indexOf(due[0]), 1); due[0].fn();
    await flush();
    expect(h.closed).toEqual([id]);
  });

  it("with nothing pending, no timer is left (no idle wake-ups)", async () => {
    const h = rig();
    const id = h.poll("B");
    h.set(h.store.get(id)!.expiresAt);
    h.fire();
    await flush();
    expect(h.closed).toEqual([id]);
    expect(h.timers).toEqual([]);
  });
});
