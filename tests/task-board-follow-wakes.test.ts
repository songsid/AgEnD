/**
 * Following a card: the instance that handed a card out, the
 * instances that watch it and the leader of its project hear when it is finished, waits for confirmation, is sent back,
 * is blocked or changes hands. The rules, each tested here:
 *
 *   1. Who hears what: the dispatcher; the person's own cards tell nobody; what is not progress; never the one who did it.
 *   2. The leader: a project's lead, else the board's (`defaults.task_board.leader`); not its own assignee; sub tasks.
 *   3. Watchers: who may set them, what is refused, a main task's follow its sub tasks, no new version, one wake each.
 *   4. The loop guard: agents changing one card back and forth tell nobody after a few changes; a person lifts it.
 *   5. The switch (`defaults.task_board.progress_wakes`) and the notice's words and delivery.
 *   6. The `task` tool (watch / unwatch) and the dashboard's route.
 *   7. Compatibility: an upgrade tells nothing about the past; the watchers table is additive and goes with its card.
 *
 * Isolation: temp databases; a simulated clock for the waker's 10 s window (its timers seam); fake system time for the
 * guard's window; a FleetManager with no fleet (nothing starts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerDb } from "../src/scheduler/db.js";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";
import { AGENT_COMMENT_WINDOW_MS, AGENT_PROGRESS_CHAIN, MAX_WATCHERS, TaskBoardError, type Actor, type TaskBoard, type Wake } from "../src/scheduler/task-board.js";
import { TaskBoardWaker, wakeMessage } from "../src/task-board-waker.js";
import { boardLeader, boardProgressWakesOn, boardToolAction } from "../src/task-board-tool.js";
import { validateFleetConfig } from "../src/config-validator.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const DEV: Actor = { kind: "instance", name: "dev-a" };
const DEV_B: Actor = { kind: "instance", name: "dev-b" };
const OPS: Actor = { kind: "instance", name: "ops" };

const dirs: string[] = [];
const dbs: SchedulerDb[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix = "task-board-follow-") => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

/** The fleet in these tests: lead, dev-a, dev-b, ops, and `quiet`, which has the task board off. */
const INSTANCES = ["lead", "dev-a", "dev-b", "ops", "quiet"];

interface Rig {
  db: SchedulerDb; board: TaskBoard; path: string; projectId: number;
  heard: Wake[]; take: () => Wake[];
  /** `defaults.task_board.progress_wakes` and `.leader`, as the fleet reads them. */
  on: { value: boolean }; leader: { value: string | null };
}
function rig(path = join(tmp(), "scheduler.db"), instances: string[] = INSTANCES): Rig {
  const db = new SchedulerDb(path); dbs.push(db);
  const board = db.board;
  const on = { value: true }, leader = { value: null as string | null };
  board.setBoardOff((n) => n === "quiet");
  board.setCommentRouting({ instances: () => instances, enabled: () => true });
  board.setProgressRouting({ enabled: () => on.value, leader: () => leader.value });
  const project = board.listProjects(true)[0] ?? board.createProject(ANN, { name: "Game" });
  const heard: Wake[] = [];
  board.onChange((c) => { heard.push(...c.wakes); });
  return { db, board, path, projectId: project.id, heard, take: () => heard.splice(0), on, leader };
}
/** A card in the project "Game"; unless it says otherwise it needs no review (so a finish is `done`). */
const card = (board: TaskBoard, by: Actor, extra: Record<string, unknown> = {}) =>
  board.createCards(by, { project: "Game", cards: [{ title: "Build the leaderboard", needsReview: false, ...extra }] }).cards[0]!;
/** What the wakes say, short: `lead:progress/done/dispatcher`, `dev-a:sent_back`. Sorted, so the order of instances does not matter. */
const brief = (wakes: Wake[]) => wakes.map((w) => `${w.instance}:${w.reasons.join("+")}${w.news ? `/${w.news.kind}/${w.news.as}` : ""}`).sort();
const noteKeys = (r: { said: Array<{ key: string }> }) => r.said.map((n) => n.key);

