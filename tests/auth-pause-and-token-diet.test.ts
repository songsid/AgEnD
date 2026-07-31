import { describe, expect, it } from "vitest";
import { sameProjectFamily, selectRelevantDecisions } from "../src/daemon.js";
import { TOOLS, TOOL_SETS } from "../src/channel/mcp-tools.js";
import { createBackend } from "../src/backend/factory.js";

describe("decisions relevance filter", () => {
  const AGEND = "/home/han/Projects/AgEnD-dev2";
  const decisions = [
    { title: "agend-rule", scope: "fleet", project_root: "/home/han/Projects/AgEnD" },
    { title: "agend-dev1-rule", scope: "fleet", project_root: "/home/han/Projects/AgEnD-dev1" },
    { title: "dopo-workflow", scope: "fleet", project_root: "/home/han/Projects/DouPo_Leader" },
    { title: "awp-rule", scope: "fleet", project_root: "/home/han/Projects/AWP-OTA" },
    { title: "truly-global", scope: "fleet" },
    { title: "own-project-scoped", scope: "project", project_root: AGEND },
    { title: "other-project-scoped", scope: "project", project_root: "/home/han/Projects/DouPo_Server" },
  ];

  it("drops fleet decisions belonging to unrelated projects", () => {
    const kept = selectRelevantDecisions(decisions, AGEND).map(d => d.title);
    expect(kept).not.toContain("dopo-workflow");
    expect(kept).not.toContain("awp-rule");
  });

  it("keeps same-project-family fleet decisions (worktrees of one repo)", () => {
    const kept = selectRelevantDecisions(decisions, AGEND).map(d => d.title);
    expect(kept).toContain("agend-rule");       // AgEnD vs AgEnD-dev2
    expect(kept).toContain("agend-dev1-rule");  // AgEnD-dev1 vs AgEnD-dev2
  });

  it("always keeps truly global (no project_root) and own project-scoped", () => {
    const kept = selectRelevantDecisions(decisions, AGEND).map(d => d.title);
    expect(kept).toContain("truly-global");
    expect(kept).toContain("own-project-scoped");
    expect(kept).not.toContain("other-project-scoped");
  });

  it("a general keeps ALL fleet decisions — it routes across projects", () => {
    const kept = selectRelevantDecisions(decisions, "/home/han/.agend/general", true).map(d => d.title);
    expect(kept).toContain("dopo-workflow");   // cross-project routing rule
    expect(kept).toContain("awp-rule");
    expect(kept).toContain("truly-global");
    // still excludes another project's *project*-scoped decisions
    expect(kept).not.toContain("other-project-scoped");
  });
});

describe("sameProjectFamily", () => {
  it("treats worktrees/role checkouts of one repo as the same project", () => {
    const P = "/home/han/Projects/";
    expect(sameProjectFamily(P + "AgEnD", P + "AgEnD-dev2")).toBe(true);
    expect(sameProjectFamily(P + "AgEnD-dev1", P + "AgEnD-reviewer")).toBe(true);
    expect(sameProjectFamily(P + "A8Plus_Server", P + "A8Plus_Server-main")).toBe(true);
  });

  it("keeps genuinely different projects apart", () => {
    const P = "/home/han/Projects/";
    expect(sameProjectFamily(P + "AgEnD", P + "DouPo_Server")).toBe(false);
    expect(sameProjectFamily(P + "AgEnD", P + "AWP-OTA")).toBe(false);
    // near-miss: different repos that merely share a prefix word
    expect(sameProjectFamily(P + "DouPo_Server", P + "DouPo_Leader")).toBe(false);
  });

  it("handles nesting and trailing slashes", () => {
    expect(sameProjectFamily("/a/b", "/a/b/sub")).toBe(true);
    expect(sameProjectFamily("/a/b/", "/a/b")).toBe(true);
  });
});

describe("general tool profile", () => {
  it("contains every tool the documented dispatch flow needs", () => {
    // GENERAL_INSTRUCTIONS prescribes: list_teams → list_instances →
    // describe_instance → create_instance → send_to_instance.
    for (const t of ["list_teams", "list_instances", "describe_instance", "create_instance",
      "send_to_instance", "delegate_task", "request_information", "report_result",
      "reply", "download_attachment", "task", "list_decisions"]) {
      expect(TOOL_SETS.general).toContain(t);
    }
  });

  it("is why `standard` could not be used — standard lacks the dispatch verbs", () => {
    for (const missing of ["delegate_task", "request_information", "report_result",
      "create_instance", "start_instance", "download_attachment", "list_teams"]) {
      expect(TOOL_SETS.standard).not.toContain(missing);
    }
  });

  it("omits destructive / project-local verbs a dispatcher shouldn't carry", () => {
    for (const t of ["delete_instance", "replace_instance", "stop_instance",
      "checkout_repo", "deploy_template", "update_fleet_defaults"]) {
      expect(TOOL_SETS.general).not.toContain(t);
    }
  });

  it("only references real tools and is materially smaller than full", () => {
    const names = new Set(TOOLS.map(t => t.name));
    for (const t of TOOL_SETS.general) expect(names.has(t)).toBe(true);
    expect(TOOL_SETS.general.length).toBeLessThan(TOOL_SETS.full.length / 1.5);
  });
});

describe("kiro auth_error pattern", () => {
  const kiro = createBackend("kiro-cli", "/tmp/kiro-test");
  const auth = kiro.getErrorPatterns!().find(p => p.type === "auth_error")!;

  it("exists and pauses the instance", () => {
    expect(auth).toBeDefined();
    expect(auth.action).toBe("pause");
  });

  it("matches the strings kiro-cli actually emits", () => {
    for (const line of [
      "You are not logged in, please log in with kiro-cli login",
      "Error: ExpiredTokenException: the security token included in the request is expired",
      "no device registration found for token",
    ]) expect(auth.pattern.test(line)).toBe(true);
  });

  it("does not fire on an agent merely discussing auth code", () => {
    for (const line of [
      "I'll add a check for Unauthorized responses in the handler",
      "the API returns 401 when not logged in as admin",
      "catch (UnauthorizedException e) { retry(); }",
    ]) expect(auth.pattern.test(line)).toBe(false);
  });
});
