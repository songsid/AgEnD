/**
 * Where an agent's new main task goes when `create` names no project. It used to land in "No
 * project" without a word, where the person never looked. Counting the projects that are not archived:
 *  - none: opened in no project, as before (the answer is the old one);
 *  - one: it goes there, whatever the caller;
 *  - several: the one the caller LEADS when it leads exactly one of them, else an error that lists the projects and creates
 *    nothing — the agent asks the person and creates again;
 *  - project named (id or name): as given; null / "none": deliberately none; a blank string is nothing said;
 *  - a sub task (parent) follows its main task and is never asked about.
 * The answer to a main task's create says where it is and why, and what to tell the person (`#M-n` opens the card).
 * Through both doors (HTTP: handleTaskCrudHttp, IPC: handleTaskCrud). Isolation: temp databases; no fleet starts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SchedulerDb } from "../src/scheduler/db.js";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { Actor } from "../src/scheduler/task-board.js";
import { placeNewMain } from "../src/task-board-tool.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const dirs: string[] = [];
const dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fleet() {
  const d = mkdtempSync(join(tmpdir(), "task-create-project-351-")); dirs.push(d);
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

const doors = ["http", "ipc"] as const;
/** Live cards on the board: every card these tests open stays open. */
const count = (db: SchedulerDb) => db.board.listCards({}).total;

