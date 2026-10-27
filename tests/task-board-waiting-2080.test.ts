/**
 * #2080: Waiting for you (待你處理) held 13 cards the person would never handle — agents' own cards in review, each
 * waiting for its own assignee's confirmation (nobody handed it out).
 *   1. The board's views say whom a card waits for: `waitsForPerson` (Needs you's rule: the person's hand-out, in review
 *      needing their confirmation or blocked; a deleted dispatcher falls back to them) and `confirmer` (the instance that
 *      confirms it, null for the person). A project's `waiting` counts only the person's.
 *   2. The page: Waiting for you and its count list only those; an agent's review card says "Waiting for <agent>".
 *   3. An agent's own card cannot sit in review unnoticed: moving it to review when it confirms it itself finishes it
 *      (review would wait for nobody but itself); a main task that went to review by itself (its sub tasks done) wakes
 *      its assignee to confirm it, who then may move it to done.
 *
 * Isolation: every database is a temp file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SchedulerDb } from "../src/scheduler/db.js";
import { TaskBoardError, type Actor, type TaskBoard } from "../src/scheduler/task-board.js";
import { wakeMessage } from "../src/task-board-waker.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const DEV: Actor = { kind: "instance", name: "dev-a" };
const OTHER: Actor = { kind: "instance", name: "dev-b" };
const dirs: string[] = [], dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function open(): TaskBoard {
  const d = mkdtempSync(join(tmpdir(), "task-board-2080-")); dirs.push(d);
  const db = new SchedulerDb(join(d, "scheduler.db")); dbs.push(db);
  return db.board;
}
const make = (board: TaskBoard, actor: Actor, extra: Record<string, unknown> = {}) =>
  board.createCards(actor, { cards: [{ title: "A card", assignee: "dev-a", ...extra }] }).cards[0]!;
function refusal(fn: () => unknown): string {
  try { fn(); } catch (e) { return e instanceof TaskBoardError ? `${e.code}: ${e.message}` : String(e); }
  throw new Error("expected a refusal");
}
function heard(board: TaskBoard) {
  const wakes: Array<{ to: string; code: string; reasons: string[] }> = [];
  board.onChange((c) => { for (const w of c.wakes) wakes.push({ to: w.instance, code: w.code, reasons: w.reasons }); });
  return { take: () => wakes.splice(0) };
}
/** A card in review as it is now: the person's (Ann handed it out), lead's, or dev-a's own (moved there before #2080). */
function inReview(board: TaskBoard, who: Actor | null) {
  const c = who ? make(board, who, { needsReview: true }) : board.createCards(DEV, { cards: [{ title: "Own notes" }] }).cards[0]!;
  board.moveCard(DEV, c.code, "claimed");
  if (who) board.moveCard(DEV, c.code, "review", { result: "r" });
  else board.moveCard(ANN, c.code, "review", { result: "r" });             // a person's move stays as asked
  return board.getCard(c.code);
}

describe("1. whom a card waits for, in the board's views and stats", () => {
  it("the person's review card waits for them; lead's for lead; an agent's own for its assignee — never the person", () => {
    const board = open();
    const ann = inReview(board, ANN), lead = inReview(board, LEAD), own = inReview(board, null);
    expect([ann.status, lead.status, own.status]).toEqual(["review", "review", "review"]);
    const v = Object.fromEntries(board.views([ann, lead, own]).map((x) => [x.id, [x.waitsForPerson, x.confirmer]]));
    expect(v).toEqual({ [ann.code]: [true, null], [lead.code]: [false, "lead"], [own.code]: [false, "dev-a"] });
    expect(board.projectStats().none!.waiting).toBe(1);
  });
  it("blocked: the person's question waits for them; an agent's (its dispatcher's, or its own) does not", () => {
    const board = open();
    const mine = make(board, ANN), lead = make(board, LEAD), own = board.createCards(DEV, { cards: [{ title: "Own", assignee: "dev-a" }] }).cards[0]!;
    for (const c of [mine, lead, own]) { board.moveCard(DEV, c.code, "claimed"); board.moveCard(DEV, c.code, "blocked", { reason: "which one?" }); }
    expect(board.views([mine, lead, own].map((c) => board.getCard(c.code))).map((x) => x.waitsForPerson)).toEqual([true, false, false]);
  });
  it("a dispatcher deleted since: its cards fall back to the person (gone), in the views and the count", () => {
    const board = open();
    const lead = inReview(board, LEAD);
    const gone = (name: string) => name === "lead";
    expect(board.views([lead], {}, gone).map((x) => [x.waitsForPerson, x.confirmer])).toEqual([[true, null]]);
    expect([board.projectStats().none!.waiting, board.projectStats(gone).none!.waiting]).toEqual([0, 1]);
  });
});

