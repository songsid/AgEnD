/** Classic CLI policy control. This is not an OS boundary against same-user processes. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLASSIC_RESTRICTED_TOOLS, type ContactGuardStatus, type ContactRoomTool } from "./contact-auth-types.js";
import type { McpServerEntry } from "./backend/types.js";

export interface ClassicRestrictedPlan {
  roomKey: string;
  policyRevision: number;
  allowedAgendTools: readonly string[];
  publicRead: boolean;
  allowedMcpTools: readonly ContactRoomTool[];
}
export interface ClassicRestrictionInput {
  mode: "legacy" | "restricted";
  roomTools: { publicRead: boolean; allowedMcpTools: readonly ContactRoomTool[] };
  policyRevision?: number;
}
/** Guard evidence is version-specific; an upgrade never inherits an unproved ready claim. */
export const CLASSIC_GUARD_CLAUDE_VERSIONS = ["2.1.295", "2.1.327"] as const;
export const CLASSIC_GUARD_MINIMUM = "2.1.295";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export const classicGuardInventory = (status: ContactGuardStatus) => ({ ...status, wouldDisable: [] as string[], impactComplete: false });
const reason = (state: ContactGuardStatus["state"], why: string): ContactGuardStatus => classicGuardInventory({ state, backend: "claude-code", reason: why });
const put = (path: string, text: string) => { const temp = `${path}.${randomUUID()}.tmp`; writeFileSync(temp, text, { mode: 0o600 }); renameSync(temp, path); };

export function classicPlanDigest(plan: ClassicRestrictedPlan): string {
  if (!plan || typeof plan.roomKey !== "string" || !plan.roomKey || plan.roomKey.length > 512 || /[\x00-\x1f]/.test(plan.roomKey)
    || !Number.isSafeInteger(plan.policyRevision) || plan.policyRevision < 0 || typeof plan.publicRead !== "boolean"
    || !Array.isArray(plan.allowedAgendTools) || plan.allowedAgendTools.length > CLASSIC_RESTRICTED_TOOLS.length
    || plan.allowedAgendTools.some(t => !CLASSIC_RESTRICTED_TOOLS.includes(t))
    || new Set(plan.allowedAgendTools).size !== plan.allowedAgendTools.length
    || !Array.isArray(plan.allowedMcpTools) || plan.allowedMcpTools.length > 128
    || plan.allowedMcpTools.some(t => !t || t.kind !== "mcp" || typeof t.usesOwnerAccount !== "boolean"
      || !/^mcp__[A-Za-z0-9_-]{1,100}__[A-Za-z0-9_.-]{1,128}$/.test(t.name) || t.name.startsWith("mcp__agend__")
      || t.accountWarning !== undefined && (typeof t.accountWarning !== "string" || t.accountWarning.length > 1024)
      || t.usesOwnerAccount && (typeof t.accountWarning !== "string" || !t.accountWarning.trim()))
    || new Set(plan.allowedMcpTools.map(t => t.name)).size !== plan.allowedMcpTools.length) throw Error("invalid-policy");
  return sha(JSON.stringify({ room: plan.roomKey, revision: plan.policyRevision, publicRead: plan.publicRead,
    agend: [...plan.allowedAgendTools].sort(), mcp: plan.allowedMcpTools.map(t => ({ name: t.name, usesOwnerAccount: t.usesOwnerAccount,
      accountWarning: t.accountWarning ?? "" })).sort((a, b) => a.name.localeCompare(b.name)) }));
}

/** Invalidating the shared launch pointer also fences old hooks after a policy change or restart. */
export function invalidateClassicGuard(instanceDir: string): void {
  const root = join(instanceDir, "classic-cli-guard");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  put(join(root, "current.json"), JSON.stringify({ invalidated: randomUUID() }));
}

