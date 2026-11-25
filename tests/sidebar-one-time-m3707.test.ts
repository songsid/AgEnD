/**
 * M-3707 (the user, 11-25, after M-3674): the sidebar shows one time again — the most recent response, to a person or to
 * another agent, unlabelled. Only a reply to a person highlights the row (.replied, --reply-a, the time's .fresh) or
 * moves it in "Recent replies"; a turn another agent started updates the time silently. The tooltip says which kind.
 * Real store, prefs, router and Shell in a mini DOM (sidebar-reply-time-2179's harness).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60000).toISOString();

describe("the sidebar: one time; the highlight and the sort follow a person (M-3707)", () => {
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
  const I = (name: string, mins: number | null, agent: number | null = null, o: Record<string, unknown> = {}) => ({ name, status: "running", backend: "claude-code", context_pct: 40, tags: ["ops"],
    ...(mins == null ? {} : { last_reply: ago(mins) }), ...(agent == null ? {} : { last_agent_turn: ago(agent) }), ...o });
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
    nav.sidebarDensityStore.set({ value: "detailed", layout: "desk" });   // M-3252: these rows are the detailed ones (a desktop now defaults to compact)
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

  const state = (pg: AppPage, n: string) => { const a = rowOf(pg, n); return { text: a.querySelector(".inst-when")?.textContent ?? null, replied: a.classList.contains("replied"),
    glow: a.style["--reply-a"] ?? "", fresh: a.querySelector(".inst-when")?.classList.contains("fresh") ?? null }; };

  it("one time, unlabelled: the newer response; an agent turn never highlights; the tooltip says which kind, newer first", async () => {
    const { pg } = await sidebar([I("busy", 33 * 1440, 2), I("chat", 5, 300), I("relay", null, 180), I("both-fresh", 4, 1), I("never", null)]);
    expect(state(pg, "busy")).toEqual({ text: "2 min ago", replied: false, glow: "", fresh: false });          // the agent's turn: silent
    expect(state(pg, "chat")).toEqual({ text: "5 min ago", replied: true, glow: "0.500", fresh: true });       // a person's reply: highlighted
    expect(state(pg, "relay")).toEqual({ text: "3 h ago", replied: false, glow: "", fresh: false });
    // A reply 4 min ago glows the row; the time shown is the agent's newer one, so that time is not marked fresh.
    expect(state(pg, "both-fresh")).toEqual({ text: "1 min ago", replied: true, glow: "0.600", fresh: false });
    expect(rowOf(pg, "never").querySelector(".inst-when")).toBeNull();
    const title = (n: string) => rowOf(pg, n).querySelector(".inst-when").getAttribute("title").split("\n").map((l: string) => l.split(":")[0]);
    expect(title("busy")).toEqual(["Last turn another agent started (send_to_instance, a task, a report, a broadcast)", "Last reply to a person"]);
    expect(title("chat")).toEqual(["Last reply to a person", "Last turn another agent started (send_to_instance, a task, a report, a broadcast)"]);
    expect([...pg.root.querySelectorAll("#instanceList .inst-when")].map((e: any) => e.textContent).join(" ")).not.toMatch(/Person|Agent/);
  });
  it("zh-TW: 「2 分鐘前」, no 人/Agent label", async () => {
    const { pg } = await sidebar([I("busy", 33 * 1440, 2), I("chat", 7, 300)], { lang: "zh-TW" });
    expect([state(pg, "busy").text, state(pg, "chat").text]).toEqual(["2 分鐘前", "7 分鐘前"]);
  });
  it("Recent replies: an agent's newer turn never moves a row up; a reply to a person does", async () => {
    const { pg, applyStatus } = await sidebar([I("a", 30, 0.5), I("b", 20), I("c", 60)], { sort: { mode: "recent", favs: "fixed" } });
    expect(groups(pg)).toEqual([["Recent replies first", ["b", "a", "c"]]]);
    applyStatus({ instances: [I("a", 30, 0.2), I("b", 20), I("c", 60, 0.1)] }); await settle(3);
    expect(groups(pg), "agent turns: the same order").toEqual([["Recent replies first", ["b", "a", "c"]]]);
    applyStatus({ instances: [I("a", 30), I("b", 20), I("c", 1)] }); await settle(3);
    expect(groups(pg), "a reply to a person: first").toEqual([["Recent replies first", ["c", "b", "a"]]]);
  });
});
