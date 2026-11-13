/**
 * The vocabulary of the CLI capability registry (cli-registry.ts). One `CliSpec` per AI tool, written as plain data: every capability is
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
/** `#3212` (an upstream issue), or `undecided`. */
export type Tracking = `#${number}` | "undecided";
export const TRACKING = /^(?:#\d+|undecided)$/;

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
export type CredentialHomeKind = "relocate-home" | "redirect-files" | "launch-argument";
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
  /**
   * AGEND-136: the dashboard's Update button — the command that takes an installed CLI to AgEnD's AUDITED release (cli-audited.ts), never to "latest". `command` has one
   * `{version}`, filled on the server with the newest audited release (a plain x.y.z from the ledger, never anything the browser sent) and run through the same
   * unattended window as an install. A CLI that updates itself in the background, or has no official way to reach a chosen version, is a `no` that says which.
   *
   * `release: "latest-unaudited"` (AGEND-153, the maintainer's decision on #3539) is the one named EXCEPTION: the CLI updates itself and its own updater cannot choose a
   * release, so the button runs `command` as it is (no `{version}`) and the CLI goes to the newest release the vendor serves, which AgEnD has NOT audited. The page says so on
   * the button; every other rule (the held change, the asker's code, no public link, the install switch on a paired computer, the publisher's signature) is the same.
   */
  readonly update: Cap<{ binary: string; command: string; release?: "latest-unaudited" }>;
  /** `/login <name>` in chat: the names it accepts besides the id, and what it does. */
  readonly chatLogin: Cap<{ aliases: readonly string[]; mode: ChatLoginMode }>;
  /** The dashboard can sign this CLI in (the browser-terminal flow, `dashboardSignInSupported`); `named`: a named account too. */
  readonly dashboardSignIn: Cap<{ named: boolean }>;
  /**
   * The structured sign-in (Sign in → open the page → paste the code): the exact command it launches, and its place in the lists.
   * `ends`: how the driver knows it is over: `success-line` (the CLI prints one, or the process ends and the auth check passes) or `exit-code` (the CLI prints no success line:
   * signed in only when the command ended with exit 0 AND the auth check passes; a failed command is never "signed in" because an older login is still there).
   * `screen`: its prompts are read by the `login-flow` patterns, or by its `own` closed table (structured-signin.ts SCREEN_READERS). `minVersion`: the oldest CLI that has the command.
   * `answer`: what the CLI's own prompt accepts: the `code`, or the code or the page's address (`code-or-address`). AgEnD's box takes the code only (a pasted address is refused), so a
   * CLI that also accepts an address gets a line under the box saying to paste the code alone.
   * `named`: a NAMED account is signed in with these controls too (the login was checked to land in the account's own folder, which `host.namedAccounts` names). It is not implied by having named accounts:
   * what these controls launch for an account is only what was checked.
   */
  readonly structuredSignIn: Cap<{ argv: readonly string[]; rank: number; ends: "success-line" | "exit-code"; screen: "login-flow" | "own"; answer: "code" | "code-or-address"; minVersion?: string; named: boolean }>;
  /** The first-run page offers it: as browser controls, or only as the console command. */
  readonly firstRunSignIn: Cap<{ mode: "browser" | "console"; rank: number }>;
  /** A cheap, token-free probe of whether the sign-in works (the command, run with a 5 s timeout). */
  readonly authCheck: Cap<{ argv: readonly string[] }>;
  /**
   * Which account the sign-in is (the whole e-mail address in the `maskedEmail` field, and a plan where the CLI says one), read locally and never from a credential: `status-command` is the CLI's own status answer;
   * `token-file` is the one field of the CLI's own token file that names the account (`field`; nothing else of the file is read, kept or logged).
   */
  readonly identity: Cap<{ source: "status-command" } | { source: "token-file"; field: string }>;
  /**
   * Several sign-ins side by side (credential profiles): how the CLI is told which account it runs as, and how a Move is worded.
   *  - `relocate-home` / `redirect-files`: a variable (`env`) moves the CLI's home, or a file or two of it, to the account's folder.
   *  - `launch-argument` (AGEND-119, Antigravity): the CLI takes the account's folder as an argument (`arg`, a path relative to the CLI's own home), keeps the sign-in in one file there (`store`),
   *    and is started with `pin` in its environment: variables that make it keep that sign-in in the file, never in the system's keyring or credential manager, where one folder's sign-in would
   *    be every folder's. The account is only isolated when the CLI honours `pin`, which is why a sign-in first checks (an empty folder must answer "signed out") and never starts otherwise.
   */
  readonly namedAccounts: Cap<NamedAccountFacts & { carry: CarryKind }>;
  /**
   * Sign out from the dashboard: the CLI's own logout (`binary`, `args`), or — for a CLI that has none — the account's sign-in files, which AgEnD removes itself (`remove`: names inside the
   * account's folder). Either way the answer is then checked with the CLI's own status probe, so a sign-out that did not sign it out is reported as that.
   */
  readonly signOut: Cap<{ binary: string; args: readonly string[] } | { remove: readonly string[] }>;
  /** "Keep sign-in alive". */
  readonly keepAlive: Cap;
  /** The CLI has a card on Settings → Accounts (`rank`: its place there). */
  readonly accountCard: Cap<{ rank: number }>;
  /**
   * The usage panel's row for it: its provider id and name, its place, and whether a named account has a row of its own (`profileRows`: one used by an agent; `hostRows`: every account on this host, used by an agent or
   * not — a subscription at its limit is the one a person stops using, so it must not vanish because nothing runs on it), and the SHAPE of the limits the CLI reports.
   *  - `pools`: the account has one set of limits (`single`), or the CLI names several pools in its own answer and each has limits of its own (`several`: Antigravity's Gemini, Claude & others,
   *    Gemini 4 Argon). A pool the CLI names is shown whatever it is called; this says only whether to expect them.
   *  - `windows`: the kinds of window a pool's limit can have, as the CLI reports them: `session` (under two days: the 5h), `weekly`, `monthly`, and `unwindowed` (one number with no window of
   *    its own, as agy gives a pool it only knows from per-model data). An Accounts row shows every pool and every window the account reports, in the usage panel's own order, so a
   *    window is never hidden; this is what a CLI is expected to report, and tests/cli-registry-usage-shape.test.ts fails when a real payload carries a kind that is not listed here.
   */
  readonly usage: Cap<{ providerId: string; name: string; rank: number; profileRows: boolean; hostRows: boolean; pools: "single" | "several"; windows: readonly UsageWindowKind[] }>;
}

