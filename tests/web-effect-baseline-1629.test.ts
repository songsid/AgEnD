import { describe, expect, it, vi } from "vitest";
const { captureEffectBaseline } = await import(new URL("../src/ui/shared/effect-baseline.js", import.meta.url).href);
function rig(options = {}) {
  let now = 0, empty: unknown = true, next = 0;
  const frames = new Map<number, () => void>(), timers = new Map<number, { fn: () => void; delay: number }>(), listeners = new Set<() => void>();
  const host = { performance: { now: () => now }, document: { visibilityState: "visible", addEventListener: vi.fn((_type: string, fn: () => void) => listeners.add(fn)), removeEventListener: vi.fn((_type: string, fn: () => void) => listeners.delete(fn)) },
    requestAnimationFrame(fn: () => void) { frames.set(++next, fn); return next; }, cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)),
    setTimeout(fn: () => void, delay: number) { timers.set(++next, { fn, delay }); return next; }, clearTimeout: vi.fn((id: number) => timers.delete(id)) };
  const job = captureEffectBaseline({ window: host, empty: () => empty, ...options });
  return { job, host, frames, timers, listeners, at(t: number) { now = t; }, empty(v: unknown) { empty = v; }, step(t: number) { now = t; const pending = [...frames.values()]; frames.clear(); for (const f of pending) f(); } };
}
describe("#1629 pre-effect host cadence", () => {
  it.each([30, 50, 60, 144])("measures an idle %s Hz host, including low-refresh displays", async hz => {
    const h = rig(); for (let i = 0; i <= Math.ceil(2 * hz) + 1; i++) h.step(i * 1000 / hz);
    const r = await h.job.promise; expect(r.ok).toBe(true); expect(r.baselineFps).toBeCloseTo(hz, 7);
    expect(h.frames.size).toBe(0); expect(h.timers.size).toBe(0); expect(h.listeners.size).toBe(0);
  });
  it("cannot resolve before two visible seconds and ignores duplicate callbacks", async () => {
    const h = rig(), result = vi.fn(); h.job.promise.then(result);
    h.step(0); h.step(0); h.step(1000); h.step(1999); await Promise.resolve(); expect(result).not.toHaveBeenCalled();
    h.step(2000); expect(await h.job.promise).toEqual({ ok: true, baselineFps: 1.5 });
  });
  it.each([false, undefined, null, "true"])("requires a proven empty registry: %s", async value => {
    const h = rig(); h.empty(value); h.step(0); expect(await h.job.promise).toEqual({ ok: false, reason: "baseline_unavailable" });
    expect(h.frames.size).toBe(0); expect(h.timers.size).toBe(0);
  });
  it("revokes immediately when an effect appears between samples", async () => {
    const h = rig(); h.step(0); h.step(1000); h.empty(false); h.step(2000);
    expect(await h.job.promise).toEqual({ ok: false, reason: "baseline_unavailable" });
  });
  it("hidden pages refuse, and visibility loss revokes before another animation frame", async () => {
    const h = rig(); h.step(0); h.host.document.visibilityState = "hidden"; for (const fn of [...h.listeners]) fn();
    expect(h.frames.size).toBe(0); expect(await h.job.promise).toEqual({ ok: false, reason: "baseline_unavailable" });
  });
  it.each([NaN, Infinity, -1])("fails closed on unavailable initial clock %s", async now => {
    const h = rig({ clock: () => now }); expect(h.frames.size).toBe(0); expect(h.timers.size).toBe(0); expect(await h.job.promise).toEqual({ ok: false, reason: "clock_unavailable" });
  });
  it("a clock rollback permanently revokes the measurement", async () => {
    const h = rig(); h.step(100); h.step(99); expect(h.frames.size).toBe(0); expect(h.timers.size).toBe(0); expect(await h.job.promise).toEqual({ ok: false, reason: "clock_unavailable" });
    h.step(2200); expect(h.frames.size).toBe(0);
  });
  it("bounds a starved rAF and rechecks an early timer's remaining monotonic budget", async () => {
    const h = rig(); expect([...h.timers.values()].map(x => x.delay)).toEqual([10000]);
    const [firstId, firstTimer] = [...h.timers][0]!; h.timers.delete(firstId); h.at(1000); firstTimer.fn(); expect([...h.timers.values()].map(x => x.delay)).toEqual([9000]);
    const [id, timer] = [...h.timers][0]!; h.timers.delete(id); h.at(9999); timer.fn(); expect([...h.timers.values()].map(x => x.delay)).toEqual([1]);
    h.at(10000); [...h.timers.values()][0]!.fn(); expect(await h.job.promise).toEqual({ ok: false, reason: "baseline_timeout" }); expect(h.frames.size).toBe(0);
  });
  it("a delayed frame cannot turn a timed-out attempt into a baseline", async () => {
    const h = rig(); h.step(0); h.step(10000); expect(await h.job.promise).toEqual({ ok: false, reason: "baseline_timeout" });
  });
  it("cancel settles once and removes every source of callbacks", async () => {
    const h = rig(), done = vi.fn(); h.job.promise.then(done); const stale = [...h.frames.values()][0]!;
    h.job.cancel(); h.job.cancel(); stale(); await Promise.resolve(); expect(done).toHaveBeenCalledOnce();
    expect(await h.job.promise).toEqual({ ok: false, reason: "baseline_cancelled" }); expect(h.frames.size).toBe(0); expect(h.timers.size).toBe(0); expect(h.listeners.size).toBe(0);
  });
  it("missing browser capabilities or an unknown empty-registry probe fail closed", async () => {
    expect(await captureEffectBaseline().promise).toEqual({ ok: false, reason: "baseline_unsupported" });
    const h = rig({ empty: () => { throw Error("unknown"); } }); expect(await h.job.promise).toEqual({ ok: false, reason: "baseline_unavailable" });
  });
});
