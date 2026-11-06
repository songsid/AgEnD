/**
 * #3195: a field the `task` tool's action does not take is refused by name, through both doors (HTTP:
 * handleTaskCrudHttp, IPC: handleTaskCrud), before anything is written — never reported as success while ignored
 * (e.g. `project` on an update). A plain update's answer shows what was saved for the fields it named.
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
import { ACTION_FIELDS, unsupportedFields } from "../src/task-board-tool.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const dirs: string[] = [];
const dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fleet() {
  const d = mkdtempSync(join(tmpdir(), "task-3195-")); dirs.push(d);
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

/** A main task in project Game, assigned to dev-a, plus a project Other to (try to) move it to. */
function seeded() {
  const f = fleet();
  f.db.board.createProject(ANN, { name: "Game" });
  f.db.board.createProject(ANN, { name: "Other" });
  f.db.board.createCards(ANN, { cards: [{ title: "Leaderboard", project: "Game", assignee: "dev-a" }] });
  const before = f.db.board.getCard("M-1");
  return { ...f, before };
}

describe("#3195: unsupported fields are refused, and nothing changes", () => {
  for (const door of ["http", "ipc"] as const) {
    it(`${door}: update with a field it does not take next to board fields — refused, the board fields not written either`, async () => {
      const f = seeded();
      const r = await f[door]("dev-a", { action: "update", id: "M-1", state: "next: x", log: "l", parent: "M-2" }) as { error: string };
      expect(r.error).toMatch(/^update does not take "parent"/);
      const after = f.db.board.getCard("M-1");
      expect(after.state).toBe("");
      expect(after.version).toBe(f.before.version);
    });
  }

  it.each([
    ["update", { id: "M-1", to: "claimed" }, /update does not take "to" \(use action "move" to change a card's status\)/],
    ["update", { id: "M-1", status: "blocked", reason: "why" }, /update does not take "reason" \(use action "move", which takes the reason with the status\)/],
    ["update", { id: "M-1", parent: "M-2" }, /update does not take "parent" \(a card's parent cannot be changed\)/],
    ["update", { id: "M-1", projectId: 2, colour: "red" }, /update does not take "projectId", "colour"\. Nothing was changed\./],
    ["move", { id: "M-1", to: "claimed", project: "Other" }, /move does not take "project"/],
    ["done", { id: "M-1", comment: "c" }, /done does not take "comment" \(use action "move" with to: "done"/],
    ["claim", { id: "M-1", assignee: "dev-b" }, /claim does not take "assignee"\. Nothing was changed\. claim takes: id\./],
    ["mine", { verbose: true }, /mine does not take "verbose"\. Nothing was changed\. mine takes no other fields\./],
  ])("%s %j — refused, with what to do instead", async (action, args, error) => {
    const f = seeded();
    const r = await f.http("dev-a", { action, ...args }) as { error: string };
    expect(r.error).toMatch(error);
    const after = f.db.board.getCard("M-1");
    expect([after.status, after.assignee, after.projectId, after.version]).toEqual([f.before.status, f.before.assignee, f.before.projectId, f.before.version]);
  });

  it("a null counts as a value: { parent: null } on an update is refused, not read as absent", () => {
    expect(unsupportedFields({ action: "update", id: "M-1", parent: null })).toMatch(/update does not take "parent"/);
    // …while an absent (undefined) field is just absent, as the CLI sends them.
    expect(unsupportedFields({ action: "update", id: "M-1", status: "done", priority: undefined })).toBeNull();
  });

  it("an action the tool does not know keeps the tool's own error", async () => {
    const f = seeded();
    expect(await f.http("dev-a", { action: "archive", id: "M-1" })).toEqual({ error: "Unknown task action: archive" });
  });
});

describe("#3195: what the tool does take is unchanged", () => {
  it("the CLI's shapes (agend-agent task …) all pass", () => {
    for (const args of [
      { action: "create", title: "t", description: "d", priority: "high", assignee: "a" },
      { action: "list", filter_assignee: "a", filter_status: ["done", "cancelled"], verbose: true },
      { action: "get", id: "M-1" }, { action: "claim", id: "M-1" }, { action: "done", id: "M-1", result: "r" },
      { action: "update", id: "M-1", status: "done", priority: "low" }, { action: "mine" }, { action: "projects" },
      { action: "move", id: "M-1", to: "blocked", reason: "who?" }, { action: "move", id: "M-1", to: "done", result: "r" },
      { action: "update", id: "M-1", comment: "c" },
    ]) expect(unsupportedFields(args), JSON.stringify(args)).toBeNull();
  });

  it("every schema field is taken by some action, and every action takes only schema fields", () => {
    const schemaFields = Object.keys(TaskBoardArgs.shape).filter((k) => k !== "action");
    const taken = new Set(Object.values(ACTION_FIELDS).flat());
    expect(schemaFields.filter((k) => !taken.has(k))).toEqual([]);
    expect([...taken].filter((k) => !schemaFields.includes(k))).toEqual([]);
    expect(Object.keys(ACTION_FIELDS).sort()).toEqual([...TaskBoardArgs.shape.action.options].sort());
  });

  it("a plain update's answer carries what was SAVED for the fields it named (status-only stays the small ack)", async () => {
    for (const door of ["http", "ipc"] as const) {
      const f = fleet();
      const ack = await f.http("dev-a", { action: "create", title: "Plain" }) as { id: string };
      const r = await f[door]("dev-a", { action: "update", id: ack.id, priority: "high", assignee: "dev-b" }) as Record<string, unknown>;
      expect(Object.keys(r).sort()).toEqual(["assignee", "id", "priority", "status", "updated_at"]);
      expect(r).toMatchObject({ id: ack.id, priority: "high", assignee: "dev-b" });
      const s = await f[door]("dev-a", { action: "update", id: ack.id, status: "cancelled" }) as Record<string, unknown>;
      expect(Object.keys(s).sort()).toEqual(["id", "status", "updated_at"]);
    }
  });
});
