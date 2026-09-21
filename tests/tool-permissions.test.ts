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
  TOOL_PROFILES,
} from "../src/tool-permissions.js";
import { dispatchAgentOperation, toolForAgentOp } from "../src/agent-endpoint.js";

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

// ── Stage 1 changes nothing an instance can do ──────────────────────────────

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

describe("nothing an instance can do has moved", () => {
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
    // And an unrecognised value is not an explicit choice.
    expect(resolveToolSet({ tool_set: "nonsense" }, "worker-1")).toBe("full");
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
  it("records a call the profile would refuse, and still runs it", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { fm, warn } = fleetManagerWith("minimal");
    const check = (FleetManager.prototype as unknown as {
      checkToolPermission(sink: string, instance: string, tool: string): boolean;
    }).checkToolPermission;

    const allowed = check.call(fm as never, "ipc-outbound", "worker", "create_instance");

    expect(allowed).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ sink: "ipc-outbound", instance: "worker", profile: "minimal", tool: "create_instance", enforced: false }),
      expect.stringContaining("would be refused"),
    );
  });

  it("is wired into the outbound handler before the tool is dispatched", () => {
    // Structural: `handleOutboundFromInstance` is reached through a live unix
    // socket, and what matters is that the check happens before the handler is
    // looked up — not after it has already run.
    const source = readFileSync(new URL("../src/fleet-manager.ts", import.meta.url), "utf8");
    const fn = source.slice(source.indexOf("private async handleOutboundFromInstance"));
    const checkAt = fn.indexOf('this.checkToolPermission("ipc-outbound"');
    const dispatchAt = fn.indexOf("outboundHandlers.get(tool)");

    expect(checkAt).toBeGreaterThan(-1);
    expect(dispatchAt, "the tool is dispatched before it is checked").toBeGreaterThan(checkAt);
  });
});

describe("sink 2 — the typed IPC handlers", () => {
  it("is checked on the dispatch, before the handler runs", () => {
    const source = readFileSync(new URL("../src/fleet-manager.ts", import.meta.url), "utf8");
    const branch = source.slice(source.indexOf("msg.type in IPC_TYPE_TOOLS"), source.indexOf("instance_process_state"));

    expect(branch).toContain('this.checkToolPermission("ipc-typed"');
    const checkAt = branch.indexOf("checkToolPermission");
    const dispatchAt = branch.indexOf("dispatchTypedIpc");
    expect(dispatchAt, "dispatched before checked").toBeGreaterThan(checkAt);
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
   * Stage 1 records and then lets the call through, so an op that reaches a
   * real lifecycle handler will run it against a context that has no
   * lifecycle — and the resulting TypeError escapes as an unhandled rejection
   * rather than a failed assertion, turning a green report into a non-zero
   * exit. Which tool each op maps to is covered by the op-table tests; what
   * these need is a call that finishes.
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

  it("records an op the profile would refuse", async () => {
    // `schedule-create` is denied under `minimal` and its handler is stubbed
    // here, so the call completes instead of walking into a real one.
    const { warn } = await callAgent("schedule-create", "minimal");

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ sink: "agent-endpoint", instance: "worker", profile: "minimal", tool: "create_schedule", enforced: false }),
      expect.stringContaining("would be refused"),
    );
  });

  it("records the early-returning ops too, which never reach OP_MAP", async () => {
    // `task` is answered before the map is consulted, so a table built from the
    // map would never have seen it. `minimal` does not include it.
    const { warn } = await callAgent("task", "minimal");

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ sink: "agent-endpoint", tool: "task" }),
      expect.anything(),
    );
    // Still ran: stage 1 refuses nothing. (The handler is the stub above, so
    // reaching it at all is the evidence the call was not stopped.)
    expect(warn.mock.calls.some(c => (c[0] as { enforced?: boolean }).enforced === false)).toBe(true);
  });

  it("says nothing when the profile allows it", async () => {
    const { warn, result } = await callAgent("task", "full");

    expect(warn).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
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
