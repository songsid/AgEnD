import { afterEach, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let p: AppPage, app: any, nav: any;
const start = vi.fn(() => true), end = vi.fn();
afterEach(async () => { if (p) { await p.unmount(); p.restore(); } app?.appStore.set({ chatWorkspace: null }); start.mockClear(); end.mockClear(); });
async function mount(opts: { retained?: boolean; filtered?: boolean; favorite?: boolean; recent?: boolean; guest?: boolean } = {}) {
  p = page({ url: "http://127.0.0.1/ui/chat/alpha" });
  if (opts.guest) p.document.body.dataset.tier = "guest";
  app = await import("/assets/app-store.js"); nav = await import("/assets/instance-nav.js");
  const instances = ["alpha", "beta"].map(name => ({ name, tags: ["Group"], backend: "codex", status: "running" }));
  app.applyStatus({ instances }); app.appStore.set({ chatWorkspace: { open() {}, label: () => "Open beside", ...(opts.retained ? {} : { dragStart: start, dragEnd: end }) } });
  nav.navStore.set({ order: { groups: new Map(), insts: new Map() }, collapsed: new Set(), filter: { q: opts.filtered ? "beta" : "", status: [], cli: [] },
    favorites: opts.favorite ? ["beta"] : [], sort: { mode: opts.recent ? "recent" : "custom", favs: "fixed" } });
  await p.mount(h(nav.InstanceNav, { route: { panel: "chat", instance: "alpha" }, items: instances })); await settle(3);
  return [...p.root.querySelectorAll("a.inst")].find((el: any) => el.querySelector(".inst-name")?.textContent === "beta")!;
}
const transfer = () => ({ effectAllowed: "", setData: vi.fn() });
// mini-dom has no native ondrag* properties; Preact keeps the custom-event spelling there.
const drag = (el: any, type: string, props = {}) => fire(el, el._listeners.has(type) ? type : type === "drop" ? "Drop" : `Drag${type.slice(4, 5).toUpperCase()}${type.slice(5)}`, props);
it.each([{ filtered: true }, { favorite: true }, { recent: true }])("docks an agent from %j without turning a partial list into reorder authority", async opts => {
  const row = await mount(opts), before = JSON.stringify([...nav.navStore.get().order.insts]);
  expect(row.getAttribute("draggable")).toBe("true");
  drag(row, "dragstart", { dataTransfer: transfer() }); expect(start).toHaveBeenCalledWith("beta", expect.anything());
  expect(drag(row, "dragover", { clientY: 1 }).defaultPrevented).toBe(false);
  drag(row, "drop"); expect(JSON.stringify([...nav.navStore.get().order.insts])).toBe(before);
  drag(row, "dragend"); expect(end).toHaveBeenCalledOnce();
});
it("retained workspace entry keeps the old filtered list non-draggable", async () => {
  const row = await mount({ retained: true, filtered: true }); expect(row.getAttribute("draggable")).toBeNull();
});
it("normal custom ordering still reorders and an outside attachment is not adopted", async () => {
  const row = await mount(), first = p.root.querySelector('a.inst[href="/ui/chat/alpha"]')!;
  const before = JSON.stringify([...nav.navStore.get().order.insts]); drag(first, "drop", { dataTransfer: transfer() });
  expect(JSON.stringify([...nav.navStore.get().order.insts])).toBe(before);
  drag(row, "dragstart", { dataTransfer: transfer() }); drag(first, "dragover", { clientY: -1 }); drag(first, "drop"); drag(row, "dragend");
  expect([...nav.navStore.get().order.insts]).toEqual([["beta", 0], ["alpha", 1]]); expect(end).toHaveBeenCalledOnce();
});
it("a guest gets no new drag entry", async () => { const row = await mount({ guest: true }); expect(row.getAttribute("draggable")).toBeNull(); });
