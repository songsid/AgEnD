/**
 * #1700 (design: the comment on #1700): the sidebar filter's Status and CLI groups each fold behind their header — a
 * real button (aria-expanded, en/zh-TW label) that toggles the group's checkboxes; folded with chips on, the header
 * says what is on (up to two names, else "N selected"); open or folded is this device's (localStorage, never synced),
 * kept across a page load, and a storage that refuses is only this page. Real Shell, store and router in a mini DOM.
 */
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
const realFetch = (globalThis as { fetch?: unknown }).fetch;
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  (globalThis as { fetch?: unknown }).fetch = realFetch;
  const nav = await import("/assets/instance-nav.js");
  nav.navStore.set({ order: { groups: new Map(), insts: new Map() }, collapsed: new Set(), filter: { q: "", status: [], cli: [] } });
  (await import("/assets/app-i18n.js")).setLang("en");
});

const live = (name: string, o: Record<string, unknown> = {}) => ({ name, status: "running", backend: "claude-code", model: "opus", context_pct: 10, tags: [], execution_state: "idle", ...o });
const INSTANCES = [
  live("web-dev", { execution_state: "working" }),
  live("api-server", { backend: "codex", state: "awaiting_input" }),
  live("docs-writer", { backend: "kiro-cli" }),
  live("qa-bot", { status: "stopped", backend: "grok" }),
];
const Stub = (name: string) => ({ Component: () => h("div", { class: `stub-${name}` }, name) });
const PANELS = new Map([["chat", Stub("chat")], ["view", Stub("view")], ["fleet", Stub("fleet")], ["settings", Stub("settings")], ["needs", Stub("needs")]]);

async function app(storage: Record<string, string> = {}, before?: (pg: AppPage) => void) {
  const pg = page({ url: "http://127.0.0.1:19280/ui/chat/web-dev", storage: { agend_tour_done: "1", ...storage } });
  mounted.push(pg);
  before?.(pg);
  (globalThis as { fetch?: unknown }).fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances: INSTANCES });
  (await import("/assets/instance-nav.js")).loadNavPrefs();
  await pg.mount(h(Shell, { panels: PANELS, onNewInstance() {} }));
  await settle(3);
  return pg;
}
/** A page load: the page before it is gone, its storage carried over. */
async function reload(prev: AppPage) {
  const storage = Object.fromEntries(prev.storage);
  await prev.unmount(); prev.restore(); mounted.splice(mounted.indexOf(prev), 1);
  return app(storage);
}

const facets = (pg: AppPage) => pg.root.querySelectorAll(".nav-facet") as any[];
const facet = (pg: AppPage, i: number) => facets(pg)[i];
const head = (pg: AppPage, i: number) => facet(pg, i).querySelector("button.nav-facet-head") as any;
/** One group as the page shows it: header label, aria-expanded, the folded summary, the checkbox labels. */
const shown = (pg: AppPage, i: number) => {
  const f = facet(pg, i);
  return { label: f.querySelector(".nav-facet-label").textContent, expanded: head(pg, i).getAttribute("aria-expanded"),
    sum: f.querySelector(".nav-facet-sum")?.textContent ?? null, chips: f.querySelectorAll(".nav-chip").map((c: any) => c.textContent) };
};
const toggle = async (pg: AppPage, i: number) => { head(pg, i).click(); await settle(); };
const chip = (pg: AppPage, i: number, label: string) => facet(pg, i).querySelectorAll(".nav-chip").find((c: any) => c.textContent === label).querySelector("input");
const STATUS = ["working", "needs you", "idle", "stopped", "crashed"];
const CLIS = ["Claude Code", "Codex", "Grok Build", "Kiro CLI"];

describe("a filter group folds and opens behind its header", () => {
  it("folded on a first visit; the header button opens and folds its own group only; aria-expanded follows", async () => {
    const pg = await app();
    expect([shown(pg, 0), shown(pg, 1)]).toEqual([
      { label: "Status", expanded: "false", sum: null, chips: [] }, { label: "CLI", expanded: "false", sum: null, chips: [] }]);
    await toggle(pg, 0);
    expect([shown(pg, 0), shown(pg, 1)]).toEqual([
      { label: "Status", expanded: "true", sum: null, chips: STATUS }, { label: "CLI", expanded: "false", sum: null, chips: [] }]);
    await toggle(pg, 1);
    expect([shown(pg, 0).expanded, shown(pg, 1)]).toEqual(["true", { label: "CLI", expanded: "true", sum: null, chips: CLIS }]);
    await toggle(pg, 0);
    expect([shown(pg, 0), shown(pg, 1).expanded]).toEqual([{ label: "Status", expanded: "false", sum: null, chips: [] }, "true"]);
  });

  it("the header is a real button: type=button, aria-controls the list it opens, a label naming the action", async () => {
    const pg = await app();
    const b = head(pg, 0);
    expect([b.tagName, b.getAttribute("type"), b.getAttribute("title")]).toEqual(["BUTTON", "button", "Show Status filters"]);
    await toggle(pg, 0);
    const list = facet(pg, 0).querySelector(".nav-facet-list");
    expect([head(pg, 0).getAttribute("aria-controls"), list.getAttribute("id"), list.getAttribute("role"), head(pg, 0).getAttribute("title")])
      .toEqual(["nav-facet-status", "nav-facet-status", "group", "Hide Status filters"]);
  });

  it("two clicks before the page renders again: both count (back where it was)", async () => {
    const pg = await app();
    head(pg, 1).click(); head(pg, 1).click(); await settle();
    expect([shown(pg, 1).expanded, pg.storage.get("agend_nav_facets")]).toEqual(["false", '{"status":false,"cli":false}']);
  });
});

