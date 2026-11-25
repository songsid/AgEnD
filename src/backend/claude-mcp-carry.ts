/**
 * M-3749: an agent's own MCP servers across a credential-profile switch.
 *
 * Claude Code keeps the MCP servers added with `claude mcp add` in its top-level config, `.claude.json`, under the
 * config dir a profile moves (`CLAUDE_CONFIG_DIR`): user scope in `mcpServers`, local scope (this folder only) in
 * `projects[<folder>].mcpServers`. A switch to another profile is another `.claude.json`, so those servers silently
 * stopped loading. A switch now merges them into the profile it switches to — a name the target already has is kept as
 * the target has it, never overwritten — and records what the agent had at that moment. Every launch then compares the
 * agent's servers with that record: anything that did not come along is told to the agent and listed in Needs you,
 * and stays listed until it is back or a person dismisses it.
 *
 * Only names leave this module: a server's entry (its command, args and env, which may hold a key) is copied from one
 * config file to the other, and never logged, recorded or returned.
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

/** Every `projects` key naming this folder, by any spelling (its real path, the unresolved path, a symlink to it). */
function equivalentKeys(cfg: Json, cwd: string): string[] {
  if (!cwd.trim() || !isObject(cfg.projects)) return [];
  const want = realOrResolved(cwd), literal = resolve(cwd);
  return Object.keys(cfg.projects).filter(key => key === literal || key === want || realOrResolved(key) === want);
}

/**
 * The one `projects` key Claude reads for this folder: its real path, falling back to the unresolved path (preTrust
 * trusts both for that reason). Present: that entry; absent: the real path, where a new entry goes.
 */
function effectiveKey(cfg: Json, cwd: string): string {
  const canonical = realOrResolved(cwd), literal = resolve(cwd);
  const projects = isObject(cfg.projects) ? cfg.projects : {};
  if (Object.hasOwn(projects, canonical)) return canonical;
  if (Object.hasOwn(projects, literal)) return literal;
  return canonical;
}

function serversOf(value: unknown): Json {
  if (!isObject(value) || !isObject(value.mcpServers)) return {};
  const out: Json = {};
  for (const [name, entry] of Object.entries(value.mcpServers)) if (isObject(entry)) out[name] = entry;
  return out;
}

export interface ClaudeMcpNames { user: string[]; local: string[] }

/** The user-scope and local-scope MCP server names Claude loads for this folder (its effective entry); null: unreadable. */
export function claudeMcpNames(jsonPath: string, cwd: string): ClaudeMcpNames | null {
  const cfg = readJson(jsonPath);
  if (!cfg) return null;
  const local = cwd.trim() && isObject(cfg.projects) ? Object.keys(serversOf(cfg.projects[effectiveKey(cfg, cwd)])) : [];
  return { user: Object.keys(serversOf(cfg)).sort(), local: local.sort() };
}

export type McpCarryResult =
  | { carried: true; user: string[]; local: string[]; keptTarget: string[] }
  | { carried: false; reason: string };

/**
 * Merge the source's user-scope and local-scope (this folder, any spelling) MCP servers into the target's `.claude.json`,
 * under its lock and by atomic rename (updateClaudeJson). Local servers go into the folder's real-path entry, the one
 * Claude reads once a launch's preTrust has created it;
 * a name the target already has — in that scope, under any spelling of the folder — stays the target's (`keptTarget`).
 * Nothing of the target is removed or changed. The same config file on both sides, or nothing to carry: nothing written.
 */
export function carryClaudeMcpServers(req: { fromProfileDir: string | null; toProfileDir: string | null; workingDirectory: string }): McpCarryResult {
  const fromPath = claudeJsonFor(req.fromProfileDir), toPath = claudeJsonFor(req.toProfileDir);
  if (resolve(fromPath) === resolve(toPath)) return { carried: false, reason: "same config file" };
  const source = readJson(fromPath);
  if (!source) return { carried: false, reason: "the previous profile's config could not be read" };
  const user = serversOf(source);
  // The source's local servers under every spelling of the folder; the one Claude reads wins a name clash.
  const local: Json = {};
  if (isObject(source.projects)) {
    const sourceProjects = source.projects;
    const keys = equivalentKeys(source, req.workingDirectory), first = effectiveKey(source, req.workingDirectory);
    for (const key of [first, ...keys.filter(k => k !== first)]) {
      for (const [name, entry] of Object.entries(serversOf(sourceProjects[key]))) if (!Object.hasOwn(local, name)) local[name] = entry;
    }
  }
  if (!Object.keys(user).length && !Object.keys(local).length) return { carried: true, user: [], local: [], keptTarget: [] };
  const added = { user: [] as string[], local: [] as string[] }, kept = new Set<string>();
  let looked = false;
  updateClaudeJson(cfg => {
    looked = true;
    if (Object.keys(user).length) {
      if (cfg.mcpServers === undefined) cfg.mcpServers = {};
      const into = cfg.mcpServers;
      for (const [name, entry] of Object.entries(user)) {
        if (!isObject(into) || Object.hasOwn(into, name)) { kept.add(name); continue; }
        into[name] = structuredClone(entry);
        added.user.push(name);
      }
    }
    if (Object.keys(local).length) {
      if (cfg.projects === undefined) cfg.projects = {};
      const projects = cfg.projects;
      const theirs = new Set<string>();
      if (isObject(projects)) for (const key of equivalentKeys(cfg, req.workingDirectory)) for (const n of Object.keys(serversOf(projects[key]))) theirs.add(n);
      // Always the real path: a launch's preTrust creates that entry, and from then on it is the one Claude reads. A
      // target that had the folder only under its unresolved spelling gets the real-path entry seeded with that entry's
      // own servers first, so its definitions stay loaded once the real-path entry exists (M-3749 review R2).
      const key = realOrResolved(req.workingDirectory), literal = resolve(req.workingDirectory);
      if (isObject(projects) && projects[key] === undefined) {
        const seed = key !== literal ? serversOf(projects[literal]) : {};
        projects[key] = Object.keys(seed).length ? { mcpServers: structuredClone(seed) } : {};
      }
      const entry = isObject(projects) ? projects[key] : undefined;
      if (isObject(entry) && entry.mcpServers === undefined) entry.mcpServers = {};
      const into = isObject(entry) ? entry.mcpServers : undefined;
      for (const [name, server] of Object.entries(local)) {
        if (!isObject(into) || theirs.has(name) || Object.hasOwn(into, name)) { kept.add(name); continue; }
        into[name] = structuredClone(server);
        added.local.push(name);
      }
    }
    return added.user.length + added.local.length > 0;
  }, req.toProfileDir);
  if (!looked) return { carried: false, reason: "the new profile's config is locked or unreadable" };
  return { carried: true, user: added.user.sort(), local: added.local.sort(), keptTarget: [...kept].sort() };
}

