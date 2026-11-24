/**
 * #4428 review (Prism, four P2s on M-3668's archive):
 *   1. The Archive list leaves out a card the reader may not see before it pages: its cursor, its total and its
 *      assignees never tell of one (filtered after paging, they did).
 *   2. A page's "same revision" board read is answered `unchanged` only when time has not moved a card across one of
 *      the board's lines since (archived, this week, the recent window): `boardEpoch()`.
 *   3. An archived main task's sub tasks leave the board with it, even one finished more recently.
 *   4. `defaults.task_board.archive_after_days` has its Settings control (settings parity, decision 4161c668).
 * The web routes' side of 1 and 2 is in tests/task-board-archive-web-m3668.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SchedulerDb } from "../src/scheduler/db.js";
import { TaskBoard, type Actor } from "../src/scheduler/task-board.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const DAY = 86_400_000;
const dirs: string[] = [], dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function open() {
  const d = mkdtempSync(join(tmpdir(), "task-board-4428-")); dirs.push(d);
  const db = new SchedulerDb(join(d, "scheduler.db")); dbs.push(db);
  return { board: db.board, raw: (db.board as any).db as Database.Database, path: join(d, "scheduler.db") };
}
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
/** A main task finished `days` ago, as the database keeps it. */
function finished(board: TaskBoard, title: string, days: number, extra: Record<string, unknown> = {}) {
  const c = board.createCards(ANN, { cards: [{ title, assignee: "dev-a", ...extra }] }).cards[0]!;
  board.moveCard(ANN, c.code, "done", { result: "r" });
  (board as any).db.prepare("UPDATE tasks SET done_at = ?, updated_at = ? WHERE code = ?").run(ago(days), ago(days), c.code);
  return board.getCard(c.code);
}

describe("1. the Archive list leaves out what the reader may not see before it pages", () => {
  it("a hidden instance's card (assigned to, created by or handed out by it) is in no page, cursor, total or assignee list", () => {
    const { board, raw } = open();
    const SPY: Actor = { kind: "instance", name: "spy" };
    // Newest first: a visible one, then each kind of hidden one, then the oldest visible one.
    const newest = finished(board, "Visible newest", 4);
    const toSpy = finished(board, "Assigned to the spy", 5, { assignee: "spy" });
    const bySpy = board.createCards(SPY, { cards: [{ title: "Created by the spy", assignee: "dev-b" }] }).cards[0]!;
    board.moveCard(ANN, bySpy.code, "done", { result: "r" });
    raw.prepare("UPDATE tasks SET done_at = ?, updated_at = ? WHERE code = ?").run(ago(6), ago(6), bySpy.code);
    const fromSpy = finished(board, "Handed out by the spy", 7, { assignee: "dev-c", dispatcher: { kind: "instance", name: "spy" } });
    const oldest = finished(board, "Visible oldest", 8);
    const all = board.archiveList(null, 3, { limit: 1 });
    expect([all.total, all.assignees]).toEqual([5, ["dev-a", "dev-b", "dev-c", "spy"]]);

    const leaveOut = ["spy"];
    const first = board.archiveList(null, 3, { limit: 1, leaveOut });
    expect([first.cards.map((c) => c.code), first.total, first.assignees]).toEqual([[newest.code], 2, ["dev-a"]]);
    // The cursor is the visible card's, and the next page skips every hidden one.
    expect(first.next).toBe(`${newest.doneAt}|${newest.uuid}`);
    const second = board.archiveList(null, 3, { limit: 1, leaveOut, before: first.next });
    expect([second.cards.map((c) => c.code), second.next]).toEqual([[oldest.code], null]);
    const text = JSON.stringify([first, second]);
    for (const c of [toSpy, bySpy, fromSpy]) { expect(text).not.toContain(c.uuid); expect(text).not.toContain(c.code); }
    // Asked for the hidden assignee's (the route never passes it on, but the read alone keeps it out too).
    expect(board.archiveList(null, 3, { assignee: "spy", leaveOut }).total).toBe(0);
  });
});

describe("1b. the board's numbers and epoch leave out what the reader may not see (#4428 review R1)", () => {
  it("projectStats and boardEpoch with leaveOut: a hidden instance's cards (and a hidden main task's sub tasks) count nowhere", () => {
    const { board, raw } = open();
    const shown = finished(board, "Visible", 5);
    const secret = finished(board, "Hidden", 5, { assignee: "spy" });
    const live = board.createCards(ANN, { cards: [{ title: "Hidden live", assignee: "spy" }] }).cards[0]!;
    board.createCards(ANN, { cards: [{ parent: live.code, title: "Its step", assignee: "dev-a" }] });
    raw.prepare("UPDATE tasks SET created_by = 'spy' WHERE code = ?").run(shown.code);       // the visible one, made by the spy: hidden too
    const all = board.projectStats(undefined, 3).none!, seen = board.projectStats(undefined, 3, ["spy"]).none;
    expect([all.archived, all.mains, all.units.total]).toEqual([2, 1, 1]);
    expect(seen).toBeUndefined();                                     // nothing left in No project
    expect([board.boardEpoch(3), board.boardEpoch(3, undefined, ["spy"])]).toEqual(["3:2:0:0", "3:0:0:0"]);
    // Without names, as before.
    expect(board.projectStats(undefined, 3, [])).toEqual(board.projectStats(undefined, 3));
    void secret;
  });
});

