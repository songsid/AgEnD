/**
 * One source of truth for "what does changing this setting cost?".
 *
 * `HOT_INSTANCE_CONFIG_KEYS` is the authority: a hot key is pushed into a live
 * daemon over IPC (`Daemon.applyConfigUpdate`), anything else needs the CLI
 * process restarted. That knowledge used to be spelled out in five places —
 * the fleet manager, the settings API, twice in the settings page, and once per
 * field as a hand-written badge — so the four copies could drift away from the
 * one that decides what actually happens.
 *
 * Everything here is derived from the two sets below. The settings page reads
 * it from `GET /api/settings/schema` instead of carrying its own copy.
 */
import { isDeepStrictEqual } from "node:util";
import type { InstanceConfig } from "./types.js";

/** ⚡ applied to the running agent / 🔄 restart the agent / 🔄🔄 restart AgEnD. */
export type ConfigImpact = "now" | "instance" | "fleet";

/** Cheapest first. A batch of edits costs as much as its worst member. */
export const IMPACT_ORDER: readonly ConfigImpact[] = ["now", "instance", "fleet"];

/**
 * Instance settings a live daemon can take without a restart.
 *
 * Adding a key here is only half the change: `Daemon.applyConfigUpdate` has to
 * learn it too, or the setting is written to disk, reported as applied, and
 * silently ignored by the running agent. `tests/hot-cold-parity.test.ts` fails
 * when the two drift.
 */
export const HOT_INSTANCE_CONFIG_KEYS: ReadonlySet<keyof InstanceConfig> = new Set<keyof InstanceConfig>([
  "tool_progress",
  "reply_completion_guard",
  "mcp_proxy_reply",
  "auto_pause_after",
  "warm_cap",
  "display_name",
  "description",
  "tags",
  "log_level",
]);

/**
 * The hot keys a ClassicBot channel edit can use.
 *
 * Narrower than the fleet-wide set because a classic channel's hot path carries
 * exactly what `FleetManager.classicBehaviorUpdate()` builds; a key that is hot
 * for a fleet instance but absent from that payload (auto_pause_after) would be
 * dropped on the way. Derived, not re-listed: dropping a key from the hot set
 * drops it here too.
 */
export const CLASSIC_HOT_CONFIG_KEYS: ReadonlySet<string> = new Set(
  (["tool_progress", "reply_completion_guard"] as const)
    .filter(key => HOT_INSTANCE_CONFIG_KEYS.has(key)),
);

/**
 * Instance keys that are not the instance's own business: they change how the
 * fleet binds and routes the instance, so the fleet process has to restart.
 */
const FLEET_SCOPED_INSTANCE_KEYS: ReadonlySet<string> = new Set([
  "topic_id",
  "channel_id",
  "general_topic",
]);

/** Instance-scoped fields the settings page renders. */
const INSTANCE_FIELDS = [
  "display_name", "description", "backend", "model", "working_directory",
  "auto_pause_after", "warm_cap", "topic_id", "channel_id", "general_topic",
  "tool_progress", "reply_completion_guard", "mcp_proxy_reply", "log_level",
  "systemPrompt", "tags", "hang_detector", "agent_mode", "tool_set",
  "lightweight", "model_failover", "effort", "pre_task_command",
] as const;

/** ClassicBot channel fields the settings page renders. */
const CLASSIC_FIELDS = [
  "backend", "model", "auto_pause_after", "tool_progress",
  "reply_completion_guard", "collab", "context_lines", "pre_task_command",
] as const;

/**
 * Fleet-level fields, which no per-key rule can derive: they belong to the
 * fleet process or the channel binding rather than to an instance's config.
 */
const FLEET_FIELD_IMPACTS: Readonly<Record<string, ConfigImpact>> = {
  "defaults.locale": "now",
  "fleet.channels": "fleet",
  "fleet.channel.access.mode": "fleet",
  "fleet.channel.access.allowed_users": "fleet",
  "fleet.spawn_concurrency": "fleet",
  "fleet.spawn_stagger_ms": "fleet",
  "classic.admin_users": "fleet",
  "classic.allowed_guilds": "fleet",
  "instance.delete": "fleet",
};

