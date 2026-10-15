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
  it("chosen on Chat (L): the root says L; Details and Fleet show L; View stays on Fit (#1869); a reload keeps both", async () => {
    const pg = await app("/ui/chat/web-dev");
    pg.root.querySelector(".panel-head .hd-text").click(); await settle();   // M → L
    expect([pg.document.documentElement.dataset.textSize, pg.storage.get("agend_text_size"), textSize(pg)]).toEqual(["l", "l", "Text size: L"]);
    const { textSizeStore } = await import("/assets/header-tools.js");
    expect([textSizeStore.get().viewFit, pg.storage.get("agend_view_fit")], "a size chosen on Chat keeps View's Fit").toEqual([true, "1"]);
    await go("/ui/fleet/agent/web-dev"); expect(textSize(pg)).toBe("Text size: L");
    await go("/ui/fleet/org"); expect(textSize(pg)).toBe("Text size: L");
    await go("/view/web-dev"); expect(textSize(pg), "View is still on Fit").toBe("Text size: Fit");
    const again = await reload(pg, "/ui/fleet/agent/web-dev");
    expect([again.document.documentElement.dataset.textSize, textSize(again)]).toEqual(["l", "Text size: L"]);
    await go("/view/web-dev"); expect(textSize(again)).toBe("Text size: Fit");
  });
  it("#1869: View's own S / M / L still leave Fit, and a size chosen elsewhere afterwards keeps View on it", async () => {
    const pg = await app("/view/web-dev");
    pg.root.querySelector(".panel-head .hd-text").click(); await settle();   // Fit → S
    expect([textSize(pg), pg.storage.get("agend_view_fit"), pg.storage.get("agend_text_size")]).toEqual(["Text size: S", "0", "s"]);
    await go("/ui/chat/web-dev");
    pg.root.querySelector(".panel-head .hd-text").click(); await settle();   // S → M on Chat
    await go("/view/web-dev");
    expect([textSize(pg), pg.storage.get("agend_view_fit")]).toEqual(["Text size: M", "0"]);
  });
  it("#1869: a device whose Fit was turned off before the fix gets it back once; a later View choice is kept", async () => {
    const pg = await app("/ui/chat/web-dev", { agend_text_size: "l", agend_view_fit: "0" });
    expect([pg.storage.get("agend_view_fit"), pg.storage.get("agend_view_fit_1869"), pg.storage.get("agend_text_size")]).toEqual(["1", "1", "l"]);
    await go("/view/web-dev"); expect(textSize(pg)).toBe("Text size: Fit");
    pg.root.querySelector(".panel-head .hd-text").click(); await settle();   // Fit → S, in View
    const again = await reload(pg, "/view/web-dev");
    expect([textSize(again), again.storage.get("agend_view_fit")], "only once").toEqual(["Text size: S", "0"]);
  });
  it("View's Fit is View's own: chosen there, the others keep the shared size", async () => {
    const pg = await app("/view/web-dev", { agend_text_size: "s", agend_view_fit: "0", agend_view_fit_1869: "1" });
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
    ["a newer choice already there", { agend_view_density: "compact", agend_text_size: "l", agend_view_fit: "0", agend_view_fit_1869: "1" }, ["l", "0"]],
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
  // #1674: on Chat, Details and Fleet the size is pure CSS — the root's attribute, read through --text-scale by the
  // panel's scaled container — so a click changes it at once, with the panel still mounted and no navigation.
  it.each([
    ["Chat", "/ui/chat/web-dev", ".thread"],
    ["Details", "/ui/fleet/agent/web-dev", ".p-details .panel-body"],
    ["Fleet", "/ui/fleet/org", ".p-fleet .panel-body"],
  ])("#1674: %s — Aa while it is mounted changes the size at once, on the container the stylesheet scales", async (_n, path, scaled) => {
    const pg = await app(path, { agend_text_size: "m", agend_view_fit: "0" });
    const panel = pg.root.querySelector(".panel");
    expect(pg.root.querySelector(scaled), "the scaled container is on the page").not.toBeNull();
    for (const want of ["l", "s", "m"]) {
      pg.root.querySelector(".panel-head .hd-text").click(); await settle();
      expect([pg.document.documentElement.dataset.textSize, pg.root.querySelector(".panel") === panel], want).toEqual([want, true]);
    }
  });
  it("the root carries data-text-size and no style; nothing in the headers has a style attribute", async () => {
    const pg = await app("/ui/fleet/agent/web-dev", { agend_text_size: "l", agend_view_fit: "0" });
    expect([pg.document.documentElement.getAttribute("data-text-size"), pg.document.documentElement.getAttribute("style")]).toEqual(["l", null]);
    expect(pg.root.querySelectorAll(".panel-head [style]").length).toBe(0);
  });
  it("the stylesheet turns it into --text-scale, read by the chat, Details and Fleet", () => {
    const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");
    expect(css).toMatch(/:root\[data-text-size="s"\] \{ --text-scale: 0\.9; \}/);
    expect(css).toMatch(/:root\[data-text-size="l"\] \{ --text-scale: 1\.15; \}/);
    expect(css).toMatch(/\.thread, \.p-details \.panel-body, \.p-fleet \.panel-body, \.p-log \.panel-body \{[^}]*--fs-md: calc\(15px \* var\(--text-scale\)\)/);   // #1218: and the Log
  });
});

