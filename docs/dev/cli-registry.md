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
| `host.update` | the dashboard's Update: the command that takes the installed CLI to the **audited** release (`{version}` is filled on the server from `cli-audited.ts`) | `hostUpdatePlan` in `web-host-install.ts` |
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
| `runtime.update` | the dashboard's Update on that computer: the pinned install over an older copy (the pin is the audited release) | `INSTALLABLE_CLIS` in `runtime-cli-install.ts`; `tests/cli-audited-136.test.ts` |
| `runtime.signIn` | the dashboard signs it in on that computer | `runtime-signin.ts` |
| `runtime.namedAccounts` | named accounts on that computer | `runtime-credential-profiles.ts` |
| `runtime.accountRows` | Accounts shows that computer's accounts of it | `machine-accounts.ts` |
| `runtime.authStatus` | the status probe the Runtime runs (never a login) | `windows-cli-worker.ts` |
| `runtime.identity` / `runtime.usage` | the Runtime reports the account / its usage | — |

A `no` says why: `cli_has_none` (the tool has no such thing), `not_applicable` (it needs a capability this CLI lacks), `by_design` (decided against; the note says where),
`needs_verification` (nobody has run the tool to find out; the note says what to check), or `not_yet_built` (it can be done; `tracking` is `#<n>` or `undecided`).

## Updating a CLI from the dashboard (AGEND-136, upstream #3521)

An installed CLI shows its version on its row (Settings → Agents → AI accounts, and Settings → Runtime for a paired computer) against the newest version **AgEnD has audited**
(`src/cli-audited.ts`: the shipped mirror of the daily upstream watch's ledger, decision ffb8104e — the same list the Windows pane gate reads). The button never goes to "latest".

| Installed version | The page shows | Button |
|---|---|---|
| older than the audited release, and the registry has an update | both versions | **Update to \<audited\>** |
| older, and the CLI updates itself (no `host.update`) | both versions, and that it updates itself | none |
| the audited release | "up to date" and the audited version | none |
| newer than anything audited | "not verified by AgEnD yet" | none |
| not readable | the audited version | none |

The browser sends only the CLI's id (`POST /ui/host-update { backend }`; any other key is a 400). The server picks the command (`host.update`, `{version}` ← the audited release,
checked against `^\d+\.\d+\.\d+$`) and runs it through the same install window as `/login` and the Install button (`openInstallWindow`): one window fleet-wide, cancellable, judged by the
exit code; the page shows the version before and after (the binary probe) or the exit code and the last lines. An update that exits 0 is a success only if the version read afterwards equals the audited release (`reached`); if not (or if it cannot be read) the page shows a warning naming the installed and the audited version. Who may: the Install button's gate (a fleet admin on the local surface; never a guest,
a read session, the CLI's header token or the public link). A Windows computer additionally needs its owner's `install` switch.

What each CLI does (checked 2026-11-09: the vendors' docs, and the CLIs' own `--help` run in an isolated HOME — no real account, nothing of the host's touched):

| CLI | Host | Why |
|---|---|---|
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash -s <audited>` | `claude update` always goes to the release channel's newest (`autoUpdatesChannel`: latest or stable), and the native build also updates itself in the background. The installer's version argument is the documented way to a chosen release ([Install a specific version](https://code.claude.com/docs/en/setup)). |
| Codex | `curl -fsSL https://chatgpt.com/codex/install.sh \| CODEX_NON_INTERACTIVE=1 sh -s -- --release <audited>` | `codex update` (0.167.0's `--help`: "Update Codex to the latest version") has no version argument; the installer's `--release VERSION` is in its own `--help`. |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash -s -- --version <audited>` | `opencode upgrade [target]` can take a version, but it needs `opencode` on the window's PATH; the installer (`--version`) is where the host's copy came from. |
| Grok | `curl -fsSL https://x.ai/cli/install.sh \| bash -s <audited>` | `grok update --version <V>` exists (grok 1.0.77's `--help`, docs.x.ai CLI reference); the installer takes the same version as its argument and does not need `grok` on PATH. |
| Kiro | `curl -fsSL https://cli.kiro.dev/install \| bash -s -- --version <audited> --force` | `kiro-cli update` (3.1.0's `--help`: `--check`, `--force`) has no version argument. The installer has `--version`, and `--force` so that "replace it?" never waits on a terminal nobody has. |
| Antigravity | none | Updates itself in the background (`agy update` exists but cannot choose a release). The page shows installed and audited versions, and "not verified" when it is ahead. |
| Muse | none | The launcher updates itself every hour (`MUSE_UPDATE_INTERVAL_SECONDS`; the launcher script has no update subcommand). Versions only. |

**On a paired Windows computer** the three CLIs with a pinned npm install (Claude Code, Codex; OpenCode when its pinned install lands) are updated by **the same pinned install over the older
copy**, not by the vendor's own updater. The vendor updater (`claude update`, `codex update`) would fetch whatever the channel serves at that moment and run it unverified on a computer nobody is watching,
which is exactly what #3190 Part 3b rules out. The pins in `runtime-cli-install.ts` are therefore kept equal to the newest audited release (`tests/cli-audited-136.test.ts` fails when they are not),
and every check of Part 3b still applies: exact version, the registry's sha512 of each package, `npm audit signatures`, and the publisher's Authenticode signature. The page shows "Update to <audited>"
when the computer's copy is older, "up to date" at it, and "not verified by AgEnD yet" (no button) when it is newer. Grok, Antigravity, Kiro and Muse have no pinned install and so no remote update:
the registry says why (`runtime.update`).

**Adding a release to the ledger:** when the upstream watch marks a version audited, add it to `AUDITED_CLI_VERSIONS` (the same change carries the audit's tests and fixtures). For Claude Code or Codex that
is also a new pin in `runtime-cli-install.ts` (its sha512 of each package, taken from the registry, and the Authenticode signer checked on the real `.exe`).

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
