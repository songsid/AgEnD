import { readFileSync, existsSync } from "node:fs";
import yaml from "js-yaml";
import type { DaemonConfig } from "./types.js";

export const DEFAULT_CONFIG: DaemonConfig = {
  channel_plugin: "telegram@claude-plugins-official",
  working_directory: process.env.HOME || "~",
  restart_policy: {
    max_retries: 10,
    backoff: "exponential",
    reset_after: 300,
  },
  context_guardian: {
    threshold_percentage: 80,
    max_age_hours: 4,
    strategy: "hybrid",
  },
  memory: {
    auto_summarize: true,
    watch_memory_dir: true,
    backup_to_sqlite: true,
  },
  log_level: "info",
};

function deepMerge(target: DaemonConfig, source: Partial<DaemonConfig>): DaemonConfig {
  const result = { ...target } as Record<string, unknown>;
  const sourceRecord = source as Record<string, unknown>;

  for (const key of Object.keys(sourceRecord)) {
    const sourceVal = sourceRecord[key];
    const targetVal = result[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === "object" &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as DaemonConfig,
        sourceVal as Partial<DaemonConfig>,
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }
  return result as unknown as DaemonConfig;
}

export function loadConfig(configPath: string): DaemonConfig {
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = yaml.load(raw) as Partial<DaemonConfig> | null;
  if (!parsed) {
    return { ...DEFAULT_CONFIG };
  }
  return deepMerge(DEFAULT_CONFIG, parsed);
}
