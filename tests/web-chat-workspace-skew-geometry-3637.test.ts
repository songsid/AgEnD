import { afterAll, beforeAll, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import * as model from "/assets/chat-workspace-model.js";
let p: AppPage, nav: any, legacy: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1/ui/chat/alpha" }); nav = await import("/assets/app-nav.js"); nav.startRouter(p.window);
  legacy = (await import("/ui/js/chat-workspace-navigation.js") as any).installWorkspaceNavigation(nav);
});
afterAll(() => { legacy.close(); p.restore(); });
it("a retained host never restores float through a new topology helper or adapter", () => {
  const url = new URL("http://127.0.0.1/ui/chat/alpha?compare=beta&layout=float");
  expect(model.readWorkspace(url)).toBeNull();
  expect((model.readWorkspace as any)(url, null, true)?.layout).toBe("float");
  nav.navigate(url.pathname + url.search, { workspace: true }); expect(legacy.current()).toBeNull();
  const floating = { ...model.openBeside(null, { panel: "chat", instance: "alpha" }, "beta"), layout: "float", floating: "b", rect: null };
  legacy.restore(floating); expect(legacy.current()).toBeNull();
  legacy.open("beta"); expect(legacy.current()?.layout).toBe("right"); legacy.layout("float"); expect(legacy.current()?.layout).toBe("right");
});
