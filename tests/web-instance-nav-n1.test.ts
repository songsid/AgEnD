/**
 * alpha.2, docs/design/web-unified-instance-nav.md N1: the sidebar's instance list is one component on every page —
 * Chat, View, Fleet — with View's tag groups and order, a filter (text + status and CLI chips) kept by this browser and
 * the same on every page, and rows that open the view the page is in. Mounted with the real Shell, store and router
 * (tests/helpers/app-harness.ts); the panels are stubs, so only the sidebar is under test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
const realFetch = (globalThis as { fetch?: unknown }).fetch;
let reads: string[] = [];
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  (globalThis as { fetch?: unknown }).fetch = realFetch;
  const nav = await import("/assets/instance-nav.js");
  nav.navStore.set({ order: { groups: new Map(), insts: new Map() }, collapsed: new Set(), filter: { q: "", status: [], cli: [] } });
  (await import("/assets/app-store.js")).appStore.set({ viewOnly: false });
  reads = [];
});

const live = (name: string, o: Record<string, unknown> = {}) => ({ name, status: "running", backend: "claude-code", model: "opus", context_pct: 10, tags: [], execution_state: "idle", ...o });
const INSTANCES = [
  live("web-dev", { tags: ["Platform"], execution_state: "working", context_pct: 82 }),
  live("api-server", { tags: ["Platform"], backend: "codex", state: "awaiting_input", interaction_summary: "Permission prompt" }),
  live("docs-writer", { tags: ["Docs"], backend: "kiro-cli" }),
  live("qa-bot", { status: "stopped", backend: "grok" }),
  live("room-1", { tags: ["classic"], status: "crashed" }),
];
const Stub = (name: string) => ({ Component: () => h("div", { class: `stub-${name}` }, name) });
const PANELS = new Map([["chat", Stub("chat")], ["view", Stub("view")], ["fleet", Stub("fleet")], ["settings", Stub("settings")], ["needs", Stub("needs")]]);

async function app(path: string, storage: Record<string, string> = {}, instances = INSTANCES) {
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1", ...storage } });
  mounted.push(pg);
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => { reads.push(url); return { ok: false, status: 404, json: async () => ({}) }; };
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances });
  (await import("/assets/instance-nav.js")).loadNavPrefs();   // a page load: this browser's order, folds and filter
  await pg.mount(h(Shell, { panels: PANELS, onNewInstance() {} }));
  await settle(3);
  return pg;
}
/** A page load of `path`: the page before it is gone (unmounted, its globals restored), the storage carried over. */
async function reload(prev: AppPage, path: string, storage: Record<string, string>) {
  await prev.unmount(); prev.restore(); mounted.splice(mounted.indexOf(prev), 1);
  return app(path, storage);
}
const go = async (path: string) => { const { navigate } = await import("/assets/app-nav.js"); navigate(path); await settle(3); };
const list = (pg: AppPage) => pg.root.querySelector("#instanceList") as any;
const rowNames = (pg: AppPage) => pg.root.querySelectorAll("#instanceList a.inst").map((a: any) => a.querySelector(".inst-name").textContent);
const hrefOf = (pg: AppPage, name: string) => pg.root.querySelectorAll("#instanceList a.inst").find((a: any) => a.querySelector(".inst-name").textContent === name)?.getAttribute("href");
const activeName = (pg: AppPage) => pg.root.querySelector('#instanceList a.inst[aria-current="page"] .inst-name')?.textContent ?? null;
const groups = (pg: AppPage) => pg.root.querySelectorAll("#instanceList .v-group-head .grow").map((g: any) => g.textContent);
const typeFilter = async (pg: AppPage, value: string) => { const i = pg.root.querySelector("#filterInput") as any; i.value = value; fire(i, "input"); await settle(); };
const chip = (pg: AppPage, facet: string, label: string) => pg.root.querySelectorAll(".nav-facet").find((d: any) => d.querySelector("summary").textContent.startsWith(facet))!
  .querySelectorAll(".nav-chip").find((c: any) => c.textContent === label).querySelector("input");