describe("1. who hears what", () => {
  it("a card an instance handed out: its dispatcher hears it was finished, with who did it and the result; the one who did it hears nothing", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.moveCard(DEV, c.code, "claimed");
    take();
    board.moveCard(DEV, c.code, "done", { result: "ranked by score, ties by time" });
    const heard = take();
    expect(brief(heard)).toEqual(["lead:progress/done/dispatcher"]);
    expect(heard[0]).toMatchObject({ code: c.code, title: "Build the leaderboard", by: { progress: "dev-a" }, texts: { progress: "ranked by score, ties by time" }, news: { kind: "done", as: "dispatcher" } });
  });

  it("in review: the dispatcher who confirms it hears `to_confirm` (as before), not progress as well; the person's confirmation then tells it `done`", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a", needsReview: true });
    board.moveCard(DEV, c.code, "claimed");
    take();
    board.moveCard(DEV, c.code, "review", { result: "done, please check" });
    expect(brief(take())).toEqual(["lead:to_confirm"]);
    board.moveCard(ANN, c.code, "done");
    const heard = take();
    expect(brief(heard)).toEqual(["lead:progress/done/dispatcher"]);
    expect(heard[0]!.by.progress).toBe("Ann");
  });

  it("sent back: the assignee hears it as before, and its dispatcher hears who sent it back and why", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a", needsReview: true });
    board.moveCard(DEV, c.code, "claimed");
    board.moveCard(DEV, c.code, "review", { result: "r" });
    take();
    board.moveCard(ANN, c.code, "claimed", { reason: "ties are not ordered" });
    const heard = take();
    expect(brief(heard)).toEqual(["dev-a:sent_back", "lead:progress/sent_back/dispatcher"]);
    expect(heard.find((w) => w.instance === "lead")!.texts.progress).toBe("ties are not ordered");
  });

  it("blocked: an instance's block is the dispatcher's question to answer (`decide`, as before); the person's block is progress to it", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.moveCard(DEV, c.code, "claimed");
    take();
    board.moveCard(DEV, c.code, "blocked", { reason: "codes or messages?" });
    expect(brief(take())).toEqual(["lead:decide"]);
    board.moveCard(LEAD, c.code, "claimed", { comment: "codes" });
    take();
    board.moveCard(ANN, c.code, "blocked", { reason: "waiting for the art" });
    const heard = take();
    expect(brief(heard)).toEqual(["lead:progress/blocked/dispatcher"]);
    expect(heard[0]!.texts.progress).toBe("waiting for the art");
  });

  it("handed to someone else: the dispatcher hears who has it now and who had it; the new assignee hears its assignment, the old one nothing new", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    take();
    board.updateCard(ANN, c.code, { assignee: "dev-b" });
    const heard = take();
    expect(brief(heard)).toEqual(["dev-b:assigned", "lead:progress/reassigned/dispatcher"]);
    expect(heard.find((w) => w.instance === "lead")!.news).toEqual({ kind: "reassigned", as: "dispatcher", assignee: "dev-b", from: "dev-a" });
    // Taken off everybody: told as well.
    board.updateCard(ANN, c.code, { assignee: null });
    expect(take().map((w) => w.news)).toEqual([{ kind: "reassigned", as: "dispatcher", assignee: null, from: "dev-b" }]);
  });

  it("what is not progress tells followers nothing: a start, a comment, an edit, a reorder, a log line, a cancel", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    take();
    board.moveCard(ANN, c.code, "claimed");
    board.updateCard(ANN, c.code, { comment: "go on", state: "next: tests", log: "started" });
    board.updateCard(ANN, c.code, { title: "Build the board" });
    board.moveCard(ANN, c.code, "cancelled", { reason: "dropped" });
    expect(brief(take())).toEqual(["dev-a:cancelled", "dev-a:comment", "dev-a:start"]);   // the assignee's own news, as before; no follower's
  });

  it("a card a person opened has no instance to tell: nobody hears it was finished — until a leader or a watcher is set", () => {
    const { board, take, leader } = rig();
    const c = card(board, ANN, { assignee: "dev-a" });
    board.moveCard(DEV, c.code, "claimed");
    take();
    board.moveCard(DEV, c.code, "done", { result: "r" });
    expect(take()).toEqual([]);
    leader.value = "ops";
    const d = card(board, ANN, { assignee: "dev-a" });
    board.moveCard(DEV, d.code, "claimed");
    take();
    board.moveCard(DEV, d.code, "done", { result: "r" });
    expect(brief(take())).toEqual(["ops:progress/done/leader"]);
  });

  it("an instance handing out work to itself has no dispatcher: it is its own business, as before", () => {
    const { board, take } = rig();
    const c = card(board, DEV, { assignee: "dev-a" });
    board.moveCard(DEV, c.code, "claimed");
    board.moveCard(DEV, c.code, "done", { result: "r" });
    expect(take()).toEqual([]);
  });

  it("the card the `task` tool opened for itself (not on the board) tells no follower, even with a leader set", () => {
    const { db, board, take, leader } = rig();
    leader.value = "ops";
    const t = db.createTask({ title: "Plain", created_by: "lead", assignee: "dev-a" }, LEAD);
    db.claimTask(t.id, "dev-a", DEV);
    db.completeTask(t.id, "ok", DEV);
    expect(take()).toEqual([]);
    expect(board.findCard(t.id)).toBeDefined();
  });

  it("an instance that is its card's dispatcher and its assignee hears nothing of itself", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a", dispatcher: { kind: "instance", name: "dev-a" } });
    board.moveCard(DEV, c.code, "claimed");
    take();
    board.moveCard(ANN, c.code, "blocked", { reason: "x" });
    expect(take()).toEqual([]);
  });

  it("a finished card still tells its news (done is finished), and a news that no longer stands is dropped as it goes out", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a", needsReview: true });
    board.moveCard(DEV, c.code, "claimed");
    board.moveCard(DEV, c.code, "review", { result: "r" });
    board.moveCard(ANN, c.code, "done");
    const done = take().find((w) => w.news?.kind === "done")!;
    expect(board.wakeHolds(done)).not.toBeNull();
    board.moveCard(ANN, c.code, "claimed", { reason: "reopened" });
    expect(board.wakeHolds(done)).toBeNull();
  });
});

