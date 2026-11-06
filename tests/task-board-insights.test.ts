/**
 * A project's Insights (after Linear's, as Circle draws them): its cards counted per assignee (each instance's load),
 * status, priority or size, each row a bar split by status, priority or size, with the numbers — every card or main
 * tasks alone, as the board shows them (its filter, its finished cards). The choices are kept on the device.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let app: any, nav: any, fleet: any, stats: any;
let handler: (path: string) => unknown = () => ({});
const fetchFake = async (path: string) => { const body: any = await handler(path); return { ok: true, status: 200, json: async () => body }; };

const card = (over: Record<string, unknown>) => ({ id: "M-1", uuid: String(over.id ?? "M-1"), kind: "main", projectId: 1, parentId: null, title: "A card", status: "open",
  assignee: null, dispatcher: { kind: "person", name: "Ann" }, waitsForPerson: false, confirmer: null, priority: "normal", size: null, needsReview: true, dependsOn: [], goal: "", scope: "",
  acceptance: [], context: "", state: "", blockedReason: "", result: "", sort: 1, createdBy: "Ann", version: 1, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
  startedAt: null, submittedAt: null, doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const PROJECT = { id: 1, name: "Leaderboard", description: "", archived: false, sort: 1, createdAt: "2026-11-01T00:00:00.000Z" };
const CARDS = [
  card({ id: "M-1", status: "claimed", assignee: "alpha", priority: "high", size: "M", sort: 1 }),
  card({ id: "M-2", status: "open", assignee: "beta", priority: "low", size: "L", sort: 2, progress: { total: 3, open: 1, claimed: 1, blocked: 1, review: 0, done: 0 } }),
  card({ id: "S-1", kind: "sub", parentId: "M-2", status: "blocked", assignee: "alpha", sort: 1 }),
  card({ id: "S-2", kind: "sub", parentId: "M-2", status: "claimed", assignee: "beta", size: "S", sort: 2 }),
  card({ id: "S-3", kind: "sub", parentId: "M-2", status: "open", assignee: "alpha", sort: 3 }),
  card({ id: "M-3", status: "review", assignee: null, priority: "urgent", sort: 3 }),
  card({ id: "M-4", status: "cancelled", assignee: "alpha", sort: 4 }),
];

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  fleet = await import("/ui/js/panel-fleet.js");
  stats = await import("/ui/js/fleet-task-stats.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  for (const k of ["agend_tasks_project", "agend_tasks_insights", "agend_tasks_assignee"]) (globalThis as any).localStorage.removeItem(k);
  handler = (path) => path.startsWith("/ui/tasks/board") ? { rev: 1, projects: [PROJECT], cards: CARDS } : {};
  app.applyStatus({ uptime: 1, instances: ["alpha", "beta"].map((name) => ({ name, status: "running", state: "idle", execution_state: "idle" })) });
});

const live = CARDS.filter((c) => c.status !== "cancelled");
const table = (d: any) => d.rows.map((r: any) => [r.key, r.total, d.parts.map((x: string) => r.parts[x])]);

describe("the numbers", () => {
  it("per assignee, split by status: most cards first, nobody last; the parts in the columns' order", () => {
    const d = stats.insight(live, stats.DEFAULT_INSIGHT);
    expect(d.parts).toEqual(["open", "claimed", "blocked", "review", "done"]);
    expect(table(d)).toEqual([["alpha", 3, [1, 1, 1, 0, 0]], ["beta", 2, [1, 1, 0, 0, 0]], ["~", 1, [0, 0, 0, 1, 0]]]);
    expect([d.max, d.total]).toEqual([3, 6]);
  });
  it("main tasks alone; rows per status, priority or size in their own order; no split", () => {
    expect(table(stats.insight(live, { count: "main", rows: "assignee", split: "none" }))).toEqual([["alpha", 1, [1]], ["beta", 1, [1]], ["~", 1, [1]]]);
    expect(stats.insight(live, { count: "all", rows: "status", split: "priority" }).rows.map((r: any) => r.key)).toEqual(["open", "claimed", "blocked", "review"]);
    expect(table(stats.insight(live, { count: "all", rows: "priority", split: "size" }))).toEqual([
      ["urgent", 1, [0, 0, 0, 1]], ["high", 1, [0, 1, 0, 0]], ["normal", 3, [1, 0, 0, 2]], ["low", 1, [0, 0, 1, 0]]]);
    expect(stats.insight([], stats.DEFAULT_INSIGHT)).toMatchObject({ rows: [], max: 0, total: 0 });
  });
  it("choices from anything: each known, else the default; a split on the rows' field (or by assignee) is no split", () => {
    expect(stats.cleanInsight({ count: "main", rows: "size", split: "size" })).toEqual({ count: "main", rows: "size", split: "none" });
    expect(stats.cleanInsight({ count: "x", rows: "colour", split: "assignee" })).toEqual(stats.DEFAULT_INSIGHT);
    expect(stats.cleanInsight(null)).toEqual(stats.DEFAULT_INSIGHT);
  });
  it("its words: every key in both languages with the same {n}; every t(\"taskstats.…\") names one", () => {
    const UI = join(process.cwd(), "src", "ui");
    const strip = (src: string) => src.replace(/^import .*$/gm, "").replace(/^export /gm, "");
    const ctx = vm.createContext({ navigator: { language: "en" } });
    vm.runInContext(strip(readFileSync(join(UI, "shared", "app-i18n.js"), "utf8")), ctx);
    const src = readFileSync(join(UI, "fleet-task-stats.js"), "utf8");
    vm.runInContext(`(${/register\("taskstats", \{[\s\S]*?\n\}\)/.exec(src)![0]})`, ctx);
    const tables = vm.runInContext("tables", ctx) as Record<"en" | "zh-TW", Record<string, string>>;
    const keys = (lang: "en" | "zh-TW") => Object.keys(tables[lang]).filter((k) => k.startsWith("taskstats.")).sort();
    expect(keys("en")).toEqual(keys("zh-TW"));
    for (const k of keys("en")) expect((tables["zh-TW"][k]!.match(/\{\d\}/g) ?? []).join(), k).toBe((tables.en[k]!.match(/\{\d\}/g) ?? []).join());
    for (const file of ["fleet-task-stats.js", "fleet-tasks.js"]) for (const m of readFileSync(join(UI, file), "utf8").matchAll(/\bt\(\s*"(taskstats\.[\w.]+)"/g)) expect(tables.en[m[1]!], m[1]).toBeDefined();
  });
});

describe("on the board", () => {
  const q = (sel: string) => p.root.querySelector(sel) ?? (globalThis as any).document.querySelector(sel);
  const rows = () => [...(globalThis as any).document.querySelectorAll("dialog[open] .ts-table tbody tr")].map((tr: any) =>
    [tr.querySelector("th").textContent, ...[...tr.querySelectorAll("td.ts-n")].map((td: any) => td.textContent)]);
  async function open(storage: Record<string, string> = {}) {
    for (const [k, v] of Object.entries({ agend_tasks_project: "1", ...storage })) (globalThis as any).localStorage.setItem(k, v);
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|ins-${Math.random()}|en` }));
    await settle(8);
    fire(q(".tb-stats .tb-insights"), "click");
    await settle(6);
  }

  it("Insights beside the project's numbers: per assignee by status, a bar per row as long as its share of the longest", async () => {
    await open();
    expect(q("dialog[open] .dlg-title").textContent).toBe("Insights: Leaderboard");
    expect(q("dialog[open] .ts-sum").textContent).toBe("6 cards");
    expect([...(globalThis as any).document.querySelectorAll("dialog[open] .ts-table thead th")].map((th: any) => th.textContent)).toEqual(["Assignee", "Total", "", "To do", "In progress", "Blocked", "To confirm", "Done"]);
    expect(rows()).toEqual([["Aalpha", "3", "1", "1", "1", "0", "0"], ["Bbeta", "2", "1", "1", "0", "0", "0"], ["Unassigned", "1", "0", "0", "0", "1", "0"]]);
    const beta = (globalThis as any).document.querySelectorAll("dialog[open] .ts-table tbody tr")[1];
    expect([...beta.querySelectorAll(".ts-seg")].map((r: any) => `${r.getAttribute("class")}@${Math.round(Number(r.getAttribute("x")))}+${Math.round(Number(r.getAttribute("width")))}`))
      .toEqual(["ts-seg status-open@0+33", "ts-seg status-claimed@33+33"]);
  });

  it("what the board shows: its assignee filter; and the choices are kept", async () => {
    await open({ agend_tasks_assignee: "alpha" });
    // M-1 (alpha's) and M-2 (a sub task of alpha's): their cards, sub tasks included.
    expect(q("dialog[open] .ts-sum").textContent).toBe("5 cards");
    const pick = (i: number, v: string) => { const s = (globalThis as any).document.querySelectorAll("dialog[open] .ts-choices select")[i]; s.value = v; fire(s, "change"); };
    pick(0, "main"); await settle(4);
    pick(1, "priority"); await settle(4);
    pick(2, "none"); await settle(4);
    expect(rows()).toEqual([["High", "1"], ["Low", "1"]]);
    expect(JSON.parse((globalThis as any).localStorage.getItem("agend_tasks_insights"))).toEqual({ count: "main", rows: "priority", split: "none" });
  });
});
