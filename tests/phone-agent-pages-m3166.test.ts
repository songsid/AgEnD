/**
 * M-3166 PR 5 (the user, round 2: the tab row goes everywhere on a phone): View, Log and Details get the chat's header —
 * "← name ● ⋯" — and the same ⋯ sheet (src/ui/shared/agent-sheet.js), whose first tile is Chat when you are not on it.
 * - on a phone: the header has the sheet's ⋯; the sheet starts with Chat, leaves out the page you are on, keeps Search;
 *   Agent details is a row except on Details; Details' own controls are under This agent; its colour is under Appearance
 * - on a desk: no sheet (the header as before: its tab row, tools and menu)
 * The real Shell, router, store and the Log and Details panels (the web-details-n2 harness), a fake fetch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire, installDom } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
const live = (name: string, o: Record<string, unknown> = {}) => ({ name, status: "running", backend: "claude-code", model: "opus", context_pct: 10, tags: [], execution_state: "idle", ...o });
const INSTANCES = [live("web-dev"), live("planner")];
const DETAIL = (name: string) => ({
  name, status: "running", description: "Builds the site", display_name: "Web developer", working_directory: "/w/web", backend: "claude-code",
  tags: [], binding: { channel_id: "discord-2", topic_id: "1234", general_topic: false }, model: "opus", model_source: "live", effort: null,
  context_pct: 42, statusline: {}, recent_activity: [],
});
const PROFILES = INSTANCES.map((i) => ({ instance_name: i.name, display_name: i.name, status: i.status, backend: i.backend }));
async function fakeFetch(url: string) {
  const body: unknown = url.startsWith("/ui/instance/") ? DETAIL(decodeURIComponent(url.slice("/ui/instance/".length)))
    : url.startsWith("/api/profiles") ? PROFILES : {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}
let chat: any, details: any, log: any;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  // @ts-expect-error — a JS module of the app, with no types
  chat = await import("../src/ui/panel-chat.js");
  // @ts-expect-error — a JS module of the app, with no types
  details = await import("../src/ui/panel-details.js");
  // @ts-expect-error — a JS module of the app, with no types
  log = await import("../src/ui/panel-log.js");
  chat.boot({ stream: { on() {} }, boot: null, deps: { fetch: () => new Promise(() => {}) } });
  base.restore();
});
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  (await import("/assets/app-store.js")).appStore.set({ viewOnly: false });
  if (typeof document !== "undefined" && document.body) { delete document.body.dataset.tier; delete document.body.dataset.guestLevel; }
});

const PANELS = () => new Map<string, any>([
  ["chat", { load: async () => chat.ChatPanel }], ["details", { load: async () => details.DetailsPanel }], ["log", { load: async () => log.LogPanel }],
  ["view", { load: async () => (await import("/assets/panel-view.js")).ViewPanel }],
  ...["fleet", "settings", "needs"].map((k) => [k, { Component: () => h("div", { class: `stub-${k}` }, k) }] as [string, any]),
]);
async function app(path: string, { narrow = true, guest = null as null | "trusted", viewOnly = false } = {}) {
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1" }, matchNarrow: narrow });
  mounted.push(pg);
  // A guest's page: the server marks <body> (#2855); an anonymous reader's: the store's viewOnly (#1408 §3).
  if (guest) { document.body.dataset.tier = "guest"; document.body.dataset.guestLevel = guest; }
  if (viewOnly) (await import("/assets/app-store.js")).appStore.set({ viewOnly: true });
  (globalThis as any).fetch = fakeFetch;
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances: INSTANCES });
  await pg.mount(h(Shell, { panels: PANELS(), onNewInstance() {} }));
  await settle(8);
  return pg;
}
/** View's roster is read after it mounts (/api/profiles, or a guest's status frame): wait until it shows the agent's status. */
async function viewLoaded(pg: AppPage) {
  for (let i = 0; i < 60 && !pg.root.querySelector(".p-view > .panel-head .panel-sub .status"); i++) await settle(2);
  expect(pg.root.querySelector(".p-view > .panel-head .panel-sub .status"), "View loaded its agent (not an empty header)").toBeTruthy();
}
async function openSheet(pg: AppPage, panel: string) {
  const btn = pg.root.querySelector(`.${panel} > .panel-head .panel-actions .chat-sheet-more`) as any;
  expect(btn, `${panel}: the header's ⋯ (a phone's sheet)`).toBeTruthy();
  fire(btn, "click"); await settle(6);
  const sheet = pg.root.querySelector(".chat-sheet") as any;
  expect(sheet, "the sheet").toBeTruthy();
  return {
    sheet,
    tiles: [...sheet.querySelectorAll(".chat-sheet-tile")].map((b: any) => b.textContent.trim()),
    rows: [...sheet.querySelectorAll(".chat-sheet-row, .menu-heading")].map((n: any) => (n.classList.contains("menu-heading") ? `# ${n.textContent.trim()}` : n.textContent.trim())),
  };
}