describe("2. the leader: a project's lead, else the board's", () => {
  it("a project's lead follows every card of the project; its own change and its own cards are not told to it", () => {
    const { board, take, projectId } = rig();
    board.updateProject(ANN, projectId, { leadInstance: "ops" });
    const c = card(board, ANN, { assignee: "dev-a" });
    board.moveCard(DEV, c.code, "claimed");
    take();
    board.moveCard(DEV, c.code, "done", { result: "r" });
    expect(brief(take())).toEqual(["ops:progress/done/leader"]);
    // The lead's own change tells the lead nothing; its own card has its own news.
    const d = card(board, OPS, { assignee: "dev-a" });
    take();
    board.updateCard(OPS, d.code, { assignee: "dev-b" });
    expect(brief(take())).toEqual(["dev-b:assigned"]);
    const mine = card(board, ANN, { assignee: "ops" });
    board.moveCard(OPS, mine.code, "claimed");
    take();
    board.moveCard(ANN, mine.code, "blocked", { reason: "x" });
    expect(take()).toEqual([]);
  });

  it("the board's leader follows the cards whose project has no lead, and those in no project; a project's own lead outranks it", () => {
    const { board, take, leader, projectId } = rig();
    leader.value = "lead";
    const none = board.createCards(ANN, { cards: [{ title: "No project", assignee: "dev-a", needsReview: false }] }).cards[0]!;
    board.moveCard(DEV, none.code, "claimed");
    take();
    board.moveCard(DEV, none.code, "done", { result: "r" });
    expect(brief(take())).toEqual(["lead:progress/done/leader"]);
    board.updateProject(ANN, projectId, { leadInstance: "ops" });
    const c = card(board, ANN, { assignee: "dev-a" });
    board.moveCard(DEV, c.code, "claimed");
    take();
    board.moveCard(DEV, c.code, "done", { result: "r" });
    expect(brief(take())).toEqual(["ops:progress/done/leader"]);
  });

  it("a sub task is followed by its project's leader and its main task's watchers, and takes its main task's dispatcher", () => {
    const { board, take, projectId } = rig();
    board.updateProject(ANN, projectId, { leadInstance: "ops" });
    const main = card(board, LEAD, { assignee: "dev-a" });
    board.setWatchers(ANN, main.code, { add: ["dev-b"] });
    const sub = board.createCards(LEAD, { cards: [{ parent: main.code, title: "Sort", assignee: "dev-a" }] }).cards[0]!;
    take();
    board.moveCard(DEV, sub.code, "claimed");
    take();
    board.moveCard(DEV, sub.code, "done", { result: "sorted" });
    expect(brief(take().filter((w) => w.code === sub.code))).toEqual(["dev-b:progress/done/watcher", "lead:progress/done/dispatcher", "ops:progress/done/leader"]);
  });

  it("a leader that is not a fleet instance, or has the task board off, is told nothing; no leader set: nobody", () => {
    const { board, take, leader } = rig();
    for (const name of ["nobody", "quiet", null]) {
      leader.value = name;
      const c = card(board, ANN, { assignee: "dev-a" });
      board.moveCard(DEV, c.code, "claimed");
      take();
      board.moveCard(DEV, c.code, "done", { result: "r" });
      expect(take(), String(name)).toEqual([]);
    }
  });
});

