import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let p: AppPage, module: any, manager: any, root: any, sash: any, header: any;
let w: any, stamp: any, observe: any;
const commit = vi.fn(), drop = vi.fn();
beforeAll(async () => { p = page(); (p.window as any).innerWidth = 1400; module = await import("/ui/js/chat-workspace-gestures.js"); });
beforeEach(() => {
  stamp = {}; w = { a: { route: { panel: "chat", instance: "alpha" } }, b: { route: { panel: "chat", instance: "beta" } }, focus: "b", layout: "right", ratio: .5 };
  root = p.document.createElement("div"); root.className = "chat-workspace"; root.getBoundingClientRect = () => ({ left: 100, top: 50, width: 1000, height: 800 });
  for (const [id, left] of [["a", 100], ["b", 604]] as const) { const pane = p.document.createElement("section"); pane.setAttribute("data-pane", id); pane.className = "ws-pane"; pane.getBoundingClientRect = () => ({ left, top: 50, right: left + 496, bottom: 850, width: 496, height: 800 }); root.appendChild(pane); }
  sash = p.document.createElement("div"); root.appendChild(sash); header = p.document.createElement("header"); root.querySelector('[data-pane="b"]').appendChild(header); p.root.appendChild(root);
  commit.mockReset(); drop.mockReset();
  manager = module.createWorkspaceGestures({ controller: { current: () => w, stamp: () => stamp, subscribe: (fn: any) => { observe = fn; return () => { observe = null; }; }, focus: () => {}, geometry: commit }, getRoot: () => root, onDrop: drop });
});
afterEach(() => { manager.close(); root.remove(); });
afterAll(() => p.restore());
const event = (more = {}) => ({ button: 0, pointerId: 7, clientX: 600, clientY: 300, currentTarget: sash, target: sash, preventDefault: vi.fn(), ...more });
const transfer = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "" });
it("shows an edge preview for an owned drag, commits once, and ignores a foreign payload", () => {
  fire(root, "drop", { clientX: 1090, clientY: 300, dataTransfer: transfer() }); expect(drop).not.toHaveBeenCalled();
  manager.dragStart("beta", event({ dataTransfer: transfer() }), "b");
  fire(root, "dragover", { clientX: 110, clientY: 300 });
  expect(p.document.querySelector('.ws-drop-overlay [data-zone="left"]')).not.toBeNull();
  const overlay = p.document.querySelector(".ws-drop-overlay"); fire(root, "dragover", { clientX: 111, clientY: 300 });
  expect(p.document.querySelector(".ws-drop-overlay")).toBe(overlay);
  fire(root, "drop", { clientX: 110, clientY: 300 }); expect(drop).toHaveBeenCalledExactlyOnceWith("beta", "a", "left");
  expect(p.document.querySelector(".ws-drop-overlay")).toBeNull();
});
it("positions the preview from real DOMRect-style prototype getters", () => {
  root.getBoundingClientRect = () => Object.create({ left: 100, top: 50, width: 1000, height: 800 });
  manager.dragStart("beta", event({ dataTransfer: transfer() }), "b"); fire(root, "dragover", { clientX: 110, clientY: 300 });
  expect((p.document.querySelector(".ws-drop-overlay") as any)?.style.width).toBe("1000px");
});
it("Esc consumes only the active arrangement and no late drop can act", () => {
  manager.dragStart("beta", event({ dataTransfer: transfer() }), "b"); fire(root, "dragover", { clientX: 110, clientY: 300 });
  const e = fire(p.document.body, "keydown", { key: "Escape" }); expect(e.defaultPrevented).toBe(true); expect(e.propagationStopped).toBe(true);
  fire(root, "drop", { clientX: 110, clientY: 300 }); expect(drop).not.toHaveBeenCalled();
  expect(fire(p.document.body, "keydown", { key: "Escape" }).defaultPrevented).toBe(false);
});
it("one pointer owns a sash; cancellation restores and release commits once", () => {
  manager.sashDown(event());
  p.window.dispatchEvent({ type: "pointermove", pointerId: 8, clientX: 800, clientY: 300 } as any); expect(manager.store.get().transient).toBeNull();
  p.window.dispatchEvent({ type: "pointermove", pointerId: 7, clientX: 800, clientY: 300 } as any); expect(manager.store.get().transient?.ratio).toBeGreaterThan(.5);
  p.window.dispatchEvent({ type: "pointercancel", pointerId: 7 } as any); expect(commit).not.toHaveBeenCalled(); expect(manager.store.get().transient).toBeNull();
  manager.sashDown(event()); p.window.dispatchEvent({ type: "pointermove", pointerId: 7, clientX: 700, clientY: 300 } as any); p.window.dispatchEvent({ type: "pointerup", pointerId: 7 } as any);
  expect(commit).toHaveBeenCalledTimes(1); expect(commit.mock.calls[0][0].ratio).toBeGreaterThan(.5);
});
it("a changed-and-restored navigation permanently cancels held work", () => {
  manager.sashDown(event()); const old = stamp; stamp = {}; observe(); stamp = old;
  p.window.dispatchEvent({ type: "pointermove", pointerId: 7, clientX: 800, clientY: 300 } as any); p.window.dispatchEvent({ type: "pointerup", pointerId: 7 } as any); expect(commit).not.toHaveBeenCalled();
});
it("a changed chat boundary or modal cancels instead of committing stale coordinates", () => {
  manager.sashDown(event()); p.window.dispatchEvent({ type: "pointermove", pointerId: 7, clientX: 800, clientY: 300 } as any);
  root.getBoundingClientRect = () => ({ left: 120, top: 50, width: 980, height: 800 });
  p.window.dispatchEvent({ type: "pointerup", pointerId: 7 } as any); expect(commit).not.toHaveBeenCalled();
  manager.sashDown(event()); p.window.dispatchEvent({ type: "pointermove", pointerId: 7, clientX: 800, clientY: 300 } as any);
  const dialog = p.document.createElement("dialog"); dialog.setAttribute("open", ""); p.root.appendChild(dialog);
  p.window.dispatchEvent({ type: "pointerup", pointerId: 7 } as any); dialog.remove(); expect(commit).not.toHaveBeenCalled();
});
it("free pointer move stays bounded, resize stays anchored, and an edge release docks", () => {
  w = { ...w, layout: "float", floating: "b", rect: { x: 100, y: 100, width: 500, height: 400 } };
  manager.floatDown("move", "b", event({ currentTarget: header }));
  p.window.dispatchEvent({ type: "pointermove", pointerId: 7, clientX: 760, clientY: 400 } as any);
  p.window.dispatchEvent({ type: "pointerup", pointerId: 7 } as any);
  expect(commit).toHaveBeenLastCalledWith({ rect: { x: 260, y: 200, width: 500, height: 400 } });
  manager.floatDown("resize", "b", event()); p.window.dispatchEvent({ type: "pointermove", pointerId: 7, clientX: 2000, clientY: 2000 } as any); p.window.dispatchEvent({ type: "pointerup", pointerId: 7 } as any);
  expect(commit).toHaveBeenLastCalledWith({ rect: { x: 100, y: 100, width: 900, height: 700 } });
  manager.floatDown("move", "b", event({ currentTarget: header })); p.window.dispatchEvent({ type: "pointermove", pointerId: 7, clientX: 110, clientY: 400 } as any); p.window.dispatchEvent({ type: "pointerup", pointerId: 7 } as any);
  expect(drop).toHaveBeenCalledExactlyOnceWith("beta", "a", "left");
});
it("sash keyboard uses16/64px, Home/End, and Enter resets while browser shortcuts remain untouched", () => {
  manager.sashKey(event({ key: "ArrowRight", shiftKey: true })); expect(commit.mock.lastCall?.[0].ratio).toBeCloseTo((496 + 64) / 992);
  manager.sashKey(event({ key: "Home" })); expect(commit.mock.lastCall?.[0].ratio).toBeCloseTo(360 / 992);
  manager.sashKey(event({ key: "Enter" })); expect(commit.mock.lastCall?.[0].ratio).toBe(.5);
  const e = event({ key: "1", ctrlKey: true }); manager.sashKey(e); expect(e.preventDefault).not.toHaveBeenCalled();
  const arrow = event({ key: "ArrowRight", ctrlKey: true }); manager.sashKey(arrow); expect(arrow.preventDefault).not.toHaveBeenCalled();
});
it("floating keyboard motion is bounded, reversible and committed only on Enter", () => {
  w = { ...w, layout: "float", floating: "b", rect: { x: 100, y: 100, width: 500, height: 400 } };
  manager.keyboard("move", "b"); fire(p.document.body, "keydown", { key: "ArrowRight" });
  expect(manager.store.get().transient?.rect.x).toBe(116); expect(commit).not.toHaveBeenCalled();
  fire(p.document.body, "keydown", { key: "Escape" }); expect(manager.store.get().transient).toBeNull(); expect(commit).not.toHaveBeenCalled();
  manager.keyboard("resize", "b"); fire(p.document.body, "keydown", { key: "ArrowDown", shiftKey: true }); fire(p.document.body, "keydown", { key: "Enter" });
  expect(commit).toHaveBeenCalledExactlyOnceWith({ rect: { x: 100, y: 100, width: 500, height: 464 } });
});
it("close removes all owned observers/listeners/preview and late events cannot commit", () => {
  const baseline = p.window.listenerCount(); manager.dragStart("beta", event({ dataTransfer: transfer() }), "b"); fire(root, "dragover", { clientX: 110, clientY: 300 });
  manager.close(); expect(observe).toBeNull(); expect(p.document.querySelector(".ws-drop-overlay")).toBeNull(); expect(p.window.listenerCount()).toBeLessThan(baseline);
  fire(root, "drop", { clientX: 110, clientY: 300 }); expect(drop).not.toHaveBeenCalled();
});
