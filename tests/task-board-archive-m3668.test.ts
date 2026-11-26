/**
 * M-3668 (the user, 11-24, hmsg-0545a711 「1–3 照提案做」): finished main tasks crowded the board (355 in one project's
 * Done column "Last 7 days"; this fleet finishes ~126 a day).
 *   1. The Done column shows its newest 20, "Show 20 more" at a time; its header says how many finished this week.
 *   2. A finished main task (done or cancelled) is archived `defaults.task_board.archive_after_days` (default 3; 0 = never)
 *      after it finished: off the board's columns and the projects' numbers, which say how many are archived; in the
 *      project's Archive list (newest first, paged, by assignee); found by search ("Archived") and by its number; moving it
 *      to To do reopens it. A view rule only: nothing in the database changes.
 *   3. Deletion is unchanged.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchedulerDb } from "../src/scheduler/db.js";
import { ARCHIVE_AFTER_DAYS, archiveAfterDays, type Actor, type TaskBoard } from "../src/scheduler/task-board.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const DAY = 86_400_000;
const dirs: string[] = [], dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function open(): { board: TaskBoard; db: SchedulerDb } {
  const d = mkdtempSync(join(tmpdir(), "task-board-3668-")); dirs.push(d);
  const db = new SchedulerDb(join(d, "scheduler.db")); dbs.push(db);
  return { board: db.board, db };
}
/** A main task finished `days` ago (done, or cancelled), as the database keeps it. */
function finished(board: TaskBoard, title: string, days: number, opts: { status?: "done" | "cancelled"; assignee?: string; project?: number | null } = {}) {
  const c = board.createCards(ANN, { cards: [{ title, assignee: opts.assignee ?? "dev-a", ...(opts.project ? { project: opts.project } : {}) }] }).cards[0]!;
  board.moveCard(ANN, c.code, opts.status ?? "done", opts.status === "cancelled" ? { reason: "dropped" } : { result: "r" });
  const at = new Date(Date.now() - days * DAY).toISOString();
  (board as any).db.prepare("UPDATE tasks SET done_at = ?, updated_at = ? WHERE code = ?").run(opts.status === "cancelled" ? null : at, at, c.code);
  return board.getCard(c.code);
}

