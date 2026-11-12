import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let p: AppPage, nav: any, entry: any;
const insert = vi.fn(() => true);
let composerReady = true, release: () => void;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/chat/alpha" }); (p.window as any).innerWidth = 1400;
  nav = await import("/assets/app-nav.js"); nav.startRouter(p.window);
  const held = new Promise<void>(resolve => { release = resolve; });
  const m = await import("/ui/js/chat-workspace.js") as any;
  entry = m.installWorkspaceEntry({ nav, ready: () => held, chat: { paneComposerReady: () => composerReady, insertPaneQuote: insert } });
});
afterAll(async () => { (await import("/assets/app-store.js") as any).appStore.get().chatWorkspaceSessionEnd?.(); p.restore(); });
describe("loading and delayed quotation retain their exact navigation intent", () => {
  it("a navigation during capability loading cannot open the older requested split", async () => {
    const pending = entry.open("beta"); nav.navigate("/ui/log/alpha"); release(); await pending;
    expect(nav.navStore.get().workspace).toBeUndefined();
    await entry.open("beta");
    expect(nav.navStore.get().workspace.a.route.panel).toBe("log");
    expect(nav.navStore.get().workspace.b.route.instance).toBe("beta");
  });
  it("a changed destination cancels the captured quote instead of editing its successor", async () => {
    composerReady = false;
    const target = entry.quoteTargets("alpha")[0], pending = target.insert("Selected passage");
    nav.navigate("/ui/chat/gamma"); await pending;
    expect(insert).not.toHaveBeenCalled();
  });
  it("a current quote opens the captured agent's Chat and inserts plain text only", async () => {
    composerReady = true;
    const app = await import("/assets/app-store.js") as any;
    app.applyStatus({ instances: [{ name: "alpha" }, { name: "gamma", display_name: "AgEnD Leader" }] });
    const target = entry.quoteTargets("alpha")[0];
    expect(target.label).toBe("Quote into the other pane (AgEnD Leader)");
    const { setLang } = await import("/assets/app-i18n.js") as any;
    setLang("zh-TW", { store: false });
    expect(entry.quoteTargets("alpha")[0].label).toBe("引用到另一格（AgEnD Leader）");
    setLang("en", { store: false });
    await target.insert("Selected passage");
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith("gamma", "alpha", "Selected passage", expect.any(Function));
    expect(nav.navStore.get().route).toEqual({ panel: "chat", instance: "gamma" });
  });
  it("uses the split/focus keys while leaving browser tab keys and IME alone", async () => {
    const shell = await import("/assets/app-shell.js") as any;
    const mods = shell.isMacLike() ? { metaKey: true } : { ctrlKey: true };
    for (const key of ["1", "2", "Tab", "w"]) expect(fire(p.document, "keydown", { key, ...mods }).defaultPrevented).toBe(false);
    expect(fire(p.document, "keydown", { key: "\\", ...mods, isComposing: true }).defaultPrevented).toBe(false);
    const focusMods = shell.isMacLike() ? { ctrlKey: true, metaKey: true } : { ctrlKey: true, altKey: true };
    expect(fire(p.document, "keydown", { key: "\\", ...focusMods }).defaultPrevented).toBe(true);
    expect(nav.navStore.get().workspace.focus).toBe("a");
    expect(fire(p.document, "keydown", { key: "\\", ...mods }).defaultPrevented).toBe(true);
    expect(shell.shellStore.get().dialog).not.toBeNull(); shell.closeDialog();
  });
  it("session retirement fences further local entry and delayed insertions", async () => {
    const app = await import("/assets/app-store.js") as any;
    const shell = await import("/assets/app-shell.js") as any;
    const mods = shell.isMacLike() ? { ctrlKey: true, metaKey: true } : { ctrlKey: true, altKey: true };
    fire(p.document, "keydown", { key: "\\", ...mods });
    const query = vi.spyOn(p.document, "querySelector");
    app.appStore.get().chatWorkspaceSessionEnd();
    const before = nav.navStore.get(); await entry.open("delta");
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(nav.navStore.get()).toBe(before); expect(app.appStore.get().chatWorkspace).toBeNull();
    expect(query.mock.calls.some(([selector]) => selector.startsWith(".ws-pane"))).toBe(false); query.mockRestore();
  });
});
