/**
 * M-3115 PR 1 (phone v2, the user's approval 11-14; mockup chat-changes-summary.html §2): on a phone, inside an agent's
 * pages, there are no bottom tabs — like LINE / Telegram, the lists keep them.
 * - The header's first button is ‹ (back to the agents: the drawer), carrying what Needs you counts.
 * - ⋯ starts with 「前往」: Needs you (its count), Fleet, Settings; then 「這個對話」 and this chat's items; it ends with
 *   「✓ 已驗證」, which the line under the composer no longer says (Not verified / Authorize / waiting still do).
 * - A Needs-you item that arrives meanwhile for another agent is a short toast; the first load is not news.
 * - A desk is unchanged: ☰, the same ⋯.
 * The real Shell, router, store and chat panel (the web-details-n2 harness), a fake fetch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire, installDom } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
let auth: any = { state: "verified", until: Date.now() + 3_600_000 };
async function fakeFetch(url: string, init: { method?: string } = {}) {
  if (url === "/ui/authorization" && (init.method ?? "GET") === "GET") return { ok: true, status: 200, json: async () => auth, text: async () => "" };
  return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
}
const INSTANCES = [{ name: "web-dev", status: "running", backend: "claude-code", model: "opus" }, { name: "planner", status: "running", backend: "claude-code" }];
let chat: any;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  // @ts-expect-error — a JS module of the app, with no types
  chat = await import("../src/ui/panel-chat.js");
  chat.boot({ stream: { on() {} }, boot: null, deps: { fetch: () => new Promise(() => {}) } });
  base.restore();
});
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  const { appStore } = await import("/assets/app-store.js");
  appStore.set({ needs: [], proposals: [], needsLoaded: false });
  auth = { state: "verified", until: Date.now() + 3_600_000 };
});
const PANELS = () => new Map<string, any>([
  ["chat", { load: async () => chat.ChatPanel }],
  ...["view", "fleet", "settings", "needs", "details", "log"].map((k) => [k, { Component: () => h("div", { class: `stub-${k}` }, k) }] as [string, any]),
]);
async function app(path: string, { narrow = true } = {}) {
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1" }, matchNarrow: narrow });
  mounted.push(pg);
  (globalThis as any).fetch = fakeFetch;
  const { resetWebAuthorization } = await import("/assets/web-authorize.js");
  resetWebAuthorization();
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus, appStore } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances: INSTANCES });
  appStore.set({ needs: [{ instance: "planner", nonce: "n1", type: "permission" }], proposals: [{ id: "p1" }], needsLoaded: true });
  await pg.mount(h(Shell, { panels: PANELS(), onNewInstance() {} }));
  await settle(8);
  return { pg, appStore };
}
const shell = (pg: AppPage) => pg.root.querySelector(".shell") as any;
async function openSheet(pg: AppPage) {
  const btn = pg.root.querySelector(".p-chat .panel-actions .chat-sheet-more") as any;
  expect(btn, "the chat's ⋯ (a phone's sheet)").toBeTruthy();
  fire(btn, "click"); await settle(6);
  const sheet = pg.root.querySelector(".chat-sheet") as any;
  expect(sheet, "the sheet").toBeTruthy();
  return sheet;
}
async function moreMenu(pg: AppPage) {
  const btn = [...pg.root.querySelectorAll(".p-chat .panel-actions .menu > button")].find((b: any) => b.getAttribute("aria-label") === "More actions") as any;
  expect(btn, "the chat's ⋯").toBeTruthy();
  fire(btn, "pointerdown"); fire(btn, "click"); await settle(4);
  const list = pg.root.querySelector('.p-chat [role="menu"]') as any;
  return [...list.children].map((n: any) => (n.classList.contains("menu-heading") ? `# ${n.textContent}` : n.textContent.trim()));
}

describe("M-3115 PR 1: inside an agent's pages a phone has no bottom tabs", () => {
  it("a chat: in-agent on the shell; ‹ with no count (M-3166: no counts on the Fleet side), named for where it goes; the list pages keep ☰ and the tabs", async () => {
    const { pg } = await app("/ui/chat/web-dev");
    expect(shell(pg).classList.contains("in-agent")).toBe(true);
    const back = pg.root.querySelector(".p-chat #sbOpen") as any;
    expect([back.classList.contains("sb-back"), !!back.querySelector(".ic-back"), !!back.querySelector(".ic-menu"), back.querySelector(".sb-badge")?.textContent, back.getAttribute("aria-label")])
      .toEqual([true, true, true, undefined, "Back to your agents"]);
    fire(back, "click"); await settle(4);
    expect(shell(pg).classList.contains("sb-open"), "‹ opens the agents (the drawer)").toBe(true);
    for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
    const fleet = await app("/ui/fleet");
    expect([shell(fleet.pg).classList.contains("in-agent"), fleet.pg.root.querySelector(".sb-back")]).toEqual([false, null]);
  });

  it("nothing waiting: ‹ has no badge and says only where it goes", async () => {
    const { pg, appStore } = await app("/ui/chat/web-dev");
    appStore.set({ needs: [], proposals: [] }); await settle(4);
    const back = pg.root.querySelector(".p-chat #sbOpen") as any;
    expect([back.querySelector(".sb-badge"), back.getAttribute("aria-label")]).toEqual([null, "Back to your agents"]);
  });

  // M-3166 (Argon 3, the user's OK of round 2): a phone's ⋯ is a sheet — tiles, rows, This agent's controls, ✓ Verified.
  it("⋯ on a phone: a sheet — View, Log, Search tiles; Text size, Appearance, Agent details; This agent: …, Delete; ✓ Verified; View goes to View", async () => {
    const { pg } = await app("/ui/chat/web-dev");
    const sheet = await openSheet(pg);
    const tiles = [...sheet.querySelectorAll(".chat-sheet-tile")].map((b: any) => b.textContent.trim());
    const rows = [...sheet.querySelectorAll(".chat-sheet-row, .menu-heading, .chat-sheet-foot")].map((n: any) => n.classList.contains("menu-heading") ? `# ${n.textContent.trim()}` : n.textContent.trim());
    expect(tiles.slice(0, 3)).toEqual(["View", "Log", "Search"]);
    expect(rows.filter((r) => /^(Text size|Appearance|Agent details|# This agent)/.test(r)).map((r) => r.replace(/(Medium|⌄)$/, ""))).toEqual(["Text size", "Appearance", "Agent details", "# This agent"]);
    expect(rows.some((r) => /^Delete /.test(r)) && /^✓ Verified/.test(rows.at(-1)!)).toBe(true);
    expect(rows.some((r) => r === "# Go to" || /^Needs you/.test(r))).toBe(false);   // Go to is the drawer's now
    fire([...sheet.querySelectorAll(".chat-sheet-tile")].find((b: any) => b.textContent.trim() === "View"), "click"); await settle(6);
    expect(pg.window.location.pathname).toMatch(/^\/view\/web-dev/);
  });

  it("not verified: no ✓ Verified in the sheet (the line under the composer still says Not verified · Authorize)", async () => {
    auth = { state: "none", reason: "not_authorized" };
    const { pg } = await app("/ui/chat/web-dev");
    expect((await openSheet(pg)).querySelector(".chat-sheet-foot")).toBeNull();
    expect(pg.root.querySelector(".composer-row .webauth-row")?.getAttribute("data-state")).toBe("none");
  });

  it("a desk: ☰ and the ⋯ it always had (no 前往, no ✓)", async () => {
    const { pg } = await app("/ui/chat/web-dev", { narrow: false });
    const rows = await moreMenu(pg);
    expect(rows.some((r) => r === "# Go to" || r.includes("Verified"))).toBe(false);
    expect(pg.root.querySelector(".p-chat #sbOpen")?.getAttribute("aria-label")).not.toMatch(/Back to your agents/);
  });

  it("a new Needs-you item for another agent is a toast; for this agent, or the first load, it is not", async () => {
    const { pg, appStore } = await app("/ui/chat/web-dev");
    const toasts = () => [...pg.root.querySelectorAll(".toast")].map((n: any) => n.textContent);
    appStore.set({ needs: [...appStore.get().needs, { instance: "web-dev", nonce: "own", type: "permission" }] }); await settle(4);
    expect(toasts().some((x) => x.includes("needs you"))).toBe(false);
    appStore.set({ needs: [...appStore.get().needs, { instance: "planner", nonce: "n2", type: "permission" }] }); await settle(4);
    expect(toasts()).toContain("planner needs you");
  });

  it("the first load of Needs you (or a reconnect's) is not news: no toast for what was already waiting", async () => {
    const { pg, appStore } = await app("/ui/chat/web-dev");
    appStore.set({ needs: [], needsLoaded: false }); await settle(4);             // a reconnect: not loaded yet
    appStore.set({ needs: [{ instance: "reviewer", nonce: "old", type: "permission" }], needsLoaded: true }); await settle(4);
    expect([...pg.root.querySelectorAll(".toast")].some((n: any) => n.textContent.includes("reviewer"))).toBe(false);
    appStore.set({ needs: [...appStore.get().needs, { instance: "reviewer", nonce: "new", type: "permission" }] }); await settle(4);
    expect([...pg.root.querySelectorAll(".toast")].map((n: any) => n.textContent)).toContain("reviewer needs you");   // after it: news again
  });

  it("the CSS: inside an agent's pages the phone's tabs and their padding go; ‹ only there; the verified-only line goes", () => {
    const css = readFileSync(join(process.cwd(), "src/ui/shared/app.css"), "utf8");
    for (const rule of [".in-agent .tabs { display: none; }", ".in-agent .main { padding-bottom: 0; }", ".sb-back .ic-menu { display: none; }",
      '.composer-row:has(.webauth-row[data-state="verified"]):not(:has(.webauth-notice, .guest-note)) { display: none; }']) expect(css).toContain(rule);
    expect(css).toContain(".sb-open .ic-back, .sb-open .sb-badge { display: none; }");
  });
});