describe("the rule: archived N days after a main task finished (a view rule)", () => {
  it("the setting: whole days 0–3650; anything else is the default 3; the validator says so", () => {
    expect([archiveAfterDays(undefined), archiveAfterDays(0), archiveAfterDays(7), archiveAfterDays(-1), archiveAfterDays(2.5), archiveAfterDays("3"), ARCHIVE_AFTER_DAYS]).toEqual([3, 0, 7, 3, 3, 3, 3]);
    const errs = (v: unknown) => validateFleetConfig({ defaults: { task_board: { archive_after_days: v } }, instances: {} } as never).errors.map((e: any) => e.path ?? e.key ?? String(e));
    expect(JSON.stringify(errs(5))).not.toContain("archive_after_days");
    expect(JSON.stringify(errs(-2))).toContain("archive_after_days");
  });

  it("the board read keeps unfinished cards and those finished in the last N days; archived ones (done or cancelled) are left out", () => {
    const { board } = open();
    const live = board.createCards(ANN, { cards: [{ title: "Live", assignee: "dev-a" }] }).cards[0]!;
    const fresh = finished(board, "Fresh", 1), old = finished(board, "Old", 5), gone = finished(board, "Dropped", 5, { status: "cancelled" });
    const codes = board.boardCards(undefined, false, 3).map((c) => c.code);
    expect(codes).toEqual(expect.arrayContaining([live.code, fresh.code]));
    expect(codes).not.toContain(old.code);
    expect(codes).not.toContain(gone.code);
    // 0 = never: the board reads as before (14 days of finished cards; every done one with `allDone`).
    expect(board.boardCards(undefined, false, 0).map((c) => c.code)).toEqual(expect.arrayContaining([fresh.code, old.code]));
    expect([board.isArchived(old, 3), board.isArchived(fresh, 3), board.isArchived(old, 0), board.isArchived(gone, 3)]).toEqual([true, false, false, true]);
  });

  it("a project's numbers leave archived main tasks out and count them apart; this week counts every main task done in 7 days", () => {
    const { board } = open();
    board.createCards(ANN, { cards: [{ title: "Live", assignee: "dev-a" }] });
    finished(board, "Fresh", 1); finished(board, "Old", 5); finished(board, "Older", 9); finished(board, "Dropped", 6, { status: "cancelled" });
    const st = board.projectStats(undefined, 3).none!;
    expect([st.mains, st.units.total, st.units.done, st.percent, st.archived, st.doneWeek, st.archivedWeek]).toEqual([2, 2, 1, 50, 3, 2, 1]);   // "Old" (5 days): this week's and archived
    // Without archiving (the task tool's view): every card, as before.
    const all = board.projectStats().none!;
    expect([all.mains, all.archived]).toEqual([4, 0]);
  });

  it("moving an archived card to To do reopens it — it is on the board again, nothing was lost", () => {
    const { board } = open();
    const old = finished(board, "Old", 5);
    board.moveCard(ANN, old.code, "open");
    expect(board.isArchived(board.getCard(old.code), 3)).toBe(false);
    expect(board.boardCards(undefined, false, 3).map((c) => c.code)).toContain(old.code);
  });

  it("the Archive list: a project's archived main tasks, newest first, a page at a time, by assignee", () => {
    const { board } = open();
    const p = board.createProject(ANN, { name: "Game" });
    for (let i = 0; i < 5; i++) finished(board, `Done ${i}`, 4 + i, { project: p.id, assignee: i % 2 ? "dev-b" : "dev-a" });
    finished(board, "Elsewhere", 4);                                          // No project
    finished(board, "Recent", 1, { project: p.id });                          // not archived yet
    const first = board.archiveList(p.id, 3, { limit: 2 });
    expect([first.cards.map((c) => c.title), first.total, first.assignees]).toEqual([["Done 0", "Done 1"], 5, ["dev-a", "dev-b"]]);
    const second = board.archiveList(p.id, 3, { limit: 2, before: first.next });
    const third = board.archiveList(p.id, 3, { limit: 2, before: second.next });
    expect([second.cards.map((c) => c.title), third.cards.map((c) => c.title), third.next]).toEqual([["Done 2", "Done 3"], ["Done 4"], null]);
    expect(board.archiveList(p.id, 3, { assignee: "dev-b" }).cards.map((c) => c.title)).toEqual(["Done 1", "Done 3"]);
    expect(board.archiveList(null, 3).cards.map((c) => c.title)).toEqual(["Elsewhere"]);
    expect(board.archiveList(p.id, 0).cards).toEqual([]);
  });
});

