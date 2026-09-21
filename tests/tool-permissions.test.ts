import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOLS } from "../src/channel/mcp-tools.js";
import {
  EARLY_AGENT_OP_TOOLS,
  IPC_TYPE_TOOLS,
  mayUseTool,
  resolveToolSet,
  toolsFor,
  toolForIpcType,
  toolRefusedMessage,
  TOOL_PROFILES,
} from "../src/tool-permissions.js";
import { dispatchAgentOperation, toolForAgentOp, ToolNotPermittedError } from "../src/agent-endpoint.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-toolperms-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── The profiles themselves did not move ────────────────────────────────────

/**
 * The four profiles exactly as they were before this module existed, written
 * out rather than imported, so the comparison is against a frozen record and
 * not against the thing being tested.
 */
const BEFORE: Record<string, string[]> = {
  standard: [
    "reply", "react", "edit_message",
    "send_to_instance", "broadcast", "list_instances", "describe_instance",
    "list_decisions", "post_decision", "task", "set_display_name", "set_description",
    "validate_config", "get_fleet_status", "get_usage", "get_effort", "get_instance_logs", "get_fleet_config",
  ],
  minimal: ["reply", "send_to_instance", "list_decisions", "download_attachment"],
  general: [
    "reply", "react", "edit_message", "download_attachment",
    "list_teams", "list_instances", "describe_instance", "get_fleet_status", "get_usage", "get_effort", "list_models",
    "send_to_instance", "delegate_task", "request_information", "report_result", "broadcast",
    "create_instance", "start_instance", "restart_instance", "wake_instance",
    "task", "list_decisions", "post_decision",
    "create_schedule", "list_schedules", "delete_schedule",
  ],
};

describe("the existing profiles are untouched", () => {
  it("keeps the three existing profiles byte for byte", () => {
    for (const [name, tools] of Object.entries(BEFORE)) {
      expect([...toolsFor(name as never)].sort(), name).toEqual([...tools].sort());
    }
  });

  it("keeps `full` meaning every tool there is", () => {
    expect([...toolsFor("full")].sort()).toEqual(TOOLS.map(t => t.name).sort());
  });

  it("resolves the same profile the daemon resolved before", () => {
    // Today: an explicit tool_set wins, a general gets `general`, everything
    // else gets the whole toolbox. The last one is #804, and stage 3 is where
    // it changes — stage 1 must leave it exactly where it was.
    expect(resolveToolSet({}, "worker-1")).toBe("full");
    expect(resolveToolSet(undefined, "worker-1")).toBe("full");
    expect(resolveToolSet({ general_topic: true }, "gen")).toBe("general");
    expect(resolveToolSet({}, "general")).toBe("general");
    expect(resolveToolSet({ tool_set: "minimal" }, "worker-1")).toBe("minimal");
  });

  it("lets an explicit choice beat the role, in both directions", () => {
    // Without this a general cannot be narrowed and a worker cannot be widened,
    // which is the whole reason `tool_set` is writable.
    expect(resolveToolSet({ general_topic: true, tool_set: "minimal" }, "gen")).toBe("minimal");
    expect(resolveToolSet({ tool_set: "full" }, "worker-1", "worker")).toBe("full");
    // An unrecognised value is not an explicit choice, and falls to the role.
    // With the stage-3 default in place that is `worker`; a typo must never be
    // the shortest path to more tools than were asked for.
    expect(resolveToolSet({ tool_set: "nonsense" }, "worker-1", "worker")).toBe("worker");
    expect(resolveToolSet({ tool_set: "__proto__" }, "worker-1", "worker")).toBe("worker");
  });

  it("has the two new profiles ready but reachable only on request", () => {
    expect(mayUseTool("worker", "report_result")).toBe(true);
    expect(mayUseTool("worker", "create_instance")).toBe(false);
    expect(mayUseTool("coordinator", "create_instance")).toBe(true);
    // Nothing resolves to them by itself yet.
    expect(resolveToolSet({}, "anyone")).not.toBe("worker");
  });
});

