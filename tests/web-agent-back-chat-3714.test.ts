import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage, nav: any, app: any, roster: any, host: any, shell: any, details: any, popup: any, controller: any;
const instances = ["alpha", "beta"].map(name => ({ name, backend: "claude-code", status: "running", state: "idle" }));
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/chat/alpha", storage: { agend_tour_done: "1" } });
  (p.window as any).innerWidth = 1400;
  vi.stubGlobal("ResizeObserver", class { constructor(private update: () => void) {} observe(el: any) { el.getBoundingClientRect = () => ({ width: 900, height: 800 }); this.update(); } disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.startsWith("/ui/instance/")
    ? { name: "alpha", status: "running", backend: "claude-code", description: "", working_directory: "/fixture", tags: [], binding: null, model: "opus", model_source: "live", context_pct: 0, statusline: {}, recent_activity: [] } : {} })));
  nav = await import("/assets/app-nav.js"); app = await import("/assets/app-store.js"); roster = await import("/assets/instance-nav.js");
  shell = await import("/assets/app-shell.js"); host = await import("/ui/js/chat-workspace.js");
  details = await import("/ui/js/panel-details.js"); popup = await import("/ui/js/chat-popout-header.js");
  nav.startRouter(p.window); app.applyStatus({ instances });
});
afterEach(async () => { await p.unmount(); controller?.close(); controller = null; nav.setLeaveGuard(null); nav.navigate("/ui/chat/alpha"); app.appStore.set({ chatWorkspace: null }); vi.clearAllMocks(); });
afterAll(() => { p.restore(); vi.unstubAllGlobals(); });
function Roster({ viewOnly = false }) { const state = app.useStore(nav.navStore); return h(roster.InstanceNav, { route: state.route, items: instances, viewOnly }); }
const row = (name: string) => [...p.root.querySelectorAll("a.inst")].find((link: any) => link.getAttribute("href")?.endsWith(`/${name}`)) as any;
const pick = async (name: string) => { fire(row(name), "click", { button: 0 }); await settle(5); };
async function split(realDetails = false) {
  controller = (await import("/ui/js/chat-workspace-navigation.js") as any).installWorkspaceNavigation(nav, { geometry: true });
  controller.open("beta"); controller.pane("a").navigate("/ui/fleet/agent/alpha"); controller.pane("b").navigate("/ui/fleet/agent/beta");
  const Workspace = host.createWorkspaceHost(controller);
  function Panel({ route, navKey }: any) { return h("div", { class: "panel" }, h(shell.PanelHeader, { title: route.instance,
    pageControls: { navKey, ...(route.panel === "details" ? { backToChat: { path: `/ui/chat/${route.instance}`, label: "Back to chat" } } : {}) } }), h("textarea", { "data-agent": route.instance })); }
  const panels = new Map(["chat", "details", "log", "view"].map(panel => [panel, { Component: realDetails && panel === "details" ? details.DetailsPanel : Panel }]));
  function App() { return h("div", null, h(Roster, {}), h(Workspace, { nav: app.useStore(nav.navStore), panels })); }
  await p.mount(h(App)); await settle(6);
}

describe("#3714 selected agent activation", () => {
  it.each([["details", "/ui/fleet/agent/"], ["log", "/ui/log/"], ["view", "/view/"]])("keeps %s for a different agent, then re-click opens its chat", async (panel, prefix) => {
    nav.navigate(prefix + "alpha"); await p.mount(h(Roster, {}));
    expect(row("beta").getAttribute("href")).toBe(prefix + "beta");
    await pick("beta"); expect(nav.navStore.get().route).toEqual({ panel, instance: "beta" });
    expect(row("beta").getAttribute("aria-current")).toBe("page");
    expect(row("beta").getAttribute("href")).toBe("/ui/chat/beta");
    await pick("beta"); expect(nav.navStore.get().route).toEqual({ panel: "chat", instance: "beta" });
  });
  it("keeps the public read-only roster on View", async () => {
    nav.navigate("/view/alpha"); await p.mount(h(Roster, { viewOnly: true }));
    expect(row("alpha").getAttribute("href")).toBe("/view/alpha"); await pick("alpha");
    expect(nav.navStore.get().route).toEqual({ panel: "view", instance: "alpha" });
  });
  it("keeps a real selected-row link for native Enter and leaves modifier clicks to the browser", async () => {
    nav.navigate("/ui/log/alpha"); await p.mount(h(Roster, {}));
    const link = row("alpha"); expect(link.tagName.toLowerCase()).toBe("a"); expect(link.getAttribute("href")).toBe("/ui/chat/alpha");
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { button: 1 }]) {
      const event = fire(link, "click", { button: 0, ...modifiers }); expect(event.defaultPrevented).toBe(false);
      expect(nav.navStore.get().route.panel).toBe("log");
    }
  });
  it("selected-row navigation consults the existing leave guard", async () => {
    nav.navigate("/ui/fleet/agent/alpha"); await p.mount(h(Roster, {}));
    const guard = vi.fn(() => false), off = nav.setLeaveGuard(guard);
    try { await pick("alpha"); expect(guard).toHaveBeenCalledWith({ panel: "chat", instance: "alpha" }, "/ui/chat/alpha", expect.anything()); expect(nav.navStore.get().route.panel).toBe("details"); }
    finally { off(); }
  });
  it("re-click targets the focused split pane and leaves its peer intact", async () => {
    await split(); const before = controller.current().a;
    await pick("beta"); expect(controller.current()).not.toBeNull();
    expect(controller.current().b.route).toEqual({ panel: "chat", instance: "beta" }); expect(controller.current().a).toBe(before);
  });
});

