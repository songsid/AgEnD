import { describe, expect, it, vi } from "vitest";
const { effectStockSnapshot, effectStockAllows } = await import(new URL("../src/ui/shared/effect-stock-snapshot.js", import.meta.url).href);
const rect = () => ({ x: -12.2, y: 3.4, width: 120.2, height: 80 });
const proof = (patch: any = {}) => ({ ok: true, front: true, agentFront: true, rects: [rect()], ...patch });
describe("closed host stock paint snapshots", () => {
  it("copies expanded paint rectangles independently and freezes every level", () => {
    const original = proof(), result = effectStockSnapshot(original);
    expect(result).toEqual(original); expect(result).not.toBe(original); expect(result.rects[0]).not.toBe(original.rects[0]);
    original.rects[0].width = 1; original.rects.length = 0;
    expect(result.rects).toEqual([rect()]); for (const value of [result, result.rects, result.rects[0]]) expect(Object.isFrozen(value)).toBe(true);
    expect(effectStockSnapshot(result)).toBe(result);
  });
  it("accepts current stock display metadata without forwarding it", () => {
    expect(effectStockSnapshot(proof({ reason: null, agentReason: "owner_css", settingsHref: "/ui/settings#appearance" }))).toEqual(proof());
  });
  it.each([null, true, false, Promise.resolve(proof()), {}, proof({ ok: false }), proof({ front: undefined, agentFront: false }), proof({ agentFront: "false" }), proof({ front: false }), proof({ extra: 1 }), proof({ reason: {} }), proof({ settingsHref: "x".repeat(257) }), proof({ rects: null }), proof({ rects: Array(1) }), proof({ rects: Array.from({ length: 129 }, rect) })])("refuses absent, weak or malformed evidence %j", value => {
    expect(effectStockSnapshot(value)).toBeNull(); expect(effectStockAllows(value, { layer: "behind", by: "human" })).toBe(false);
  });
  it.each(["ok", "front", "agentFront", "rects", "reason"])("does not read a %s getter", key => {
    const value = proof(), get = vi.fn(() => { throw Error("must not run"); }); Object.defineProperty(value, key, { enumerable: true, get });
    expect(effectStockSnapshot(value)).toBeNull(); expect(get).not.toHaveBeenCalled();
  });
  it.each(["x", "y", "width", "height"])("does not read a rectangle %s getter", key => {
    const value = proof(), get = vi.fn(() => 1); Object.defineProperty(value.rects[0], key, { get });
    expect(effectStockSnapshot(value)).toBeNull(); expect(get).not.toHaveBeenCalled();
  });
  it("does not invoke array entries and rejects extra array/symbol/rectangle keys", () => {
    const value = proof(), get = vi.fn(rect); Object.defineProperty(value.rects, "0", { get });
    expect(effectStockSnapshot(value)).toBeNull(); expect(get).not.toHaveBeenCalled();
    for (const v of [proof({ rects: Object.assign([rect()], { extra: 1 }) }), Object.assign(proof(), { [Symbol()]: true }), proof({ rects: [{ ...rect(), extra: 1 }] })]) expect(effectStockSnapshot(v)).toBeNull();
  });
  it.each([NaN, Infinity, -Infinity, "1", 1e7 + 1, -1e7 - 1])("refuses unbounded/non-numeric coordinate %j", x => expect(effectStockSnapshot(proof({ rects: [{ ...rect(), x }] }))).toBeNull());
  it.each(["width", "height"])("rejects negative %s but accepts zero", key => {
    expect(effectStockSnapshot(proof({ rects: [{ ...rect(), [key]: -1 }] }))).toBeNull();
    expect(effectStockSnapshot(proof({ rects: [{ ...rect(), [key]: 0 }] }))).not.toBeNull();
  });
  it("accepts exact count/coordinate bounds and null-prototype records; no DOMRect prototype", () => {
    expect(effectStockSnapshot(proof({ rects: Array.from({ length: 128 }, () => ({ x: -1e7, y: 1e7, width: 1e7, height: 0 })) }))).not.toBeNull();
    expect(effectStockSnapshot(Object.assign(Object.create(null), proof()))).not.toBeNull();
    class NativeRect { x = 0; y = 0; width = 10; height = 10; }
    expect(effectStockSnapshot(proof({ rects: [new NativeRect()] }))).toBeNull();
  });
  it.each(["human", "agent", undefined])("behind still needs stock ordering (%s)", by => {
    expect(effectStockAllows(proof({ front: false, agentFront: false }), { layer: "behind", by })).toBe(true);
    expect(effectStockAllows(null, { layer: "behind", by })).toBe(false);
    expect(effectStockAllows(proof(), { layer: "unknown", by })).toBe(false);
  });
  it("owner CSS restricts agent fronts; overlays restrict both; missing provenance stays agent", () => {
    const css = proof({ agentFront: false });
    expect(effectStockAllows(css, { layer: "front", by: "agent" })).toBe(false); expect(effectStockAllows(css, { layer: "front" })).toBe(false);
    expect(effectStockAllows(css, { layer: "front", by: "human" })).toBe(true);
    expect(effectStockAllows(proof({ front: false, agentFront: false }), { layer: "front", by: "human" })).toBe(false);
  });
});
