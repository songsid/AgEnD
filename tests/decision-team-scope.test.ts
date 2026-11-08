/**
 * Team-scoped decisions (cid-decision-scope). A team's conventions used to go out fleet-wide (every other team read
 * them) or project-wide (only one exact working directory: a teammate in a worktree or a workspace never saw them).
 * `scope: "team"` reaches the members of fleet.yaml's team, wherever they work; membership is read when listing and at
 * each launch. On a real SchedulerDb, through FleetManager's two entry paths (the MCP tool over IPC, and the agent
 * endpoint), and the Active Decisions selection.
 */
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchedulerDb } from "../src/scheduler/db.js";
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon, selectRelevantDecisions } from "../src/daemon.js";
import type { CliBackend, CliBackendConfig } from "../src/backend/types.js";
import { TmuxManager } from "../src/tmux-manager.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-team-dec-")); dirs.push(d); return d; };

/** A fleet of instances in different directories; `dev` team = lead + dev + reviewer (a workspace, not the repo). */
function fleet() {
  const db = new SchedulerDb(join(scratch(), "scheduler.db"));
  const instances: Record<string, { working_directory: string; tool_set?: string }> = {
    lead: { working_directory: "/home/u/Projects/App", tool_set: "coordinator" },
    dev: { working_directory: "/home/u/Projects/App-dev2" },                       // a worktree of App
    reviewer: { working_directory: "/home/u/.agend/workspaces/reviewer" },          // not a checkout at all
    ops: { working_directory: "/home/u/Projects/Infra", tool_set: "coordinator" },  // another team (may supersede)
    loner: { working_directory: "/home/u/Projects/Solo" },                         // in no team
    both: { working_directory: "/home/u/Projects/Shared" },                        // in two teams
  };
  const teams: Record<string, { members: string[] }> = {
    dev: { members: ["lead", "dev", "reviewer", "both"] },
    ops: { members: ["ops", "both"] },
  };
  const sent: any[] = [];
  const fake: any = { scheduler: { db }, fleetConfig: { instances, teams }, logger: { warn() {}, info() {}, debug() {} },
    instanceIpcClients: new Map(Object.keys(instances).map((n) => [n, { send: (m: unknown) => sent.push(m) }])) };
  for (const m of ["checkToolPermission", "decisionSupersedes", "decisionScopeFor"]) {
    const fn = (FleetManager.prototype as any)[m];
    if (fn) fake[m] = fn.bind(fake);
  }
  const ipc = async (who: string, type: string, payload: Record<string, unknown>) => {
    await (FleetManager.prototype as any).handleDecisionCrud.call(fake, who, { type, fleetRequestId: "r", payload, meta: { working_directory: instances[who]!.working_directory } });
    const r = sent.at(-1); return r.error ? { error: r.error } : r.result;
  };
  const http = (who: string, op: string, args: Record<string, unknown>) => (FleetManager.prototype as any).handleDecisionCrudHttp.call(fake, who, op, args);
  return {
    db, teams,
    post: (path: "ipc" | "http", who: string, args: Record<string, unknown>) => path === "ipc" ? ipc(who, "fleet_decision_create", args) : http(who, "post", args),
    titles: async (path: "ipc" | "http", who: string): Promise<string[]> => {
      const r = path === "ipc" ? await ipc(who, "fleet_decision_list", {}) : await http(who, "list", {});
      return (r.decisions as { title: string }[]).map(d => d.title).sort();
    },
  };
}