// beta.11 report (「UI 歪歪的 不同高」): the sidebar's brand row was 56 px with its centre at 30, every page header 52 px
// with its centre at 26; the title sat on its baseline, so badges and the status were 1–2 px lower than it; the header's
// small buttons and tabs were 30 px beside 36 px icon buttons. Real Chromium measured it (smoke-align.mts); these are the
// rules that hold the one row.
describe("one header row: the brand row and every page's header share a height and a centre line", () => {
  const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (sel: string) => { const m = new RegExp(`(?:^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css); return m ? m[1].replace(/\s+/g, " ").trim() : null; };
  it("the brand row: the header's row height and padding, the top inset its own (not the sidebar's)", () => {
    const side = rule(".side-head")!;
    for (const d of ["align-items: center;", "box-sizing: content-box;", "min-height: calc(var(--header-h) - 2 * var(--s-1));",
      "padding: max(var(--s-1), env(safe-area-inset-top)) var(--s-2) var(--s-1) var(--s-4);"]) expect(side, d).toContain(d);
    expect(rule(".sidebar")).toContain("padding: 0 0 env(safe-area-inset-bottom) env(safe-area-inset-left);");
    expect(rule(".panel-head")).toContain("padding: max(var(--s-1), env(safe-area-inset-top))");
  });
  it("the title row: one --header-h row on every page (a phone's tabs wrap under it), its title, status and badges centred", () => {
    const title = rule(".panel-title")!;
    expect(title).toContain("align-items: center;");
    expect(title).not.toContain("baseline");
    expect(title).toContain("min-height: calc(var(--header-h) - 2 * var(--s-1));");
  });
  it("the header's controls are one height: small buttons always; the instance tabs where they share the row", () => {
    expect(rule(".panel-head .btn-sm")).toBe("min-height: 36px;");
    expect(css).toMatch(/@media \(min-width: 900px\) \{ \.panel-head \.inst-switch \.seg-item \{ min-height: 36px; \} \}/);
    expect(rule(".icon-btn")).toContain("height: 36px;");
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
  it.each([["en", "Text size cycles Fit → S → M → L."], ["zh-TW", "「字級」會在填滿 → 小 → 中 → 大之間切換。"]])("%s", async (lang, want) => {
    const pg = await app("/view/web-dev");
    (await import("/assets/app-i18n.js")).setLang(lang); await settle(6);
    pg.root.querySelector(".p-view .panel-actions > button.icon-btn").click(); await settle(4);
    expect(pg.root.querySelectorAll("dialog .help-list li").map((li: any) => li.textContent).find((x: string) => x.includes("→")) ?? null).toContain(want);
  });
});

describe("#1585: the usage footer says how old the numbers are, and replaces a refreshing snapshot", () => {
  const foot = (pg: AppPage) => pg.root.querySelector("dialog .u-foot .note")?.textContent ?? null;
  const names = (pg: AppPage) => [...pg.root.querySelectorAll("dialog .u-provider strong")].map((e: any) => e.textContent);
  it.each([["en", "Updated 3 min ago · Refreshing…"], ["zh-TW", "3 分鐘前更新 · 更新中…"]])("%s: the age and that a fresh one is coming", async (lang, want) => {
    const pg = await app("/view/web-dev");
    (await import("/assets/app-i18n.js")).setLang(lang); await settle(4);
    usageHeld = [Promise.resolve({ providers: [{ id: "p", name: "STALE", status: "ok", metrics: [] }], fetchedAt: new Date(Date.now() - 3 * 60_000).toISOString(), refreshing: true })];
    pg.root.querySelector(".panel-head .hd-usage").click(); await settle(6);
    expect(foot(pg)).toBe(want);
  });
  it("a refreshing snapshot is read again shortly: the fresh numbers replace it (no Refresh press, no minute's wait)", async () => {
    const pg = await app("/view/web-dev");
    usageHeld = [
      Promise.resolve({ providers: [{ id: "p", name: "STALE", status: "ok", metrics: [] }], fetchedAt: new Date(Date.now() - 6 * 60_000).toISOString(), refreshing: true }),
      Promise.resolve({ providers: [{ id: "p", name: "FRESH", status: "ok", metrics: [] }], fetchedAt: new Date().toISOString() }),
    ];
    pg.root.querySelector(".panel-head .hd-usage").click(); await settle(6);
    expect([names(pg), foot(pg)?.includes("Refreshing")]).toEqual([["STALE"], true]);
    await new Promise((r) => setTimeout(r, 4_300)); await settle(6);
    expect([names(pg), foot(pg)]).toEqual([["FRESH"], "Updated just now"]);
  }, 15_000);
});
