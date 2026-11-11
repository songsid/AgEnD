import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
let p: AppPage, nav: any, controller: any;
const retirePreview = vi.fn();
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/chat/alpha" });
  nav = await import("/assets/app-nav.js");
  const module = await import("/ui/js/chat-workspace-navigation.js");
  nav.startRouter(p.window);
  controller = module.installWorkspaceNavigation(nav, { beforeLayout: retirePreview });
});
afterAll(() => { controller?.close(); p.restore(); });
describe("workspace shares the existing router and guarded history", () => {
  it("plain sidebar routes target focus; focus and another pane's tab preserve its lease", () => {
    controller.open("beta");
    const first = nav.navStore.get().workspace;
    controller.focus("a");
    expect(nav.navStore.get().route.instance).toBe("alpha");
    nav.navigate("/ui/log/gamma");
    const next = nav.navStore.get().workspace;
    expect(next.a.route).toEqual({ panel: "log", instance: "gamma" });
    expect(next.b).toBe(first.b);
    controller.pane("b").navigate("/view/beta");
    expect(nav.navStore.get().workspace.a).toBe(next.a);
  });
  it("an unchanged Details pane does not guard another pane's navigation", () => {
    controller.pane("a").navigate("/ui/fleet/agent/gamma?cat=basic");
    const guarded = vi.fn((to: any) => to?.panel === "details" && to.instance === "gamma");
    const off = controller.pane("a").addLeaveGuard(guarded);
    controller.pane("b").navigate("/ui/log/beta");
    expect(guarded).toHaveBeenLastCalledWith(expect.objectContaining({ panel: "details", instance: "gamma" }), expect.any(String),
      expect.objectContaining({ workspace: expect.objectContaining({ focus: "b" }) }));
    expect(nav.navStore.get().workspace.b.route.panel).toBe("log");
    off();
  });
  it("accepted guarded close resumes the entire intent and checks the other guard", () => {
    const a = controller.pane("a"), b = controller.pane("b");
    let resume: (() => void) | undefined;
    const checkA = (_: any, path: string) => { resume = () => a.navigate(path, { skipGuard: checkA }); return false; };
    const second = vi.fn(() => true);
    const offA = a.addLeaveGuard(checkA), offB = b.addLeaveGuard(second);
    controller.closePane("a");
    expect(nav.navStore.get().workspace).not.toBeNull();
    expect(second).not.toHaveBeenCalled();
    resume!();
    expect(nav.navStore.get().workspace).toBeNull();
    expect(nav.navStore.get().route).toEqual({ panel: "log", instance: "beta" });
    expect(second).toHaveBeenCalledTimes(1);
    offA(); offB();
  });
  it("global pages leave the workspace and an explicit ordinary deep link remains single", () => {
    controller.open("alpha");
    nav.navigate("/ui/needs"); expect(nav.navStore.get().workspace).toBeNull();
    nav.navigate("/ui/chat/alpha"); expect(nav.navStore.get().workspace).toBeNull();
  });
  it("Back/Forward decodes the explicit URL instead of replacing the old focused pane", () => {
    controller.open("beta"); controller.focus("a");
    p.window.history.replaceState(null, "", "/ui/log/beta?compare=gamma&paneB=chat&focus=b");
    p.window.dispatchEvent({ type: "popstate" } as any);
    expect(nav.navStore.get().route.instance).toBe("gamma");
    expect(nav.navStore.get().workspace.a.route.panel).toBe("log");
  });
  it("retires suspended drafts and their guard resources on a real pane replacement", () => {
    controller.pane("a").navigate("/ui/fleet/agent/beta?cat=basic");
    const memory = controller.pane("a").retain("settings"), cleanup = vi.fn();
    memory.hold(cleanup); memory.set("draft", "not persisted");
    controller.focus("b"); expect(memory.current()).toBe(true);
    controller.pane("a").navigate("/ui/log/beta");
    expect(memory.current()).toBe(false); expect(cleanup).toHaveBeenCalledTimes(1);
    expect(memory.state.size).toBe(0); memory.set("draft", "late"); expect(memory.state.size).toBe(0);
  });
  it("retires preview before a layout is published, including a restored history entry", () => {
    retirePreview.mockClear(); // entry/exit are now preview transitions too; this case measures layout/focus/history.
    const before = nav.navStore.get().workspace;
    retirePreview.mockImplementationOnce(() => expect(nav.navStore.get().workspace).toBe(before));
    controller.layout("stack"); expect(retirePreview).toHaveBeenCalledTimes(1);
    controller.focus("a"); expect(retirePreview).toHaveBeenCalledTimes(1);
    p.window.history.replaceState(null, "", "/ui/log/beta?compare=gamma&layout=right");
    p.window.dispatchEvent({ type: "popstate" } as any); expect(retirePreview).toHaveBeenCalledTimes(2);
  });
});
