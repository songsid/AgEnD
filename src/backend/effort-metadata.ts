import { codexMetadataHomes, readCodexEffortLevels } from "./codex-metadata.js";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
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

/**
 * Pure status/menu lookup: only existing Codex config/cache files, the CLI env cache and Grok's own model cache may be
 * read. `catalogProfile` is a claude-code credential profile whose own catalog is read first.
 */
export function readEffortMetadata(backend: string, instanceDir: string, model?: string | null, catalogProfile?: string | null): EffortMetadata {
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
  // The model's own levels when its catalog says (claude: the account API's `capabilities.effort`; grok: its
  // models_cache.json). `[]` is a model with no effort setting; null (no cache, an alias, a model it does not list)
  // keeps the backend's list.
  const own = backend === "claude-code" ? readClaudeEffortLevels(model ?? null, getAgendHome(), catalogProfile ?? null)
    : backend === "grok" ? readGrokEffortLevels(model ?? null) : null;
  if (own) return own.length > 0 ? { strategy: capability.strategy, levels: own } : { strategy: "unsupported", levels: [] };
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

/**
 * The levels one model of claude's account catalog (`GET /v1/models`) accepts, from its `capabilities.effort`: one
 * `{ supported }` per level. `[]`: the model has no effort setting (`effort.supported: false`, Haiku 4.5). Null: the
 * entry says nothing usable, so the caller keeps its own list.
 */
export function parseClaudeEffortCapability(capabilities: unknown): string[] | null {
  const effort = (capabilities as { effort?: unknown } | null | undefined)?.effort as Record<string, unknown> | null | undefined;
  if (!effort || typeof effort !== "object" || Array.isArray(effort) || typeof effort.supported !== "boolean") return null;
  if (!effort.supported) return [];
  const levels = CANONICAL_EFFORT.filter(level => (effort[level] as { supported?: unknown } | null | undefined)?.supported === true);
  return levels.length > 0 ? levels : null;
}

const safeCacheName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

/**
 * The effort levels claude takes for `model`, from the account catalog the CLI env probe cached
 * (`<AGEND_HOME>/cli-env/claude-code[@profile].json`, `apiModels`) while it is valid. The model's id matches
 * exactly (a `[1m]` suffix and the case aside): an alias (`opus`, `default`) names no one model, so it is null — and
 * null for a missing, stale or unreadable cache, or an entry without `effortLevels`. A pure file read.
 */
export function readClaudeEffortLevels(model: string | null, agendHome: string = getAgendHome(), profile: string | null = null): string[] | null {
  const id = model?.trim().replace(/\[1m\]$/i, "").toLowerCase();
  if (!id) return null;
  for (const file of profile ? [`claude-code@${safeCacheName(profile)}.json`, "claude-code.json"] : ["claude-code.json"]) {
    const levels = claudeCatalogLevels(join(agendHome, "cli-env", file)).get(id);
    if (levels) return levels;
  }
  return null;
}

/** Each model's effort levels (lower-cased id, `[1m]` stripped) of one cached claude catalog; empty while it is missing, stale or unreadable. */
function claudeCatalogLevels(path: string): Map<string, string[]> {
  const none = new Map<string, string[]>();
  try {
    const stat = statSync(path);
    let memo = claudeLevelsMemo.get(path);
    if (!memo || memo.size !== stat.size || memo.mtimeMs !== stat.mtimeMs) {
      const env = JSON.parse(readFileSync(path, "utf-8")) as { probedAt?: unknown; apiModels?: unknown };
      const levels = new Map<string, string[]>();
      if (typeof env?.probedAt === "number" && Array.isArray(env.apiModels)) {
        for (const m of env.apiModels as Array<{ id?: unknown; effortLevels?: unknown }>) {
          if (typeof m?.id !== "string" || !Array.isArray(m.effortLevels)) continue;
          levels.set(m.id.replace(/\[1m\]$/i, "").toLowerCase(), CANONICAL_EFFORT.filter(level => (m.effortLevels as unknown[]).includes(level)));
        }
      }
      memo = { size: stat.size, mtimeMs: stat.mtimeMs, probedAt: typeof env?.probedAt === "number" ? env.probedAt : 0, levels };
      claudeLevelsMemo.set(path, memo);
    }
    return Date.now() - memo.probedAt < CLI_ENV_TTL_MS ? memo.levels : none;
  } catch { return none; }                                         // no probe yet, or unreadable
}
const claudeLevelsMemo = new Map<string, { size: number; mtimeMs: number; probedAt: number; levels: Map<string, string[]> }>();

const GROK_CACHE_MAX_BYTES = 1024 * 1024;
let grokLevelsMemo: { path: string; size: number; mtimeMs: number; levels: Map<string, string[]> } | null = null;

/**
 * The effort levels a grok model takes: `info.reasoning_efforts` of its entry in grok's own `models_cache.json`
 * (`$GROK_HOME`, else `~/.grok`), which grok keeps fresh. `[]`: the entry says the model has no effort setting
 * (`supports_reasoning_effort: false`). Null: no readable cache, no such model, or an entry without a usable list.
 * `model` null reads grok's cached default model (the CLI env probe's `currentModel`). A bounded, synchronous read of
 * a regular file only (never a symlink, never more than 1 MiB), memoised by the file's size and mtime; it never
 * returns anything but level names (the cache also holds credentials).
 */
export function readGrokEffortLevels(model: string | null, grokHome: string = process.env.GROK_HOME?.trim() || join(homedir(), ".grok")): string[] | null {
  // No model, or the placeholder "default" (unresolved): the default model grok's CLI env probe cached.
  const named = model?.trim();
  const name = (named && named.toLowerCase() !== "default" ? named : null) || readCachedCurrentModel("grok");
  if (!name) return null;
  const path = join(grokHome, "models_cache.json");
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size < 1 || stat.size > GROK_CACHE_MAX_BYTES) return null;
    if (!grokLevelsMemo || grokLevelsMemo.path !== path || grokLevelsMemo.size !== stat.size || grokLevelsMemo.mtimeMs !== stat.mtimeMs) {
      const cache = JSON.parse(readFileSync(path, "utf-8")) as { models?: Record<string, { info?: Record<string, unknown> }> };
      const levels = new Map<string, string[]>();
      for (const [id, entry] of Object.entries(cache?.models && typeof cache.models === "object" ? cache.models : {})) {
        const info = entry?.info;
        if (!info || typeof info !== "object") continue;
        if (info.supports_reasoning_effort === false) { levels.set(id.toLowerCase(), []); continue; }
        if (!Array.isArray(info.reasoning_efforts)) continue;
        const offered = new Set(info.reasoning_efforts.map((e: unknown) => typeof e === "string" ? e : (e as { value?: unknown; id?: unknown } | null)?.value ?? (e as { id?: unknown } | null)?.id));
        const known = CANONICAL_EFFORT.filter(level => offered.has(level));
        if (known.length > 0) levels.set(id.toLowerCase(), known);
      }
      grokLevelsMemo = { path, size: stat.size, mtimeMs: stat.mtimeMs, levels };
    }
    return grokLevelsMemo.levels.get(name.toLowerCase()) ?? null;
  } catch { return null; }                                         // no cache, or unreadable
}

/** The default model a backend's CLI env probe cached (`currentModel`), while the cache is valid; else null. */
function readCachedCurrentModel(backend: string, agendHome: string = getAgendHome()): string | null {
  try {
    const env = JSON.parse(readFileSync(join(agendHome, "cli-env", `${safeCacheName(backend)}.json`), "utf-8")) as { probedAt?: unknown; currentModel?: unknown };
    if (typeof env?.probedAt !== "number" || Date.now() - env.probedAt >= CLI_ENV_TTL_MS) return null;
    return typeof env.currentModel === "string" && env.currentModel.trim() ? env.currentModel.trim() : null;
  } catch { return null; }
}
