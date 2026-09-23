import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { dispatchAgentOperation, ToolNotPermittedError } from "../src/agent-endpoint.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { DEFAULT_SCHEDULER_CONFIG } from "../src/scheduler/types.js";
import { scheduleOpRefusal, type ToolSetName } from "../src/tool-permissions.js";

/**
 * #895: every instance may schedule for ITSELF; scheduling for, or managing
 * the schedules of, ANOTHER instance stays with coordinators (full, coordinator,
 * general). The control is the schedule's target, decided in one place —
 * scheduleOpRefusal, called only by FleetManager.performScheduleOp — which both
 * faces reach: the typed IPC message MCP sends, and the agent endpoint that
 * agent-cli and HTTP agent mode use. #804 had to close its gap twice because
 * each face made its own check; these tests run the same cases through both.
 */

// ── the decision itself ──────────────────────────────────────────────────

describe("scheduleOpRefusal", () => {
  const own = { target: "w", source: "w" };
  const placedOnW = { target: "w", source: "coord" };
  const someoneElses = { target: "other", source: "other" };
  const cases: Array<[string, ToolSetName, "create" | "update" | "delete",
    Parameters<typeof scheduleOpRefusal>[3], boolean]> = [
    ["worker creates for itself",               "worker",   "create", { requestedTarget: "w" }, true],
    ["worker creates with no target",           "worker",   "create", {}, true],
    ["worker creates with an empty target",     "worker",   "create", { requestedTarget: "  " }, true],
    ["worker creates for another",              "worker",   "create", { requestedTarget: "other" }, false],
    ["standard creates for another",            "standard", "create", { requestedTarget: "other" }, false],
    ["worker updates its own",                  "worker",   "update", { existing: own }, true],
    ["worker updates another's",                "worker",   "update", { existing: someoneElses }, false],
    ["worker updates one a coordinator set",    "worker",   "update", { existing: placedOnW }, false],
    ["worker retargets its own onto another",   "worker",   "update", { existing: own, requestedTarget: "other" }, false],
    ["worker 'retargets' its own onto itself",  "worker",   "update", { existing: own, requestedTarget: "w" }, true],
    ["worker deletes its own",                  "worker",   "delete", { existing: own }, true],
    ["worker deletes another's",                "worker",   "delete", { existing: someoneElses }, false],
    ["worker deletes one a coordinator set",    "worker",   "delete", { existing: placedOnW }, false],
    ["coordinator creates for another",         "coordinator", "create", { requestedTarget: "other" }, true],
    ["general updates another's",               "general",  "update", { existing: someoneElses, requestedTarget: "w" }, true],
    ["full deletes another's",                  "full",     "delete", { existing: someoneElses }, true],
  ];
  for (const [name, profile, op, subject, allowed] of cases) {
    it(name, () => {
      const refusal = scheduleOpRefusal(profile, "w", op, subject);
      if (allowed) expect(refusal).toBeNull();
      else expect(refusal, "a refusal must say what to do instead").toContain("ask a coordinator");
    });
  }
});

// ── both faces, same cases, a real scheduler ─────────────────────────────

let dir: string;
let fm: FleetManager;
let scheduler: Scheduler;
const ipcSent: Array<Record<string, unknown>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agend-schedule-scope-"));
  fm = new FleetManager(dir);
  fm.fleetConfig = {
    defaults: {},
    instances: {
      w: { working_directory: "/tmp/w", tool_set: "worker" },
      other: { working_directory: "/tmp/o", tool_set: "worker" },
      coord: { working_directory: "/tmp/c", tool_set: "coordinator" },
    },
  } as never;
  scheduler = new Scheduler(join(dir, "scheduler.db"), () => {}, DEFAULT_SCHEDULER_CONFIG,
    name => name in (fm.fleetConfig!.instances as Record<string, unknown>));
  (fm as unknown as { scheduler: Scheduler }).scheduler = scheduler;
  ipcSent.length = 0;
  for (const name of ["w", "other", "coord"]) {
    (fm as unknown as { instanceIpcClients: Map<string, unknown> }).instanceIpcClients
      .set(name, { send: (m: Record<string, unknown>) => { ipcSent.push(m); return true; } });
  }
});
afterEach(() => {
  scheduler.shutdown?.();
  rmSync(dir, { recursive: true, force: true });
});

type Face = (caller: string, op: "create" | "update" | "delete", args: Record<string, unknown>) =>
  Promise<{ ok: boolean; result?: unknown; error?: string }>;

/**
 * MCP / channel.sock: the typed IPC message, answered on the caller's IPC.
 * `meta` carries no chat id, as for a worker that has only ever received
 * cross-instance messages — which is who #895 is for.
 */
const viaIpc: Face = async (caller, op, args) => {
  const before = ipcSent.length;
  (fm as unknown as { handleScheduleCrud: (n: string, m: unknown) => void })
    .handleScheduleCrud(caller, { type: `fleet_schedule_${op}`, fleetRequestId: "r1", payload: args, meta: {} });
  const reply = ipcSent.slice(before).find(m => m.type === "fleet_schedule_response")!;
  return reply.error ? { ok: false, error: String(reply.error) } : { ok: true, result: reply.result };
};

