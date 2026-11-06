/**
 * #3195 (the user's decision 9af8d799): agents organize the task board's projects through the `task` tool —
 *  - create_project: a project with a name and description (its lead, renaming and archiving stay a person's);
 *  - update { project }: a main task into another project, or out of one, by the project's canonical id, when the agent
 *    may edit that card (unassigned, assigned to it, created by it, or its dispatcher); archived projects refused; a
 *    sub task never moves on its own and follows its main task;
 *  - move_project { ids, project }: several main tasks, each moved or refused on its own, one line per card;
 *  - get / list / projects read the saved membership back.
 * Through both doors (HTTP: handleTaskCrudHttp, IPC: handleTaskCrud). Isolation: temp databases; no fleet starts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SchedulerDb } from "../src/scheduler/db.js";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { Actor, Card } from "../src/scheduler/task-board.js";
import { TaskBoardArgs } from "../src/outbound-schemas.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const dirs: string[] = [];
const dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fleet() {
  const d = mkdtempSync(join(tmpdir(), "task-proj-3195-")); dirs.push(d);
  writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
  const fm = new FleetManager(d);
  const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
  (fm as unknown as Record<string, unknown>).scheduler = scheduler;
  dbs.push(scheduler.db);
  const http = (instance: string, args: Record<string, unknown>) => fm.handleTaskCrudHttp(instance, args);
  const ipc = (instance: string, args: Record<string, unknown>) => {
    const got: Array<Record<string, unknown>> = [];
    (fm as unknown as { instanceIpcClients: Map<string, unknown> }).instanceIpcClients.set(instance, { send: (m: Record<string, unknown>) => { got.push(m); return true; } });
    (fm as unknown as { handleTaskCrud(name: string, msg: Record<string, unknown>): void }).handleTaskCrud(instance, { fleetRequestId: "r", payload: args, meta: { instance_name: instance } });
    const m = got[0]!;
    return m.error !== undefined ? { error: m.error } : m.result;
  };
  return { db: scheduler.db, http, ipc };
}

/**
 * Projects Game (1) and Other (2), and Old (3, archived). M-1 "Leaderboard" in Game, assigned to dev-a, with a sub task
 * S-1 (dev-a), a dependency on M-2 and a comment; M-2 "Theirs" in Game, the person's card for dev-b.
 */
function seeded() {
  const f = fleet();
  const b = f.db.board;
  b.createProject(ANN, { name: "Game" });
  b.createProject(ANN, { name: "Other" });
  const old = b.createProject(ANN, { name: "Old" });
  b.updateProject(ANN, old.id, { archived: true });
  b.createCards(ANN, { cards: [{ title: "Theirs", project: "Game", assignee: "dev-b" }] });            // M-1 … renumbered below
  return f;
}
/** What a move must keep, card by card. */
const kept = (c: Card) => ({ uuid: c.uuid, code: c.code, status: c.status, assignee: c.assignee, deps: c.deps, parent: c.parent, createdBy: c.createdBy });

