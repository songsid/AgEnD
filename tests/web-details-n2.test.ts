/**
 * #1523 N2 (docs/design/web-unified-instance-nav.md §3.2, §3.3; decisions Q1 = B, Q4 = A): one instance's Details at
 * /ui/fleet/agent/<name>, the Chat | View | Details switch that keeps the instance, and "Fleet" with an instance open
 * going to that instance's Details (with none: Tasks, as before). The real Shell, router, store and panels in the mini
 * DOM; fetch is a fake that records what is called.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire, installDom } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
let calls: string[] = [];
let detail: Record<string, unknown> = {};
const live = (name: string, o: Record<string, unknown> = {}) => ({ name, status: "running", backend: "claude-code", model: "opus", context_pct: 10, tags: [], execution_state: "idle", ...o });
const INSTANCES = [live("web-dev", { tags: ["Platform"] }), live("api-server", { status: "stopped" }), live("qa-bot", { status: "paused" })];
const DETAIL = (name: string) => ({
  name, status: "running", description: "Builds the site", display_name: "Web developer", working_directory: "/w/web", backend: "claude-code",
  tags: ["Platform", "web"], binding: { channel_id: "discord-2", topic_id: "1234", general_topic: false },
  model: "opus", model_source: "live", effort: null, context_pct: 42, statusline: {}, recent_activity: [{ timestamp: "2026-10-10 01:02:03", event: "message", summary: "hello" }],
});

async function fakeFetch(url: string, init: { method?: string } = {}) {
  const m = init.method || "GET";
  calls.push(`${m} ${url}`);
  const SETTINGS: Record<string, unknown> = {
    "/api/settings/schema": { impacts: {}, order: ["now", "instance", "fleet"] },
    "/api/settings/fleet/raw": { defaults: {}, channels: [], instances: { "web-dev": { working_directory: "/w/web", description: "Builds the site" } } },
    "/api/settings/classic": { defaults: {}, channels: {} }, "/api/settings/connections": [],
    "/api/settings/status-emojis": { keys: [], builtins: { discord: {}, telegram: {} }, telegram_allowed: [], suggestions: [] }, "/api/fleet": { version: "2.2.0", instances: [{ name: "web-dev", status: "running" }] },
    "/api/profiles": [{ instance_name: "web-dev", status: "running", backend: "claude-code", tags: [] }], "/api/settings/pending": [],
  };
  if (m === "GET" && Object.prototype.hasOwnProperty.call(SETTINGS, url)) return { ok: true, status: 200, json: async () => structuredClone(SETTINGS[url]), text: async () => "" };
  const body: unknown = url.startsWith("/ui/instance/") ? detail[decodeURIComponent(url.slice("/ui/instance/".length))] ?? { error: "Instance not found" }
    : m === "POST" ? { ok: true } : {};
  const status = url.startsWith("/ui/instance/") && !detail[decodeURIComponent(url.slice("/ui/instance/".length))] ? 404 : 200;
  return { ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

let details: any, chat: any, req: any;
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
  req = await import("../src/ui/settings-request.js");
  chat.boot({ stream: { on() {} }, boot: null, deps: { fetch: () => new Promise(() => {}) } });
  base.restore();
});
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  (await import("/assets/app-store.js")).appStore.set({ viewOnly: false });
  req.takeAgentRequest();
  calls = [];
});

const PANELS = () => new Map([
  ["chat", { load: async () => chat.ChatPanel }], ["details", { load: async () => details.DetailsPanel }],
  ["view", { Component: () => h("div", { class: "stub-view" }, "view") }], ["fleet", { Component: () => h("div", { class: "stub-fleet" }, "fleet") }],
  ["settings", { Component: () => h("div", { class: "stub-settings" }, "settings") }], ["needs", { Component: () => h("div", { class: "stub-needs" }, "needs") }],
]);
async function app(path: string) {
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1" } });
  mounted.push(pg);
  (globalThis as any).fetch = fakeFetch;
  detail = { "web-dev": DETAIL("web-dev"), "api-server": { ...DETAIL("api-server"), status: "stopped" }, "qa-bot": { ...DETAIL("qa-bot"), status: "paused" } };
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances: INSTANCES });
  await pg.mount(h(Shell, { panels: PANELS(), onNewInstance() {} }));
  await settle(6);
  return pg;
}
/** A page load of `path`: the page before it gone first (unmounted, its globals restored). */
async function reload(prev: AppPage, path: string) { await prev.unmount(); prev.restore(); mounted.splice(mounted.indexOf(prev), 1); return app(path); }
const go = async (path: string) => { const { navigate } = await import("/assets/app-nav.js"); navigate(path); await settle(6); };
const route = async () => (await import("/assets/app-nav.js")).navStore.get().route;
const fleetLink = (pg: AppPage) => (pg.root.querySelectorAll(".side-nav a.side-row").find((a: any) => a.getAttribute("href")?.startsWith("/ui/fleet")) as any) ?? null;
const fleetTab = (pg: AppPage) => (pg.root.querySelectorAll("nav.tabs a.tab").find((a: any) => a.getAttribute("href")?.startsWith("/ui/fleet")) as any) ?? null;
const sw = (pg: AppPage) => pg.root.querySelectorAll(".inst-switch a.seg-item").map((a: any) => [a.textContent, a.getAttribute("href"), a.getAttribute("aria-current") ?? null]);
const menuItems = async (pg: AppPage) => {
  pg.root.querySelector(".p-details .menu > button").click(); await settle();
  return pg.root.querySelectorAll(".p-details .menu-list .menu-item").map((b: any) => b.textContent.trim());
};
const choose = async (pg: AppPage, label: string) => {
  if (!pg.root.querySelector(".p-details .menu-list")) { pg.root.querySelector(".p-details .menu > button").click(); await settle(); }
  pg.root.querySelectorAll(".p-details .menu-list .menu-item").find((b: any) => b.textContent.trim() === label).click(); await settle(4);
};

