/**
 * #1673: AI usage is a right rail beside the page on a wide screen (min-width 1200px), the dialog's own body (one read,
 * one view), on the pages whose header has ◔. ◔ shows or hides it; that choice is this device's (agend_usage_rail) and
 * survives a reload. A hidden rail reads nothing; an open one keeps one lease across navigation. A fleet with
 * web.usage_panel: false has neither rail nor ◔. On a narrower screen ◔ opens the dialog, as before — and crossing the
 * width switches at once.
 *
 * The app's real Shell, router and panels in the fake DOM; /api/ai-usage is a fake that counts its reads.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { installDom } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
const USAGE = { providers: [{ id: "claude", name: "Claude", status: "ok", plan: "Max", metrics: [{ type: "percent", label: "5-hour", used: 42 }] }], fetchedAt: Date.now() };
let usageReads = 0;
async function fakeFetch(url: string) {
  if (url.startsWith("/api/ai-usage")) usageReads++;
  const body: unknown = url.startsWith("/ui/instance/") ? { name: "web-dev", status: "running", kind: "agent", working_directory: "/w", tags: [], binding: { channel_id: null, implicit: false, topic_id: null, general_topic: false }, statusline: {}, recent_activity: [] }
    : url === "/api/profiles" ? [{ instance_name: "web-dev", status: "running", backend: "claude-code", tags: [] }]
    : url.startsWith("/api/ai-usage") ? USAGE : url.startsWith("/ui/") ? [] : {};
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

let chat: any, details: any, fleet: any, view: any, tools: any;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/preview.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  // @ts-expect-error — a JS module of the app, with no types
  chat = await import("../src/ui/panel-chat.js");
  // @ts-expect-error — a JS module of the app, with no types
  details = await import("../src/ui/panel-details.js");
  // @ts-expect-error — a JS module of the app, with no types
  fleet = await import("../src/ui/panel-fleet.js");
  view = await import("/assets/panel-view.js");
  tools = await import("/assets/header-tools.js");
  chat.boot({ stream: { on() {} }, boot: null, deps: { fetch: () => new Promise(() => {}) } });
  base.restore();
});
// One page at a time, as a reload is: the rail's store is the page's module state, shared by every mounted page.
async function unmountAll() { for (const p of mounted.splice(0).reverse()) { await p.unmount(); p.restore(); } }
afterEach(async () => { await unmountAll(); usageReads = 0; });

/** A screen whose width the test sets; the page's matchMedia answers the rail's query from it and reports changes. */
function screen(wide: boolean) {
  const listeners = new Set<() => void>();
  const s = {
    wide,
    set(next: boolean) { s.wide = next; for (const fn of [...listeners]) fn(); },
    matchMedia: (q: string) => ({
      get matches() { return /min-width: 1200px/.test(q) ? s.wide : /max-width: 899px/.test(q) ? false : false; },
      addEventListener: (_t: string, fn: () => void) => listeners.add(fn), removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
    }),
  };
  return s;
}