for (const path of ["ipc", "http"] as const) {
  describe(`${path}: team decisions reach the team's members wherever they work`, () => {
    it("a team member in a different directory sees it; a non-member does not", async () => {
      const f = fleet();
      const r = await f.post(path, "lead", { title: "Review flow", content: "Odd PRs to Prism.", scope: "team", team: "dev" });
      expect(r.error).toBeUndefined();
      expect(r.scope).toBe("team");
      expect(r.team).toBe("dev");
      expect(await f.titles(path, "dev")).toEqual(["Review flow"]);          // a worktree
      expect(await f.titles(path, "reviewer")).toEqual(["Review flow"]);     // a workspace directory
      expect(await f.titles(path, "ops")).toEqual([]);                       // another team
      expect(await f.titles(path, "loner")).toEqual([]);                     // no team
    });

    it("the default scope is the poster's team when they are in one, project when in none", async () => {
      const f = fleet();
      const t = await f.post(path, "dev", { title: "Dev convention", content: "x" });
      expect([t.scope, t.team]).toEqual(["team", "dev"]);
      const p = await f.post(path, "loner", { title: "Solo note", content: "x" });
      expect([p.scope, p.team]).toEqual(["project", null]);
      expect(await f.titles(path, "reviewer")).toEqual(["Dev convention"]);
      expect(await f.titles(path, "loner")).toEqual(["Solo note"]);
    });

    it("an instance in several teams sees every one of its teams' decisions, and names the team to post", async () => {
      const f = fleet();
      await f.post(path, "lead", { title: "Dev rule", content: "x" });
      await f.post(path, "ops", { title: "Ops rule", content: "x" });
      expect(await f.titles(path, "both")).toEqual(["Dev rule", "Ops rule"]);
      expect(await f.titles(path, "ops")).toEqual(["Ops rule"]);
      const ambiguous = await f.post(path, "both", { title: "Which?", content: "x" });
      expect(ambiguous.error).toMatch(/several teams \(dev, ops\)/);
      expect((await f.post(path, "both", { title: "Ops only", content: "x", team: "ops" })).team).toBe("ops");
    });

    it("leaving the team hides its decisions at once; joining shows them, without posting again", async () => {
      const f = fleet();
      await f.post(path, "lead", { title: "Dev rule", content: "x" });
      f.teams.dev!.members = f.teams.dev!.members.filter(m => m !== "reviewer");
      expect(await f.titles(path, "reviewer")).toEqual([]);
      f.teams.dev!.members.push("ops");
      expect(await f.titles(path, "ops")).toEqual(["Dev rule"]);
    });

    it("a team decision goes only to a team the poster is in; project and fleet stay as they were", async () => {
      const f = fleet();
      expect((await f.post(path, "ops", { title: "Into dev", content: "x", team: "dev" })).error).toMatch(/not in team "dev"/);
      expect((await f.post(path, "loner", { title: "No team", content: "x", scope: "team" })).error).toMatch(/in no team/);
      expect((await f.post(path, "lead", { title: "Bad", content: "x", scope: "fleet", team: "dev" })).error).toMatch(/team goes with scope "team"/);
      await f.post(path, "lead", { title: "Everyone", content: "x", scope: "fleet" });
      await f.post(path, "lead", { title: "Lead dir only", content: "x", scope: "project" });
      expect(await f.titles(path, "ops")).toEqual(["Everyone"]);
      expect(await f.titles(path, "dev")).toEqual(["Everyone"]);              // project = the exact directory, as before
      expect(await f.titles(path, "lead")).toEqual(["Everyone", "Lead dir only"]);
      expect(f.db.listDecisions("/anywhere").map(d => d.title)).toEqual(["Everyone"]);
    });

    it("superseding a team decision is for its team's members", async () => {
      const f = fleet();
      const old = await f.post(path, "lead", { title: "Dev rule", content: "v1" });
      expect((await f.post(path, "ops", { title: "Hijack", content: "x", scope: "fleet", supersedes: old.id })).error).toMatch(/not found/);
      const next = await f.post(path, "lead", { title: "Dev rule v2", content: "v2", supersedes: old.id });
      expect(next.error).toBeUndefined();
      expect(await f.titles(path, "reviewer")).toEqual(["Dev rule v2"]);
    });
  });
}

describe("Active Decisions: fleet + this instance's teams + its own directory", () => {
  const all = [
    { title: "Fleet-wide", scope: "fleet", project_root: "" },
    { title: "Dev team", scope: "team", team: "dev", project_root: "/home/u/Projects/App" },
    { title: "Ops team", scope: "team", team: "ops", project_root: "/home/u/Projects/Infra" },
    { title: "Mine", scope: "project", project_root: "/w/me" },
  ];
  it("a member gets its teams' decisions wherever it works; others don't", () => {
    expect(selectRelevantDecisions(all, "/w/me", false, ["dev"]).map(d => d.title)).toEqual(["Fleet-wide", "Dev team", "Mine"]);
    expect(selectRelevantDecisions(all, "/home/u/Projects/App", false, []).map(d => d.title)).toEqual(["Fleet-wide"]);
    expect(selectRelevantDecisions(all, "/w/x", false, ["dev", "ops"]).map(d => d.title)).toEqual(["Fleet-wide", "Dev team", "Ops team"]);
  });
  it("a general outside the team does not get the team's decisions", () => {
    expect(selectRelevantDecisions(all, "/home/u/.agend/general", true, []).map(d => d.title)).toEqual(["Fleet-wide"]);
  });
});