/** Only explicitly selected owner-level stdio definitions; never project settings or repository .mcp.json. */
export function classicOwnerMcpServers(plan: ClassicRestrictedPlan, ownerFile: string,
  configured: Record<string, McpServerEntry>): Record<string, McpServerEntry> {
  classicPlanDigest(plan);
  const servers = { ...configured };
  if (!plan.allowedMcpTools.length) return servers;
  let definitions: Record<string, unknown>;
  try {
    const value = JSON.parse(bounded(ownerFile));
    if (!value.mcpServers || typeof value.mcpServers !== "object" || Array.isArray(value.mcpServers)
      || Object.keys(value.mcpServers).length > 128) return servers;
    definitions = value.mcpServers;
  } catch { return servers; }
  for (const tool of plan.allowedMcpTools) {
    if (Object.keys(configured).some(n => tool.name.startsWith(`mcp__${n}__`))) continue;
    // Unknown external code acts under the owner's account, even without a visible token in this file.
    if (!tool.usesOwnerAccount || !tool.accountWarning?.trim()) continue;
    const names = Object.keys(definitions).filter(n => n !== "agend" && /^[A-Za-z0-9_-]{1,100}$/.test(n) && tool.name.startsWith(`mcp__${n}__`));
    if (names.length !== 1) continue;
    const name = names[0]!, entry = definitions[name] as Partial<McpServerEntry> & { type?: unknown } | null;
    if (["__proto__", "constructor", "prototype"].includes(name)) continue;
    if (!entry || typeof entry !== "object" || entry.type !== undefined && entry.type !== "stdio"
      || typeof entry.command !== "string" || !entry.command || entry.command.length > 4096 || entry.command.includes("\0")
      || entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.length > 256 || entry.args.some(a => typeof a !== "string" || a.length > 4096 || a.includes("\0")))
      || entry.env !== undefined && (!entry.env || typeof entry.env !== "object" || Array.isArray(entry.env)
        || Object.keys(entry.env).length > 128 || Object.entries(entry.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)
          || typeof v !== "string" || v.length > 16_384 || v.includes("\0")))) continue;
    servers[name] = { command: entry.command, args: entry.args ? [...entry.args] : [], env: { ...entry.env } };
  }
  return servers;
}

/** Self-contained Node hook: no child commands, network, package lookup or credentials. */
export const CLASSIC_GUARD_HOOK = String.raw`"use strict";
const fs = require("node:fs"), crypto = require("node:crypto");
const {BlockList,isIP} = require("node:net");
// Literal-target checks only: no DNS lookup, redirect inspection or network sandbox.
const private4 = new BlockList(), private6 = new BlockList(), global6 = new BlockList();
for (const [address,prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],
  ["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],
  ["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]]) private4.addSubnet(address,prefix,"ipv4");
global6.addSubnet("2000::",3,"ipv6");
for (const [address,prefix] of [["2001::",23],["2001:db8::",32],["2002::",16],["3fff::",20]]) private6.addSubnet(address,prefix,"ipv6");
const publicTarget = value => { try {
  if (typeof value !== "string" || value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value)) return false;
  const url = new URL(value);
  if (!["https:","http:"].includes(url.protocol) || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/,"").replace(/^\[|\]$/g,"");
  const family = isIP(host);
  if (family === 4) return !private4.check(host,"ipv4");
  if (family === 6) return global6.check(host,"ipv6") && !private6.check(host,"ipv6");
  if (!host.includes(".") || host.length > 253 || host.split(".").some(x => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x))) return false;
  return !["localhost","local","localdomain","internal","intranet","lan","home","corp","private","test","invalid","example","onion","arpa"]
    .some(s => host === s || host.endsWith("." + s));
} catch { return false; } };
const hash = s => crypto.createHash("sha256").update(s).digest("hex");
const read = path => { const s = fs.lstatSync(path); if (!s.isFile() || s.size > 262144) throw Error("guard-file"); return fs.readFileSync(path,"utf8"); };
const deny = () => { process.stderr.write("Restricted room: tool or launch policy refused.\n"); process.exit(2); };
let input = "";
process.stdin.on("error", deny);
process.stdin.on("data", chunk => { input += chunk; if (input.length > 1048576) deny(); });
process.stdin.on("end", () => { try {
  const policyText = read(process.argv[2]), p = JSON.parse(policyText), event = JSON.parse(input), now = JSON.parse(read(p.current));
  if (now.launch !== p.launch || now.digest !== p.digest || hash(read(p.settings)) !== p.settingsSha
    || now.policySha !== hash(policyText) || hash(read(p.mcp)) !== p.mcpSha
    || hash(read(__filename)) !== p.hookSha || typeof event.session_id !== "string" || !event.session_id
    || event.cwd !== p.cwd) return deny();
  if (event.hook_event_name === "SessionStart") {
    const tmp = p.receipt + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ launch:p.launch,digest:p.digest,session:event.session_id }), {mode:384});
    fs.renameSync(tmp,p.receipt); return;
  }
  const receipt = JSON.parse(read(p.receipt));
  if (receipt.launch !== p.launch || receipt.digest !== p.digest || receipt.session !== event.session_id) return deny();
  if (event.hook_event_name === "UserPromptSubmit") return;
  if (event.hook_event_name !== "PreToolUse" || !p.allowed.includes(event.tool_name)) return deny();
  if (event.tool_name === "WebFetch" && !publicTarget(event.tool_input?.url)) {
    process.stderr.write("Restricted room: WebFetch requires a public HTTP(S) target.\n"); return deny();
  }
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:"Restricted room exact tool policy"}}));
} catch { deny(); } });
`;