describe("3. watchers", () => {
  it("the person sets them; the card's history says who and what, as names a reader can check; the card keeps its version (a page editing it is not told it conflicts)", () => {
    const { board, projectId } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    const revision = board.revision();
    const r = board.setWatchers(ANN, c.code, { add: ["ops", "dev-b", "ops"] });
    expect(r.watchers).toEqual(["ops", "dev-b"]);
    expect(board.getCard(c.code).version).toBe(c.version);
    expect(board.revision()).toBeGreaterThan(revision);
    expect(board.detail(c.code).watchers).toEqual(["ops", "dev-b"]);
    const watched = () => board.detail(c.code).history.filter((e) => e.type === "logged").map((e) => [e.actor, e.data]);
    expect(watched()).toEqual([["Ann", { text: "watchers: +ops, +dev-b", watchers: { added: ["ops", "dev-b"], removed: [] } }]]);
    board.setWatchers(ANN, c.code, { remove: ["ops"] });
    expect(board.detail(c.code).watchers).toEqual(["dev-b"]);
    expect(watched().slice(-1)).toEqual([["Ann", { text: "watchers: -ops", watchers: { added: [], removed: ["ops"] } }]]);
    // No log entry and no comment: an entry's text is shown and searched by every reader, so the names stay in the event.
    expect(board.detail(c.code).logs).toEqual([]);
    expect(board.search("ops").filter((h) => h.card.uuid === c.uuid)).toEqual([]);
    expect(projectId).toBeGreaterThan(0);
  });

  it("a watcher is told what the dispatcher is told; one that is also the dispatcher or the leader is told once, as the dispatcher", () => {
    const { board, take, leader } = rig();
    leader.value = "ops";
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.setWatchers(ANN, c.code, { add: ["lead", "ops", "dev-b"] });
    board.moveCard(DEV, c.code, "claimed");
    take();
    board.moveCard(DEV, c.code, "done", { result: "r" });
    expect(brief(take())).toEqual(["dev-b:progress/done/watcher", "lead:progress/done/dispatcher", "ops:progress/done/watcher"]);
  });

  it("an instance watches or stops watching itself on any board card; for another it needs the right to edit the card", () => {
    const { board } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    expect(board.setWatchers(DEV_B, c.code, { add: ["dev-b"] }).watchers).toEqual(["dev-b"]);
    expect(() => board.setWatchers(DEV_B, c.code, { add: ["ops"] })).toThrowError(/you can only watch or stop watching it yourself/);
    // Its dispatcher, its assignee and its creator may; an unassigned card is anyone's.
    expect(board.setWatchers(LEAD, c.code, { add: ["ops"] }).watchers).toEqual(["dev-b", "ops"]);
    expect(board.setWatchers(DEV, c.code, { remove: ["ops"] }).watchers).toEqual(["dev-b"]);
    expect(board.setWatchers(DEV_B, c.code, { remove: ["dev-b"] }).watchers).toEqual([]);
    const free = card(board, LEAD, { assignee: "dev-a" });
    board.updateCard(ANN, free.code, { assignee: null });
    expect(board.setWatchers(DEV_B, free.code, { add: ["ops"] }).watchers).toEqual(["ops"]);
  });

  it("refusals: a name that is no instance, one with the task board off, too many, a card that is not on the board; nothing is changed", () => {
    const names = ["lead", "dev-a", "dev-b", "ops", ...Array.from({ length: MAX_WATCHERS }, (_, i) => `w${i}`)];
    const { board, db } = rig(join(tmp(), "scheduler.db"), names);
    const c = card(board, LEAD, { assignee: "dev-a" });
    const refused = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof TaskBoardError ? `${e.code}:${e.key}` : String(e); } return "allowed"; };
    expect(refused(() => board.setWatchers(ANN, c.code, { add: ["ghost"] }))).toBe("invalid:watcher_unknown");
    expect(refused(() => board.setWatchers(ANN, c.code, { add: ["quiet"] }))).toBe("invalid:watcher_unknown");     // not in this fleet's list
    expect(refused(() => board.setWatchers(ANN, c.code, { add: ["ops", "ghost"] }))).toBe("invalid:watcher_unknown");
    expect(board.detail(c.code).watchers).toEqual([]);
    board.setCommentRouting({ instances: () => [...names, "quiet"], enabled: () => true });
    expect(refused(() => board.setWatchers(ANN, c.code, { add: ["quiet"] }))).toBe("forbidden:watcher_board_off");
    board.setWatchers(ANN, c.code, { add: names.slice(4, 4 + MAX_WATCHERS) });
    expect(refused(() => board.setWatchers(ANN, c.code, { add: ["ops"] }))).toBe("invalid:watchers_max");
    expect(board.detail(c.code).watchers).toHaveLength(MAX_WATCHERS);
    const plain = db.createTask({ title: "Plain", created_by: "lead", assignee: "dev-a" }, LEAD);
    expect(refused(() => board.setWatchers(ANN, plain.id, { add: ["ops"] }))).toBe("invalid:watch_not_board");
  });

  it("an instance that has left the fleet can still be removed; adding one twice or removing one that is not there changes nothing", () => {
    const names = ["lead", "dev-a", "ops"];
    const { board } = rig(join(tmp(), "scheduler.db"), names);
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.setWatchers(ANN, c.code, { add: ["ops"] });
    const events = () => board.detail(c.code).history.length;
    const before = events();
    expect(noteKeys(board.setWatchers(ANN, c.code, { add: ["ops"] }))).toEqual(["no_change"]);
    expect(noteKeys(board.setWatchers(ANN, c.code, { remove: ["dev-b"] }))).toEqual(["no_change"]);
    expect(events()).toBe(before);
    board.setCommentRouting({ instances: () => ["lead", "dev-a"], enabled: () => true });     // ops left the fleet
    expect(board.setWatchers(ANN, c.code, { remove: ["ops"] }).watchers).toEqual([]);
  });

  it("a watcher that was removed meanwhile (before the notice goes out) is not told", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.setWatchers(ANN, c.code, { add: ["dev-b"] });
    board.moveCard(DEV, c.code, "claimed");
    take();
    board.moveCard(DEV, c.code, "done", { result: "r" });
    const [mine] = take().filter((w) => w.instance === "dev-b");
    expect(board.wakeHolds(mine!)).not.toBeNull();
    board.setWatchers(ANN, c.code, { remove: ["dev-b"] });
    expect(board.wakeHolds(mine!)).toBeNull();
  });
});

