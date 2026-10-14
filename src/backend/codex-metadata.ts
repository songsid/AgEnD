import { measureSyncWork } from "../sync-work-attribution.js";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgendHome } from "../paths.js";

export const CODEX_MODELS_CACHE_MAX_BYTES = 5 * 1024 * 1024;

/** The persistent short path only; never creates or migrates a home. */
export function codexShortHomeFor(instanceDir: string): string {
  const hash = createHash("sha256").update(resolve(instanceDir)).digest("hex").slice(0, 8);
  return join(getAgendHome(), "cx", hash);
}

/** Read the existing home before or after migration, without performing it. */
export function codexMetadataHomes(instanceDir: string): { isolatedHome: string; sharedHome: string } {
  const shortHome = codexShortHomeFor(instanceDir);
  const legacyHome = resolve(instanceDir, "codex-home");
  let isolatedHome = shortHome;
  // A real legacy directory is what a successful rename would preserve, and
  // what a failed rename still uses. An external legacy symlink is not a home
  // selected by resolveShortHome; do not follow it as a new metadata source.
  if (!existsSync(shortHome)) {
    try {
      if (lstatSync(legacyHome).isDirectory()) isolatedHome = legacyHome;
    } catch { /* not prepared yet: read shared config/cache instead */ }
  }
  return {
    isolatedHome,
    sharedHome: resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")),
  };
}

/** Same per-model account cache/config reader used by the backend and UI. */
export function readCodexEffortLevels(homes: {
  isolatedHome: string;
  sharedHome: string;
  model?: string | null;
}): string[] {
  return measureSyncWork("codex.effortMetadata", () => readCodexEffortLevelsSync(homes));
}
function readCodexEffortLevelsSync(homes: {
  isolatedHome: string;
  sharedHome: string;
  model?: string | null;
}): string[] {
  return readCodexModelEffortLevelsSync(homes).levels ?? ["low", "medium", "high", "xhigh"];
}

/**
 * #1811: the levels the model's catalog entry lists, and which model that was — `levels: null` when there is no model,
 * no readable cache or no entry for it (no fallback: a launch passes only a level the catalog lists).
 */
export function readCodexModelEffortLevels(homes: {
  isolatedHome: string;
  sharedHome: string;
  model?: string | null;
}): { model: string | null; levels: string[] | null } {
  return measureSyncWork("codex.effortMetadata", () => readCodexModelEffortLevelsSync(homes));
}
function readCodexModelEffortLevelsSync(homes: {
  isolatedHome: string;
  sharedHome: string;
  model?: string | null;
}): { model: string | null; levels: string[] | null } {
  const canonical = new Set(["low", "medium", "high", "xhigh", "max"]);
  let model = homes.model ?? null;
  try {
    if (!model) {
      for (const home of [homes.isolatedHome, homes.sharedHome]) {
        try {
          const match = readFileSync(join(home, "config.toml"), "utf-8")
            .match(/^model\s*=\s*"([^"]+)"/m);
          if (match) { model = match[1]!; break; }
        } catch { /* try the next home */ }
      }
    }
    if (!model) return { model, levels: null };
    const isolatedCache = join(homes.isolatedHome, "models_cache.json");
    const cachePath = existsSync(isolatedCache) ? isolatedCache : join(homes.sharedHome, "models_cache.json");
    if (statSync(cachePath).size > CODEX_MODELS_CACHE_MAX_BYTES) return { model, levels: null };
    const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return { model, levels: null };
    const entry = parsed.models.find((m): m is Record<string, unknown> =>
      !!m && typeof m === "object" && (m as Record<string, unknown>).slug === model);
    const levels = (entry?.supported_reasoning_levels as { effort?: unknown }[] | undefined)
      ?.map(l => l?.effort)
      .filter((e): e is string => typeof e === "string" && canonical.has(e));
    return { model, levels: levels?.length ? levels : null };
  } catch {
    return { model, levels: null };
  }
}
