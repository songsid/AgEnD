/**
 * The run-time half of the registry's completeness check (the other half is the compiler: `CliSpec` requires every capability).
 * `checkCliRegistry` reads a table of specs as untrusted data and lists what is wrong with it, one sentence each; an empty list is a complete, consistent
 * registry. tests/cli-registry-completeness.test.ts runs it on the real table (must be empty) and on deliberately broken copies (must not be).
 *
 * It looks at the table only. That every `yes` has the behaviour it promises (an identity parser, a login flow, a usage reader, …) is checked in that test,
 * which may import the modules the registry itself must not.
 */
import { CAPABILITY_PATHS, CLI_IDS, NO_REASONS, TRACKING, USAGE_WINDOW_KINDS, type CapabilityPath, type CliId } from "./cli-capability.js";

type Check = (value: unknown) => string | null;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text: Check = v => typeof v === "string" && v.trim() !== "" ? null : "a non-empty string";
const bool: Check = v => typeof v === "boolean" ? null : "a boolean";
const int: Check = v => Number.isInteger(v) && (v as number) >= 0 ? null : "a whole number, 0 or more";
const words = (min: number): Check => v => Array.isArray(v) && v.length >= min && v.every(w => typeof w === "string" && w !== "") ? null : `a list of ${min === 0 ? "" : "at least one "}non-empty strings`;
/** A list of at least one value from a fixed set, none twice (the window kinds a usage limit can have). */
const someOf = (...allowed: readonly string[]): Check => v => Array.isArray(v) && v.length >= 1 && new Set(v).size === v.length && v.every(w => typeof w === "string" && allowed.includes(w)) ? null : `a list of at least one of ${allowed.join(", ")}, none twice`;
const oneOf = (...allowed: string[]): Check => v => typeof v === "string" && allowed.includes(v) ? null : `one of ${allowed.join(", ")}`;
const version: Check = v => typeof v === "string" && /^\d+(?:\.\d+){0,3}$/.test(v) ? null : "a version such as 1.5.0"
const envName: Check = v => typeof v === "string" && /^[A-Z][A-Z0-9_]*$/.test(v) ? null : "an environment variable name";
/** A launch argument as it is typed (`--app_data_dir`). */
const argName: Check = v => typeof v === "string" && /^--?[A-Za-z][A-Za-z0-9_-]*$/.test(v) ? null : "a command-line flag such as --app_data_dir";
/** A file name inside an account's folder: one name, no path. */
const fileName: Check = v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) ? null : "a plain file name";
const fileNames: Check = v => Array.isArray(v) && v.length >= 1 && new Set(v).size === v.length && v.every(w => fileName(w) === null) ? null : "a list of plain file names, none twice";
/** Environment variables a launch is given: names and one-line values. */
const envMap: Check = v => isRecord(v) && Object.keys(v).length >= 1 && Object.entries(v).every(([k, val]) => envName(k) === null && typeof val === "string" && val.trim() !== "" && !/[\0\r\n]/.test(val)) ? null : "one or more environment variables with one-line values";
const orNull = (inner: Check): Check => v => v === null ? null : inner(v);
/** An update command carries exactly one `{version}`: the server fills it with the audited release, so a command that has none could not be pinned. */
const updateCommand: Check = v => typeof v === "string" && v.split("{version}").length === 2 ? null : "a command with exactly one {version}";
/** AGEND-153: the named exception (`release: "latest-unaudited"`) has no `{version}` at all: it goes to the newest release, which no `{version}` could name. */
const noVersion: Check = v => typeof v === "string" && v.trim() !== "" && !v.includes("{version}") ? null : "a command with no {version}";
const supportsShape: Check = v => isRecord(v) && ["execution", "resume", "model"].every(k => typeof v[k] === "boolean") && (v.mcp === undefined || typeof v.mcp === "boolean") && Object.keys(v).every(k => ["execution", "resume", "model", "mcp"].includes(k)) ? null : "{ execution, resume, model, mcp? } booleans";