describe("4. the loop guard", () => {
  /**
   * The real cycle: dev-a hands the card in for review, lead (its dispatcher) sends it back, and again — each a progress
   * change by an agent, and ops, who watches the card, hears every one until the guard stops it. (lead's and dev-a's own
   * notices — to confirm, sent back — are the board's old rules and are not held by it.)
   */
  function cycle() {
    const r = rig();
    const c = card(r.board, LEAD, { assignee: "dev-a", needsReview: true });
    r.board.setWatchers(ANN, c.code, { add: ["ops"] });
    r.board.moveCard(DEV, c.code, "claimed");
    r.take();
    return { ...r, c };
  }
  /** The n-th change (1-based): an odd one is dev-a's review, an even one lead's send-back. */
  const step = (r: ReturnType<typeof cycle>, n: number) => n % 2
    ? r.board.moveCard(DEV, r.c.code, "review", { result: `r${n}` })
    : r.board.moveCard(LEAD, r.c.code, "claimed", { reason: `again ${n}` });
  const followers = (wakes: Wake[]) => wakes.filter((w) => w.reasons.includes("progress")).map((w) => w.instance);

  it(`agents changing one card back and forth tell its followers for ${AGENT_PROGRESS_CHAIN} changes, then nobody; the writer is told why`, () => {
    const r = cycle();
    const told: string[][] = [];
    for (let n = 1; n <= AGENT_PROGRESS_CHAIN + 2; n++) {
      const res = step(r, n);
      told.push(followers(r.take()));
      if (n <= AGENT_PROGRESS_CHAIN) expect(noteKeys(res), `change ${n}`).toContain("progress_wakes");
      else expect(noteKeys(res), `change ${n}`).toContain("progress_chain");
    }
    expect(told.slice(0, AGENT_PROGRESS_CHAIN)).toEqual(Array.from({ length: AGENT_PROGRESS_CHAIN }, () => ["ops"]));
    expect(told.slice(AGENT_PROGRESS_CHAIN)).toEqual([[], []]);
  });

  it("only followers are held: the dispatcher's and the assignee's own notices (to confirm, sent back) still go, and nothing is refused", () => {
    const r = cycle();
    for (let n = 1; n <= AGENT_PROGRESS_CHAIN; n++) step(r, n);
    r.take();
    step(r, AGENT_PROGRESS_CHAIN + 1);
    expect(brief(r.take())).toEqual(["lead:to_confirm"]);
    step(r, AGENT_PROGRESS_CHAIN + 2);
    expect(brief(r.take())).toEqual(["dev-a:sent_back"]);
    expect(r.board.getCard(r.c.code).status).toBe("claimed");
  });

  it("an agent's many log lines and comments on the card do not push its progress changes out of the count", () => {
    const r = cycle();
    for (let n = 1; n <= 2; n++) step(r, n);
    // far more than the window's rows: log lines and comments by agents between the early changes and the late ones
    for (let i = 0; i < 230; i++) r.board.updateCard(DEV, r.c.code, i % 2 ? { log: `step ${i}` } : { state: `done ${i}` });
    for (let i = 0; i < 20; i++) r.board.updateCard(LEAD, r.c.code, { comment: `note ${i}` });
    r.take();
    const told: string[][] = [];
    for (let n = 3; n <= AGENT_PROGRESS_CHAIN + 1; n++) { step(r, n); told.push(followers(r.take())); }
    expect(told.slice(0, -1).every((t) => t.length === 1)).toBe(true);
    expect(told.at(-1), "the 7th agent change, whatever came between").toEqual([]);
  });

  it("a person touching the card lifts it: the agents' count starts again", () => {
    const r = cycle();
    for (let n = 1; n <= AGENT_PROGRESS_CHAIN + 1; n++) step(r, n);       // the last one (a review) is past the limit
    r.take();
    step(r, AGENT_PROGRESS_CHAIN + 2);
    expect(followers(r.take())).toEqual([]);
    r.board.updateCard(ANN, r.c.code, { comment: "stop it, both of you" });
    r.take();
    const res = step(r, AGENT_PROGRESS_CHAIN + 3);
    expect(followers(r.take())).toEqual(["ops"]);
    expect(noteKeys(res)).toContain("progress_wakes");
  });

  it("a person's own changes are never limited", () => {
    const r = cycle();
    for (let i = 0; i < AGENT_PROGRESS_CHAIN * 2; i++) {
      r.board.moveCard(ANN, r.c.code, "blocked", { reason: `q${i}` });
      expect(followers(r.take()).sort(), `block ${i}`).toEqual(["lead", "ops"]);       // the dispatcher and the watcher, every time
      r.board.moveCard(ANN, r.c.code, "claimed", { comment: "go on" });
      r.take();
    }
  });

  it(`it counts only the last ${AGENT_COMMENT_WINDOW_MS / 60_000} minutes: a slow card is never held`, () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T09:00:00Z"));
    const r = cycle();
    for (let n = 1; n <= AGENT_PROGRESS_CHAIN + 1; n++) step(r, n);
    expect(followers(r.take().slice(-1))).toEqual([]);
    vi.setSystemTime(new Date("2026-11-18T09:00:00Z").getTime() + AGENT_COMMENT_WINDOW_MS + 1000);
    step(r, AGENT_PROGRESS_CHAIN + 2);
    expect(followers(r.take())).toEqual(["ops"]);
  });
});