describe("Fleet goes to the open instance's Details (the user's complaint)", () => {
  it("from Chat, View or Details of an instance: its Details; from Tasks or Settings: Tasks — sidebar and phone tab alike", async () => {
    const pg = await app("/ui/chat/web-dev");
    expect([fleetLink(pg)?.getAttribute("href") ?? null, fleetTab(pg)?.getAttribute("href") ?? null]).toEqual(["/ui/fleet/agent/web-dev", "/ui/fleet/agent/web-dev"]);
    await go("/view/api-server");
    expect(fleetLink(pg)?.getAttribute("href") ?? null).toBe("/ui/fleet/agent/api-server");
    await go("/ui/fleet/agent/qa-bot");
    expect([fleetLink(pg)?.getAttribute("href") ?? null, fleetLink(pg)?.getAttribute("aria-current") ?? null]).toEqual(["/ui/fleet/agent/qa-bot", "page"]);
    await go("/ui/fleet/org");
    expect(fleetLink(pg)?.getAttribute("href") ?? null).toBe("/ui/fleet");
    await go("/settings");
    expect([fleetLink(pg)?.getAttribute("href") ?? null, fleetTab(pg)?.getAttribute("href") ?? null]).toEqual(["/ui/fleet", "/ui/fleet"]);
  });
  it("a click on Fleet from an instance's chat lands on its Details (a client navigation)", async () => {
    const pg = await app("/ui/chat/web-dev");
    fire(fleetLink(pg), "click", { button: 0 }); await settle(6);
    expect([await route(), pg.window.location.pathname]).toEqual([{ panel: "details", instance: "web-dev" }, "/ui/fleet/agent/web-dev"]);
    expect(pg.root.querySelector(".p-details h1")?.textContent ?? null).toBe("web-dev");
  });
});

describe("the switch keeps the instance", () => {
  it("Chat and Details of web-dev: Chat | View | Details of web-dev, the current one marked; a reload of the URL keeps the view", async () => {
    const pg = await app("/ui/chat/web-dev");
    const want = (cur: string) => [["Chat", "/ui/chat/web-dev", cur === "chat" ? "page" : null], ["View", "/view/web-dev", cur === "view" ? "page" : null], ["Details", "/ui/fleet/agent/web-dev", cur === "details" ? "page" : null]];
    expect(sw(pg)).toEqual(want("chat"));
    const d = pg.root.querySelectorAll(".inst-switch a.seg-item").find((a: any) => a.textContent === "Details");
    fire(d, "click", { button: 0 }); await settle(6);
    expect([await route(), sw(pg)]).toEqual([{ panel: "details", instance: "web-dev" }, want("details")]);
    const again = await reload(pg, "/ui/fleet/agent/web-dev");
    expect(sw(again)).toEqual(want("details"));
  });
  it("Chat's ⋯ → Details is the page now, not a dialog", async () => {
    const pg = await app("/ui/chat/web-dev");
    pg.root.querySelector(".p-chat .menu > button").click(); await settle();
    pg.root.querySelectorAll(".p-chat .menu-list .menu-item").find((b: any) => b.textContent.trim() === "Instance details").click(); await settle(6);
    expect([await route(), pg.root.querySelector("dialog") ? "dialog" : null]).toEqual([{ panel: "details", instance: "web-dev" }, null]);
  });
});

