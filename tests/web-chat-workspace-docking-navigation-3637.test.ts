import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
let p: AppPage, nav: any, controller: any;
const stopPreview = vi.fn();
beforeAll(async () => { p = page({ url: "http://127.0.0.1/ui/chat/alpha" }); nav = await import("/assets/app-nav.js"); nav.startRouter(p.window); controller = (await import("/ui/js/chat-workspace-navigation.js")).installWorkspaceNavigation(nav, { geometry: true, beforeLayout: stopPreview }); });
beforeEach(() => { nav.navigate("/ui/chat/alpha", { workspace: true, force: true }); controller.open("beta"); stopPreview.mockClear(); });
afterAll(() => { controller.close(); p.restore(); });
it("stops the old preview on first split and final collapse, before the next host can render", () => {
  nav.navigate("/ui/chat/alpha", { workspace: true, force: true }); stopPreview.mockClear();
  controller.open("beta"); expect(stopPreview).toHaveBeenCalledTimes(1);
  controller.closePane("b"); expect(stopPreview).toHaveBeenCalledTimes(2);
});
it("floats the requested pane and stops the old live preview before changing its DOM position", () => {
  const w = controller.current(); controller.layout("float", "a");
  expect(controller.current().layout).toBe("float"); expect(controller.current().floating).toBe("a");
  expect(controller.current().a).toBe(w.a); expect(controller.current().b).toBe(w.b); expect(stopPreview).toHaveBeenCalledTimes(1);
  controller.swap(); expect(controller.current().floating).toBe("b"); expect(stopPreview).toHaveBeenCalledTimes(2);
});
it("commits only physical geometry with replace history while preserving pane leases", () => {
  const w = controller.current(), spy = vi.spyOn(p.window.history, "replaceState");
  controller.geometry({ ratio: .37, token: "never serialize", rect: { x: 4, y: 7, width: 500, height: 400, draft: "private" } });
  expect(controller.current().ratio).toBe(.37); expect(controller.current().a).toBe(w.a); expect(controller.current().b).toBe(w.b);
  expect(spy).toHaveBeenCalled(); expect(p.window.location.href).not.toMatch(/token|private/); spy.mockRestore();
});
it("a drop consults the existing leave guard and cannot overwrite an edited target", () => {
  const check = vi.fn(() => false), off = controller.pane("a").addLeaveGuard(check), w = controller.current();
  controller.dock("gamma", "a", "right"); expect(check).toHaveBeenCalled(); expect(controller.current()).toBe(w); off();
  controller.dock("gamma", "a", "right"); expect(controller.current().a.route.instance).toBe("gamma"); expect(controller.current().b).toBe(w.b);
});
it("sidebar docking opens a single pane's second agent at the requested edge without losing its category", () => {
  nav.navigate("/ui/fleet/agent/alpha?cat=runtime", { workspace: true, force: true }); controller.dock("beta", "a", "left");
  expect(controller.current()?.a.search).toBe("?cat=runtime"); expect(controller.current()?.flipped).toBe(true); expect(controller.current()?.b.route.instance).toBe("beta");
});

it("leaving float for a menu layout removes the old floating owner and rectangle", () => {
  controller.layout("float", "a"); controller.geometry({ rect: { x: 15, y: 20, width: 500, height: 400 } });
  controller.layout("right"); expect(controller.current()).not.toHaveProperty("floating"); expect(controller.current()).not.toHaveProperty("rect");
});
