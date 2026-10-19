import { measureSyncWork } from "../sync-work-attribution.js";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { getAgendHome } from "../paths.js";

export const CODEX_MODELS_CACHE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * #1956 item 2: what a codex file says, read and parsed once per version of the file. The fleet's status asks for every
 * codex instance's effort levels on every build (every open dashboard, every 10 s), and each ask parsed the whole
 * models_cache.json (hundreds of KB) again. The key is the file's stat — inode, size, mtime and ctime in nanoseconds —
 * so a rewritten or replaced file (or a chmod) is read again on the next ask. A file that can't be stat'd is never
 * cached (the caller answers as before), and a parse that throws is not kept (it is retried, as before).
 * "Racy" files (git's rule): a filesystem's clock is coarse, so two writes inside one tick can leave the same size,
 * mtime and ctime. A file is trusted from the cache only once its last change (the later of mtime and ctime: a chmod or a
 * touch moves only ctime) was at least FILE_SETTLED_MS old when it was read; one changed more recently than that is read
 * again on every ask until it has settled.
 */
const fileCache = new Map<string, { stamp: string; value: unknown; settled: boolean }>();
export const FILE_CACHE_MAX = 256;
export const FILE_SETTLED_MS = 1000;
/** The wall clock the files' times are compared with (a seam for tests: a file's ctime can't be set back). */
export const codexMetadataClock = { now: (): number => Date.now() };
function stamped<T>(kind: string, path: string, stat: import("node:fs").BigIntStats, read: () => T): T {
  const key = `${kind}:${path}`, stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const hit = fileCache.get(key);
  if (hit && hit.settled && hit.stamp === stamp) return hit.value as T;
  // The wall clock against the file's own times (both realtime).
  const settled = codexMetadataClock.now() - Math.max(Number(stat.mtimeMs), Number(stat.ctimeMs)) >= FILE_SETTLED_MS;
  const value = read();
  if (fileCache.size >= FILE_CACHE_MAX && !fileCache.has(key)) fileCache.clear();
  fileCache.set(key, { stamp, value, settled });
  return value;
}
/** For tests: forget every cached file. */
export function resetCodexMetadataCache(): void { fileCache.clear(); }

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
    const stat = statSync(cachePath, { bigint: true });
    if (stat.size > BigInt(CODEX_MODELS_CACHE_MAX_BYTES)) return { model, levels: null };
    // Each model's levels, as the first entry with its slug lists them (null: no models list at all).
    const bySlug = stamped("models", cachePath, stat, () => {
      const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as { models?: unknown };
      if (!Array.isArray(parsed.models)) return null;
      const out = new Map<string, string[] | null>();
      for (const m of parsed.models) {
        if (!m || typeof m !== "object") continue;
        const slug = (m as Record<string, unknown>).slug;
        if (typeof slug !== "string" || out.has(slug)) continue;
        const levels = ((m as Record<string, unknown>).supported_reasoning_levels as { effort?: unknown }[] | undefined)
          ?.map(l => l?.effort)
          .filter((e): e is string => typeof e === "string" && canonical.has(e));
        out.set(slug, levels?.length ? levels : null);
      }
      return out;
    });
    if (!bySlug) return { model, levels: null };
    const levels = bySlug.get(model) ?? null;
    return { model, levels: levels ? [...levels] : null };
  } catch {
    return { model, levels: null };
  }
}

type TomlTable = Record<string, unknown>;
const isTable = (v: unknown): v is TomlTable => !!v && typeof v === "object" && !Array.isArray(v);

/** A TOML file's root table; undefined when there is no file, null when it cannot be read or parsed. */
function readTomlTable(path: string): TomlTable | null | undefined {
  let stat: import("node:fs").BigIntStats;
  try { stat = statSync(path, { bigint: true }); } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null; }
  // #1956: parsed once per version of the file (see stamped); callers only read the table.
  return stamped("toml", path, stat, () => {
    let text: string;
    try { text = readFileSync(path, "utf-8"); } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null; }
    try { const parsed = parseToml(text); return isTable(parsed) ? parsed : null; } catch { return null; }
  });
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
