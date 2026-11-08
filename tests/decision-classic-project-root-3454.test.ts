/**
 * #3454: on the agent-endpoint path (CLI mode, `agend-agent decision-*`), a ClassicBot agent's project root was
 * `fleetConfig.instances[name]?.working_directory ?? ""` — a ClassicBot agent is not in fleet.yaml, so every CLI-mode
 * ClassicBot room stored and listed its project decisions under "": one project shared across rooms. Now it is the
 * agent's own workspace (where startClassicInstance launches it); an agent that is neither is refused. The MCP/IPC path
 * and fleet instances are unchanged. On a real SchedulerDb, through FleetManager's two handlers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchedulerDb } from "../src/scheduler/db.js";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
let home = "";
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agend-3454-home-")); dirs.push(home); vi.stubEnv("AGEND_HOME", home); });
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ROOM_A = "classic-roomA-1111", ROOM_B = "classic-roomB-2222";
function fleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-3454-db-")); dirs.push(dir);
  const db = new SchedulerDb(join(dir, "scheduler.db"));
  const instances: Record<string, { working_directory?: string }> = {
    lead: { working_directory: "/home/u/Projects/App" },
    bare: {},                                                            // a fleet instance with no working_directory
  };
  const sent: any[] = [];
  const fake: any = { scheduler: { db }, fleetConfig: { instances, teams: {} }, logger: { warn() {}, info() {}, debug() {} },
    classicChannels: { getAll: () => [{ instanceName: ROOM_A }, { instanceName: ROOM_B }] },
    instanceIpcClients: new Map([ROOM_A, ROOM_B, "lead"].map((n) => [n, { send: (m: unknown) => sent.push(m) }])) };
  for (const m of ["checkToolPermission", "decisionSupersedes", "decisionScopeFor", "decisionHiddenFrom", "decisionProjectRootFor", "classicWorkspaceDir"]) {
    const fn = (FleetManager.prototype as any)[m];
    if (fn) fake[m] = fn.bind(fake);
  }
  const http = (who: string, op: string, args: Record<string, unknown>) => (FleetManager.prototype as any).handleDecisionCrudHttp.call(fake, who, op, args);
  const ipc = async (who: string, type: string, payload: Record<string, unknown>, workingDirectory: string) => {
    await (FleetManager.prototype as any).handleDecisionCrud.call(fake, who, { type, fleetRequestId: "r", payload, meta: { working_directory: workingDirectory } });
    const r = sent.at(-1); return r.error ? { error: r.error } : r.result;
  };
  const roots = () => (db as any).db.prepare("SELECT title, project_root FROM decisions ORDER BY created_at").all() as Array<{ title: string; project_root: string }>;
  return { db, http, ipc, roots };
}
const titles = (r: any) => ((r?.decisions ?? []) as Array<{ title: string }>).map(d => d.title).sort();

describe("#3454: a ClassicBot agent's CLI-path project decisions belong to its own workspace", () => {
  it("two ClassicBot rooms do not see each other's project decisions through the agent endpoint", async () => {
    const f = fleet();
    const a = await f.http(ROOM_A, "post", { title: "Room A note", content: "a" });
    expect(a.error).toBeUndefined();
    expect(a.scope).toBe("project");
    expect(a.project_root).toBe(join(home, "workspaces", ROOM_A));
    await f.http(ROOM_B, "post", { title: "Room B note", content: "b" });
    expect(titles(await f.http(ROOM_A, "list", {}))).toEqual(["Room A note"]);
    expect(titles(await f.http(ROOM_B, "list", {}))).toEqual(["Room B note"]);
    expect((await f.http(ROOM_B, "get", { id: a.id })).error).toMatch(/No decision/);
    expect(f.roots().map(r => r.project_root)).not.toContain("");
  });

  it("the CLI path and the MCP path agree on a ClassicBot agent's project (its workspace)", async () => {
    const f = fleet();
    const workspace = join(home, "workspaces", ROOM_A);
    await f.ipc(ROOM_A, "fleet_decision_create", { title: "Via MCP", content: "m" }, workspace);   // the daemon's own cwd
    await f.http(ROOM_A, "post", { title: "Via CLI", content: "c" });
    expect(titles(await f.http(ROOM_A, "list", {}))).toEqual(["Via CLI", "Via MCP"]);
    expect(titles(await f.ipc(ROOM_A, "fleet_decision_list", {}, workspace))).toEqual(["Via CLI", "Via MCP"]);
  });

  it("an agent that is neither a fleet instance nor a ClassicBot agent is refused — nothing stored under \"\"", async () => {
    const f = fleet();
    for (const [op, args] of [["post", { title: "Ghost", content: "g" }], ["list", {}], ["get", { id: "abcdef12" }]] as const) {
      expect((await f.http("ghost", op, args)).error).toBe('Decisions are unavailable for "ghost": it is neither a fleet instance nor a ClassicBot agent, so its working directory is unknown');
    }
    expect(f.roots()).toEqual([]);
  });

  it("fleet instances are unchanged: their fleet.yaml working_directory (and \"\" when they have none, as before)", async () => {
    const f = fleet();
    expect((await f.http("lead", "post", { title: "Lead note", content: "l" })).project_root).toBe("/home/u/Projects/App");
    expect((await f.http("bare", "post", { title: "Bare note", content: "x" })).project_root).toBe("");
    expect(titles(await f.http("lead", "list", {}))).toEqual(["Lead note"]);
  });

  it("the MCP/IPC path is unchanged: the daemon's own working directory", async () => {
    const f = fleet();
    const r = await f.ipc(ROOM_B, "fleet_decision_create", { title: "MCP room B", content: "m" }, "/some/daemon/cwd");
    expect(r.project_root).toBe("/some/daemon/cwd");
  });
});
