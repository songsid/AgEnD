import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let p: AppPage, nav: any, app: any, shell: any, host: any, ctx: any, tabs: any, controller: any;
const leases = new Map<string, any>();
let width = 900;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/chat/alpha" });
  (globalThis as any).fetch = async () => ({ ok: false, json: async () => ({}) });
  (p.window as any).innerWidth = 1400;
  (globalThis as any).ResizeObserver = class {
    constructor(private changed: () => void) {}
    observe(el: any) { el.getBoundingClientRect = () => ({ width, height: 800 }); this.changed(); }
    disconnect() {}
  };
  nav = await import("/assets/app-nav.js"); app = await import("/assets/app-store.js"); shell = await import("/assets/app-shell.js");
  ctx = await import("/assets/app-ctx.js"); tabs = await import("/assets/instance-switch.js");
  host = await import("/ui/js/chat-workspace.js");
  nav.startRouter(p.window); controller = (await import("/ui/js/chat-workspace-navigation.js") as any).installWorkspaceNavigation(nav, { geometry: true });
  app.applyStatus({ instances: ["alpha", "beta"].map(name => ({ name, backend: "claude-code", status: "running", state: "idle" })) });
});
afterEach(async () => { await p.unmount(); nav.navigate("/ui/chat/alpha", { workspace: true }); leases.clear(); width = 900; });
afterAll(() => { controller.close(); p.restore(); delete (globalThis as any).fetch; delete (globalThis as any).ResizeObserver; });
function Panel({ route, navKey }: any) {
  const lease = ctx.useLease(navKey); leases.set(route.instance, lease);
  return h("div", { class: "panel" }, h(shell.PanelHeader, { title: route.instance, pageControls: { navKey },
    nav: h(tabs.InstanceSwitch, { name: route.instance, current: route.panel }) }), h("textarea", { "data-agent": route.instance }));
}
async function mount() {
  const Workspace = host.createWorkspaceHost(controller), panels = new Map(["chat", "log", "details", "view"].map(view => [view, { Component: Panel }]));
  function App() { return h(Workspace, { nav: app.useStore(nav.navStore), panels }); }
  await p.mount(h(App)); await settle(6);
}
describe("the real panel host is additive to the single pane", () => {
  it("dock, swap and float keep each existing composer DOM and lease", async () => {
    controller.open("beta"); await mount();
    const inputs = ["alpha", "beta"].map(name => p.root.querySelector(`textarea[data-agent="${name}"]`) as any);
    const original = [leases.get("alpha"), leases.get("beta")]; inputs[0].value = "Unsent alpha";
    for (const change of [() => controller.swap(), () => controller.layout("float", "a"), () => controller.dock("alpha", "b", "top")]) {
      change(); await settle(4);
      expect(p.root.querySelector('textarea[data-agent="alpha"]')).toBe(inputs[0]);
      expect(p.root.querySelector('textarea[data-agent="beta"]')).toBe(inputs[1]);
      expect(inputs[0].value).toBe("Unsent alpha");
      expect(leases.get("alpha")).toBe(original[0]); expect(leases.get("beta")).toBe(original[1]);
    }
  });
  it("renders a keyboard sash from the saved ratio without remounting either composer", async () => {
    controller.open("beta"); await mount(); const input: any = p.root.querySelector('textarea[data-agent="alpha"]'), a = leases.get("alpha"); input.value = "Keep draft";
    const sash = p.root.querySelector('.ws-sash[role="separator"]'); expect(sash).not.toBeNull(); expect(sash?.getAttribute("aria-orientation")).toBe("vertical");
    fire(sash!, "keydown", { key: "ArrowRight" }); await settle(4); expect(controller.current().ratio).toBeGreaterThan(.5);
    expect(p.root.querySelector('textarea[data-agent="alpha"]')).toBe(input); expect(input.value).toBe("Keep draft"); expect(leases.get("alpha")).toBe(a);
    fire(sash!, "dblclick"); await settle(4); expect(controller.current().ratio).toBe(.5);
  });
  it("keeps both full panes in float mode with a bounded resize handle and one page-tools root", async () => {
    controller.open("beta"); controller.layout("float", "b"); await mount();
    expect(p.root.querySelectorAll(".ws-pane")).toHaveLength(2); expect(p.root.querySelector('.ws-pane.ws-floating[data-pane="b"]')).not.toBeNull();
    expect(p.root.querySelector(".ws-float-resize")).not.toBeNull(); expect(p.root.querySelectorAll(".ws-page-tools")).toHaveLength(1); expect(p.root.querySelector(".ws-sash")).toBeNull();
  });
  it("leaves the normal header/IDs alone without a workspace", async () => {
    await mount(); expect(p.root.querySelector(".chat-workspace")).toBeNull();
    expect(p.root.querySelector("#sbOpen")).not.toBeNull(); expect(p.root.querySelectorAll(".panel-head")).toHaveLength(1);
  });
  it("focus moves the one page-tools node and preserves both pane leases and unsent text", async () => {
    controller.open("beta"); await mount();
    expect(p.root.querySelectorAll(".ws-pane-head")).toHaveLength(2);
    expect(p.root.querySelectorAll(".hd-text")).toHaveLength(1);
    const tools = p.root.querySelector(".ws-page-tools"), a = leases.get("alpha"), b = leases.get("beta");
    const input = p.root.querySelector('textarea[data-agent="alpha"]') as any; input.value = "Unsent";
    fire(p.root.querySelector('[data-pane="a"]')!, "pointerdown", { button: 0 }); await settle(4);
    expect(p.root.querySelector(".ws-page-tools")).toBe(tools);
    expect(tools?.closest("[data-pane]")?.getAttribute("data-pane")).toBe("a");
    expect(leases.get("alpha")).toBe(a); expect(leases.get("beta")).toBe(b);
    expect(input.value).toBe("Unsent"); expect(a.current()).toBe(true); expect(b.current()).toBe(true);
    controller.pane("b").navigate("/ui/log/beta"); await settle(4);
    expect(leases.get("alpha")).toBe(a); expect(b.current()).toBe(false);
    expect(p.root.querySelectorAll(".hd-text")).toHaveLength(1);
  });
  it("available chat width falls back to one mounted pane and text agent tabs", async () => {
    width = 650; controller.open("beta"); await mount();
    expect(p.root.querySelectorAll(".ws-pane")).toHaveLength(1);
    expect(p.root.querySelectorAll(".ws-agent-tabs .seg-item")).toHaveLength(2);
    expect(p.root.querySelector(".ws-pane-head")).toBeNull();
    fire(p.root.querySelector(".ws-agent-tabs button")!, "click", { button: 0 }); await settle(4);
    expect(p.root.querySelector('[data-pane="a"]')).not.toBeNull();
    expect(p.root.querySelectorAll(".ws-pane")).toHaveLength(1);
  });
  it.each(["a", "b"])("Alt-Split from A keeps A even with %s initially focused", async focus => {
    app.applyStatus({ instances: ["alpha", "beta", "gamma"].map(name => ({ name, backend: "claude-code", status: "running", state: "idle" })) });
    controller.open("beta"); controller.focus(focus); await mount();
    const dialog = await import("/assets/app-shell.js") as any;
    function DialogHost() { const s = app.useStore(dialog.shellStore); return s.dialog ? h(s.dialog.Component, { ...s.dialog.props, onClose: dialog.closeDialog }) : null; }
    const node = p.document.createElement("div"); p.root.appendChild(node);
    const { render } = await import("/assets/preact.module.js"); render(h(DialogHost), node); await settle();
    fire(p.root.querySelector('[data-pane="a"] .ws-pane-split')!, "click", { button: 0, altKey: true }); await settle(4);
    const button = [...node.querySelectorAll(".ws-agent-choices button")].find((b: any) => b.textContent === "gamma");
    expect(button).not.toBeUndefined(); fire(button!, "click", { button: 0 }); await settle(4);
    expect(controller.current().a.route.instance).toBe("alpha"); expect(controller.current().b.route.instance).toBe("gamma"); expect(controller.current().layout).toBe("stack");
    render(null, node);
  });
  it("does not move an unfocused text-tab target between pointer down and click", async () => {
    controller.open("beta"); await mount();
    const link = p.root.querySelector('[data-pane="a"] a[href="/ui/chat/alpha"]')!;
    fire(link, "pointerdown", { button: 0 }); await settle(3);
    expect(nav.navStore.get().workspace.focus).toBe("b");
    fire(link, "click", { button: 0 }); await settle(3);
    expect(nav.navStore.get().workspace.a.route.panel).toBe("chat");
    expect(nav.navStore.get().workspace.focus).toBe("a");
  });
  it("a modified tab click leaves focus and the browser's navigation untouched", async () => {
    controller.open("beta"); await mount();
    const link = p.root.querySelector('[data-pane="a"] a[href="/ui/chat/alpha"]')!;
    fire(link, "pointerdown", { button: 0, ctrlKey: true });
    const click = fire(link, "click", { button: 0, ctrlKey: true }); await settle(3);
    expect(click.defaultPrevented).toBe(false); expect(nav.navStore.get().workspace.focus).toBe("b");
  });
  it("closing back to a single pane unmounts the detached page-tools root", async () => {
    controller.open("beta"); await mount();
    const tools = p.root.querySelector(".ws-page-tools")!;
    expect(tools.childNodes.length).toBeGreaterThan(0);
    controller.closePane("a"); await settle(5);
    expect(p.root.querySelector(".chat-workspace")).toBeNull();
    expect(tools.childNodes).toHaveLength(0);
  });
  it("folded touch tools keep one root and stale header cleanup cannot reclaim it", async () => {
    const controls = host.createPageControls(), a = {}, b = {};
    const header = p.document.createElement("div"), menu = p.document.createElement("div"), other = p.document.createElement("div");
    p.root.append(header, menu, other);
    try {
      controls.show(a, header, { navKey: "a" }); await settle(3);
      const node = controls.node, text = node.querySelector(".hd-text");
      controls.move(a, menu, true); expect(node.parentNode).toBe(menu); expect(text.getAttribute("role")).toBe("menuitem");
      controls.move(a, header); expect(text.getAttribute("role")).toBeNull();
      controls.show(b, other, { navKey: "b" }); await settle(3);
      controls.move(a, header); controls.release(a);
      expect(controls.node).toBe(node); expect(node.parentNode).toBe(other);
    } finally { controls.close(); }
  });
  it("keeps one working sidebar opener when both pane headers replace the normal header", async () => {
    controller.open("beta"); shell.shellStore.set({ collapsed: true }); await mount();
    try {
      expect(p.root.querySelectorAll("#sbOpen")).toHaveLength(1);
      fire(p.root.querySelector("#sbOpen")!, "click", { button: 0 }); await settle(3);
      expect(shell.shellStore.get().collapsed).toBe(false);
    } finally { shell.shellStore.set({ collapsed: false }); }
  });
});
