/**
 * #3011: a set's deadline is fixed at prepare(), before the send. When the platform confirms the send after that
 * deadline (a 20 s poll on a slow Discord send), arm() saw nothing ahead (nextExpiry then looked only past `now`), so no timer
 * was armed and the poll stayed open until something unrelated swept. bind() now sweeps at once for a past-due set.
 * The real store (scratch sqlite) and controller; a fake clock and a recording timer — no other trigger exists here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplyButtonStore } from "../src/reply-buttons.js";
import { ReplyButtonsController } from "../src/reply-buttons-controller.js";
import type { PollConfig } from "../src/reply-polls.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); vi.restoreAllMocks(); });

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agend-3011-"));
  const store = new ReplyButtonStore(join(dir, "buttons.db"));
  let now = 1_000_000;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const admitted: Array<{ key: string; text: string }> = [];
  const infos: Array<[object, string | undefined]> = [];
  const settled: unknown[] = [];
  const adapter = { settleReplyButtons: vi.fn(async (...a: unknown[]) => { settled.push(a); }), settleReplyPoll: vi.fn(async () => {}), editReplyPoll: vi.fn(async () => {}) };
  const ctl = new ReplyButtonsController({
    store, now: () => now, monotonic: () => now,
    adapterFor: () => adapter as never, mayClick: () => true, deliver: async () => true, publish: () => {},
    admitResults: (_set, key, text) => { admitted.push({ key, text }); return true; },
    logger: { info: (o, m) => { infos.push([o, m]); }, warn() {} },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
  });
  cleanup.push(() => { ctl.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, ctl, timers, admitted, infos, settled, adapter, advance: (ms: number) => { now += ms; }, now: () => now };
}
const where = { instance: "quiz", adapterId: "dc", chatId: "guild", threadId: "room" };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise(r => setImmediate(r)); };

describe("#3011: a set bound after its own deadline", () => {
  it("a 20 s poll whose send is confirmed 25 s later closes and its results reach the agent, with no other trigger", async () => {
    const r = rig();
    const poll: PollConfig = { seconds: 20, multi: false, reveal: "close", showVoters: false, question: "Q?" };
    const p = r.ctl.prepare(where, [{ label: "A", value: "a" }, { label: "B", value: "b" }], poll);
    r.advance(25_000);                                    // the platform confirms the send after the deadline
    r.ctl.bind(p.id, "msg-1");
    await flush();
    const set = r.store.get(p.id)!;
    expect(set.closedAt).not.toBeNull();                  // closed at once, not "whenever something sweeps"
    expect(r.admitted.map(a => a.key)).toEqual([`poll:${p.id}`]);
    expect(r.admitted[0].text).toContain("[poll results]");
    const bound = r.infos.find(([, m]) => m === "Reply buttons bound");
    expect(bound?.[0]).toMatchObject({ set: p.id, bindDelayMs: 25_000, poll: true });
  });

  it("plain buttons whose expiry passed before the bind are settled as expired at once", async () => {
    const r = rig();
    const p = r.ctl.prepare(where, [{ label: "Yes", value: "yes" }]);
    const set0 = r.store.get(p.id)!;
    r.advance(set0.expiresAt - r.now() + 1_000);          // bound after the plain set's expiry
    r.ctl.bind(p.id, "msg-2");
    await flush();
    expect(r.store.get(p.id)!.settledAt).not.toBeNull();
    expect(r.adapter.settleReplyButtons).toHaveBeenCalledTimes(1);
    expect(r.adapter.settleReplyButtons.mock.calls[0][4]).toEqual({ expired: true });
  });

  it("an on-time bind still just arms the one timer (no sweep, nothing settled), and logs its delay", async () => {
    const r = rig();
    const poll: PollConfig = { seconds: 20, multi: false, reveal: "close", showVoters: false, question: "Q?" };
    const p = r.ctl.prepare(where, [{ label: "A", value: "a" }, { label: "B", value: "b" }], poll);
    r.advance(800);
    r.ctl.bind(p.id, "msg-3");
    await flush();
    expect(r.store.get(p.id)!.closedAt).toBeNull();
    expect(r.admitted).toEqual([]);
    expect(r.timers.some(t => t.ms >= 19_000 && t.ms <= 19_200)).toBe(true);   // the sweep timer for the deadline
    expect(r.infos.find(([, m]) => m === "Reply buttons bound")?.[0]).toMatchObject({ bindDelayMs: 800 });
  });
});
