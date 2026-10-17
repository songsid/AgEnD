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
const INSTANCES = [live("web-dev", { tags: ["Platform"] }), live("api-server", { status: "stopped" }), live("qa-bot", { status: "paused" }), live("classic-ops-1", { tags: ["classic"] }), live("loner", { card_v: "v1" })];
/** #1629 r4 §1: loner's identity card, as GET /api/card/loner answers it (a person's tagline over the agent's bio). */
const PIC = "a".repeat(32);
const CARD = { portrait: { id: PIC, by: "agent", src: `/api/card/loner/portrait?v=${PIC}` }, banner: { id: PIC, by: "human", src: `/api/card/other/banner?v=${PIC}` },
  tagline: { text: "<b>Reviews</b> your PRs", by: "human" }, bio: { text: "Line one\nhttps://example.com", by: "agent" }, limits: {} };
const ROOM = { name: "classic-ops-1", status: "running", kind: "classic", description: "the ops room", display_name: "Ops", working_directory: null, backend: "codex", tags: ["classic"],
  binding: null, room: { name: "ops", channel_id: "555", adapter_id: "discord" }, model: "gpt", model_source: "live", effort: null, context_pct: 5, statusline: {}, recent_activity: [] };
/** Answers for /ui/instance/<name> held by a test: each read takes the next one (a promise it can settle later). */
const held = new Map<string, Array<Promise<{ status: number; body: unknown }>>>();
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
    "/api/settings/classic": { defaults: {}, channels: { "555:discord": { instanceName: "classic-ops-1", name: "ops", adapterId: "discord", channelId: "555", backend: "codex" } } }, "/api/settings/connections": [],
    "/api/settings/status-emojis": { keys: [], builtins: { discord: {}, telegram: {} }, telegram_allowed: [], suggestions: [] }, "/api/fleet": { version: "2.2.0", instances: [{ name: "web-dev", status: "running" }] },
    "/api/profiles": [{ instance_name: "web-dev", status: "running", backend: "claude-code", tags: [] }], "/api/settings/pending": [],
    "/api/card/loner": CARD,
  };
  if (m === "GET" && Object.prototype.hasOwnProperty.call(SETTINGS, url)) return { ok: true, status: 200, json: async () => structuredClone(SETTINGS[url]), text: async () => "" };
  if (url.startsWith("/ui/instance/") && held.get(decodeURIComponent(url.slice("/ui/instance/".length)))?.length) {
    const a = await held.get(decodeURIComponent(url.slice("/ui/instance/".length)))!.shift()!;
    return { ok: a.status < 300, status: a.status, json: async () => a.body, text: async () => JSON.stringify(a.body) };
  }
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
  held.clear();
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
  detail = { "web-dev": DETAIL("web-dev"), "api-server": { ...DETAIL("api-server"), status: "stopped", binding: { channel_id: "telegram", implicit: true, topic_id: null, general_topic: false } },
    "qa-bot": { ...DETAIL("qa-bot"), status: "paused" }, "classic-ops-1": ROOM, loner: { ...DETAIL("loner"), binding: { channel_id: null, implicit: false, topic_id: null, general_topic: false } } };
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
// The "Fleet" row (#1675's "Fleet overview" above it, also a /ui/fleet link, is another row).
const fleetLink = (pg: AppPage) => (pg.root.querySelectorAll(".side-nav a.side-row").find((a: any) => a.getAttribute("href")?.startsWith("/ui/fleet") && !a.classList.contains("side-overview")) as any) ?? null;
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
    const want = (cur: string) => [["Chat", "/ui/chat/web-dev", cur === "chat" ? "page" : null], ["View", "/view/web-dev", cur === "view" ? "page" : null],
      ["Log", "/ui/log/web-dev", cur === "log" ? "page" : null], ["Details", "/ui/fleet/agent/web-dev", cur === "details" ? "page" : null]];   // #1218: Log
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
    // Carried over, none new (leader 2026-10-10): no Delete on Details — it stays in Chat's ⋯ and Settings.
    // #1629: then a person's Lock and Reset of the agent's web theme.
    const THEME = ["Colour…", "Lock theme", "Reset theme…"];   // #1958: its colour, before the theme's Lock and Reset
    expect(await menuItems(pg)).toEqual(["Edit in Settings", "Restart instance", "Stop instance", "Pause", ...THEME]);
    await choose(pg, "Stop instance");
    await choose(pg, "Pause");
    expect(calls.filter(c => c.startsWith("POST"))).toEqual(["POST /ui/stop/web-dev", "POST /api/settings/instances/web-dev/pause"]);
    await go("/ui/fleet/agent/api-server");
    expect(await menuItems(pg)).toEqual(["Edit in Settings", "Start instance", ...THEME]);
    await go("/ui/fleet/agent/qa-bot");
    expect(await menuItems(pg)).toEqual(["Edit in Settings", "Wake", ...THEME]);
    await choose(pg, "Wake");
    expect(calls.filter(c => c.startsWith("POST")).at(-1)).toBe("POST /api/settings/instances/qa-bot/wake");
  });
  it("Edit in Settings goes to Settings and asks it for that agent's dialog", async () => {
    const pg = await app("/ui/fleet/agent/web-dev");
    pg.root.querySelector(".p-details .d-edit-settings").click(); await settle(4);
    expect([await route(), req.takeAgentRequest()]).toEqual([{ panel: "settings", section: "agents" }, { name: "web-dev", kind: "agent" }]);
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
      expect([viewOnly, sw(pg)]).toEqual(viewOnly ? [true, []] : [false, [["Chat", "/ui/chat/web-dev", null], ["View", "/view/web-dev", "page"], ["Log", "/ui/log/web-dev", null], ["Details", "/ui/fleet/agent/web-dev", null]]]);
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

describe("#1561 review", () => {
  const rowsOf = (pg: AppPage) => Object.fromEntries(pg.root.querySelectorAll(".p-details .d-config .kv").map((r: any) => [r.querySelector(".k").textContent, r.querySelector(".v").textContent]));
  it("a ClassicBot room: its own summary (no directory), Classic's actions only (pause), and Edit in Settings → its ClassicBot dialog", async () => {
    const pg = await app("/ui/fleet/agent/classic-ops-1");
    expect(rowsOf(pg)).toEqual({ "Display name": "Ops", Description: "the ops room", "Bound to": "ClassicBot room #ops (discord)", Tags: "classic" });
    expect(await menuItems(pg)).toEqual(["Edit in Settings", "Pause", "Colour…", "Lock theme", "Reset theme…"]);   // #1629: a Classic room's agent has a theme too; #1958 a colour
    pg.root.querySelector(".p-details .d-edit-settings").click(); await settle(4);
    expect([await route(), req.takeAgentRequest()]).toEqual([{ panel: "settings", section: "classic" }, { name: "classic-ops-1", kind: "classic" }]);
  });
  it("bound by default to the first connection says so; web only only when the fleet has no connection", async () => {
    const pg = await app("/ui/fleet/agent/api-server");
    expect(rowsOf(pg)["Bound to"]).toBe("telegram (the first connection, by default), no topic yet");
    await go("/ui/fleet/agent/loner");
    expect(rowsOf(pg)["Bound to"]).toBe("not bound (web only)");
  });
  it("Retry: an older read still on its way never overwrites a newer answer (failed or not)", async () => {
    const gate = () => { let open!: (v: { status: number; body: unknown }) => void; const p = new Promise<{ status: number; body: unknown }>((r) => { open = r; }); return { p, open }; };
    const a = gate(), b = gate();
    held.set("web-dev", [Promise.resolve({ status: 500, body: { error: "x" } }), a.p, b.p]);
    const pg = await app("/ui/fleet/agent/web-dev");
    const retry = () => pg.root.querySelector(".p-details .error-state .btn");
    expect(retry()?.textContent ?? null, "the first read failed").toBe("Try again");
    retry().click(); await settle();                       // Retry A: held
    retry().click(); await settle();                       // Retry B: held
    b.open({ status: 200, body: { ...DETAIL("web-dev"), description: "newest" } }); await settle(4);
    expect(rowsOf(pg).Description).toBe("newest");
    a.open({ status: 500, body: { error: "late" } }); await settle(4);
    expect([rowsOf(pg).Description ?? null, pg.root.querySelector(".p-details .error-state") ? "failed" : null]).toEqual(["newest", null]);
  });
});

describe("#1561 review: Settings opens a ClassicBot room's own dialog", () => {
  it("a classic request opens ClassicDialog for that room; a fleet agent's name as classic opens nothing", async () => {
    // @ts-expect-error — a JS module of the app, with no types
    const S = await import("../src/ui/panel-settings.js");
    for (const [name, want] of [["classic-ops-1", "dialog"], ["web-dev", null]] as const) {
      const pg = page({ url: "http://127.0.0.1:19280/settings/classic", storage: { agend_tour_done: "1" } });
      mounted.push(pg);
      (globalThis as any).fetch = fakeFetch;
      req.requestAgentSettings(name, "classic");
      await pg.mount(h(S.SettingsPanel, { route: { panel: "settings", section: "classic" }, navKey: `settings:classic|${name}|en` }));
      await settle(8);
      const dlg = pg.root.querySelector("dialog");
      expect([name, dlg ? "dialog" : null, dlg ? /ops/.test(dlg.textContent) : null]).toEqual([name, want, want ? true : null]);
      await pg.unmount(); pg.restore(); mounted.splice(mounted.indexOf(pg), 1);
    }
  });
});

describe("#1629 r4 §1: the identity card", () => {
  it("Details: at the top, text as text (never markup or a link), only this card's own picture paths, sized by its own S / M / L", async () => {
    const pg = await app("/ui/fleet/agent/loner");
    const card = pg.root.querySelector(".p-details .id-card");
    expect(card?.getAttribute("class")).toBe("id-card card-m");
    expect([card.querySelector(".id-tagline").textContent, card.querySelector(".id-bio").textContent]).toEqual(["<b>Reviews</b> your PRs", "Line one\nhttps://example.com"]);
    expect([card.querySelectorAll("b").length, card.querySelectorAll("a").length]).toEqual([0, 0]);
    expect(card.querySelectorAll("img").map((i: any) => [i.getAttribute("class"), i.getAttribute("src")])).toEqual([["id-portrait", `/api/card/loner/portrait?v=${PIC}`]]);   // another card's banner path is dropped
    expect(card.querySelector(".id-tagline").getAttribute("title")).toBe("set by a person");
    const size = (label: string) => card.querySelectorAll(".card-size .seg-item").find((b: any) => b.textContent === label);
    size("L").click(); await settle(2);
    expect([pg.root.querySelector(".p-details .id-card").getAttribute("class"), JSON.parse(pg.storage.get("agend_card_sizes") ?? "null")]).toEqual(["id-card card-l", { loner: "l" }]);
    size("M").click(); await settle(2);   // the default: its entry goes
    expect([pg.root.querySelector(".p-details .id-card").getAttribute("class"), pg.storage.get("agend_card_sizes") ?? null]).toEqual(["id-card card-m", null]);
    expect(calls.filter(c => c === "GET /api/card/loner").length).toBeLessThanOrEqual(1);   // once per version (the store is module-wide)
  });
  it("an instance with no card_v shows none, and reads none", async () => {
    const pg = await app("/ui/fleet/agent/web-dev");
    expect([pg.root.querySelector(".p-details .id-card"), calls.filter(c => c.startsWith("GET /api/card/"))]).toEqual([null, []]);
  });
  it("Chat: folded into the header by default (the tagline peeks); open is this device's choice, at the chat's own compact size", async () => {
    const pg = await app("/ui/chat/loner");
    const toggle = () => pg.root.querySelector(".p-chat .chat-card-toggle");
    expect([toggle().getAttribute("aria-expanded"), pg.root.querySelector(".p-chat .id-card"), pg.root.querySelector(".chat-card-peek").textContent]).toEqual(["false", null, "<b>Reviews</b> your PRs"]);
    toggle().click(); await settle(2);
    expect([pg.root.querySelector(".p-chat .id-card").getAttribute("class"), pg.root.querySelector(".p-chat .card-size"), pg.storage.get("agend_chat_card")]).toEqual(["id-card card-c bs-m", null, "open"]);
    // #2038: its banner follows this card's size choice (made on Details or in View).
    const { setCardSize } = await import("/assets/identity-card.js");
    setCardSize("loner", "l"); await settle(2);
    expect(pg.root.querySelector(".p-chat .id-card").getAttribute("class")).toBe("id-card card-c bs-l");
    setCardSize("loner", "m"); await settle(2);
    toggle().click(); await settle(2);
    expect([pg.root.querySelector(".p-chat .id-card"), pg.storage.get("agend_chat_card") ?? null]).toEqual([null, null]);
  });
  it("#2038: the banner's height follows the card's width (an aspect per size) between a floor and a ceiling — never half the size token", async () => {
    const css = (await import("node:fs")).readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8");
    const rule = (sel: string) => { const i = css.indexOf(`${sel} {`); expect(i, sel).toBeGreaterThanOrEqual(0); return css.slice(i, css.indexOf("}", i)); };
    // #2089: the floor and the ceiling yield to the box's width ÷ 2.25 on a narrow column (never narrower than 9 : 4).
    expect(rule(".id-banner")).toContain("aspect-ratio: var(--id-ar);\n  min-height: min(var(--id-bmin), calc(100cqw / 2.25)); max-height: min(var(--id-bmax), calc(100cqw / 2.25)); object-fit: cover;");
    expect(css).not.toContain("calc(var(--id-h) / 2)");
    // Every size, the chat header's and a phone's, sets a floor below its ceiling, and the chat's floor is at least 96 px.
    const px = (sel: string, v: string, from = 0) => { const i = css.indexOf(`${sel} {`, from); const m = new RegExp(`--${v}: (\\d+)px`).exec(css.slice(i, css.indexOf("}", i))); return m ? Number(m[1]) : null; };
    const phone = css.indexOf("@media (max-width: 479px) {\n  .id-card.card-s");
    expect(phone).toBeGreaterThan(0);
    for (const [sel, from] of [[".id-card", 0], [".id-card.card-s", 0], [".id-card.card-l", 0], [".id-card.card-c", 0], [".id-card.card-c.bs-s", 0], [".id-card.card-c.bs-l", 0],
      [".id-card.card-s", phone], [".id-card.card-m", phone], [".id-card.card-l", phone], [".id-card.card-c", phone], [".id-card.card-c.bs-s", phone], [".id-card.card-c.bs-l", phone]] as const) {
      const lo = px(sel, "id-bmin", from), hi = px(sel, "id-bmax", from);
      expect([lo !== null && hi !== null && lo < hi, sel, from > 0]).toEqual([true, sel, from > 0]);
      if (sel.startsWith(".id-card.card-c")) expect(lo!, sel).toBeGreaterThanOrEqual(80);
    }
  });
  it("#1888 review: the agent's working label shows only while working; its background's opacity goes through the CSSOM", async () => {
    const pg = await app("/ui/chat/loner");
    const { themesStore } = await import("/assets/app-themes.js");
    const { applyStatus } = await import("/assets/app-store.js");
    try {
      themesStore.set({ themes: { loner: { v: 1, workingLabel: "Brewing", background: { image: PIC, fit: "cover", opacity: 0.35 } } }, shown: true }); await settle(4);
      const as = async (state: string) => { applyStatus({ instances: INSTANCES.map(i => (i.name === "loner" ? { ...i, execution_state: state } : i)) }); await settle(4); return pg.root.querySelector(".p-chat .work-bar .lbl")?.textContent ?? null; };
      expect(await as("working")).toBe("Brewing");
      expect(await as("stuck")).not.toBe("Brewing");
      expect((pg.root.querySelector(".p-chat .th-bg") as any).style["--th-bg-opacity"]).toBe("0.35");
    } finally { themesStore.set({ themes: {} }); applyStatus({ instances: INSTANCES }); }
  });
});
