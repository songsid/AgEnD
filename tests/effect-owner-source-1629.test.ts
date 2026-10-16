/** Unmounted source-model controls; loader, target geometry and registry caps are separate suites. */
import { describe, expect, it, vi } from "vitest";
import { isServedAsset } from "../src/auth-api.js";
const { createOwnerEffectSource } = await import(new URL("../src/ui/shared/effect-owner-source.js", import.meta.url).href);
const A = "a".repeat(32), B = "b".repeat(32), slots = ["fx.page", "fx.header", "fx.sidebar", "fx.box"];
const manifest = () => ({ v: 1, kind: "effect", runtime: "canvas-worker-v1", worker: "worker.js", name: "test", title: "Test", regions: ["chat", "page", "header", "sidebar", "box"], layer: "front", wants: ["state"], box: { anchor: "center", width: 100, height: 80, offset: 0 } });
const body = (id = A, rev = 1) => ({ rev, slots: { ...Object.fromEntries(slots.map(slot => [slot, { status: "available", id, manifest: manifest() }])), "fx.cursor": { status: "none", id: null } } });
const held = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { resolve, promise }; };
function rig() {
  let live = true; const elements: any = Object.fromEntries(slots.map(slot => [slot, { isConnected: true }])), change = vi.fn(), unavailable = vi.fn(), data: any = { value: body(), proof: { ok: true, front: true, agentFront: true, rects: [] } };
  const options = { current: () => live, readMetadata: vi.fn(async (_signal: any): Promise<any> => data.value), readResource: vi.fn(async (spec: any, _signal: any): Promise<any> => ({ id: spec.id, params: {} })), resolveTarget: vi.fn((slot: string) => elements[slot]), stock: () => data.proof, onChange: change, onUnavailable: unavailable };
  const api = createOwnerEffectSource(options); return { api, elements, options, data, change, unavailable, stale() { live = false; } };
}
describe("#1629 optional personal effect source model", () => {
  it("is a static inert helper and does no eager I/O or target resolution", () => { const h = rig(); expect(h.api.ok).toBe(true); expect(isServedAsset("effect-owner-source.js")).toBe(true); expect(h.options.readMetadata).not.toHaveBeenCalled(); expect(h.options.resolveTarget).not.toHaveBeenCalled(); h.api.dispose(); });
  it("projects four human owner descriptors in fixed order, never cursor, Chat instance or agent provenance", async () => {
    const h = rig(); expect(await h.api.read()).toBe(true); const rows = h.api.descriptors(); expect(rows.map((r: any) => r.region)).toEqual(["page", "header", "sidebar", "box"]); expect(new Set(rows.map((r: any) => r.key)).size).toBe(4);
    for (const r of rows) expect(r).toMatchObject({ id: A, by: "human", instance: null, layer: "front", visible: true, paused: false }); expect(h.options.resolveTarget).toHaveBeenCalledTimes(4); h.api.dispose();
  });
  it("exact key/id/slot capture survives only its own current target", async () => {
    const h = rig(); await h.api.read(); const rows = h.api.descriptors(), a = h.api.binding(rows[0].key, A); expect(Object.isFrozen(a)).toBe(true);
    expect(h.api.binding(rows[0].key, B)).toBeNull(); expect(h.api.binding(A, A)).toBeNull(); expect(await h.api.load(a)).toMatchObject({ id: A }); expect(h.options.readResource).toHaveBeenCalledExactlyOnceWith({ id: A, slot: "fx.page" }, undefined);
    h.elements["fx.page"] = { isConnected: true }; const next = h.api.descriptors()[0]; expect(next.key).not.toBe(rows[0].key); expect(h.api.current(a)).toBe(false); expect(await h.api.load(a)).toBeNull(); h.api.dispose();
  });
  it("same-id target replacement fences a held old success and failure", async () => {
    for (const result of [null, { id: A }]) { const h = rig(); await h.api.read(); const old = h.api.descriptors()[0], b = h.api.binding(old.key, A), pending = held(); h.options.readResource.mockImplementationOnce(() => pending.promise); const job = h.api.load(b);
      h.elements["fx.page"] = { isConnected: true }; const next = h.api.descriptors()[0]; pending.resolve(result); expect(await job).toBeNull(); expect(h.api.binding(next.key, A)).not.toBeNull(); expect(h.unavailable).not.toHaveBeenCalled(); h.api.dispose(); }
  });
  it("resource refusal affects only its captured slot and preserves the stored selected id", async () => {
    const h = rig(); await h.api.read(); const row = h.api.descriptors()[0]; h.options.readResource.mockResolvedValueOnce(null); expect(await h.api.load(h.api.binding(row.key, A))).toBeNull();
    expect(h.api.snapshot().slots["fx.page"]).toEqual({ status: "unavailable", id: A }); expect(h.api.descriptors()).toHaveLength(3); expect(h.unavailable).toHaveBeenCalledExactlyOnceWith("fx.page", A); expect(h.options.readMetadata).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("a refusal callback cannot mark a newer generation unavailable after onChange invalidates", async () => {
    const h = rig(); await h.api.read(); const descriptor = h.api.descriptors()[0], b = h.api.binding(descriptor.key, A); h.change.mockImplementationOnce(() => h.api.invalidate()); h.options.readResource.mockResolvedValueOnce(null);
    expect(await h.api.load(b)).toBeNull(); expect(h.unavailable).not.toHaveBeenCalled(); expect(h.api.needsMetadata()).toBe(true); h.api.dispose();
  });
  it("keeps physical metadata ownership with its caller while invalidation fences the answer", async () => {
    const h = rig(), pending = held(); h.options.readMetadata.mockImplementationOnce(() => pending.promise); const first = h.api.read(); h.api.invalidate(); expect(await h.api.read()).toBe(false); expect(h.options.readMetadata).toHaveBeenCalledOnce();
    pending.resolve(body(A)); expect(await first).toBe(false); expect(h.api.snapshot().slots["fx.page"].status).toBe("unknown"); expect(await h.api.read()).toBe(true); expect(h.options.readMetadata).toHaveBeenCalledTimes(2); h.api.dispose();
  });
  it.each(["malformed", "stale", "throw"])("%s metadata latches without autonomous retries until invalidation", async kind => {
    const h = rig(); await h.api.read(); h.api.invalidate(); if (kind === "malformed") h.data.value = {}; if (kind === "stale") h.data.value = body(A, 0); if (kind === "throw") h.options.readMetadata.mockRejectedValueOnce(Error("network"));
    expect(await h.api.read()).toBe(false); expect(h.api.needsMetadata()).toBe(false); expect(await h.api.read()).toBe(false); expect(h.options.readMetadata).toHaveBeenCalledTimes(2); h.data.value = body(B, 2); h.api.invalidate(); expect(await h.api.read()).toBe(true); h.api.dispose();
  });
  it("preserves manual pauses through unrelated metadata revisions, but not a different selection", async () => {
    const h = rig(); await h.api.read(); h.api.descriptors(); expect(h.api.pause("fx.page")).toBe(true); h.api.invalidate(); h.data.value = body(A, 2); await h.api.read(); expect(h.api.descriptors()[0].paused).toBe(true);
    h.api.invalidate(); h.data.value = body(B, 3); await h.api.read(); expect(h.api.descriptors()[0].paused).toBe(false); expect(h.api.pause("fx.cursor")).toBe(false); expect(h.api.unpause("unknown")).toBe(false); h.api.dispose();
  });
  it("unknown proof or missing/disconnected target retires binding identity without fetching or retrying metadata", async () => {
    const h = rig(); await h.api.read(); const first = h.api.descriptors()[0]; h.data.proof = { ok: false }; expect(h.api.descriptors()).toEqual([]); expect(h.api.binding(first.key, A)).toBeNull(); h.data.proof = { ok: true, front: false, agentFront: false, rects: [] };
    h.elements["fx.page"].isConnected = false; expect(h.api.descriptors()).toHaveLength(3); expect(h.options.readMetadata).toHaveBeenCalledOnce(); expect(h.options.readResource).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("resolver reentry invalidates the older metadata/descriptor pass", async () => {
    const h = rig(); await h.api.read(); h.options.resolveTarget.mockImplementationOnce(() => { h.api.invalidate(); return h.elements["fx.page"]; }); expect(h.api.descriptors()).toEqual([]); expect(h.api.snapshot().slots["fx.page"].status).toBe("unknown"); h.api.dispose();
  });
  it.each(["stale", "dispose", "abort"])("%s fences a held resource without poisoning another slot", async kind => {
    const h = rig(); await h.api.read(); const row = h.api.descriptors()[0], pending = held(), controller = new AbortController(); h.options.readResource.mockImplementationOnce(() => pending.promise); const job = h.api.load(h.api.binding(row.key, A), controller.signal);
    if (kind === "stale") h.stale(); if (kind === "dispose") h.api.dispose(); if (kind === "abort") controller.abort(); pending.resolve(null); expect(await job).toBeNull(); expect(h.unavailable).not.toHaveBeenCalled(); h.api.dispose();
  });
});

describe("fifth personal cursor receipt without a frame descriptor", () => {
  const cursorBody = (id = A, rev = 1) => { const b: any = body(id, rev); b.slots["fx.cursor"] = { status: "available", id, manifest: { ...manifest(), cursor: { hotspot: [2, 3] } } }; return b; };
  it("returns a frozen exact cursor generation from the same authoritative metadata, never a descriptor/resource or pause target", async () => {
    const h = rig(); h.data.value = cursorBody(); await h.api.read(); const c = h.api.cursorSelection(); expect(c).toEqual({ id: A, generation: 0, hotspot: [2, 3] }); expect(Object.isFrozen(c)).toBe(true); expect(Object.isFrozen(c.hotspot)).toBe(true);
    expect(h.api.cursorSelection()).toBe(c); expect(h.api.cursorCurrent({ ...c, hotspot: [2, 3] })).toBe(true); expect(h.api.snapshot().slots["fx.cursor"]).toMatchObject({ id: A, status: "available" }); expect(h.api.descriptors()).toHaveLength(4); expect(h.api.pause("fx.cursor")).toBe(false); expect(h.options.readResource).not.toHaveBeenCalled();
    h.api.invalidate(); expect(h.api.cursorCurrent(c)).toBe(false); expect(h.api.cursorSelection()).toBeNull(); h.data.value = cursorBody(A, 2); await h.api.read(); expect(h.api.cursorSelection()).toEqual({ ...c, generation: 1 }); h.api.dispose();
  });
  it("refuses wrong id/generation/hotspot, extra/accessor/sparse values without invoking a getter", async () => {
    const h = rig(); h.data.value = cursorBody(); await h.api.read(); const c = h.api.cursorSelection(), getter = vi.fn(() => A);
    for (const bad of [{ ...c, id: B }, { ...c, generation: 9 }, { ...c, hotspot: [3, 2] }, { ...c, extra: true }, { ...c, hotspot: Array(2) }, { ...c, get id() { return getter(); } }]) expect(h.api.cursorCurrent(bad)).toBe(false);
    expect(getter).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("a local cursor read refusal preserves its saved id, keeps four frame slots and latches without metadata retries", async () => {
    const h = rig(); h.data.value = cursorBody(); await h.api.read(); const c = h.api.cursorSelection(); h.api.refuseCursor(c);
    expect(h.api.cursorSelection()).toBeNull(); expect(h.api.cursorCurrent(c)).toBe(false); expect(h.api.snapshot().slots["fx.cursor"]).toEqual({ status: "unavailable", id: A }); expect(h.api.descriptors()).toHaveLength(4); expect(h.unavailable).toHaveBeenCalledExactlyOnceWith("fx.cursor", A); expect(h.options.readMetadata).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("stale or reentrant cursor refusal cannot mark the next generation unavailable", async () => {
    const h = rig(); h.data.value = cursorBody(); await h.api.read(); const old = h.api.cursorSelection(); h.api.invalidate(); h.data.value = cursorBody(A, 2); await h.api.read(); h.api.refuseCursor(old); expect(h.api.cursorSelection()).not.toBeNull(); expect(h.unavailable).not.toHaveBeenCalled();
    h.change.mockImplementationOnce(() => h.api.invalidate()); h.api.refuseCursor(h.api.cursorSelection()); expect(h.unavailable).not.toHaveBeenCalled(); expect(h.api.needsMetadata()).toBe(true); h.api.dispose();
  });
  it("cursor metadata is independent of frame paint proof/targets but still dies with its source", async () => {
    const h = rig(); h.data.value = cursorBody(); await h.api.read(); const c = h.api.cursorSelection(); h.data.proof = null; expect(h.api.descriptors()).toEqual([]); expect(h.api.cursorCurrent(c)).toBe(true); h.stale(); expect(h.api.cursorSelection()).toBeNull(); expect(h.api.cursorCurrent(c)).toBe(false); h.api.dispose();
  });
});

it("reflective receipt reentry cannot certify a pre-invalidation cursor generation", async () => {
  const h = rig(), b: any = body(); b.slots["fx.cursor"] = { id: A, status: "available", manifest: { ...manifest(), cursor: { hotspot: [0, 0] } } }; h.data.value = b; await h.api.read();
  const own = h.api.cursorSelection(); let hit = false;
  const value = new Proxy({ ...own, hotspot: [...own.hotspot] }, { ownKeys(target) { if (!hit) { hit = true; h.api.invalidate(); } return Reflect.ownKeys(target); } });
  expect(h.api.cursorCurrent(value)).toBe(false); expect(h.api.cursorSelection()).toBeNull(); h.api.dispose();
});