describe("2. the board's epoch: what time alone changes in a board read", () => {
  it("moves when a card crosses the archive line, this week's line or the recent window — with no write, the revision unchanged", () => {
    const { path } = open();
    let now = Date.now();
    const board = new TaskBoard(new Database(path), () => new Date(now));
    const c = finished(board, "Shipped", 2);
    const rev = board.revision(), first = board.boardEpoch(3);
    expect(board.boardEpoch(3)).toBe(first);                         // nothing moved
    expect(board.boardEpoch(5)).not.toBe(first);                     // another archive age is another board
    now += 1.5 * DAY;                                                // 3.5 days since it finished: archived
    const archived = board.boardEpoch(3);
    expect([archived === first, board.revision(), board.boardCards(undefined, false, 3).some((x) => x.code === c.code)]).toEqual([false, rev, false]);
    now += 4 * DAY;                                                  // 7.5 days: out of this week's count
    const week = board.boardEpoch(3);
    expect(week).not.toBe(archived);
    now += 7 * DAY;                                                  // 14.5 days: out of the recent window too
    expect(board.boardEpoch(3)).not.toBe(week);
    expect(board.boardEpoch(0)).toMatch(/^0:0:/);                    // never archived: that count stays 0
  });
});

describe("3. an archived main task's sub tasks leave the board with it", () => {
  it("a sub task done after its main task's archive line still goes with the main task; a live main task's stays", () => {
    const { board, raw } = open();
    const main = board.createCards(ANN, { cards: [{ title: "Old main", assignee: "dev-a" }] }).cards[0]!;
    const step = board.createCards(ANN, { cards: [{ parent: main.code, title: "A late step", assignee: "dev-a" }] }).cards[0]!;
    const live = board.createCards(ANN, { cards: [{ title: "Live main", assignee: "dev-a" }] }).cards[0]!;
    const liveStep = board.createCards(ANN, { cards: [{ parent: live.code, title: "Its step", assignee: "dev-a" }] }).cards[0]!;
    // The database as the review found it: the main task finished 4 days ago, its step marked done a day ago.
    raw.prepare("UPDATE tasks SET status = 'done', done_at = ?, updated_at = ? WHERE code = ?").run(ago(4), ago(4), main.code);
    raw.prepare("UPDATE tasks SET status = 'done', done_at = ?, updated_at = ? WHERE code = ?").run(ago(1), ago(1), step.code);
    const codes = board.boardCards(undefined, false, 3).map((c) => c.code);
    expect([codes.includes(main.code), codes.includes(step.code), codes.includes(live.code), codes.includes(liveStep.code)]).toEqual([false, false, true, true]);
    expect(board.isArchived(board.getCard(step.code), 3)).toBe(true);
    // Archiving off: both are on the board, as before.
    const all = board.boardCards(undefined, false, 0).map((c) => c.code);
    expect([all.includes(main.code), all.includes(step.code)]).toEqual([true, true]);
  });
});

