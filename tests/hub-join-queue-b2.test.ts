/** Pure browser retry orchestration; server authorization is never inferred here. No network/CLI. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJoinApprovalQueue } from "/ui/js/hub-join-queue.js";
const REQUEST = "11111111-1111-4111-8111-111111111111";
const queues: ReturnType<typeof createJoinApprovalQueue>[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(() => { for (const q of queues.splice(0)) q.cancel(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function rig(patch: Record<string, unknown> = {}) {
  const events: any[] = [], approve = vi.fn(async (..._args: any[]) => ({ ok: true })), state = { current: true };
  const input = { approve, requestId: REQUEST, csrf: "owned-csrf", deadline: 61_000, current: () => state.current,
    onChange: (event: any) => { events.push(event); }, random: () => 0, ...patch };
  const queue = createJoinApprovalQueue(input); queues.push(queue);
  return { queue, approve, state, events, input };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
describe("B2 approval queue: same bound request, bounded lifetime", () => {
  it("backpressure queues then retries the same request inside 2–6 seconds", async () => {
    const r = rig(); r.approve.mockResolvedValueOnce({ ok: false, code: "backpressure" } as any);
    const result = r.queue.run(); await flush();
    expect(r.events.at(-1)).toMatchObject({ phase: "queued", attempts: 1, retryInMs: 2000 });
    await vi.advanceTimersByTimeAsync(1999); expect(r.approve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(await result).toEqual({ ok: true });
    expect(r.approve.mock.calls.map(call => call.slice(0, 2))).toEqual([[REQUEST, "owned-csrf"], [REQUEST, "owned-csrf"]]);
  });
  it("concurrent presses share one active request and promise", async () => {
    let release!: (answer: any) => void; const held = new Promise(resolve => { release = resolve; });
    const approve = vi.fn(() => held), r = rig({ approve });
    const first = r.queue.run(), second = r.queue.run();
    expect(second).toBe(first); expect(approve).toHaveBeenCalledOnce();
    release({ ok: true }); expect(await first).toEqual({ ok: true });
  });
  it("an already expired outer deadline sends no approval", async () => {
    const r = rig({ deadline: 999 }); expect(await r.queue.run()).toEqual({ ok: false, code: "unavailable", deadline: true });
    expect(r.approve).not.toHaveBeenCalled();
  });
  it("limits automatic retries to eight, and a manual retry keeps the same request", async () => {
    const approve = vi.fn(async () => ({ ok: false, code: "backpressure" })), r = rig({ approve });
    const result = r.queue.run(); await vi.advanceTimersByTimeAsync(16_000);
    expect(await result).toEqual({ ok: false, code: "backpressure" }); expect(approve).toHaveBeenCalledTimes(9);
    expect(r.events.at(-1)).toMatchObject({ phase: "failed", attempts: 9 }); expect(vi.getTimerCount()).toBe(0);
    approve.mockResolvedValueOnce({ ok: true } as any); expect(await r.queue.run()).toEqual({ ok: true });
    expect(approve.mock.calls.every((args: any[]) => args[0] === REQUEST)).toBe(true);
  });
  it.each(["denied", "expired", "unavailable"])("does not automatically retry %s", async code => {
    const approve = vi.fn(async () => ({ ok: false, code })), r = rig({ approve });
    expect(await r.queue.run()).toEqual({ ok: false, code }); await vi.advanceTimersByTimeAsync(20_000);
    expect(approve).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["limit-reached", "offer-pending"])("does not queue a terminal %s refusal", async code => {
    const approve = vi.fn(async () => ({ ok: false, code })), r = rig({ approve });
    expect(await r.queue.run()).toEqual({ ok: false, code }); await vi.advanceTimersByTimeAsync(20_000);
    expect(approve).toHaveBeenCalledOnce();
  });
  it("preserves an explicit limit reason even when a cached server uses the busy code", async () => {
    const answer = { ok: false, code: "backpressure", reason: "limit-reached" }, approve = vi.fn(async () => answer), r = rig({ approve });
    let settled: unknown; void r.queue.run().then((value: unknown) => { settled = value; }); await flush();
    expect(settled).toEqual(answer); expect(approve).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([0, 1])("jitter stays inside 2–6 seconds (sample=%s)", async random => {
    const r = rig({ random: () => random }); r.approve.mockResolvedValueOnce({ ok: false, code: "backpressure" } as any);
    const result = r.queue.run(); await flush(); const delay = random ? 6000 : 2000;
    expect(r.events.at(-1)).toMatchObject({ phase: "queued", retryInMs: delay });
    await vi.advanceTimersByTimeAsync(delay); expect(await result).toEqual({ ok: true });
  });
  it("the original deadline wins over a queued retry", async () => {
    const approve = vi.fn(async () => ({ ok: false, code: "backpressure" })), r = rig({ approve, deadline: 2000 });
    const result = r.queue.run(); await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({ ok: false, code: "unavailable", deadline: true }); expect(approve).toHaveBeenCalledOnce();
    expect(r.events.at(-1)).toMatchObject({ phase: "uncertain" });
    await vi.advanceTimersByTimeAsync(10_000); expect(approve).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("a never-settled approval cannot hold the page beyond the outer deadline", async () => {
    let release!: (answer: any) => void; const held = new Promise(resolve => { release = resolve; });
    const approve = vi.fn(() => held), r = rig({ approve, deadline: 2000 }), result = r.queue.run();
    let settled: unknown; void result.then((value: unknown) => { settled = value; });
    await vi.advanceTimersByTimeAsync(1000); expect(settled).toEqual({ ok: false, code: "unavailable", deadline: true });
    const events = r.events.slice(); release({ ok: true }); await flush(); expect(r.events).toEqual(events);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancel clears the retry, retires the result and aborts the pending request signal", async () => {
    const r = rig(); r.approve.mockResolvedValueOnce({ ok: false, code: "backpressure" } as any);
    const result = r.queue.run(); await flush(); const events = r.events.slice(), signal = r.approve.mock.calls[0]![2];
    r.queue.cancel(); expect(await result).toEqual({ ok: false, code: "retired" }); expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000); expect(r.events).toEqual(events); expect(r.approve).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("late results are inert without AbortController after the session is retired", async () => {
    vi.stubGlobal("AbortController", undefined);
    let release!: (answer: any) => void; const held = new Promise(resolve => { release = resolve; });
    const approve = vi.fn(() => held), r = rig({ approve }), result = r.queue.run(); const events = r.events.slice();
    r.state.current = false; r.queue.cancel(); expect(await result).toEqual({ ok: false, code: "retired" });
    release({ ok: true }); await flush(); expect(r.events).toEqual(events); expect(vi.getTimerCount()).toBe(0);
  });
  it("rechecks current after the await even if no cancel event was delivered", async () => {
    let release!: (answer: any) => void; const held = new Promise(resolve => { release = resolve; });
    const approve = vi.fn(() => held), r = rig({ approve }), result = r.queue.run(); const events = r.events.slice();
    r.state.current = false; release({ ok: true }); expect(await result).toEqual({ ok: false, code: "retired" });
    expect(r.events).toEqual(events); expect(vi.getTimerCount()).toBe(0);
  });
  it("captures request, CSRF, deadline and callbacks before any await", async () => {
    const r = rig(); r.approve.mockResolvedValueOnce({ ok: false, code: "backpressure" } as any);
    const result = r.queue.run(); await flush();
    Object.assign(r.input, { requestId: "replacement", csrf: "replacement", deadline: 999, approve: vi.fn(), onChange: vi.fn() });
    await vi.advanceTimersByTimeAsync(2000); expect(await result).toEqual({ ok: true });
    expect(r.approve.mock.calls.map(args => args.slice(0, 2))).toEqual([[REQUEST, "owned-csrf"], [REQUEST, "owned-csrf"]]);
    expect(JSON.stringify(r.events)).not.toContain("owned-csrf"); expect(r.events.at(-1)).toMatchObject({ phase: "done" });
  });
  it("normalizes a transport exception without exposing its message or looping", async () => {
    const approve = vi.fn(async () => { throw Error("owned-inert-diagnostic"); }), r = rig({ approve });
    expect(await r.queue.run()).toEqual({ ok: false, code: "unavailable" }); expect(approve).toHaveBeenCalledOnce();
    expect(JSON.stringify(r.events)).not.toContain("owned-inert-diagnostic"); expect(vi.getTimerCount()).toBe(0);
  });
});
