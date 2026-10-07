import { codexMetadataHomes, readCodexEffortLevels } from "./codex-metadata.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgendHome } from "../paths.js";
import { CLI_ENV_TTL_MS } from "./types.js";

/** Capability data shared with backend getters; resolving it never launches a CLI. */
export const EFFORT_CAPABILITIES = {
  "claude-code": { strategy: "runtime", levels: ["low", "medium", "high", "xhigh", "max"] },
  "kiro-cli": { strategy: "restart", levels: ["low", "medium", "high", "xhigh", "max"] },
  grok: { strategy: "runtime", levels: ["low", "medium", "high"] },
  antigravity: { strategy: "runtime", levels: ["low", "medium", "high"] },
  muse: { strategy: "runtime", levels: ["low", "medium", "high", "xhigh", "max"] },
  codex: { strategy: "restart" },
} as const;

export interface EffortMetadata {
  strategy: "runtime" | "restart" | "unsupported";
  levels: string[];
}

/** Pure status/menu lookup: only existing Codex config/cache files may be read. */
export function readEffortMetadata(backend: string, instanceDir: string): EffortMetadata {
  if (backend === "codex") {
    return { strategy: EFFORT_CAPABILITIES.codex.strategy, levels: readCodexEffortLevels(codexMetadataHomes(instanceDir)) };
  }
  if (backend === "antigravity") {
    // From the binary's own --help, via the CLI env probe's cache (agyEffortLevels); three levels until then.
    return { strategy: EFFORT_CAPABILITIES.antigravity.strategy, levels: agyEffortLevels() };
  }
  if (!Object.hasOwn(EFFORT_CAPABILITIES, backend)) return { strategy: "unsupported", levels: [] };
  const capability = EFFORT_CAPABILITIES[backend as Exclude<keyof typeof EFFORT_CAPABILITIES, "codex">];
  return { strategy: capability.strategy, levels: [...capability.levels] };
}

/** The effort levels agy accepts when its `--help` does not list them (agy before 1.3, or an unreadable help). */
export const AGY_FALLBACK_EFFORT_LEVELS: readonly string[] = ["low", "medium", "high"];
export const CANONICAL_EFFORT: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * The effort levels the installed agy takes: the `effortLevels` the CLI env probe read from its `--help` and cached
 * in `<AGEND_HOME>/cli-env/antigravity.json` (#1328), else the fallback. The cache counts only while it is valid
 * (CLI_ENV_TTL_MS, the same bound the fleet's own reader uses). A pure file read; never runs the CLI.
 */
export function agyEffortLevels(agendHome: string = getAgendHome()): string[] {
  try {
    const env = JSON.parse(readFileSync(join(agendHome, "cli-env", "antigravity.json"), "utf-8")) as { effortLevels?: unknown; probedAt?: unknown };
    const valid = typeof env.probedAt === "number" && Date.now() - env.probedAt < CLI_ENV_TTL_MS;
    const levels = valid && Array.isArray(env.effortLevels)
      ? CANONICAL_EFFORT.filter(level => (env.effortLevels as unknown[]).includes(level))
      : [];
    if (levels.length > 0) return levels;
  } catch { /* no probe yet, or unreadable */ }
  return [...AGY_FALLBACK_EFFORT_LEVELS];
}
