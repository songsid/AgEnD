/**
 * #1523 N3 (§3.4, Q2 = A): every page's header has the same shared controls in the same order — Aa (text size), then
 * ◔ (usage, unless web.usage_panel is false) — and one text size per device (agend_text_size, taken over once from
 * View's agend_view_density), shared by Chat, Details, Fleet and View (View keeps Fit), across navigation and page
 * loads, set as one attribute on the root (no style attribute). The real Shell, router, store and panels in the mini DOM.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { installDom, MiniEvent } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
const live = (name: string, o: Record<string, unknown> = {}) => ({ name, status: "running", backend: "claude-code", model: "opus", context_pct: 10, tags: [], execution_state: "idle", ...o });
const INSTANCES = [live("web-dev")];
/** /api/ai-usage answers a test holds (each read takes the next); otherwise answered at once. */
let usageHeld: Array<Promise<unknown>> = [];
async function fakeFetch(url: string) {
  if (url.startsWith("/api/ai-usage") && usageHeld.length) { const b = await usageHeld.shift(); return { ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }; }
  const body: unknown = url.startsWith("/ui/instance/") ? { name: "web-dev", status: "running", kind: "agent", working_directory: "/w", tags: [], binding: { channel_id: null, implicit: false, topic_id: null, general_topic: false }, statusline: {}, recent_activity: [] }
    : url === "/api/profiles" ? [{ instance_name: "web-dev", status: "running", backend: "claude-code", tags: [] }]
    : url.startsWith("/api/ai-usage") ? { providers: [], fetchedAt: 1 } : url.startsWith("/ui/") ? [] : {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
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
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  usageHeld = [];
  (await import("/assets/app-i18n.js")).setLang("en");
});

