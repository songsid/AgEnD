import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { EffectBudget } = await import(new URL("../src/ui/shared/effect-profiler.js", import.meta.url).href);
const { createEffectProfileCollector } = await import(new URL("../src/ui/shared/effect-profiles.js", import.meta.url).href);
const gates = { hidden: false, reducedMotion: false, show: true };
function live(hz = 60, device = "standard", longTasksSupported = false) {
  let now = 0, index = 1;
  const budget = new EffectBudget({ device, longTasksSupported, clock: () => now });
  return { budget, at(n: number) { now = n; }, now: () => now,
    advance(to: number, keep = (_n: number) => true) {
      for (; index * 1000 / hz <= to; index++) {
        now = index * 1000 / hz;
        if (keep(now)) budget.frame();
      }
      now = to;
    },
  };
}

describe("#2118 immediate playback with a concurrent host guard", () => {
  it.each([30, 50, 60, 144])("learns %sHz during playback, without an empty-page admission or assumed 60Hz", hz => {
    const h = live(hz);
    expect(h.budget.snapshot()).toMatchObject({ forward: true, remove: false, metrics: null });
    h.advance(2999); expect(h.budget.poll().metrics).toBeNull();
    h.advance(3000);
    const first = h.budget.poll();
    expect(first).toMatchObject({ verdict: "ok", remove: false, metrics: { hostFps: hz } });
    expect(first.metrics.fpsFloor).toBeCloseTo(Math.min(55, hz * 0.9), 7);
    for (let t = 4000; t <= 9000; t += 1000) { h.advance(t); expect(h.budget.poll()).toMatchObject({ verdict: "ok", remove: false }); }
  });
  it.each([30, 50, 60, 144])("keeps a coherent immutable profile floor at %sHz and detects subsequent sustained frame loss", hz => {
    const h = live(hz), id = "a".repeat(32);
    const collector = createEffectProfileCollector({ key: "chat", id, device: "standard", clock: h.now });
    h.advance(3000); const first = h.budget.poll(), floor = first.metrics.fpsFloor;
    expect(collector.add({ key: "chat", id, device: "standard", ...first })).toBe(true);
    for (const t of [4000, 5000, 6000, 7000]) {
      h.advance(t, () => false); const state = h.budget.poll();
      expect(state.metrics.fpsFloor).toBe(floor);
      expect(collector.add({ key: "chat", id, device: "standard", ...state })).toBe(true);
      if (state.remove) break;
    }
    expect(h.budget.snapshot()).toMatchObject({ remove: true, reason: "host_budget", badWindows: 3 });
    expect(collector.report()).toMatchObject({ profile: { samples: hz === 144 ? 5 : 4, fps_floor: floor, verdict: "paused" } });
  });
  it("catches intermittent jank present from the first drawing frame, rather than learning its average as healthy", () => {
    const h = live();
    for (const t of [3000, 4000, 5000]) {
      h.advance(t, n => n % 200 < 100); h.budget.poll();
    }
    expect(h.budget.snapshot()).toMatchObject({ reason: "host_budget", remove: true, badWindows: 3 });
  });
  it("an unobserved cadence never fabricates an FPS floor or healthy window", () => {
    const h = live();
    for (const t of [3000, 4000, 5000]) { h.at(t); expect(h.budget.poll().metrics).toBeNull(); }
    expect(h.budget.snapshot()).toMatchObject({ reason: "host_budget", remove: true, badWindows: 3 });
  });
  it("long tasks still stop a responsive-looking frame stream", () => {
    const h = live(60, "standard", true);
    for (const t of [3000, 4000, 5000]) {
      h.advance(t); expect(h.budget.longTask(t - 500, 200)).toBe(true); h.budget.poll();
    }
    expect(h.budget.snapshot()).toMatchObject({ reason: "host_budget", remove: true });
  });
  it("hidden time resets observation windows, preserves the floor, and rollback still revokes", () => {
    const h = live(30); h.advance(3000); const floor = h.budget.poll().metrics.fpsFloor;
    h.budget.gates({ ...gates, hidden: true }); h.at(5000);
    expect(h.budget.frame()).toMatchObject({ forward: false, metrics: { fpsFloor: floor } });
    h.budget.gates(gates); expect(h.budget.snapshot().metrics).toBeNull();
    h.at(4999); expect(h.budget.frame()).toMatchObject({ remove: true, reason: "clock_unavailable" });
  });
  it("data saver is informational, including when its value is unavailable", () => {
    const h = live(); const data = { ...gates };
    Object.defineProperty(data, "saveData", { get() { throw Error("not an admission input"); } });
    expect(h.budget.gates(data)).toMatchObject({ remove: false, forward: true });
    expect(h.budget.gates({ ...gates, saveData: true })).toMatchObject({ remove: false, forward: true });
  });
});

