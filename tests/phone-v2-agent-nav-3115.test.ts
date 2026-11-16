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
// The chat store's own fetch (boot's deps): a test may answer it; otherwise it never settles, as before.
let chatFetch: null | ((url: string, init: any) => Promise<any>) = null;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  // @ts-expect-error — a JS module of the app, with no types
  chat = await import("../src/ui/panel-chat.js");
  chat.boot({ stream: { on() {} }, boot: null, deps: { fetch: (url: string, init: any) => (chatFetch ? chatFetch(url, init) : new Promise(() => {})) } });
  base.restore();
});
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  if (typeof document !== "undefined" && document.body) { delete document.body.dataset.tier; delete document.body.dataset.guestLevel; }
  chatFetch = null;
  const { appStore } = await import("/assets/app-store.js");
  appStore.set({ needs: [], proposals: [], needsLoaded: false });
  auth = { state: "verified", until: Date.now() + 3_600_000 };
});
const PANELS = () => new Map<string, any>([
  ["chat", { load: async () => chat.ChatPanel }],
  ...["view", "fleet", "settings", "needs", "details", "log"].map((k) => [k, { Component: () => h("div", { class: `stub-${k}` }, k) }] as [string, any]),
]);
async function app(path: string, { narrow = true, guest = null as null | "trusted" | "chat" } = {}) {
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1" }, matchNarrow: narrow });
  mounted.push(pg);
  // A guest's page: the server marks <body> (data-tier="guest", and data-guest-level="trusted" for a Trusted guest, #2855).
  if (guest) { document.body.dataset.tier = "guest"; if (guest === "trusted") document.body.dataset.guestLevel = "trusted"; }
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
    // M-3245: the drawer is closed by ✕ (it was ←, read as "back"); ← only goes back a level.
    const close = pg.root.querySelector("#sidebar .side-collapse") as any;
    expect([!!close.querySelector(".ic-close"), !!close.querySelector(".ic-back"), close.getAttribute("aria-label")]).toEqual([true, false, "Close the sidebar"]);
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

  // #4002 review (P3a, P3b): the header's backend and model chips are hidden on a phone, so the sheet has both; like the
  // chips, each runs bound to this page — a reply that comes after you left this chat is dropped, never shown on return.
  it("the sheet's Model & effort and CLI backend rows run /model and /backend, bound to the page: a reply after leaving is dropped", async () => {
    const posted: any[] = [];
    const replies: Array<(v: any) => void> = [];
    const { pg } = await app("/ui/chat/web-dev");
    chatFetch = async (url: string, init: { method?: string; body?: string } = {}) => {
      if (url !== "/ui/command" || init.method !== "POST") return new Promise(() => {});
      posted.push(JSON.parse(init.body || "{}"));
      const v = await new Promise<any>((r) => replies.push(r));
      return { ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) };
    };
    const rowsOf = (sheet: any) => [...sheet.querySelectorAll(".chat-sheet-row")] as any[];
    let sheet = await openSheet(pg);
    const backend = rowsOf(sheet).find((b) => /^CLI backend/.test(b.textContent.trim()));
    expect(backend, "a CLI backend row").toBeTruthy();
    fire(backend, "click"); await settle(4);
    replies.shift()!({ text: "Backend: claude-code" }); await settle(6);   // one command at a time per chat: answer it
    sheet = await openSheet(pg);
    fire(rowsOf(sheet).find((b) => /^Model & effort/.test(b.textContent.trim())), "click"); await settle(4);
    expect(posted.map((b) => [b.instance, b.command])).toEqual([["web-dev", "backend"], ["web-dev", "model"]]);
    // Leave this chat before the replies come; come back after.
    const { navigate } = await import("/assets/app-nav.js");
    navigate("/ui/chat/planner"); await settle(8);
    for (const r of replies) r({ choices: { current: "sonnet", options: [{ id: "late-pick", label: "Arrived after you left" }] } });
    await settle(8);
    navigate("/ui/chat/web-dev"); await settle(8);
    expect(pg.root.textContent).not.toContain("Arrived after you left");
  });

  // #4002 review (P2): a guest's header has no ⋯ sheet, so it keeps its own controls on a phone (the hide rules need the sheet).
  for (const level of ["trusted", "chat"] as const) {
    it(`a ${level} guest on a phone: no sheet, and its header keeps ${level === "trusted" ? "its tab row" : "its controls"}`, async () => {
      const { pg } = await app("/ui/chat/web-dev", { guest: level });
      const head = pg.root.querySelector(".p-chat > .panel-head") as any;
      expect(head, "the chat's header").toBeTruthy();
      expect(head.querySelector(".chat-sheet-more")).toBeNull();
      expect(!!head.querySelector(".inst-switch")).toBe(level === "trusted");
    });
  }
  it("the CSS: a phone's chat header gives its controls up only when it has the ⋯ sheet", () => {
    const css = readFileSync(join(process.cwd(), "src/ui/shared/chat-work-bar.css"), "utf8");
    const rule = css.slice(css.indexOf("@media (max-width: 899px)", css.indexOf("M-3166 (Argon 2–3")));
    const hides = rule.slice(0, rule.indexOf("{ display: none !important; }")).split("\n").filter((l) => /\.sb-search|\.inst-switch|\.panel-actions >/.test(l)).join(" ");
    const selectors = hides.split(",").map((x) => x.trim()).filter(Boolean);
    expect(selectors.length).toBe(3);
    for (const sel of selectors) expect(sel, sel).toMatch(/^\.p-chat > \.panel-head:has\(\.chat-sheet-more\) /);
    expect(rule).toContain(".p-chat > .panel-head:has(.chat-sheet-more) { flex-wrap: nowrap; }");
  });

  it("not verified: no ✓ Verified in the sheet (the meta line above the box says Not verified · Authorize — M-3166)", async () => {
    auth = { state: "none", reason: "not_authorized" };
    const { pg } = await app("/ui/chat/web-dev");
    expect((await openSheet(pg)).querySelector(".chat-sheet-foot")).toBeNull();
    expect(pg.root.querySelector(".chat-meta-right .webauth-row")?.getAttribute("data-state")).toBe("none");
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
    // M-3245: the full-width drawer's ✕ (the sidebar icon elsewhere)
    expect(css).toContain(".side-collapse .ic-close { display: none; }");
    expect(css).toMatch(/\.sidebar\.fleet-side:not\(\.drawer-narrow\) \.side-collapse \.ic-close \{ display: inline-block; \}/);
  });
});
