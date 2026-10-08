/**
 * One kiro agent per instance, and the shared workspace files it replaces (#906,
 * docs/design/kiro-per-instance-agent.md §1 and §4).
 *
 * Every write and every removal here is decided by evidence that AgEnD — this fleet, this instance — wrote the
 * thing, never by a name's shape: the user's agents, MCP servers and steering files, and another fleet's, are kept.
 *  - The agent file is ours only on a positive, canonical match: our name, and `mcpServers` with exactly this
 *    instance's keys, each run by this instance's own wrapper script.
 *  - A shared `mcp.json` entry is ours only when its command is one of this fleet's wrapper scripts.
 *  - A steering file is ours only when it carries this fleet's tag for this instance. Files written before the tag
 *    existed name an instance and a working directory but no fleet, so they are ambiguous and are kept.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { writeFileAtomic } from "./kiro-engine-ledger.js";

/** Instance names written as they are; any other name is hashed under a different prefix, so the two never meet. */
const PLAIN_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** This fleet, as 8 hex: two fleets (two AGEND_HOMEs) on one directory get different agents and tags. */
export function kiroFleetTag(agendHome: string): string {
  let home = resolve(agendHome);
  try { home = realpathSync(home); } catch { /* not created yet: the resolved path */ }
  return createHash("sha256").update(home).digest("hex").slice(0, 8);
}

/** `agend-<instance>-<fleet>`, or `agendx-<hash>-<fleet>` for a name outside PLAIN_NAME (they differ at char 6). */
export function kiroAgentName(instance: string, fleet: string): string {
  return PLAIN_NAME.test(instance)
    ? `agend-${instance}-${fleet}`
    : `agendx-${createHash("sha256").update(instance).digest("hex").slice(0, 16)}-${fleet}`;
}

export interface KiroAgentSpec {
  workingDirectory: string;
  instance: string;
  fleet: string;
  /** This instance's own directory: its wrapper scripts live there. */
  instanceDir: string;
  /** The MCP servers this instance runs, by server name (the `agend` server, …). */
  serverNames: string[];
}

export const kiroAgentPath = (spec: KiroAgentSpec): string =>
  join(spec.workingDirectory, ".kiro", "agents", `${kiroAgentName(spec.instance, spec.fleet)}.json`);

/** The shared-file key a server had before #906, and still has in the agent file (kiro keeps one of the two). */
export const kiroServerKey = (server: string, instance: string): string => `${server}-${instance}`;

export const kiroWrapperPath = (instanceDir: string, server: string): string => join(instanceDir, `mcp-wrapper-${server}.sh`);

/** This instance's servers, key → wrapper: the only map an agent file of ours can have. */
export function expectedKiroServers(spec: KiroAgentSpec): Record<string, string> {
  const map: Record<string, string> = {};
  for (const server of spec.serverNames) map[kiroServerKey(server, spec.instance)] = kiroWrapperPath(spec.instanceDir, server);
  return map;
}

/**
 * The same file, compared as written: an absolute path, normalized. A relative command means whatever kiro's own
 * working directory makes of it, which is never evidence that it is one of AgEnD's wrappers (#1416 review).
 */
const samePath = (a: unknown, b: string): boolean =>
  typeof a === "string" && isAbsolute(a) && isAbsolute(b) && normalize(a) === normalize(b);

/** The provenance line every agent file AgEnD writes carries: this fleet and this instance. */
export const kiroAgentDescription = (spec: KiroAgentSpec): string =>
  `AgEnD fleet instance ${spec.instance} (agend-fleet:${spec.fleet})`;

/**
 * Ours only on positive evidence, never on absence: our name, our provenance line, and every MCP server in it one of
 * THIS instance's own wrapper scripts under its own key (`<server>-<instance>` → `<instanceDir>/mcp-wrapper-<server>.sh`,
 * absolute). Which servers, and how many, may differ — an instance in CLI agent mode has none, and a mode switch
 * changes the set — but a sibling's wrapper, a relative command or any other entry is never ours.
 */
export function isOwnKiroAgent(value: unknown, spec: KiroAgentSpec): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.name !== kiroAgentName(spec.instance, spec.fleet) || v.description !== kiroAgentDescription(spec)) return false;
  const servers = v.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return false;
  const suffix = `-${spec.instance}`;
  return Object.entries(servers as Record<string, unknown>).every(([key, entry]) => {
    if (!key.endsWith(suffix) || key.length === suffix.length) return false;
    const server = key.slice(0, -suffix.length);
    const command = (entry as Record<string, unknown> | null)?.command;
    return samePath(command, kiroWrapperPath(spec.instanceDir, server));
  });
}