const PANELS = () => new Map([
  ["chat", { load: async () => chat.ChatPanel }], ["details", { load: async () => details.DetailsPanel }],
  ["fleet", { load: async () => fleet.FleetPanel }], ["view", { load: async () => view.ViewPanel }],
  ["settings", { Component: () => h("div", { class: "stub-settings" }, "settings") }], ["needs", { Component: () => h("div", { class: "stub-needs" }, "needs") }],
]);
async function app(path: string, opts: { wide?: boolean; storage?: Record<string, string>; usagePanel?: string; scr?: ReturnType<typeof screen> } = {}) {
  await unmountAll();
  usageReads = 0;
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1", ...(opts.storage ?? {}) } });
  mounted.push(pg);
  const scr = opts.scr ?? screen(opts.wide ?? true);
  (globalThis as any).matchMedia = scr.matchMedia;
  (globalThis as any).fetch = fakeFetch;
  pg.document.body.dataset.usagePanel = opts.usagePanel ?? "1";
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { viewStore } = await import("/assets/view-roster-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances: [{ name: "web-dev", status: "running", backend: "claude-code", model: "opus", context_pct: 10, tags: [], execution_state: "idle" }] });
  viewStore.set({ loaded: true, error: null, roster: [{ instance_name: "web-dev", status: "running", backend: "claude-code", tags: [] }] });
  tools.initTextSize(); tools.initUsageRail();          // what app.js does on a page load
  await pg.mount(h(Shell, { panels: PANELS(), onNewInstance() {} }));
  await settle(8);
  return { pg, scr };
}
const go = async (path: string) => { const { navigate } = await import("/assets/app-nav.js"); navigate(path); await settle(8); };
const rail = (pg: AppPage) => pg.root.querySelector("aside.u-rail") !== null;
const hasDialog = (pg: AppPage) => pg.root.querySelector("dialog") !== null;
const railRows = (pg: AppPage) => (pg.root.querySelectorAll("aside.u-rail .u-provider") as any[]).map(s => s.textContent);
const dialogRows = (pg: AppPage) => (pg.root.querySelectorAll("dialog .u-provider") as any[]).map(s => s.textContent);
const usageBtn = (pg: AppPage) => pg.root.querySelector(".panel-head .hd-usage");

describe("#1673: a wide screen shows usage as a rail beside the page", () => {
  it("on Chat, View, Details and Fleet — the dialog's rows — and not on Settings or Needs you", async () => {
    const { pg } = await app("/ui/chat/web-dev");
    for (const path of ["/ui/chat/web-dev", "/view/web-dev", "/ui/fleet/agent/web-dev", "/ui/fleet/org"]) {
      if (path !== "/ui/chat/web-dev") await go(path);
      expect(rail(pg), path).toBe(true);
      expect(railRows(pg), path).toHaveLength(1);
      expect(railRows(pg)[0], path).toContain("Claude");
      expect(railRows(pg)[0], path).toContain("42");
      expect(pg.root.querySelector("main#main aside.u-rail") === null, "beside the page, not inside it").toBe(true);
      expect(usageBtn(pg)?.getAttribute("aria-pressed"), path).toBe("true");
    }
    for (const path of ["/settings", "/ui/needs"]) { await go(path); expect(rail(pg), path).toBe(false); }
  });

  it("the rail's rows are the dialog's rows (one body)", async () => {
    const wide = await app("/ui/chat/web-dev");
    const inRail = railRows(wide.pg);
    const narrow = await app("/ui/chat/web-dev", { wide: false });
    usageBtn(narrow.pg).click(); await settle(8);
    expect(dialogRows(narrow.pg)).toEqual(inRail);
  });

  it("◔ hides it and shows it again; the choice is this device's, kept across a reload; the rail's own button hides it", async () => {
    const { pg } = await app("/ui/chat/web-dev");
    usageBtn(pg).click(); await settle(4);
    expect([rail(pg), pg.storage.get("agend_usage_rail"), usageBtn(pg).getAttribute("aria-pressed"), hasDialog(pg)]).toEqual([false, "0", "false", false]);
    const again = await app("/ui/fleet/org", { storage: Object.fromEntries(pg.storage) });
    expect(rail(again.pg), "a reload keeps it hidden").toBe(false);
    usageBtn(again.pg).click(); await settle(8);
    expect([rail(again.pg), again.pg.storage.get("agend_usage_rail")]).toEqual([true, "1"]);
    again.pg.root.querySelector("aside.u-rail .u-rail-head button").click(); await settle(4);
    expect([rail(again.pg), again.pg.storage.get("agend_usage_rail")]).toEqual([false, "0"]);
  });

  it("a hidden rail reads nothing; an open one keeps its one read across navigation", async () => {
    await app("/ui/chat/web-dev", { storage: { agend_usage_rail: "0" } });
    expect(usageReads, "hidden: no /api/ai-usage read").toBe(0);
    const { pg } = await app("/ui/chat/web-dev");
    expect(usageReads).toBe(1);
    await go("/view/web-dev"); await go("/ui/fleet/org"); await go("/ui/chat/web-dev");
    expect([usageReads, rail(pg)], "the same rail, the same lease: no read per navigation").toEqual([1, true]);
  });
});

describe("#1673: no rail where there is no usage, and the dialog on a narrower screen", () => {
  it("web.usage_panel: false — no rail and no ◔, wide or narrow; no read", async () => {
    for (const wide of [true, false]) {
      const { pg } = await app("/ui/chat/web-dev", { wide, usagePanel: "0" });
      expect([rail(pg), usageBtn(pg) === null, usageReads], String(wide)).toEqual([false, true, 0]);
    }
  });

  it("narrow: no rail; ◔ opens the dialog", async () => {
    const { pg } = await app("/ui/chat/web-dev", { wide: false });
    expect([rail(pg), usageBtn(pg).getAttribute("aria-pressed")]).toEqual([false, null]);
    usageBtn(pg).click(); await settle(8);
    expect([hasDialog(pg), dialogRows(pg)]).toEqual([true, [expect.stringContaining("Claude")]]);
  });

  it("crossing the width switches at once: wide → the rail; narrower → gone, ◔ opens the dialog; wide again → the rail", async () => {
    const { pg, scr } = await app("/ui/chat/web-dev");
    expect(rail(pg)).toBe(true);
    scr.set(false); await settle(6);
    expect(rail(pg)).toBe(false);
    usageBtn(pg).click(); await settle(8);
    expect(hasDialog(pg)).toBe(true);
    pg.root.querySelector("dialog .dlg-x").click(); await settle(4);
    scr.set(true); await settle(8);
    expect([rail(pg), hasDialog(pg), pg.storage.get("agend_usage_rail") ?? null]).toEqual([true, false, null]);
  });

  it("a dialog opened on a narrower screen gives way to the rail when the screen widens (never both)", async () => {
    const { pg, scr } = await app("/ui/chat/web-dev", { wide: false });
    usageBtn(pg).click(); await settle(8);
    expect([hasDialog(pg), rail(pg)]).toEqual([true, false]);
    scr.set(true); await settle(8);
    expect([hasDialog(pg), rail(pg), usageReads], "the dialog's read, then the rail's — the closing dialog reads nothing more").toEqual([false, true, 2]);
  });

  // #1679 review (P2): widening closes the dialog for good — hiding the rail and narrowing again never brings it back.
  it.each([["the rail's ✕", "close"], ["◔", "button"]])("dialog → wide → hidden with %s → narrow again: nothing reopens, no third read", async (_n, how) => {
    const { pg, scr } = await app("/ui/chat/web-dev", { wide: false });
    usageBtn(pg).click(); await settle(8);
    scr.set(true); await settle(8);
    if (how === "close") pg.root.querySelector("aside.u-rail .u-rail-head button").click(); else usageBtn(pg).click();
    await settle(4);
    expect([hasDialog(pg), rail(pg)]).toEqual([false, false]);
    scr.set(false); await settle(8);
    expect([hasDialog(pg), rail(pg), usageReads]).toEqual([false, false, 2]);
  });

  it("this device's hidden choice is kept: dialog → wide shows neither, and the choice stays \"0\"", async () => {
    const { pg, scr } = await app("/ui/chat/web-dev", { wide: false, storage: { agend_usage_rail: "0" } });
    usageBtn(pg).click(); await settle(8);
    scr.set(true); await settle(8);
    expect([hasDialog(pg), rail(pg), pg.storage.get("agend_usage_rail")]).toEqual([false, false, "0"]);
    scr.set(false); await settle(8);
    expect([hasDialog(pg), rail(pg)]).toEqual([false, false]);
  });
});
