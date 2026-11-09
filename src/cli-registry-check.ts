/**
 * The run-time half of the registry's completeness check (the other half is the compiler: `CliSpec` requires every capability).
 * `checkCliRegistry` reads a table of specs as untrusted data and lists what is wrong with it, one sentence each; an empty list is a complete, consistent
 * registry. tests/cli-registry-completeness.test.ts runs it on the real table (must be empty) and on deliberately broken copies (must not be).
 *
 * It looks at the table only. That every `yes` has the behaviour it promises (an identity parser, a login flow, a usage reader, …) is checked in that test,
 * which may import the modules the registry itself must not.
 */
import { CAPABILITY_PATHS, CLI_IDS, NO_REASONS, TRACKING, type CapabilityPath, type CliId } from "./cli-capability.js";

type Check = (value: unknown) => string | null;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text: Check = v => typeof v === "string" && v.trim() !== "" ? null : "a non-empty string";
const bool: Check = v => typeof v === "boolean" ? null : "a boolean";
const int: Check = v => Number.isInteger(v) && (v as number) >= 0 ? null : "a whole number, 0 or more";
const words = (min: number): Check => v => Array.isArray(v) && v.length >= min && v.every(w => typeof w === "string" && w !== "") ? null : `a list of ${min === 0 ? "" : "at least one "}non-empty strings`;
const oneOf = (...allowed: string[]): Check => v => typeof v === "string" && allowed.includes(v) ? null : `one of ${allowed.join(", ")}`;
const envName: Check = v => typeof v === "string" && /^[A-Z][A-Z0-9_]*$/.test(v) ? null : "an environment variable name";
const orNull = (inner: Check): Check => v => v === null ? null : inner(v);
const supportsShape: Check = v => isRecord(v) && ["execution", "resume", "model"].every(k => typeof v[k] === "boolean") && (v.mcp === undefined || typeof v.mcp === "boolean") && Object.keys(v).every(k => ["execution", "resume", "model", "mcp"].includes(k)) ? null : "{ execution, resume, model, mcp? } booleans";

/** What a `yes` must carry, per capability: each field and how it is checked. `?`: may be absent. */
const FACTS: Readonly<Record<CapabilityPath, Readonly<Record<string, Check>>>> = {
  "host.install": { binary: text, command: text, "unattended?": text },
  "host.chatLogin": { aliases: words(0), mode: oneOf("device-code", "paste-code", "menu", "declined", "install-only") },
  "host.dashboardSignIn": { named: bool },
  "host.structuredSignIn": { argv: words(1), rank: int, named: bool },
  "host.firstRunSignIn": { mode: oneOf("browser", "console"), rank: int },
  "host.authCheck": { argv: words(1) },
  "host.identity": { source: oneOf("status-command") },
  "host.namedAccounts": { env: envName, home: oneOf("relocate-home", "redirect-files"), carry: oneOf("carries", "keeps", "handover") },
  "host.signOut": { binary: text, args: words(1) },
  "host.keepAlive": {},
  "host.accountCard": { rank: int },
  "host.usage": { providerId: text, name: text, rank: int, profileRows: bool },
  "runtime.provider": {
    name: text, company: text, binaryNames: words(1), supports: supportsShape, readOnlySupport: bool, permission: oneOf("os-sandbox", "read-tools", "native-policy"),
    permissionNote: text, promptTransport: oneOf("stdin-text", "stdin-json", "file"), modelProbe: orNull(words(1)), "reason?": text, rank: int,
  },
  "runtime.install": { kind: oneOf("npm", "download"), pin: oneOf("audited", "integrity") },
  "runtime.signIn": { argv: words(1), profile: oneOf("named") },
  "runtime.namedAccounts": { env: envName },
  "runtime.accountRows": {},
  "runtime.authStatus": { argv: words(1) },
  "runtime.identity": {},
  "runtime.usage": {},
};

/** The capability at an address of a spec, as written (undefined when the spec leaves it out). */
export function capabilityOf(spec: unknown, path: CapabilityPath): unknown {
  const [group, key] = path.split(".") as [string, string];
  const side = isRecord(spec) ? spec[group] : undefined;
  return isRecord(side) ? side[key] : undefined;
}
const isYesCap = (cap: unknown): cap is Record<string, unknown> => isRecord(cap) && cap.support === "yes";

