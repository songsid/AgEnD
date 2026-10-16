import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const P = await import(new URL("../src/ui/shared/effect-profiler.js", import.meta.url).href);
const effectId = "a".repeat(32);
const page = { hidden: false, reducedMotion: false, saveData: false, show: true };
function rig(device = "standard", longTasksSupported = true) {
  let now = 0;
  const budget = new P.EffectBudget({ device, longTasksSupported, clock: () => now });
  return { budget, at(t: number) { now = t; }, frames(from: number, to: number, fps: number) {
    for (let i = 1; i <= Math.floor((to - from) / 1000 * fps); i++) { now = from + i * 1000 / fps; budget.frame(); }
    now = to;
  } };
}
describe("#1629 host-only effect profiler", () => {
  it("is an unmounted module with no child telemetry, browser side effects or message-content reads", () => {
    const source = readFileSync(new URL("../src/ui/shared/effect-profiler.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(source).not.toMatch(/\b(?:document|window|MessagePort|Worker|postMessage|addEventListener|requestAnimationFrame|setInterval|localStorage)\b/);
    expect(source).not.toMatch(/\.(?:textContent|innerHTML|message|content|body)\b/);
    expect(Object.keys(P).sort()).toEqual(["EFFECT_BUDGETS", "EffectBudget", "newEffectPauseHistory", "recordEffectPause"]);
  });
  it("pins both device budgets without accepting an author fps option", () => {
    expect(P.EFFECT_BUDGETS).toEqual({ standard: { fps: 55, longTaskMsPerSecond: 50 }, constrained: { fps: 50, longTaskMsPerSecond: 25 } });
    expect(Object.isFrozen(P.EFFECT_BUDGETS.standard)).toBe(true);
    expect(() => new P.EffectBudget({ device: "fast" })).toThrow(TypeError);
    expect(() => new P.EffectBudget({ device: "standard", longTasksSupported: "yes" })).toThrow(TypeError);
    expect(() => new P.EffectBudget({ device: "standard", clock: 1 })).toThrow(TypeError);
  });
  it("ignores startup, waits for a full window, degrades then pauses at 3/4/5 seconds", () => {
    const h = rig("constrained");
    h.at(999); expect(h.budget.longTask(0, 999)).toBe(false);
    h.at(2999); expect(h.budget.poll()).toMatchObject({ verdict: "ok", metrics: null, badWindows: 0 });
    h.at(3000); expect(h.budget.poll()).toMatchObject({ verdict: "degraded", quality: "low", pointerHz: 30, remove: false, badWindows: 1 });
    for (const t of [3000, 3001, 3999]) { h.at(t); expect(h.budget.poll().badWindows).toBe(1); }
    h.at(4000); expect(h.budget.poll()).toMatchObject({ verdict: "degraded", badWindows: 2 });
    h.at(4999); expect(h.budget.poll().remove).toBe(false);
    h.at(5000); expect(h.budget.poll()).toMatchObject({ verdict: "paused", reason: "host_budget", remove: true, forward: false, badWindows: 3 });
    h.frames(5000, 8000, 60); expect(h.budget.poll().remove).toBe(true);
  });
  it.each([["standard", 55], ["constrained", 50]])("keeps light %s host cadence running at its exact floor", (device, fps) => {
    const h = rig(device as string);
    h.frames(1000, 3000, fps as number);
    expect(h.budget.poll()).toMatchObject({ verdict: "ok", pointerHz: 60, quality: "normal", metrics: { hostFps: fps, attribution: "unknown", attributedLongTaskMsPerSecond: null } });
    h.frames(3000, 8000, fps as number); expect(h.budget.poll().verdict).toBe("ok");
  });
  it.each([["standard", 54.5], ["constrained", 49.5]])("detects %s below-floor cadence", (device, fps) => {
    const h = rig(device as string); h.frames(1000, 3000, fps as number);
    expect(h.budget.poll()).toMatchObject({ verdict: "degraded", metrics: { hostFps: fps } });
  });
  it("does not call a short burst at 60fps healthy after the rest of the window stalled", () => {
    const h = rig(); h.frames(1000, 1500, 60); h.at(3000);
    expect(h.budget.poll()).toMatchObject({ verdict: "degraded", metrics: { hostFps: 15 } });
  });
  it.each([["standard", 100], ["constrained", 50]])("holds %s exact long-task threshold but degrades above it", (device, duration) => {
    const h = rig(device as string); h.frames(1000, 3000, 60);
    expect(h.budget.longTask(2000, duration as number, true)).toBe(true);
    expect(h.budget.poll()).toMatchObject({ verdict: "ok", metrics: { hostLongTaskMsPerSecond: (duration as number) / 2, attributedLongTaskMsPerSecond: (duration as number) / 2, attribution: "observed" } });
    const bad = rig(device as string); bad.frames(1000, 3000, 60);
    bad.budget.longTask(2000, (duration as number) + 1, true);
    expect(bad.budget.poll().verdict).toBe("degraded");
  });
  it("uses unattributed host tasks conservatively and doesn't certify Worker CPU as zero", () => {
    const h = rig(); h.frames(1000, 3000, 60);
    h.budget.longTask(2200, 101, false);
    expect(h.budget.poll()).toMatchObject({ verdict: "degraded", metrics: { hostLongTaskMsPerSecond: 50.5, attributedLongTaskMsPerSecond: null, attribution: "unknown" } });
    const noApi = rig("standard", false); noApi.frames(1000, 3000, 60);
    expect(noApi.budget.longTask(2200, 1000, true)).toBe(false);
    expect(noApi.budget.poll()).toMatchObject({ verdict: "ok", metrics: { hostLongTaskMsPerSecond: null, attributedLongTaskMsPerSecond: null, attribution: "unknown" } });
    noApi.frames(3000, 4000, 20); expect(noApi.budget.poll().verdict).toBe("degraded");
  });
  it("clips tasks to warmup and the current window, then retires old observations", () => {
    const h = rig(); h.frames(1000, 3000, 60);
    expect(h.budget.longTask(950, 100)).toBe(true);
    expect(h.budget.poll().metrics.hostLongTaskMsPerSecond).toBe(25);
    h.frames(3000, 5000, 60);
    expect(h.budget.longTask(2900, 200)).toBe(true);
    expect(h.budget.poll().metrics.hostLongTaskMsPerSecond).toBe(50);
    h.frames(5000, 7000, 60);
    expect(h.budget.poll().metrics.hostLongTaskMsPerSecond).toBe(0);
  });
  it.each([[-1, 60, true], [1, 49, true], [1, 60001, true], [NaN, 100, true], [1, Infinity, true], [2950, 100, true], [2000, 100, "yes"]])("rejects malformed/future task %s/%s/%s", (start, duration, attributed) => {
    const h = rig(); h.frames(1000, 3000, 60);
    expect(h.budget.longTask(start, duration, attributed)).toBe(false);
    expect(h.budget.poll().verdict).toBe("ok");
  });
  it("resets the consecutive bad streak on health but never silently restores high quality", () => {
    const h = rig(); h.at(3000); h.budget.poll();
    h.frames(3000, 5000, 60);
    expect(h.budget.poll()).toMatchObject({ verdict: "degraded", badWindows: 0, quality: "low" });
    h.at(7000); expect(h.budget.poll()).toMatchObject({ badWindows: 1, remove: false });
    h.at(8000); expect(h.budget.poll()).toMatchObject({ badWindows: 2, remove: false });
    h.at(9000); expect(h.budget.poll().remove).toBe(true);
  });
  it("doesn't fabricate three missed windows after one delayed poll", () => {
    const h = rig(); h.at(20000);
    expect(h.budget.poll()).toMatchObject({ verdict: "degraded", badWindows: 1 });
    h.at(20001); expect(h.budget.poll().badWindows).toBe(1);
  });
  it("stops forwarding immediately hidden, removes at 10 seconds, and cannot revive late", () => {
    const h = rig(); h.at(2000);
    expect(h.budget.gates({ ...page, hidden: true })).toMatchObject({ forward: false, remove: false });
    h.at(11999); expect(h.budget.poll().remove).toBe(false);
    h.at(12000); expect(h.budget.poll()).toMatchObject({ remove: true, reason: "hidden" });
    expect(h.budget.gates(page).remove).toBe(true);
    const late = rig(); late.budget.gates({ ...page, hidden: true }); late.at(10000);
    expect(late.budget.gates(page).remove).toBe(true);
  });
  it("restarts sampling after a short background stay rather than treating throttling as jank", () => {
    const h = rig(); h.at(3000); h.budget.poll();
    h.at(4000); h.budget.gates({ ...page, hidden: true });
    h.at(9000); expect(h.budget.frame().forward).toBe(false);
    expect(h.budget.longTask(8000, 500)).toBe(false);
    h.budget.gates(page); h.at(9999); expect(h.budget.poll().metrics).toBeNull();
    h.frames(10000, 12000, 60);
    expect(h.budget.poll()).toMatchObject({ verdict: "degraded", badWindows: 0, remove: false, forward: true, metrics: { hostFps: 60 } });
  });
  it.each([[{ reducedMotion: true }, "reduced_motion"], [{ saveData: true }, "save_data"], [{ show: false }, "viewer_off"], [{ hidden: undefined }, "gates_unknown"]])("removes immediately for %s", (patch, reason) => {
    const h = rig(); expect(h.budget.gates({ ...page, ...patch })).toMatchObject({ remove: true, forward: false, reason });
    expect(h.budget.gates(page).remove).toBe(true);
  });
  it.each([null, [], false])("fails closed on non-object page gates %s", gates => {
    let result; expect(() => { result = rig().budget.gates(gates); }).not.toThrow();
    expect(result).toMatchObject({ remove: true, reason: "gates_unknown" });
  });
  it.each(["frame", "loaded", "poll", "gates", "longTask"])("fails closed on clock rollback through %s", method => {
    const h = rig(); h.at(1000); h.budget.frame(); h.at(999);
    h.budget[method](...(method === "gates" ? [page] : method === "longTask" ? [0, 100] : []));
    expect(h.budget.snapshot()).toMatchObject({ remove: true, reason: "clock_unavailable" });
  });
  it.each([NaN, Infinity, -1])("fails closed on unavailable clock %s", now => {
    const h = rig(); h.at(now); expect(h.budget.poll()).toMatchObject({ remove: true, reason: "clock_unavailable" });
    expect(new P.EffectBudget({ device: "standard", clock: () => now }).snapshot().remove).toBe(true);
  });
  it("fails closed when the clock throws", () => {
    expect(new P.EffectBudget({ device: "standard", clock: () => { throw Error("no clock"); } }).snapshot().remove).toBe(true);
  });
  it("records load from the host clock only and returns independent snapshots", () => {
    const h = rig(); h.at(100); expect(h.budget.loaded().loadMs).toBe(100);
    h.at(200); expect(h.budget.loaded().loadMs).toBe(100);
    h.frames(1000, 3000, 60); const first = h.budget.poll(); first.metrics.hostFps = 0;
    expect(h.budget.snapshot().metrics.hostFps).toBe(60);
  });
  it("bounds retained observations and degrades on overflow instead of silently losing expense", () => {
    const h = rig(); h.frames(1000, 3000, 60);
    for (let i = 0; i < 257; i++) h.budget.longTask(2000, 50);
    expect(h.budget.tasks).toHaveLength(256);
    expect(h.budget.poll().verdict).toBe("degraded");
    const many = rig(); many.frames(1000, 3000, 1100);
    expect(many.budget.frames.length).toBeLessThanOrEqual(2048);
    expect(many.budget.poll().verdict).toBe("degraded");
  });
});
describe("#1629 per-content device pause history", () => {
  it("turns off at the third pause in 24 hours and keeps off sticky after age-out", () => {
    let history = P.newEffectPauseHistory(effectId, "constrained", 0);
    for (const [time, off] of [[0, false], [1, false], [2, true]] as const) {
      const r = P.recordEffectPause(history, time); expect(r.ok).toBe(true); expect(r.history.off).toBe(off); history = r.history;
    }
    const aged = P.recordEffectPause(history, 86400003);
    expect(aged.history).toMatchObject({ off: true, pauses: [86400003] });
    expect(P.newEffectPauseHistory("b".repeat(32), "constrained", 86400003).off).toBe(false);
    expect(P.newEffectPauseHistory(effectId, "standard", 86400003).off).toBe(false);
  });
  it("expires a pause exactly at 24h, retains the one 1ms inside and never mutates its preimage", () => {
    const h = { ...P.newEffectPauseHistory(effectId, "standard", 1), pauses: [0, 1] };
    expect(P.recordEffectPause(h, 86400000).history).toMatchObject({ pauses: [1, 86400000], off: false });
    expect(h.pauses).toEqual([0, 1]);
    expect(P.recordEffectPause(h, 86399999).history.off).toBe(true);
  });
  it("does not let a wall rollback expire pauses", () => {
    const h = { ...P.newEffectPauseHistory(effectId, "standard", 100000000), pauses: [99999999, 100000000] };
    expect(P.recordEffectPause(h, 0).history).toMatchObject({ pauses: [99999999, 100000000, 100000000], lastWall: 100000000, off: true });
  });
  it.each([null, { v: 2 }, { id: "bad" }, { device: "phone" }, { off: "yes" }, { lastWall: -1 }, { pauses: [2, 1] }, { pauses: new Array(1) }, { pauses: [1, 2, 3, 4] }, { pauses: [NaN] }, { pauses: [Infinity] }, { pauses: [-1] }, { pauses: [11] }, { extra: true }])("refuses unknown persisted history %s", patch => {
    const h = patch === null ? null : { ...P.newEffectPauseHistory(effectId, "standard", 10), ...patch };
    expect(P.recordEffectPause(h, 10)).toEqual({ ok: false, error: "pause_history_unknown" });
  });
  it.each([NaN, Infinity, -1])("refuses unknown calendar time %s", wall => {
    expect(P.newEffectPauseHistory(effectId, "standard", wall)).toBeNull();
    expect(P.recordEffectPause(P.newEffectPauseHistory(effectId, "standard", 0), wall).ok).toBe(false);
  });
  it("refuses invalid version and device identity", () => {
    expect(P.newEffectPauseHistory("bad", "standard", 0)).toBeNull();
    expect(P.newEffectPauseHistory(effectId, "unknown", 0)).toBeNull();
  });
});