/** The kinds of window a usage limit can have (see `host.usage.windows`). */
export const USAGE_WINDOW_KINDS = Object.freeze(["session", "weekly", "monthly", "unwindowed"] as const);
export type UsageWindowKind = typeof USAGE_WINDOW_KINDS[number];

/** How a named account is told apart (see `host.namedAccounts`). */
export type NamedAccountFacts =
  | { readonly env: string; readonly home: "relocate-home" | "redirect-files" }
  | { readonly home: "launch-argument"; readonly arg: string; readonly store: string; readonly pin: Readonly<Record<string, string>> };

/** How a named account on a computer is told apart (see `runtime.namedAccounts`). */
export type RuntimeNamedAccountFacts =
  | { readonly env: string }
  | { readonly arg: string; readonly store: string; readonly pin: Readonly<Record<string, string>> };

/** Every capability a CLI has on a paired Windows computer, as its Runtime reports and does it. */
/**
 * What a Runtime install's pinned version vouches for: `audited` — the pin is a release AgEnD has audited (the upstream rule for npm CLIs: "the audited version, not latest"); `integrity` — it is
 * pinned only for what can be checked about the file (its size, checksum, the publisher's signature) because no audited release can be installed (the vendor serves only its newest build, and
 * the CLI updates itself afterwards). The page says "Not yet verified by AgEnD" next to an `integrity` pin; nothing else decides that.
 */