describe("#2118 shared device motion preference", () => {
  let values: Map<string, string>, events: Map<string, Set<(e: any) => void>>, reduce: boolean;
  beforeEach(() => {
    vi.resetModules(); values = new Map(); events = new Map(); reduce = true;
    vi.stubGlobal("localStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) });
    vi.stubGlobal("addEventListener", (k: string, fn: (e: any) => void) => { if (!events.has(k)) events.set(k, new Set()); events.get(k)!.add(fn); });
    vi.stubGlobal("removeEventListener", (k: string, fn: (e: any) => void) => events.get(k)?.delete(fn));
    vi.stubGlobal("matchMedia", () => ({ matches: reduce }));
  });
  afterEach(() => vi.unstubAllGlobals());
  const motion = () => import(new URL("../src/ui/shared/fx-motion.js", import.meta.url).href);
  it("a fresh device plays under OS reduce, then one explicit choice blocks it and can recover", async () => {
    const m = await motion(); expect(m.followsReducedMotion()).toBe(false); expect(m.motionBlocked()).toBe(false);
    expect(m.motionNoteDue()).toBe(true); m.markMotionNoteShown(); expect(m.motionNoteDue()).toBe(false);
    m.setFollowsReducedMotion(true); expect(m.motionBlocked()).toBe(true);
    reduce = false; expect(m.motionBlocked()).toBe(false);
    reduce = true; m.setFollowsReducedMotion(false); expect(m.motionBlocked()).toBe(false);
    expect(values.has(m.FX_FOLLOW_REDUCED_MOTION_KEY)).toBe(false);
  });
  it("retains the visible choice and a single note on this page when storage is blocked", async () => {
    vi.stubGlobal("localStorage", { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); }, removeItem() { throw Error("blocked"); } });
    const m = await motion(); expect(m.motionNoteDue()).toBe(true); m.markMotionNoteShown(); expect(m.motionNoteDue()).toBe(false);
    m.setFollowsReducedMotion(true); expect(m.followsReducedMotion()).toBe(true); expect(m.motionBlocked()).toBe(true);
    m.setFollowsReducedMotion(false); expect(m.motionBlocked()).toBe(false);
  });
  it("does not lose a choice when a failed write leaves a readable stale storage value", async () => {
    values.set("agend_fx_follow_reduced_motion", "1");
    const m = await motion(); (globalThis.localStorage as any).removeItem = () => { throw Error("full"); };
    m.setFollowsReducedMotion(false); expect(m.motionBlocked()).toBe(false); expect(values.get(m.FX_FOLLOW_REDUCED_MOTION_KEY)).toBe("1");
  });
  it("cross-tab changes notify and replace this page's override; unsubscribing releases the listener", async () => {
    const m = await motion(), changed = vi.fn(), off = m.onMotionChange(changed);
    m.setFollowsReducedMotion(true); expect(changed).toHaveBeenCalledOnce();
    for (const fn of events.get("storage")!) fn({ key: m.FX_FOLLOW_REDUCED_MOTION_KEY, newValue: null });
    expect(changed).toHaveBeenCalledTimes(2); expect(m.motionBlocked()).toBe(false);
    off(); expect(events.get("storage")?.size).toBe(0);
  });
  it("unknown OS motion is only a block after the person chose to follow it", async () => {
    const m = await motion(), unknown = { matchMedia() { throw Error("unknown"); } };
    expect(m.motionBlocked(unknown)).toBe(false); m.setFollowsReducedMotion(true); expect(m.motionBlocked(unknown)).toBe(true);
  });
});