describe("#3195: agents create projects and move main tasks between them", () => {
  for (const door of ["http", "ipc"] as const) {
    it(`${door}: create_project, then a main task moved in, across and out by its id — membership read back; nothing else changes`, async () => {
      const f = seeded();
      const call = (args: Record<string, unknown>) => f[door]("dev-a", args);
      const b = f.db.board;
      // dev-a's own main task (M-2), a sub task, a dependency on M-1, a comment from the person.
      expect(await f.http("dev-a", { action: "create", title: "Leaderboard", project: "Game", depends_on: ["M-1"] })).toBe("ok M-2 Leaderboard [to do] @dev-a (v1)");
      expect(await f.http("dev-a", { action: "create", title: "API", parent: "M-2" })).toBe("ok S-1 API [to do] @dev-a (v1)");
      b.updateCard(ANN, "M-2", { comment: "weekly" });
      const before = { main: kept(b.getCard("M-2")), sub: kept(b.getCard("S-1")), comments: b.detail("M-2").comments.length };

      expect(await call({ action: "create_project", name: "Ops", description: "infra work" })).toBe("ok project 4 Ops");
      expect(await call({ action: "projects" })).toContain("4 Ops — 0 main tasks, 0% done · infra work");

      // Its first write since the person's comment hands that over too, as every board write does.
      expect(await call({ action: "update", id: "M-2", project: 4 })).toBe("ok M-2 Leaderboard [to do] @dev-a (v3)\nnew comment (Ann): weekly");
      expect((await call({ action: "get", id: "M-2" }) as string).split("\n")[1]).toMatch(/^project Ops/);
      expect((await call({ action: "get", id: "S-1" }) as string)).toContain("main M-2 Leaderboard");
      expect(b.getCard("S-1").projectId).toBe(4);                                      // the sub task follows
      expect(await call({ action: "list", project: 4 })).toBe("M-2 [to do] Leaderboard @dev-a\nS-1 [to do] API @dev-a");
      expect(await call({ action: "list", project: "Game" })).toBe("M-1 [to do] Theirs @dev-b");

      expect(await call({ action: "update", id: "M-2", project: "2" })).toBe("ok M-2 Leaderboard [to do] @dev-a (v4)");   // digits as text
      expect(b.getCard("M-2").projectId).toBe(2);
      expect(await call({ action: "update", id: "M-2", project: null })).toBe("ok M-2 Leaderboard [to do] @dev-a (v5)");
      expect([b.getCard("M-2").projectId, b.getCard("S-1").projectId]).toEqual([null, null]);
      expect(await call({ action: "update", id: "M-2", project: 1 })).toBe("ok M-2 Leaderboard [to do] @dev-a (v6)");
      expect(await call({ action: "update", id: "M-2", project: "none" })).toBe("ok M-2 Leaderboard [to do] @dev-a (v7)");
      expect(b.getCard("M-2").projectId).toBeNull();

      // The same card: id, code, status, assignee, dependencies, parent link, creator, comments.
      expect(kept(b.getCard("M-2"))).toEqual(before.main);
      expect(kept(b.getCard("S-1"))).toEqual(before.sub);
      expect(b.detail("M-2").comments.length).toBe(before.comments);
    });
  }

  it.each([
    ["someone else's card (assigned to dev-b, the person's)", { id: "M-1", project: 2 }, /M-1 belongs to dev-b; only its assignee, its creator, its dispatcher or a person can move it to another project/],
    ["an archived project", { id: "M-2", project: 3 }, /project "Old" is archived/],
    ["a sub task on its own", { id: "S-1", project: 2 }, /a sub task follows its main task's project; move the main task/],
    ["a project by name (not its id)", { id: "M-2", project: "Other" }, /"project" takes a project's id .* got "Other"\. Nothing was changed\./],
    ["a project that does not exist", { id: "M-2", project: 99 }, /no project "99"/],
  ])("refused: %s — the card unchanged", async (_why, args, error) => {
    const f = seeded();
    const b = f.db.board;
    await f.http("dev-a", { action: "create", title: "Leaderboard", project: "Game" });
    await f.http("dev-a", { action: "create", title: "API", parent: "M-2" });
    const cards = ["M-1", "M-2", "S-1"].map((c) => b.getCard(c));
    const r = await f.http("dev-a", { action: "update", ...args }) as { error: string };
    expect(r.error).toMatch(error);
    expect(["M-1", "M-2", "S-1"].map((c) => b.getCard(c))).toEqual(cards);
  });

  it("an agent moves a card it is the dispatcher of, or created; a person moves any", async () => {
    const f = seeded();
    const b = f.db.board;
    await f.http("lead", { action: "create", title: "Handed out", project: "Game", assignee: "dev-b" });      // M-2: lead dispatches
    expect(await f.http("lead", { action: "update", id: "M-2", project: 2 })).toBe("ok M-2 Handed out [to do] @dev-b (v2)");
    expect(await f.http("dev-c", { action: "update", id: "M-2", project: 1 })).toMatchObject({ error: expect.stringMatching(/belongs to dev-b/) });
    b.updateCard(ANN, "M-1", { projectId: 2 });
    expect(b.getCard("M-1").projectId).toBe(2);
  });

  it("create_project: a name it needs and keeps unique; a lead, renaming and archiving stay a person's", async () => {
    const f = seeded();
    expect(await f.http("dev-a", { action: "create_project" })).toEqual({ error: "name is required" });
    expect(await f.http("dev-a", { action: "create_project", name: "game" })).toEqual({ error: "there is already a project named \"game\"" });
    expect(await f.http("dev-a", { action: "create_project", name: "Ops", lead: "dev-a" })).toMatchObject({ error: expect.stringMatching(/^create_project does not take "lead"/) });
    expect(f.db.board.listProjects(true).map((p) => p.name)).toEqual(["Game", "Other", "Old"]);
  });

  it("move_project: each main task moved or refused on its own, one line per card, in the order given", async () => {
    const f = seeded();
    const b = f.db.board;
    await f.http("dev-a", { action: "create", title: "Mine", project: "Game" });             // M-2
    await f.http("dev-a", { action: "create", title: "API", parent: "M-2" });                // S-1
    await f.http("dev-a", { action: "create", title: "Also mine", project: "Other" });       // M-3: already there
    const theirs = b.getCard("M-1");
    const r = await f.ipc("dev-a", { action: "move_project", ids: ["S-1", "M-2", "M-1", "M-3", "M-9"], project: 2 });
    expect(r).toBe([
      "moved 1 of 5 to project 2 Other",
      "S-1: not moved — a sub task follows its main task's project; move the main task",
      "ok M-2 → project 2 Other (v2)",
      "M-1: not moved — M-1 belongs to dev-b; only its assignee, its creator, its dispatcher or a person can move it to another project",
      "M-3: already in project 2 Other",
      "M-9: not moved — no card M-9",
    ].join("\n"));
    expect([b.getCard("M-2").projectId, b.getCard("S-1").projectId]).toEqual([2, 2]);
    expect(b.getCard("M-1")).toEqual(theirs);
    expect(await f.http("dev-a", { action: "move_project", ids: ["M-2", "M-3"], project: null }))
      .toBe("moved 2 of 2 to no project\nok M-2 → no project (v3)\nok M-3 → no project (v2)");
  });

  it.each([
    [{ ids: [], project: 2 }, /ids lists the main tasks to move/],
    [{ ids: ["M-1"] }, /project is the project's id, or null/],
    [{ ids: Array.from({ length: 51 }, (_, i) => `M-${i + 1}`), project: 2 }, /at most 50 cards in one move_project/],
    [{ ids: ["M-1"], project: "Other" }, /"project" takes a project's id/],
  ])("move_project %j is refused before anything moves", async (args, error) => {
    const f = seeded();
    const before = f.db.board.getCard("M-1");
    expect(((await f.http("dev-a", { action: "move_project", ...args })) as { error: string }).error).toMatch(error);
    expect(f.db.board.getCard("M-1")).toEqual(before);
  });

  it("the schema advertises the new actions and fields", () => {
    expect(TaskBoardArgs.safeParse({ action: "create_project", name: "Ops", description: "d" }).success).toBe(true);
    expect(TaskBoardArgs.safeParse({ action: "move_project", ids: ["M-1", "M-2"], project: 3 }).success).toBe(true);
    expect(TaskBoardArgs.safeParse({ action: "update", id: "M-1", project: null }).success).toBe(true);
  });
});
