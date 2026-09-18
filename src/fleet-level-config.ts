/**
 * Which fleet settings only a fresh process can adopt.
 *
 * The test is mechanical, not intuitive: **read once at construction and never
 * re-read by `reconcileInstances`**. "Feels fleet-level" is not the test —
 * `defaults.backend` feels fleet-level and is absorbed entirely by restarting
 * the agents.
 *
 * Getting this set wrong in the *narrow* direction is worse than not narrowing
 * at all. A startup-only key left out is saved to disk, produces no instance
 * restart and no fleet row, and therefore never takes effect and never tells
 * anyone — where an over-broad set only asks for a restart that was not needed.
 * `tests/fleet-level-config.test.ts` asserts both sides of the line so a new
 * key has to be classified deliberately.
 */
import type { FleetConfig } from "./types.js";

/**
 * Startup-only, with the construction site that consumes each one.
 *
 * `timezone` is deliberately absent: `detectLocale()` reads only
 * `defaults.locale` plus the host clock, and the configurable timezone lives
 * inside `defaults.cost_guard`, which is covered whole.
 */
export const STARTUP_ONLY_FLEET_KEYS = [
  "channel",                              // createAdapter() at startup
  "channels",                             // createAdapter() at startup
  "health_port",                          // startHealthServer(), once
  "defaults.locale",                      // setLocale(detectLocale(fleet)), once
  "defaults.cost_guard",                  // new CostGuard(...)
  "defaults.webhooks",                    // new WebhookEmitter(...)
  "defaults.daily_summary",               // new DailySummary(...)
  "defaults.scheduler.max_schedules",     // Scheduler ctor config
  "defaults.scheduler.default_timezone",  // Scheduler ctor config
] as const;

/**
 * Verified to be read at the point of use, so they must NOT be in the set above.
 *
 * Listed rather than implied: the enumeration test asserts their absence, which
 * is what stops the set from quietly growing back into "every cold default".
 */
export const RUNTIME_READ_FLEET_KEYS = [
  // Absorbed by restarting the agent.
  "defaults.backend",
  "defaults.model",
  "defaults.tool_set",
  "defaults.agent_mode",
  "defaults.hang_detector",
  // Read per spawn by the SpawnGate closures.
  "defaults.startup.concurrency",
  "defaults.startup.stagger_delay_ms",
  // Read per message / per post / per tick.
  "defaults.max_cross_instance_message_bytes",
  "defaults.tips",
  "defaults.progress_min_elapsed",
  // Read on every schedule trigger, unlike the two Scheduler ctor keys.
  "defaults.scheduler.retry_count",
  "defaults.scheduler.retry_interval_ms",
  // Read when the value is used; no construction captures them.
  "web",
  "hostname",
  "login",
  "web_terminal",
] as const;

function pick(source: unknown, path: string): unknown {
  let value: unknown = source;
  for (const segment of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/**
 * The fleet-level configuration as one comparable string.
 *
 * Built by walking a fixed key list, so the output is stable regardless of the
 * order keys appear in the YAML — two configs that differ only in key order
 * must not look like a pending restart.
 */
export function fleetLevelSignature(config: FleetConfig | null): string {
  const snapshot: Record<string, unknown> = {};
  for (const path of STARTUP_ONLY_FLEET_KEYS) {
    const value = pick(config, path);
    if (value !== undefined) snapshot[path] = value;
  }
  return JSON.stringify(snapshot);
}

/** The keys whose values differ between two configs — for the log line that
 * explains why a restart is being asked for, or why two signatures disagree. */
export function fleetLevelDifferences(a: FleetConfig | null, b: FleetConfig | null): string[] {
  return STARTUP_ONLY_FLEET_KEYS.filter(path =>
    JSON.stringify(pick(a, path) ?? null) !== JSON.stringify(pick(b, path) ?? null));
}
