/**
 * #1675 (root cause and design: the comment on #1675): the sidebar's "Fleet" row goes to the open instance's Details
 * (#1523 N2) — with an instance open (chat, View, Details) the Fleet panel and its Org chart (#1389) were out of reach.
 * "Fleet overview" at the top of the sidebar (the drawer on a phone) opens the Fleet panel on the Org chart from any
 * page; the deep link /ui/fleet/org still routes; an instance row still opens that instance. The real Shell, router and
 * Fleet panel in a mini DOM.
 */
import { afterEach, describe, expect, it } from "vitest";
import { fire } from "./helpers/mini-dom.js";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const mounted: AppPage[] = [];
const realFetch = (globalThis as { fetch?: unknown }).fetch;
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  (globalThis as { fetch?: unknown }).fetch = realFetch;
  const { setLang } = await import("/assets/app-i18n.js");
  setLang("en");
});
const I = (name: string) => ({ name, status: "running", backend: "claude-code", tags: ["AgEnD"] });

async function shell(path: string, opts: { narrow?: boolean; viewOnly?: boolean } = {}) {
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1" }, matchNarrow: opts.narrow });
  mounted.push(pg);
  // The Org chart's one read (and anything else the Fleet panel asks): an empty fleet.
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => ({ ok: true, status: 200,
    json: async () => (String(url).startsWith("/ui/org") ? { teams: [], general: null, instances: [] } : []) });
  const { startRouter, navStore } = await import("/assets/app-nav.js");
  const { applyStatus, appStore } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  // @ts-expect-error — a JS module of the app, with no types
  const { FleetPanel } = await import("../src/ui/panel-fleet.js");
  appStore.set({ viewOnly: !!opts.viewOnly });
  startRouter(pg.window);
  applyStatus({ instances: [I("web-dev"), I("reviewer")] });
  const Chat = () => h("div", { id: "chatStub" }, "chat");
  await pg.mount(h(Shell, { panels: new Map<string, unknown>([["fleet", { Component: FleetPanel }], ["chat", { Component: Chat }]]), onNewInstance() {}, viewOnly: !!opts.viewOnly }));
  return { pg, navStore };
}
const entry = (pg: AppPage) => pg.root.querySelector("#sidebar a.side-overview") as any;
/** A left click on a link (the router acts on button 0 only). */
const click = (el: any) => fire(el, "click", { button: 0 });
const navRows = (pg: AppPage) => [...pg.root.querySelectorAll("#sidebar .side-nav a")].map((a: any) => a.textContent.trim());

describe("Fleet overview", () => {
  it("is the first row at the top of the sidebar, before Needs you / Fleet / View", async () => {
    const { pg } = await shell("/ui/chat/web-dev");
    expect([navRows(pg)[0], entry(pg)?.getAttribute("href")]).toEqual(["Fleet overview", "/ui/fleet/org"]);
  });
  it("from an instance's chat it opens the Fleet panel on the Org chart (where the old Fleet row goes to Details)", async () => {
    const { pg, navStore } = await shell("/ui/chat/web-dev");
    const fleetRow = [...pg.root.querySelectorAll("#sidebar .side-nav a")].find((a: any) => a.textContent.trim() === "Fleet") as any;
    expect(fleetRow.getAttribute("href")).toBe("/ui/fleet/agent/web-dev");          // #1523 N2, unchanged
    click(entry(pg)); await settle(6);
    const active = pg.root.querySelector(".p-fleet .seg-item.active") as any;
    expect([navStore.get().route, pg.window.location.pathname, active?.getAttribute("href"), entry(pg).getAttribute("aria-current")])
      .toEqual([{ panel: "fleet", tab: "org" }, "/ui/fleet/org", "/ui/fleet/org", "page"]);
  });
  it("marks itself current on every Fleet tab, and nowhere else — one current row (the Fleet row has Details)", async () => {
    const outcomes: unknown[] = [];
    for (const path of ["/ui/fleet", "/ui/fleet/org", "/ui/fleet/cache", "/ui/chat/web-dev", "/ui/fleet/agent/web-dev"]) {
      const { pg } = await shell(path);
      const current = [...pg.root.querySelectorAll("#sidebar .side-nav a")].filter((a: any) => a.getAttribute("aria-current") === "page").map((a: any) => a.textContent.trim());
      outcomes.push([path, entry(pg)?.getAttribute("aria-current") ?? null, current]);
      const p = mounted.pop()!; await p.unmount(); p.restore();
    }
    expect(outcomes).toEqual([["/ui/fleet", "page", ["Fleet overview"]], ["/ui/fleet/org", "page", ["Fleet overview"]], ["/ui/fleet/cache", "page", ["Fleet overview"]],
      ["/ui/chat/web-dev", null, []], ["/ui/fleet/agent/web-dev", null, ["Fleet"]]]);
  });
  it("the deep link /ui/fleet/org still opens the Org chart", async () => {
    const { pg, navStore } = await shell("/ui/fleet/org");
    await settle(4);
    expect([navStore.get().route, (pg.root.querySelector(".p-fleet .seg-item.active") as any)?.getAttribute("href")]).toEqual([{ panel: "fleet", tab: "org" }, "/ui/fleet/org"]);
  });
  it("an instance row still opens that instance — its chat from a chat, its Details from the Fleet panel (#1523 Q4)", async () => {
    const row = (pg: AppPage, href: string) => [...pg.root.querySelectorAll("#instanceList a")].find((a: any) => a.getAttribute("href") === href);
    const a = await shell("/ui/chat/web-dev");
    click(row(a.pg, "/ui/chat/reviewer")); await settle(4);
    const fromChat = a.navStore.get().route;
    const p = mounted.pop()!; await p.unmount(); p.restore();
    const b = await shell("/ui/fleet/org");
    click(row(b.pg, "/ui/fleet/agent/reviewer")); await settle(4);
    expect([fromChat, b.navStore.get().route]).toEqual([{ panel: "chat", instance: "reviewer" }, { panel: "details", instance: "reviewer" }]);
  });
  it("on a phone it is at the top of the drawer, and closes it when chosen", async () => {
    const { pg, navStore } = await shell("/ui/chat/web-dev", { narrow: true });
    const { shellStore } = await import("/assets/app-shell.js");
    shellStore.set({ drawer: true }); await settle();
    expect(navRows(pg)[0]).toBe("Fleet overview");
    click(entry(pg)); await settle(6);
    expect([navStore.get().route, shellStore.get().drawer]).toEqual([{ panel: "fleet", tab: "org" }, false]);
  });
  it("in zh-TW: Fleet 概覽", async () => {
    const { pg } = await shell("/ui/chat/web-dev");
    const { setLang } = await import("/assets/app-i18n.js");
    setLang("zh-TW"); await settle();
    expect(entry(pg).textContent.trim()).toBe("Fleet 概覽");
  });
  it("the anonymous View reader has no entry (the Fleet panel needs a session)", async () => {
    const { pg } = await shell("/view", { viewOnly: true });
    expect(entry(pg)).toBeNull();
  });
});
