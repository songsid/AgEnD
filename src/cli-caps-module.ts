/**
 * CLI registry, step 3: what the dashboard's scripts may ask about a CLI, derived from the registry (cli-registry.ts) and written to `src/ui/cli-caps.js` by
 * `npx tsx scripts/gen-cli-caps.mts`. The scripts used to write CLI ids out by hand (which CLIs can sign out, which sign in with browser controls, how a Move words the
 * conversation, which a Runtime can install); they import this module instead, so a CLI the registry says can do something is the same CLI the page offers it for.
 *
 * Booleans and words only; nothing in the module runs anything or names a command. It is a generated file, not a hand-kept one: tests/cli-registry-ui-caps.test.ts
 * fails while it differs from what this function renders, and says how to regenerate it. (A file, not a request, so a page that has not finished loading
 * cannot be missing it, and the setup page's server needs no new route. Authorization is not here: the server still checks every request itself.)
 */
import { CLI_IDS, hostFacts, hostIdsByRank, isRuntimeDefaultLoginCli, runtimeFacts, type CarryKind, type CliId } from "./cli-registry.js";

/** What a page may ask of one CLI. */
export interface UiCliCaps {
  /** The dashboard can sign this CLI's account out (`host.signOut`). */
  signOut: boolean;
  /** It is signed out by AgEnD removing the account's sign-in file (the CLI has no logout command; `host.signOut.remove`), and then checking: the dialog says so instead of "the CLI's own logout". */
  signOutFiles: boolean;
  /** The CLI can have named accounts (`host.namedAccounts`), and how a Move between two of them words the conversation; null when it has none. */
  namedAccounts: boolean;
  /** An account is the CLI's whole app-data folder (`host.namedAccounts` as a launch argument): Remove deletes its conversations with its sign-in. */
  accountIsFolder: boolean;
  carry: CarryKind | null;
  /** Browser controls for default accounts (`host.structuredSignIn`), and separately named accounts (`host.structuredSignIn.named`). */
  structuredSignIn: boolean;
  structuredNamedSignIn: boolean;
  /** The first-run page offers this CLI: as browser controls, or only as the console command; null when it does not (`host.firstRunSignIn`). */
  firstRunSignIn: "browser" | "console" | null;
  /** A Windows Runtime can install it from the dashboard, and the name it lists it by (`runtime.install`, `runtime.provider.name`). */
  runtimeInstall: boolean;
  runtimeName: string | null;
  /** A Windows Runtime can UPDATE it from the dashboard (`runtime.update`): install and update are separate facts — a CLI may be install-only (it updates itself, or Update is not built). */
  runtimeUpdate: boolean;
  /** AGEND-153: that update is the named exception — it goes to the vendor's newest release, which AgEnD has not audited (`runtime.update.kind: "latest-unaudited"`); the page labels it so. */
  runtimeUpdateLatest: boolean;
  /** A Runtime signs it in as the COMPUTER'S OWN login (no profile; `runtime.signIn.profile === "none"`): the page asks before it changes that login. */
  runtimeDefaultLogin: boolean;
  /** A Runtime keeps NAMED accounts of it on a paired computer (`runtime.namedAccounts`; AGEND-124): an agent there can choose one, and the Accounts page adds, signs in and removes them under that computer's name. */
  runtimeNamedAccounts: boolean;
  /** The oldest CLI that has the structured sign-in's command (`host.structuredSignIn.minVersion`), for the words that say "too old"; null: any. */
  structuredMinVersion: string | null;
  /** `/login <name>` in chat runs a flow for it (`host.chatLogin`'s mode is not `declined` or `install-only`): the older dialog can sign it in, so a "console fallback" is offered. */
  chatSignIn: boolean;
  /** The CLI's own prompt also accepts the page's address, which AgEnD's code box refuses: the box says to paste the code alone (`host.structuredSignIn.answer`). */
  codeHint: boolean;
}

export function uiCliCaps(): Record<CliId, UiCliCaps> {
  return Object.fromEntries(CLI_IDS.map(id => {
    const named = hostFacts(id, "namedAccounts"), structured = hostFacts(id, "structuredSignIn");
    const caps: UiCliCaps = {
      signOut: hostFacts(id, "signOut") !== null,
      signOutFiles: hostFacts(id, "signOut") !== null && "remove" in hostFacts(id, "signOut")!,
      namedAccounts: named !== null,
      accountIsFolder: named?.home === "launch-argument",
      carry: named?.carry ?? null,
      structuredSignIn: structured !== null,
      structuredNamedSignIn: structured?.named === true,
      firstRunSignIn: hostFacts(id, "firstRunSignIn")?.mode ?? null,
      runtimeInstall: runtimeFacts(id, "install") !== null,
      runtimeUpdate: runtimeFacts(id, "update") !== null,
      runtimeUpdateLatest: runtimeFacts(id, "update")?.kind === "latest-unaudited",
      runtimeName: runtimeFacts(id, "install") ? runtimeFacts(id, "provider")?.name ?? null : null,
      runtimeDefaultLogin: isRuntimeDefaultLoginCli(id),
      runtimeNamedAccounts: runtimeFacts(id, "namedAccounts") !== null,
      codeHint: structured?.answer === "code-or-address",
      structuredMinVersion: structured?.minVersion ?? null,
      chatSignIn: ["device-code", "paste-code", "menu"].includes(hostFacts(id, "chatLogin")?.mode ?? ""),
    };
    return [id, caps] as const;
  })) as Record<CliId, UiCliCaps>;
}

/** The exact text of `src/ui/cli-caps.js`. Deterministic: same registry, same bytes. */
export function renderCliCapsModule(): string {
  const caps = uiCliCaps();
  const object = (value: object): string => `{ ${Object.entries(value).map(([key, item]) => `${key}: ${JSON.stringify(item)}`).join(", ")} }`;
  const rows = CLI_IDS.map(id => `  ${JSON.stringify(id)}: Object.freeze(${object(caps[id])}),`);
  return `// GENERATED by \`npx tsx scripts/gen-cli-caps.mts\` from src/cli-registry.ts. Do not edit it: tests/cli-registry-ui-caps.test.ts fails while it differs from the registry.
// What the dashboard's scripts may ask about a CLI (see src/cli-caps-module.ts). Booleans and words only; nothing here runs anything.
export const CLI_CAPS = Object.freeze({
${rows.join("\n")}
});
/** The CLIs the first-run page offers a sign-in for, in its order. */
export const FIRST_RUN_BACKENDS = Object.freeze([${hostIdsByRank("firstRunSignIn").map(id => JSON.stringify(id)).join(", ")}]);
/** The caps of a CLI id; null for anything that is not one (a name from a URL, a config file or a request). */
export const capsOf = (id) => (typeof id === "string" && Object.hasOwn(CLI_CAPS, id) ? CLI_CAPS[id] : null);
`;
}
