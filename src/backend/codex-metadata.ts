import { measureSyncWork } from "../sync-work-attribution.js";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
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
        const config = readTomlTable(join(home, "config.toml"));
        if (config === undefined) continue;                            // no such file: the next home
        model = config === null ? null : tomlModel(config);             // a home that exists decides, unreadable or not
        break;
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

type TomlTable = Record<string, unknown>;
const isTable = (v: unknown): v is TomlTable => !!v && typeof v === "object" && !Array.isArray(v);

/** A TOML file's root table; undefined when there is no file, null when it cannot be read or parsed. */
function readTomlTable(path: string): TomlTable | null | undefined {
  let text: string;
  try { text = readFileSync(path, "utf-8"); } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null; }
  try { const parsed = parseToml(text); return isTable(parsed) ? parsed : null; } catch { return null; }
}

/**
 * #1813 review: the model a config table sets — its ROOT `model` key, read through the TOML structure (a `model = …`
 * line inside a multi-line string is text, not the key). Null when it sets none. A top-level `profile = "x"` is read
 * as older codex versions did (`[profiles.x] model`); codex 0.162.1 refuses a top-level `profile` at startup, so there
 * it decides nothing that launch would run.
 */
function tomlModel(config: TomlTable): string | null {
  const profileName = config.profile;
  if (typeof profileName === "string") {
    const profiles = isTable(config.profiles) ? config.profiles : undefined;
    const profile = profiles && Object.prototype.hasOwnProperty.call(profiles, profileName) ? profiles[profileName] : undefined;
    if (isTable(profile) && typeof profile.model === "string") return profile.model;
  }
  return typeof config.model === "string" ? config.model : null;
}

/**
 * #1813 review: the model a codex launch runs, or why it cannot be proven. A model given on the command line
 * (`-c model=…`) outranks every config file. Otherwise the instance's codex home `config.toml` (its CODEX_HOME), unless
 * a project `.codex/config.toml` could override it: codex loads a trusted project's files (AgEnD trusts every
 * instance's working directory) from the working directory up to the project root — the nearest directory holding one
 * of `project_root_markers` (default `.git`), else every ancestor. Any such file that sets another model, selects a
 * profile, or cannot be read makes the model unproven, and a launch passes no effort it cannot match to the model that
 * will run. A codex home's own config.toml met on the way (`~/.codex`) is the user layer, not a project file.
 * The walk starts from the PHYSICAL directory (#1813 review r2): tmux starts codex there (`-c <cwd>`, no `--cd`), and
 * codex walks the ancestors of its current_dir() — a symlinked working directory's lexical parents are not those. One
 * that cannot be resolved is unproven.
 */
export function resolveCodexLaunchModel(input: {
  isolatedHome: string; sharedHome: string; model?: string | null; workingDirectory?: string;
}): { model: string | null; proven: boolean } {
  const given = input.model?.trim();
  if (given) return { model: given, proven: true };
  let home: string | null = null;
  let markers = [".git"];
  for (const dir of [input.isolatedHome, input.sharedHome]) {
    const config = readTomlTable(join(dir, "config.toml"));
    if (config === undefined) continue;
    if (config === null) return { model: null, proven: false };
    home = tomlModel(config);
    const configured = config.project_root_markers;
    if (Array.isArray(configured) && configured.every(m => typeof m === "string")) markers = configured as string[];
    break;
  }
  const physical = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
  const homeConfigs = new Set([input.isolatedHome, input.sharedHome].map(dir => join(physical(dir), "config.toml")));
  if (input.workingDirectory) {
    let start: string;
    try { start = realpathSync(input.workingDirectory); } catch { return { model: home, proven: false }; }
    for (let dir = start; ; dir = dirname(dir)) {
      const file = join(dir, ".codex", "config.toml");
      const project = homeConfigs.has(file) ? undefined : readTomlTable(file);
      if (project === null) return { model: home, proven: false };
      if (project !== undefined) {
        if (typeof project.profile === "string") return { model: home, proven: false };
        if (typeof project.model === "string" && project.model !== home) return { model: home, proven: false };
      }
      if (markers.some(marker => existsSync(join(dir, marker)))) break;      // the project root: nothing above applies
      if (dirname(dir) === dir) break;
    }
  }
  return { model: home, proven: home !== null };
}