function checkFacts(where: string, cap: Record<string, unknown>, shape: Readonly<Record<string, Check>>, problems: string[]): void {
  const known = new Set(["support"]);
  for (const [spec, check] of Object.entries(shape)) {
    const optional = spec.endsWith("?"), field = optional ? spec.slice(0, -1) : spec;
    known.add(field);
    if (cap[field] === undefined) { if (!optional) problems.push(`${where} is "yes" but has no \`${field}\``); continue; }
    const expected = check(cap[field]);
    if (expected) problems.push(`${where} \`${field}\` must be ${expected}`);
  }
  for (const field of Object.keys(cap)) if (!known.has(field)) problems.push(`${where} has an unknown field \`${field}\``);
}

/**
 * Everything wrong with a table of specs, one sentence each. Checks: every CLI has a spec with its own id; no capability is missing, unknown or
 * unexplained (a `no` needs a reason from the list, a sentence, and — for `not_yet_built` — the issue that tracks it); a `yes` carries the facts its capability
 * needs; ranks and names do not collide; and the capabilities that cannot stand alone (a keep-alive needs named accounts to read) are not set up without
 * what they stand on.
 */
export function checkCliRegistry(specs: unknown, ids: readonly string[] = CLI_IDS): string[] {
  const problems: string[] = [];
  if (!isRecord(specs)) return ["the registry is not a table of specs"];
  for (const id of Object.keys(specs)) if (!ids.includes(id)) problems.push(`${id}: a spec for a CLI that is not in CLI_IDS`);
  for (const id of ids) {
    const spec = specs[id];
    if (!isRecord(spec)) { problems.push(`${id}: has no spec`); continue; }
    if (spec.id !== id) problems.push(`${id}: its spec says id ${JSON.stringify(spec.id)}`);
    for (const group of ["host", "runtime"]) {
      const side = spec[group];
      if (!isRecord(side)) { problems.push(`${id}: has no \`${group}\` capabilities`); continue; }
      const listed = new Set(CAPABILITY_PATHS.filter(path => path.startsWith(`${group}.`)).map(path => path.slice(group.length + 1)));
      for (const key of Object.keys(side)) if (!listed.has(key)) problems.push(`${id}: \`${group}.${key}\` is not a capability`);
    }
    for (const path of CAPABILITY_PATHS) {
      const where = `${id}: ${path}`;
      const cap = capabilityOf(spec, path);
      if (cap === undefined) { problems.push(`${where} is not answered (say "yes", or "no" and why)`); continue; }
      if (!isRecord(cap) || (cap.support !== "yes" && cap.support !== "no")) { problems.push(`${where} must have support "yes" or "no"`); continue; }
      if (cap.support === "yes") { checkFacts(where, cap, FACTS[path], problems); continue; }
      for (const field of Object.keys(cap)) if (!["support", "why", "note", "tracking"].includes(field)) problems.push(`${where} has an unknown field \`${field}\``);
      if (typeof cap.why !== "string" || !(NO_REASONS as readonly string[]).includes(cap.why)) { problems.push(`${where} is "no" without a reason (${NO_REASONS.join(", ")})`); continue; }
      if (typeof cap.note !== "string" || cap.note.trim().length < 12) problems.push(`${where} is "no" (${cap.why}) without a sentence saying why`);
      if (cap.why === "not_yet_built" && !(typeof cap.tracking === "string" && TRACKING.test(cap.tracking))) problems.push(`${where} is "not_yet_built" without the issue that tracks it (#<n> or undecided)`);
      if (cap.tracking !== undefined && !(typeof cap.tracking === "string" && TRACKING.test(cap.tracking))) problems.push(`${where} has a tracking value that is not #<n> or undecided`);
    }
  }
  problems.push(...checkUniqueness(specs, ids), ...checkDependencies(specs, ids));
  return problems;
}

function yesFactsOf(specs: Record<string, unknown>, id: string, path: CapabilityPath): Record<string, unknown> | null {
  const cap = capabilityOf(specs[id], path);
  return isYesCap(cap) ? cap : null;
}

/** Ranks order a page's list, names are looked up by: two CLIs sharing either would make a list ambiguous. */
function checkUniqueness(specs: Record<string, unknown>, ids: readonly string[]): string[] {
  const problems: string[] = [];
  const unique = (what: string, entries: Array<[string, unknown]>): void => {
    const seen = new Map<string, string>();
    for (const [id, value] of entries) {
      if (value === undefined) continue;
      const key = JSON.stringify(value), other = seen.get(key);
      if (other) problems.push(`${what}: ${other} and ${id} both have ${key}`); else seen.set(key, id);
    }
  };
  for (const path of ["host.structuredSignIn", "host.firstRunSignIn", "host.accountCard", "host.usage", "runtime.provider"] as const) {
    unique(`${path} rank`, ids.map(id => [id, yesFactsOf(specs, id, path)?.rank] as [string, unknown]));
  }
  unique("host.usage providerId", ids.map(id => [id, yesFactsOf(specs, id, "host.usage")?.providerId] as [string, unknown]));
  // `/login <name>`: a name means one CLI, and no alias may be another CLI's id.
  const names = new Map<string, string>(ids.map(id => [id, id]));
  for (const id of ids) {
    const aliases = yesFactsOf(specs, id, "host.chatLogin")?.aliases;
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      if (typeof alias !== "string") continue;
      if (alias !== alias.toLowerCase()) problems.push(`${id}: the alias ${JSON.stringify(alias)} must be lower case (chat lower-cases what it is given)`);
      const owner = names.get(alias);
      if (owner && owner !== id) problems.push(`${id}: the alias ${JSON.stringify(alias)} is already ${owner}'s`); else names.set(alias, id);
    }
  }
  return problems;
}