// ── The worker profile is the one `standard` could not be ───────────────────

describe("the worker profile", () => {
  it("can complete the protocol the fleet asks of it", () => {
    // `standard` has no report_result, which is why every worker ran on `full`.
    for (const tool of ["send_to_instance", "report_result", "request_information", "broadcast", "delegate_task"]) {
      expect(mayUseTool("worker", tool), tool).toBe(true);
      if (tool !== "send_to_instance" && tool !== "broadcast") {
        expect(mayUseTool("standard", tool), `standard should still lack ${tool}`).toBe(false);
      }
    }
  });

  it("cannot create, destroy, silence or reconfigure anything of anyone else's", () => {
    for (const tool of [
      "create_instance", "delete_instance", "replace_instance",
      "stop_instance", "pause_instance", "start_instance", "restart_instance", "wake_instance",
      "deploy_template", "teardown_deployment",
      "create_team", "delete_team", "update_team",
      "update_fleet_defaults", "update_instance_config", "update_decision",
      "create_schedule", "update_schedule", "delete_schedule",
    ]) {
      expect(mayUseTool("worker", tool), tool).toBe(false);
      expect(mayUseTool("coordinator", tool), `coordinator should have ${tool}`).toBe(true);
    }
  });

  it("keeps the repo lease, which is the work rather than the running of it", () => {
    expect(mayUseTool("worker", "checkout_repo")).toBe(true);
    expect(mayUseTool("worker", "release_repo")).toBe(true);
  });
});

// ── Every way of naming a tool resolves to one ──────────────────────────────

describe("no entry path is missing from the table", () => {
  it("names a tool for every agent-endpoint op", () => {
    const source = readFileSync(new URL("../src/agent-endpoint.ts", import.meta.url), "utf8");
    const opMap = source.slice(source.indexOf("const OP_MAP"), source.indexOf("/** Schedule/decision"));
    const ops = [...opMap.matchAll(/^\s*"?([a-z-]+)"?:\s*"([a-z_]+)"/gm)].map(m => m[1]!);

    expect(ops.length).toBeGreaterThan(15);
    for (const op of ops) {
      expect(toolForAgentOp(op), `op ${op} resolves to no tool`).toBeTruthy();
    }
    // And the six that never reach OP_MAP.
    for (const op of Object.keys(EARLY_AGENT_OP_TOOLS)) {
      expect(toolForAgentOp(op), `early op ${op} resolves to no tool`).toBeTruthy();
    }
  });

  it("names a tool for every typed IPC message", () => {
    // These bypass the outbound path entirely, which is how a coordinator-only
    // tool kept a way through.
    const source = readFileSync(new URL("../src/fleet-manager.ts", import.meta.url), "utf8");
    const router = source.slice(source.indexOf("private dispatchTypedIpc"), source.indexOf("private handleScheduleCrud"));

    for (const type of Object.keys(IPC_TYPE_TOOLS)) {
      const family = type.startsWith("fleet_schedule_") ? "fleet_schedule_"
        : type.startsWith("fleet_decision_") ? "fleet_decision_" : type;
      expect(router, `${type} is in the table but the router drops it`).toContain(family);
    }
    expect(IPC_TYPE_TOOLS.fleet_decision_update).toBe("update_decision");
    expect(IPC_TYPE_TOOLS.fleet_schedule_create).toBe("create_schedule");
  });

  it("maps every tool name it claims to a tool that exists", () => {
    const real = new Set(TOOLS.map(t => t.name));
    for (const [, tool] of Object.entries({ ...IPC_TYPE_TOOLS, ...EARLY_AGENT_OP_TOOLS })) {
      expect(real.has(tool), `${tool} is not a tool`).toBe(true);
    }
    for (const [profile, tools] of Object.entries(TOOL_PROFILES)) {
      for (const tool of tools) expect(real.has(tool), `${profile} lists ${tool}`).toBe(true);
    }
  });
});

// ── All three sinks ask, and none of them acts on the answer yet ────────────

