import { codexMetadataHomes, readCodexEffortLevels } from "./codex-metadata.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgendHome } from "../paths.js";
import { CLI_ENV_TTL_MS, cliBinaryIdentity } from "./types.js";

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
export function readEffortMetadata(backend: string, instanceDir: string, model?: string | null): EffortMetadata {
  if (backend === "codex") {
    // Codex's levels are per model (#1806 review): `model` when the caller knows which one runs, else config.toml's.
    return { strategy: EFFORT_CAPABILITIES.codex.strategy, levels: readCodexEffortLevels({ ...codexMetadataHomes(instanceDir), model: model ?? null }) };
  }
  if (backend === "antigravity") {
    // The model's own levels (#1825: one catalog model per level) that the binary's --help takes, via the CLI env
    // probe's cache; three levels until then.
    return { strategy: EFFORT_CAPABILITIES.antigravity.strategy, levels: agyModelEffortLevels(model ?? null) };
  }
  if (!Object.hasOwn(EFFORT_CAPABILITIES, backend)) return { strategy: "unsupported", levels: [] };
  const capability = EFFORT_CAPABILITIES[backend as Exclude<keyof typeof EFFORT_CAPABILITIES, "codex">];
  return { strategy: capability.strategy, levels: [...capability.levels] };
}

/** The effort levels agy accepts when its `--help` does not list them (agy before 1.3, or an unreadable help). */
export const AGY_FALLBACK_EFFORT_LEVELS: readonly string[] = ["low", "medium", "high"];
export const CANONICAL_EFFORT: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** The CLI env probe's cached agy state (`<AGEND_HOME>/cli-env/antigravity.json`), while it is valid; else null. */
export interface AgyCliEnv { models: { id: string; label: string }[]; currentModel: string | null; effortLevels: unknown[] | null }

/**
 * Valid: within the CLI env TTL, or — past it — while the binary the probe ran is the one installed: the file it
 * recorded (`binary`) is still at `binaryPath` (default: its own path) with the same size and mtime (#1825 review: the
 * fleet probes only at start, in the background, so a fleet up for a day, or one cold-started after a day, would
 * otherwise launch without the catalog). A stat, never a CLI run.
 */
export function readAgyCliEnv(agendHome: string = getAgendHome(), binaryPath?: string): AgyCliEnv | null {
  try {
    const env = JSON.parse(readFileSync(join(agendHome, "cli-env", "antigravity.json"), "utf-8")) as Record<string, unknown>;
    if (typeof env?.probedAt !== "number") return null;
    if (Date.now() - env.probedAt >= CLI_ENV_TTL_MS && !sameBinary(env.binary, binaryPath)) return null;
    const models = Array.isArray(env.models)
      ? env.models.filter((m): m is { id: string; label: string } => typeof m?.id === "string" && typeof m?.label === "string")
      : [];
    return {
      models,
      currentModel: typeof env.currentModel === "string" && env.currentModel.trim() ? env.currentModel.trim() : null,
      effortLevels: Array.isArray(env.effortLevels) ? env.effortLevels : null,
    };
  } catch { return null; }                                         // no probe yet, or unreadable
}

/** Whether the recorded binary is the file now at `binaryPath` (default: the recorded path): same size and mtime. */
function sameBinary(recorded: unknown, binaryPath?: string): boolean {
  const r = recorded as { path?: unknown; size?: unknown; mtimeMs?: unknown } | null;
  if (!r || typeof r.path !== "string" || typeof r.size !== "number" || typeof r.mtimeMs !== "number") return false;
  if (binaryPath !== undefined && binaryPath !== r.path) return false;
  const now = cliBinaryIdentity(r.path);
  return now !== null && now.size === r.size && now.mtimeMs === r.mtimeMs;
}

/**
 * The effort levels the installed agy takes: the `effortLevels` the CLI env probe read from its `--help` and cached
 * in `<AGEND_HOME>/cli-env/antigravity.json` (#1328), else the fallback. The cache counts only while it is valid
 * (CLI_ENV_TTL_MS, the same bound the fleet's own reader uses). A pure file read; never runs the CLI.
 */
export function agyEffortLevels(agendHome: string = getAgendHome()): string[] {
  const listed = readAgyCliEnv(agendHome)?.effortLevels ?? [];
  const levels = CANONICAL_EFFORT.filter(level => listed.includes(level));
  return levels.length > 0 ? levels : [...AGY_FALLBACK_EFFORT_LEVELS];
}

/**
 * #1825: agy's catalog (`agy models`) has one model per effort level — `gemini-3.8-flash-high` "Gemini 3.8 Flash
 * (High)", `…-medium`, `…-low` — and its /model picker shows them as one base with an Effort gauge. A model's family:
 * its base slug and the catalog's variants of it by level. `name` may be a variant's slug, its label (what agy's
 * settings.json and older configs hold), or the base slug itself. Null when the catalog has no variant of it (a model
 * with no levels, or one it does not list).
 */
export function agyModelFamily(
  name: string, catalog: readonly { id: string; label: string }[],
): { base: string; variants: Map<string, string> } | null {
  const variant = (id: string) => {
    const at = id.lastIndexOf("-");
    return at > 0 && CANONICAL_EFFORT.includes(id.slice(at + 1)) ? { base: id.slice(0, at), level: id.slice(at + 1) } : null;
  };
  const entry = catalog.find(m => m.id === name) ?? catalog.find(m => m.label === name);
  const base = entry ? variant(entry.id)?.base : name;
  if (!base) return null;
  const variants = new Map<string, string>();
  for (const level of CANONICAL_EFFORT) {
    const id = catalog.find(m => m.id === `${base}-${level}`)?.id;
    if (id) variants.set(level, id);
  }
  return variants.size > 0 ? { base, variants } : null;
}

/**
 * The levels agy offers for `model` (else the model agy's settings select, as the probe cached it): its family's
 * levels this binary takes. A model the catalog lists without levels has none; with no catalog, or a model it does
 * not list, the binary's levels (agyEffortLevels), as before.
 */
export function agyModelEffortLevels(model: string | null, agendHome: string = getAgendHome()): string[] {
  const env = readAgyCliEnv(agendHome);
  const takes = agyEffortLevels(agendHome);
  const name = model ?? env?.currentModel ?? null;
  if (!env || !name) return takes;
  const family = agyModelFamily(name, env.models);
  if (family) return takes.filter(level => family.variants.has(level));
  const listed = env.models.some(m => m.id === name || m.label === name);
  return listed ? [] : takes;
}