describe("3. an agent's own card never sits in review unnoticed", () => {
  it("moving it to review when it confirms it itself finishes it — and says why; the checks for review still hold", () => {
    const board = open();
    const own = board.createCards(DEV, { cards: [{ title: "Own notes" }] }).cards[0]!;
    board.moveCard(DEV, own.code, "claimed");
    expect(refusal(() => board.moveCard(DEV, own.code, "review"))).toMatch(/^invalid: .*result/);
    const r = board.moveCard(DEV, own.code, "review", { result: "written" });
    expect([r.card.status, r.notes.join("\n")]).toEqual(["done", `${own.code} waits for nobody else's confirmation (you confirm it): done, not review`]);
    // One it handed to itself, likewise; even with review asked for.
    const self = board.createCards(DEV, { cards: [{ title: "Self", assignee: "dev-a", dispatcher: { kind: "instance", name: "dev-a" }, needsReview: true }] }).cards[0]!;
    board.moveCard(DEV, self.code, "claimed");
    expect(board.moveCard(DEV, self.code, "review", { result: "r" }).card.status).toBe("done");
  });
  it("the plain update's status review likewise; a card someone else confirms, and a person's move, stay in review", () => {
    const board = open();
    const own = board.createCards(DEV, { cards: [{ title: "Own" }] }).cards[0]!;
    board.moveCard(DEV, own.code, "claimed");
    board.updateCard(DEV, own.code, { result: "r" });
    expect(board.legacyUpdate(DEV, own.uuid, { status: "review" }).status).toBe("done");
    expect(inReview(board, LEAD).status).toBe("review");
    expect(inReview(board, ANN).status).toBe("review");
    expect(inReview(board, null).status).toBe("review");                    // the person moved it there
  });
  it("a main task that went to review by itself (its sub tasks done by another) wakes its assignee, who may finish it; nobody else may", () => {
    const board = open();
    const w = heard(board);
    const main = board.createCards(DEV, { cards: [{ title: "Plan", assignee: "dev-a", needsReview: true }] }).cards[0]!;
    const [s] = board.createCards(DEV, { parent: main.code, cards: [{ title: "Check it", assignee: "dev-b" }] }).cards;
    board.moveCard(OTHER, s!.code, "claimed");
    w.take();
    board.moveCard(OTHER, s!.code, "done", { result: "checked" });
    expect(board.getCard(main.code).status).toBe("review");
    // Its own to confirm — and, with no result yet, the wrap-up reminder too.
    expect(w.take().filter((x) => x.code === main.code)).toEqual([{ to: "dev-a", code: main.code, reasons: ["confirm_own", "wrap_up"] }]);
    expect(refusal(() => board.moveCard(OTHER, main.code, "done"))).toMatch(/^forbidden: /);
    board.updateCard(DEV, main.code, { result: "all checked" });
    expect(board.moveCard(DEV, main.code, "done").card.status).toBe("done");
  });
  it("#2757 review: a derived main task sent back to its own agent finishes with done's checks, through move and the plain update", () => {
    const board = open();
    const sentBack = () => {
      const main = board.createCards(DEV, { cards: [{ title: "Plan", assignee: "dev-a", needsReview: true, acceptance: ["works"] }] }).cards[0]!;
      const [s] = board.createCards(DEV, { parent: main.code, cards: [{ title: "Step", assignee: "dev-a" }] }).cards;
      board.moveCard(DEV, s!.code, "claimed");
      board.moveCard(DEV, s!.code, "done", { result: "r" });
      expect(board.getCard(main.code).status).toBe("review");
      board.moveCard(ANN, main.code, "claimed", { reason: "one more look" });          // the person sends it back
      board.updateCard(DEV, main.code, { result: "looked again" });
      return board.getCard(main.code);
    };
    const a = sentBack();
    expect(refusal(() => board.moveCard(DEV, a.code, "review"))).toBe("invalid: 1 acceptance item(s) unchecked (1); check them, or say why in the reason");
    expect(board.getCard(a.code).status).toBe("claimed");
    board.updateCard(DEV, a.code, { check: [1] });
    expect(board.moveCard(DEV, a.code, "review").card.status).toBe("done");
    const b = sentBack();
    expect(() => board.legacyUpdate(DEV, b.uuid, { status: "review" })).toThrow(/acceptance item\(s\) unchecked/);
    board.updateCard(DEV, b.code, { check: [1] });
    expect(board.legacyUpdate(DEV, b.uuid, { status: "review" }).status).toBe("done");
  });
  it("no confirm_own for the person's main task: it is theirs to confirm (Needs you)", () => {
    const board = open();
    const w = heard(board);
    const main = make(board, ANN, { needsReview: true });
    const [s] = board.createCards(DEV, { parent: main.code, cards: [{ title: "Step", assignee: "dev-b" }] }).cards;
    board.moveCard(OTHER, s!.code, "claimed");
    w.take();
    board.moveCard(OTHER, s!.code, "done", { result: "r" });
    expect(board.getCard(main.code).status).toBe("review");
    expect(w.take().filter((x) => x.code === main.code).flatMap((x) => x.reasons)).not.toContain("confirm_own");
  });
  it("no confirm_own for a card someone else confirms: lead's hears to_confirm, as before", () => {
    const board = open();
    const w = heard(board);
    const main = make(board, LEAD, { needsReview: true });
    const [s] = board.createCards(DEV, { parent: main.code, cards: [{ title: "Step", assignee: "dev-a" }] }).cards;
    board.moveCard(DEV, s!.code, "claimed");
    w.take();
    board.moveCard(DEV, s!.code, "done", { result: "r" });
    const onMain = w.take().filter((x) => x.code === main.code);
    expect(onMain.some((x) => x.reasons.includes("confirm_own"))).toBe(false);
    expect(onMain.find((x) => x.to === "lead")?.reasons).toContain("to_confirm");
  });
  it("the wake says it is theirs to confirm; a wrap-up of an agent's own card says review, not the person", () => {
    const wake = { instance: "dev-a", uuid: "u", code: "M-1", title: "Plan", parent: null, reasons: ["confirm_own"], by: { confirm_own: "dev-b" }, texts: {} } as never;
    expect(wakeMessage([wake])).toBe('[Task board] M-1 "Plan": it is in review and nobody else confirms it — it is yours: check it, then move it to done. Read it with: task get M-1');
    const card = { kind: "main", acceptance: [], result: "", dispatcher: null } as never;
    const wrap = { ...(wake as object), reasons: ["wrap_up"], by: { wrap_up: "dev-b" } } as never;
    expect(wakeMessage([wrap], () => card)).toContain("it went to review by itself, but");
    expect(wakeMessage([wrap], () => ({ ...(card as object), dispatcher: { kind: "person", name: "Ann" } }) as never)).toContain("it went to the person for confirmation by itself");
  });
});

