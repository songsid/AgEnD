/**
 * #2183 (the user's call, after #1675 and #1523 N2): one Fleet entry. The sidebar's "Fleet" (an instance's Details) and
 * "View" rows are gone — an agent's View, Log and Details are the tabs under its header; "Fleet overview" is "Fleet" in
 * English and opens the Fleet tab this device used last (the Org chart the first time); a phone's tabs are Chat · Needs
 * you · Fleet · Settings. The anonymous /view reader is unchanged. The real Shell, router and Fleet panel in a mini DOM.
 */
import { afterEach, describe, expect, it } from "vitest";
import { fire } from "./helpers/mini-dom.js";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const mounted: AppPage[] = [];
const realFetch = (globalThis as { fetch?: unknown }).fetch;
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  (globalThis as { fetch?: unknown }).fetch = realFetch;
  (await import("/assets/app-store.js")).appStore.set({ viewOnly: false });
  (await import("/assets/app-i18n.js")).setLang("en");
});
const I = (name: string) => ({ name, status: "running", backend: "claude-code", tags: [] });

async function shell(path: string, opts: { storage?: Record<string, string>; viewOnly?: boolean; narrow?: boolean } = {}) {
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1", ...opts.storage }, matchNarrow: opts.narrow });
  mounted.push(pg);
  // Whatever a Fleet tab reads: an empty fleet.
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => ({ ok: true, status: 200, text: async () => "",
    json: async () => (String(url).startsWith("/ui/org") ? { teams: [], general: null, instances: [] } : []) });
  const { startRouter, navStore } = await import("/assets/app-nav.js");
  const { applyStatus, appStore } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  // @ts-expect-error — a JS module of the app, with no types
  const { FleetPanel } = await import("../src/ui/panel-fleet.js");
  appStore.set({ viewOnly: !!opts.viewOnly });
  startRouter(pg.window);
  applyStatus({ instances: [I("web-dev"), I("reviewer")] });
  const Stub = (cls: string) => () => h("div", { class: cls }, cls);
  const panels = new Map<string, unknown>([["fleet", { Component: FleetPanel }], ["chat", { Component: Stub("stub-chat") }], ["view", { Component: Stub("stub-view") }],
    ["settings", { Component: Stub("stub-settings") }], ["needs", { Component: Stub("stub-needs") }], ["details", { Component: Stub("stub-details") }]]);
  await pg.mount(h(Shell, { panels, onNewInstance() {}, viewOnly: !!opts.viewOnly }));
  await settle(6);
  return { pg, navStore };
}
const rows = (pg: AppPage) => pg.root.querySelectorAll("#sidebar .side-nav .side-row").map((a: any) => [a.textContent.trim(), a.getAttribute("href")]);
const tabs = (pg: AppPage) => pg.root.querySelectorAll("nav.tabs a.tab").map((a: any) => [a.textContent.trim(), a.getAttribute("href"), a.getAttribute("aria-current") ?? null]);
const entry = (pg: AppPage) => pg.root.querySelector("#sidebar a.side-overview") as any;
const go = async (path: string) => { (await import("/assets/app-nav.js")).navigate(path); await settle(6); };

describe("the sidebar: Fleet, Needs you — no Fleet (Details) or View row", () => {
  it("in English and in zh-TW", async () => {
    const { pg } = await shell("/ui/chat/web-dev");
    const en = rows(pg);
    (await import("/assets/app-i18n.js")).setLang("zh-TW"); await settle();
    expect([en, rows(pg)]).toEqual([
      [["Fleet", "/ui/fleet/org"], ["Needs you", "/ui/needs"]],
      [["Fleet 概覽", "/ui/fleet/org"], ["等你處理", "/ui/needs"]],
    ]);
  });
  it("an instance's Details is reached from its header's switch, and no sidebar row is current there", async () => {
    const { pg } = await shell("/ui/fleet/agent/web-dev");
    const current = pg.root.querySelectorAll("#sidebar .side-nav a").filter((a: any) => a.getAttribute("aria-current") === "page");
    expect([current.length, pg.root.querySelectorAll("#sidebar .side-nav a, #sidebar .side-foot a").some((a: any) => /^\/ui\/fleet\/agent\/|^\/view$/.test(a.getAttribute("href") ?? ""))]).toEqual([0, false]);
  });
});