describe("a new main task's project, when none is named", () => {
  for (const door of doors) {
    describe(`through ${door}`, () => {
      it("no project on the board: opened in no project, the answer as it always was", async () => {
        const f = fleet();
        const plain = await f[door]("dev-a", { action: "create", title: "Plain" }) as { id: string; status: string };
        expect(Object.keys(plain).sort()).toEqual(["id", "status", "updated_at"]);
        expect(f.db.board.getCard("M-1").projectId).toBeNull();
        // an archived project does not count: still none
        const old = f.db.board.createProject(ANN, { name: "Old" });
        f.db.board.updateProject(ANN, old.id, { archived: true });
        const board = await f[door]("dev-a", { action: "create", title: "Board card", acceptance: ["done"] });
        expect(board).toBe("ok M-2 Board card [to do] @dev-a (v1)");
        expect(f.db.board.getCard("M-2").projectId).toBeNull();
      });

      it("one project: a plain create and a board create both go there, unassigned as a plain task is, and the answer says so", async () => {
        const f = fleet();
        const game = f.db.board.createProject(ANN, { name: "Game" });
        const old = f.db.board.createProject(ANN, { name: "Old" });
        f.db.board.updateProject(ANN, old.id, { archived: true });

        const plain = await f[door]("dev-a", { action: "create", title: "Leaderboard", description: "weekly top 100" });
        expect(plain).toBe("ok M-1 Leaderboard [to do] (v1)\nIn project 1 Game — the board's only project, chosen for you.\nTell the person: #M-1 (opens the card) is in project Game.");
        const m1 = f.db.board.getCard("M-1");
        expect(m1.projectId).toBe(game.id);
        expect(m1.assignee).toBeNull();            // a plain task is unassigned unless asked: the default project does not change that
        expect(m1.goal).toBe("weekly top 100");
        expect(m1.needsReview).toBe(false);

        // asked for a card for someone else: the assignee and the hand-out are kept
        await f[door]("lead", { action: "create", title: "For dev-b", assignee: "dev-b" });
        const m2 = f.db.board.getCard("M-2");
        expect([m2.projectId, m2.assignee, m2.dispatcher?.name]).toEqual([game.id, "dev-b", "lead"]);

        // a board field without a project: it still goes to the only project, assigned to its opener as a board card is
        await f[door]("dev-a", { action: "create", title: "With checklist", acceptance: ["a"] });
        const m3 = f.db.board.getCard("M-3");
        expect([m3.projectId, m3.assignee]).toEqual([game.id, "dev-a"]);
      });

      it("one project, but 'none' is asked for: opened in no project, and the answer says that", async () => {
        const f = fleet();
        f.db.board.createProject(ANN, { name: "Game" });
        for (const none of ["none", " None ", null] as const) {
          const out = await f[door]("dev-a", { action: "create", title: `T ${String(none)}`, project: none }) as string;
          expect(out).toMatch(/\nIn no project \(the board's 未分類 \/ No project\)\.\nTell the person: #M-\d+ \(opens the card\) is in no project\. Unless they asked for none, ask which project it belongs to; once they say, move it \(move_project\) and add the rule to your soul\.md Rules, so the next such card goes there\.$/);
        }
        expect(f.db.board.listCards({ project: null }).cards).toHaveLength(3);
      });

      it("several projects, none named, the caller leads none: nothing is created and the projects are listed", async () => {
        const f = fleet();
        f.db.board.createProject(ANN, { name: "Game", description: "the game's work", leadInstance: "lead-a" });
        f.db.board.createProject(ANN, { name: "Shop" });
        const old = f.db.board.createProject(ANN, { name: "Old" });
        f.db.board.updateProject(ANN, old.id, { archived: true });
        const asked = await f[door]("dev-a", { action: "create", title: "Where?" }) as { error: string };
        expect(asked.error).toMatch(/^This board has 2 projects and you did not say which one this card belongs to\. Ask the person which project it is for — do not guess — then create it again with project set to its id\. Use project: "none" only when nobody can answer now \(a scheduled or automated run\) or the person says it belongs to no project\. Nothing was created\./);
        expect(asked.error).toContain("\nProjects:\n1 Game (lead: lead-a) · the game's work\n2 Shop");
        expect(asked.error).not.toContain("Old");
        expect(count(f.db)).toBe(0);
        // a board create too, and a blank project is nothing said
        expect(((await f[door]("dev-a", { action: "create", title: "Where?", acceptance: ["a"] })) as { error: string }).error).toMatch(/^This board has 2 projects/);
        expect(((await f[door]("dev-a", { action: "create", title: "Where?", project: "  " })) as { error: string }).error).toMatch(/^This board has 2 projects/);
        expect(count(f.db)).toBe(0);
      });

      it("several projects: the caller leads exactly one — it goes there, and the answer says why; another instance is asked", async () => {
        const f = fleet();
        f.db.board.createProject(ANN, { name: "Game", leadInstance: "dev-a" });
        f.db.board.createProject(ANN, { name: "Shop", leadInstance: "dev-b" });
        const out = await f[door]("dev-a", { action: "create", title: "Leaderboard" });
        expect(out).toBe("ok M-1 Leaderboard [to do] (v1)\nIn project 1 Game — chosen for you: you lead this project.\nTell the person: #M-1 (opens the card) is in project Game.");
        expect(f.db.board.getCard("M-1").projectId).toBe(1);
        const other = await f[door]("dev-c", { action: "create", title: "Not mine" }) as { error: string };
        expect(other.error).toMatch(/^This board has 2 projects/);
        expect(other.error).not.toContain("you lead");
        expect(count(f.db)).toBe(1);
      });

      it("several projects: the caller leads two — it is asked, and told so; an archived project it led does not count", async () => {
        const f = fleet();
        f.db.board.createProject(ANN, { name: "Game", leadInstance: "dev-a" });
        f.db.board.createProject(ANN, { name: "Shop", leadInstance: "dev-a" });
        const asked = await f[door]("dev-a", { action: "create", title: "Which?" }) as { error: string };
        expect(asked.error).toMatch(/^This board has 2 projects and you did not say which one this card belongs to \(you lead 2 of them, so none is yours by default\)\. Ask the person/);
        expect(count(f.db)).toBe(0);
        // one of them archived: it leads exactly one active project again
        f.db.board.updateProject(ANN, 2, { archived: true });
        f.db.board.createProject(ANN, { name: "Docs" });
        expect(await f[door]("dev-a", { action: "create", title: "Now it is Game's" })).toMatch(/\nIn project 1 Game — chosen for you: you lead this project\./);
      });

      it("a project named is taken as given (id, number or name); 'none' is none; a lead is not overridden", async () => {
        const f = fleet();
        f.db.board.createProject(ANN, { name: "Game", leadInstance: "dev-a" });
        f.db.board.createProject(ANN, { name: "Shop" });
        expect(await f[door]("dev-a", { action: "create", title: "By id", project: 2 })).toMatch(/\nIn project 2 Shop\.\nTell the person: #M-1 \(opens the card\) is in project Shop\.$/);
        expect(await f[door]("dev-a", { action: "create", title: "By name", project: "Shop" })).toMatch(/\nIn project 2 Shop\.\n/);
        expect(await f[door]("dev-a", { action: "create", title: "By digits", project: "2" })).toMatch(/\nIn project 2 Shop\.\n/);
        expect(await f[door]("dev-a", { action: "create", title: "Nowhere", project: "none" })).toMatch(/\nIn no project /);
        expect(await f[door]("dev-b", { action: "create", title: "Nowhere too", project: null })).toMatch(/\nIn no project /);
        expect(f.db.board.getCard("M-1").projectId).toBe(2);
        // a project that is not there is still refused by name, as before, and nothing is created
        const before = count(f.db);
        expect(((await f[door]("dev-a", { action: "create", title: "x", project: "Nope" })) as { error: string }).error).toMatch(/^no project "Nope" \(projects: Game, Shop\)/);
        expect(count(f.db)).toBe(before);
      });

      it("nobody to ask (a scheduled run): the error says to use 'none'; the card is opened in no project and the answer sends the agent to tell the person, ask, move it and remember", async () => {
        const f = fleet();
        f.db.board.createProject(ANN, { name: "Game" });
        f.db.board.createProject(ANN, { name: "Shop" });
        expect(((await f[door]("nightly", { action: "create", title: "Daily report" })) as { error: string }).error).toContain('Use project: "none" only when nobody can answer now (a scheduled or automated run)');
        const out = await f[door]("nightly", { action: "create", title: "Daily report", project: "none" }) as string;
        expect(out).toContain("In no project");
        expect(out).toContain("ask which project it belongs to");
        expect(out).toContain("soul.md Rules");
        const card = f.db.board.getCard("M-1");
        expect(card.projectId).toBeNull();
        // the person answers: the agent moves it by id, as the answer says, and the next one it opens goes there by naming it
        expect(await f[door]("nightly", { action: "move_project", ids: ["M-1"], project: 2 })).toMatch(/^moved 1 of 1 to project 2 Shop/);
        expect(f.db.board.getCard("M-1").projectId).toBe(2);
      });

      it("a sub task follows its main task and is never asked about the project", async () => {
        const f = fleet();
        f.db.board.createProject(ANN, { name: "Game" });
        f.db.board.createProject(ANN, { name: "Shop" });
        await f[door]("dev-a", { action: "create", title: "Main", project: "Shop" });
        const sub = await f[door]("dev-a", { action: "create", title: "Step", parent: "M-1" });
        expect(sub).toBe("ok S-1 Step [to do] @dev-a (v1)");            // the sub task's answer is as it was
        expect(f.db.board.getCard("S-1").projectId).toBe(2);
      });
    });
  }

  it("the same through the board's own door: a person (the dashboard) and the board's createCards are not asked anything", () => {
    const f = fleet();
    f.db.board.createProject(ANN, { name: "Game" });
    f.db.board.createProject(ANN, { name: "Shop" });
    const card = f.db.board.createCards(ANN, { cards: [{ title: "Dashboard card" }] }).cards[0]!;
    expect(card.projectId).toBeNull();
  });

  it("placeNewMain: the rule alone", () => {
    const projects = [{ id: 1, name: "A", description: "", archived: false, leadInstance: "x" }, { id: 2, name: "B", description: "", archived: false, leadInstance: null }] as never[];
    const board = (list: unknown[]) => ({ listProjects: () => list }) as never;
    expect(placeNewMain(board([]), "x", undefined)).toBeNull();
    expect(placeNewMain(board(projects.slice(0, 1)), "z", undefined)).toMatchObject({ why: "only", project: { id: 1 } });
    expect(placeNewMain(board(projects), "x", undefined)).toMatchObject({ why: "lead", project: { id: 1 } });
    expect(() => placeNewMain(board(projects), "z", undefined)).toThrowError(/^This board has 2 projects/);
    expect(placeNewMain(board(projects), "z", "none")).toBeNull();
    expect(placeNewMain(board(projects), "z", null)).toBeNull();
    expect(placeNewMain(board(projects), "z", 2)).toBeNull();
  });
});