describe("Details (Q1 = B)", () => {
  it("runtime, recent activity and a read-only config summary — nothing to edit on the page", async () => {
    const pg = await app("/ui/fleet/agent/web-dev");
    const rows = Object.fromEntries(pg.root.querySelectorAll(".p-details .d-config .kv").map((r: any) => [r.querySelector(".k").textContent, r.querySelector(".v").textContent]));
    expect(rows).toEqual({ "Display name": "Web developer", Description: "Builds the site", Directory: "/w/web", "Bound to": "discord-2, topic 1234", Tags: "Platformweb" });
    expect(pg.root.querySelector(".p-details .activity")?.textContent ?? "").toContain("hello");
    expect(pg.root.querySelectorAll(".p-details input, .p-details textarea, .p-details select").length, "read only").toBe(0);
    expect(calls.filter(c => c.startsWith("GET /ui/instance/")), "one read when it opens").toEqual(["GET /ui/instance/web-dev"]);
  });
  it("the actions are the state's, through the existing calls: running → restart / stop / pause; stopped → start; paused → wake", async () => {
    const pg = await app("/ui/fleet/agent/web-dev");
    expect(await menuItems(pg)).toEqual(["Edit in Settings", "Restart instance", "Stop instance", "Pause", "Delete instance…"]);
    await choose(pg, "Stop instance");
    await choose(pg, "Pause");
    expect(calls.filter(c => c.startsWith("POST"))).toEqual(["POST /ui/stop/web-dev", "POST /api/settings/instances/web-dev/pause"]);
    await go("/ui/fleet/agent/api-server");
    expect(await menuItems(pg)).toEqual(["Edit in Settings", "Start instance", "Delete instance…"]);
    await go("/ui/fleet/agent/qa-bot");
    expect(await menuItems(pg)).toEqual(["Edit in Settings", "Wake", "Delete instance…"]);
    await choose(pg, "Wake");
    expect(calls.filter(c => c.startsWith("POST")).at(-1)).toBe("POST /api/settings/instances/qa-bot/wake");
  });
  it("Delete asks with Chat's typed confirmation; Edit in Settings goes to Settings and asks it for that agent's dialog", async () => {
    const pg = await app("/ui/fleet/agent/web-dev");
    await choose(pg, "Delete instance…");
    expect(pg.root.querySelector("dialog input")?.getAttribute("placeholder") ?? null).toBe("delete web-dev");
    expect(calls.filter(c => c.includes("/delete")), "nothing deleted by opening it").toEqual([]);
    pg.root.querySelector("dialog .btn:not(.btn-danger)").click(); await settle();
    pg.root.querySelector(".p-details .d-edit-settings").click(); await settle(4);
    expect([await route(), req.takeAgentRequest()]).toEqual([{ panel: "settings", section: "agents" }, "web-dev"]);
  });
  it("an unknown instance: not found, with no actions", async () => {
    const pg = await app("/ui/fleet/agent/nobody");
    expect([pg.root.querySelector(".p-details .empty-title")?.textContent ?? null, pg.root.querySelector(".p-details .menu") ? "menu" : null]).toEqual(["No instance called “nobody”", null]);
  });
});

describe("View: the switch for a signed-in person, none for the anonymous reader", () => {
  it("signed in: Chat | View | Details of the instance; view-only: no switch", async () => {
    const { ViewPanel } = await import("/assets/panel-view.js");
    const { viewStore } = await import("/assets/view-roster-store.js");
    const { appStore } = await import("/assets/app-store.js");
    for (const viewOnly of [false, true]) {
      const pg = page({ url: "http://127.0.0.1:19280/view/web-dev", storage: { agend_tour_done: "1" } });
      mounted.push(pg);
      (globalThis as any).fetch = fakeFetch;
      appStore.set({ viewOnly });
      viewStore.set({ loaded: true, error: null, roster: [{ instance_name: "web-dev", status: "running", backend: "claude-code", tags: [] }] });
      await pg.mount(h(ViewPanel, { route: { panel: "view", instance: "web-dev" }, navKey: `view:web-dev|${viewOnly}` }));
      await settle(3);
      expect([viewOnly, sw(pg)]).toEqual(viewOnly ? [true, []] : [false, [["Chat", "/ui/chat/web-dev", null], ["View", "/view/web-dev", "page"], ["Details", "/ui/fleet/agent/web-dev", null]]]);
      await pg.unmount(); pg.restore(); mounted.splice(mounted.indexOf(pg), 1);
    }
  });
});

describe("Edit in Settings: that agent's dialog — only an agent Settings knows", () => {
  async function settings(want: string | null) {
    // @ts-expect-error — a JS module of the app, with no types
    const S = await import("../src/ui/panel-settings.js");
    const pg = page({ url: "http://127.0.0.1:19280/settings", storage: { agend_tour_done: "1" } });
    mounted.push(pg);
    (globalThis as any).fetch = fakeFetch;
    if (want !== null) req.requestAgentSettings(want);
    await pg.mount(h(S.SettingsPanel, { route: { panel: "settings", section: "agents" }, navKey: `settings:agents|${want}|en` }));
    await settle(8);
    return pg;
  }
  it("web-dev: its dialog opens once the data is in; asked once (a second visit opens nothing)", async () => {
    const pg = await settings("web-dev");
    expect(pg.root.querySelector("dialog")?.textContent ?? "").toContain("ID: web-dev");
    expect(req.takeAgentRequest(), "taken").toBeNull();
  });
  it("an agent this configuration does not have (or an inherited key): nothing opens", async () => {
    for (const name of ["nobody", "__proto__", "constructor"]) {
      const pg = await settings(name);
      expect([name, pg.root.querySelector("dialog") ? "dialog" : null]).toEqual([name, null]);
      await pg.unmount(); pg.restore(); mounted.splice(mounted.indexOf(pg), 1);
    }
  });
});