// ── 2. The page ──

let p: AppPage, app: any, nav: any, fleet: any, I: any;
let handler: (path: string) => unknown = () => ({});
const PROJECT = { id: 1, name: "Leaderboard", description: "", archived: false, sort: 1, createdAt: "2026-10-20T00:00:00.000Z" };
const view = (over: Record<string, unknown>) => ({ id: "M-1", uuid: "u1", kind: "main", projectId: 1, parentId: null, title: "A card", status: "review",
  assignee: "alpha", dispatcher: null, waitsForPerson: false, confirmer: "alpha", priority: "normal", size: null, needsReview: false, dependsOn: [], goal: "", scope: "",
  acceptance: [], context: "", state: "", blockedReason: "", result: "r", sort: 1, createdBy: "alpha", version: 3, createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z", startedAt: null, submittedAt: null, doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 },
  unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const CARDS = [
  view({ id: "M-1", uuid: "u1", title: "Agent's own review" }),
  view({ id: "M-2", uuid: "u2", title: "Lead's review", dispatcher: { kind: "instance", name: "lead" }, confirmer: "lead", needsReview: true }),
  view({ id: "M-3", uuid: "u3", title: "Your review", dispatcher: { kind: "person", name: "Ann" }, waitsForPerson: true, confirmer: null, needsReview: true }),
  view({ id: "M-4", uuid: "u4", title: "Agent blocked", status: "blocked", blockedReason: "which?", dispatcher: { kind: "instance", name: "lead" }, confirmer: "lead" }),
  view({ id: "M-5", uuid: "u5", title: "Your question", status: "blocked", blockedReason: "ranked only?", dispatcher: { kind: "person", name: "Ann" }, waitsForPerson: true, confirmer: null }),
];
const STATS = { 1: { mains: 5, waiting: 1, blocked: 2, percent: 0, units: { total: 5, open: 0, claimed: 0, blocked: 2, review: 3, done: 0 }, lastActivity: "2026-10-20T00:00:00.000Z" } };

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = async (path: string) => { const body: any = await handler(path); return { ok: true, status: 200, json: async () => body }; };
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  fleet = await import("/ui/js/panel-fleet.js");
  I = await import("/assets/app-i18n.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  (globalThis as any).localStorage.removeItem("agend_tasks_project");
  handler = (path) => (path.startsWith("/ui/tasks/board") ? { rev: 1, projects: [PROJECT], cards: CARDS, stats: STATS } : {});
  app.applyStatus({ uptime: 1, instances: [{ name: "alpha", status: "running", state: "idle", execution_state: "idle" }, { name: "lead", status: "running", state: "idle", execution_state: "idle" }] });
});
const mount = async (key: string) => { await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|${key}|en` })); await settle(8); };

describe("2. the page", () => {
  it("Waiting for you lists only the person's: their review and their question; an agent's review or block is not there", async () => {
    await mount("waiting");
    const rows = p.root.querySelectorAll(".tb-wait-row .tb-code").map((e: any) => e.textContent);
    expect(rows).toEqual(["M-3", "M-5"]);
    expect(p.root.querySelector(".tb-project .tb-flag.st-review").textContent).toBe("1 waiting for you");    // the host's count
  });
  it("nothing of the person's: no Waiting for you at all, however many agents' cards are in review", async () => {
    handler = (path) => (path.startsWith("/ui/tasks/board") ? { rev: 1, projects: [PROJECT], cards: CARDS.filter((c) => !c.waitsForPerson), stats: { 1: { ...STATS[1], waiting: 0 } } } : {});
    await mount("none");
    expect([p.root.querySelector(".tb-waiting"), p.root.querySelector(".tb-project .tb-flag.st-review")]).toEqual([null, null]);
  });
  it("in the project, a review card says whom it waits for: the agent that confirms it, or you", async () => {
    await mount("tiles");
    p.root.querySelector(".tb-project-open").click(); await settle(8);
    const waits = Object.fromEntries(p.root.querySelectorAll(".tb-tile").map((tile: any) => [tile.querySelector(".tb-code")?.textContent, tile.querySelector(".tb-tile-waits")?.textContent ?? null]));
    expect([waits["M-1"], waits["M-2"], waits["M-3"], waits["M-4"]]).toEqual(["Waiting for alpha", "Waiting for lead", "Waiting for you", null]);
    expect(p.root.querySelectorAll(".tb-tile-waits.you")).toHaveLength(1);
  });
  it("the status pill with its card: an agent's review names the agent (with a tip); the person's says you; the column is To confirm", async () => {
    const C = await import("/ui/js/fleet-task-common.js") as any;
    await p.mount(h("div", {}, h(C.StatusPill, { status: "review", card: CARDS[1] }), h(C.StatusPill, { status: "review", card: CARDS[2] }), h(C.StatusPill, { status: "review" })));
    await settle(2);
    const pills = p.root.querySelectorAll(".tb-pill");
    expect(pills.map((e: any) => [e.textContent, e.className, e.getAttribute("title") || null])).toEqual([
      ["Waiting for lead", "tb-pill st-review by-agent", "lead confirms it, not you"], ["Waiting for you", "tb-pill st-review", null], ["To confirm", "tb-pill st-review", null]]);
    expect(C.projectStats(1, CARDS).waiting).toBe(1);                                                        // the page's own count, when it counts
    expect(C.waitsForYou({ status: "review", needsReview: true, dispatcher: { kind: "person", name: "Ann" } })).toBe(true);   // read without the host's word
    // The host's word wins: a dispatcher deleted since (the person's now), the person's card with its review switched off.
    expect(C.waitsForYou({ status: "review", needsReview: true, dispatcher: { kind: "instance", name: "gone" }, waitsForPerson: true })).toBe(true);
    expect(C.waitsForYou({ status: "review", needsReview: true, dispatcher: { kind: "person", name: "Ann" }, waitsForPerson: false })).toBe(false);
    expect(C.waitsForYou({ status: "review", needsReview: true, dispatcher: null })).toBe(false);
    expect(C.waitsForYou({ status: "blocked", needsReview: false, dispatcher: { kind: "person", name: "Ann" } })).toBe(true);
  });
  it("its words in both languages", () => {
    I.setLang("zh-TW", { store: false });
    try { expect([I.t("tasks.reviewYou"), I.t("tasks.reviewBy", "lead"), I.t("tasks.reviewByTip", "lead"), I.t("tasks.review")]).toEqual(["等你確認", "等 lead 確認", "由 lead 確認，不是你", "待確認"]); }
    finally { I.setLang("en", { store: false }); }
    expect([I.t("tasks.reviewYou"), I.t("tasks.reviewBy", "lead"), I.t("tasks.review"), I.t("tasks.workReview")]).toEqual(["Waiting for you", "Waiting for lead", "To confirm", "To confirm"]);
  });
});