describe("4. Settings → Shared agent settings: when finished cards are archived", () => {
  const schema = buildSettingsImpactSchema();
  let p: AppPage, raw: any;
  const sent: Array<{ method: string; path: string; body: any }> = [];
  const realFetch = (globalThis as any).fetch;
  const fleet = (taskBoard?: Record<string, unknown>) => ({
    defaults: { backend: "codex", model: "gpt-5.5", ...(taskBoard ? { task_board: taskBoard } : {}) },
    instances: { "dev-a": { working_directory: "/w/dev" }, general: { working_directory: "/w/g", general_topic: true } },
    channels: [{ id: "main", type: "discord", bot_token_env: "T", group_id: "1" }], web: {},
  });
  const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? "GET";
    if (method !== "GET") sent.push({ method, path, body: init.body ? JSON.parse(init.body) : null });
    const body = (() => {
      if (method !== "GET") return { ok: true };
      if (path === "/api/settings/schema") return schema;
      if (path === "/api/settings/fleet/raw") return raw;
      if (path === "/api/settings/classic") return { defaults: {}, channels: {} };
      if (path === "/api/settings/connections") return [{ id: "main", token_present: true }];
      if (path === "/api/settings/status-emojis") return { keys: [], builtins: { discord: {}, telegram: {} }, telegram_allowed: [], suggestions: [] };
      if (path === "/api/settings/pending") return [];
      if (path === "/api/fleet") return { version: "2.4.0", instances: Object.keys(raw.instances).map((name) => ({ name, status: "running" })) };
      if (path.startsWith("/ui/")) return {};
      return [];
    })();
    return { ok: true, status: 200, json: async () => body };
  };
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19285/settings", storage: { agend_tour_done: "1" } });
    (globalThis as any).fetch = fakeFetch;
    (await import("/assets/app-nav.js")).startRouter(p.window);
  });
  afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
  beforeEach(async () => { raw = fleet(); sent.length = 0; (globalThis as any).confirm = () => true; (await import("/assets/app-i18n.js")).setLang("en"); });
  afterEach(async () => { await p.unmount(); });
  let opened = 0;
  const show = async () => {
    const { SettingsPanel } = await import("/ui/js/panel-settings.js");
    await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "agent-defaults" }, navKey: `settings:agent-defaults|${++opened}` }));
    await settle(14);
  };
  const text = (el: any) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
  const $ = (sel: string): any => p.root.querySelector(sel);
  const type = async (v: string) => { const el = $("#g-archive-days"); el.value = v; fire(el, "input"); await settle(4); };
  const bar = () => $(".s-pending");
  const save = async () => { bar().querySelectorAll("button").find((b: any) => b.textContent === "Save").click(); await settle(12); };
  const written = () => sent.filter((s) => s.path === "/api/settings/fleet/defaults").map((s) => s.body);
  const LIVENESS = { enabled: true, quiet_minutes: 60, prompt_minutes: 10, crash_grace_minutes: 5 };

  it("is drawn in the Advanced drawer after the wake switches: a number of days, 3 unless set, with a line on what it does", async () => {
    await show();
    const card = $("#g-archive");
    expect([!!card, !!card.closest("details"), card.previousElementSibling?.id ?? card.previousSibling?.id]).toEqual([true, true, "g-wakes"]);
    expect(text(card.querySelector(".s-lab label"))).toBe("Archive finished cards after");
    const input = $("#g-archive-days");
    expect([input.getAttribute("type"), input.getAttribute("min"), input.getAttribute("max"), input.value]).toEqual(["number", "0", "3650", "3"]);
    expect(text(card.querySelector(".s-unit"))).toBe("days (0 = never)");
    expect(text(card.querySelector(".s-info"))).toContain("Nothing is deleted. 0 keeps every finished card on the board.");
    expect(card.querySelectorAll(".s-default").length).toBe(1);      // nobody set it: the built-in default
    expect(bar()).toBeNull();
  });

  it("a change is written beside liveness; 0 is written as 0; back to 3 with nothing saved, the key stays absent", async () => {
    await show();
    await type("7");
    await save();
    expect(written()[0].task_board).toEqual({ liveness: LIVENESS, archive_after_days: 7 });
    sent.length = 0;
    await p.unmount(); await show();
    await type("0");
    await save();
    expect(written()[0].task_board).toEqual({ liveness: LIVENESS, archive_after_days: 0 });
    sent.length = 0;
    await p.unmount(); await show();
    await type("5"); await type("3");
    expect(bar()).toBeNull();                                        // back to what is saved: nothing to save
  });

  it("a saved value shows and keeps the other task board keys; put back to 3 it is written (the file had it)", async () => {
    raw = fleet({ archive_after_days: 10, comment_wakes: false });
    await show();
    expect($("#g-archive-days").value).toBe("10");
    expect($("#g-archive").querySelectorAll(".s-default").length).toBe(0);
    await type("3");
    await save();
    expect(written()[0].task_board).toEqual({ archive_after_days: 3, comment_wakes: false, liveness: LIVENESS });
  });

  it("refuses what the server would: a fraction, a negative number, more than 3650, nothing", async () => {
    await show();
    for (const v of ["2.5", "-1", "3651", ""]) {
      await type(v);
      expect([v, $("#g-archive-days").classList.contains("invalid"), text($("#g-archive")), text(bar())])
        .toEqual([v, true, expect.stringContaining("A whole number of days from 0 to 3650."), expect.stringContaining("Fix 1 field(s) to save")]);
    }
    expect(written()).toEqual([]);
  });

  it("繁體中文, and Settings search finds it", async () => {
    (await import("/assets/app-i18n.js")).setLang("zh-TW");
    await show();
    expect([text($("#g-archive .s-lab label")), text($("#g-archive .s-unit"))]).toEqual(["完成的卡片封存於", "天後（0 = 不封存）"]);
    const { searchSettings } = await import("/ui/js/settings-registry.js") as any;
    for (const q of ["archive finished", "封存", "完成的卡片", "archive_after_days"]) {
      const hit = searchSettings(q).find((e: any) => e.id === "defaults.task-archive");
      expect([q, hit?.target, hit?.key]).toEqual([q, "#g-archive-days", "defaults.task_board.archive_after_days"]);
    }
    expect(searchSettings("archive_after_days")[0].id).toBe("defaults.task-archive");
  });
});
