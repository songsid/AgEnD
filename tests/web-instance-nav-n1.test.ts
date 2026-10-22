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
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1", agend_nav_facets: '{"status":true,"cli":true}', ...storage } });   // both filter groups open (#1700: folded by default)
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
/** #1936: the open instance pinned on top while a filter is on is not a filter result — rowNames are the results. */
const inPinned = (el: any) => { for (let n = el.parentNode; n; n = n.parentNode) if (n.classList?.contains("v-pinned")) return true; return false; };
const rowNames = (pg: AppPage) => pg.root.querySelectorAll("#instanceList a.inst").filter((a: any) => !inPinned(a)).map((a: any) => a.querySelector(".inst-name").textContent);
const pinnedNames = (pg: AppPage) => pg.root.querySelectorAll("#instanceList .v-pinned a.inst").map((a: any) => a.querySelector(".inst-name").textContent);
const hrefOf = (pg: AppPage, name: string) => pg.root.querySelectorAll("#instanceList a.inst").find((a: any) => a.querySelector(".inst-name").textContent === name)?.getAttribute("href");
const activeName = (pg: AppPage) => pg.root.querySelector('#instanceList a.inst[aria-current="page"] .inst-name')?.textContent ?? null;
const groups = (pg: AppPage) => pg.root.querySelectorAll("#instanceList .v-group-head .grow").map((g: any) => g.textContent);
const typeFilter = async (pg: AppPage, value: string) => { const i = pg.root.querySelector("#filterInput") as any; i.value = value; fire(i, "input"); await settle(); };
const chip = (pg: AppPage, facet: string, label: string) => pg.root.querySelectorAll(".nav-facet").find((d: any) => d.querySelector(".nav-facet-label").textContent === facet)!
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

  it("a row opens the view the page is in: View → View, Details → Details, everywhere else (the Fleet tabs too, #1917) → Chat; the open instance is the active row", async () => {
    const pg = await app("/ui/chat/web-dev");
    expect([hrefOf(pg, "docs-writer"), activeName(pg)]).toEqual(["/ui/chat/docs-writer", "web-dev"]);
    await go("/view/api-server");
    expect([hrefOf(pg, "docs-writer"), activeName(pg)]).toEqual(["/view/docs-writer", "api-server"]);
    await go("/ui/fleet/tasks");
    expect([hrefOf(pg, "docs-writer"), activeName(pg)]).toEqual(["/ui/chat/docs-writer", null]);
    await go("/ui/fleet/agent/api-server");
    expect([hrefOf(pg, "docs-writer"), activeName(pg)]).toEqual(["/ui/fleet/agent/docs-writer", "api-server"]);
    await go("/settings");
    expect([hrefOf(pg, "docs-writer"), activeName(pg)]).toEqual(["/ui/chat/docs-writer", null]);
  });

  it("live state on every page: working, needs you, stopped and crashed dots, and the needs-you badge", async () => {
    const pg = await app("/view/web-dev");
    // #1630: the dot sits on the avatar, with its state as its label (not colour alone).
    const dotOf = (name: string) => pg.root.querySelectorAll("#instanceList a.inst").find((a: any) => a.getAttribute("href").endsWith(`/${name}`))!.querySelector(".dot");
    expect(["web-dev", "api-server", "docs-writer", "qa-bot", "room-1"].map(n => dotOf(n).getAttribute("class"))).toEqual(["av-dot dot busy", "av-dot dot warn", "av-dot dot ok", "av-dot dot off", "av-dot dot bad"]);
    expect(["web-dev", "api-server", "docs-writer", "qa-bot", "room-1"].map(n => dotOf(n).getAttribute("aria-label"))).toEqual(["working", "needs you", "idle", "stopped", "crashed"]);
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
    // #1936: web-dev (open, working) is pinned on top, not repeated in the results; the count still counts it.
    expect([pinnedNames(pg), rowNames(pg), pg.root.querySelector(".v-filter .note")!.textContent]).toEqual([["web-dev"], ["docs-writer"], "2 / 5 shown"]);
    fire(chip(pg, "Status", "working"), "change"); fire(chip(pg, "Status", "idle"), "change"); fire(chip(pg, "Status", "stopped"), "change"); fire(chip(pg, "Status", "crashed"), "change"); await settle();
    expect(rowNames(pg)).toEqual(["room-1", "qa-bot"]);
  });

  it("CLI chips list the backends present; text and chips combine", async () => {
    const pg = await app("/ui/chat/web-dev");
    const labels = pg.root.querySelectorAll(".nav-facet").find((d: any) => d.querySelector(".nav-facet-label").textContent === "CLI")!
      .querySelectorAll(".nav-chip").map((c: any) => c.textContent);
    expect(labels).toEqual(["Claude Code", "Codex", "Grok Build", "Kiro CLI"]);
    fire(chip(pg, "CLI", "Claude Code"), "change"); await settle();
    expect([pinnedNames(pg), rowNames(pg)]).toEqual([["web-dev"], ["room-1"]]);
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

describe("the open instance stays on top while a filter is on (#1936)", () => {
  const pinnedBlock = (pg: AppPage) => pg.root.querySelector("#instanceList .v-pinned") as any;
  it("not a match: pinned on top under \"Current\", the active row, its own link; the results and the count are the filter's", async () => {
    const pg = await app("/ui/chat/web-dev");
    await typeFilter(pg, "ap");
    const block = pinnedBlock(pg);
    expect([block?.getAttribute("role"), block?.getAttribute("aria-label"), block?.querySelector(".v-group-head .grow")?.textContent]).toEqual(["group", "The instance you have open", "Current"]);
    const a = block.querySelector("a.inst");
    expect([a.getAttribute("href"), a.getAttribute("aria-current"), a.classList.contains("active"), a.getAttribute("draggable")]).toEqual(["/ui/chat/web-dev", "page", true, null]);
    expect(pg.root.querySelectorAll("#instanceList a.inst")[0], "first in the list").toBe(a);
    expect([pinnedNames(pg), rowNames(pg), pg.root.querySelector(".v-filter .note")!.textContent]).toEqual([["web-dev"], ["api-server"], "1 / 5 shown"]);
    expect(pg.root.querySelector("#instanceList .side-empty"), "not \"no match\"").toBeNull();
  });
  it("a match: pinned once, not repeated in the results, and counted", async () => {
    const pg = await app("/ui/chat/web-dev");
    await typeFilter(pg, "e");
    expect(pinnedNames(pg)).toEqual(["web-dev"]);
    expect(rowNames(pg)).not.toContain("web-dev");
    expect(pg.root.querySelectorAll("#instanceList a.inst").filter((a: any) => a.getAttribute("href") === "/ui/chat/web-dev").length).toBe(1);
    expect(pg.root.querySelector(".v-filter .note")!.textContent).toBe(`${rowNames(pg).length + 1} / 5 shown`);
  });
  it("the only match: pinned, and \"no match\" is not shown", async () => {
    const pg = await app("/ui/chat/web-dev");
    await typeFilter(pg, "web-d");
    expect([pinnedNames(pg), rowNames(pg), pg.root.querySelector("#instanceList .side-empty"), pg.root.querySelector(".v-filter .note")!.textContent]).toEqual([["web-dev"], [], null, "1 / 5 shown"]);
    expect(groups(pg), "its group, empty without it, is not shown").toEqual(["Current"]);
  });
  it("no filter, or no instance open: nothing pinned; clearing the filter puts it back in its group", async () => {
    const pg = await app("/ui/chat/web-dev");
    expect(pinnedBlock(pg)).toBeNull();
    await typeFilter(pg, "ap");
    expect(pinnedBlock(pg)).not.toBeNull();
    await typeFilter(pg, "");
    expect([pinnedBlock(pg), activeName(pg), rowNames(pg).includes("web-dev")]).toEqual([null, "web-dev", true]);
    await go("/ui/fleet/org");
    await typeFilter(pg, "ap");
    expect([pinnedBlock(pg), rowNames(pg)]).toEqual([null, ["api-server"]]);
  });
  it("the same on View, Details and Log, and by status / CLI facets; a favorite open instance is pinned, not listed under Favorites", async () => {
    const pg = await app("/view/docs-writer");
    fire(chip(pg, "CLI", "Codex"), "change"); await settle();
    expect([pinnedNames(pg), rowNames(pg), pinnedBlock(pg).querySelector("a.inst").getAttribute("href")]).toEqual([["docs-writer"], ["api-server"], "/view/docs-writer"]);
    await go("/ui/fleet/agent/qa-bot");
    expect(pinnedNames(pg)).toEqual(["qa-bot"]);
    const nav = await import("/assets/instance-nav.js");
    nav.navStore.set({ favorites: ["qa-bot", "api-server"] }); await settle(2);
    expect([pinnedNames(pg), rowNames(pg)]).toEqual([["qa-bot"], ["api-server"]]);
    expect(pg.root.querySelectorAll("#instanceList .v-fav a.inst").map((a: any) => a.querySelector(".inst-name").textContent)).toEqual(["api-server"]);
    nav.navStore.set({ favorites: [] });
  });
  it("in zh-TW: 目前", async () => {
    const pg = await app("/ui/chat/web-dev");
    const { setLang } = await import("/assets/app-i18n.js");
    setLang("zh-TW"); await settle(2);
    await typeFilter(pg, "ap");
    expect([pinnedBlock(pg).getAttribute("aria-label"), pinnedBlock(pg).querySelector(".v-group-head .grow").textContent]).toEqual(["你目前開著的 instance", "目前"]);
    setLang("en"); await settle();
  });
});

describe("the identity the status frame carries (one rule with /api/profiles)", () => {
  it("a profile alias and description: searched and shown the same on Chat, View and Fleet", async () => {
    const withProfile = INSTANCES.map(i => i.name === "docs-writer" ? { ...i, display_name: "Sentinel", description: "Writes the release notes" } : i);
    const pg = await app("/ui/chat/web-dev", {}, withProfile);
    await typeFilter(pg, "sentinel");
    for (const path of ["/ui/chat/web-dev", "/view/web-dev", "/ui/fleet"]) {
      await go(path);
      const row = pg.root.querySelectorAll("#instanceList a.inst").find((a: any) => !inPinned(a)) as any;
      // #1630: called by its display name, the instance name on hover.
      expect([rowNames(pg), row?.querySelector(".inst-alias")?.textContent, row?.getAttribute("title")?.split("\n").slice(0, 2), row?.getAttribute("title")?.split("\n").at(-1)], path)
        .toEqual([["Sentinel"], undefined, ["Sentinel", "(docs-writer)"], "Writes the release notes"]);
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
    expect(pg.root.querySelectorAll(".nav-facet").map((d: any) => d.querySelector(".nav-facet-label").textContent)).toEqual(["CLI"]);
  });
});

// #1776: the "N / M" count sits on the facet headers' row, at its right end — not on a row of its own under them. The
// headers, an open group's list and the reset wrap in their own box beside it, so nothing pushes the count down.
describe("#1776: the count is on the facet headers' row", () => {
  const facetsRow = (pg: AppPage) => pg.root.querySelector(".v-filter .nav-facets") as any;
  const shape = (pg: AppPage) => {
    const row = facetsRow(pg);
    return {
      children: [...row.children].map((c: any) => c.className),
      groups: [...row.querySelector(".nav-facet-groups").children].map((c: any) => c.className.split(" ")[0]),
      count: row.querySelector(".nav-shown")?.textContent ?? null,
      live: row.querySelector(".nav-shown")?.getAttribute("aria-live") ?? null,
      ownRow: [...(pg.root.querySelector(".v-filter") as any).children].some((c: any) => c.classList.contains("note")),
    };
  };

  it("folded and open, filtered or not: the headers (and the reset) in their box, the count after it, in the same row", async () => {
    const pg = await app("/ui/chat/web-dev", { agend_nav_facets: '{"status":false,"cli":false}' });
    expect(shape(pg)).toEqual({ children: ["nav-facet-groups", "note nav-shown"], groups: ["nav-facet", "nav-facet"], count: "5 / 5", live: "polite", ownRow: false });
    (pg.root.querySelector(".nav-facet-head") as any).click(); await settle();
    fire(chip(pg, "Status", "needs you"), "change"); await settle();
    expect(shape(pg), "a group open, a filter set: its list stays in the box; the count is still the row's last").toEqual({
      children: ["nav-facet-groups", "note nav-shown"], groups: ["nav-facet", "nav-facet", "chip-btn"], count: "1 / 5 shown", live: "polite", ownRow: false });
    expect(facetsRow(pg).querySelector(".nav-facet-groups .nav-facet-list"), "the open list is under its header, in the box").not.toBeNull();
  });

  it("one CLI (no CLI group): the count beside the Status header, still in that row", async () => {
    const pg = await app("/ui/chat/web-dev", {}, [live("web-dev"), live("api-server")]);
    expect(shape(pg)).toEqual({ children: ["nav-facet-groups", "note nav-shown"], groups: ["nav-facet"], count: "2 / 2", live: "polite", ownRow: false });
  });

  it("the rules: the row does not wrap; the headers' box does, and may shrink; the count keeps its width at the right end", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const decl = (sel: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1]!.split(",").map(s => s.trim()).includes(sel)).map(m => m[2]!).join(";");
    expect(decl(".nav-facets")).not.toMatch(/flex-wrap/);
    expect(decl(".nav-facet-groups")).toMatch(/flex-wrap:\s*wrap/);
    expect(decl(".nav-facet-groups")).toMatch(/min-width:\s*0/);
    expect(decl(".nav-facets .nav-shown")).toMatch(/flex:\s*none/);
    expect(decl(".nav-facets .nav-shown")).toMatch(/margin:\s*0 0 0 auto/);
    expect(decl(".nav-facets .nav-shown")).toMatch(/white-space:\s*nowrap/);
  });
});
