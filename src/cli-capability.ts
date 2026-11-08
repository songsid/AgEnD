/**
 * AGEND-115: the vocabulary of the CLI capability registry (cli-registry.ts). One `CliSpec` per AI tool, written as plain data: every capability is
 * either `yes` (with the few facts the rest of AgEnD needs) or `no` with a reason and a sentence. A capability that is left out does not compile
 * (`CliSpec` requires every field), and a `no` that does not say why does not compile either; cli-registry-check.ts and
 * tests/cli-registry-completeness.test.ts check the same things at run time.
 *
 * Plain data only: strings, numbers, booleans and arrays of them. No function, no RegExp and nothing read from the network or the disk, so a
 * reviewer reads a table, not a program. Behaviour (screen reduction, identity parsing, usage reads, the login flow's patterns) stays in its own files
 * and is keyed by the CLI id; a `yes` here promises that it exists there, and the completeness test checks the promise.
 *
 * Built-ins only (it imports nothing): this file, cli-registry.ts and the cli-spec-*.ts files are part of the Runtime bundle (RUNTIME_BUNDLE_MODULES).
 */

/** The CLIs AgEnD knows, in the order the Accounts page lists them. A new CLI is one more id here, one `cli-spec-<id>.ts` and one line in cli-registry.ts. */
export const CLI_IDS = Object.freeze(["claude-code", "codex", "kiro-cli", "antigravity", "grok", "muse", "opencode"] as const);
export type CliId = typeof CLI_IDS[number];

/**
 * Why a capability is `no`:
 *  - `cli_has_none`: the tool itself has no such thing (no logout command, no account).
 *  - `not_applicable`: it depends on another capability this CLI does not have (a named-account sign-in needs named accounts).
 *  - `by_design`: AgEnD decided against it, and the note says where that decision is recorded.
 *  - `needs_verification`: nobody has run the tool to find out; the note says what to check. Not a promise to build it.
 *  - `not_yet_built`: it could be done and has not been; `tracking` is the issue that will (or `undecided`: the owner has not chosen).
 */
