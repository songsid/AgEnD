import { afterEach, describe, expect, it, vi } from "vitest";
import { fire } from "./helpers/mini-dom.js";
import { page, type AppPage } from "./helpers/app-harness.js";
const { createChatPosters } = await import(new URL("../src/ui/shared/effect-posters.js", import.meta.url).href);
const ID = "a".repeat(32), OTHER = "b".repeat(32), PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=", "base64"));
const held = () => { let resolve: (v?: any) => void = () => {}; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
async function flush() { for (let n = 0; n < 25; n++) await Promise.resolve(); }
const pages: AppPage[] = [], cleanups: (() => void)[] = [];
afterEach(async () => { for (const off of cleanups.splice(0)) off(); for (const pg of pages.splice(0)) { await pg.unmount(); pg.restore(); } vi.restoreAllMocks(); });
function fixture(patch: any = {}) {
  const pg = page(); pages.push(pg); const host: any = pg.window, element: any = pg.root;
  let now = 0, live = true, ended = false, visible = true, serial = 0;
  const auth = new Set<() => void>(), rafs = new Map<number, () => void>(), timers = new Map<number, () => void>(), bindings: any[] = [], decodes: any[] = [], observers: any[] = [];
  pg.document.body.dataset.mode = "full";
  Object.defineProperty(pg.document, "visibilityState", { configurable: true, get: () => visible ? "visible" : "hidden" });
  Object.assign(host, { innerWidth: 1366, innerHeight: 768, Blob, AbortController, performance: { now: () => now },
    URL: { createObjectURL: vi.fn(() => `blob:private-${++serial}`), revokeObjectURL: vi.fn() },
    requestAnimationFrame(fn: () => void) { rafs.set(++serial, fn); return serial; }, cancelAnimationFrame(n: number) { rafs.delete(n); },
    setTimeout(fn: () => void) { timers.set(++serial, fn); return serial; }, clearTimeout(n: number) { timers.delete(n); },
    MutationObserver: class { constructor(fn: () => void) { observers.push(fn); } observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} },
    AgendAuth: { sessionEnded: () => ended, onSessionEnd(fn: () => void) { auth.add(fn); if (ended) fn(); return () => auth.delete(fn); } },
  });
  element.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 100 });
  const create = pg.document.createElement.bind(pg.document);
  vi.spyOn(pg.document, "createElement").mockImplementation(((tag: string) => {
    const el: any = create(tag); if (tag === "img") {
      const decode = held(); decodes.push(decode); el.decode = () => patch.heldDecode ? decode.promise : Promise.resolve();
      Object.defineProperty(el, "naturalWidth", { get: () => 1 }); Object.defineProperty(el, "naturalHeight", { get: () => 1 });
    } return el;
  }) as never);
  const observation = { shown: true, fallback: true, ownerCss: "unknown" };
  const stock = { ok: true, front: false, agentFront: false, rects: [] };
  const reader = { ok: true, summary: vi.fn(async () => ({ rev: 1, posters: [{ id: ID, title: "Fixture" }] })), image: vi.fn(async () => PNG), dispose: vi.fn() };
  const geometry = { ok: true, hide: vi.fn(), dispose: vi.fn(), bind: vi.fn((_el: any, options: any) => { const h = { ok: true, hide: vi.fn(), sync: vi.fn(() => true), remove: vi.fn(), options }; bindings.push(h); return h; }) };
  patch.prepare?.({ host, element, observation, stock, reader, geometry });
  const args = { window: host, name: "own", element, current: () => live, observe: () => observation, factories: { reader: () => reader, geometry: () => geometry, stock: () => stock } };
  const api = createChatPosters(args); cleanups.push(() => api.dispose());
  return { api, host, pg, element, observation, stock, reader, geometry, bindings, decodes, observers, timers, args,
    at(n: number) { now = n; }, stale() { live = false; }, end() { ended = true; for (const fn of [...auth]) fn(); },
    hidden() { visible = false; fire(pg.document as any, "visibilitychange"); },
    frames() { const fs = [...rafs.values()]; rafs.clear(); for (const f of fs) f(); },
    nodes: () => [...pg.document.querySelectorAll("img.agend-effect-poster")],
  };
}
describe("#1629 static Chat poster ownership (geometry mocked here, native recipe proves IMG paint)", () => {
  it("forces behind/agent geometry before assigning the host-owned PNG URL; no Worker/frame/events/profile", async () => {
    const h = fixture(); h.api.sync(); await flush(); expect(h.api.snapshot()).toEqual({ failed: false, count: 1, ready: 1 });
    expect(h.bindings[0].options).toEqual({ layer: "behind", by: "agent" }); expect(h.bindings[0].sync).toHaveBeenCalledWith({ x: 0, y: 0, width: 100, height: 100 }, expect.objectContaining({ ok: true }));
    expect(h.nodes()[0].getAttribute("src")).toMatch(/^blob:private-/); expect(h.nodes()[0].getAttribute("aria-hidden")).toBe("true"); expect(h.nodes()[0].getAttribute("alt")).toBe("");
    expect(h.pg.document.querySelector("iframe,canvas")).toBeNull(); expect(h.reader.summary).toHaveBeenCalledOnce(); h.frames(); expect(h.reader.summary).toHaveBeenCalledOnce();
    h.api.dispose(); expect(h.nodes()).toEqual([]); expect(h.host.URL.revokeObjectURL).toHaveBeenCalledOnce(); expect(h.reader.dispose).toHaveBeenCalledOnce();
  });
  it("a host mutation hides immediately before the next fresh paint proof", async () => {
    const h = fixture(); h.api.sync(); await flush(); h.geometry.hide.mockClear(); h.bindings[0].sync.mockClear();
    h.observers[0](); expect(h.geometry.hide).toHaveBeenCalledOnce(); expect(h.bindings[0].sync).not.toHaveBeenCalled();
    h.frames(); expect(h.bindings[0].sync).toHaveBeenCalledWith({ x: 0, y: 0, width: 100, height: 100 }, expect.objectContaining({ ok: true }));
  });
  it.each(["switch", "preview", "hidden", "stock", "rect", "disconnected"])("%s gate removes existing posters and never keeps stale pixels", async fault => {
    const h = fixture(); h.api.sync(); await flush();
    if (fault === "switch") h.observation.shown = false; if (fault === "preview") h.observation.fallback = false;
    if (fault === "hidden") h.hidden(); if (fault === "stock") h.stock.ok = false;
    if (fault === "rect") h.element.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0 }); if (fault === "disconnected") h.element.remove();
    h.api.sync(); expect(h.nodes()).toEqual([]); expect(h.host.URL.revokeObjectURL).toHaveBeenCalledOnce();
  });
  it.each(["public", "no-preview", "reduced-motion", "save-data"])("static %s fallback does not require local runtime identity or preview facilities", async kind => {
    const h = fixture({ prepare({ host }: any) { if (kind === "public") host.document.body.dataset.publicLink = "1"; delete host.Worker; delete host.OffscreenCanvas; delete host.AgendPreview; } });
    h.api.sync(); await flush(); expect(h.api.snapshot().ready).toBe(1);
  });
  it.each(["view", "unknown-gate", "unknown-stock", "unsupported"])("%s cannot read or paint", async fault => {
    const h = fixture({ prepare({ host, observation, stock }: any) {
      if (fault === "view") host.document.body.dataset.mode = "view-only";
      if (fault === "unknown-gate") delete observation.shown; if (fault === "unknown-stock") delete stock.front;
      if (fault === "unsupported") delete host.ResizeObserver;
    } }); h.api.sync?.(); await flush(); expect(h.reader.summary).not.toHaveBeenCalled(); expect(h.nodes()).toEqual([]);
  });
  it.each(["geometry", "reader", "observer"])("partial %s setup failure cleans the empty root and leaves Chat intact", fault => {
    const h = fixture({ prepare({ host, geometry, reader }: any) {
      if (fault === "geometry") { geometry.ok = false; delete geometry.hide; }
      if (fault === "reader") reader.ok = false;
      if (fault === "observer") host.MutationObserver = class { constructor() { throw Error("unsupported"); } };
    } });
    expect(h.api.ok).toBe(false); expect(h.pg.document.querySelector(".agend-effect-layer")).toBeNull(); expect(h.reader.summary).not.toHaveBeenCalled(); expect(() => h.api.dispose()).not.toThrow();
  });
  it.each(["summary", "image", "decode"])("late %s completion after auth end cannot restore an image", async phase => {
    const wait = held(), h = fixture({ heldDecode: phase === "decode", prepare({ reader }: any) { if (phase !== "decode") reader[phase].mockImplementationOnce(() => wait.promise); } });
    h.api.sync(); await flush(); h.end(); expect(h.nodes()).toEqual([]);
    wait.resolve(phase === "summary" ? { rev: 1, posters: [{ id: ID, title: "Fixture" }] } : PNG); h.decodes[0]?.resolve(); await flush(); expect(h.nodes()).toEqual([]); expect(h.bindings.every(b => !b.sync.mock.calls.length)).toBe(true);
  });
  it("a changed revision drops old summary/decode ownership and never publishes the former identity", async () => {
    const wait = held(), h = fixture({ prepare({ reader }: any) { reader.summary.mockImplementationOnce(() => wait.promise); } });
    h.api.sync(); await flush(); h.api.changed(); wait.resolve({ rev: 1, posters: [{ id: OTHER, title: "old" }] }); await flush();
    expect(h.reader.summary).toHaveBeenCalledTimes(2); expect(h.reader.image).toHaveBeenCalledTimes(1); expect(h.reader.image).toHaveBeenCalledWith("own", ID, expect.any(AbortSignal));
  });
  it.each([9999, 10000, 10001])("decode completion at %i honors monotonic time even before the delayed timer", async at => {
    const h = fixture({ heldDecode: true }); h.api.sync(); await flush(); h.at(at); h.decodes[0].resolve(); await flush();
    expect(h.api.snapshot().ready).toBe(at < 10000 ? 1 : 0); expect(h.nodes().length).toBe(at < 10000 ? 1 : 0);
  });
  it("unknown read/cascade refusal latches instead of retrying on every animation frame", async () => {
    const h = fixture({ prepare({ reader }: any) { reader.image.mockResolvedValueOnce(null); } }); h.api.sync(); await flush();
    for (let n = 0; n < 5; n++) { h.frames(); h.api.sync(); } expect(h.api.snapshot().failed).toBe(true); expect(h.reader.summary).toHaveBeenCalledOnce(); expect(h.nodes()).toEqual([]);
    h.api.changed(); await flush(); expect(h.api.snapshot().ready).toBe(1);
  });
  it("never exceeds two decoded-but-unsettled images across replaced controllers", async () => {
    const h = fixture({ heldDecode: true, prepare({ reader }: any) { reader.summary.mockResolvedValue({ rev: 1, posters: [{ id: ID, title: "a" }, { id: OTHER, title: "b" }] }); } });
    h.api.sync(); await flush(); expect(h.decodes).toHaveLength(2); h.api.dispose();
    const next = createChatPosters(h.args); cleanups.push(() => next.dispose()); next.sync(); await flush(); expect(next.snapshot().failed).toBe(true); expect(h.decodes).toHaveLength(4); expect(h.nodes()).toEqual([]);
    h.decodes[0].resolve(); h.decodes[1].resolve(); await flush(); next.changed(); await flush(); expect(h.nodes()).toHaveLength(2);
  });
});