describe("Fleet opens the tab this device used last", () => {
  it("the Org chart the first time; a visited tab after that — on the sidebar and the phone tab, also after a reload", async () => {
    const a = await shell("/ui/chat/web-dev");
    const first = [entry(a.pg).getAttribute("href"), tabs(a.pg).find((t: any) => t[0] === "Fleet")?.[1]];
    await go("/ui/fleet/cache");
    await go("/ui/chat/web-dev");
    const after = [entry(a.pg).getAttribute("href"), tabs(a.pg).find((t: any) => t[0] === "Fleet")?.[1], a.pg.storage.get("agend_last_fleet_tab")];
    const kept = a.pg.storage.get("agend_last_fleet_tab")!;
    const p = mounted.pop()!; await p.unmount(); p.restore();
    const b = await shell("/settings", { storage: { agend_last_fleet_tab: kept } });
    fire(entry(b.pg), "click", { button: 0 }); await settle(6);
    expect([first, after, b.navStore.get().route, b.pg.root.querySelector(".p-fleet .seg-item.active")?.getAttribute("href")])
      .toEqual([["/ui/fleet/org", "/ui/fleet/org"], ["/ui/fleet/cache", "/ui/fleet/cache", "cache"], { panel: "fleet", tab: "cache" }, "/ui/fleet/cache"]);
  });
  it("#2185 review: on a Fleet tab, Fleet is that tab at once — Org → Cache with nothing else re-rendering, and a direct load of Cache over an older saved tab", async () => {
    const { pg, navStore } = await shell("/ui/fleet/org", { narrow: true });
    const hrefs = () => [entry(pg).getAttribute("href"), tabs(pg).find((t: any) => t[0] === "Fleet")?.[1]];
    const first = hrefs();
    fire(pg.root.querySelector('.p-fleet a.seg-item[href="/ui/fleet/cache"]'), "click", { button: 0 }); await settle(6);   // no status, no store refresh
    const onCache = hrefs();
    fire(pg.root.querySelector('nav.tabs a.tab[href="/ui/fleet/cache"]') ?? pg.root.querySelector("nav.tabs a.tab.active"), "click", { button: 0 }); await settle(6);
    const afterTap = [navStore.get().route, pg.window.location.pathname];
    const p = mounted.pop()!; await p.unmount(); p.restore();
    const b = await shell("/ui/fleet/cache", { storage: { agend_last_fleet_tab: "org" } });
    const direct = [entry(b.pg).getAttribute("href"), tabs(b.pg).find((t: any) => t[0] === "Fleet")?.[1]];
    expect([first, onCache, afterTap, direct]).toEqual([["/ui/fleet/org", "/ui/fleet/org"], ["/ui/fleet/cache", "/ui/fleet/cache"],
      [{ panel: "fleet", tab: "cache" }, "/ui/fleet/cache"], ["/ui/fleet/cache", "/ui/fleet/cache"]]);
  });
  it("/ui/fleet (Tasks) is remembered as tasks; a stored value that is not a tab falls back to the Org chart", async () => {
    const out: unknown[] = [];
    for (const stored of ["tasks", "nope", "__proto__", "agent", ""]) {
      const { pg } = await shell("/ui/chat/web-dev", { storage: { agend_last_fleet_tab: stored } });
      out.push([stored, entry(pg).getAttribute("href")]);
      const p = mounted.pop()!; await p.unmount(); p.restore();
    }
    const { pg } = await shell("/ui/fleet");
    expect([out, pg.storage.get("agend_last_fleet_tab")]).toEqual([[["tasks", "/ui/fleet"], ["nope", "/ui/fleet/org"], ["__proto__", "/ui/fleet/org"], ["agent", "/ui/fleet/org"], ["", "/ui/fleet/org"]], "tasks"]);
  });
  it("only a Fleet tab is written: anything else leaves the remembered tab as it was", async () => {
    const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_last_fleet_tab: "teams" } });
    mounted.push(pg);
    const { rememberFleetTab } = await import("/assets/app-route.js");
    for (const t of ["nope", "agent", "__proto__", "", undefined, null]) rememberFleetTab(t);
    const kept = pg.storage.get("agend_last_fleet_tab");
    rememberFleetTab("usage");
    expect([kept, pg.storage.get("agend_last_fleet_tab")]).toEqual(["teams", "usage"]);
  });
  it("an instance's Details (/ui/fleet/agent/<name>) is not a Fleet tab: it leaves the remembered tab alone", async () => {
    const { pg } = await shell("/ui/fleet/agent/web-dev", { storage: { agend_last_fleet_tab: "usage" } });
    expect([pg.storage.get("agend_last_fleet_tab"), entry(pg).getAttribute("href")]).toEqual(["usage", "/ui/fleet/usage"]);
  });
  it("storage that throws: the Org chart, and the Fleet panel still opens", async () => {
    const { pg, navStore } = await shell("/ui/chat/web-dev");
    const ls = (globalThis as any).localStorage;
    const get = ls.getItem, set = ls.setItem;
    ls.getItem = () => { throw new Error("blocked"); }; ls.setItem = () => { throw new Error("blocked"); };
    try {
      await go("/ui/fleet/usage");
      await go("/ui/chat/web-dev");
      expect([entry(pg).getAttribute("href"), navStore.get().route]).toEqual(["/ui/fleet/org", { panel: "chat", instance: "web-dev" }]);
    } finally { ls.getItem = get; ls.setItem = set; }
  });
});

