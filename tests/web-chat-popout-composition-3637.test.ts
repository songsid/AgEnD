import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let p: AppPage, nav: any, app: any, shell: any, popup: any, controller: any;
const draft = { payload: { text: "unsent", files: [], reply: null }, current: vi.fn(() => true), clear: vi.fn(() => true) };
const chat = { popoutDraftVersion: 1, popoutDraftReady: () => true, capturePaneDraft: vi.fn(() => draft), paneComposerReady: vi.fn(() => false), acceptPaneDraft: vi.fn(() => true) };
const scope = "viewer", nonce = "12345678-1234-1234-1234-123456789abc";
let owner: any;
beforeAll(async () => {
  p = page({ url: "https://fleet.example/ui/chat/alpha" });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "1" }));
  Object.assign(p.window, { crypto: { randomUUID: () => nonce }, open: vi.fn(), innerWidth: 1400 });
  nav = await import("/assets/app-nav.js"); nav.startRouter(p.window);
  app = await import("/assets/app-store.js"); shell = await import("/assets/app-shell.js"); popup = await import("/ui/js/chat-popout.js");
});
afterEach(() => { owner?.close(); controller?.close(); owner = controller = null; vi.clearAllMocks(); });
afterAll(() => { p.restore(); vi.unstubAllGlobals(); });
const data = (type: string, rest = {}) => ({ channel: "agend-chat-popout-v1", type, name: "beta", scope, ...rest });
async function parent() {
  nav.navigate("/ui/chat/alpha", { force: true });
  controller = (await import("/ui/js/chat-workspace-navigation.js") as any).installWorkspaceNavigation(nav, { geometry: true }); controller.open("beta");
  const child = { closed: false, postMessage: vi.fn() }; (p.window as any).open.mockReturnValue(child);
  owner = popup.createPanePopout({ scope, chat, notify: vi.fn() });
  const receive = (type: string) => fire(p.window, "message", { origin: "https://fleet.example", source: child, data: data(type, { nonce }) });
  return { child, receive };
}
describe("the existing router, guards and draft owner compose the pop-out", () => {
  it("retires only the acknowledged pane, preserving its peer route and clearing just its captured draft", async () => {
    const f = await parent(); const peer = controller.current().a;
    expect(owner.open(controller, "b")).toBe(true); expect(controller.current().b.route.instance).toBe("beta");
    f.receive("ready"); expect(draft.clear).not.toHaveBeenCalled(); f.receive("received");
    expect(controller.current()).toBeNull(); expect(nav.navStore.get().route).toEqual(peer.route); expect(draft.clear).toHaveBeenCalledTimes(1);
  });
  it("keeps the source when an existing Details guard declines closure", async () => {
    const f = await parent(); const off = controller.pane("b").addLeaveGuard(() => false), w = controller.current();
    owner.open(controller, "b"); f.receive("ready"); f.receive("received");
    expect(controller.current()).toBe(w); expect(draft.clear).not.toHaveBeenCalled(); off();
  });
  it("a replaced source or session retirement prevents the old ACK from consuming a successor", async () => {
    const f = await parent(); owner.open(controller, "b"); f.receive("ready"); controller.dock("gamma", "b", "center"); f.receive("received");
    expect(controller.current()?.b.route.instance).toBe("gamma"); expect(draft.clear).not.toHaveBeenCalled();
    owner.open(controller, "b"); owner.close(); f.receive("received"); expect(draft.clear).not.toHaveBeenCalled();
  });
  it.each(["css", "shell", "chat", "store", "scope", "guest"])("retained/missing %s capability keeps the old entry closed", cause => {
    const old = shell.Shell.popoutVersion;
    if (cause === "shell") shell.Shell.popoutVersion = undefined;
    if (cause === "css") vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    if (cause === "guest") p.document.body.dataset.tier = "guest";
    try {
      expect(popup.createPanePopout({ scope: cause === "scope" ? "" : scope, chat: cause === "chat" ? {} : cause === "store" ? { ...chat, popoutDraftReady: () => false } : chat })).toBeNull();
    } finally { shell.Shell.popoutVersion = old; delete p.document.body.dataset.tier; vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "1" })); }
  });
  it("a popup restores one normal Agent route, keeps presentation across its text tabs, and uses no workspace", async () => {
    nav.navigate("/ui/chat/beta?presentation=popout", { force: true }); (p.window as any).opener = null;
    owner = popup.installPopout({ nav, chat, scope }); expect(owner).not.toBeNull(); expect(shell.shellStore.get().popout).toBe(true);
    nav.navigate("/ui/log/beta"); expect(p.window.location.search).toBe("?presentation=popout"); expect(nav.navStore.get().workspace).toBeUndefined();
    nav.navigate("/ui/fleet/agent/beta?cat=runtime"); expect(p.window.location.search).toContain("cat=runtime"); expect(p.window.location.search).toContain("presentation=popout");
    owner.close(); expect(shell.shellStore.get().popout).toBe(false);
  });
});

it("a child navigation A → B → A cannot revive the original handoff", () => {
  nav.navigate("/ui/chat/beta?presentation=popout", { force: true });
  const parent = { closed: false, postMessage: vi.fn() }; (p.window as any).opener = parent;
  const offeredChat = { ...chat, paneComposerReady: () => true }; app.appStore.set({ ready: true });
  owner = popup.installPopout({ nav, chat: offeredChat, scope });
  expect(parent.postMessage).toHaveBeenCalled();
  nav.navigate("/ui/log/beta"); nav.navigate("/ui/chat/beta");
  fire(p.window, "message", { source: parent, origin: "https://fleet.example", data: data("draft", { nonce, payload: draft.payload }) });
  expect(chat.acceptPaneDraft).not.toHaveBeenCalled();
});
