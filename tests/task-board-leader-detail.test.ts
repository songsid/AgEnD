/**
 *, the board's side: a card's read says who hears its progress, so the page can show it.
 *  - `leader`: the lead of its project (`via: project`), else the board's default leader (`via: board`, which also leads the
 *    cards in no project); nobody, and a card the `task` tool opened for itself, read as none. It is the same lookup
 *    `followersOf` tells, so what the page says is who is told.
 *  - `inheritedWatchers`: a sub task's main task's watchers (they follow the sub task too), read-only on the sub task.
 *  - `followsProgress`: the fleet's switch for progress notices.
 *  - All three are additions to the read: the fields a page had before are as they were.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerDb } from "../src/scheduler/db.js";
import type { Actor, TaskBoard } from "../src/scheduler/task-board.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const LEAD: Actor = { kind: "instance", name: "lead" };

const dirs: string[] = [];
const dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "task-board-leader-")); dirs.push(dir);
  const db = new SchedulerDb(join(dir, "scheduler.db")); dbs.push(db);
  const on = { value: true }, leader = { value: null as string | null };
  db.board.setCommentRouting({ instances: () => ["lead", "dev-a", "dev-b", "ops"], enabled: () => true });
  db.board.setProgressRouting({ enabled: () => on.value, leader: () => leader.value });
  return { db, board: db.board as TaskBoard, on, leader };
}
const main = (board: TaskBoard, project: string | undefined, extra: Record<string, unknown> = {}) =>
  board.createCards(ANN, { ...(project ? { project } : {}), cards: [{ title: "Build the leaderboard", ...extra }] }).cards[0]!;

describe("the leader a card's read names", () => {
  it("a project's lead outranks the board's default; without one the default leads it; a card in no project has the default too", () => {
    const { board, leader } = rig();
    const game = board.createProject(ANN, { name: "Game" });
    const plain = board.createProject(ANN, { name: "Plain" });
    board.updateProject(ANN, game.id, { leadInstance: "ops" });
    leader.value = "lead";
    expect(board.detail(main(board, "Game").code).leader).toEqual({ name: "ops", via: "project" });
    expect(board.detail(main(board, "Plain").code).leader).toEqual({ name: "lead", via: "board" });
    expect(board.detail(main(board, undefined).code).leader).toEqual({ name: "lead", via: "board" });
    expect(plain.id).toBeGreaterThan(0);
  });

  it("nobody: no project lead and no default; changing either is read on the next read; a project's lead removed falls back to the default", () => {
    const { board, leader } = rig();
    const game = board.createProject(ANN, { name: "Game" });
    const code = main(board, "Game").code;
    expect(board.detail(code).leader).toBeNull();
    leader.value = "dev-a";
    expect(board.detail(code).leader).toEqual({ name: "dev-a", via: "board" });
    board.updateProject(ANN, game.id, { leadInstance: "ops" });
    expect(board.detail(code).leader).toEqual({ name: "ops", via: "project" });
    board.updateProject(ANN, game.id, { leadInstance: null });
    expect(board.detail(code).leader).toEqual({ name: "dev-a", via: "board" });
  });

  it("a sub task has its project's leader; the card the `task` tool opened for itself has none, even with a default set", () => {
    const { db, board, leader } = rig();
    const game = board.createProject(ANN, { name: "Game" });
    board.updateProject(ANN, game.id, { leadInstance: "ops" });
    const m = main(board, "Game");
    const sub = board.createCards(ANN, { cards: [{ parent: m.code, title: "Sort" }] }).cards[0]!;
    expect(board.detail(sub.code).leader).toEqual({ name: "ops", via: "project" });
    leader.value = "lead";
    const plain = db.createTask({ title: "Plain", created_by: "lead", assignee: "dev-a" }, LEAD);
    expect(board.detail(plain.id).leader).toBeNull();
  });

  it("it is the lookup `followersOf` uses: the leader read is the leader told (not the assignee, who has the card's own news)", () => {
    const { board, leader } = rig();
    leader.value = "ops";
    const c = main(board, undefined, { assignee: "dev-a" });
    expect(board.detail(c.code).leader?.name).toBe("ops");
    expect([...board.followersOf(board.getCard(c.code))]).toEqual([["ops", "leader"]]);
    board.updateCard(ANN, c.code, { assignee: "ops" });
    expect(board.detail(c.code).leader?.name).toBe("ops");        // still the leader: the page says why it is told nothing
    expect([...board.followersOf(board.getCard(c.code))]).toEqual([]);
  });
});

describe("the watchers a sub task also has, and the switch", () => {
  it("a sub task reads its main task's watchers as its own inherited ones; its own list stays its own; other cards have none", () => {
    const { board } = rig();
    const m = main(board, undefined);
    board.setWatchers(ANN, m.code, { add: ["dev-b", "ops"] });
    const sub = board.createCards(ANN, { cards: [{ parent: m.code, title: "Sort" }] }).cards[0]!;
    board.setWatchers(ANN, sub.code, { add: ["ops"] });
    const d = board.detail(sub.code);
    expect(d.watchers).toEqual(["ops"]);
    expect(d.inheritedWatchers).toEqual(["dev-b", "ops"]);
    const main1 = board.detail(m.code);
    expect(main1.watchers).toEqual(["dev-b", "ops"]);
    expect(main1.inheritedWatchers).toEqual([]);
  });

  it("`followsProgress` is the fleet's switch, read at each read", () => {
    const { board, on } = rig();
    const c = main(board, undefined);
    expect(board.detail(c.code).followsProgress).toBe(true);
    on.value = false;
    expect(board.detail(c.code).followsProgress).toBe(false);
  });

  it("a board nobody set routing on reads as it always did: no leader, no inherited watchers, notices on", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-board-leader-")); dirs.push(dir);
    const db = new SchedulerDb(join(dir, "scheduler.db")); dbs.push(db);
    const c = db.board.createCards(ANN, { cards: [{ title: "Old" }] }).cards[0]!;
    expect(db.board.detail(c.code)).toMatchObject({ watchers: [], inheritedWatchers: [], leader: null, followsProgress: true });
  });
});