/** What a `yes` must carry, per capability: each field and how it is checked. `?`: may be absent. */
const FACTS: Readonly<Record<CapabilityPath, Readonly<Record<string, Check>>>> = {
  "host.install": { binary: text, command: text, "unattended?": text },
  // `command` is checked below with `release` in view: exactly one {version}, or (the named exception) none.
  "host.update": { binary: text, command: text, "release?": oneOf("latest-unaudited") },
  "host.chatLogin": { aliases: words(0), mode: oneOf("device-code", "paste-code", "menu", "declined", "install-only") },
  "host.dashboardSignIn": { named: bool },
  "host.structuredSignIn": { argv: words(1), rank: int, ends: oneOf("success-line", "exit-code"), screen: oneOf("login-flow", "own"), answer: oneOf("code", "code-or-address"), "minVersion?": version, named: bool },
  "host.firstRunSignIn": { mode: oneOf("browser", "console"), rank: int },
  "host.authCheck": { argv: words(1) },
  "host.identity": { source: oneOf("status-command", "token-file"), "field?": text },
  "host.namedAccounts": { "env?": envName, home: oneOf("relocate-home", "redirect-files", "launch-argument"), "arg?": argName, "store?": fileName, "pin?": envMap, carry: oneOf("carries", "keeps", "handover") },
  "host.signOut": { "binary?": text, "args?": words(1), "remove?": fileNames },
  "host.keepAlive": {},
  "host.accountCard": { rank: int },
  "host.usage": { providerId: text, name: text, rank: int, profileRows: bool, hostRows: bool, pools: oneOf("single", "several"), windows: someOf(...USAGE_WINDOW_KINDS) },
  "runtime.provider": {
    name: text, company: text, binaryNames: words(1), supports: supportsShape, readOnlySupport: bool, permission: oneOf("os-sandbox", "read-tools", "native-policy"),
    permissionNote: text, promptTransport: oneOf("stdin-text", "stdin-json", "file"), modelProbe: orNull(words(1)), "reason?": text, rank: int,
  },
  "runtime.install": { kind: oneOf("npm", "download"), pin: oneOf("audited", "integrity") },
  "runtime.update": { kind: oneOf("pinned", "latest-unaudited") },
  "runtime.signIn": { argv: words(1), profile: oneOf("named", "none", "both") },
  "runtime.namedAccounts": { "env?": envName, "arg?": argName, "store?": fileName, "pin?": envMap },
  "runtime.signOut": { "binary?": text, "args?": words(1), "remove?": fileNames, "credential?": text },
  "runtime.accountRows": { defaultRow: oneOf("read-only", "sign-in") },
  "runtime.authStatus": { argv: words(1), source: oneOf("own-command", "model-listing") },
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
      if (cap.support === "yes") {
        checkFacts(where, cap, FACTS[path], problems);
        if (path === "host.update" && typeof cap.command === "string") { const expected = (cap.release === "latest-unaudited" ? noVersion : updateCommand)(cap.command); if (expected) problems.push(`${where} \`command\` must be ${expected}`); }
        continue;
      }
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
    need(id, "host.update", "host.install", "an update is the vendor's installer or updater taken to a release; what has no install has nothing to update");
    need(id, "runtime.update", "runtime.install", "an update is the pinned install over an older copy");
    need(id, "host.structuredSignIn", "host.authCheck", "the sign-in is confirmed by the CLI's own status probe");
    if (yesFactsOf(specs, id, "host.identity")?.source === "status-command" && !has(id, "host.authCheck")) problems.push(`${id}: host.identity reads the status command's answer, but host.authCheck is not "yes"`);
    if (yesFactsOf(specs, id, "host.identity")?.source === "token-file" && !(typeof yesFactsOf(specs, id, "host.identity")?.field === "string")) problems.push(`${id}: host.identity reads a token file but names no \`field\``);
    if (yesFactsOf(specs, id, "host.identity")?.source === "status-command" && yesFactsOf(specs, id, "host.identity")?.field !== undefined) problems.push(`${id}: host.identity has a \`field\` but reads the status command`);
    need(id, "host.keepAlive", "host.namedAccounts", "it reads and renews a credential home");
    if (yesFactsOf(specs, id, "host.structuredSignIn")?.named === true && !has(id, "host.namedAccounts")) problems.push(`${id}: host.structuredSignIn signs a named account in, but host.namedAccounts is not "yes"`);
    need(id, "host.dashboardSignIn", "host.chatLogin", "the dashboard runs the chat login's command");
    if (yesFactsOf(specs, id, "host.dashboardSignIn")?.named === true && !has(id, "host.namedAccounts")) problems.push(`${id}: host.dashboardSignIn says named accounts can be signed in, but host.namedAccounts is not "yes"`);
    if (yesFactsOf(specs, id, "host.firstRunSignIn")?.mode === "browser" && !has(id, "host.structuredSignIn")) problems.push(`${id}: host.firstRunSignIn offers browser controls, but host.structuredSignIn is not "yes"`);
    if (yesFactsOf(specs, id, "host.usage")?.hostRows === true && yesFactsOf(specs, id, "host.usage")?.profileRows !== true) problems.push(`${id}: host.usage has a row for every account on the host, but not for named accounts (profileRows)`);
    if (yesFactsOf(specs, id, "host.usage")?.profileRows === true && !has(id, "host.namedAccounts")) problems.push(`${id}: host.usage has rows for named accounts, but host.namedAccounts is not "yes"`);
    const signIn = yesFactsOf(specs, id, "runtime.signIn"), rows = yesFactsOf(specs, id, "runtime.accountRows");
    if ((signIn?.profile === "named" || signIn?.profile === "both") && !has(id, "runtime.namedAccounts")) problems.push(`${id}: runtime.signIn is a named account's, but runtime.namedAccounts is not "yes"`);
    // A sign-in with no profile REPLACES the computer's own login: it is only set up as that, with a row to sign it in from, a way to tell it worked, and the command the server launches (the Runtime maps the launch by exact argv).
    if (signIn?.profile === "none" || signIn?.profile === "both") {
      if (rows?.defaultRow !== "sign-in") problems.push(`${id}: runtime.signIn covers the computer's own login, so runtime.accountRows must say \`defaultRow: "sign-in"\``);
      if (!has(id, "runtime.authStatus")) problems.push(`${id}: runtime.signIn covers the computer's own login, but runtime.authStatus is not "yes" (nothing says whether it worked)`);
      if (signIn.profile === "none" && has(id, "runtime.namedAccounts")) problems.push(`${id}: runtime.signIn has no profile, but runtime.namedAccounts is "yes" (say \`both\`)`);
      if (signIn.profile === "both" && !has(id, "runtime.namedAccounts")) problems.push(`${id}: runtime.signIn is \`both\`, but runtime.namedAccounts is not "yes"`);
    }
    if (rows?.defaultRow === "sign-in" && signIn?.profile !== "none" && signIn?.profile !== "both") problems.push(`${id}: runtime.accountRows lets the computer's own login be signed in, but runtime.signIn does not cover it`);
    const hostSignIn = yesFactsOf(specs, id, "host.structuredSignIn");
    if (signIn && hostSignIn && JSON.stringify(signIn.argv) !== JSON.stringify(hostSignIn.argv)) problems.push(`${id}: runtime.signIn launches ${JSON.stringify(signIn.argv)}, host.structuredSignIn ${JSON.stringify(hostSignIn.argv)} (the server maps a launch to the Runtime's sign-in by its exact argv)`);
    if ((signIn?.profile === "none" || signIn?.profile === "both") && !hostSignIn) problems.push(`${id}: runtime.signIn covers the computer's own login, but host.structuredSignIn is not "yes" (the dashboard drives both with the same dialog)`);
    if (signIn?.profile === "both" && hostSignIn && hostSignIn.named !== true) problems.push(`${id}: runtime.signIn signs a named account in, but host.structuredSignIn does not (\`named\`): the dashboard drives both with the same dialog`);
    need(id, "runtime.accountRows", "runtime.authStatus", "a row shows the sign-in state from that probe");
    if (rows?.defaultRow === "read-only" && !has(id, "runtime.namedAccounts")) problems.push(`${id}: runtime.accountRows shows the computer's named accounts, but runtime.namedAccounts is not "yes"`);
    const status = yesFactsOf(specs, id, "runtime.authStatus"), provider = yesFactsOf(specs, id, "runtime.provider");
    if (status?.source === "model-listing" && JSON.stringify(status.argv) !== JSON.stringify(provider?.modelProbe)) problems.push(`${id}: runtime.authStatus is the model listing, so its argv must be runtime.provider.modelProbe`);
    need(id, "runtime.identity", "runtime.authStatus", "the account is read from the same status answer");
    need(id, "runtime.install", "runtime.provider", "what is not run is not installed");
    if (yesFactsOf(specs, id, "runtime.provider")?.supports && (yesFactsOf(specs, id, "runtime.provider")!.supports as { execution?: boolean }).execution === false && has(id, "runtime.signIn")) problems.push(`${id}: runtime.signIn is "yes" for a provider the Runtime does not run`);
    const named = yesFactsOf(specs, id, "host.namedAccounts");
    if (named) {
      // How an account is told apart decides which facts it carries: a variable that moves the home, or an argument naming the folder with the file the sign-in is in and what keeps it there.
      const byArgument = named.home === "launch-argument";
      for (const field of ["env"]) if ((named[field] !== undefined) === byArgument) problems.push(`${id}: host.namedAccounts ${byArgument ? "is a launch argument, so it has no" : "moves a home with a variable, so it needs an"} \`${field}\``);
      for (const field of ["arg", "store", "pin"]) if ((named[field] === undefined) === byArgument) problems.push(`${id}: host.namedAccounts ${byArgument ? "is a launch argument, so it needs" : "moves a home with a variable, so it has no"} \`${field}\``);
    }
    const signOut = yesFactsOf(specs, id, "host.signOut");
    if (signOut) {
      const command = signOut.binary !== undefined || signOut.args !== undefined, removes = signOut.remove !== undefined;
      if (command === removes) problems.push(`${id}: host.signOut is either the CLI's own logout (binary and args) or the sign-in files AgEnD removes (remove), not both and not neither`);
      else if (command && (signOut.binary === undefined || signOut.args === undefined)) problems.push(`${id}: host.signOut names a logout command, so it needs both \`binary\` and \`args\``);
      if (removes && !has(id, "host.authCheck")) problems.push(`${id}: host.signOut removes files, but host.authCheck is not "yes" (nothing would say it signed out)`);
      if (removes && named?.home !== "launch-argument") problems.push(`${id}: host.signOut removes files, which is only set up for an account kept in its own folder (host.namedAccounts as a launch argument)`);
    }
    const runtimeNamed = yesFactsOf(specs, id, "runtime.namedAccounts");
    if (runtimeNamed) {
      const hostEnv = named?.env, runtimeEnv = runtimeNamed.env, byArgument = runtimeNamed.env === undefined;
      if (!named) problems.push(`${id}: runtime.namedAccounts is "yes" but host.namedAccounts is not`);
      if (runtimeEnv !== undefined && hostEnv !== undefined && runtimeEnv !== hostEnv) problems.push(`${id}: runtime.namedAccounts points at ${String(runtimeEnv)}, host.namedAccounts at ${String(hostEnv)}`);
      for (const field of ["arg", "store", "pin"]) if ((runtimeNamed[field] === undefined) === byArgument) problems.push(`${id}: runtime.namedAccounts ${byArgument ? "has no `env`, so it needs" : "moves a home with a variable, so it has no"} \`${field}\``);
      // The Runtime launches the CLI with the same argument and the same pin the host does: one set of facts, never two that drift apart.
      if (byArgument && named) for (const field of ["arg", "store", "pin"]) if (JSON.stringify(runtimeNamed[field]) !== JSON.stringify(named[field])) problems.push(`${id}: runtime.namedAccounts \`${field}\` is not host.namedAccounts's`);
    }
    const runtimeSignOut = yesFactsOf(specs, id, "runtime.signOut");
    if (runtimeSignOut) {
      const command = runtimeSignOut.binary !== undefined || runtimeSignOut.args !== undefined, removes = runtimeSignOut.remove !== undefined || runtimeSignOut.credential !== undefined;
      if (command === removes) problems.push(`${id}: runtime.signOut is either the CLI's own logout (binary and args) or what the Runtime removes (remove and credential), not both and not neither`);
      else if (command && (runtimeSignOut.binary === undefined || runtimeSignOut.args === undefined)) problems.push(`${id}: runtime.signOut names a logout command, so it needs both \`binary\` and \`args\``);
      else if (removes && (runtimeSignOut.remove === undefined || runtimeSignOut.credential === undefined)) problems.push(`${id}: runtime.signOut removes a named account's files and the computer's own login, so it needs both \`remove\` and \`credential\``);
      if (removes && !has(id, "runtime.authStatus")) problems.push(`${id}: runtime.signOut removes sign-in data, but runtime.authStatus is not "yes" (nothing would say it signed out)`);
      if (removes && yesFactsOf(specs, id, "runtime.namedAccounts")?.store !== undefined && JSON.stringify(runtimeSignOut.remove) !== JSON.stringify([runtimeNamed?.store])) problems.push(`${id}: runtime.signOut removes ${JSON.stringify(runtimeSignOut.remove)}, but the account keeps its sign-in in ${JSON.stringify(runtimeNamed?.store)}`);
      if (!has(id, "runtime.signIn")) problems.push(`${id}: runtime.signOut is "yes" but runtime.signIn is not (nothing from the dashboard signed it in)`);
    }
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
