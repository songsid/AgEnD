import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fleetLevelDifferences,
  fleetLevelSignature,
  RUNTIME_READ_FLEET_KEYS,
  STARTUP_ONLY_FLEET_KEYS,
} from "../src/fleet-level-config.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import type { FleetConfig } from "../src/types.js";

const src = (file: string) => readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", file),
  "utf8",
);

function config(overrides: Record<string, unknown>): FleetConfig {
  return { defaults: {}, instances: {}, ...overrides } as FleetConfig;
}

describe("which fleet settings only a new process can adopt", () => {
  it("holds exactly the keys verified to be read once at construction", () => {
    // The register. Adding a startup-only setting without listing it here means
    // the change is saved, never applied, and never reported to anyone — which
    // is why this list is asserted exactly rather than as a subset.
    expect([...STARTUP_ONLY_FLEET_KEYS]).toEqual([
      "channel",
      "channels",
      "health_port",
      "defaults.locale",
      "defaults.cost_guard",
      "defaults.webhooks",
      "defaults.daily_summary",
      "defaults.scheduler.max_schedules",
      "defaults.scheduler.default_timezone",
      "web.preview_port",
      "web.preview_origin",
    ]);
  });

  it("keeps every runtime-read setting out of it", () => {
    // The other side of the line. Without this, the set can quietly grow back
    // into "every cold default" and start demanding restarts nothing needs.
    for (const key of RUNTIME_READ_FLEET_KEYS) {
      expect(STARTUP_ONLY_FLEET_KEYS as readonly string[], key).not.toContain(key);
    }
    expect(RUNTIME_READ_FLEET_KEYS).toContain("defaults.backend");
    expect(RUNTIME_READ_FLEET_KEYS).toContain("defaults.startup.concurrency");
    expect(RUNTIME_READ_FLEET_KEYS).toContain("defaults.max_cross_instance_message_bytes");
    expect(RUNTIME_READ_FLEET_KEYS).toContain("defaults.tips");
    expect(RUNTIME_READ_FLEET_KEYS).toContain("defaults.progress_min_elapsed");
    expect(RUNTIME_READ_FLEET_KEYS).toContain("web");
    expect(RUNTIME_READ_FLEET_KEYS).toContain("hostname");
    expect(RUNTIME_READ_FLEET_KEYS).toContain("login");
    expect(RUNTIME_READ_FLEET_KEYS).toContain("web_terminal");
  });

  it("splits defaults.scheduler, because only two of its keys reach the ctor", () => {
    // max_schedules/default_timezone are captured by the Scheduler instance;
    // the retry pair is read on every trigger, so a change takes effect live.
    expect(STARTUP_ONLY_FLEET_KEYS as readonly string[]).toContain("defaults.scheduler.max_schedules");
    expect(STARTUP_ONLY_FLEET_KEYS as readonly string[]).not.toContain("defaults.scheduler");
    expect(RUNTIME_READ_FLEET_KEYS as readonly string[]).toContain("defaults.scheduler.retry_count");
  });

  it("still sees the construction sites the classification is based on", () => {
    // If one of these moves to a reconcile, its key belongs on the other side —
    // this fails rather than leaving the set silently wrong.
    const fleet = src("fleet-manager.ts");
    expect(fleet).toContain("setLocale(detectLocale(fleet))");
    expect(fleet).toContain("new CostGuard(costGuardConfig");
    expect(fleet).toContain("new WebhookEmitter(webhookConfigs");
    expect(fleet).toContain("new DailySummary(summaryConfig");
    expect(fleet).toContain("this.scheduler = new Scheduler(");
    // …and the runtime reads that keep the other side out.
    expect(fleet).toContain("this.fleetConfig?.defaults?.startup?.concurrency");
    expect(src("outbound-handlers.ts")).toContain("defaults?.max_cross_instance_message_bytes");
  });
});

describe("the fleet-level signature", () => {
  it("moves for a startup-only key and not for a runtime-read one", () => {
    const base = config({ defaults: { locale: "en", backend: "claude-code" } });
    const runtimeChange = config({ defaults: { locale: "en", backend: "codex" } });
    const startupChange = config({ defaults: { locale: "zh-TW", backend: "claude-code" } });

    expect(fleetLevelSignature(runtimeChange)).toBe(fleetLevelSignature(base));
    expect(fleetLevelSignature(startupChange)).not.toBe(fleetLevelSignature(base));
  });

  it("#1056: a connection's status_emojis alone is not a pending restart; the rest of the connection still is", () => {
    const ch = { id: "dc", type: "discord", bot_token_env: "T", group_id: "1", options: { general_channel_id: "2" } };
    const base = config({ channels: [ch] });
    const emojis = config({ channels: [{ ...ch, options: { ...ch.options, status_emojis: { delivered: "🦉" } } }] });
    const general = config({ channels: [{ ...ch, options: { general_channel_id: "3" } }] });
    const legacy = config({ channel: { ...ch, options: { status_emojis: { delivered: "🦉" } } } });
    const legacyBase = config({ channel: { ...ch, options: {} } });
    expect(fleetLevelSignature(emojis)).toBe(fleetLevelSignature(base));
    expect(fleetLevelDifferences(base, emojis)).toEqual([]);
    expect(fleetLevelSignature(general)).not.toBe(fleetLevelSignature(base));
    expect(fleetLevelSignature(legacy)).toBe(fleetLevelSignature(legacyBase));
    expect(fleetLevelSignature(config({ channels: [{ ...ch, group_id: "9", options: { ...ch.options, status_emojis: { delivered: "🦉" } } }] })),
      "a binding change with it still is").not.toBe(fleetLevelSignature(base));
    // …and Settings says so: the edit's label matches what Apply will do (no "restart AgEnD" for it).
    expect(buildSettingsImpactSchema().impacts["fleet.channel.options.status_emojis"]).toBe("now");
    expect(buildSettingsImpactSchema().impacts["fleet.channels"]).toBe("fleet");
  });

  it("ignores key order, so a rewritten file is not a pending restart", () => {
    const a = config({ health_port: 1, defaults: { locale: "en", cost_guard: { daily_limit_usd: 5 } } });
    const b = config({ defaults: { cost_guard: { daily_limit_usd: 5 }, locale: "en" }, health_port: 1 });

    expect(fleetLevelSignature(a)).toBe(fleetLevelSignature(b));
  });

  it("covers health_port, which nothing used to report at all", () => {
    expect(fleetLevelSignature(config({ health_port: 19280 })))
      .not.toBe(fleetLevelSignature(config({ health_port: 19281 })));
  });

  it("covers the three constructed subsystems", () => {
    const base = config({ defaults: {} });
    for (const overrides of [
      { defaults: { cost_guard: { daily_limit_usd: 9 } } },
      { defaults: { webhooks: [{ url: "https://x", events: ["cost_limit"] }] } },
      { defaults: { daily_summary: { enabled: true } } },
    ]) {
      expect(fleetLevelSignature(config(overrides)), JSON.stringify(overrides))
        .not.toBe(fleetLevelSignature(base));
    }
  });

  it("names the keys that moved, for the log line", () => {
    const before = config({ defaults: { locale: "en" }, health_port: 1 });
    const after = config({ defaults: { locale: "zh-TW" }, health_port: 2 });

    expect(fleetLevelDifferences(before, after).sort()).toEqual(["defaults.locale", "health_port"]);
    expect(fleetLevelDifferences(before, before)).toEqual([]);
  });
});
