/**
 * The task board's list and filters (after Linear's Display and Filter, as Circle draws them):
 *  - filters stack, each "is" or "is not" some values; a main task stays when it or one of its sub tasks matches them
 *    all; they ride in the address with the project (`?tp=`, `?tf=`), so a link opens that filtered board, and the last
 *    ones are kept on the device (the old assignee filter becomes one);
 *  - Display: the board or a list, the list grouped by status, assignee or priority, ordered by the board, priority,
 *    last change, newest or title, sub tasks as rows of their own; finished cards of the last 7 days, all, or hidden.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let app: any, nav: any, fleet: any, view: any;
const calls: string[] = [];
let handler: (path: string) => unknown = () => ({});
const fetchFake = async (path: string) => { calls.push(path); const body: any = await handler(path); return { ok: true, status: 200, json: async () => body }; };

const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const PROJECT = { id: 1, name: "Leaderboard", description: "", archived: false, sort: 1, createdAt: ago(30) };
const card = (over: Record<string, unknown>) => ({ id: "M-1", uuid: String(over.id ?? "M-1"), kind: "main", projectId: 1, parentId: null, title: "A card", status: "open",
  assignee: null, dispatcher: { kind: "person", name: "Ann" }, waitsForPerson: false, confirmer: null, priority: "normal", size: null, needsReview: true, dependsOn: [], goal: "", scope: "",
  acceptance: [], context: "", state: "", blockedReason: "", result: "", sort: 1, createdBy: "Ann", version: 1, createdAt: ago(10), updatedAt: ago(5), startedAt: null, submittedAt: null,
  doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const M1 = card({ id: "M-1", title: "Serve the weekly leaderboard", status: "claimed", assignee: "alpha", priority: "high", sort: 1, createdAt: ago(9), updatedAt: ago(1) });
const M2 = card({ id: "M-2", title: "Add the shop", status: "open", assignee: "beta", priority: "low", size: "S", sort: 2, createdAt: ago(3), updatedAt: ago(4),
  progress: { total: 1, open: 0, claimed: 0, blocked: 1, review: 0, done: 0 } });
const S1 = card({ id: "S-1", kind: "sub", parentId: "M-2", title: "Price list", status: "blocked", assignee: "alpha", blockedReason: "Which currency?", sort: 1, updatedAt: ago(2) });
const M3 = card({ id: "M-3", title: "Choose the badge", status: "review", assignee: null, waitsForPerson: true, priority: "urgent", sort: 3, createdAt: ago(7), updatedAt: ago(3) });
const M4 = card({ id: "M-4", title: "Bootstrap", status: "done", assignee: "alpha", sort: 4, doneAt: ago(1), createdAt: ago(20), updatedAt: ago(1) });
const CARDS = [M1, M2, S1, M3, M4];

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  fleet = await import("/ui/js/panel-fleet.js");
  view = await import("/ui/js/fleet-task-view.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  for (const k of ["agend_tasks_project", "agend_tasks_filters", "agend_tasks_display", "agend_tasks_assignee"]) (globalThis as any).localStorage.removeItem(k);
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  calls.length = 0;
  handler = (path) => path.startsWith("/ui/tasks/board") ? { rev: 1, projects: [PROJECT], cards: CARDS }
    : path.startsWith("/ui/tasks/cards/") ? { card: CARDS.find((c) => path.endsWith(`/${c.id}`)) ?? M1, parent: null, children: [], comments: [], logs: [], history: [] } : {};
  app.applyStatus({ uptime: 1, instances: [{ name: "alpha", status: "running", state: "idle", execution_state: "idle" }, { name: "beta", status: "running", state: "idle", execution_state: "idle" }] });
});

let mounts = 0;
async function board(storage: Record<string, string> = { agend_tasks_project: "1" }) {
  for (const [k, v] of Object.entries(storage)) (globalThis as any).localStorage.setItem(k, v);
  await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|lf-${++mounts}|en` }));
  await settle(8);
}
const q = (sel: string) => p.root.querySelector(sel);
const qa = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
// An element's words, a space between its pieces (the markup has no whitespace between elements).
const text = (el: any): string | null => (el ? el.childNodes.map((n: any) => (n.nodeType === 3 ? n.textContent : text(n)) ?? "").map((s: string) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") : null);
const tiles = () => qa(".tb-col").map((col) => [col.getAttribute("aria-label"), col.querySelectorAll(".tb-tile").map((t: any) => t.getAttribute("data-tile"))]);
const rows = () => qa(".tb-row").map((r) => r.getAttribute("data-row"));
const groups = () => qa(".tb-group").map((g) => [text(g.querySelector(".tb-group-head")), g.querySelectorAll(".tb-row").map((r: any) => r.getAttribute("data-row"))]);
const search = () => new URLSearchParams((globalThis as any).location.search);
async function pick(menu: string, label: string) {
  if (!q(`${menu} .menu-list`)) { fire(q(`${menu} > button`), "click"); await settle(4); }
  const item = qa(`${menu} .menu-list button`).find((b) => text(b) === label);
  expect(item, `${label} in ${menu}`).toBeTruthy();
  fire(item, "click");
  await settle(6);
}

describe("filters: the address form", () => {
  it("round-trips any value: an assignee's , ; : ! % ~ and CJK, nobody, is not", () => {
    const filters = [{ field: "assignee", not: false, values: ["a,b;c:d", "100%~!", "小金", view.NONE] }, { field: "priority", not: true, values: ["low", "normal"] }];
    const s = view.formatFilters(filters);
    expect(s).toBe("assignee:a%2Cb%3Bc%3Ad,100%25%7E%21,小金,~;priority!:low,normal");
    expect(view.parseFilters(s)).toEqual(filters);
    // Through the address bar and back.
    const u = new URL("http://x/ui/fleet"); u.searchParams.set("tf", s);
    expect(view.parseFilters(new URL(u.href).searchParams.get("tf"))).toEqual(filters);
  });
  it("drops what it does not know: fields, statuses, priorities, sizes, a broken escape, a field's second filter, empty ones", () => {
    expect(view.parseFilters("colour:red;status:claimed,gone;priority:urgent,nope;size:XL,~;assignee:%E0%A4,alpha;status:open;priority!:")).toEqual([
      { field: "status", not: false, values: ["claimed"] }, { field: "priority", not: false, values: ["urgent"] },
      { field: "size", not: false, values: [view.NONE] }, { field: "assignee", not: false, values: ["alpha"] },
    ]);
    expect(view.parseFilters("")).toEqual([]);
    expect(view.parseFilters(null)).toEqual([]);
  });
});

describe("filters: what matches", () => {
  const f = (field: string, values: string[], not = false) => ({ field, not, values });
  it("is, is not, nobody, not sized — and every filter at once", () => {
    expect(view.cardMatches(M1, [f("assignee", ["alpha"])])).toBe(true);
    expect(view.cardMatches(M1, [f("assignee", ["alpha"], true)])).toBe(false);
    expect(view.cardMatches(M3, [f("assignee", [view.NONE])])).toBe(true);
    expect(view.cardMatches(M1, [f("size", [view.NONE])])).toBe(true);
    expect(view.cardMatches(M2, [f("size", [view.NONE])])).toBe(false);
    expect(view.cardMatches(M1, [f("assignee", ["alpha"]), f("priority", ["low"])])).toBe(false);
    expect(view.cardMatches(M1, [])).toBe(true);
  });
  it("a main task stays when one of its sub tasks matches", () => {
    expect(view.mainMatches(M2, [S1], [f("assignee", ["alpha"])])).toBe(true);
    expect(view.mainMatches(M2, [S1], [f("status", ["blocked"])])).toBe(true);
    expect(view.mainMatches(M2, [S1], [f("assignee", ["gamma"])])).toBe(false);
  });
  it("finished cards: the last 7 days', all, or none", () => {
    const old = card({ status: "done", doneAt: ago(30) });
    expect([view.doneShown(M4, "recent"), view.doneShown(old, "recent"), view.doneShown(old, "all"), view.doneShown(M4, "hide"), view.doneShown(M1, "hide")]).toEqual([true, false, true, false, true]);
  });
  it("ticking a value: a new filter, a value more, a value less, gone with its last", () => {
    let fs = view.toggleValue([], "assignee", "alpha");
    expect(fs).toEqual([f("assignee", ["alpha"])]);
    fs = view.toggleValue([{ ...fs[0], not: true }], "assignee", "beta");
    expect(fs).toEqual([f("assignee", ["alpha", "beta"], true)]);
    fs = view.toggleValue(fs, "assignee", "alpha");
    expect(fs).toEqual([f("assignee", ["beta"], true)]);
    expect(view.toggleValue(fs, "assignee", "beta")).toEqual([]);
  });
  it("the assignees offered: the cards' and the filter's, by name, nobody last; the others are fixed", () => {
    expect(view.fieldValues("assignee", CARDS, f("assignee", ["zed"]))).toEqual(["alpha", "beta", "zed", view.NONE]);
    expect(view.fieldValues("status", CARDS)).toEqual(["open", "claimed", "blocked", "review", "done"]);
    expect(view.fieldValues("size", CARDS)).toEqual(["S", "M", "L", view.NONE]);
  });
});

describe("the list: rows, order and groups", () => {
  const byId = new Map(CARDS.map((c) => [c.id, c]));
  const ids = (list: any[]) => list.map((c) => c.id);
  it("orders: the board's (a sub task right after its main task), priority, last change, newest, title", () => {
    const all = [M4, S1, M3, M2, M1];
    expect(ids(view.orderRows(all, "manual", byId))).toEqual(["M-1", "M-2", "S-1", "M-3", "M-4"]);
    expect(ids(view.orderRows(all, "priority", byId))).toEqual(["M-3", "M-1", "S-1", "M-4", "M-2"]);
    expect(ids(view.orderRows(all, "updated", byId))).toEqual(["M-1", "M-4", "S-1", "M-3", "M-2"]);
    expect(ids(view.orderRows(all, "created", byId))).toEqual(["M-2", "M-3", "M-1", "S-1", "M-4"]);
    expect(ids(view.orderRows(all, "title", byId))).toEqual(["M-2", "M-4", "M-3", "S-1", "M-1"]);
  });
  it("groups: statuses as the columns, priorities from urgent, assignees by name with nobody last; none is one group", () => {
    const all = [M1, M2, S1, M3, M4];
    expect(view.groupRows(all, "status").map((g: any) => [g.key, ids(g.rows)])).toEqual([["open", ["M-2"]], ["claimed", ["M-1"]], ["blocked", ["S-1"]], ["review", ["M-3"]], ["done", ["M-4"]]]);
    expect(view.groupRows(all, "priority").map((g: any) => g.key)).toEqual(["urgent", "high", "normal", "low"]);
    expect(view.groupRows(all, "assignee").map((g: any) => [g.key, ids(g.rows)])).toEqual([["alpha", ["M-1", "S-1", "M-4"]], ["beta", ["M-2"]], [view.NONE, ["M-3"]]]);
    expect(view.groupRows(all, "none").map((g: any) => ids(g.rows))).toEqual([ids(all)]);
    expect(view.groupRows([], "none")).toEqual([]);
  });
  it("sub tasks as rows: a main task that matches itself, and its sub tasks that do", () => {
    const subsOf = new Map([["M-2", [S1]]]);
    const d = { ...view.DEFAULT_DISPLAY, subs: true };
    expect(ids(view.listRows([M1, M2], subsOf, d, []))).toEqual(["M-1", "M-2", "S-1"]);
    expect(ids(view.listRows([M1, M2], subsOf, d, [{ field: "assignee", not: false, values: ["alpha"] }]))).toEqual(["M-1", "S-1"]);
    expect(ids(view.listRows([M1, M2], subsOf, view.DEFAULT_DISPLAY, []))).toEqual(["M-1", "M-2"]);
  });
  it("display choices from anything: each one known, else its default", () => {
    expect(view.cleanDisplay({ view: "list", group: "colour", order: "title", done: "hide", subs: "yes" })).toEqual({ view: "list", group: "status", order: "title", done: "hide", subs: false });
    expect(view.cleanDisplay(null)).toEqual(view.DEFAULT_DISPLAY);
  });
  it("the filters to start with: the address's, else the device's, else the old assignee filter's (nobody too)", () => {
    const ls = (globalThis as any).localStorage;
    ls.setItem("agend_tasks_assignee", "\u0000none");
    expect(view.startFilters("")).toEqual([{ field: "assignee", not: false, values: [view.NONE] }]);
    view.keepFilters([{ field: "priority", not: false, values: ["high"] }]);
    expect(ls.getItem("agend_tasks_assignee"), "the old one is gone once these are kept").toBeNull();
    expect(view.startFilters("")).toEqual([{ field: "priority", not: false, values: ["high"] }]);
    expect(view.startFilters("?tf=status%3Aopen")).toEqual([{ field: "status", not: false, values: ["open"] }]);
    expect(view.startFilters("?tf="), "an address without filters wins over the device's").toEqual([]);
  });
});

describe("on the board", () => {
  it("Filter: ticking an assignee keeps the main tasks it (or a sub task) has; the chip says so; the address carries it", async () => {
    await board();
    expect(tiles()).toEqual([["To do", ["M-2"]], ["In progress", ["M-1"]], ["Blocked", []], ["To confirm", ["M-3"]], ["Done", ["M-4"]]]);
    expect(search().get("tp")).toBe("1");
    await pick(".tb-filter-menu", "alpha");
    expect(tiles()).toEqual([["To do", ["M-2"]], ["In progress", ["M-1"]], ["Blocked", []], ["To confirm", []], ["Done", ["M-4"]]]);
    expect(text(q(".tb-chip"))).toBe("Assignee is alpha");
    expect(search().get("tf")).toBe("assignee:alpha");
    expect((globalThis as any).localStorage.getItem("agend_tasks_filters")).toBe("assignee:alpha");
    expect(q(".tb-filter-menu > button").className).toContain("active");
    // is → is not
    fire(q(".tb-chip-op"), "click"); await settle(6);
    expect(text(q(".tb-chip"))).toBe("Assignee is not alpha");
    expect(search().get("tf")).toBe("assignee!:alpha");
    expect(tiles().flatMap(([, ids]) => ids)).toEqual(["M-2", "M-3"]);
    // A second filter: every one must match.
    await pick(".tb-filter-menu", "Urgent");
    expect(tiles().flatMap(([, ids]) => ids)).toEqual(["M-3"]);
    expect(search().get("tf")).toBe("assignee!:alpha;priority:urgent");
    // Removing one, then clearing.
    fire(qa(".tb-chip-x")[1], "click"); await settle(6);
    expect(qa(".tb-chip").length).toBe(1);
    fire(q(".tb-filters > .tb-link"), "click"); await settle(6);
    expect(q(".tb-filters")).toBeNull();
    expect(search().has("tf")).toBe(false);
    expect(tiles().flatMap(([, ids]) => ids)).toEqual(["M-2", "M-1", "M-3", "M-4"]);
  });

  it("a chip's values: its own menu, ticked as the filter has them", async () => {
    await board({ agend_tasks_project: "1", agend_tasks_filters: "assignee:alpha,beta,~" });
    expect(text(q(".tb-chip .menu-text"))).toBe("3 values");
    await pick(".tb-chip-menu", "Unassigned");
    expect(text(q(".tb-chip .menu-text"))).toBe("alpha, beta");
    expect(qa(".tb-chip-menu .menu-list [aria-checked=true]").map(text)).toEqual(["alpha", "beta"]);
  });

  it("a link with a project and filters opens that filtered board; Back to the projects leaves them out of the address", async () => {
    (globalThis as any).history.replaceState(null, "", "/ui/fleet?tp=1&tf=priority%3Ahigh");
    await board({});
    expect(text(q(".tb-title h2"))).toBe("Leaderboard");
    expect(text(q(".tb-chip"))).toBe("Priority is High");
    expect(tiles().flatMap(([, ids]) => ids)).toEqual(["M-1"]);
    fire(q(".tb-bar-head .btn-ghost"), "click"); await settle(8);
    expect(q(".tb-home")).toBeTruthy();
    expect(search().has("tp") || search().has("tf")).toBe(false);
  });

  it("the old assignee filter on the device becomes an assignee filter", async () => {
    await board({ agend_tasks_project: "1", agend_tasks_assignee: "beta" });
    expect(text(q(".tb-chip"))).toBe("Assignee is beta");
    expect(tiles().flatMap(([, ids]) => ids)).toEqual(["M-2"]);
  });

  it("finished cards hidden: no Done column; all: the board asks for every finished card", async () => {
    await board();
    await pick(".tb-view-menu", "Hidden");
    expect(tiles().map(([s]) => s)).toEqual(["To do", "In progress", "Blocked", "To confirm"]);
    expect(q(".tb-columns").className).toContain("no-done");
    expect(q(".tb-view-menu > button").className).toContain("active");
    await pick(".tb-view-menu", "All");
    expect(calls.some((c) => c === "/ui/tasks/board?done=all")).toBe(true);
    expect(JSON.parse((globalThis as any).localStorage.getItem("agend_tasks_display"))).toMatchObject({ done: "all" });
    // The Done column's own switch is the same choice.
    fire(q(".tb-col.st-done .tb-col-head .tb-link"), "click"); await settle(6);
    expect(JSON.parse((globalThis as any).localStorage.getItem("agend_tasks_display"))).toMatchObject({ done: "recent" });
  });
});

describe("the list", () => {
  it("a row per main task, grouped by status; a row opens its card; sub tasks open up under their main task", async () => {
    await board();
    await pick(".tb-view-menu", "List");
    expect(q(".tb-columns")).toBeNull();
    expect(groups()).toEqual([["To do 1", ["M-2"]], ["In progress 1", ["M-1"]], ["To confirm 1", ["M-3"]], ["Done 1", ["M-4"]]]);
    const m3 = q('[data-row="M-3"]');
    expect(text(m3.querySelector(".tb-row-tags"))).toBe("Urgent Waiting for you To fill in");   // in review without a result
    expect(text(m3.querySelector(".tb-row-who"))).toBe("Unassigned");
    fire(q('[data-row="M-2"] .tb-row-progress'), "click"); await settle(6);
    expect(qa('[data-row="M-2"] .tb-subs li').map((li) => text(li.querySelector(".tb-code")))).toEqual(["S-1"]);
    fire(q('[data-row="M-1"] .tb-row-title'), "click"); await settle(6);
    expect(search().get("card")).toBe("M-1");
  });

  it("grouped by assignee with sub tasks as rows: each instance's own steps under it, nobody last", async () => {
    await board({ agend_tasks_project: "1", agend_tasks_display: JSON.stringify({ view: "list" }) });
    await pick(".tb-view-menu", "Assignee");
    await pick(".tb-view-menu", "Sub tasks as rows of their own");
    expect(groups()).toEqual([["A alpha 3", ["M-1", "S-1", "M-4"]], ["B beta 1", ["M-2"]], ["Unassigned 1", ["M-3"]]]);
    expect(text(q('[data-row="S-1"] .tb-row-main'))).toBe("M-2 ›");
    expect(text(q('[data-row="S-1"] .tb-row-note'))).toBe("Which currency?");
    expect(q('[data-row="M-2"] button.tb-row-progress'), "its sub tasks are rows already: nothing to open up").toBeNull();
    expect(q(".tb-row-who"), "the heading names the assignee").toBeNull();
    await pick(".tb-view-menu", "No grouping");
    await pick(".tb-view-menu", "Title");
    expect(q(".tb-group-head")).toBeNull();
    expect(rows()).toEqual(["M-2", "M-4", "M-3", "S-1", "M-1"]);
    expect(JSON.parse((globalThis as any).localStorage.getItem("agend_tasks_display"))).toEqual({ view: "list", group: "none", order: "title", done: "recent", subs: true });
  });

  it("filters apply to the list, and nothing left says so", async () => {
    await board({ agend_tasks_project: "1", agend_tasks_display: JSON.stringify({ view: "list" }), agend_tasks_filters: "assignee:gamma" });
    expect(rows()).toEqual([]);
    expect(text(q(".empty"))).toContain("No main tasks match the filter");
  });
});
