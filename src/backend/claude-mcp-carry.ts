/**
 * M-3749: an agent's own MCP servers across a credential-profile switch.
 *
 * Claude Code keeps the MCP servers added with `claude mcp add` in its top-level config, `.claude.json`, under the
 * config dir a profile moves (`CLAUDE_CONFIG_DIR`): user scope in `mcpServers`, local scope (this folder only) in
 * `projects[<folder>].mcpServers`. A switch to another profile is another `.claude.json`, so those servers silently
 * stopped loading. A switch now merges them into the profile it switches to — a name the target already has is kept as
 * the target has it, never overwritten — and every launch compares what the agent had at its previous launch, under
 * another config dir, with what it has now, so anything still missing is told to the agent and listed in Needs you.
 *
 * Only names leave this module: a server's entry (its command, args and env, which may hold a key) is copied from one
 * config file to the other, and never logged or returned.
 */
import { readFileSync, realpathSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { claudeJsonPath, updateClaudeJson } from "./claude-code.js";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** `.claude.json` as Claude Code reads it for a config dir: a profile's own, or null for the default login (claudeJsonPath). */
export const claudeJsonFor = (profileDir: string | null): string => claudeJsonPath(profileDir);

function realOrResolved(path: string): string {
  const literal = resolve(path);
  try { return realpathSync(literal); } catch { return literal; }
}

/** The parsed file: `{}` when there is none (a new profile); null when it cannot be read or is not an object. */
function readJson(path: string): Json | null {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? {} : null; }
  try { const v: unknown = JSON.parse(raw); return isObject(v) ? v : null; } catch { return null; }
}

/** The `projects` keys naming this folder: Claude keys by the folder's real path, or its unresolved spelling (preTrust). */
function projectKeysFor(cfg: Json, cwd: string): string[] {
  if (!cwd.trim() || !isObject(cfg.projects)) return [];
  const want = realOrResolved(cwd), literal = resolve(cwd);
  return Object.keys(cfg.projects).filter(key => key === literal || key === want || realOrResolved(key) === want);
}

function serversOf(value: unknown): Json {
  if (!isObject(value) || !isObject(value.mcpServers)) return {};
  const out: Json = {};
  for (const [name, entry] of Object.entries(value.mcpServers)) if (isObject(entry)) out[name] = entry;
  return out;
}

export interface ClaudeMcpNames { user: string[]; local: string[] }

/** The user-scope and local-scope (this folder) MCP server names in a `.claude.json`; null when it cannot be read. */
export function claudeMcpNames(jsonPath: string, cwd: string): ClaudeMcpNames | null {
  const cfg = readJson(jsonPath);
  if (!cfg) return null;
  const local = new Set<string>();
  for (const key of projectKeysFor(cfg, cwd)) for (const name of Object.keys(serversOf((cfg.projects as Json)[key]))) local.add(name);
  return { user: Object.keys(serversOf(cfg)).sort(), local: [...local].sort() };
}

export type McpCarryResult =
  | { carried: true; user: string[]; local: string[]; keptTarget: string[] }
  | { carried: false; reason: string };

/**
 * Merge the source's user-scope and local-scope (this folder) MCP servers into the target's `.claude.json`, under its
 * lock and by atomic rename (updateClaudeJson). A name the target already has stays the target's (`keptTarget`); nothing
 * of the target is removed or changed. The same config file on both sides, or nothing to carry: nothing written.
 */