describe("one list on every page", () => {
  it("Chat, View and Fleet show the same list — the same element, never remounted by navigation — with tag groups", async () => {
    const pg = await app("/ui/chat/web-dev");
    const el = list(pg);
    expect(el, "the list on Chat").toBeTruthy();
    expect(groups(pg)).toEqual(["Classic", "Docs", "Platform", "Other"]);
    for (const path of ["/view/web-dev", "/ui/fleet", "/ui/chat/api-server", "/settings"]) {
      await go(path);
      expect(list(pg) === el, `the same list element on ${path}`).toBe(true);
      expect(rowNames(pg), path).toEqual(["room-1", "docs-writer", "web-dev", "api-server", "qa-bot"]);
    }
  });

  it("a row opens the view the page is in: View → View, everywhere else → Chat; the open instance is the active row", async () => {
    const pg = await app("/ui/chat/web-dev");
    expect([hrefOf(pg, "docs-writer"), activeName(pg)]).toEqual(["/ui/chat/docs-writer", "web-dev"]);
    await go("/view/api-server");
    expect([hrefOf(pg, "docs-writer"), activeName(pg)]).toEqual(["/view/docs-writer", "api-server"]);
    await go("/ui/fleet/tasks");
    expect([hrefOf(pg, "docs-writer"), activeName(pg)]).toEqual(["/ui/chat/docs-writer", null]);
  });

  it("live state on every page: working, needs you, stopped and crashed dots, and the needs-you badge", async () => {
    const pg = await app("/view/web-dev");
    const dot = (name: string) => pg.root.querySelectorAll("#instanceList a.inst").find((a: any) => a.querySelector(".inst-name").textContent === name)!.querySelector(".dot").getAttribute("class");
    expect(["web-dev", "api-server", "docs-writer", "qa-bot", "room-1"].map(dot)).toEqual(["dot busy", "dot warn", "dot ok", "dot off", "dot bad"]);
    expect(pg.root.querySelectorAll("#instanceList .badge-await").length).toBe(1);
  });

  it("adds no read of its own: the list rides the status frames (no /api/profiles outside View)", async () => {
    await app("/ui/chat/web-dev");
    await go("/ui/fleet");
    expect(reads.filter(u => u.startsWith("/api/profiles"))).toEqual([]);
  });
});

describe("the filter: text, status and CLI, the same on every page and kept by this browser", () => {
  it("typed on Chat, still applied on View and Fleet", async () => {
    const pg = await app("/ui/chat/web-dev");
    await typeFilter(pg, "ap");
    expect(rowNames(pg)).toEqual(["api-server"]);
    for (const path of ["/view/web-dev", "/ui/fleet/org"]) {
      await go(path);
      expect([rowNames(pg), (pg.root.querySelector("#filterInput") as any).value], path).toEqual([["api-server"], "ap"]);
    }
    expect(pg.root.querySelector(".v-filter .note")!.textContent).toBe("1 / 5 shown");
  });

  it("status chips: needs you, then working + idle; the count says it is filtered", async () => {
    const pg = await app("/ui/chat/web-dev");
    fire(chip(pg, "Status", "needs you"), "change"); await settle();
    expect(rowNames(pg)).toEqual(["api-server"]);
    // Three clicks before the list renders again: each one counts.
    fire(chip(pg, "Status", "needs you"), "change"); fire(chip(pg, "Status", "working"), "change"); fire(chip(pg, "Status", "idle"), "change"); await settle();
    expect(rowNames(pg)).toEqual(["docs-writer", "web-dev"]);
    fire(chip(pg, "Status", "working"), "change"); fire(chip(pg, "Status", "idle"), "change"); fire(chip(pg, "Status", "stopped"), "change"); fire(chip(pg, "Status", "crashed"), "change"); await settle();
    expect(rowNames(pg)).toEqual(["room-1", "qa-bot"]);
  });

  it("CLI chips list the backends present; text and chips combine", async () => {
    const pg = await app("/ui/chat/web-dev");
    const labels = pg.root.querySelectorAll(".nav-facet").find((d: any) => d.querySelector("summary").textContent.startsWith("CLI"))!
      .querySelectorAll(".nav-chip").map((c: any) => c.textContent);
    expect(labels).toEqual(["Claude Code", "Codex", "Grok Build", "Kiro CLI"]);
    fire(chip(pg, "CLI", "Claude Code"), "change"); await settle();
    expect(rowNames(pg)).toEqual(["room-1", "web-dev"]);
    await typeFilter(pg, "room");
    expect(rowNames(pg)).toEqual(["room-1"]);
    (pg.root.querySelector(".nav-facet-reset") as any).click(); await settle();
    expect(rowNames(pg)).toEqual(["room-1"]);
  });

  it("a page load keeps the filter (this browser's storage); a corrupt or foreign value is ignored", async () => {
    const pg = await app("/ui/chat/web-dev");
    await typeFilter(pg, "doc");
    fire(chip(pg, "Status", "idle"), "change"); await settle();
    const saved = pg.storage.get("agend_instance_filter") ?? null;
    expect(saved, "kept in this browser's storage").not.toBeNull();
    expect(JSON.parse(saved!)).toEqual({ q: "doc", status: ["idle"], cli: [] });
    const again = await reload(pg, "/view/web-dev", { agend_instance_filter: saved! });
    expect(rowNames(again)).toEqual(["docs-writer"]);
    // Kept: the known status; dropped: a non-string query, an unknown status, a non-list CLI.
    const bad = await reload(again, "/ui/chat/web-dev", { agend_instance_filter: '{"q":5,"status":["bogus","idle"],"cli":"x"}' });
    expect([rowNames(bad), (bad.root.querySelector("#filterInput") as any).value]).toEqual([["docs-writer"], ""]);
    expect(bad.root.querySelectorAll(".nav-facet-n").map((n: any) => n.textContent), "one status chip on, no CLI chip").toEqual(["1"]);
    const broken = await reload(bad, "/ui/chat/web-dev", { agend_instance_filter: "{not json" });
    expect(rowNames(broken).length).toBe(5);
  });
});

