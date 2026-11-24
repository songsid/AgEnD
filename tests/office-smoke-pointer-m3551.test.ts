import { describe, expect, it, vi } from "vitest";
import { createContext, runInContext } from "node:vm";
import { findOfficePersonPoint, pinOfficePointerClock, resumeOfficePointerClock, officePointerClockIsLive } from "../scripts/manual/smoke-fixture/office-smoke-pointer.js";
function clockPage(inherited = false) {
  let ms = 100;
  const native = () => ++ms;
  const performance = inherited ? Object.create({ now: native }) : { now: native };
  const context = createContext({ performance, requestAnimationFrame: (fn: Function) => { ms += 16; fn(); } });
  return { performance, native, page: { evaluate: (code: string) => Promise.resolve(runInContext(code, context)) } };
}
describe("Office smoke pointer setup (M-3551)", () => {
  it.each([false, true])("pins acquisition then restores the exact %s clock property before live actions", async inherited => {
    const f = clockPage(inherited), descriptor = Object.getOwnPropertyDescriptor(f.performance, "now");
    await pinOfficePointerClock(f.page);
    expect(f.performance.now()).toBe(f.performance.now());
    expect(await officePointerClockIsLive(f.page)).toBe(false);
    await expect(pinOfficePointerClock(f.page)).rejects.toThrow("already pinned");
    await resumeOfficePointerClock(f.page);
    expect(Object.getOwnPropertyDescriptor(f.performance, "now")).toEqual(descriptor);
    expect(f.performance.now).toBe(f.native);
    expect(await officePointerClockIsLive(f.page)).toBe(true);
    expect(f.performance.now()).toBeLessThan(f.performance.now());
    await resumeOfficePointerClock(f.page); // teardown is idempotent
  });
  it("requires a positive person hit and returns exactly the observed point, without a six-pixel shift", async () => {
    const move = vi.fn(), evaluate = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const page = { locator: () => ({ boundingBox: async () => ({ x: 0, y: 0, width: 160, height: 140 }) }), mouse: { move }, evaluate };
    const point = await findOfficePersonPoint(page);
    const [x, y] = move.mock.calls[1];
    expect(point).toEqual({ x, y });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
  it("does not treat a hot bubble-only scan as a person", async () => {
    const context = createContext({ document: { querySelector: (selector: string) => selector === ".oo-canvas.hot" ? {} : null, querySelectorAll: () => [] }, queueMicrotask });
    const page = { locator: () => ({ boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 100 }) }), mouse: { move: vi.fn() }, evaluate: (code: string) => runInContext(code, context) };
    expect(await findOfficePersonPoint(page)).toBeNull();
  });
});