/** agent-cli / HTTP agent mode: the agent endpoint, which throws a 403 on refusal. */
const viaAgentEndpoint: Face = async (caller, op, args) => {
  try {
    const result = await dispatchAgentOperation(fm as never, caller, `schedule-${op}`, args);
    return { ok: true, result };
  } catch (err) {
    if (!(err instanceof ToolNotPermittedError)) throw err;
    return { ok: false, error: err.message };
  }
};

const seed = (source: string, target: string) =>
  scheduler.create({ cron: "0 9 * * *", message: "ping", source, target, reply_chat_id: "", reply_thread_id: null });

for (const [faceName, face] of [["MCP (typed IPC)", viaIpc], ["agent endpoint (CLI / HTTP)", viaAgentEndpoint]] as const) {
  describe(`schedule scope through the ${faceName}`, () => {
    it("lets a worker schedule for itself, with or without naming itself", async () => {
      expect((await face("w", "create", { cron: "*/30 * * * *", message: "heartbeat" })).ok).toBe(true);
      expect((await face("w", "create", { cron: "*/30 * * * *", message: "again", target: "w" })).ok).toBe(true);
      expect(scheduler.list().map(s => [s.source, s.target])).toEqual([["w", "w"], ["w", "w"]]);
    });

    it("refuses a worker scheduling work for another instance, and creates nothing", async () => {
      const r = await face("w", "create", { cron: "0 9 * * *", message: "do my work", target: "other" });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("ask a coordinator");
      expect(scheduler.list(), "a refusal must not leave a schedule behind").toHaveLength(0);
    });

    it("ignores a source in the request: the caller is who the server says it is", async () => {
      // The useful lie is not "I am the coordinator" but "I am the target":
      // claim to be `other`, and scheduling for `other` would be self-scheduling.
      const r = await face("w", "create", { cron: "0 9 * * *", message: "x", target: "other", source: "other" });
      expect(r.ok).toBe(false);
      const theirs = seed("other", "other");
      expect((await face("w", "delete", { id: theirs.id, source: "other" })).ok).toBe(false);
      expect(scheduler.get(theirs.id)).not.toBeNull();
    });

    it("refuses the two-step bypass: create for itself, then retarget", async () => {
      const mine = seed("w", "w");
      const r = await face("w", "update", { id: mine.id, target: "other" });
      expect(r.ok).toBe(false);
      expect(scheduler.get(mine.id)!.target, "the schedule must stay where it was").toBe("w");
    });

    it("lets a worker change and delete its own schedule", async () => {
      const mine = seed("w", "w");
      expect((await face("w", "update", { id: mine.id, message: "changed" })).ok).toBe(true);
      expect(scheduler.get(mine.id)!.message).toBe("changed");
      expect((await face("w", "delete", { id: mine.id })).ok).toBe(true);
      expect(scheduler.get(mine.id)).toBeNull();
    });

    it("refuses a worker changing or deleting another instance's schedule", async () => {
      const theirs = seed("other", "other");
      expect((await face("w", "update", { id: theirs.id, message: "hijacked" })).ok).toBe(false);
      expect((await face("w", "delete", { id: theirs.id })).ok).toBe(false);
      expect(scheduler.get(theirs.id)!.message).toBe("ping");
    });

    it("leaves a heartbeat a coordinator placed on a worker to the coordinator", async () => {
      const placed = seed("coord", "w");
      expect((await face("w", "delete", { id: placed.id })).ok).toBe(false);
      expect(scheduler.get(placed.id)).not.toBeNull();
      expect((await face("coord", "delete", { id: placed.id })).ok).toBe(true);
    });

    it("lets a coordinator schedule for, and manage, another instance", async () => {
      const r = await face("coord", "create", { cron: "0 9 * * *", message: "standup", target: "w" });
      expect(r.ok).toBe(true);
      const id = (r.result as { id: string }).id;
      expect((await face("coord", "update", { id, target: "other" })).ok).toBe(true);
      expect(scheduler.get(id)!.target).toBe("other");
    });
  });
}

describe("a schedule tool sent as fleet_outbound", () => {
  it("is not a schedule path at all — it ends as an unknown tool", async () => {
    // Pinned rather than assumed: fleet_outbound is sink 1, and if it ever grew
    // a create_schedule handler it would be a third face that skips
    // performScheduleOp. A real adapter is needed to get as far as the tool
    // lookup; without one the call stops at "No adapter available", which
    // would make this test pass while proving nothing.
    (fm as unknown as { worlds: Map<string, unknown> }).worlds.set("x", {} as never);
    (fm as unknown as { adapter: unknown }).adapter = { id: "x", type: "discord" };
    await (fm as unknown as { handleOutboundFromInstance: (n: string, m: unknown) => Promise<void> })
      .handleOutboundFromInstance("w", {
        type: "fleet_outbound", tool: "create_schedule", requestId: 1,
        args: { cron: "0 9 * * *", message: "x", target: "other" },
      });
    const reply = ipcSent.find(m => m.type === "fleet_outbound_response");
    expect(reply?.error).toBe("Unknown tool: create_schedule");
    expect(scheduler.list()).toHaveLength(0);
  });
});