export interface ClassicGuardLaunch {
  digest: string;
  launch: string;
  settingsPath: string;
  mcpPath: string;
  policyPath: string;
  hookPath: string;
  receiptPath: string;
  currentPath: string;
  settingsSha: string;
  policySha: string;
  mcpSha: string;
  tools: string[];
  uncoveredReason?: string;
}

/** Stages only an already-proved backend/version/configuration. No CLI is started by this function. */
export function stageClaudeClassicGuard(input: {
  plan: ClassicRestrictedPlan; version: string | null; platform: NodeJS.Platform; architecture?: string; agentMode?: "mcp" | "cli";
  instanceDir: string; cwd: string; mcpServers: Record<string, McpServerEntry>; settings: Record<string, unknown>;
}): { status: ContactGuardStatus; launch?: ClassicGuardLaunch } {
  if (input.platform !== "linux" || (input.architecture ?? process.arch) !== "x64") return { status: reason("not-covered", "unsupported-platform") };
  if (input.agentMode === "cli") return { status: reason("not-covered", "cli-mode") };
  if (!CLASSIC_GUARD_CLAUDE_VERSIONS.includes(input.version as typeof CLASSIC_GUARD_CLAUDE_VERSIONS[number]))
    return { status: reason("not-covered", "unsupported-version") };
  let digest: string;
  try { digest = classicPlanDigest(input.plan); } catch { return { status: reason("failed", "invalid-policy") }; }
  if (!input.mcpServers.agend) return { status: reason("failed", "missing-bound-mcp") };
  const bound = input.mcpServers.agend;
  const servers: Record<string, McpServerEntry> = { agend: { ...bound, env: { ...bound.env, NODE_OPTIONS: "", NODE_PATH: "" } } };
  const admittedMcp: string[] = [];
  let uncoveredReason: string | undefined;
  for (const tool of input.plan.allowedMcpTools) {
    const names = Object.keys(input.mcpServers).filter(n => n !== "agend" && tool.name.startsWith(`mcp__${n}__`));
    if (names.length !== 1) { uncoveredReason = "missing-selected-mcp"; continue; }
    servers[names[0]!] = input.mcpServers[names[0]!]!;
    admittedMcp.push(tool.name);
  }
  const root = join(input.instanceDir, "classic-cli-guard"), launch = randomUUID(), directory = join(root, launch);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const settingsPath = join(directory, "settings.json"), mcpPath = join(directory, "mcp.json"), hookPath = join(directory, "guard.cjs"),
    policyPath = join(directory, "policy.json"), receiptPath = join(directory, "loaded.json"), currentPath = join(root, "current.json");
  // Shell form is available at the 2.1.295 boundary; every path is POSIX-quoted.
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const command = `/usr/bin/env -i ${quote(process.execPath)} ${quote(hookPath)} ${quote(policyPath)}`;
  const hook = { type: "command", command, timeout: 2, onFailure: "block" };
  const tools = input.plan.publicRead ? ["WebSearch", "WebFetch"] : [];
  const allowed = [...tools, ...input.plan.allowedAgendTools.map(n => `mcp__agend__${n}`), ...admittedMcp];
  const settings = JSON.stringify({ ...input.settings, skipDangerousModePermissionPrompt: false,
    disableAllHooks: false, disableClaudeAiConnectors: true, disableBundledSkills: true, enabledPlugins: {},
    permissions: { defaultMode: "dontAsk", allow: allowed },
    hooks: { SessionStart: [{ hooks: [hook] }], UserPromptSubmit: [{ hooks: [hook] }], PreToolUse: [{ matcher: ".*", hooks: [hook] }] } });
  const settingsSha = sha(settings);
  writeFileSync(hookPath, CLASSIC_GUARD_HOOK, { mode: 0o600 });
  writeFileSync(settingsPath, settings, { mode: 0o600 });
  const mcpText = JSON.stringify({ mcpServers: servers }), mcpSha = sha(mcpText);
  writeFileSync(mcpPath, mcpText, { mode: 0o600 });
  const policyText = JSON.stringify({ launch, digest, allowed, cwd: input.cwd, current: currentPath, settings: settingsPath,
    settingsSha, mcp: mcpPath, mcpSha, hookSha: sha(CLASSIC_GUARD_HOOK), receipt: receiptPath }), policySha = sha(policyText);
  writeFileSync(policyPath, policyText, { mode: 0o600 });
  put(currentPath, JSON.stringify({ launch, digest, policySha }));
  return { status: reason("restart-required", "load-not-verified"),
    launch: { digest, launch, settingsPath, mcpPath, policyPath, hookPath, receiptPath, currentPath, settingsSha, policySha, mcpSha, tools, uncoveredReason } };
}

