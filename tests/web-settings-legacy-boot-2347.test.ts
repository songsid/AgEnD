// #2347: a page loaded at an old Settings address (a bookmark, a link from before the regrouping) shows the new one in
// the address bar before the first render — ClassicBot's with its place (#classicbot).
import { afterAll, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

let p: AppPage;
afterAll(() => p?.restore());
it("starts on /settings/classic → the address bar says /settings/chat#classicbot, the route is Chat & connections", async () => {
  p = page({ url: "http://127.0.0.1:19284/settings/classic", storage: {} });
  const nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
  expect([p.window.location.pathname, p.window.location.hash, nav.navStore.get().route]).toEqual(["/settings/chat", "#classicbot", { panel: "settings", section: "chat" }]);
});

it("#2382 review: loaded at an old address with a place of its own (/settings/web#guests) keeps it", async () => {
  p.restore();
  p = page({ url: "http://127.0.0.1:19284/settings/web#guests", storage: {} });
  const nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
  expect([p.window.location.pathname, p.window.location.hash]).toEqual(["/settings/access", "#guests"]);
});