function readJson(path: string): { kind: "absent" } | { kind: "unreadable" } | { kind: "ok"; value: unknown } {
  let text: string;
  try { text = readFileSync(path, "utf-8"); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
  }
  try { return { kind: "ok", value: JSON.parse(text) }; } catch { return { kind: "unreadable" }; }
}

/** A file at our agent path that is not ours: never overwritten, so the launch is refused. */
export class KiroAgentConflictError extends Error {
  constructor(path: string) {
    super(`${path} exists and is not this AgEnD instance's agent; not overwriting it, so this kiro instance is not launched (#906)`);
    this.name = "KiroAgentConflictError";
  }
}

/** Write the instance's agent. Throws when it cannot, or when a file that is not ours is in the way. */
export function writeKiroAgent(spec: KiroAgentSpec, instructions: string | undefined): string {
  const path = kiroAgentPath(spec);
  const existing = readJson(path);
  if (existing.kind === "unreadable" || (existing.kind === "ok" && !isOwnKiroAgent(existing.value, spec))) {
    throw new KiroAgentConflictError(path);
  }
  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  for (const [key, command] of Object.entries(expectedKiroServers(spec))) mcpServers[key] = { command, args: [] };
  const agent = {
    name: kiroAgentName(spec.instance, spec.fleet),
    description: kiroAgentDescription(spec),
    prompt: instructions ?? null,
    mcpServers,
    tools: ["*"],
    allowedTools: [],
    resources: [],
    // The user's own MCP servers stay available; isolation comes from AgEnD's entries living only here (decided).
    includeMcpJson: true,
    // V3's own addition, so an auto-upgrading V3 has nothing to rewrite.
    permissions: { rules: [] },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(agent, null, 2) + "\n");
  return path;
}

/** Remove the agent file and V3's `.bak` of it, each only when it is ours. What was kept is returned, to be logged. */
export function removeKiroAgent(spec: KiroAgentSpec): { removed: string[]; kept: string[] } {
  const out = { removed: [] as string[], kept: [] as string[] };
  const path = kiroAgentPath(spec);
  for (const p of [path, `${path}.bak`]) {
    const file = readJson(p);
    if (file.kind === "absent") continue;
    if (file.kind === "ok" && isOwnKiroAgent(file.value, spec)) {
      try { unlinkSync(p); out.removed.push(p); } catch { out.kept.push(p); }
    } else {
      out.kept.push(p);
    }
  }
  return out;
}

// ── The shared workspace mcp.json (§4) ──

export type SharedFileOutcome = "written" | "unchanged" | "conflict" | "unreadable" | "failed";

const mcpJsonPath = (cwd: string): string => join(cwd, ".kiro", "settings", "mcp.json");

/**
 * The transition's old setup (§3): this instance's entries in the shared mcp.json, so a resumed `kiro_default`
 * conversation still has its AgEnD server until the switch to the agent is confirmed. A key is written only when it
 * is free — absent, or already this instance's own wrapper. A key run by anything else is a conflict and is kept.
 */
export function writeSharedKiroMcpEntries(spec: KiroAgentSpec): SharedFileOutcome {
  const path = mcpJsonPath(spec.workingDirectory);
  const file = readJson(path);
  if (file.kind === "unreadable") return "unreadable";
  let config: Record<string, unknown> = {};
  if (file.kind === "ok") {
    if (!file.value || typeof file.value !== "object" || Array.isArray(file.value)) return "unreadable";
    config = file.value as Record<string, unknown>;
  }
  const raw = config.mcpServers;
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) return "unreadable";
  const servers = { ...(raw as Record<string, unknown> | undefined) };
  let changed = false;
  let conflict = false;
  for (const [key, wrapper] of Object.entries(expectedKiroServers(spec))) {
    const current = Object.hasOwn(servers, key) ? servers[key] as Record<string, unknown> | undefined : undefined;
    if (current === undefined) { servers[key] = { command: wrapper, args: [] }; changed = true; continue; }
    if (!samePath(current?.command, wrapper)) conflict = true;
  }
  if (changed) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileAtomic(path, JSON.stringify({ ...config, mcpServers: servers }, null, 2));
    } catch { return "failed"; }
  }
  return conflict ? "conflict" : changed ? "written" : "unchanged";
}