/** Split a config into what a live daemon can take and what needs a restart. */
export function splitHotColdConfig(config: InstanceConfig): {
  hot: Partial<InstanceConfig>;
  cold: Partial<InstanceConfig>;
} {
  const hot: Partial<InstanceConfig> = {};
  const cold: Partial<InstanceConfig> = {};
  for (const [key, value] of Object.entries(config) as Array<[keyof InstanceConfig, InstanceConfig[keyof InstanceConfig]]>) {
    (HOT_INSTANCE_CONFIG_KEYS.has(key) ? hot : cold)[key] = value as never;
  }
  return { hot, cold };
}

/** The complete hot snapshot sent over IPC; absent values are explicit nulls so
 * the daemon removes them rather than keeping a stale override. */
export function hotConfigUpdate(config: InstanceConfig): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  for (const key of HOT_INSTANCE_CONFIG_KEYS) update[key] = config[key] ?? null;
  return update;
}

/**
 * What applying `next` to a running instance costs.
 *
 * The one comparison `reconcileInstances` makes when it decides between an IPC
 * hot update and a stop/start — shared so the apply job's plan says what the
 * reconcile will actually do rather than holding a second opinion about it.
 */
export function classifyInstanceChange(
  runtime: InstanceConfig,
  next: InstanceConfig,
): "restart" | "hot" | "none" {
  const before = splitHotColdConfig(runtime);
  const after = splitHotColdConfig(next);
  // Every field not explicitly classified hot is cold by default.
  if (!isDeepStrictEqual(before.cold, after.cold)) return "restart";
  if (!isDeepStrictEqual(before.hot, after.hot)) return "hot";
  return "none";
}

export function instanceFieldImpact(key: string): ConfigImpact {
  if (FLEET_SCOPED_INSTANCE_KEYS.has(key)) return "fleet";
  return HOT_INSTANCE_CONFIG_KEYS.has(key as keyof InstanceConfig) ? "now" : "instance";
}

export function classicFieldImpact(key: string): ConfigImpact {
  return CLASSIC_HOT_CONFIG_KEYS.has(key) ? "now" : "instance";
}

/**
 * Impact of one staged edit: hot only while every changed key is hot, since a
 * single cold key in the batch forces the restart anyway.
 */
export function batchImpact(keys: readonly string[], impactOf: (key: string) => ConfigImpact): ConfigImpact {
  let worst = 0;
  for (const key of keys) worst = Math.max(worst, IMPACT_ORDER.indexOf(impactOf(key)));
  return IMPACT_ORDER[worst]!;
}

export interface SettingsImpactSchema {
  /** field path → impact, e.g. `instance.tool_progress` → "now". */
  impacts: Record<string, ConfigImpact>;
  /** Escalation order, so the page can cost a batch without knowing the rule. */
  order: readonly ConfigImpact[];
}

/** The payload behind `GET /api/settings/schema`. */
export function buildSettingsImpactSchema(): SettingsImpactSchema {
  const impacts: Record<string, ConfigImpact> = { ...FLEET_FIELD_IMPACTS };
  for (const key of INSTANCE_FIELDS) {
    impacts[`instance.${key}`] = instanceFieldImpact(key);
    // Fleet defaults carry the same restart cost as the instance field they
    // seed — except the fleet-scoped ones, which are not defaults at all.
    if (!FLEET_SCOPED_INSTANCE_KEYS.has(key)) impacts[`defaults.${key}`] = instanceFieldImpact(key);
  }
  for (const key of CLASSIC_FIELDS) {
    impacts[`classic.${key}`] = classicFieldImpact(key);
    impacts[`classic_defaults.${key}`] = classicFieldImpact(key);
  }
  return { impacts, order: IMPACT_ORDER };
}
