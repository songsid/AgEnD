/**
 * AGEND-115: the one place that says what each AI tool (CLI) can do in AgEnD — install, sign in (chat, dashboard, structured, first run), sign out, which
 * account it is, named accounts, keep-alive, usage, and what a paired Windows computer does for it. The lists that used to be written out in each file
 * (the Accounts page's CLIs, the sign-out table, the usage provider ids, the Runtime's installable CLIs, …) are derived from here instead, and
 * tests/cli-registry-completeness.test.ts fails when a CLI leaves a capability unanswered. See cli-capability.ts for the vocabulary and docs/dev/cli-registry.md
 * for how to add a CLI.
 *
 * Plain data, deeply frozen. The server only ever sends a CLI id to a Runtime: a Runtime reads its own copy of this table from its own bundle, so nothing here
 * travels over the wire, and a value that decides what a Runtime starts (a sign-in command, an environment variable, a binary name, a probe) is also written out
 * literally in the tests that pin it, so changing it takes a change in two places a reviewer sees.
 *
 * Built-ins only (it imports only the cli-*.ts files): part of the Runtime bundle (RUNTIME_BUNDLE_MODULES).
 */
import { CLI_IDS, deepFreeze, isYes, type Cap, type CliId, type CliSpec, type HostCapabilities, type RuntimeCapabilities, type Yes } from "./cli-capability.js";
import { ANTIGRAVITY_SPEC } from "./cli-spec-antigravity.js";
import { CLAUDE_CODE_SPEC } from "./cli-spec-claude-code.js";
import { CODEX_SPEC } from "./cli-spec-codex.js";
import { GROK_SPEC } from "./cli-spec-grok.js";
import { KIRO_CLI_SPEC } from "./cli-spec-kiro-cli.js";
import { MUSE_SPEC } from "./cli-spec-muse.js";
import { OPENCODE_SPEC } from "./cli-spec-opencode.js";

export { CLI_IDS, isYes } from "./cli-capability.js";
export type { Cap, CarryKind, CliId, CliSpec, HostCapabilities, RuntimeCapabilities, Yes } from "./cli-capability.js";

const TABLE = deepFreeze({
  "claude-code": CLAUDE_CODE_SPEC,
  "codex": CODEX_SPEC,
  "kiro-cli": KIRO_CLI_SPEC,
  "antigravity": ANTIGRAVITY_SPEC,
  "grok": GROK_SPEC,
  "muse": MUSE_SPEC,
  "opencode": OPENCODE_SPEC,
} satisfies Record<CliId, CliSpec>);
/**
 * Every CLI AgEnD knows, by id. A new CLI is one more entry here (and its id in `CLI_IDS`); the completeness test says what is missing. The table keeps the exact
 * type of what the specs wrote (not `CliSpec`), so the types below follow the data: `HostCliWith<"keepAlive">` is the union of the CLIs whose spec says "yes".
 */
export const CLI_SPECS: typeof TABLE = TABLE;

/** The CLIs whose spec says "yes" to a host capability, as a type: a `switch` over it stops compiling when a CLI gains or loses the capability. */
export type HostCliWith<K extends keyof HostCapabilities> = { [I in CliId]: typeof CLI_SPECS[I]["host"][K] extends { readonly support: "yes" } ? I : never }[CliId];
/** The same for a Runtime capability. */
export type RuntimeCliWith<K extends keyof RuntimeCapabilities> = { [I in CliId]: typeof CLI_SPECS[I]["runtime"][K] extends { readonly support: "yes" } ? I : never }[CliId];

/**
 * The compiled files of this registry, as the Runtime bundle lists them (runtime-build-info.ts RUNTIME_BUNDLE_MODULES): a CLI added to `CLI_IDS` brings its spec
 * file into every Runtime bundle with it, so nobody has to remember to list it. tests/cli-registry-runtime-bundle.test.ts builds a bundle and runs it outside the
 * dependency tree.
 */
export const CLI_REGISTRY_MODULES: readonly string[] = Object.freeze(["cli-capability.js", "cli-registry.js", ...CLI_IDS.map(id => `cli-spec-${id}.js`)]);

export function isCliId(value: unknown): value is CliId {
  return typeof value === "string" && Object.hasOwn(CLI_SPECS, value);
}
/** The spec of a CLI, or null for an id AgEnD does not know (a backend name from a config file, a request, a Runtime). */
export function cliSpec(id: unknown): CliSpec | null {
  return isCliId(id) ? CLI_SPECS[id] : null;
}

/** One host capability of a CLI; null for an id AgEnD does not know. */
export function hostCap<K extends keyof HostCapabilities>(id: unknown, key: K): HostCapabilities[K] | null {
  return cliSpec(id)?.host[key] ?? null;
}
/** One Runtime capability of a CLI; null for an id AgEnD does not know. */
export function runtimeCap<K extends keyof RuntimeCapabilities>(id: unknown, key: K): RuntimeCapabilities[K] | null {
  return cliSpec(id)?.runtime[key] ?? null;
}
/** The facts of a supported capability, or null when the CLI is unknown or does not support it. */
export function hostFacts<K extends keyof HostCapabilities>(id: unknown, key: K): Extract<HostCapabilities[K], { support: "yes" }> | null {
  const cap = hostCap(id, key);
  return cap && isYes(cap as Cap) ? cap as Extract<HostCapabilities[K], { support: "yes" }> : null;
}
export function runtimeFacts<K extends keyof RuntimeCapabilities>(id: unknown, key: K): Extract<RuntimeCapabilities[K], { support: "yes" }> | null {
  const cap = runtimeCap(id, key);
  return cap && isYes(cap as Cap) ? cap as Extract<RuntimeCapabilities[K], { support: "yes" }> : null;
}

type RankedHost = { [K in keyof HostCapabilities]: Extract<HostCapabilities[K], { support: "yes" }> extends { rank: number } ? K : never }[keyof HostCapabilities];

/** The CLIs that support a host capability, in the registry's order. */
export function hostIds(key: keyof HostCapabilities): CliId[] {
  return CLI_IDS.filter(id => hostCap(id, key)?.support === "yes");
}
/** The CLIs that support a Runtime capability, in the registry's order. */
export function runtimeIds(key: keyof RuntimeCapabilities): CliId[] {
  return CLI_IDS.filter(id => runtimeCap(id, key)?.support === "yes");
}
/** The CLIs that support a host capability that carries a `rank`, in the order of that rank (the order a list on a page shows them in). */
export function hostIdsByRank(key: RankedHost): CliId[] {
  return hostIds(key).sort((a, b) => (hostFacts(a, key) as Yes<{ rank: number }>).rank - (hostFacts(b, key) as Yes<{ rank: number }>).rank);
}
/** The CLIs the Windows Runtime lists as providers, in its inventory order (`runtime.provider.rank`). */
export function runtimeProviderIds(): CliId[] {
  return runtimeIds("provider").sort((a, b) => runtimeFacts(a, "provider")!.rank - runtimeFacts(b, "provider")!.rank);
}