describe("5. the switch, the notice and its delivery", () => {
  it("`progress_wakes: false` tells followers nothing, and leaves every other notice as it was", () => {
    const { board, take, on, leader } = rig();
    on.value = false;
    leader.value = "ops";
    const c = card(board, LEAD, { assignee: "dev-a", needsReview: true });
    board.setWatchers(ANN, c.code, { add: ["dev-b"] });
    expect(brief(take())).toEqual(["dev-a:assigned"]);
    board.moveCard(DEV, c.code, "claimed");
    take();
    const blocked = board.moveCard(DEV, c.code, "blocked", { reason: "q" });
    expect(brief(take())).toEqual(["lead:decide"]);
    expect(noteKeys(blocked)).not.toContain("progress_wakes");
    board.moveCard(LEAD, c.code, "claimed", { comment: "a" });
    take();
    board.moveCard(DEV, c.code, "review", { result: "r" });
    expect(brief(take())).toEqual(["lead:to_confirm"]);
    on.value = true;
    board.moveCard(ANN, c.code, "done");
    expect(brief(take())).toEqual(["dev-b:progress/done/watcher", "lead:progress/done/dispatcher", "ops:progress/done/leader"]);
  });

  it("the fleet's settings: on unless false; the leader is a name or none; the validator checks both", () => {
    expect(boardProgressWakesOn(undefined)).toBe(true);
    expect(boardProgressWakesOn({ defaults: { task_board: {} } })).toBe(true);
    expect(boardProgressWakesOn({ defaults: { task_board: { progress_wakes: false } } })).toBe(false);
    expect(boardLeader(undefined)).toBeNull();
    expect(boardLeader({ defaults: { task_board: { leader: " lead " } } })).toBe("lead");
    expect(boardLeader({ defaults: { task_board: { leader: "" } } })).toBeNull();
    expect(boardLeader({ defaults: { task_board: { leader: 3 } } })).toBeNull();
    const check = (task_board: unknown, instances: unknown = { lead: { working_directory: "/tmp" } }) => validateFleetConfig({ defaults: { task_board }, instances } as never);
    const messages = (r: ReturnType<typeof validateFleetConfig>) => [...r.errors, ...r.warnings].map((m) => `${m.path}: ${m.message}`);
    expect(messages(check({ progress_wakes: false, leader: "lead" })).filter((m) => m.startsWith("defaults.task_board"))).toEqual([]);
    expect(messages(check({ progress_wakes: "no" }))).toContain("defaults.task_board.progress_wakes: must be true or false");
    expect(messages(check({ leader: 3 }))).toContain("defaults.task_board.leader: must be the name of an instance");
    expect(messages(check({ leader: "ghost" })).some((m) => m.startsWith("defaults.task_board.leader: \"ghost\" is not one of the fleet's instances"))).toBe(true);
  });

  it("the notice says what happened, who did it, the words with it and why the instance hears it", () => {
    const { board, take } = rig();
    const c = card(board, LEAD, { assignee: "dev-a", needsReview: false });
    board.setWatchers(ANN, c.code, { add: ["dev-b"] });
    board.moveCard(DEV, c.code, "claimed");
    take();
    board.moveCard(DEV, c.code, "done", { result: "ranked by score" });
    const heard = take();
    const text = (instance: string) => wakeMessage(heard.filter((w) => w.instance === instance), (uuid) => board.findCard(uuid));
    expect(text("lead")).toBe(`[Task board] ${c.code} "Build the leaderboard": finished by dev-a: "ranked by score" — you handed it out; step in (comment, reassign, open the next card) only if it needs you Read it with: task get ${c.code}`.replace("it needs you Read", "it needs you. Read"));
    expect(text("dev-b")).toContain("— you watch it;");
    // review, sent back, blocked, reassigned: each says its own
    const d = card(board, ANN, { assignee: "dev-a", needsReview: true });
    board.setWatchers(ANN, d.code, { add: ["ops"] });
    board.moveCard(DEV, d.code, "claimed");
    take();
    board.moveCard(DEV, d.code, "review", { result: "r" });
    const review = take();
    expect(wakeMessage(review, (u) => board.findCard(u))).toContain("dev-a moved it to review: \"r\" — waiting for the person to confirm it — you watch it");
    board.moveCard(ANN, d.code, "claimed", { reason: "no" });
    expect(wakeMessage(take().filter((w) => w.instance === "ops"), (u) => board.findCard(u))).toContain("sent back by Ann: \"no\" (@dev-a)".replace(" (@dev-a)", "") + " — back with dev-a — you watch it");
    board.moveCard(ANN, d.code, "blocked", { reason: "art" });
    expect(wakeMessage(take().filter((w) => w.instance === "ops"), (u) => board.findCard(u))).toContain("blocked (@dev-a) — \"art\" (moved by Ann) — you watch it");
    board.updateCard(ANN, d.code, { assignee: "dev-b" });
    expect(wakeMessage(take().filter((w) => w.instance === "ops"), (u) => board.findCard(u))).toContain("Ann gave it to @dev-b (it was @dev-a's) — you watch it");
  });

  /** The waker with a simulated clock, over the board's own holds. */
  function waker(board: TaskBoard, extra: Record<string, unknown> = {}) {
    const sent: Array<{ instance: string; message: string }> = [];
    const timers: Array<{ fn: () => void; at: number }> = [];
    let now = 0;
    const w = new TaskBoardWaker({
      deliver: (instance, message) => { sent.push({ instance, message }); return true; },
      isInstance: (n) => INSTANCES.includes(n),
      boardOff: (n) => n === "quiet",
      holds: (x) => board.wakeHolds(x),
      card: (uuid) => board.findCard(uuid),
      log: () => {},
      now: () => now,
      timers: { set: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; }, clear: () => {} },
      ...extra,
    });
    const advance = (ms: number) => { now += ms; for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) { if (t.at <= now) t.fn(); else timers.push(t); } };
    return { w, sent, advance };
  }

  it("10 s later one notice carries what happened on several cards; a piece that no longer stands is not in it", () => {
    const { board, heard } = rig();
    const a = card(board, LEAD, { assignee: "dev-a", needsReview: true }), b = card(board, LEAD, { assignee: "dev-b" });
    const { w, sent, advance } = waker(board);
    board.moveCard(DEV, a.code, "claimed"); board.moveCard(DEV_B, b.code, "claimed");
    heard.splice(0);
    board.moveCard(DEV, a.code, "review", { result: "r" });                 // lead: to_confirm for a
    board.moveCard(ANN, b.code, "blocked", { reason: "art" });             // lead: progress/blocked for b …
    board.moveCard(ANN, b.code, "claimed", { comment: "go" });              // … which no longer stands
    board.moveCard(ANN, b.code, "done");
    w.note(heard.splice(0));
    advance(10_000);
    expect(sent.map((s) => s.instance)).toEqual(["lead"]);
    expect(sent[0]!.message).toContain(`${a.code}`);
    expect(sent[0]!.message).toContain("finished by Ann");
    expect(sent[0]!.message).not.toContain("blocked (@dev-b)");
    expect(sent[0]!.message).not.toContain("art");            // the block's words do not stay on the later news
  });

  it("in one write, the words of an earlier change on the card do not stay on a later one that has none", () => {
    const { board, heard } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.moveCard(DEV, c.code, "claimed");
    heard.splice(0);
    board.atomically(() => {
      board.moveCard(ANN, c.code, "blocked", { reason: "art" });
      board.moveCard(ANN, c.code, "claimed", { comment: "go" });
      board.moveCard(ANN, c.code, "done");
    });
    const lead = heard.find((x) => x.instance === "lead" && x.reasons.includes("progress"))!;
    expect(lead.news?.kind).toBe("done");
    expect(lead.texts.progress).toBeUndefined();
  });

  it("an agent that also messaged the follower about the card does not stand in for the board's notice: the follower is told as it would be", () => {
    const { board, heard } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.moveCard(DEV, c.code, "claimed");
    heard.splice(0);
    const { w, sent, advance } = waker(board);
    board.moveCard(DEV, c.code, "done", { result: "r" });
    w.note(heard.splice(0));
    advance(10_000);                                   // the gather, nothing more
    expect(sent.map((x) => x.instance)).toEqual(["lead"]);
    expect(sent[0]!.message).toContain("finished by dev-a");
  });
});