function fleetManagerWith(toolSet: string | undefined) {
  const dir = tempDir();
  const warn = vi.fn();
  const fm = {
    fleetConfig: { defaults: {}, instances: { worker: { working_directory: "/tmp/w", ...(toolSet ? { tool_set: toolSet } : {}) } } },
    logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    dataDir: dir,
  };
  return { fm, warn };
}

describe("sink 1 — the fleet's outbound IPC", () => {
  /** Everything `handleOutboundFromInstance` touches before it decides. */
  async function outbound(toolSet: string | undefined, tool: string) {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const sent: Array<Record<string, unknown>> = [];
    const warn = vi.fn();
    const fm = {
      fleetConfig: { defaults: {}, instances: { worker: { working_directory: "/tmp/w", ...(toolSet ? { tool_set: toolSet } : {}) } } },
      logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
      instanceIpcClients: new Map([["worker", { send: (m: Record<string, unknown>) => { sent.push(m); return true; } }]]),
      worlds: new Map(),
      touchActivity: () => {},
      setTopicIcon: () => {},
      eventLog: null,
      checkToolPermission: (FleetManager.prototype as unknown as Record<string, unknown>).checkToolPermission,
    };
    const handle = (FleetManager.prototype as unknown as {
      handleOutboundFromInstance(instance: string, msg: Record<string, unknown>): Promise<void>;
    }).handleOutboundFromInstance;
    await handle.call(fm as never, "worker", { tool, args: {}, fleetRequestId: "r1" });
    return { sent, warn };
  }

  it("refuses a create_instance written straight to the socket", async () => {
    // The case that proves the defence does not rest on non-disclosure: this
    // path never touches mcp-server, so no amount of filtering the tool list
    // would have stopped it.
    const { sent, warn } = await outbound("minimal", "create_instance");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "fleet_outbound_response", fleetRequestId: "r1", result: null });
    expect(String(sent[0]!.error)).toContain("create_instance is not available to this instance");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ sink: "ipc-outbound", profile: "minimal", tool: "create_instance", enforced: true }),
      expect.stringContaining("refused"),
    );
  });

  it("refuses before the adapters are even consulted", async () => {
    // `worlds` is empty here, which is the "channel not ready" path. A refusal
    // that only happens after that check would answer "retry shortly" to a call
    // that is never going to be allowed.
    const { sent } = await outbound("minimal", "create_instance");

    expect(String(sent[0]!.error)).not.toContain("retry shortly");
  });

  it("lets a permitted tool through to the normal path", async () => {
    // `reply` is in every profile; with no adapters it reaches the existing
    // "not ready" answer, which is proof it got past the permission check.
    const { sent } = await outbound("minimal", "reply");

    expect(String(sent[0]!.error)).toContain("adapters are not ready");
  });

  it("decides permission before anything else can answer first", () => {
    const source = readFileSync(new URL("../src/fleet-manager.ts", import.meta.url), "utf8");
    const fn = source.slice(source.indexOf("private async handleOutboundFromInstance"));
    const checkAt = fn.indexOf('this.checkToolPermission("ipc-outbound"');
    const adaptersAt = fn.indexOf("Channel adapters are not ready");
    const dispatchAt = fn.indexOf("outboundHandlers.get(tool)");

    expect(checkAt).toBeGreaterThan(-1);
    expect(adaptersAt, "an unready adapter answers before a refusal").toBeGreaterThan(checkAt);
    expect(dispatchAt, "the tool is dispatched before it is checked").toBeGreaterThan(checkAt);
  });
});