describe("M-3166 PR 5: View, Log and Details share the chat's phone header and its ⋯ sheet", () => {
  it("Details on a phone: Chat first, no Details tile or row; its own controls under This agent; its colour under Appearance", async () => {
    const pg = await app("/ui/fleet/agent/web-dev");
    const { sheet, tiles, rows } = await openSheet(pg, "p-details");
    expect(tiles[0]).toBe("Chat");
    expect(tiles).toContain("Search");
    expect(rows.some((r) => /^Agent details/.test(r))).toBe(false);
    const head = rows.indexOf("# This agent");
    expect(head, JSON.stringify(rows)).toBeGreaterThan(-1);
    expect(rows.slice(head + 1).map((r) => r.replace(/\s+/g, " "))).toEqual(expect.arrayContaining([expect.stringMatching(/^Restart/), expect.stringMatching(/^Stop/)]));
    expect(rows.some((r) => /^Appearance/.test(r))).toBe(true);
    fire([...sheet.querySelectorAll(".chat-sheet-tile")].find((b: any) => b.textContent.trim() === "Chat"), "click"); await settle(6);
    expect(pg.window.location.pathname).toBe("/ui/chat/web-dev");
  });

  it("Log on a phone: Chat first, View, Search, no Log tile; Agent details goes to Details", async () => {
    const pg = await app("/ui/log/web-dev");
    const { sheet, tiles, rows } = await openSheet(pg, "p-log");
    expect(tiles.slice(0, 3)).toEqual(["Chat", "View", "Search"]);
    expect(tiles).not.toContain("Log");
    expect(rows.some((r) => r === "# This agent")).toBe(false);   // the Log has no controls of its own
    fire([...sheet.querySelectorAll(".chat-sheet-row")].find((b: any) => /^Agent details/.test(b.textContent.trim())), "click"); await settle(6);
    expect(pg.window.location.pathname).toBe("/ui/fleet/agent/web-dev");
  });

  it("View on a phone (an admin): the sheet starts with Chat, has Log and Search, and no View tile", async () => {
    const pg = await app("/view/web-dev");
    await viewLoaded(pg);
    const { tiles, rows } = await openSheet(pg, "p-view");
    expect(tiles[0]).toBe("Chat");
    expect(tiles).toEqual(expect.arrayContaining(["Log", "Search"]));
    expect(tiles, "no tile for the page you are on").not.toContain("View");
    expect(rows.some((r) => /^Agent details/.test(r))).toBe(true);
  });

  // #4018 review: the sheet is an admin's. A Trusted guest's View or an anonymous reader's keeps its own header, no ⋯ sheet.
  it("View on a phone, a Trusted guest: no sheet; its own tab row stays", async () => {
    const pg = await app("/view/web-dev", { guest: "trusted" });
    await viewLoaded(pg);
    const head = pg.root.querySelector(".p-view > .panel-head") as any;
    expect(head, "View's header").toBeTruthy();
    expect(head.querySelector(".chat-sheet-more")).toBeNull();
    expect(head.querySelector(".inst-switch"), "a Trusted guest's Chat | View row").toBeTruthy();
  });
  it("View on a phone, an anonymous reader (viewOnly): no sheet", async () => {
    const pg = await app("/view/web-dev", { viewOnly: true });
    await viewLoaded(pg);
    const head = pg.root.querySelector(".p-view > .panel-head") as any;
    expect(head, "View's header").toBeTruthy();
    expect(head.querySelector(".chat-sheet-more")).toBeNull();
  });

  it("the chat's sheet is the same module: no Chat tile there, View and Log first", async () => {
    const pg = await app("/ui/chat/web-dev");
    const { tiles } = await openSheet(pg, "p-chat");
    expect(tiles.slice(0, 3)).toEqual(["View", "Log", "Search"]);
  });

  it("a desk: no sheet on Log or Details (their header as before)", async () => {
    for (const path of ["/ui/log/web-dev", "/ui/fleet/agent/web-dev"]) {
      const pg = await app(path, { narrow: false });
      expect(pg.root.querySelector(".panel-head .chat-sheet-more"), path).toBeNull();
      expect(pg.root.querySelector(".panel-head .inst-switch"), path).toBeTruthy();
      await pg.unmount(); pg.restore(); mounted.splice(mounted.indexOf(pg), 1);
    }
  });

  it("the CSS: the other pages give their header up only when it has the sheet; the module is served", () => {
    const css = readFileSync(join(process.cwd(), "src/ui/shared/chat-work-bar.css"), "utf8");
    const block = css.slice(css.indexOf("M-3166 PR 5"));
    const hide = block.slice(0, block.indexOf("{ display: none !important; }"));
    expect(hide).toContain(":is(.p-view, .p-log, .p-details) > .panel-head:has(.chat-sheet-more) :is(.sb-search, .inst-switch)");
    expect(hide).toContain(":is(.p-view, .p-log, .p-details) > .panel-head:has(.chat-sheet-more) .panel-actions > :not(.chat-sheet-more):not(.dlg)");
    expect(readFileSync(join(process.cwd(), "src/auth-api.ts"), "utf8")).toContain('"agent-sheet.js"');
  });
});