/** What a launch found missing: names the agent had under `fromConfigDir` and does not have now, since `since`. */
export interface McpMissing { names: string[]; fromConfigDir: string; toConfigDir: string; since: number }

const SEEN_FILE = "claude-mcp-seen.json";

interface SeenRecord {
  /** The config dir the names were read from, and the names (user + local scope) it had. */
  configDir: string | null;
  names: string[];
  /** Outstanding: names that did not come along to a later profile, and from which config dir; since when. */
  missing: Array<{ name: string; from: string }>;
  missingSince: number | null;
}

function readSeen(instanceDir: string): SeenRecord {
  let v: unknown = null;
  try { v = JSON.parse(readFileSync(join(instanceDir, SEEN_FILE), "utf8")); } catch { /* none yet */ }
  const o = isObject(v) ? v : {};
  const strings = (x: unknown) => Array.isArray(x) ? x.filter((n): n is string => typeof n === "string") : [];
  return {
    configDir: typeof o.configDir === "string" ? o.configDir : null,
    names: strings(o.names),
    missing: Array.isArray(o.missing) ? o.missing.filter((m): m is { name: string; from: string } => isObject(m) && typeof m.name === "string" && typeof m.from === "string") : [],
    missingSince: typeof o.missingSince === "number" ? o.missingSince : null,
  };
}

function writeSeen(instanceDir: string, record: SeenRecord): void {
  const path = join(instanceDir, SEEN_FILE), tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, path);
  } catch { try { unlinkSync(tmp); } catch { /* not written */ } }
}

const missingOf = (record: SeenRecord, toConfigDir: string): McpMissing | null => record.missing.length
  ? { names: record.missing.map(m => m.name).sort(), fromConfigDir: record.missing[record.missing.length - 1]!.from, toConfigDir, since: record.missingSince ?? Date.now() }
  : null;

/**
 * At a switch, before the carry: what the agent has in the profile it leaves NOW (servers added during its session
 * included), so the next launch can tell what did not come along even when the carry could not be written.
 * Outstanding names are kept. An unreadable source records nothing.
 */
export function recordClaudeMcpBeforeSwitch(req: { instanceDir: string; configDir: string; jsonPath: string; workingDirectory: string }): void {
  const names = claudeMcpNames(req.jsonPath, req.workingDirectory);
  if (!names) return;
  const record = readSeen(req.instanceDir);
  writeSeen(req.instanceDir, { ...record, configDir: resolve(req.configDir), names: [...new Set([...names.user, ...names.local])].sort() });
}

/**
 * At a launch: the agent's MCP server names now (user + local scope for its folder), against the record. A launch under
 * ANOTHER config dir than the record's (a profile switch) adds the names it lacks to the outstanding list; a server
 * removed under the same profile is the agent's own choice and is never reported. An outstanding name leaves the list
 * when it is back, or when dismissed (dismissClaudeMcpMissing). Returns the outstanding list, or null. An unreadable
 * config records nothing and keeps reporting what was outstanding.
 */
export function checkClaudeMcpAtLaunch(req: { instanceDir: string; configDir: string; jsonPath: string; workingDirectory: string; now?: number }): McpMissing | null {
  const configDir = resolve(req.configDir);
  const record = readSeen(req.instanceDir);
  const names = claudeMcpNames(req.jsonPath, req.workingDirectory);
  if (!names) return missingOf(record, configDir);
  const current = new Set([...names.user, ...names.local]);
  const missing = record.missing.filter(m => !current.has(m.name));
  if (record.configDir && record.configDir !== configDir) {
    for (const name of record.names) if (!current.has(name) && !missing.some(m => m.name === name)) missing.push({ name, from: record.configDir });
  }
  const since = missing.length ? (record.missing.length ? record.missingSince : null) ?? req.now ?? Date.now() : null;
  const next: SeenRecord = { configDir, names: [...current].sort(), missing, missingSince: since };
  writeSeen(req.instanceDir, next);
  return missingOf(next, configDir);
}

/** A person dismissed the outstanding list: it is forgotten (the names stay as they are now). */
export function dismissClaudeMcpMissing(instanceDir: string): void {
  const record = readSeen(instanceDir);
  if (!record.missing.length) return;
  writeSeen(instanceDir, { ...record, missing: [], missingSince: null });
}