describe("the identity the status frame carries (one rule with /api/profiles)", () => {
  it("a profile alias and description: searched and shown the same on Chat, View and Fleet", async () => {
    const withProfile = INSTANCES.map(i => i.name === "docs-writer" ? { ...i, display_name: "Sentinel", description: "Writes the release notes" } : i);
    const pg = await app("/ui/chat/web-dev", {}, withProfile);
    await typeFilter(pg, "sentinel");
    for (const path of ["/ui/chat/web-dev", "/view/web-dev", "/ui/fleet"]) {
      await go(path);
      const row = pg.root.querySelector("#instanceList a.inst") as any;
      expect([rowNames(pg), row?.querySelector(".inst-alias")?.textContent, row?.getAttribute("title")?.split("\n").at(-1)], path)
        .toEqual([["docs-writer"], "Sentinel", "Writes the release notes"]);
    }
  });
});

describe("order and folding: View's, on every page", () => {
  it("the order saved by dragging on View is the order on Chat; a folded group stays folded across pages and loads", async () => {
    const order = JSON.stringify([
      { item_type: "group", item_name: "Platform", sort_index: 0, group_name: null },
      { item_type: "instance", item_name: "api-server", sort_index: 0, group_name: "Platform" },
      { item_type: "instance", item_name: "web-dev", sort_index: 1, group_name: "Platform" },
    ]);
    const pg = await app("/ui/chat/web-dev", { agend_view_sidebar_order: order });
    expect(rowNames(pg).slice(0, 2)).toEqual(["api-server", "web-dev"]);
    const docs = pg.root.querySelectorAll("#instanceList .v-group-head").find((b: any) => b.textContent.includes("Docs"))!;
    (docs as any).click(); await settle();
    expect(rowNames(pg)).not.toContain("docs-writer");
    await go("/view/web-dev");
    expect(rowNames(pg)).not.toContain("docs-writer");
    const saved = pg.storage.get("agend_instance_collapsed");
    const again = await reload(pg, "/ui/fleet", { agend_instance_collapsed: saved!, agend_view_sidebar_order: order });
    expect(rowNames(again)).not.toContain("docs-writer");
  });
});

describe("the anonymous View reader", () => {
  it("gets the same list from View's roster read: groups and filter, rows to View, no status chips", async () => {
    const pg = page({ url: "http://127.0.0.1:19280/view/alpha", storage: { agend_tour_done: "1" } });
    mounted.push(pg);
    const { startRouter } = await import("/assets/app-nav.js");
    const { appStore } = await import("/assets/app-store.js");
    const { Shell } = await import("/assets/app-shell.js");
    const { viewStore } = await import("/assets/view-roster-store.js");
    startRouter(pg.window);
    appStore.set({ viewOnly: true });
    viewStore.set({ loaded: true, roster: [
      { instance_name: "alpha", status: "running", backend: "codex", tags: ["G"], context_pct: 5 },
      { instance_name: "beta", status: "stopped", backend: "claude-code", tags: [], context_pct: null },
    ] });
    await pg.mount(h(Shell, { panels: PANELS, onNewInstance() {}, viewOnly: true }));
    await settle(3);
    expect([groups(pg), rowNames(pg), hrefOf(pg, "beta"), activeName(pg)]).toEqual([["G", "Other"], ["alpha", "beta"], "/view/beta", "alpha"]);
    expect(pg.root.querySelectorAll(".nav-facet").map((d: any) => d.querySelector("summary").textContent)).toEqual(["CLI"]);
  });
});