export function carryClaudeMcpServers(req: { fromProfileDir: string | null; toProfileDir: string | null; workingDirectory: string }): McpCarryResult {
  const fromPath = claudeJsonFor(req.fromProfileDir), toPath = claudeJsonFor(req.toProfileDir);
  if (resolve(fromPath) === resolve(toPath)) return { carried: false, reason: "same config file" };
  const source = readJson(fromPath);
  if (!source) return { carried: false, reason: "the previous profile's config could not be read" };
  const user = serversOf(source);
  const localByKey = new Map<string, Json>();
  for (const key of projectKeysFor(source, req.workingDirectory)) {
    const servers = serversOf((source.projects as Json)[key]);
    if (Object.keys(servers).length) localByKey.set(key, servers);
  }
  if (!Object.keys(user).length && !localByKey.size) return { carried: true, user: [], local: [], keptTarget: [] };
  const added = { user: new Set<string>(), local: new Set<string>() }, kept = new Set<string>();
  let wrote = false, looked = false;
  updateClaudeJson(cfg => {
    looked = true;
    const merge = (into: Json, from: Json, scope: "user" | "local") => {
      for (const [name, entry] of Object.entries(from)) {
        if (Object.hasOwn(into, name)) { kept.add(name); continue; }
        into[name] = structuredClone(entry);
        added[scope].add(name);
      }
    };
    if (Object.keys(user).length) {
      if (!isObject(cfg.mcpServers)) { if (cfg.mcpServers !== undefined) { for (const n of Object.keys(user)) kept.add(n); } else cfg.mcpServers = {}; }
      if (isObject(cfg.mcpServers)) merge(cfg.mcpServers, user, "user");
    }
    if (localByKey.size) {
      if (cfg.projects === undefined) cfg.projects = {};
      if (isObject(cfg.projects)) {
        const projects = cfg.projects;
        for (const [key, servers] of localByKey) {
          if (projects[key] === undefined) projects[key] = {};
          const entry = projects[key];
          if (!isObject(entry)) { for (const n of Object.keys(servers)) kept.add(n); continue; }
          if (entry.mcpServers === undefined) entry.mcpServers = {};
          if (!isObject(entry.mcpServers)) { for (const n of Object.keys(servers)) kept.add(n); continue; }
          merge(entry.mcpServers, servers, "local");
        }
      } else for (const servers of localByKey.values()) for (const n of Object.keys(servers)) kept.add(n);
    }
    wrote = added.user.size + added.local.size > 0;
    return wrote;
  }, req.toProfileDir);
  if (!looked) return { carried: false, reason: "the new profile's config is locked or unreadable" };
  return { carried: true, user: [...added.user].sort(), local: [...added.local].sort(), keptTarget: [...kept].sort() };
}

/** What a launch found missing: the names the agent had under `fromConfigDir` and does not have now. */
export interface McpMissing { names: string[]; fromConfigDir: string; toConfigDir: string; since: number }

const SEEN_FILE = "claude-mcp-seen.json";

/**
 * At a launch: the agent's MCP server names now (user + local scope for its folder), against those recorded at its
 * previous launch. Only a launch under ANOTHER config dir (a profile switch) can report names as missing — a server the
 * agent removed itself under the same profile is its own choice. Records the current names for the next launch. Null:
 * nothing missing, or the config could not be read (then nothing is recorded either).
 */
export function checkClaudeMcpAtLaunch(req: { instanceDir: string; configDir: string; jsonPath: string; workingDirectory: string; now?: number }): McpMissing | null {
  const names = claudeMcpNames(req.jsonPath, req.workingDirectory);
  if (!names) return null;
  const current = new Set([...names.user, ...names.local]);
  const seenPath = join(req.instanceDir, SEEN_FILE);
  let previous: { configDir?: unknown; names?: unknown } | null = null;
  try { const v: unknown = JSON.parse(readFileSync(seenPath, "utf8")); previous = isObject(v) ? v : null; } catch { previous = null; }
  const configDir = resolve(req.configDir);
  const previousDir = typeof previous?.configDir === "string" ? previous.configDir : null;
  const previousNames = Array.isArray(previous?.names) ? previous.names.filter((n): n is string => typeof n === "string") : [];
  const missing = previousDir && previousDir !== configDir ? previousNames.filter(n => !current.has(n)).sort() : [];
  const tmp = `${seenPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ configDir, names: [...current].sort() }), { mode: 0o600 });
    renameSync(tmp, seenPath);
  } catch { try { unlinkSync(tmp); } catch { /* not written */ } }
  return missing.length ? { names: missing, fromConfigDir: previousDir!, toConfigDir: configDir, since: req.now ?? Date.now() } : null;
}