/** A wrapper script of this fleet: `<instancesRoot>/<some instance>/mcp-wrapper-<server>.sh`. */
function fleetWrapperInstanceDir(command: unknown, instancesRoot: string): string | null {
  if (typeof command !== "string" || !isAbsolute(command)) return null;
  if (!/^mcp-wrapper-[^/]+\.sh$/.test(basename(command))) return null;
  const dir = resolve(dirname(command));
  return resolve(dirname(dir)) === resolve(instancesRoot) ? dir : null;
}

/**
 * Remove AgEnD from the shared mcp.json, by provenance only:
 *  - `own`: this instance's keys whose command is exactly its own wrapper (after a confirmed switch, and on cleanup);
 *  - any entry run by a wrapper of this fleet whose instance directory is gone.
 * Everything else — the user's servers, another fleet's — is kept. Written only when something changed.
 */
export function removeSharedKiroMcpEntries(spec: KiroAgentSpec, instancesRoot: string, own: boolean): SharedFileOutcome {
  const path = mcpJsonPath(spec.workingDirectory);
  const file = readJson(path);
  if (file.kind === "absent") return "unchanged";
  if (file.kind === "unreadable" || !file.value || typeof file.value !== "object" || Array.isArray(file.value)) return "unreadable";
  const config = file.value as Record<string, unknown>;
  const raw = config.mcpServers;
  if (raw === undefined) return "unchanged";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "unreadable";
  const servers = { ...(raw as Record<string, unknown>) };
  const expected = expectedKiroServers(spec);
  let changed = false;
  for (const [key, value] of Object.entries(servers)) {
    const command = (value as Record<string, unknown> | null)?.command;
    const mine = own && Object.hasOwn(expected, key) && samePath(command, expected[key]!);
    const gone = (() => { const dir = fleetWrapperInstanceDir(command, instancesRoot); return dir !== null && !existsSync(dir); })();
    if (mine || gone) { delete servers[key]; changed = true; }
  }
  if (!changed) return "unchanged";
  try { writeFileAtomic(path, JSON.stringify({ ...config, mcpServers: servers }, null, 2)); } catch { return "failed"; }
  return "written";
}

// ── Steering (§4) ──

export const kiroSteeringPath = (cwd: string, instance: string): string => join(cwd, ".kiro", "steering", `agend-${instance}.md`);

/** The first line of every steering file AgEnD writes from #906 on. */
export const kiroSteeringTag = (spec: KiroAgentSpec): string => `<!-- agend-agent:${kiroAgentName(spec.instance, spec.fleet)} -->`;

export type SteeringOwnership = "absent" | "ours" | "untagged-legacy" | "foreign" | "unreadable";

/**
 * Whose steering file this is. "untagged-legacy": written by AgEnD before the tag existed, for this instance and this
 * directory (its `# AgEnD Fleet Context` header says so) — but by which fleet cannot be told, so it is never ours.
 */
export function kiroSteeringOwnership(spec: KiroAgentSpec): SteeringOwnership {
  let text: string;
  try { text = readFileSync(kiroSteeringPath(spec.workingDirectory, spec.instance), "utf-8"); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
  if (text.split("\n", 1)[0] === kiroSteeringTag(spec)) return "ours";
  const header = `# AgEnD Fleet Context\nYou are **${spec.instance}**, an instance in an AgEnD fleet.\nYour working directory is \`${spec.workingDirectory}\`.`;
  return text.startsWith(header) ? "untagged-legacy" : "foreign";
}

/** The transition's steering (§3): written only when absent or already ours. An untagged one serves as it is. */
export function writeTaggedKiroSteering(spec: KiroAgentSpec, instructions: string): SharedFileOutcome | "untagged-legacy" {
  const ownership = kiroSteeringOwnership(spec);
  if (ownership === "unreadable") return "unreadable";
  if (ownership === "foreign") return "conflict";
  if (ownership === "untagged-legacy") return "untagged-legacy";
  const path = kiroSteeringPath(spec.workingDirectory, spec.instance);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, `${kiroSteeringTag(spec)}\n${instructions}`);
  } catch { return "failed"; }
  return "written";
}

/** Remove this instance's steering file only when it carries this fleet's tag. */
export function removeTaggedKiroSteering(spec: KiroAgentSpec): SteeringOwnership | "removed" | "failed" {
  const ownership = kiroSteeringOwnership(spec);
  if (ownership !== "ours") return ownership;
  try { unlinkSync(kiroSteeringPath(spec.workingDirectory, spec.instance)); } catch { return "failed"; }
  return "removed";
}