describe("#3714 Settings Back to chat", () => {
  it.each([["en", "Back to chat"], ["zh-TW", "回到聊天"]])("the actual Settings content offers an accessible guarded return in %s", async (language, label) => {
    const i18n = await import("/assets/app-i18n.js"); i18n.setLang(language, { store: false });
    nav.navigate("/ui/fleet/agent/alpha");
    try {
      await p.mount(h(details.DetailsPanel, { route: nav.navStore.get().route, navKey: "alpha-details" })); await settle(6);
      const back = p.root.querySelector(".panel-body .agent-back-chat"); expect(back).not.toBeNull();
      expect(p.root.querySelector(".panel-head .agent-back-chat")).toBeNull();
      expect(back.getAttribute("aria-label")).toBe(label); expect(back.getAttribute("title")).toBe(label); expect(back.getAttribute("href")).toBe("/ui/chat/alpha");
      const guard = vi.fn(() => false), off = nav.setLeaveGuard(guard);
      fire(back, "click", { button: 0 }); await settle(4); expect(guard).toHaveBeenCalled(); expect(nav.navStore.get().route.panel).toBe("details");
      off(); fire(back, "click", { button: 0 }); await settle(4); expect(nav.navStore.get().route).toEqual({ panel: "chat", instance: "alpha" });
    } finally { i18n.setLang("en", { store: false }); }
  });
  it("the phone index return belongs to the category content, outside the header", async () => {
    nav.navigate("/ui/fleet/agent/alpha"); await p.mount(h(details.DetailsPanel, { route: nav.navStore.get().route, navKey: "alpha-index" })); await settle(6);
    const back = p.root.querySelector(".s-nav .agent-settings-index-return .agent-back-chat"); expect(back).not.toBeNull();
    expect(p.root.querySelector(".panel-head .agent-back-chat")).toBeNull();
    fire(back, "click", { button: 0 }); await settle(4); expect(nav.navStore.get().route.panel).toBe("chat");
  });
  it("the split Settings X returns its own pane to chat without closing it or changing its peer", async () => {
    await split(true); const peer = controller.current().b;
    const back = p.root.querySelector('[data-pane="a"] .panel-body .agent-back-chat'); expect(back).not.toBeNull();
    expect(back.getAttribute("aria-label")).toBe("Back to chat");
    expect(p.root.querySelector('[data-pane="a"] .ws-pane-close').getAttribute("aria-label")).toBe("Close this pane");
    fire(back, "click", { button: 0 }); await settle(5); expect(controller.current()).not.toBeNull();
    expect(controller.current().a.route).toEqual({ panel: "chat", instance: "alpha" }); expect(controller.current().b).toBe(peer);
  });
  it("the split Settings X respects its pane's leave guard", async () => {
    await split(true); const before = controller.current(), off = controller.pane("b").addLeaveGuard(() => false);
    try { const back = p.root.querySelector('[data-pane="b"] .panel-body .agent-back-chat'); expect(back).not.toBeNull(); fire(back, "click", { button: 0 }); await settle(4); expect(controller.current()).toBe(before); }
    finally { off(); }
  });
  it("the Chat pane X still closes that pane", async () => {
    await split(); controller.pane("b").navigate("/ui/chat/beta"); await settle(4);
    expect(p.root.querySelector('[data-pane="b"] .ws-pane-close').getAttribute("aria-label")).toBe("Close this pane");
    fire(p.root.querySelector('[data-pane="b"] .ws-pane-close'), "click", { button: 0 }); await settle(4);
    expect(nav.navStore.get().workspace).toBeNull(); expect(nav.navStore.get().route.instance).toBe("alpha");
  });
  it("a Settings pane's header X closes the pane rather than returning to Chat", async () => {
    await split(true);
    const close = p.root.querySelector('[data-pane="b"] .ws-pane-close');
    expect(close.getAttribute("aria-label")).toBe("Close this pane");
    fire(close, "click", { button: 0 }); await settle(4);
    expect(nav.navStore.get().workspace).toBeNull();
    expect(nav.navStore.get().route).toEqual({ panel: "details", instance: "alpha" });
  });
  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])("the content return leaves modified clicks to the browser: %o", async modifiers => {
    await split(true); const before = controller.current();
    const back = p.root.querySelector('[data-pane="a"] .panel-body .agent-back-chat'); expect(back).not.toBeNull();
    const event = fire(back, "click", { button: 0, ...modifiers }); await settle(3);
    expect(event.defaultPrevented).toBe(false); expect(controller.current()).toBe(before);
  });
  it("a pop-out keeps the return inside actual Settings content, outside its header", async () => {
    nav.navigate("/ui/fleet/agent/alpha"); shell.shellStore.set({ popout: true, popoutHeader: popup.PopoutHeader });
    try {
      await p.mount(h(details.DetailsPanel, { route: nav.navStore.get().route, navKey: "popup-details" })); await settle(6);
      expect(p.root.querySelector(".popup-pane-head")).not.toBeNull();
      expect(p.root.querySelector(".popup-pane-head .agent-back-chat")).toBeNull();
      const back = p.root.querySelector(".panel-body .agent-back-chat"); expect(back).not.toBeNull();
      expect(back.getAttribute("aria-label")).toBe("Back to chat"); fire(back, "click", { button: 0 }); await settle(4); expect(nav.navStore.get().route.panel).toBe("chat");
    } finally { shell.shellStore.set({ popout: false, popoutHeader: null }); }
  });
});