/** Capabilities that stand on others. A rule that does not hold means a CLI was set up halfway. */
function checkDependencies(specs: Record<string, unknown>, ids: readonly string[]): string[] {
  const problems: string[] = [];
  const has = (id: string, path: CapabilityPath): boolean => yesFactsOf(specs, id, path) !== null;
  const need = (id: string, path: CapabilityPath, needs: CapabilityPath, why: string): void => {
    if (has(id, path) && !has(id, needs)) problems.push(`${id}: ${path} is "yes" but ${needs} is not (${why})`);
  };
  for (const id of ids) {
    need(id, "host.structuredSignIn", "host.authCheck", "the sign-in is confirmed by the CLI's own status probe");
    need(id, "host.identity", "host.authCheck", "the account is read from the same status answer");
    need(id, "host.keepAlive", "host.namedAccounts", "it reads and renews a credential home");
    need(id, "host.dashboardSignIn", "host.chatLogin", "the dashboard runs the chat login's command");
    if (yesFactsOf(specs, id, "host.dashboardSignIn")?.named === true && !has(id, "host.namedAccounts")) problems.push(`${id}: host.dashboardSignIn says named accounts can be signed in, but host.namedAccounts is not "yes"`);
    if (yesFactsOf(specs, id, "host.firstRunSignIn")?.mode === "browser" && !has(id, "host.structuredSignIn")) problems.push(`${id}: host.firstRunSignIn offers browser controls, but host.structuredSignIn is not "yes"`);
    if (yesFactsOf(specs, id, "host.usage")?.profileRows === true && !has(id, "host.namedAccounts")) problems.push(`${id}: host.usage has rows for named accounts, but host.namedAccounts is not "yes"`);
    need(id, "runtime.signIn", "runtime.namedAccounts", "a computer's sign-in is a named account's");
    need(id, "runtime.accountRows", "runtime.authStatus", "a row shows the sign-in state from that probe");
    need(id, "runtime.accountRows", "runtime.namedAccounts", "the rows are the computer's named accounts");
    need(id, "runtime.identity", "runtime.authStatus", "the account is read from the same status answer");
    need(id, "runtime.install", "runtime.provider", "what is not run is not installed");
    if (yesFactsOf(specs, id, "runtime.provider")?.supports && (yesFactsOf(specs, id, "runtime.provider")!.supports as { execution?: boolean }).execution === false && has(id, "runtime.signIn")) problems.push(`${id}: runtime.signIn is "yes" for a provider the Runtime does not run`);
    const hostEnv = yesFactsOf(specs, id, "host.namedAccounts")?.env, runtimeEnv = yesFactsOf(specs, id, "runtime.namedAccounts")?.env;
    if (runtimeEnv !== undefined && hostEnv !== undefined && runtimeEnv !== hostEnv) problems.push(`${id}: runtime.namedAccounts points at ${String(runtimeEnv)}, host.namedAccounts at ${String(hostEnv)}`);
    if (runtimeEnv !== undefined && hostEnv === undefined) problems.push(`${id}: runtime.namedAccounts is "yes" but host.namedAccounts is not`);
  }
  return problems;
}

/** One `no` of the table: what is not supported, why, and what tracks it. */
export interface CliGap { cli: CliId; path: CapabilityPath; why: string; tracking: string | null; note: string }
/** Every capability a CLI does not support, in the registry's order: the gap report the completeness test pins. */
export function cliGaps(specs: Readonly<Record<string, unknown>>, ids: readonly CliId[] = CLI_IDS): CliGap[] {
  const out: CliGap[] = [];
  for (const cli of ids) for (const path of CAPABILITY_PATHS) {
    const cap = capabilityOf(specs[cli], path);
    if (isRecord(cap) && cap.support === "no") out.push({ cli, path, why: String(cap.why), tracking: typeof cap.tracking === "string" ? cap.tracking : null, note: String(cap.note) });
  }
  return out;
}
