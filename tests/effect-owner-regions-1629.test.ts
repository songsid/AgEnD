import { afterEach, describe, expect, it, vi } from "vitest";
import { isServedAsset } from "../src/auth-api.js";
import { page, type AppPage } from "./helpers/app-harness.js";
const { ownerEffectBoxRect, createOwnerEffectRegions } = await import(new URL("../src/ui/shared/effect-owner-regions.js", import.meta.url).href);
const proof = () => ({ ok: true, front: false, agentFront: false, rects: [] }), box = (anchor = "top-right", patch = {}) => ({ anchor, width: 100, height: 80, offset: 16, ...patch });
const domRect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height });
const pages: AppPage[] = [], cleanups: (() => void)[] = [];
afterEach(async () => { for (const off of cleanups.splice(0)) off(); for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } });
function fixture(initialPanel = true) {
  const p = page(); pages.push(p); const host: any = p.window; let live = true, onCurrent = () => live;
  p.document.body.dataset.mode = "full"; p.root.className = "main"; const chat = p.document.createElement("section"); chat.className = "panel p-chat"; if (initialPanel) p.root.append(chat);
  const header = p.document.createElement("header"); header.className = "panel-head"; header.setAttribute("data-trust", "header"); chat.append(header);
  Object.assign(host, { innerWidth: 800, innerHeight: 600, getComputedStyle: (el: any) => ({ display: "block", visibility: el.hiddenState ? "hidden" : "visible", transform: "none", perspective: "none", filter: "none", contain: "none", willChange: "auto" }) });
  header.getBoundingClientRect = () => domRect(0, 0, 800, 50);
  const bindings: any[] = [];
  const geometry = { ok: true, dispose: vi.fn(() => { for (const b of bindings) b.remove(); }), bind: vi.fn((element: any, options: any) => {
    element.hiddenState = true; let rect: any = null;
    element.getBoundingClientRect = () => rect;
    const b = { ok: true, options, element, sync: vi.fn((r: any) => { rect = r; element.hiddenState = false; return true; }), hide: vi.fn(() => { element.hiddenState = true; }), remove: vi.fn(() => element.remove()) }; bindings.push(b); return b;
  }) };
  const api = createOwnerEffectRegions({ window: host, current: () => onCurrent(), factories: { geometry: () => geometry } }); cleanups.push(() => api.dispose());
  return { p, host, chat, header, geometry, bindings, api, stale() { live = false; }, current(fn: () => boolean) { onCurrent = fn; } };
}
describe("#1629 host-owned anchored box rectangles", () => {
  it.each([["top-left", 16, 16], ["top-right", 684, 16], ["bottom-left", 16, 504], ["bottom-right", 684, 504], ["center", 350, 260]])("%s uses bounded viewport axes", (anchor, x, y) => {
    expect(ownerEffectBoxRect(box(anchor as string), { width: 800, height: 600 })).toEqual({ x, y, width: 100, height: 80 });
  });
  it("shrinks oversized edges within padding; center uses all available size and ignores offset", () => {
    expect(ownerEffectBoxRect(box("bottom-right", { width: 480, height: 480 }), { width: 390, height: 300 })).toEqual({ x: 16, y: 16, width: 358, height: 268 });
    expect(ownerEffectBoxRect(box("center", { width: 480, height: 480, offset: 64 }), { width: 390, height: 301 })).toEqual({ x: 0, y: 0, width: 390, height: 301 });
    expect(ownerEffectBoxRect(box("top-left", { offset: 64 }), { width: 128, height: 300 })).toBeNull();
  });
  it.each([{ anchor: "other" }, { width: 31 }, { width: 481 }, { height: NaN }, { offset: -1 }, { offset: 65 }, { offset: 0.5 }, { extra: true }])("unknown box %s refuses", patch => expect(ownerEffectBoxRect(box("center", patch), { width: 800, height: 600 })).toBeNull());
  it("refuses getters without invoking them and unbounded/unknown viewport dimensions", () => {
    const get = vi.fn(() => 100), b = box(); Object.defineProperty(b, "width", { get }); expect(ownerEffectBoxRect(b, { width: 800, height: 600 })).toBeNull(); expect(get).not.toHaveBeenCalled();
    for (const size of [null, { width: 0, height: 1 }, { width: 4097, height: 1 }, { width: 4096, height: 4096 }, { width: 1.5, height: 5 }]) expect(ownerEffectBoxRect(box(), size)).toBeNull();
  });
});
describe("personal region target primitive (geometry mocked; native recipe is separate)", () => {
  it("serves the reviewed owner adapter target helper through the fixed map", () => expect(isServedAsset("effect-owner-regions.js")).toBe(true));
  it("returns actual protected Chat header and hidden host-owned page/box references; creates no frame/code", () => {
    const h = fixture(); expect(h.api.ok).toBe(true); expect(h.api.resolve("fx.header", null, proof())).toBe(h.header);
    const page = h.api.resolve("fx.page", null, proof()), small = h.api.resolve("fx.box", box(), proof()); expect(page).not.toBe(small);
    expect(page.getBoundingClientRect()).toEqual({ x: 0, y: 0, width: 800, height: 600 }); expect(small.getBoundingClientRect()).toEqual({ x: 684, y: 16, width: 100, height: 80 });
    expect(h.bindings.every(b => b.element.hiddenState && b.options.layer === "behind" && b.options.by === "human")).toBe(true);
    expect(page.getAttribute("aria-hidden")).toBe("true"); expect(h.p.document.querySelector("iframe,canvas,input")).toBeNull();
    expect(h.api.resolve("fx.page", null, proof())).toBe(page); expect(h.bindings).toHaveLength(2);
    h.api.dispose(); expect(page.isConnected).toBe(false); expect(small.isConnected).toBe(false); expect(h.header.isConnected).toBe(true);
  });
  it.each(["fleet", "needs", "settings", "view", "log", "details"])("uses only the exact protected %s panel header and hidden page/box references", kind => {
    const h = fixture(); h.chat.className = `panel p-${kind}`; h.chat.setAttribute("data-effect-panel", kind);
    expect(h.api.resolve("fx.header", null, proof())).toBe(h.header); expect(h.api.resolve("fx.page", null, proof()).hiddenState).toBe(true); expect(h.api.resolve("fx.box", box(), proof()).hiddenState).toBe(true);
    expect(h.p.document.querySelector("iframe,canvas,input")).toBeNull();
  });
  it("can own empty references before the first panel commits, but resolves nothing until a closed panel and proof exist", () => {
    const h = fixture(false); expect(h.api.ok).toBe(true); expect(h.api.resolve("fx.page", null, proof())).toBeNull(); expect(h.bindings).toEqual([]);
    h.p.root.append(h.chat); expect(h.api.resolve("fx.page", null, proof()).hiddenState).toBe(true);
  });
  it.each(["unmarked", "unknown-kind", "mismatch", "duplicate", "nested-header"])("%s is not a global stock target even with a modeled positive proof", fault => {
    const h = fixture(); h.api.resolve("fx.page", null, proof());
    if (fault === "unmarked") h.chat.className = "panel p-fleet";
    if (fault === "unknown-kind") { h.chat.className = "panel p-other"; h.chat.setAttribute("data-effect-panel", "other"); }
    if (fault === "mismatch") h.chat.setAttribute("data-effect-panel", "fleet");
    if (fault === "duplicate") { const p = h.p.document.createElement("section"); p.className = "panel p-chat"; h.p.root.append(p); }
    if (fault === "nested-header") { const wrap = h.p.document.createElement("div"); h.chat.append(wrap); wrap.append(h.header); }
    expect(h.api.resolve("fx.header", null, proof())).toBeNull();
    if (fault !== "nested-header") { expect(h.api.resolve("fx.page", null, proof())).toBeNull(); expect(h.bindings[0].element.hiddenState).toBe(true); }
  });
  it("a synchronous header layout callback cannot return a target after changing its route or ending its owner", () => {
    const h = fixture(); h.header.getBoundingClientRect = () => { h.stale(); return domRect(0, 0, 800, 50); }; expect(h.api.resolve("fx.header", null, proof())).toBeNull();
  });
  it.each(["missing-marker", "duplicate", "hidden", "offscreen", "foreign", "transformed"])("actual header %s is unavailable", fault => {
    const h = fixture();
    if (fault === "missing-marker") h.header.removeAttribute("data-trust");
    if (fault === "duplicate") { const other = h.p.document.createElement("header"); other.className = "panel-head"; other.setAttribute("data-trust", "header"); h.chat.append(other); }
    if (fault === "hidden") { const original = h.host.getComputedStyle; h.host.getComputedStyle = (el: any) => ({ ...original(el), visibility: el === h.header ? "hidden" : "visible" }); }
    if (fault === "foreign") Object.defineProperty(h.header, "ownerDocument", { value: {}, configurable: true });
    if (fault === "transformed") { const original = h.host.getComputedStyle; h.host.getComputedStyle = (el: any) => ({ ...original(el), transform: el === h.header ? "translateX(1px)" : "none" }); }
    if (fault === "offscreen") h.header.getBoundingClientRect = () => domRect(-900, 0, 800, 50);
    expect(h.api.resolve("fx.header", null, proof())).toBeNull(); expect(h.bindings).toEqual([]);
  });
  it("sidebar uses only its actual stock element and refuses a hidden or offscreen drawer", () => {
    const h = fixture(), shell = h.p.document.createElement("div"), side = h.p.document.createElement("aside"); shell.className = "shell"; side.className = "sidebar"; h.p.document.body.append(shell); shell.append(side);
    side.getBoundingClientRect = () => domRect(0, 0, 260, 600); expect(h.api.resolve("fx.sidebar", null, proof())).toBe(side);
    side.getBoundingClientRect = () => domRect(-260, 0, 260, 600); expect(h.api.resolve("fx.sidebar", null, proof())).toBeNull();
    expect(h.bindings).toEqual([]);
  });
  it("a lease callback that disposes cannot return a target from the old owner", () => {
    const h = fixture(); h.api.resolve("fx.page", null, proof()); h.current(() => { h.api.dispose(); return true; });
    expect(h.api.resolve("fx.header", null, proof())).toBeNull(); expect(h.header.isConnected).toBe(true); expect(h.p.document.querySelector(".agend-owner-effect-target")).toBeNull();
  });
  it.each(["missing-proof", "bad-proof", "stale", "route", "viewport"])("%s refuses before continuing geometry", fault => {
    const h = fixture(); h.api.resolve("fx.page", null, proof()); const b = h.bindings[0]; b.sync.mockClear();
    if (fault === "stale") h.stale(); if (fault === "route") h.chat.className = "other"; if (fault === "viewport") h.host.innerWidth = 4097;
    expect(h.api.resolve("fx.page", null, fault === "missing-proof" ? null : fault === "bad-proof" ? { ...proof(), ok: false } : proof())).toBeNull(); expect(b.hide).toHaveBeenCalled(); expect(b.sync).not.toHaveBeenCalled();
  });
  it.each(["sync", "actual", "visibility"])("failed %s removes only its synthetic reference", fault => {
    const h = fixture(); const p = h.api.resolve("fx.page", null, proof()), b = h.bindings[0];
    if (fault === "sync") b.sync.mockReturnValue(false); if (fault === "actual") p.getBoundingClientRect = () => ({ x: 1, y: 0, width: 800, height: 600 }); if (fault === "visibility") b.hide.mockImplementation(() => {});
    expect(h.api.resolve("fx.page", null, proof())).toBeNull(); expect(p.isConnected).toBe(false); expect(h.header.isConnected).toBe(true);
  });
  it("unknown slots, cursor and absent sidebar do not allocate a synthetic reference", () => {
    const h = fixture(); for (const slot of ["fx.sidebar", "fx.cursor", "unknown"]) expect(h.api.resolve(slot, box(), proof())).toBeNull(); expect(h.bindings).toEqual([]);
  });
});