describe("5b. in a real FleetManager: one durable notice, and the switch and the leader are read at each write", () => {
  async function fleet(config: Record<string, unknown>) {
    vi.useFakeTimers();
    const d = tmp("task-board-follow-fm-");
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d) as unknown as Record<string, any>;
    fm.fleetConfig = config;
    fm.ensureDeliveryOutbox();
    const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
    fm.scheduler = scheduler;
    fm.attachTaskBoard(scheduler.db);
    const notices = () => {
      const db = new Database(join(d, "delivery-outbox.db"), { readonly: true });
      try {
        return (db.prepare("SELECT target_instance, payload_json FROM deliveries WHERE kind='system_notice'").all() as Array<{ target_instance: string; payload_json: string }>)
          .map((r) => ({ to: r.target_instance, text: JSON.parse(r.payload_json).content as string }));
      } finally { db.close(); }
    };
    const stop = () => { fm.taskBoardWaker.stop(); fm.deliveryOutbox?.close?.(); scheduler.db.close(); };
    return { fm, board: scheduler.db.board, db: scheduler.db, notices, stop };
  }
  const base = () => ({ defaults: { task_board: { leader: "ops" } as Record<string, unknown> }, instances: { lead: {}, "dev-a": {}, "dev-b": {}, ops: {}, quiet: { dashboard: { task_board: false } } } });

  it("the person's confirmation: 10 s later the dispatcher and the board's leader each have one notice", async () => {
    const f = await fleet(base());
    const c = f.board.createCards(ANN, { cards: [{ title: "Leaderboard", assignee: "dev-a", dispatcher: { kind: "instance", name: "lead" }, needsReview: true }] }).cards[0]!;
    await vi.advanceTimersByTimeAsync(10_000);
    f.board.moveCard(DEV, c.code, "claimed");
    f.board.moveCard(DEV, c.code, "review", { result: "ranked" });
    await vi.advanceTimersByTimeAsync(130_000);          // an instance's own move waits up to 2 minutes for its own message (#2785 (c))
    const before = f.notices().length;
    f.board.moveCard(ANN, c.code, "done", { comment: "good" });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(f.notices()).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1_000);
    const fresh = f.notices().slice(before);
    expect(fresh.map((n) => n.to).sort()).toEqual(["lead", "ops"]);
    expect(fresh.find((n) => n.to === "lead")!.text).toContain(`${c.code} "Leaderboard": finished by Ann: "ranked" — you handed it out;`);
    expect(fresh.find((n) => n.to === "ops")!.text).toContain("— you lead its project;");
    f.stop();
  });

  it("an edit of fleet.yaml applies to the next write: the switch off, then the leader changed", async () => {
    const f = await fleet(base());
    const c = f.board.createCards(ANN, { cards: [{ title: "T", assignee: "dev-a", needsReview: false }] }).cards[0]!;
    f.board.moveCard(DEV, c.code, "claimed");
    await vi.advanceTimersByTimeAsync(130_000);
    const count = () => f.notices().length;
    const start = count();
    (f.fm.fleetConfig as any).defaults.task_board.progress_wakes = false;
    f.board.moveCard(DEV, c.code, "blocked", { reason: "q" });
    f.board.moveCard(ANN, c.code, "claimed", { comment: "go" });
    await vi.advanceTimersByTimeAsync(130_000);
    expect(count()).toBe(start + 1);                       // dev-a's answered notice; no follower's
    (f.fm.fleetConfig as any).defaults.task_board.progress_wakes = true;
    (f.fm.fleetConfig as any).defaults.task_board.leader = "lead";
    f.board.moveCard(ANN, c.code, "blocked", { reason: "art" });
    await vi.advanceTimersByTimeAsync(10_000);
    const fresh = f.notices().slice(start + 1);
    expect(fresh.map((n) => n.to)).toEqual(["lead"]);
    expect(fresh[0]!.text).toContain("blocked (@dev-a)");
    f.stop();
  });
});

