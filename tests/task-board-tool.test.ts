/**
 * The `task` tool on the task board (docs/design/task-board.md): its board actions through both of its doors (HTTP:
 * handleTaskCrudHttp, IPC: handleTaskCrud) — mine, projects, move, create/update with board fields, get of a board
 * card, list by project or parent — answered in text; the tool's own tasks answered as before.
 *
 * Isolation: temp databases; a FleetManager with no fleet (nothing starts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SchedulerDb } from "../src/scheduler/db.js";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { Actor } from "../src/scheduler/task-board.js";
import { TaskBoardArgs } from "../src/outbound-schemas.js";

const ANN: Actor = { kind: "person", name: "Ann" };

const dirs: string[] = [];
const dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string { const d = mkdtempSync(join(tmpdir(), "task-board-tool-")); dirs.push(d); return d; }

describe("the task tool's board actions", () => {
  function fleet() {
    const d = dir();
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d);
    const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
    (fm as unknown as Record<string, unknown>).scheduler = scheduler;
    dbs.push(scheduler.db);
    const call = (instance: string, args: Record<string, unknown>) => fm.handleTaskCrudHttp(instance, args);
    return { fm, db: scheduler.db, call };
  }

  it("an agent's day: projects, a main task split into sub tasks, mine, get, update, move — text answers", async () => {
    const { db, call } = fleet();
    db.board.createProject(ANN, { name: "Game" });
    expect(await call("lead", { action: "projects" })).toBe("1 Game — 0 main tasks, 0% done");
    expect(await call("lead", { action: "create", title: "Leaderboard", project: "Game", description: "weekly top 100", acceptance: ["resets Monday"] }))
      .toBe("ok M-1 Leaderboard [to do] @lead (v1)");
    expect(await call("lead", { action: "create", title: "API", parent: "M-1", assignee: "dev-a" })).toBe("ok S-1 API [to do] @dev-a (v1)");
    expect(await call("lead", { action: "create", title: "Review", parent: "M-1", assignee: "dev-b", depends_on: ["S-1"] })).toBe("ok S-2 Review [to do] @dev-b (v1)");
    expect(await call("dev-b", { action: "mine" })).toBe("dev-b's work on the task board\nwaiting on dependencies:\n S-2 Review — waits for S-1");
    expect(await call("dev-a", { action: "move", id: "S-1", to: "claimed" })).toBe("ok S-1 to do → in progress (v2)");
    expect(await call("dev-a", { action: "update", id: "S-1", state: "done: handler\nnext: tests", log: "handler in" })).toBe("ok S-1 API [in progress] @dev-a (v3)");
    db.board.updateCard(ANN, "S-1", { comment: "cache it 30 s" });
    expect(await call("dev-a", { action: "get", id: "s1" })).toBe([
      "S-1 sub task · API [in progress] @dev-a v4",
      "main M-1 Leaderboard · finish it yourself",
      "state:", " done: handler", " next: tests",
      "comments (1 new):", ` Ann ${db.board.detail("S-1").comments[0]!.at.slice(5, 16).replace("T", " ")} [new]: cache it 30 s`,
    ].join("\n"));
    // Its next write hands over the comment it had not seen.
    expect(await call("dev-a", { action: "move", id: "S-1", to: "done", result: "src/api.ts; tests pass" }))
      .toBe("ok S-1 in progress → done (v5)\nnew comment (Ann): cache it 30 s\nS-2's dependencies are all done; it can start");
    expect(await call("lead", { action: "list", parent: "M-1" })).toBe("S-2 [to do] Review @dev-b");
    expect(await call("lead", { action: "list", parent: "M-1", filter_status: ["done", "open"] })).toBe("S-2 [to do] Review @dev-b\nS-1 [done] API @dev-a");
    expect(await call("lead", { action: "mine" })).toBe("lead's work on the task board\nmain tasks you coordinate:\n M-1 Leaderboard [in progress] sub tasks 1/2");
  });

  it("the board's rules hold, as answers the agent can act on", async () => {
    const { db, call } = fleet();
    db.board.createCards(ANN, { cards: [{ title: "Theirs", assignee: "dev-b" }] });
    expect(await call("dev-a", { action: "move", id: "M-1", to: "claimed" })).toEqual({ error: "M-1 is assigned to dev-b; you cannot take it" });
    // Fields and a status together: one write — the refused move leaves the fields as they were.
    expect(await call("dev-b", { action: "update", id: "M-1", state: "x", status: "done" })).toEqual({ error: "only a card in progress can go to review (M-1 is open)" });
    expect(db.board.getCard("M-1").state).toBe("");
    expect(await call("dev-b", { action: "move", id: "M-1", to: "finished" })).toEqual({ error: "\"to\" is one of open, claimed, blocked, review, done, cancelled" });
    expect(await call("dev-b", { action: "move", id: "M-1", to: "doing" })).toBe("ok M-1 to do → in progress (v2)");      // a word from other boards
    // Done on a card that waits for the person is theirs to confirm, as with the tool's `done`; past that, only they move it.
    expect(await call("dev-b", { action: "move", id: "M-1", to: "done", result: "r" })).toBe("ok M-1 in progress → waiting for the person (v3)");
    expect(await call("dev-b", { action: "move", id: "M-1", to: "done" })).toEqual({ error: "M-1 is waiting for the person's confirmation: only they finish it" });
  });

  it("the tool's own tasks are answered as before", async () => {
    const { call } = fleet();
    const ack = await call("dev-a", { action: "create", title: "Plain" }) as { id: string; status: string };
    expect(Object.keys(ack).sort()).toEqual(["id", "status", "updated_at"]);
    expect(await call("dev-a", { action: "get", id: ack.id })).toMatchObject({ id: ack.id, code: "M-1", title: "Plain" });
    expect(await call("dev-a", { action: "update", id: ack.id, priority: "high" })).toMatchObject({ id: ack.id, status: "open" });
  });

  it("the IPC door answers the same", () => {
    const { fm, db } = fleet();
    db.board.createProject(ANN, { name: "Game" });
    const got: Array<Record<string, unknown>> = [];
    (fm as unknown as { instanceIpcClients: Map<string, unknown> }).instanceIpcClients.set("dev-a", { send: (m: Record<string, unknown>) => { got.push(m); return true; } });
    (fm as unknown as { handleTaskCrud(name: string, msg: Record<string, unknown>): void }).handleTaskCrud("dev-a", { fleetRequestId: "r1", payload: { action: "projects" }, meta: { instance_name: "dev-a" } });
    expect(got).toEqual([{ type: "fleet_task_response", fleetRequestId: "r1", result: "1 Game — 0 main tasks, 0% done" }]);
  });

  it("the tool's schema takes the board's fields", () => {
    expect(TaskBoardArgs.safeParse({ action: "move", id: "M-1", to: "blocked", reason: "who?" }).success).toBe(true);
    expect(TaskBoardArgs.safeParse({ action: "update", id: "S-1", check: [1, 2], state: "next: x", comment: "c", version: 3 }).success).toBe(true);
    expect(TaskBoardArgs.safeParse({ action: "create", title: "x", parent: "M-1", acceptance: ["a"], needs_review: true, size: "M" }).success).toBe(true);
    expect(TaskBoardArgs.safeParse({ action: "move", id: "M-1", to: "finished" }).success).toBe(false);
  });
});