export type InstallPin = "audited" | "integrity";
export interface RuntimeCapabilities {
  /** The Runtime can list and (where `supports.execution`) run it. */
  readonly provider: Cap<NativeProviderFacts>;
  /** The dashboard installs it: from a pinned npm package (`npm`), or from one pinned download (`download`: exact address, size, sha512; no npm package exists). (The pins stay in runtime-cli-install.ts.) */
  readonly install: Cap<{ kind: "npm" | "download"; pin: InstallPin }>;
  /**
   * AGEND-136: the dashboard's Update button for that computer. `pinned`: the same closed installer as `install`, whose pinned release is the audited one
   * (runtime-cli-install.ts), so an update is that install over an older copy with every check of #3190 Part 3b; nothing the vendor's own updater would fetch runs.
   * `latest-unaudited` (AGEND-153): the named exception — the Runtime downloads the vendor's NEWEST release (named by the vendor's own manifest at a fixed address, saved only from a
   * fixed address prefix), checks its sha512 against that manifest and the publisher's Windows signature, and switches to it. The release is not one AgEnD has audited, and the page says so.
   */
  readonly update: Cap<{ kind: "pinned" | "latest-unaudited" }>;
  /**
   * The dashboard signs it in on that computer: the exact command, and whose login it is: a `named` profile this Runtime created (nothing else is touched), or `none`: the
   * computer's OWN login (a CLI that keeps one login per Windows user and has no profile folder; signing in REPLACES it, which is why only a CLI whose spec says `none` or `both` may, and the
   * computer's owner must have turned `accounts` on), or `both` (AGEND-124, Antigravity: the computer's own login AND named accounts, each with its own rules). A `none` or `both` is announced
   * to the server by a capability of its own (`signin-<id>`, runtimeSignInCapability).
   */
  readonly signIn: Cap<{ argv: readonly string[]; profile: "named" | "none" | "both" }>;
  /**
   * Named accounts on that computer: how the CLI is pointed at the profile's folder. `env`: the variable that does it (Claude Code). `arg`/`store`/`pin` (AGEND-124, Antigravity): the same launch-argument
   * facts as `host.namedAccounts` (a path relative to the CLI's own home, the file the sign-in is kept in, and the variables that keep it there: never in the Credential Manager, where one folder's sign-in would
   * be every folder's). They must be the host's, word for word (cli-registry-check.ts).
   */
  readonly namedAccounts: Cap<RuntimeNamedAccountFacts>;
  /**
   * Sign out from the dashboard on that computer: the CLI's own logout (`binary`, `args`, run under the profile's folder), or — for a CLI that has none (Antigravity) — the files AgEnD's Runtime removes itself
   * (`remove`: names inside a named account's folder) and, for the computer's own login, the Credential Manager entry (`credential`) the CLI keeps it in. Either way the answer is then checked with the CLI's own
   * status probe, so a sign-out that did not take effect is reported as that.
   */
  readonly signOut: Cap<{ binary: string; args: readonly string[] } | { remove: readonly string[]; credential: string }>;
  /** The Accounts page shows that computer's accounts of this CLI; `defaultRow`: the computer's own login is `read-only` there (a named account is added instead), or can be signed in (`sign-in`). */
  readonly accountRows: Cap<{ defaultRow: "read-only" | "sign-in" }>;
  /**
   * The status probe for a sign-in (never a login). `own-command`: a command of the CLI's own, run for that (`runtime.provider`'s auth probe). `model-listing`: the CLI has none, so its
   * answer is the model listing the Runtime already asks for (`argv` is `runtime.provider.modelProbe`, and the answer is read by its exit code and its words: no extra process).
   */
  readonly authStatus: Cap<{ argv: readonly string[]; source: "own-command" | "model-listing" }>;
  /** The Runtime reports which account it is (the whole e-mail address, in the `maskedEmail` field). */
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
export const HOST_CAPABILITIES = Object.freeze(["install", "update", "chatLogin", "dashboardSignIn", "structuredSignIn", "firstRunSignIn", "authCheck", "identity", "namedAccounts", "signOut", "keepAlive", "accountCard", "usage"] as const satisfies readonly (keyof HostCapabilities)[]);
export const RUNTIME_CAPABILITIES = Object.freeze(["provider", "install", "update", "signIn", "namedAccounts", "signOut", "accountRows", "authStatus", "identity", "usage"] as const satisfies readonly (keyof RuntimeCapabilities)[]);
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