function bounded(path: string): string {
  const st = lstatSync(path); if (!st.isFile() || st.size > 262_144) throw Error("guard-file");
  return readFileSync(path, "utf8");
}
export function classicGuardStatus(launch: ClassicGuardLaunch, plan: ClassicRestrictedPlan): ContactGuardStatus {
  try {
    if (classicPlanDigest(plan) !== launch.digest) return reason("restart-required", "stale-policy");
    const current = JSON.parse(bounded(launch.currentPath));
    if (current.launch !== launch.launch || current.digest !== launch.digest) return reason("restart-required", "stale-launch");
    if (current.policySha !== launch.policySha || sha(bounded(launch.settingsPath)) !== launch.settingsSha
      || sha(bounded(launch.policyPath)) !== launch.policySha || sha(bounded(launch.mcpPath)) !== launch.mcpSha
      || bounded(launch.hookPath) !== CLASSIC_GUARD_HOOK)
      return reason("failed", "guard-files-changed");
    if (!existsSync(launch.receiptPath)) return reason("restart-required", "load-not-verified");
    const receipt = JSON.parse(bounded(launch.receiptPath));
    if (receipt.launch !== launch.launch || receipt.digest !== launch.digest || typeof receipt.session !== "string" || !receipt.session)
      return reason("failed", "invalid-load-receipt");
    return launch.uncoveredReason ? reason("not-covered", launch.uncoveredReason) : classicGuardInventory({ state: "ready", backend: "claude-code" });
  } catch { return reason("failed", "guard-unavailable"); }
}