describe("an existing decisions table (no team column) keeps working", () => {
  it("opens, migrates, and lists the old rows as before", () => {
    const file = join(scratch(), "scheduler.db");
    const raw = new Database(file);
    raw.exec(`CREATE TABLE decisions (id TEXT PRIMARY KEY, project_root TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'project',
      title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT, status TEXT NOT NULL DEFAULT 'active', superseded_by TEXT,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, updated_at TEXT NOT NULL)`);
    const now = new Date().toISOString();
    raw.prepare("INSERT INTO decisions VALUES (?,?,?,?,?,NULL,'active',NULL,'x',?,NULL,?)").run("a", "/p", "fleet", "Old fleet", "c", now, now);
    raw.prepare("INSERT INTO decisions VALUES (?,?,?,?,?,NULL,'active',NULL,'x',?,NULL,?)").run("b", "/p", "project", "Old project", "c", now, now);
    raw.close();
    const db = new SchedulerDb(file);
    expect(db.listDecisions("/p").map(d => [d.title, d.scope, d.team])).toEqual([["Old fleet", "fleet", null], ["Old project", "project", null]]);
    expect(db.listDecisions("/q", { teams: ["dev"] }).map(d => d.title)).toEqual(["Old fleet"]);
    db.createDecision({ project_root: "/p", scope: "team", team: "dev", title: "New team", content: "c", created_by: "x" });
    expect(db.listDecisions("/q", { teams: ["dev"] }).map(d => d.title)).toEqual(["Old fleet", "New team"]);
  });
});

describe("a launch reads the instance's teams for its Active Decisions", () => {
  afterEach(() => { vi.restoreAllMocks(); delete process.env.AGEND_DECISIONS; });
  it("the daemon asks its team getter at spawn and passes only its teams' decisions to the CLI", async () => {
    process.env.AGEND_DECISIONS = JSON.stringify([
      { title: "Fleet-wide", content: "f", scope: "fleet", project_root: "" },
      { title: "Dev team rule", content: "d", scope: "team", team: "dev", project_root: "/elsewhere" },
      { title: "Ops team rule", content: "o", scope: "team", team: "ops", project_root: "/elsewhere" },
    ]);
    const dir = scratch();
    const daemon = new Daemon("worker", {
      working_directory: dir, backend: "codex", log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    } as any, join(dir, "instance"), false, undefined, undefined, pino({ level: "silent" }) as any) as any;
    mkdirSync(join(dir, "instance"), { recursive: true });
    const seen: CliBackendConfig[] = [];
    daemon.backend = { binaryName: "codex", writeConfig: vi.fn((c: CliBackendConfig) => { seen.push(c); }),
      buildCommand: vi.fn((c: CliBackendConfig) => { seen.push(c); return "codex"; }) } as unknown as CliBackend;
    let teams = ["dev"];
    daemon.setDecisionTeams(() => teams);
    vi.spyOn(TmuxManager, "ensureSession").mockRejectedValue(new Error("stop after the command is built"));
    await expect(daemon.trySpawnInsideGate()).rejects.toThrow(/stop after the command/);
    const text = JSON.stringify(seen);
    expect(text).toContain("Dev team rule");
    expect(text).toContain("Fleet-wide");
    expect(text).not.toContain("Ops team rule");
    teams = [];                                                       // left the team: the next spawn drops it
    seen.length = 0;
    await expect(daemon.trySpawnInsideGate()).rejects.toThrow(/stop after the command/);
    expect(JSON.stringify(seen)).not.toContain("Dev team rule");
  });

  it("the lifecycle gives each daemon a getter over fleet.yaml's teams, read live", async () => {
    const root = scratch(), home = join(root, "agend"), cwd = join(root, "work");
    mkdirSync(home, { recursive: true }); mkdirSync(cwd, { recursive: true });
    vi.stubEnv("AGEND_HOME", home); vi.stubEnv("XDG_DATA_HOME", join(root, "xdg"));
    try {
      const fm = new FleetManager(home);
      fm.fleetConfig = { defaults: { backend: "codex" }, instances: { worker: { working_directory: cwd } },
        teams: { core: { members: ["worker"] }, other: { members: ["someone"] } } } as any;
      const got: Array<(() => string[]) | undefined> = [];
      vi.spyOn(Daemon.prototype, "setDecisionTeams").mockImplementation((fn) => { got.push(fn); });
      vi.spyOn(Daemon.prototype, "start").mockRejectedValue(new Error("fixture stops BEFORE spawning"));
      await fm.lifecycle.start("worker", fm.fleetConfig!.instances.worker!, false).catch(() => {});
      expect(got).toHaveLength(1);
      expect(got[0]?.()).toEqual(["core"]);
      (fm.fleetConfig as any).teams.other.members.push("worker");          // joined later: the next spawn reads it
      expect(got[0]?.()).toEqual(["core", "other"]);
    } finally { vi.unstubAllEnvs(); }
  });
});