describe("folded with chips on, the header says what is on", () => {
  it("one or two: their names; three or more: how many; open: the count badge, no summary; none on: nothing", async () => {
    const pg = await app();
    await toggle(pg, 0); await toggle(pg, 1);
    fire(chip(pg, 0, "idle"), "change"); fire(chip(pg, 1, "Codex"), "change"); fire(chip(pg, 1, "Kiro CLI"), "change"); await settle();
    const badges = () => pg.root.querySelectorAll(".nav-facet-n").map((n: any) => n.textContent);
    expect([shown(pg, 0).sum, shown(pg, 1).sum, badges()]).toEqual([null, null, ["1", "2"]]);
    await toggle(pg, 0); await toggle(pg, 1);
    expect([shown(pg, 0).sum, shown(pg, 1).sum, badges()]).toEqual(["· idle", "· Codex, Kiro CLI", []]);
    expect(head(pg, 1).getAttribute("title")).toBe("Show CLI filters (CLI · Codex, Kiro CLI)");
    await toggle(pg, 1); fire(chip(pg, 1, "Grok Build"), "change"); await settle(); await toggle(pg, 1);
    expect(shown(pg, 1).sum).toBe("· 3 selected");
    (pg.root.querySelector(".nav-facet-reset") as any).click(); await settle();
    expect([shown(pg, 0).sum, shown(pg, 1).sum, badges()]).toEqual([null, null, []]);
  });

  it("zh-TW: the summary and the header's label", async () => {
    const pg = await app({ agend_instance_filter: JSON.stringify({ q: "", status: ["idle", "working", "stopped"], cli: ["codex"] }) });
    (await import("/assets/app-i18n.js")).setLang("zh-TW"); await settle();
    expect([shown(pg, 0).sum, head(pg, 0).getAttribute("title"), shown(pg, 1).label, head(pg, 1).getAttribute("title")])
      .toEqual(["· 已選 3 個", "顯示狀態篩選 (狀態 · 已選 3 個)", "CLI", "顯示CLI篩選 (CLI · Codex)"]);
    expect(shown(pg, 0).label).toBe("狀態");
  });
});

describe("open or folded is this device's", () => {
  it("kept across a page load (each group its own); a corrupt or foreign value is folded", async () => {
    const pg = await app();
    await toggle(pg, 1);
    expect(pg.storage.get("agend_nav_facets")).toBe('{"status":false,"cli":true}');
    const again = await reload(pg);
    expect([shown(again, 0).expanded, shown(again, 1)]).toEqual(["false", { label: "CLI", expanded: "true", sum: null, chips: CLIS }]);
    await toggle(again, 0); await toggle(again, 1);
    const third = await reload(again);
    expect([shown(third, 0).expanded, shown(third, 1).expanded]).toEqual(["true", "false"]);
    const outcomes = [];
    for (const v of ["{not json", "null", '"status"', '{"status":"yes","cli":1}', "[true,true]"]) {
      const bad = await app({ agend_nav_facets: v });
      outcomes.push([v, shown(bad, 0).expanded, shown(bad, 1).expanded]);
      await bad.unmount(); bad.restore(); mounted.splice(mounted.indexOf(bad), 1);
    }
    expect(outcomes).toEqual(["{not json", "null", '"status"', '{"status":"yes","cli":1}', "[true,true]"].map((v) => [v, "false", "false"]));
  });

  it("never sent to the host: a toggle writes no /ui/prefs", async () => {
    const pg = await app();
    const calls: string[] = [];
    (globalThis as { fetch?: unknown }).fetch = async (url: string) => { calls.push(String(url)); return { ok: false, status: 404, json: async () => ({}) }; };
    await toggle(pg, 0); await toggle(pg, 1); await settle(3);
    expect(calls.filter((u) => u.includes("prefs"))).toEqual([]);
  });

  it("a storage that refuses (blocked, full): the groups still fold and open — this page only", async () => {
    const pg = await app({}, () => {
      const ls = (globalThis as any).localStorage;
      ls.getItem = () => { throw new Error("SecurityError"); };
      ls.setItem = () => { throw new Error("QuotaExceededError"); };
    });
    expect(shown(pg, 0).expanded).toBe("false");
    await toggle(pg, 0);
    expect([shown(pg, 0).expanded, shown(pg, 0).chips]).toEqual(["true", STATUS]);
    await toggle(pg, 0);
    expect(shown(pg, 0).expanded).toBe("false");
  });
});