// ── The page ──
let p: AppPage;
let app: any, nav: any, fleet: any;
let handler: (path: string) => unknown = () => ({});
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const PROJECT = { id: 1, name: "Leaderboard", description: "", archived: false, sort: 1, createdAt: ago(30) };
const card = (over: Record<string, unknown>) => ({ id: "M-1", uuid: String(over.id ?? "M-1"), kind: "main", projectId: 1, parentId: null, title: "A card", status: "open",
  assignee: "alpha", dispatcher: { kind: "person", name: "Ann" }, waitsForPerson: false, confirmer: null, priority: "normal", size: null, needsReview: true, dependsOn: [], goal: "", scope: "",
  acceptance: [], context: "", state: "", blockedReason: "", result: "", sort: 1, createdBy: "Ann", version: 1, createdAt: ago(10), updatedAt: ago(1), startedAt: null, submittedAt: null,
  doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
// 45 done in the last two days (newest M-100), one open.
const DONE = Array.from({ length: 45 }, (_, i) => card({ id: `M-${100 - i}`, title: `Finished ${100 - i}`, status: "done", sort: 10 + i, doneAt: new Date(NOW - i * 3_600_000).toISOString() }));
const OPEN = card({ id: "M-1", title: "Still to do", status: "open" });
const STATS = { 1: { mains: 46, units: { total: 46, open: 1, claimed: 0, blocked: 0, review: 0, done: 45 }, percent: 98, waiting: 0, blocked: 0, lastActivity: ago(0), archived: 1591, doneWeek: 355, archivedWeek: 310 } };
const ARCHIVED = card({ id: "M-7", title: "Shipped long ago", status: "done", doneAt: ago(12) });

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = async (path: string) => ({ ok: true, status: 200, json: async () => handler(path) });
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  fleet = await import("/ui/js/panel-fleet.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
const seen: string[] = [];
beforeEach(async () => {
  await p.unmount();
  for (const k of ["agend_tasks_project", "agend_tasks_filters", "agend_tasks_display"]) (globalThis as any).localStorage.removeItem(k);
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  seen.length = 0;
  handler = (path) => { seen.push(path);
    return path.startsWith("/ui/tasks/board") ? { rev: 1, projects: [PROJECT], cards: [OPEN, ...DONE], stats: STATS, archiveAfterDays: 3 }
      : path.startsWith("/ui/tasks/archive") ? { cards: [ARCHIVED], next: null, total: 1591, assignees: ["alpha", "beta"], archiveAfterDays: 3 }
      : path.startsWith("/ui/tasks/search") ? { results: [{ card: ARCHIVED, match: null, project: "Leaderboard", parentTitle: null, archived: true }] }
      : path.startsWith("/ui/tasks/cards/M-7") ? { card: ARCHIVED, parent: null, children: [], comments: [], logs: [], history: [], watchers: [], inheritedWatchers: [], leader: null, archived: true, archiveAfterDays: 3 } : {}; };
  app.applyStatus({ uptime: 1, instances: [{ name: "alpha", status: "running", state: "idle", execution_state: "idle" }] });
});
let mounts = 0;
async function board(storage: Record<string, string> = { agend_tasks_project: "1" }) {
  for (const [k, v] of Object.entries(storage)) (globalThis as any).localStorage.setItem(k, v);
  await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|arch-${++mounts}|en` }));
  await settle(8);
}
const q = (sel: string) => p.root.querySelector(sel) as any;
const qa = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
const doneTiles = () => (q('.tb-col[aria-label="Done"]')?.querySelectorAll(".tb-tile") ?? []).map((t: any) => t.getAttribute("data-tile"));

describe("the page: the Done column, the Archive", () => {
  it("the Done column shows its newest 20 and \"Show 20 more\"; its header says this week's 355; the count is every one shown on the board", async () => {
    await board();
    expect(doneTiles()).toEqual(DONE.slice(0, 20).map((c) => c.id));
    const head = q('.tb-col[aria-label="Done"] .tb-col-head');
    // #4428 capture check: the week's count says how many of them are archived (the column shows the rest).
    // Under the column's head, not in it (the head keeps its title and count on one line).
    expect([head.querySelector(".tb-done-week"), q('.tb-col[aria-label="Done"] > .tb-done-week').textContent]).toEqual([null, "355 done this week · 310 archived"]);
    expect(head.querySelector(".tb-count").textContent).toBe("45");
    fire(q(".tb-done-more"), "click"); await settle(4);
    expect(doneTiles()).toHaveLength(40);
    fire(q(".tb-done-more"), "click"); await settle(4);
    expect([doneTiles().length, q(".tb-done-more")]).toEqual([45, null]);
  });

  it("\"Archived · 1591\" opens the project's Archive: newest first, the lead, the filter; a card opens from it", async () => {
    await board();
    const link = q(".tb-archived-link");
    expect(link.textContent).toBe("Archived · 1591");
    fire(link, "click"); await settle(8);
    expect(seen.some((u) => u.startsWith("/ui/tasks/archive?project=1"))).toBe(true);
    const dlg = q(".tb-archive");
    expect(dlg.textContent).toContain("Main tasks finished more than 3 days ago");
    expect(dlg.querySelectorAll(".tb-row").map((r: any) => r.querySelector(".tb-row-main").textContent)).toEqual(["M-7"]);
    expect(dlg.querySelector(".tb-archive-who select")).toBeTruthy();
    fire(dlg.querySelector(".tb-row-title"), "click"); await settle(8);
    expect(new URLSearchParams((globalThis as any).location.search).get("card")).toBe("M-7");
  });

  it("the display menu offers Show / Hidden while archiving (the Archive is \"All\"); the project tile says how many are archived", async () => {
    await board();
    fire(q(".tb-view-menu > button"), "click"); await settle(4);
    const labels = qa(".tb-view-menu .menu-list button").map((b) => b.textContent.trim());
    expect(labels).toEqual(expect.arrayContaining(["Show", "Hidden"]));
    expect(labels).not.toContain("All");
    await p.unmount();
    (globalThis as any).localStorage.removeItem("agend_tasks_project");
    (globalThis as any).history.replaceState(null, "", "/ui/fleet");             // the board put ?tp=1 in the address
    await board({});
    expect(q(".tb-project-archived")?.textContent).toBe("1591 archived");
  });

  it("search marks an archived card (it still opens by its number)", async () => {
    await board({});
    const input = q(".tb-search input");
    input.value = "Shipped"; fire(input, "input"); await settle(4);
    await new Promise((r) => setTimeout(r, 260)); await settle(12);                  // the search box waits 200 ms for typing to stop
    const hit = q(".tb-search-results li");
    expect(hit.textContent).toContain("M-7");
    expect(hit.textContent).toContain("Archived");
  });

  // #4428 review: a same-revision read sends where time had left the board's lines too, so a card archived since is read.
  it("reading the board again after a reconnect sends the revision and the epoch the page has", async () => {
    const live: Record<string, Array<(d: unknown) => void>> = {};
    const before = app.appStore.get().streamOn;
    app.appStore.set({ streamOn: (name: string, fn: (d: unknown) => void) => { (live[name] ??= []).push(fn); return () => {}; } });
    const plain = handler;
    handler = (path) => { const d: any = plain(path); return path.startsWith("/ui/tasks/board") ? { ...d, epoch: "3:12:40:7" } : d; };
    try {
      await board();
      seen.length = 0;
      for (const fn of live.connection ?? []) fn("live");
      await settle(8);
      const reads = seen.filter((s) => s.startsWith("/ui/tasks/board"));
      expect(reads).toEqual([`/ui/tasks/board?rev=1&epoch=${encodeURIComponent("3:12:40:7")}`]);
    } finally { app.appStore.set({ streamOn: before }); }
  });

  // #4428 capture check: with none of this week's archived, the line says only how many; the Archive's rows say when, as
  // a date and time (a rounded "3 days ago" read as contradicting "more than 3 days"), the relative time their tooltip.
  it("this week's line without archived ones; the Archive's finish time is a date and time", async () => {
    const { finishedAt, weekLabel } = await import("/ui/js/fleet-task-archive.js") as any;
    const said = async (v: unknown) => { await p.mount(h("p", null, v)); await settle(2); return [p.root.textContent, p.root.querySelectorAll(".tb-nowrap").length]; };
    expect([await said(weekLabel({ doneWeek: 12, archivedWeek: 0 })), await said(weekLabel({ doneWeek: 12, archivedWeek: 4 }))]).toEqual([["12 done this week", 1], ["12 done this week · 4 archived", 2]]);
    const now = new Date("2026-11-25T00:00:00Z"), at = "2026-11-21T06:05:00Z";
    expect(finishedAt(at, now)).toMatch(/^Nov 21, \d\d:05$/);
    expect(finishedAt("2025-11-21T06:05:00Z", now)).toMatch(/2025/);
    (await import("/assets/app-i18n.js") as any).setLang("zh-TW");
    try {
      expect([(await said(weekLabel({ doneWeek: 12, archivedWeek: 4 })))[0], finishedAt(at, now)]).toEqual(["本週完成 12 張 · 其中 4 張已封存", expect.stringMatching(/^11月21日 \d\d:05$/)]);
    } finally { (await import("/assets/app-i18n.js") as any).setLang("en"); }
    await board();
    fire(q(".tb-archived-link"), "click"); await settle(6);
    const time = q(".tb-archive .tb-row-time");
    expect([time.textContent.startsWith("Done "), /ago/.test(time.textContent), /ago/.test(time.getAttribute("title"))]).toEqual([true, false, true]);
  });
});
