import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { readableShade as priorDarkShade } from "../src/web-identity-color.js";

let p: AppPage, ctx: any, host: any, app: any, roster: any;
const inst = { name: "alpha", backend: "claude-code", status: "running", model: "opus", effort: "auto", color: { person: "preset:lime" }, color_show: { person: ["name", "bar"] } };
const control = { focus: vi.fn(), layout: vi.fn(), swap: vi.fn(), closePane: vi.fn(), focusedName: () => "alpha", current: () => null };
const pane = { id: "a", name: "alpha", route: { panel: "chat", instance: "alpha" }, focused: true, width: 700,
  tabs: ["chat", "log"], visibleTabs: ["chat"], layout: "right", controller: control, navigate: vi.fn(),
  controls: { show() {}, release() {}, move() {} }, gestures: {} };
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/chat/alpha", storage: { agend_tour_done: "1" } });
  p.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: {} }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
  ctx = await import("/assets/app-ctx.js"); host = await import("/ui/js/chat-workspace.js");
  app = await import("/assets/app-store.js"); roster = await import("/assets/instance-nav.js");
  app.applyStatus({ instances: [inst] });
});
afterEach(async () => { await p.unmount(); pane.focused = true; delete p.document.body.dataset.tier; delete p.document.body.dataset.publicLink; app.applyStatus({ instances: [inst] }); vi.clearAllMocks(); });
afterAll(() => { p.restore(); vi.unstubAllGlobals(); });