export const NO_REASONS = Object.freeze(["cli_has_none", "not_applicable", "by_design", "needs_verification", "not_yet_built"] as const);
export type NoReason = typeof NO_REASONS[number];
/** `AGEND-115`, `#3212`, or `undecided`. */
export type Tracking = `AGEND-${number}` | `#${number}` | "undecided";
export const TRACKING = /^(?:AGEND-\d+|#\d+|undecided)$/;

export type No =
  | { readonly support: "no"; readonly why: Exclude<NoReason, "not_yet_built">; readonly note: string; readonly tracking?: Tracking }
  | { readonly support: "no"; readonly why: "not_yet_built"; readonly note: string; readonly tracking: Tracking };
export type Yes<T extends object = {}> = { readonly support: "yes" } & Readonly<T>;
/** One capability of one CLI: supported (with its facts), or not supported (with its reason). */
export type Cap<T extends object = {}> = Yes<T> | No;

/** `yes`, with the facts (a capability that needs none, like `keepAlive`, is `yes()`). */
export function yes(): Yes;
export function yes<const T extends object>(facts: T): Yes<T>;
export function yes(facts?: object): Yes<object> { return { support: "yes", ...(facts ?? {}) }; }
/** `no`: the tool has no such thing. */
export const none = (note: string): No => ({ support: "no", why: "cli_has_none", note });
/** `no`: it depends on a capability this CLI does not have. */
export const notApplicable = (note: string): No => ({ support: "no", why: "not_applicable", note });
/** `no`: decided against, on purpose. */
export const byDesign = (note: string): No => ({ support: "no", why: "by_design", note });
/** `no`: not known; the note says what to check. */
export const toVerify = (note: string): No => ({ support: "no", why: "needs_verification", note });
/** `no`: not built yet, and the issue that tracks it (`undecided` until the owner picks). */
export const notYetBuilt = (tracking: Tracking, note: string): No => ({ support: "no", why: "not_yet_built", note, tracking });

export const isYes = <T extends object>(cap: Cap<T>): cap is Yes<T> => cap.support === "yes";

/** How the conversation of an agent moved between two accounts of this CLI carries over (the Accounts page's note on a Move). */
export type CarryKind = "carries" | "keeps" | "handover";
export type ChatLoginMode = "device-code" | "paste-code" | "menu" | "declined" | "install-only";
export type CredentialHomeKind = "relocate-home" | "redirect-files";
export type NativePermission = "os-sandbox" | "read-tools" | "native-policy";
export type NativePromptTransport = "stdin-text" | "stdin-json" | "file";

/** What the Windows Runtime knows of a CLI it can run (the former `NativeProviderDescriptor`, windows-cli-providers.ts). */
export interface NativeProviderFacts {
  readonly name: string;
  readonly company: string;
  /** Executable basenames only. IDE launchers such as kiro.cmd are deliberately excluded. */
  readonly binaryNames: readonly string[];
  readonly supports: { readonly execution: boolean; readonly resume: boolean; readonly model: boolean; readonly mcp?: boolean };
  readonly readOnlySupport: boolean;
  readonly permission: NativePermission;
  readonly permissionNote: string;
  readonly promptTransport: NativePromptTransport;
  /** A listing command only; never an inference/model request. `null`: none. */
  readonly modelProbe: readonly string[] | null;
  readonly reason?: string;
  /** Where this CLI sits in the Windows inventory (the order of the former NATIVE_PROVIDER_IDS). */
  readonly rank: number;
}

/** Every capability a CLI has, on the AgEnD host. */
export interface HostCapabilities {
  /** The binary and the command a person (or the install window) runs to get the CLI. */
  readonly install: Cap<{ binary: string; command: string; unattended?: string }>;
  /** `/login <name>` in chat: the names it accepts besides the id, and what it does. */
  readonly chatLogin: Cap<{ aliases: readonly string[]; mode: ChatLoginMode }>;
  /** The dashboard can sign this CLI in (the browser-terminal flow, `dashboardSignInSupported`); `named`: a named account too. */
  readonly dashboardSignIn: Cap<{ named: boolean }>;
  /** The structured sign-in (Sign in → open the page → paste the code): the exact command it launches, and its place in the lists. */
  readonly structuredSignIn: Cap<{ argv: readonly string[]; rank: number }>;
  /** The first-run page offers it: as browser controls, or only as the console command. */
  readonly firstRunSignIn: Cap<{ mode: "browser" | "console"; rank: number }>;
  /** A cheap, token-free probe of whether the sign-in works (the command, run with a 5 s timeout). */
  readonly authCheck: Cap<{ argv: readonly string[] }>;
  /** Which account the sign-in is (a masked e-mail and a plan), read from the CLI's own status answer. */
  readonly identity: Cap<{ source: "status-command" }>;
  /** Several sign-ins side by side (credential profiles): the variable that relocates the CLI's home, how, and how a Move is worded. */
  readonly namedAccounts: Cap<{ env: string; home: CredentialHomeKind; carry: CarryKind }>;
  /** Sign out from the dashboard: the CLI's own logout. */
  readonly signOut: Cap<{ binary: string; args: readonly string[] }>;
  /** "Keep sign-in alive". */
  readonly keepAlive: Cap;
  /** The CLI has a card on Settings → Accounts (`rank`: its place there). */
  readonly accountCard: Cap<{ rank: number }>;
  /** The usage panel's row for it: its provider id and name, its place, and whether a named account has a row of its own. */
  readonly usage: Cap<{ providerId: string; name: string; rank: number; profileRows: boolean }>;
}

/** Every capability a CLI has on a paired Windows computer, as its Runtime reports and does it. */
export interface RuntimeCapabilities {
  /** The Runtime can list and (where `supports.execution`) run it. */
  readonly provider: Cap<NativeProviderFacts>;
  /** The dashboard installs it, from a pinned npm package. (The pins stay in runtime-cli-install.ts.) */
  readonly install: Cap<{ kind: "npm" }>;
  /** The dashboard signs it in on that computer: the exact command, and whether it is a named account's sign-in. */
  readonly signIn: Cap<{ argv: readonly string[]; profile: "named" }>;
  /** Named accounts on that computer: the variable that points the CLI at the profile's folder. */
  readonly namedAccounts: Cap<{ env: string }>;
  /** The Accounts page shows that computer's accounts of this CLI. */
  readonly accountRows: Cap;
  /** The status probe the Runtime runs for a sign-in (never a login). */
  readonly authStatus: Cap<{ argv: readonly string[] }>;
  /** The Runtime reports which account it is (masked). */
  readonly identity: Cap;
  /** The Runtime reports the account's usage. */
  readonly usage: Cap;
}

export interface CliSpec {
  readonly id: CliId;
  readonly host: HostCapabilities;
  readonly runtime: RuntimeCapabilities;
}

/** `host.install`, `runtime.signIn`, …: every capability's address, in the order the specs and the gap report list them. */
export const HOST_CAPABILITIES = Object.freeze(["install", "chatLogin", "dashboardSignIn", "structuredSignIn", "firstRunSignIn", "authCheck", "identity", "namedAccounts", "signOut", "keepAlive", "accountCard", "usage"] as const satisfies readonly (keyof HostCapabilities)[]);
export const RUNTIME_CAPABILITIES = Object.freeze(["provider", "install", "signIn", "namedAccounts", "accountRows", "authStatus", "identity", "usage"] as const satisfies readonly (keyof RuntimeCapabilities)[]);
// Compile-time: the two lists above name every field of the interfaces (a capability added to an interface and not here fails the build).
const _hostListed: [Exclude<keyof HostCapabilities, typeof HOST_CAPABILITIES[number]>] extends [never] ? true : never = true;
const _runtimeListed: [Exclude<keyof RuntimeCapabilities, typeof RUNTIME_CAPABILITIES[number]>] extends [never] ? true : never = true;
void _hostListed; void _runtimeListed;
export type CapabilityPath =`host.${typeof HOST_CAPABILITIES[number]}` | `runtime.${typeof RUNTIME_CAPABILITIES[number]}`;
export const CAPABILITY_PATHS: readonly CapabilityPath[] = Object.freeze([...HOST_CAPABILITIES.map(k => `host.${k}` as const), ...RUNTIME_CAPABILITIES.map(k => `runtime.${k}` as const)]);

/** Freezes a spec all the way down: a table that can be read, not changed, by whoever imports it. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}
