/**
 * post_decision's `supersedes` retires a decision someone else may have recorded, so it asks for `update_decision` — through
 * the live permission check (tool set, as configured now), on both create paths: the MCP tool (daemon → IPC
 * `fleet_decision_create` → FleetManager.handleDecisionCrud) and the agent endpoint (`decision-post` →
 * handleDecisionCrudHttp). The predecessor is checked, and marked, in the insert's own transaction: a refusal or a failed
 * update inserts nothing. On a real SchedulerDb.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SchedulerDb } from "../src/scheduler/db.js";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const WD = "/work/project";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "agend-supersede-")); dirs.push(dir);
  const db = new SchedulerDb(join(dir, "scheduler.db"));
  const rule = db.createDecision({ project_root: WD, scope: "fleet", title: "Review flow", content: "General's rule.", created_by: "general" });
  return { db, rule };
}
const count = (db: SchedulerDb) => db.listDecisions(WD, { includeArchived: true }).length;

/** FleetManager's two create paths, with its real permission check, for instances of these tool sets. */
function fleet(db: SchedulerDb) {
  const sent: any[] = [];
  const instances = {
    general: { working_directory: WD },                                   // the `general` tool set by name
    lead: { working_directory: WD, tool_set: "coordinator" },
    dev: { working_directory: WD, tool_set: "worker" },
    plain: { working_directory: WD },                                     // unset: a worker
  };
  const fake: any = { scheduler: { db }, fleetConfig: { instances }, logger: { warn() {}, info() {}, debug() {} },
    instanceIpcClients: new Map(Object.keys(instances).map((n) => [n, { send: (m: unknown) => sent.push(m) }])) };
  fake.checkToolPermission = (FleetManager.prototype as any).checkToolPermission.bind(fake);
  fake.decisionSupersedes = (FleetManager.prototype as any).decisionSupersedes.bind(fake);
  return {
    async ipc(who: string, payload: Record<string, unknown>) {
      await (FleetManager.prototype as any).handleDecisionCrud.call(fake, who, { type: "fleet_decision_create", fleetRequestId: "r1", payload, meta: { working_directory: WD } });
      return sent.at(-1);
    },
    http: (who: string, args: Record<string, unknown>) => (FleetManager.prototype as any).handleDecisionCrudHttp.call(fake, who, "post", args),
  };
}

describe("superseding needs update_decision", () => {
  for (const path of ["ipc", "http"] as const) {
    const create = async (f: ReturnType<typeof fleet>, who: string, args: Record<string, unknown>) => {
      const r = path === "ipc" ? await f.ipc(who, args) : await f.http(who, args);
      return path === "ipc" ? (r.error ? { error: r.error } : r.result) : r;
    };
    it(`${path}: a worker's supersedes is refused, and nothing is inserted; the old decision stays active`, async () => {
      for (const who of ["dev", "plain"]) {
        const { db, rule } = store();
        const r = await create(fleet(db), who, { title: "Mine now", content: "x", supersedes: rule.id });
        expect(r.error).toMatch(/^Superseding a decision needs update_decision\. update_decision is not available to this instance: it runs with the "worker" tool set/);
        expect(count(db)).toBe(1);
        expect(db.getDecision(rule.id)).toMatchObject({ status: "active", superseded_by: null });
      }
    });
    it(`${path}: a worker may still post without supersedes (and with an empty one)`, async () => {
      const { db, rule } = store();
      const f = fleet(db);
      expect((await create(f, "dev", { title: "New", content: "x" })).title).toBe("New");
      expect((await create(f, "dev", { title: "New 2", content: "x", supersedes: "" })).title).toBe("New 2");
      expect(count(db)).toBe(3);
      expect(db.getDecision(rule.id)!.status).toBe("active");
    });
    it(`${path}: General and a coordinator supersede`, async () => {
      for (const who of ["general", "lead"]) {
        const { db, rule } = store();
        const r = await create(fleet(db), who, { title: "V2", content: "y", supersedes: rule.id });
        expect(r.title).toBe("V2");
        expect(db.getDecision(rule.id)).toMatchObject({ status: "superseded", superseded_by: r.id });
      }
    });
    it(`${path}: a predecessor that is missing, not active, or not a string is refused — nothing inserted`, async () => {
      const { db, rule } = store();
      const f = fleet(db);
      expect((await create(f, "lead", { title: "A", content: "a", supersedes: "no-such-id" })).error).toBe('Decision "no-such-id" not found');
      db.archiveDecision(rule.id);
      expect((await create(f, "lead", { title: "B", content: "b", supersedes: rule.id })).error).toMatch(/is archived, not active/);
      expect((await create(f, "lead", { title: "C", content: "c", supersedes: 42 })).error).toBe("supersedes must be a decision id");
      expect(count(db)).toBe(1);
    });
  }
  it("a project decision of another working directory is not one this instance can supersede", () => {
    const { db } = store();
    const other = db.createDecision({ project_root: "/elsewhere", title: "Theirs", content: "t", created_by: "x" });
    expect(() => db.createDecision({ project_root: WD, title: "Mine", content: "m", created_by: "lead", supersedes: other.id })).toThrow(`Decision "${other.id}" not found`);
    expect(db.getDecision(other.id)!.status).toBe("active");
    expect(db.listDecisions(WD).map((d) => d.title)).toEqual(["Review flow"]);
  });
});

describe("one transaction", () => {
  it("a predecessor update that changes no row rolls the insert back", () => {
    const { db, rule } = store();
    // The row is valid when checked, and the update then finds nothing to change (as if it went away in between).
    (db as any).supersedeDecision = () => 0;
    expect(() => db.createDecision({ project_root: WD, title: "V2", content: "y", created_by: "lead", supersedes: rule.id })).toThrow(/could not be superseded/);
    expect(count(db)).toBe(1);
    expect(db.getDecision(rule.id)!.status).toBe("active");
  });
  it("a predecessor update that throws rolls the insert back", () => {
    const { db, rule } = store();
    (db as any).supersedeDecision = () => { throw new Error("disk I/O error"); };
    expect(() => db.createDecision({ project_root: WD, title: "V2", content: "y", created_by: "lead", supersedes: rule.id })).toThrow("disk I/O error");
    expect(count(db)).toBe(1);
  });
  it("the update itself only touches an active row", () => {
    const { db, rule } = store();
    db.archiveDecision(rule.id);
    expect(db.supersedeDecision(rule.id, "x")).toBe(0);
    expect(db.getDecision(rule.id)).toMatchObject({ status: "archived", superseded_by: null });
  });
});
