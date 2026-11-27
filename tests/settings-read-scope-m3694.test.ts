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

describe("#4561 F1: what an agent reads is redacted by shape too (webhooks, headers, URL userinfo and queries)", () => {
  const secretFleet = () => ({
    defaults: { backend: "claude-code", webhooks: [{ url: "https://discord.com/api/webhooks/123/fake-webhook-secret", events: ["crash"], headers: { Authorization: "Bearer fake-bearer-secret" } }] },
    web: { proxy: "https://fake-user:fake-pass@proxy.example.com:8443/path", callback: "https://hooks.example.com/notify?token=fake-query-secret", docs: "https://example.com/docs" },
    instances: { general: { general_topic: true }, worker: { mcp_url: "https://u:fake-instance-pass@mcp.example.com/" } },
  });
  const read = (args: Record<string, unknown>) => new Promise<{ result: any; error?: string }>(resolve => {
    void outboundHandlers.get("get_fleet_config")!({ fleetConfig: secretFleet() } as never, args as never, (result, error) => resolve({ result, error }), { instanceName: "general" } as never);
  });
  const SECRETS = ["fake-webhook-secret", "fake-bearer-secret", "fake-user", "fake-pass", "fake-query-secret", "fake-instance-pass", "/api/webhooks/123"];

  it("scope settings: none of the secret parts appear; the rest still reads", async () => {
    const { result } = await read({ scope: "settings" });
    const text = JSON.stringify(result);
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
    expect(result.settings.defaults.webhooks).toEqual([{ url: "https://discord.com/[redacted]", events: ["crash"], headers: { Authorization: "[redacted]" } }]);
    expect(result.settings.web).toEqual({ proxy: "https://[redacted]@proxy.example.com:8443/path", callback: "https://hooks.example.com/notify?[redacted]", docs: "https://example.com/docs" });
  });

  it("the defaults and instance scopes too (they carried webhooks and URLs before this)", async () => {
    for (const args of [{}, { scope: "instance", name: "worker" }]) {
      const text = JSON.stringify((await read(args)).result);
      for (const secret of SECRETS) expect(text, `${JSON.stringify(args)} ${secret}`).not.toContain(secret);
    }
  });
});

