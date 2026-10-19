/**
 * #2179 (the user's pick from the mockups: B5 + A2, A3 as an option): the sidebar says who has replied — no unread
 * markers to clear.
 * - The host: an instance's last reply to a person is its newest kept `agent` message (WebChatHistory.lastAgentReply);
 *   a person's message, a status line (a cross-instance line) never counts. The status frame carries it as last_reply;
 *   a guest's frame never does.
 * - The row (B5): the name and its % on the first line; the other name and the time at the end of the second — "just
 *   now", "2 min ago", "3 h ago", "yesterday", "4 d ago" (zh-TW too). A reply under 10 minutes old is highlighted, fading
 *   by itself (--reply-a); one under a minute pulses once (.just).
 * - Sort (nav.sort, a synced pref): "Custom" (the default) never moves a row when a reply comes; "Recent replies" keeps the
 *   favorites in their order (or sorts them too) and lists every other row by its last reply, without groups. The button
 *   says which, and the choice is kept (written as nav.sort, read back on a page load).
 * - A guest: no times, no sort, the list as it is.
 * Real store, prefs, router and Shell in a mini DOM.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebChatHistory } from "../src/web-chat-history.js";
import { guestStatus } from "../src/web-guest-access.js";
import { handleViewRequest } from "../src/view-api.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fire } from "./helpers/mini-dom.js";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60000).toISOString();

describe("the host: when an instance last replied to a person", () => {
  it("its newest agent message; a person's message or a status line never counts; none kept → null", () => {
    const h = new WebChatHistory();
    h.record({ instance: "a", sender: "a", role: "agent", text: "first", ts: ago(30) });
    h.record({ instance: "a", sender: "a", role: "agent", text: "second", ts: ago(5) });
    h.record({ instance: "a", sender: "person", text: "a person's", ts: ago(1) });
    h.record({ instance: "a", sender: "agend", role: "status", text: "b → a: a cross-instance line", ts: ago(0) });
    h.record({ instance: "b", sender: "person", text: "only a person's", ts: ago(2) });
    expect([h.lastAgentReply("a"), h.lastAgentReply("b"), h.lastAgentReply("nobody")]).toEqual([ago(5), null, null]);
  });
  it("the status frame carries it; a guest's frame keeps none of it", async () => {
    const src = (await import("node:fs")).readFileSync("src/fleet-manager.ts", "utf8");
    expect(src).toMatch(/last_reply: this\.webChatHistory\.lastAgentReply\(name\) \?\? undefined/);
    expect(guestStatus({ instances: [{ name: "a", status: "running", last_reply: ago(1) }] }, new Set(["a"])).instances).toEqual([{ name: "a", status: "running" }]);
  });
});

describe("the sidebar", () => {
  const mounted: AppPage[] = [];
  const realFetch = (globalThis as { fetch?: unknown }).fetch;
  let posts: any[] = [];
  let host: Record<string, unknown> = {}, rev = 1, era = 0;
  afterEach(async () => {
    for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
    (globalThis as { fetch?: unknown }).fetch = realFetch;
    vi.useRealTimers();
    (await import("/assets/app-i18n.js")).setLang("en");
  });
  const I = (name: string, mins: number | null, o: Record<string, unknown> = {}) => ({ name, status: "running", backend: "claude-code", context_pct: 40, tags: ["ops"],
    ...(mins == null ? {} : { last_reply: ago(mins) }), ...o });
  async function sidebar(instances: Array<Record<string, unknown>>, opts: { favorites?: string[]; sort?: { mode: string; favs: string }; guest?: boolean; lang?: string } = {}) {
    posts = []; rev = ++era * 1000;
    host = { ...(opts.favorites ? { "nav.favorites": opts.favorites } : {}), ...(opts.sort ? { "nav.sort": opts.sort } : {}) };
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: NOW });
    const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1",
      ...(opts.favorites ? { agend_favorites: JSON.stringify(opts.favorites) } : {}), ...(opts.sort ? { agend_nav_sort: JSON.stringify(opts.sort) } : {}) } });
    mounted.push(pg);
    pg.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: {} }));
    if (opts.guest) pg.document.body.dataset.tier = "guest";
    (globalThis as { fetch?: unknown }).fetch = async (_url: string, init: any = {}) => {
      if (init.method === "POST") { const b = JSON.parse(init.body); posts.push(b); Object.assign(host, b.set); rev++; }
      return { ok: true, status: 200, json: async () => ({ values: { ...host }, rev }) };
    };
    const { startRouter } = await import("/assets/app-nav.js");
    const { applyStatus } = await import("/assets/app-store.js");
    const { Shell } = await import("/assets/app-shell.js");
    const nav = await import("/assets/instance-nav.js");
    const prefs = await import("/assets/app-prefs.js");
    await prefs.refresh();
    (await import("/assets/app-i18n.js")).setLang(opts.lang ?? "en");
    nav.loadNavPrefs();
    startRouter(pg.window);
    applyStatus({ instances });
    await pg.mount(h(Shell, { panels: new Map(), onNewInstance() {} }));
    await settle(3);
    return { pg, applyStatus, nav };
  }
  const rowOf = (pg: AppPage, name: string) => ([...pg.root.querySelectorAll("#instanceList a.inst")] as any[]).find((a) => a.querySelector(".inst-name").textContent === name);
  const groups = (pg: AppPage) => [...pg.root.querySelectorAll("#instanceList .v-group")].map((g: any) =>
    [g.querySelector(".v-group-head .grow").textContent, [...g.querySelectorAll(".inst-name")].map((n: any) => n.textContent)]);
  const sortBtn = (pg: AppPage) => pg.root.querySelector("#instanceList .nav-sort-btn") as any;

  it("B5: the name and its % on the first line; the time at the end of the second; fresh ones highlighted and fading", async () => {
    const { pg } = await sidebar([I("fresh", 0.4), I("two", 2), I("old", 25), I("hours", 180), I("days", 4 * 1440), I("never", null)]);
    const line = (name: string, sel: string) => [...rowOf(pg, name).querySelector(sel).children].map((c: any) => [c.className.split(" ")[0], c.textContent]);
    expect(line("two", ".inst-line")).toEqual([["inst-name", "two"], ["v-meta", "40%"]]);
    expect(line("two", ".inst-line2")).toEqual([["inst-alt", ""], ["inst-when", "2 min ago"]]);
    expect(["fresh", "old", "hours", "days"].map((n) => rowOf(pg, n).querySelector(".inst-when").textContent)).toEqual(["just now", "25 min ago", "3 h ago", "4 d ago"]);
    expect(rowOf(pg, "never").querySelector(".inst-line2"), "no reply kept: one line").toBeNull();
    // The highlight: under 10 minutes, its strength falling with age; a reply under a minute pulses once.
    const state = (n: string) => { const a = rowOf(pg, n); return [a.classList.contains("replied"), a.classList.contains("just"), (a.style["--reply-a"] ?? ""), a.querySelector(".inst-when")?.classList.contains("fresh") ?? null]; };
    expect([state("fresh"), state("two"), state("old")]).toEqual([[true, true, "0.960", true], [true, false, "0.800", true], [false, false, "", false]]);
    expect(rowOf(pg, "two").parentNode.className).toContain("two-line");
  });
  it("the times and the highlight move on by themselves (a tick every 30 s): two minutes later, 4 min ago and fainter", async () => {
    const { pg } = await sidebar([I("two", 2)]);
    vi.advanceTimersByTime(120_000); await settle(3);
    expect([rowOf(pg, "two").querySelector(".inst-when").textContent, rowOf(pg, "two").style["--reply-a"]]).toEqual(["4 min ago", "0.600"]);
  });
  it("zh-TW", async () => {
    const { pg } = await sidebar([I("a", 0.2), I("b", 7), I("c", 120), I("d", 1500), I("e", 3000)], { lang: "zh-TW" });
    expect(["a", "b", "c", "d", "e"].map((n) => rowOf(pg, n).querySelector(".inst-when").textContent)).toEqual(["剛剛", "7 分鐘前", "2 小時前", "昨天", "2 天前"]);
    expect(sortBtn(pg).textContent).toBe("自訂");
  });
  it("Custom (the default): a new reply never moves a row", async () => {
    const list = [I("alpha", 50), I("beta", 40), I("gamma", 30)];
    const { pg, applyStatus } = await sidebar(list, { favorites: ["gamma", "alpha"] });
    const before = groups(pg);
    expect(before).toEqual([["Favorites", ["gamma", "alpha"]], ["ops", ["beta"]]]);
    applyStatus({ instances: [I("alpha", 0), I("beta", 0.5), I("gamma", 30)] }); await settle(3);
    expect(groups(pg), "the same order").toEqual(before);
    expect(sortBtn(pg).textContent).toBe("Custom");
  });
  it("Recent replies: favorites keep their order; the rest is one list, the last reply first (none last, in their order)", async () => {
    const { pg } = await sidebar([I("fav-old", 300), I("fav-new", 1), I("x", 20), I("y", 3), I("z", null), I("w", 600, { tags: ["other"] })],
      { favorites: ["fav-old", "fav-new"], sort: { mode: "recent", favs: "fixed" } });
    expect(groups(pg)).toEqual([["Favorites", ["fav-old", "fav-new"]], ["Recent replies first", ["y", "x", "w", "z"]]]);
    expect([sortBtn(pg).textContent, sortBtn(pg).classList.contains("on")]).toEqual(["Recent replies", true]);
    expect(pg.root.querySelector("#instanceList .v-recent [draggable]"), "nothing is dragged while sorted by reply").toBeNull();
  });
  it("…and with 'sorted by last reply too', the favorites as well", async () => {
    const { pg } = await sidebar([I("fav-old", 300), I("fav-new", 1), I("x", 20)], { favorites: ["fav-old", "fav-new"], sort: { mode: "recent", favs: "recent" } });
    expect(groups(pg)).toEqual([["Favorites", ["fav-new", "fav-old"]], ["Recent replies first", ["x"]]]);
  });
  it("the menu: choosing changes the list at once, and is written as nav.sort (kept: read back on the next page load)", async () => {
    const { pg, nav } = await sidebar([I("fav", 300), I("x", 20), I("y", 3)], { favorites: ["fav"] });
    fire(sortBtn(pg), "click"); await settle();
    expect(sortBtn(pg).getAttribute("aria-expanded")).toBe("true");
    const radio = (group: string, value: string) => ([...pg.root.querySelectorAll(`.nav-sort-menu input`)] as any[]).find((i) => i.getAttribute("name") === `nav-sort-${group}` && i.value === value);
    expect([radio("mode", "custom").checked, radio("favs", "fixed").checked]).toEqual([true, true]);
    fire(radio("mode", "recent"), "change"); await settle();
    expect(groups(pg)).toEqual([["Favorites", ["fav"]], ["Recent replies first", ["y", "x"]]]);
    await new Promise((r) => setTimeout(r, 450));
    expect(posts.at(-1)).toEqual({ set: { "nav.sort": { mode: "recent", favs: "fixed" } } });
    expect(pg.storage.get("agend_nav_sort")).toBe(JSON.stringify({ mode: "recent", favs: "fixed" }));
    nav.loadNavPrefs();
    expect(nav.navStore.get().sort).toEqual({ mode: "recent", favs: "fixed" });
  });
  it("another device switches the sort: this page's list follows (the host's change, read)", async () => {
    const { pg } = await sidebar([I("fav", 300), I("x", 20), I("y", 3)], { favorites: ["fav"] });
    expect(groups(pg)).toEqual([["Favorites", ["fav"]], ["ops", ["x", "y"]]]);
    host["nav.sort"] = { mode: "recent", favs: "fixed" }; rev++;
    await (await import("/assets/app-prefs.js")).refresh(); await settle(3);
    expect([groups(pg), sortBtn(pg).textContent]).toEqual([[["Favorites", ["fav"]], ["Recent replies first", ["y", "x"]]], "Recent replies"]);
  });
  it("Escape or a click elsewhere closes the menu", async () => {
    const { pg } = await sidebar([I("x", 20)]);
    fire(sortBtn(pg), "click"); await settle();
    fire(pg.document, "keydown", { key: "Escape" }); await settle();
    expect(pg.root.querySelector(".nav-sort-menu")).toBeNull();
    fire(sortBtn(pg), "click"); await settle();
    fire(pg.document.body, "pointerdown"); await settle();
    expect(pg.root.querySelector(".nav-sort-menu")).toBeNull();
  });
  it("CSS: the pulse stops under reduced motion (the rule as specific as the one it stops); the menu spans the header, inside the sidebar", async () => {
    const css = (await import("node:fs")).readFileSync("src/ui/shared/app.css", "utf8");
    const pulse = /\n(\.inst\.just[^{]*)\{ animation: inst-just/.exec(css)![1]!.trim();
    expect(css).toContain(`@media (prefers-reduced-motion: reduce) { ${pulse} { animation: none; }`);
    expect(css).toMatch(/\.inst-head \{ position: relative; \}/);
    expect(css).toMatch(/\.nav-sort \{ position: static;/);
    expect(css).toMatch(/\.nav-sort-menu \{ position: absolute; left: 0; right: 0;/);
  });
  it("a guest: no times, no sort button, the list as it is — whatever the host's sort", async () => {
    const { pg } = await sidebar([I("a", 1), I("b", 20)], { sort: { mode: "recent", favs: "fixed" }, guest: true });
    expect([pg.root.querySelector(".inst-when"), pg.root.querySelector(".nav-sort-btn"), pg.root.querySelector(".inst.replied")]).toEqual([null, null, null]);
    expect(groups(pg)).toEqual([["ops", ["a", "b"]]]);
  });
});

describe("#2181 review: the anonymous View reader — no reply times there, so always Custom", () => {
  const mounted: AppPage[] = [];
  const dirs: string[] = [];
  afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  /** A real /api/profiles answer: the status frame has the reply times (beta replied last), the projection carries none. */
  function profiles(): Array<Record<string, unknown>> {
    const dir = mkdtempSync(join(tmpdir(), "rt-2179-")); dirs.push(dir);
    let body = "";
    const res = { writeHead() { return res; }, setHeader() {}, end(b?: string) { body = b ?? ""; } } as any;
    handleViewRequest({ method: "GET", headers: {} } as any, res, new URL("http://localhost/api/profiles"), {
      webToken: null, dataDir: dir, logger: { debug() {}, info() {}, warn() {}, error() {} },
      fleetConfig: { defaults: { backend: "claude-code" }, instances: { alpha: { working_directory: dir, tags: ["G"] }, beta: { working_directory: dir, tags: ["G"] } } },
      getInstanceStatus: () => "running", resolveInstanceModel: () => ({ model: "" }),
      getUiStatus: () => ({ instances: [{ name: "alpha", status: "running", last_reply: ago(50) }, { name: "beta", status: "running", last_reply: ago(1) }] }),
    } as never);
    return JSON.parse(body);
  }
  it("a Recent replies choice kept in this browser: the anonymous list stays in its own order, says no mode, shows no times", async () => {
    const roster = profiles();
    expect(roster.map((r) => [r.instance_name, "last_reply" in r]), "the projection carries no reply time").toEqual([["alpha", false], ["beta", false]]);
    const pg = page({ url: "http://127.0.0.1:19280/view", storage: { agend_tour_done: "1", agend_nav_sort: JSON.stringify({ mode: "recent", favs: "fixed" }) } });
    mounted.push(pg);
    const nav = await import("/assets/instance-nav.js");
    nav.loadNavPrefs();
    expect(nav.navStore.get().sort.mode, "the kept choice is read").toBe("recent");
    await pg.mount(h(nav.InstanceNav, { route: { panel: "view", instance: null }, items: roster, viewOnly: true }));
    await settle(3);
    const groups = [...pg.root.querySelectorAll(".v-group")].map((g: any) => [g.querySelector(".v-group-head .grow").textContent, [...g.querySelectorAll(".inst-name")].map((n: any) => n.textContent)]);
    expect(groups).toEqual([["G", ["alpha", "beta"]]]);
    expect([pg.root.querySelector(".nav-sort-btn"), pg.root.querySelector(".v-recent"), pg.root.querySelector(".inst-when")]).toEqual([null, null, null]);
  });
});