async function menu(actions: any[] = []) {
  await p.mount(h(ctx.PaneScope, { value: pane }, h(host.PaneHeader, { title: "alpha", pageActions: actions })));
  fire(p.root.querySelector('.panel-actions .menu > button')!, "click"); await settle(4);
  return p.root.querySelector('[role="menu"]') as any;
}
describe("the pane menu uses the same icon rows as the sidebar", () => {
  it("keeps one Split, replaces legacy model commands with Settings, and groups every action", async () => {
    const list = await menu([
      { key: "splitChat", label: "Split chat", onSelect() {} },
      { key: "retained-split-key", label: "Split chat", onSelect() {} },
      { key: "pane-backend", label: "Select backend", onSelect() {} },
      { key: "pane-model", label: "Model: old", onSelect() {} },
      { key: "pane-effort", label: "Effort: old", onSelect() {} },
      { key: "details", label: "Agent details", icon: "info", onSelect() {} },
      { key: "identity-color", label: "Identity colour", icon: "palette", onSelect() {} },
      { key: "fullWidth", label: "Full width", checkbox: true, checked: false, onSelect() {} },
      { key: "delete", label: "Delete agent", icon: "trash", danger: true, onSelect() {} },
    ]);
    const buttons = [...list.querySelectorAll("button")];
    expect(buttons.filter((b: any) => b.textContent === "Split chat")).toHaveLength(1);
    expect(list.textContent).not.toMatch(/Select backend|Model: old|Effort: old/);
    expect([...list.querySelectorAll(".menu-heading")].map((n: any) => n.textContent)).toEqual(["Pane", "Agent", "Appearance", "Delete"]);
    for (const b of buttons) expect(b.querySelector(".icon"), b.textContent).not.toBeNull();
    const model: any = buttons.find((b: any) => b.textContent.startsWith("Model and effort…"));
    expect(model).toBeTruthy(); expect(model.querySelector(".menu-value").textContent).toContain("auto");
    fire(model, "click"); expect(pane.navigate).toHaveBeenCalledWith("/ui/fleet/agent/alpha?cat=runtime");
  });
  it("uses one sidebar action slot whose first item toggles favourites, with keyboard return", async () => {
    roster.navStore.set({ favorites: ["alpha"], filter: { q: "", status: [], cli: [] } });
    await p.mount(h(roster.InstanceNav, { route: pane.route, items: [inst], loaded: true })); await settle(4);
    expect(p.root.querySelectorAll(".inst-star, .inst-gear")).toHaveLength(0);
    const row = p.root.querySelector(".v-li"), trigger: any = row.querySelector(".inst-row-menu > button");
    expect(trigger).not.toBeNull(); expect(row.querySelectorAll(".inst-row-menu")).toHaveLength(1);
    expect(row.querySelector("a.inst").classList.contains("inst-favorite")).toBe(true);
    const color = await import("/assets/identity-color.js") as any;
    expect(color.contrast(row.querySelector("a.inst").style["--id-name-light"], "#ececec")).toBeGreaterThanOrEqual(4.5);
    fire(trigger, "keydown", { key: "ArrowDown" }); await settle(4);
    const list: any = row.querySelector('[role="menu"]'), first: any = list.querySelector('[role="menuitem"]');
    expect(first.textContent).toBe("Remove from favorites"); expect(first.querySelector(".icon")).not.toBeNull();
    fire(list, "keydown", { key: "Escape" }); await settle(4); expect(p.document.activeElement).toBe(trigger);
    fire(trigger, "click"); await settle(4); fire(row.querySelector('[role="menuitem"]')!, "click"); await settle(4);
    expect(roster.navStore.get().favorites).toEqual([]);
    const moved = p.root.querySelector('[data-agent-row="alpha"] .inst-row-menu > button');
    expect(moved).not.toBe(trigger); expect(p.document.activeElement).toBe(moved);
    fire(moved!, "keydown", { key: "ArrowDown" }); await settle(4);
    expect(p.root.querySelector('[data-agent-row="alpha"] [role="menuitem"]')!.textContent).toBe("Add to favorites");
  });
  it("darkens light names on selected and fresh-reply rows while preserving dark mode", async () => {
    const color = await import("/assets/identity-color.js") as any;
    const colors = [...color.IDENTITY_PALETTE.map((p: any) => `preset:${p.id}`), ...color.AUTO_PALETTE.map((p: any) => `auto:${p.id}`), "#aaddff", "#ffbb11"];
    expect(colors.length).toBe(22);
    for (const c of colors) {
      const it = { color: { person: c }, color_show: { person: ["name"] } };
      const base = color.identityOf(it), row = color.identityOf(it, { sidebar: true });
      expect(row.nameDark).toBe(base.nameDark);
      expect(row.nameDark).toBe(priorDarkShade(color.colorValue(c, "dark"), "dark"));
      for (const background of ["#f9f9f9", "#ececec", "#c2ddfa"]) expect(color.contrast(row.nameLight, background), `${c} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("keeps model Settings on the focused, supported pane", async () => {
    pane.focused = false;
    expect((await menu()).textContent).not.toContain("Model and effort…");
    await p.unmount(); pane.focused = true; app.applyStatus({ instances: [{ ...inst, capabilities: { details: false } }] });
    expect((await menu()).textContent).not.toContain("Model and effort…");
  });
  it("offers no mutating menu on the read-only public roster", async () => {
    roster.navStore.set({ favorites: ["alpha"] }); p.document.body.dataset.publicLink = "1";
    await p.mount(h(roster.InstanceNav, { route: pane.route, items: [inst], loaded: true, viewOnly: true }));
    expect(p.root.querySelector(".inst-row-menu")).toBeNull(); expect(p.root.querySelector(".inst-favorite-mark")).not.toBeNull();
  });
  it("a guest keeps their own favourite action and gets no Agent settings action", async () => {
    p.document.body.dataset.tier = "guest";
    await p.mount(h(roster.InstanceNav, { route: pane.route, items: [inst], loaded: true }));
    fire(p.root.querySelector(".inst-row-menu > button")!, "click"); await settle(4);
    const labels = [...p.root.querySelectorAll('[role="menuitem"]')].map((n: any) => n.textContent);
    expect(labels).toHaveLength(1); expect(labels[0]).toMatch(/favorites/);
  });
  it("fits a sidebar menu in the top layer and releases its placement listeners", async () => {
    const { Menu } = await import("/assets/ui-menu.js") as any;
    const create = p.document.createElement.bind(p.document), createNS = p.document.createElementNS.bind(p.document), show = vi.fn(), hide = vi.fn();
    const decorate = (el: any, tag: string) => {
      if (tag === "div") { el.showPopover = show; el.hidePopover = hide;
        el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 280, bottom: 120, width: 280, height: 120 }); }
      return el;
    };
    const createSpy = vi.spyOn(p.document, "createElement").mockImplementation((tag: string) => decorate(create(tag), tag));
    const createNSSpy = vi.spyOn(p.document, "createElementNS").mockImplementation((ns: string, tag: string) => decorate(createNS(ns, tag), tag));
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (key: string) => key === "--agent-menu-version" ? "1" : "" }));
    const prior = { scroll: p.window.listenerCount("scroll"), resize: p.window.listenerCount("resize") };
    (p.window as any).innerWidth = 1024; (p.window as any).innerHeight = 768;
    try {
      await p.mount(h(Menu, { label: "Agent actions", cls: "agent-menu", topLayer: true, fit: true, items: [{ key: "one", label: "One", onSelect() {} }] }));
      const trigger: any = p.root.querySelector("button");
      trigger.getBoundingClientRect = () => ({ left: 982, right: 1010, top: 700, bottom: 728, width: 28, height: 28 });
      fire(trigger, "click"); await settle(4);
      const list: any = p.root.querySelector('[role="menu"]');
      expect(list.getAttribute("popover")).toBe("manual"); expect(show).toHaveBeenCalledOnce();
      expect([list.style["--menu-x"], list.style["--menu-y"]]).toEqual(["730px", "576px"]);
      expect(p.window.listenerCount("scroll")).toBe(prior.scroll + 1); expect(p.window.listenerCount("resize")).toBe(prior.resize + 1);
      await p.unmount(); expect(hide).toHaveBeenCalledOnce();
      expect(p.window.listenerCount("scroll")).toBe(prior.scroll); expect(p.window.listenerCount("resize")).toBe(prior.resize);
    } finally { await p.unmount(); createSpy.mockRestore(); createNSSpy.mockRestore(); vi.unstubAllGlobals(); }
  });
  it("retained CSS keeps the legacy menu placement without a native popover", async () => {
    const { Menu } = await import("/assets/ui-menu.js") as any;
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    try {
      await p.mount(h(Menu, { label: "Agent actions", cls: "agent-menu", topLayer: true, fit: true, items: [{ key: "one", label: "One", onSelect() {} }] }));
      fire(p.root.querySelector("button")!, "click"); await settle(4);
      const list = p.root.querySelector('[role="menu"]')!;
      expect(list.getAttribute("popover")).toBeNull(); expect(list.classList.contains("menu-anchored")).toBe(false);
      fire(list, "keydown", { key: "Escape" }); await settle(4); expect(p.root.querySelector('[role="menu"]')).toBeNull();
    } finally { await p.unmount(); vi.unstubAllGlobals(); }
  });
});