describe("sink 2 — the typed IPC handlers", () => {
  it("is checked on the dispatch, before the handler runs", () => {
    const source = readFileSync(new URL("../src/fleet-manager.ts", import.meta.url), "utf8");
    const branch = source.slice(source.indexOf("toolForIpcType(msg.type) !== null"), source.indexOf("instance_process_state"));

    expect(branch).toContain('this.checkToolPermission("ipc-typed"');
    const checkAt = branch.indexOf("checkToolPermission");
    const dispatchAt = branch.indexOf("dispatchTypedIpc");
    expect(dispatchAt, "dispatched before checked").toBeGreaterThan(checkAt);
    // And a refusal answers rather than dropping the message: these are
    // request/response, so silence leaves the caller waiting forever.
    expect(branch).toContain("refuseTypedIpc");
  });

  it("routes every typed message through the one door that is checked", () => {
    // A sixth type added later cannot be dispatched without appearing in
    // IPC_TYPE_TOOLS first, which is what stops the check being forgotten again.
    const source = readFileSync(new URL("../src/fleet-manager.ts", import.meta.url), "utf8");
    for (const dead of ['msg.type === "fleet_schedule_create"', 'msg.type === "fleet_task"', 'msg.type === "fleet_set_description"']) {
      expect(source, `${dead} still has its own dispatch branch`).not.toContain(dead);
    }
  });
});

describe("sink 3 — the agent endpoint", () => {
  /**
   * Only ops whose handler this context actually stubs.
   *
   * A permitted op still runs, so one that reaches a real lifecycle handler
   * runs it against a context that has no lifecycle — and the resulting
   * TypeError escapes as an unhandled rejection rather than a failed
   * assertion, which turns a green report into a non-zero exit. Which tool
   * each op maps to is covered by the op-table tests; what these need is a
   * call that finishes.
   */
  async function callAgent(op: string, toolSet: string | undefined) {
    const warn = vi.fn();
    const ctx = {
      dataDir: tempDir(),
      fleetConfig: { defaults: {}, instances: { worker: { working_directory: "/tmp/w", ...(toolSet ? { tool_set: toolSet } : {}) } } },
      logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
      handleTaskCrudHttp: async () => ({ ok: true }),
      handleScheduleCrudHttp: async () => ({ ok: true }),
    };
    const result = await dispatchAgentOperation(ctx as never, "worker", op, {});
    return { warn, result };
  }

  it("refuses an op the profile does not allow", async () => {
    const ctx = {
      dataDir: tempDir(),
      fleetConfig: { defaults: {}, instances: { worker: { working_directory: "/tmp/w", tool_set: "minimal" } } },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    };

    const err = await dispatchAgentOperation(ctx as never, "worker", "spawn", {}).catch(e => e as Error);

    expect(err).toBeInstanceOf(ToolNotPermittedError);
    expect((err as ToolNotPermittedError).status).toBe(403);
    expect((err as Error).message).toContain("create_instance is not available");
  });

  it("answers 403 rather than 400, because it is not a malformed request", () => {
    const source = readFileSync(new URL("../src/agent-endpoint.ts", import.meta.url), "utf8");

    expect(source).toContain("err instanceof ToolNotPermittedError ? 403 : 400");
  });

  it("checks the early-returning ops too, which never reach OP_MAP", async () => {
    // `schedule-create` is answered before the map is consulted, so a table
    // built from the map alone would have let it straight through.
    const ctx = {
      dataDir: tempDir(),
      fleetConfig: { defaults: {}, instances: { worker: { working_directory: "/tmp/w", tool_set: "worker" } } },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
      handleScheduleCrudHttp: async () => ({ ok: true }),
    };

    const err = await dispatchAgentOperation(ctx as never, "worker", "schedule-create", {}).catch(e => e as Error);

    expect(err).toBeInstanceOf(ToolNotPermittedError);
    expect((err as Error).message).toContain("create_schedule");
  });

  it("still lets a worker do the things a worker does", async () => {
    const ctx = {
      dataDir: tempDir(),
      fleetConfig: { defaults: {}, instances: { worker: { working_directory: "/tmp/w", tool_set: "worker" } } },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
      handleTaskCrudHttp: async () => ({ ok: true }),
    };

    await expect(dispatchAgentOperation(ctx as never, "worker", "task", {})).resolves.toEqual({ ok: true });
  });

  it("says nothing when the profile allows it", async () => {
    const { warn, result } = await callAgent("task", "full");

    expect(warn).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it("names a tool for every op agent-cli can actually send", async () => {
    // Built from the CLI's own switch, not from the endpoint's map — `usage`
    // and `decision-post` live only in the CLI, and an op with no name is an op
    // with no permission check.
    const cli = readFileSync(new URL("../src/agent-cli.ts", import.meta.url), "utf8");
    const body = cli.slice(cli.indexOf("switch (op)"));
    const ops = [...body.matchAll(/^\s*(?:\/\/ .*\n\s*)?case "([a-z][a-z-]*)":/gm)].map(m => m[1]!);
    // The task sub-actions are arguments, not ops.
    const subActions = new Set(["create", "list", "claim", "done", "update"]);

    const unnamed = [...new Set(ops)].filter(op => !subActions.has(op) && toolForAgentOp(op) === null);

    expect(unnamed, `these ops reach the endpoint with no permission check: ${unnamed.join(", ")}`).toEqual([]);
    expect(toolForAgentOp("usage")).toBe("get_usage");
    expect(toolForAgentOp("decision-post")).toBe("post_decision");
  });

  it("checks before any branch, including the early returns", () => {
    const source = readFileSync(new URL("../src/agent-endpoint.ts", import.meta.url), "utf8");
    const fn = source.slice(source.indexOf("export async function dispatchAgentOperation"));
    const checkAt = fn.indexOf("toolForAgentOp(op)");
    const firstBranch = fn.indexOf('op.startsWith("schedule-")');

    expect(checkAt).toBeGreaterThan(-1);
    expect(firstBranch, "an op is handled before it is checked").toBeGreaterThan(checkAt);
  });
});

// ── A key that only exists on Object.prototype is not a profile ─────────────

describe("inherited keys are not answers", () => {
  it("refuses to treat prototype names as tool sets", () => {
    // `"constructor" in PROFILE_SETS` is true, so this used to pass and then
    // throw `.has is not a function` inside the sink — a crash reachable by
    // writing `tool_set: constructor` in fleet.yaml.
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(resolveToolSet({ tool_set: name }, "w", "worker"), name).toBe("worker");
      expect(() => mayUseTool(resolveToolSet({ tool_set: name }, "w", "worker"), "reply")).not.toThrow();
    }
  });

  it("refuses to treat prototype names as IPC types or ops", () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      expect(toolForIpcType(name), name).toBeNull();
      expect(toolForAgentOp(name), name).toBeNull();
    }
    // And the real ones still resolve.
    expect(toolForIpcType("fleet_decision_update")).toBe("update_decision");
    expect(toolForAgentOp("spawn")).toBe("create_instance");
  });
});