describe("a phone's tabs: Chat · Needs you · Fleet · Settings", () => {
  it("Chat is current on an agent's Chat, View, Log and Details and goes to its chat; Fleet is current on the Fleet panel only", async () => {
    const { pg } = await shell("/ui/chat/web-dev", { narrow: true });
    const out: unknown[] = [];
    for (const path of ["/ui/chat/web-dev", "/view/reviewer", "/ui/log/reviewer", "/ui/fleet/agent/reviewer", "/ui/fleet/org", "/ui/needs", "/settings", "/ui"]) {
      await go(path);
      out.push([path, tabs(pg).map((t: any) => t[2] ? `${t[0]}*` : t[0]), tabs(pg)[0][1]]);
    }
    expect(out).toEqual([
      ["/ui/chat/web-dev", ["Chat*", "Needs you", "Fleet", "Settings"], "/ui/chat/web-dev"],
      ["/view/reviewer", ["Chat*", "Needs you", "Fleet", "Settings"], "/ui/chat/reviewer"],
      ["/ui/log/reviewer", ["Chat*", "Needs you", "Fleet", "Settings"], "/ui/chat/reviewer"],
      ["/ui/fleet/agent/reviewer", ["Chat*", "Needs you", "Fleet", "Settings"], "/ui/chat/reviewer"],
      ["/ui/fleet/org", ["Chat", "Needs you", "Fleet*", "Settings"], "/ui"],
      ["/ui/needs", ["Chat", "Needs you*", "Fleet", "Settings"], "/ui"],
      ["/settings", ["Chat", "Needs you", "Fleet", "Settings*"], "/ui"],
      ["/ui", ["Chat*", "Needs you", "Fleet", "Settings"], "/ui"],   // #2185 review: the pick-an-agent page is Chat's
    ]);
  });
  it("in zh-TW", async () => {
    const { pg } = await shell("/ui/chat/web-dev", { narrow: true });
    (await import("/assets/app-i18n.js")).setLang("zh-TW"); await settle();
    expect(tabs(pg).map((t: any) => t[0])).toEqual(["聊天", "待處理", "Fleet", "設定"]);
  });
});

describe("the anonymous /view reader: unchanged", () => {
  it("its sidebar is View (and Sign in at the foot); its tabs View and Sign in; no Fleet anywhere", async () => {
    const { pg } = await shell("/view/web-dev", { viewOnly: true, narrow: true });
    expect([rows(pg), tabs(pg).map((t: any) => [t[0], t[1]]), entry(pg)]).toEqual([[["View", "/view"]], [["View", "/view/web-dev"], ["Sign in", expect.stringContaining("/")]], null]);
  });
});
