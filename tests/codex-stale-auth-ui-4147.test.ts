import { afterAll, beforeAll, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
let p: AppPage, app: any, panel: any, i18n: any;
const calls: string[] = [];
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/needs", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) }; };
  app = await import("/assets/app-store.js");
  i18n = await import("/assets/app-i18n.js");
  panel = await import("/ui/js/panel-needs.js");
  const nav = await import("/assets/app-nav.js"); nav.startRouter(p.window);
});
afterAll(async () => { await p.unmount(); p.restore(); delete (globalThis as any).fetch; });
it.each(["en", "zh-TW"])("shows the instance restart remedy in %s without Connect-account controls", async lang => {
  await p.unmount(); i18n.setLang(lang);
  app.appStore.set({ ready: true, needsLoaded: true, proposals: [], needs: [{ id: "stale-auth:worker:1", type: "instance", instance: "worker", reason: "stale_auth", detail: "", since: Date.now() }], instances: [] });
  await p.mount(h(panel.NeedsPanel, { route: { panel: "needs" }, navKey: `needs:|1|${lang}` })); await settle(4);
  expect(p.root.textContent).toContain(lang === "en" ? "Codex needs a restart" : "Codex 需要重新啟動");
  expect(p.root.textContent).toContain(lang === "en" ? "sign in again only if Codex asks" : "只有 Codex 要求時才需要重新登入");
  expect(calls.some(url => url.includes("backend-login"))).toBe(false);
  expect(p.root.querySelectorAll("button").some((b: any) => /^(Connect|連接)$/.test(b.textContent.trim()))).toBe(false);
});
