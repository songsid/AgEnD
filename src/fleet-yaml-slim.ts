import { isDeepStrictEqual } from "node:util";
import { getEffectiveInstanceDefaults } from "./config.js";
import type { InstanceConfig, RawFleetConfig } from "./types.js";

/**
 * Instance identity/routing fields remain explicit even when they currently
 * equal a fleet default. Removing one of these makes the YAML harder to audit
 * and can change which external resource an instance represents.
 */
export const PRESERVED_INSTANCE_FIELDS = new Set([
  "working_directory",
  "topic_id",
  "channel_id",
  "general_topic",
  "description",
  "tags",
  "model",
  "backend",
  "backend_options",
  "display_name",
  "systemPrompt",
  "worktree_source",
  "profile",
]);

export type FleetConfigPath = Array<string | number>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectMatchingLeaves(
  value: unknown,
  inherited: unknown,
  path: FleetConfigPath,
  output: FleetConfigPath[],
): void {
  if (isRecord(value) && isRecord(inherited)) {
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(inherited, key)) {
        collectMatchingLeaves(child, inherited[key], [...path, key], output);
      }
    }
    return;
  }

  // Arrays are leaf values here: a partial array cannot inherit safely.
  if (isDeepStrictEqual(value, inherited)) output.push(path);
}

/** Return raw YAML leaf paths that are redundant with effective defaults. */
export function collectRedundantInstanceDefaultPaths(
  raw: RawFleetConfig,
): FleetConfigPath[] {
  const instances = raw.instances;
  if (!instances || !isRecord(instances)) return [];

  const effectiveDefaults = getEffectiveInstanceDefaults(
    (raw.defaults ?? {}) as Partial<InstanceConfig>,
  ) as Record<string, unknown>;
  const redundant: FleetConfigPath[] = [];

  for (const [name, instance] of Object.entries(instances)) {
    if (!isRecord(instance)) continue;
    for (const [key, value] of Object.entries(instance)) {
      if (PRESERVED_INSTANCE_FIELDS.has(key)) continue;
      if (!Object.prototype.hasOwnProperty.call(effectiveDefaults, key)) continue;
      collectMatchingLeaves(
        value,
        effectiveDefaults[key],
        ["instances", name, key],
        redundant,
      );
    }
  }

  return redundant;
}
