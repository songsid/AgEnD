// M-3694 (S-266): General reads any setting through get_fleet_config scope 'settings' — the Settings page's own read of
// fleet.yaml (everything but the agents), credentials redacted as Settings shows them; General only; read-only.
import { describe, expect, it } from "vitest";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { REDACTED_SECRET } from "../src/settings-redaction.js";

const fleet = () => ({
  channel: { type: "discord", mode: "topic", bot_token: "fake-inline-token", group_id: 1 },
  defaults: { backend: "claude-code", task_board: { leader: "dev-a" } },
  updates: { mode: "ask", pin: null },
  health_port: 19280,
  instances: { general: { general_topic: true }, "dev-a": { working_directory: "/w" } },
});
const call = (args: Record<string, unknown>, caller = "general") => new Promise<{ result: any; error?: string }>(resolve => {
  void outboundHandlers.get("get_fleet_config")!({ fleetConfig: fleet() } as never, args as never, (result, error) => resolve({ result, error }), { instanceName: caller } as never);
});

describe("M-3694 S-266: get_fleet_config scope 'settings'", () => {
  it("General reads everything but the agents, credentials redacted; nothing is written", async () => {
    const { result } = await call({ scope: "settings" });
    expect(result.settings).toEqual({ channel: { type: "discord", mode: "topic", bot_token: REDACTED_SECRET, group_id: 1 },
      defaults: { backend: "claude-code", task_board: { leader: "dev-a" } }, updates: { mode: "ask", pin: null }, health_port: 19280 });
    expect(JSON.stringify(result)).not.toContain("fake-inline-token");
    expect(result.settings).not.toHaveProperty("instances");
  });

  it("only General: another caller is told where the person reads them", async () => {
    expect((await call({ scope: "settings" }, "dev-a")).error).toBe("scope='settings' is General's; the person sees these in Settings.");
  });

  it("the other scopes are unchanged", async () => {
    expect((await call({})).result).toEqual({ defaults: { backend: "claude-code", task_board: { leader: "dev-a" } } });
    expect((await call({ scope: "instance", name: "dev-a" }, "dev-a")).result).toEqual({ name: "dev-a", config: { working_directory: "/w" } });
  });
});