describe("6. the `task` tool and the dashboard's route", () => {
  it("watch and unwatch: yourself by default, another with `watcher`; the answer lists the watchers; an unknown field is refused by name", () => {
    const { db, board } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    expect(boardToolAction(db, "dev-b", { action: "watch", id: c.code })).toBe(`ok ${c.code} watchers: dev-b`);
    expect(boardToolAction(db, "lead", { action: "watch", id: c.code, watcher: "ops" })).toBe(`ok ${c.code} watchers: dev-b, ops`);
    expect(boardToolAction(db, "dev-b", { action: "watch", id: c.code })).toBe(`ok ${c.code} watchers: dev-b, ops (no change)`);
    expect(() => boardToolAction(db, "dev-b", { action: "unwatch", id: c.code, watcher: "ops" })).toThrowError(/you can only watch or stop watching it yourself/);
    expect(boardToolAction(db, "dev-b", { action: "unwatch", id: c.code })).toBe(`ok ${c.code} watchers: ops`);
    expect(() => boardToolAction(db, "dev-b", { action: "watch", id: c.code, title: "x" })).toThrowError(/watch does not take "title"/);
    expect(() => boardToolAction(db, "dev-b", { action: "watch" })).toThrowError(/id is required/);
    expect(boardToolAction(db, "dev-a", { action: "get", id: c.code, detail: true })).toContain("watched by ops");
  });

  it("a change made through the tool says whom it told, so the agent need not message them", () => {
    const { db, board } = rig();
    const c = card(board, LEAD, { assignee: "dev-a" });
    board.setWatchers(ANN, c.code, { add: ["dev-b", "ops"] });
    boardToolAction(db, "dev-a", { action: "move", id: c.code, to: "claimed" });
    const done = boardToolAction(db, "dev-a", { action: "move", id: c.code, to: "done", result: "r" })!;
    expect(done).toContain("how this changed the card is told to lead (dispatcher), dev-b (watcher), ops (watcher) as a [Task board] notice: no need to message them about it");
    const other = card(board, LEAD, { assignee: "dev-a" });
    board.setWatchers(ANN, other.code, { add: ["dev-b", "ops"] });
    // A board field with the new assignee: the new assignee has its own news, the dispatcher made the change; ops is told.
    const upd = boardToolAction(db, "lead", { action: "update", id: other.code, assignee: "dev-b", log: "handing it over" })!;
    expect(upd).toContain("is told to ops (watcher) as a [Task board] notice");
    expect(upd).not.toContain("dev-b (watcher)");
  });
});

describe("7. compatibility", () => {
  it("an upgrade tells nothing about the past: a database without the watchers' table opens, gets it, and no wake comes of old events", () => {
    const path = join(tmp(), "scheduler.db");
    const first = rig(path);
    const c = card(first.board, LEAD, { assignee: "dev-a", needsReview: true });
    first.board.moveCard(DEV, c.code, "claimed");
    first.board.moveCard(DEV, c.code, "review", { result: "r" });
    first.board.moveCard(ANN, c.code, "done");
    first.db.close();
    const raw = new Database(path);
    raw.exec("DROP TABLE task_watchers");
    raw.close();
    const again = rig(path);
    expect(again.take()).toEqual([]);
    expect(again.board.detail(c.code).watchers).toEqual([]);
    again.board.setWatchers(ANN, c.code, { add: ["ops"] });
    expect(again.board.detail(c.code).watchers).toEqual(["ops"]);
    expect(again.take()).toEqual([]);                     // watching tells nobody anything
  });

  it("the table is the only addition, and the tasks table keeps its columns: a release without this reads the same file", () => {
    const path = join(tmp(), "scheduler.db");
    const r = rig(path);
    const c = card(r.board, LEAD, { assignee: "dev-a" });
    r.board.setWatchers(ANN, c.code, { add: ["ops"] });
    r.board.moveCard(DEV, c.code, "claimed");
    r.db.close();
    const raw = new Database(path, { readonly: true });
    try {
      const cols = (t: string) => (raw.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((x) => x.name);
      expect(cols("task_watchers")).toEqual(["task_id", "instance", "added_by", "at"]);
      expect(cols("tasks")).not.toContain("watchers");
      // A watch is one `logged` event with its text (a release without this shows it as it shows any log line's), the names
      // also as values; no entry, so no reader's log or search carries a name.
      const ev = raw.prepare("SELECT type, data FROM task_events WHERE data LIKE '%watchers:%'").get() as { type: string; data: string };
      expect([ev.type, JSON.parse(ev.data)]).toEqual(["logged", { text: "watchers: +ops", watchers: { added: ["ops"], removed: [] } }]);
      expect(raw.prepare("SELECT kind FROM task_entries WHERE text LIKE 'watchers:%'").all()).toEqual([]);
    } finally { raw.close(); }
  });

  it("a card pruned with its record takes its watchers with it, and watchers a release without the table left behind are swept", async () => {
    const path = join(tmp(), "scheduler.db");
    const r = rig(path);
    const old = r.board.createCards(ANN, { cards: [{ title: "Old", assignee: "dev-a", needsReview: false }] }).cards[0]!;
    const kept = r.board.createCards(ANN, { cards: [{ title: "Kept", assignee: "dev-a", needsReview: false }] }).cards[0]!;
    r.board.setWatchers(ANN, old.code, { add: ["ops"] });
    r.board.setWatchers(ANN, kept.code, { add: ["ops"] });
    r.board.moveCard(DEV, old.code, "claimed");
    r.board.moveCard(DEV, old.code, "done", { result: "r" });
    r.db.close();
    const raw = new Database(path);
    raw.prepare("UPDATE tasks SET updated_at = '2020-01-01T00:00:00.000Z' WHERE title = 'Old'").run();
    raw.prepare("INSERT INTO task_watchers (task_id, instance, added_by, at) VALUES ('gone', 'ops', 'x', '2020-01-01')").run();
    raw.close();
    const again = rig(path);
    expect(await again.db.pruneOldTasks(30)).toBe(1);
    expect(again.board.detail(kept.code).watchers).toEqual(["ops"]);
    const check = new Database(path, { readonly: true });
    try { expect(check.prepare("SELECT task_id FROM task_watchers").all()).toEqual([{ task_id: kept.uuid }]); } finally { check.close(); }
  });
});