const PANELS = () => new Map([
  ["chat", { load: async () => chat.ChatPanel }], ["details", { load: async () => details.DetailsPanel }],
  ["fleet", { load: async () => fleet.FleetPanel }], ["view", { load: async () => view.ViewPanel }],
  ["settings", { Component: () => h("div", { class: "stub-settings" }, "settings") }], ["needs", { Component: () => h("div", { class: "stub-needs" }, "needs") }],
]);
/** A page load of `path` with this browser's storage; `usagePanel` "0" is a fleet with web.usage_panel: false. */
async function app(path: string, storage: Record<string, string> = {}, usagePanel = "1") {
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1", ...storage } });
  mounted.push(pg);
  (globalThis as any).fetch = fakeFetch;
  pg.document.body.dataset.usagePanel = usagePanel;
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { viewStore } = await import("/assets/view-roster-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances: INSTANCES });
  viewStore.set({ loaded: true, error: null, roster: [{ instance_name: "web-dev", status: "running", backend: "claude-code", tags: [] }] });
  tools.initTextSize();                              // what app.js does on a page load
  await pg.mount(h(Shell, { panels: PANELS(), onNewInstance() {} }));
  await settle(8);
  return pg;
}
async function reload(prev: AppPage, path: string, usagePanel = "1") {
  const storage = Object.fromEntries(prev.storage);
  await prev.unmount(); prev.restore(); mounted.splice(mounted.indexOf(prev), 1);
  return app(path, storage, usagePanel);
}
const go = async (path: string) => { const { navigate } = await import("/assets/app-nav.js"); navigate(path); await settle(8); };
/** The header's controls, in order: [what, its label] — Aa, ◔, then the page's own (⋯ or Help). */
const controls = (pg: AppPage) => pg.root.querySelectorAll(".panel-head .panel-actions > button, .panel-head .panel-actions > .menu > button").map((b: any) => b.getAttribute("aria-label"));
const textSize = (pg: AppPage) => pg.root.querySelector(".panel-head .hd-text")?.getAttribute("aria-label") ?? null;

describe("the same controls, in the same order, on every page", () => {
  it("Chat, Details, Fleet and View: Aa, then ◔, then the page's own", async () => {
    const pg = await app("/ui/chat/web-dev");
    const seen: Record<string, string[]> = {};
    seen.chat = controls(pg);
    await go("/ui/fleet/agent/web-dev"); seen.details = controls(pg);
    await go("/ui/fleet/tasks"); seen.fleet = controls(pg);
    await go("/view/web-dev"); seen.view = controls(pg);
    expect(seen).toEqual({
      chat: ["Text size: M", "Usage", "More actions"],
      details: ["Text size: M", "Usage", "More actions"],
      fleet: ["Text size: M", "Usage"],
      view: ["Text size: Fit", "Usage", "Help"],
    });
  });
  it("a fleet with web.usage_panel: false: no ◔ on any page (and no read to find out)", async () => {
    const reads: string[] = [];
    const pg = await app("/ui/chat/web-dev", {}, "0");
    (globalThis as any).fetch = async (u: string) => { reads.push(u); return fakeFetch(u); };
    expect(controls(pg)).toEqual(["Text size: M", "More actions"]);
    await go("/view/web-dev");
    expect([controls(pg), reads.filter(r => r.startsWith("/api/ai-usage"))]).toEqual([["Text size: Fit", "Help"], []]);
  });
});

describe("one text size, across pages and page loads", () => {
  it("chosen on Chat (L): the root says L; Details, Fleet and View show L; a reload keeps it", async () => {
    const pg = await app("/ui/chat/web-dev");
    pg.root.querySelector(".panel-head .hd-text").click(); await settle();   // M → L
    expect([pg.document.documentElement.dataset.textSize, pg.storage.get("agend_text_size"), textSize(pg)]).toEqual(["l", "l", "Text size: L"]);
    await go("/ui/fleet/agent/web-dev"); expect(textSize(pg)).toBe("Text size: L");
    await go("/ui/fleet/org"); expect(textSize(pg)).toBe("Text size: L");
    await go("/view/web-dev"); expect(textSize(pg), "the last choice wins on View too").toBe("Text size: L");
    const again = await reload(pg, "/ui/fleet/agent/web-dev");
    expect([again.document.documentElement.dataset.textSize, textSize(again)]).toEqual(["l", "Text size: L"]);
  });
  it("View's Fit is View's own: chosen there, the others keep the shared size", async () => {
    const pg = await app("/view/web-dev", { agend_text_size: "s", agend_view_fit: "0" });
    expect(textSize(pg)).toBe("Text size: S");
    for (let i = 0; i < 3; i++) { pg.root.querySelector(".panel-head .hd-text").click(); await settle(); }   // S → M → L → Fit
    expect([textSize(pg), pg.storage.get("agend_view_fit"), pg.storage.get("agend_text_size")]).toEqual(["Text size: Fit", "1", "l"]);
    await go("/ui/chat/web-dev");
    expect([textSize(pg), pg.document.documentElement.dataset.textSize]).toEqual(["Text size: L", "l"]);
  });
  it.each([
    ["comfortable", { agend_view_density: "comfortable" }, ["l", "0"]],
    ["compact", { agend_view_density: "compact" }, ["s", "0"]],
    ["fit", { agend_view_density: "fit" }, ["m", "1"]],
    ["nothing", {}, ["m", "1"]],
    ["a newer choice already there", { agend_view_density: "compact", agend_text_size: "l", agend_view_fit: "0" }, ["l", "0"]],
  ])("taken over from View's old setting (%s), once", async (_n, storage, want) => {
    const pg = await app("/ui/fleet/tasks", storage as Record<string, string>);
    expect([pg.storage.get("agend_text_size"), pg.storage.get("agend_view_fit")]).toEqual(want);
  });
  it("another tab's choice follows (storage event)", async () => {
    const pg = await app("/ui/chat/web-dev");
    pg.storage.set("agend_text_size", "s"); pg.storage.set("agend_view_fit", "0");
    const e: any = new MiniEvent("storage", { cancelable: false }); e.key = "agend_text_size"; e.eventPhase = 2; e.target = pg.window;
    pg.window._fire(e, false); await settle();
    expect([textSize(pg), pg.document.documentElement.dataset.textSize]).toEqual(["Text size: S", "s"]);
  });
});

describe("no style attribute (#1300): one attribute on the root, one custom property in the stylesheet", () => {
  it("the root carries data-text-size and no style; nothing in the headers has a style attribute", async () => {
    const pg = await app("/ui/fleet/agent/web-dev", { agend_text_size: "l", agend_view_fit: "0" });
    expect([pg.document.documentElement.getAttribute("data-text-size"), pg.document.documentElement.getAttribute("style")]).toEqual(["l", null]);
    expect(pg.root.querySelectorAll(".panel-head [style]").length).toBe(0);
  });
  it("the stylesheet turns it into --text-scale, read by the chat, Details and Fleet", () => {
    const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");
    expect(css).toMatch(/:root\[data-text-size="s"\] \{ --text-scale: 0\.9; \}/);
    expect(css).toMatch(/:root\[data-text-size="l"\] \{ --text-scale: 1\.15; \}/);
    expect(css).toMatch(/\.thread, \.p-details \.panel-body, \.p-fleet \.panel-body \{[^}]*--fs-md: calc\(15px \* var\(--text-scale\)\)/);
  });
});

describe("#1563 review: the usage dialog belongs to the navigation that opened it", () => {
  const gate = () => { let open!: (v: unknown) => void; const p = new Promise((r) => { open = r; }); return { p, open }; };
  const OLD = { providers: [{ id: "p", name: "OLD NAVIGATION", status: "ok", metrics: [] }], fetchedAt: 1 };
  const shown = (pg: AppPage) => [pg.root.querySelector("dialog .u-provider strong")?.textContent ?? null, pg.root.querySelector("dialog") ? "dialog" : null];
  async function openUsageThen(path: string, then: (pg: AppPage) => Promise<void>) {
    const pg = await app(path);
    const held = gate();
    usageHeld = [held.p];
    pg.root.querySelector(".panel-head .hd-usage").click(); await settle(4);
    const before = shown(pg);
    await then(pg);
    const afterNav = shown(pg);
    held.open(OLD); await settle(6);
    return [before, afterNav, shown(pg)];
  }
  it.each([
    ["View A → View B", "/view/web-dev", async () => { await go("/view/other"); }],
    ["the same View route again", "/view/web-dev", async () => { await go("/view/web-dev"); }],
    ["another Fleet tab", "/ui/fleet/tasks", async () => { await go("/ui/fleet/org"); }],
    ["a language switch", "/ui/fleet/tasks", async () => { (await import("/assets/app-i18n.js")).setLang("zh-TW"); await settle(6); }],
  ])("%s: the dialog goes, and the old navigation's late answer is never shown", async (_n, path, then) => {
    const r = await openUsageThen(path, then);
    expect(r).toEqual([[null, "dialog"], [null, null], [null, null]]);
  });
  it("control: the same navigation — the answer lands in its dialog", async () => {
    const r = await openUsageThen("/view/web-dev", async () => { await settle(2); });
    expect(r).toEqual([[null, "dialog"], [null, "dialog"], ["OLD NAVIGATION", "dialog"]]);
  });
});

describe("#1563 review: View's Help says the new cycle", () => {
  it.each([["en", "Text size cycles Fit → S → M → L."], ["zh-TW", "「字級」會在剛好填滿 → 小 → 中 → 大之間切換。"]])("%s", async (lang, want) => {
    const pg = await app("/view/web-dev");
    (await import("/assets/app-i18n.js")).setLang(lang); await settle(6);
    pg.root.querySelector(".p-view .panel-actions > button.icon-btn").click(); await settle(4);
    expect(pg.root.querySelectorAll("dialog .help-list li").map((li: any) => li.textContent).find((x: string) => x.includes("→")) ?? null).toContain(want);
  });
});
