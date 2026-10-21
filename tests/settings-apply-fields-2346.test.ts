/**
 * #2346: what Settings offers, the server takes at Apply — and each change says what it costs.
 * - The confirmation gate (prepareSettingsEffect, the HTTP path every Settings write goes through) refused six fields the
 *   page offers (400 unsupported_sensitive_effect): log_level, agent_mode, tool_set, cross_instance_visibility, tags,
 *   model_failover. Each now has a class: applied directly, or (tool_set: which tools an agent gets) shown and confirmed.
 *   defaults.startup.{concurrency, stagger_delay_ms} applied directly too (they only ever went to confirmation by name).
 * - The impact badges: defaults.locale needs AgEnD restarted (read once at startup); the spawn settings apply to the
 *   next start; guests and web authority come from the schema; a new connection starts at once while another runs.
 */
import { describe, expect, it } from "vitest";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { SettingsConfirmationError } from "../src/settings-confirmation.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { handleSettingsRequest } from "../src/settings-api.js";
// @ts-expect-error — a JS module of the app, with no types
import { DEFAULT_SCHEMA, impactOf, newConnectionImpact } from "../src/ui/settings-model.js";

const config = () => ({
  defaults: { backend: "claude-code" },
  channels: [{ id: "main", type: "telegram", mode: "topic", group_id: "-1001", bot_token_env: "BOT", access: { mode: "locked", allowed_users: ["1"] } }],
  instances: { dev: { working_directory: "/tmp/dev", backend: "codex", tags: ["web"] } },
});
/** The gate's answer for one write: "direct" (no confirmation), "confirm" (its summary lines), or the refusal code. */
function gate(method: string, path: string, body: unknown, cfg: any = config()): "direct" | string[] | string {
  try {
    const { diff } = prepareSettingsEffect(method, path, body, { config: cfg, classic: {} });
    return diff ? [...diff.summary] : "direct";
  } catch (e) {
    if (e instanceof SettingsConfirmationError) return `refused:${(e as any).code ?? e.message}`;
    throw e;
  }
}
const agent = (patch: unknown) => gate("PATCH", "/api/settings/fleet/instances/dev", patch);
const defaults = (patch: unknown) => gate("PUT", "/api/settings/fleet/defaults", patch);

describe("the six fields the gate refused", () => {
  it("an agent's log level, agent mode, bot-to-bot visibility, tags and fallback models apply directly", () => {
    expect([
      agent({ log_level: "debug" }), agent({ agent_mode: "cli" }), agent({ cross_instance_visibility: "hidden" }),
      agent({ tags: ["web", "review"] }), agent({ tags: [] }), agent({ model_failover: ["sonnet", "haiku"] }), agent({ model_failover: null }),
    ]).toEqual(["direct", "direct", "direct", "direct", "direct", "direct", "direct"]);
  });
  it("an agent's tool set is shown and confirmed (full: the fleet's own tools), never refused", () => {
    const res = agent({ tool_set: "full" });
    expect(Array.isArray(res) && res.some((l) => /tool\\?_set/.test(l) && /full/.test(l))).toBe(true);
  });
  it("the same fields as fleet defaults (General → Defaults / Advanced)", () => {
    expect([defaults({ log_level: "warn" }), defaults({ agent_mode: "cli" }), defaults({ cross_instance_visibility: "summary" })])
      .toEqual(["direct", "direct", "direct"]);
    const res = defaults({ tool_set: "minimal" });
    expect(Array.isArray(res) && res.some((l) => /tool\\?_set/.test(l) && /minimal/.test(l))).toBe(true);
  });
  it("the startup settings apply directly (read at each spawn); anything else under startup is still refused", () => {
    expect([defaults({ startup: { concurrency: 2 } }), defaults({ startup: { concurrency: 3, stagger_delay_ms: 500 } })]).toEqual(["direct", "direct"]);
    expect(String(defaults({ startup: { command: "rm -rf /" } }))).toMatch(/^refused:/);
  });
  it("a plain list stays plain: an item that is not a string, or a list under an access key, is never applied quietly", () => {
    expect(String(agent({ tags: [{ name: "x" }] }))).toMatch(/^refused:/);
    expect(String(agent({ model_failover: [1, 2] }))).toMatch(/^refused:/);
    // An allowed-users list is an id list: confirmed, as before (not a plain list).
    const access = gate("PUT", "/api/settings/fleet/channels", [{ ...config().channels[0], access: { mode: "locked", allowed_users: ["1", "2"] } }]);
    expect(Array.isArray(access)).toBe(true);
  });
});

describe("the impact badges", () => {
  const impacts = buildSettingsImpactSchema().impacts as Record<string, string>;
  it("the bot reply language needs AgEnD restarted; the spawn settings apply to the next start", () => {
    expect([impacts["defaults.locale"], impacts["fleet.spawn_concurrency"], impacts["fleet.spawn_stagger_ms"]]).toEqual(["fleet", "now", "now"]);
  });
  it("guests and web authority are in the schema (the page used to say 'now' itself)", () => {
    expect([impacts["web.guests"], impacts["web.verified_authority"]]).toEqual(["now", "now"]);
  });
  it("a new connection: 'now' while another one runs, the channels' own cost otherwise", () => {
    const schema = buildSettingsImpactSchema();
    expect([newConnectionImpact({ ...schema, connections_start_live: true }), newConnectionImpact({ ...schema, connections_start_live: false }),
      newConnectionImpact(undefined), impactOf(DEFAULT_SCHEMA, "fleet.channels")]).toEqual(["now", impacts["fleet.channels"], "instance", "instance"]);
  });
  it("the schema says whether a new connection starts at once (from the fleet)", async () => {
    const ask = async (live: boolean | undefined) => {
      let body: any = null;
      const res: any = { statusCode: 0, setHeader() {}, writeHead(code: number) { this.statusCode = code; }, end(text: string) { body = JSON.parse(text); } };
      const ctx: any = { fleetConfig: {}, connectionsStartLive: live === undefined ? undefined : () => live };
      handleSettingsRequest({ method: "GET", url: "/api/settings/schema", headers: {} } as any, res, new URL("http://127.0.0.1/api/settings/schema"), ctx);
      return body?.connections_start_live;
    };
    expect([await ask(true), await ask(false), await ask(undefined)]).toEqual([true, false, false]);
  });
});
