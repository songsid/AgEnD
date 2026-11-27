// M-3694 (S-264): General turns the task board on or off for every agent and sets its leader through
// update_fleet_defaults {task_board_on, task_board_leader} — defaults.dashboard.task_board (unset is on, false is off; an
// agent's own false stays) and defaults.task_board.leader (an instance of this fleet; null removes it).
import { describe, expect, it, vi } from "vitest";
import { outboundHandlers } from "../src/outbound-handlers.js";

function rig(defaults: Record<string, unknown> = {}) {
  const saveFleetConfig = vi.fn();
  const ctx: any = { fleetConfig: { defaults, instances: { general: { general_topic: true }, "dev-a": {}, quiet: { dashboard: { task_board: false } } } }, saveFleetConfig };
  const call = (patch: Record<string, unknown>) => new Promise<{ result: any; error?: string }>(resolve => {
    void outboundHandlers.get("update_fleet_defaults")!(ctx, { defaults: patch } as never, (result, error) => resolve({ result, error }), { instanceName: "general" } as never);
  });
  return { ctx, call, saveFleetConfig };
}

describe("M-3694 S-264: the task board's switch and leader", () => {
  it("on for every agent: a fleet-wide false goes; an agent's own off is named and stays", async () => {
    const r = rig({ dashboard: { task_board: false, appearance: false } });
    const { result } = await r.call({ task_board_on: true, task_board_leader: "dev-a" });
    expect(r.ctx.fleetConfig.defaults).toEqual({ dashboard: { appearance: false }, task_board: { leader: "dev-a" } });
    expect(result.notes).toEqual(["These keep it off by their own setting: quiet.", "Each agent's tool menu shows the change from its next start; the board itself follows at once."]);
    expect(r.ctx.fleetConfig.instances.quiet).toEqual({ dashboard: { task_board: false } });
    expect(r.saveFleetConfig).toHaveBeenCalledOnce();
  });

  it("off for every agent; the leader removed with null (empty maps go)", async () => {
    const r = rig({ task_board: { leader: "dev-a" } });
    await r.call({ task_board_on: false, task_board_leader: null });
    expect(r.ctx.fleetConfig.defaults).toEqual({ dashboard: { task_board: false } });
    await r.call({ task_board_on: true });
    expect(r.ctx.fleetConfig.defaults).toEqual({});                                                  // back to the default (on): no empty map left
  });

  it("a leader that isn't one of this fleet's instances: refused, nothing written", async () => {
    const r = rig({ dashboard: { task_board: false } });
    expect((await r.call({ task_board_on: true, model: "sonnet", task_board_leader: "nobody" })).error).toBe("Not changed: 'nobody' isn't one of this fleet's instances.");
    expect(r.ctx.fleetConfig.defaults).toEqual({ dashboard: { task_board: false } });
    expect(r.saveFleetConfig).not.toHaveBeenCalled();
  });
});
