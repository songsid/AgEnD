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
import { settingsChangeDiff } from "../src/settings-change.js";
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
  it("an agent's log level, agent mode, tags and fallback models apply directly; hiding its bot-to-bot messages too", () => {
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
      .toEqual(["direct", "direct", "direct"]);                    // summary narrows the default's full
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
    // Only an agent's own list or the defaults': never a child of an immediate key (review P3).
    expect([String(defaults({ startup: { tags: ["x"] } })), String(defaults({ startup: { model_failover: ["sonnet"] } }))].every((r) => r.startsWith("refused:"))).toBe(true);
    // An allowed-users list is an id list: confirmed, as before (not a plain list).
    const access = gate("PUT", "/api/settings/fleet/channels", [{ ...config().channels[0], access: { mode: "locked", allowed_users: ["1", "2"] } }]);
    expect(Array.isArray(access)).toBe(true);
  });
});

describe("bot-to-bot visibility is judged by what each agent gets (review P2-1)", () => {
  const modes = [undefined, "hidden", "summary", "full"] as const;
  const fleetWith = (dflt: string | undefined, own: string | undefined) => {
    const c: any = config();
    if (dflt !== undefined) c.defaults.cross_instance_visibility = dflt;
    if (own !== undefined) c.instances.dev.cross_instance_visibility = own; else delete c.instances.dev.cross_instance_visibility;
    return c;
  };
  const rank = { hidden: 0, summary: 1, full: 2 } as Record<string, number>;
  it("every change of the default and an agent's own mode: direct exactly when neither the agent's mode in effect nor the default's widens", async () => {
    const { crossInstanceVisibility } = await import("../src/cross-instance-notice.js");
    const wrong: string[] = [];
    for (const d0 of modes) for (const o0 of modes) for (const d1 of modes) for (const o1 of modes) {
      if (d0 === d1 && o0 === o1) continue;
      const before = fleetWith(d0, o0), after = fleetWith(d1, o1);
      const widens = rank[crossInstanceVisibility(after, "dev")]! > rank[crossInstanceVisibility(before, "dev")]!
        || rank[d1 ?? "full"]! > rank[d0 ?? "full"]!;
      // The whole fleet as the gate compares it (prepareSettingsEffect's last step): defaults and agent changed together.
      let res: unknown;
      try { res = settingsChangeDiff({ fleet: before, classic: {} }, { fleet: after, classic: {} }, { operation: "matrix" }) ? "confirm" : "direct"; }
      catch { res = "refused"; }
      if (res === "refused" || (res === "direct") === widens) wrong.push(`${d0}/${o0} → ${d1}/${o1}: ${res}${widens ? " (widens)" : ""}`);
    }
    expect(wrong).toEqual([]);
  });
  it("the agent dialog: hidden → full, and hidden → inherit (the default full), wait; full → hidden applies; a value the validator refuses waits", () => {
    const hiddenDev = () => { const c: any = config(); c.instances.dev.cross_instance_visibility = "hidden"; return c; };
    const toFull = gate("PATCH", "/api/settings/fleet/instances/dev", { cross_instance_visibility: "full" }, hiddenDev());
    const toInherit = gate("PATCH", "/api/settings/fleet/instances/dev", { cross_instance_visibility: null }, hiddenDev());
    expect([Array.isArray(toFull), Array.isArray(toInherit), agent({ cross_instance_visibility: "hidden" }), String(agent({ cross_instance_visibility: "everyone" }))])
      .toEqual([true, true, "direct", "refused:invalid_settings_effect"]);
    // Where no validator ran first (a caller comparing parts of a fleet), the diff itself never lets one through quietly.
    const odd = settingsChangeDiff({ instances: { dev: {} } }, { instances: { dev: { cross_instance_visibility: "everyone" } } }, { operation: "part" });
    expect(odd?.summary.some((l) => /everyone/.test(l))).toBe(true);
    const oddDefault = settingsChangeDiff({ defaults: {} }, { defaults: { cross_instance_visibility: "everyone" } }, { operation: "part" });
    expect(oddDefault?.summary.some((l) => /everyone/.test(l))).toBe(true);
  });
  it("the defaults: hidden → full waits (it shows every agent that inherits it, and every name with no setting)", () => {
    const hiddenDefault = () => { const c: any = config(); c.defaults.cross_instance_visibility = "hidden"; return c; };
    expect(Array.isArray(gate("PUT", "/api/settings/fleet/defaults", { cross_instance_visibility: "full" }, hiddenDefault()))).toBe(true);
  });
});

describe("a wider default names its inheritors on one line (review r2: within SETTINGS_DIFF_RECORDS)", () => {
  const many = (n: number, own?: string) => {
    const c: any = config();
    c.defaults.cross_instance_visibility = "hidden";
    c.instances = Object.fromEntries(Array.from({ length: n }, (_, i) => [`agent-${i + 1}`, { working_directory: `/tmp/a${i}`, ...(own ? { cross_instance_visibility: own } : {}) }]));
    return c;
  };
  for (const n of [30, 31, 45]) it(`${n} agents inherit hidden → full: confirmed, the default's line counts them (the operation and one line)`, () => {
    const res = gate("PUT", "/api/settings/fleet/defaults", { cross_instance_visibility: "full" }, many(n));
    expect(Array.isArray(res)).toBe(true);
    const lines = res as string[];
    expect([lines.length, lines[1]!.includes(`${n} agent(s) inherit it`), lines[1]!.includes(n > 5 ? `+${n - 5} more` : "")]).toEqual([2, true, true]);
  });
  it("45 agents set full on their own: only the default's own widening (it covers names with no setting)", () => {
    const res = gate("PUT", "/api/settings/fleet/defaults", { cross_instance_visibility: "full" }, many(45, "full")) as string[];
    expect([res.length, /inherit it/.test(res.join("\n"))]).toEqual([2, false]);
  });
  it("an agent's own change stays its own line beside the counted inheritors", () => {
    const before = { fleet: many(40), classic: {} };
    const after: any = structuredClone(before);
    after.fleet.defaults.cross_instance_visibility = "full";
    after.fleet.instances["agent-1"].cross_instance_visibility = "summary";        // own: hidden (inherited) → summary
    const diff = settingsChangeDiff(before, after, { operation: "mixed" })!;
    expect([diff.summary.length, diff.summary.filter((l) => /agent-1/.test(l) && /summary/.test(l)).length, diff.summary.some((l) => /39 agent\(s\) inherit it/.test(l))])
      .toEqual([3, 1, true]);
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
  it("the fleet answers as a live add would (review P2-2): a connection running and nothing else waiting for a restart", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const P = FleetManager.prototype as any;
    const fleet = (over: Record<string, unknown> = {}) => ({ ...config(), ...over }) as any;
    const fm = (startup: any, current: any, adapters: number) => ({
      startupFleetConfig: startup, fleetConfig: current, adapters: new Map(Array.from({ length: adapters }, (_, i) => [`a${i}`, {}])),
      canHotAddConnections: P.canHotAddConnections,
    });
    const live = (f: any) => P.connectionsStartLive.call(f) as boolean;
    const base = fleet();
    const pendingLocale = fleet({ defaults: { ...base.defaults, locale: "zh-TW" } });
    const pendingAccess = fleet({ channels: [{ ...base.channels[0], access: { mode: "open", allowed_users: [] } }] });
    expect([live(fm(base, structuredClone(base), 1)), live(fm(base, pendingLocale, 1)), live(fm(base, pendingAccess, 1)), live(fm(base, structuredClone(base), 0))])
      .toEqual([true, false, false, false]);
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