// ── What a refused agent is told ────────────────────────────────────────────

describe("the refusal explains itself", () => {
  it("names the profile, the tool, and what to do instead", () => {
    const message = toolRefusedMessage("worker", "create_instance");

    // A refused agent reads this as an instruction, so it has to contain one.
    expect(message).toContain("create_instance");
    expect(message).toContain("worker");
    expect(message).toContain("report_result");
    expect(message).toContain("tool_set: coordinator");
  });
});

// ── One rule for what a general is ──────────────────────────────────────────

describe("the general check no longer disagrees with itself", () => {
  it("treats an instance named general as a general, like everywhere else does", async () => {
    // The daemon read `general_topic` alone while `isGeneralInstance` also
    // accepted the name, so this instance was a worker in one place and a
    // general in the other.
    const { isGeneralInstance } = await import("../src/general-instance.js");
    const config = { instances: { general: { working_directory: "/tmp/g" } } } as never;

    expect(isGeneralInstance(config, "general")).toBe(true);
    expect(resolveToolSet({}, "general")).toBe("general");
  });

  it("is wired that way in the daemon, not just in the helper", () => {
    const source = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
    const block = source.slice(source.indexOf("One rule for \"is this a general\""), source.indexOf("AGEND_DISPLAY_NAME"));

    expect(block).toContain('this.name === "general"');
    expect(block).toContain("resolveToolSet(this.config, this.name");
  });
});
