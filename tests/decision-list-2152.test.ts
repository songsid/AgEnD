/**
 * #2152: `list_decisions` answers titles by default — the fleet's 82 decisions were 126 KB in one call, read after every
 * restart. One decision's full text by `id` (exact, or a unique prefix of 6+), all of it with `full: true`. Both entry
 * paths answer the same: the MCP tool (daemon → FleetManager.handleDecisionCrud) and the agent endpoint's
 * `decision-list` / `decision-get` (FleetManager.handleDecisionCrudHttp, CLI mode), on a real SchedulerDb.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SchedulerDb } from "../src/scheduler/db.js";
import { FleetManager } from "../src/fleet-manager.js";
import { decisionListAnswer, DECISION_TITLES_HINT } from "../src/decision-list.js";
import { ListDecisionsArgs } from "../src/outbound-schemas.js";
import { TOOLS } from "../src/channel/mcp-tools.js";
import { EARLY_AGENT_OP_TOOLS } from "../src/tool-permissions.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const WD = "/work/project";
function store() {
  const dir = mkdtempSync(join(tmpdir(), "agend-2152-")); dirs.push(dir);
  const db = new SchedulerDb(join(dir, "scheduler.db"));
  const long = "Rule body. ".repeat(200);
  const a = db.createDecision({ project_root: WD, scope: "fleet", title: "Review flow v3", content: long, tags: ["review"], created_by: "leader" });
  const b = db.createDecision({ project_root: WD, scope: "project", title: "Use pnpm", content: "Always pnpm.", created_by: "dev" });
  const c = db.createDecision({ project_root: WD, scope: "fleet", title: "Old rule", content: "Gone.", created_by: "leader" });
  db.archiveDecision(c.id);
  return { db, a, b, c, long };
}
/** FleetManager's two decision paths, on the real store. */
function fleet(db: SchedulerDb) {
  const sent: any[] = [];
  const fake: any = { scheduler: { db }, fleetConfig: { instances: { dev: { working_directory: WD } } }, logger: { warn() {}, info() {}, debug() {} },
    instanceIpcClients: new Map([["dev", { send: (m: unknown) => sent.push(m) }]]) };
  return {
    ipc(payload: Record<string, unknown>) {
      (FleetManager.prototype as any).handleDecisionCrud.call(fake, "dev", { type: "fleet_decision_list", fleetRequestId: "r1", payload, meta: { working_directory: WD } });
      return sent.at(-1).result;
    },
    http: (op: string, args: Record<string, unknown>) => (FleetManager.prototype as any).handleDecisionCrudHttp.call(fake, "dev", op, args),
  };
}

describe("titles by default; the full text when asked", () => {
  it("default: id, title, scope, date and tags — no content — and a hint", () => {
    const { db, a, b } = store();
    const r = decisionListAnswer(db.listDecisions(WD)) as any;
    expect(r.hint).toBe(DECISION_TITLES_HINT);
    expect(r.decisions.map((d: any) => d.title).sort()).toEqual(["Review flow v3", "Use pnpm"]);
    const row = r.decisions.find((d: any) => d.id === a.id);
    expect(row).toEqual({ id: a.id, title: "Review flow v3", scope: "fleet", date: a.updated_at.slice(0, 10), tags: ["review"] });
    expect(r.decisions.find((d: any) => d.id === b.id)).not.toHaveProperty("tags");
    expect(JSON.stringify(r)).not.toContain("Rule body");
  });
  it("by id (exact, or a unique prefix of 6+): the whole decision; an unknown or too-short id says so", () => {
    const { db, a, long } = store();
    const all = db.listDecisions(WD);
    expect((decisionListAnswer(all, { id: a.id }) as any).decision.content).toBe(long);
    expect((decisionListAnswer(all, { id: a.id.slice(0, 8) }) as any).decision.id).toBe(a.id);
    expect((decisionListAnswer(all, { id: a.id.slice(0, 3) }) as any).error).toMatch(/^No decision/);
    expect((decisionListAnswer(all, { id: "nope-nope" }) as any).error).toMatch(/^No decision 'nope-nope'/);
  });
  it("an ambiguous prefix is refused, never a guess", () => {
    const d = (id: string) => ({ id, project_root: WD, scope: "fleet", title: id, content: "x", tags: [], status: "active", superseded_by: null, created_by: "x", created_at: "2026-10-18T00:00:00Z", expires_at: null, updated_at: "2026-10-18T00:00:00Z" }) as any;
    expect((decisionListAnswer([d("abcdef01"), d("abcdef02")], { id: "abcdef" }) as any).error).toMatch(/^No decision/);
  });
  it("full: true — every full record, as before", () => {
    const { db } = store();
    const r = decisionListAnswer(db.listDecisions(WD), { full: true }) as any[];
    expect(Array.isArray(r)).toBe(true);
    expect(r.every(d => typeof d.content === "string")).toBe(true);
  });
  it("archived ones, when included, say their status", () => {
    const { db, c } = store();
    const r = decisionListAnswer(db.listDecisions(WD, { includeArchived: true })) as any;
    expect(r.decisions.find((d: any) => d.id === c.id).status).toBe("archived");
  });
});

describe("both entry paths answer the same", () => {
  it("the MCP tool's path (daemon → handleDecisionCrud): titles; { id } the decision; { full } the records", () => {
    const { db, a } = store();
    const f = fleet(db);
    expect(f.ipc({}).decisions.map((d: any) => d.id)).toContain(a.id);
    expect(f.ipc({ id: a.id }).decision.id).toBe(a.id);
    expect(f.ipc({ full: true }).length).toBe(2);
  });
  it("CLI mode (decision-list / decision-get): the same; decision-list true includes archived (include_archived, as the CLI sends it)", async () => {
    const { db, a, c } = store();
    const f = fleet(db);
    expect((await f.http("list", {})).decisions.map((d: any) => d.id)).not.toContain(c.id);
    expect((await f.http("list", { include_archived: true })).decisions.map((d: any) => d.id)).toContain(c.id);
    expect((await f.http("get", { id: a.id })).decision.id).toBe(a.id);
    expect((await f.http("get", {})).error).toBeDefined();                     // decision-get with no id: not the list
    expect(EARLY_AGENT_OP_TOOLS["decision-get"]).toBe("list_decisions");
  });
});

describe("the contract agents read", () => {
  it("the schema takes id and full; the tool description says titles by default", () => {
    expect(ListDecisionsArgs.safeParse({ id: "abc123", full: true }).success).toBe(true);
    expect(TOOLS.find(t => t.name === "list_decisions")!.description).toContain("Titles by default");
  });
});
