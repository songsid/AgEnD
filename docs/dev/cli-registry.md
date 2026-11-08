# The CLI capability registry

What each AI tool (CLI) can do in AgEnD is answered in **one place**: `src/cli-registry.ts`, one `src/cli-spec-<id>.ts` per CLI. Before it, the same answers
were written out in about thirty lists across the server, the dashboard's scripts and the Windows Runtime, and a CLI that was added to some of them and not
the others "signed in, but showed no account and no usage". Now a capability is either **`yes`** (with the few facts the rest of AgEnD needs) or **`no`** (with a
reason and a sentence), for every CLI, and leaving one out does not compile.

## What is in it

Plain data: strings, numbers, booleans and lists of them; no function, no RegExp, nothing read from the disk or the network. It is deeply frozen. Behaviour
(screen reduction, identity parsing, usage reads, a login flow's patterns) stays in its own file, keyed by the CLI id; a `yes` is a promise that it is there, and
`tests/cli-registry-completeness.test.ts` checks the promise.

| Capability | `yes` means | Behaviour that backs it |
|---|---|---|
| `host.install` | a binary and the command a person (or the install window) runs | `BIN_DIRS` in `instance-lifecycle.ts` |
| `host.chatLogin` | `/login <name>` recognises it (`aliases`), and what it does (`mode`) | `LOGIN_FLOWS` in `login-flows.ts` |
| `host.dashboardSignIn` | the browser-terminal flow signs it in; `named`: a named account too | `LOGIN_FLOWS[id].noShellEscape`, `dashboardSignInSupported` |
| `host.structuredSignIn` | Sign in → open the page → paste the code; the exact command | `structured-signin.ts` |
| `host.firstRunSignIn` | the first-run page offers it, as browser controls or only the console command | `browser-backend-signins.ts` |
| `host.authCheck` | a token-free probe of whether the sign-in works | `LOGIN_FLOWS[id].authCheck`, `BACKEND_AUTH_CHECKS` |
| `host.identity` | which account it is (masked), read from the CLI's own status | `AUTH_IDENTITY` in `login-flows.ts` |
| `host.namedAccounts` | several sign-ins side by side (the variable that relocates its home) | `CREDENTIAL_HOMES` in `backend/credential-profile.ts` |
| `host.signOut` | the CLI's own logout | `accounts-signout.ts` |
| `host.keepAlive` | "Keep sign-in alive" | `signin-keepalive.ts` |
| `host.accountCard` | a card on Settings → Accounts | — |
| `host.usage` | a row in the usage panel (provider id, name, place) | `USAGE_FETCHERS` in `usage/providers.ts` |
| `runtime.provider` | a Windows Runtime lists it and (if `supports.execution`) runs it | `windows-cli-worker.ts` |
| `runtime.install` | the dashboard installs it from a pinned package | pins and signer in `runtime-cli-install.ts` |
| `runtime.signIn` | the dashboard signs it in on that computer | `runtime-signin.ts` |
| `runtime.namedAccounts` | named accounts on that computer | `runtime-credential-profiles.ts` |
| `runtime.accountRows` | Accounts shows that computer's accounts of it | `machine-accounts.ts` |
| `runtime.authStatus` | the status probe the Runtime runs (never a login) | `windows-cli-worker.ts` |
| `runtime.identity` / `runtime.usage` | the Runtime reports the account / its usage | — |

A `no` says why: `cli_has_none` (the tool has no such thing), `not_applicable` (it needs a capability this CLI lacks), `by_design` (decided against; the note says where),
`needs_verification` (nobody has run the tool to find out; the note says what to check), or `not_yet_built` (it can be done; `tracking` is `AGEND-<n>`, `#<n>` or `undecided`).

## Adding a CLI

1. Add its id to `CLI_IDS` (`src/cli-capability.ts`); the order is the Accounts page's.
2. Copy a spec: `src/cli-spec-<id>.ts`. `tsc` lists every capability you have not answered. Add it to the table in `src/cli-registry.ts`.
3. Run `npx tsx scripts/gen-cli-caps.mts` (the dashboard's scripts read `src/ui/cli-caps.js`, which is generated from the registry).
4. Run `npx vitest run tests/cli-registry`. The failures say what is left: a `yes` with no behaviour behind it, a login flow, an installer directory, a usage reader; the
   golden test (`cli-registry-golden.test.ts`) asks you to write the values that decide what AgEnD or a Runtime starts out literally, so they are reviewed twice.
5. A capability you cannot answer yet is `toVerify(...)` or `notYetBuilt("undecided", ...)`, never left out.

A registry entry that is written wrongly (a usage `providerId` no provider has, a `yes` whose behaviour does not exist, an argv that disagrees with another fact) throws when the
registry module is imported. The daemon does not start and every test file that imports the registry fails with the same message; that is on purpose, so the mistake shows up the first
time anything runs and not in front of a user.

## Rules that keep it safe

- The server sends a Runtime only a CLI id (and a profile name); nothing in the registry is sent anywhere. A Runtime reads its own copy, shipped in its own bundle
  (`CLI_REGISTRY_MODULES` in `runtime-build-info.ts`). Its whitelist is still the frozen table it builds at start, and the computer's own `accounts` switch still applies.
- Values that decide what is run (sign-in commands, environment variable names, probes, executable names, the login flows' safety flags) are also written out in
  `tests/cli-registry-golden.test.ts`. Changing one takes a change in both places.
- The registry's data files import only Node built-ins and each other (`tests/cli-registry-runtime-safe.test.ts`), and `tests/cli-registry-runtime-bundle.test.ts` builds a
  bundle and runs it outside the dependency tree.
- `tests/cli-registry-no-literal-lists.test.ts` fails on a new hand-written list of CLI ids in `src`. If the list is about something else (which CLIs run a persistent
  pane, display names), allow it there with the reason; otherwise ask the registry.
- The dashboard's `cli-caps.js` holds booleans and words only. Authorization is not decided there: the server still checks every request.
