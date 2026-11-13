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
| `host.update` | the dashboard's Update: the command that takes the installed CLI to the **audited** release (`{version}` is filled on the server from `cli-audited.ts`); the one named exception (AGEND-153, Antigravity) has `release: "latest-unaudited"` and a command with no `{version}` | `hostUpdatePlan` in `web-host-install.ts` |
| `host.chatLogin` | `/login <name>` recognises it (`aliases`), and what it does (`mode`) | `LOGIN_FLOWS` in `login-flows.ts` |
| `host.dashboardSignIn` | the browser-terminal flow signs it in; `named`: a named account too | `LOGIN_FLOWS[id].noShellEscape`, `dashboardSignInSupported` |
| `host.structuredSignIn` | Sign in → open the page → paste the code; the exact command, how it `ends` (`success-line`, or `exit-code`: the CLI prints no success line, so signed in = exit 0 AND the auth check), whose `screen` table reads it (`login-flow` patterns, or an `own` closed table), what its prompt `answer`s (the `code`, or also the page's address: the box says to paste the code alone), its `minVersion`, and `named` (a named account is signed in with these controls too: the login was checked to land in the account's own folder) | `structured-signin.ts` (`SCREEN_READERS`), `runtime-signin.ts` (`BEHAVIOUR`) |
| `host.firstRunSignIn` | the first-run page offers it, as browser controls or only the console command | `browser-backend-signins.ts` |
| `host.authCheck` | a token-free probe of whether the sign-in works | `LOGIN_FLOWS[id].authCheck`, `BACKEND_AUTH_CHECKS` |
| `host.identity` | which account it is (masked): from the CLI's own status command (`status-command`), or from ONE named field of its own token file, read locally (`token-file`) | `IDENTITY_READERS` in `login-flows.ts` |
| `host.namedAccounts` | several sign-ins side by side: how the CLI is told its account — a variable that relocates its home (`relocate-home`, `redirect-files`), or an argument naming the account's folder (`launch-argument`, AGEND-119: `arg`, the file its sign-in is in (`store`), and `pin`, the variables every launch carries so the CLI keeps that sign-in in the file and not in a keyring shared by every folder; Antigravity has no switch of its own for this, so its `pin` is `SSH_CONNECTION`, which every program an agent on a named account starts (shell, tools, MCP servers) also sees — a program that behaves differently in an SSH session behaves so there) | `CREDENTIAL_HOMES` in `backend/credential-profile.ts` (`credentialProfileLaunch`) |
| `host.signOut` | the CLI's own logout (`binary`, `args`), or — for a CLI with none — the sign-in files AgEnD removes (`remove`), after which the CLI's own status probe says whether it took effect | `accounts-signout.ts` |
| `host.keepAlive` | "Keep sign-in alive" | `signin-keepalive.ts` |
| `host.accountCard` | a card on Settings → Accounts | — |
| `host.usage` | a row in the usage panel (provider id, name, place); `profileRows`/`hostRows`: a row for each named account an agent uses / every account on the host (Settings → Accounts reads them); `pools`: one set of limits (`single`) or pools the CLI names in its own answer (`several`: an Accounts row has a block per pool, named); `windows`: the kinds of window it reports (`session`, `weekly`, `monthly`, `unwindowed`). An Accounts row shows every pool and every window the account reports, in the usage panel's order, and `tests/cli-registry-usage-shape.test.ts` fails when a real payload carries a kind the entry does not list | `USAGE_FETCHERS` in `usage/providers.ts`, `accountUsage` in `accounts-view.ts` |
| `runtime.provider` | a Windows Runtime lists it and (if `supports.execution`) runs it | `windows-cli-worker.ts` |
| `runtime.install` | the dashboard installs it from a pinned package | pins and signer in `runtime-cli-install.ts` |
| `runtime.update` | the dashboard's Update on that computer: `pinned` — the pinned install over an older copy (the pin is the audited release); `latest-unaudited` — the one named exception (AGEND-153, Antigravity), see below | `INSTALLABLE_CLIS` in `runtime-cli-install.ts`; `tests/cli-audited-136.test.ts` |
| `runtime.signIn` | the dashboard signs it in on that computer: a `named` profile this Runtime created, `none`: the computer's OWN login (a CLI with one login per Windows user; signing in REPLACES it), or `both` (AGEND-124, Antigravity: the own login and named accounts). A `none` or `both` is announced by a capability derived from the registry, `signin-<id>`; named accounts of a CLI other than Claude Code by `accounts-<id>` | `runtime-signin.ts` (`BEHAVIOUR`) |
| `runtime.namedAccounts` | named accounts on that computer: the variable that points the CLI at the profile's folder (`env`), or (AGEND-124, Antigravity) the same launch-argument facts as the host (`arg`, `store`, `pin`; they must be the host's, word for word) | `runtime-credential-profiles.ts` (`credentialProfileLaunch`) |
| `runtime.signOut` | sign out on that computer: the CLI's own logout (`binary`, `args`), or what the Runtime removes itself (`remove`: a named account's token file; `credential`: the Credential Manager entry that holds the computer's own login), then the CLI's status probe says whether it took | `runtime-remote-accounts.ts` |
| `runtime.accountRows` | Accounts shows that computer's accounts of it; `defaultRow`: the computer's own login is `read-only` there, or can be signed in (`sign-in`) | `machine-accounts.ts` |
| `runtime.authStatus` | the status probe (never a login): `own-command` (the Runtime runs it), or `model-listing` (the CLI has none: the model listing it is asked for anyway says whether it is signed in) | `windows-cli-worker.ts`, `parseNativeAuthResult` |
| `runtime.identity` / `runtime.usage` | the Runtime reports the account / its usage | — |

### Why a CLI is, or is not, in the Windows Runtime's installer (`runtime.install`, #3521)

The rule stays "pinned and verifiable, or not at all" (the maintainer's answer on #3521): an exact version, the registry's hash of every package that lands, and who published the program.
Measured 2026-11-09 (the hashes and signers are in `runtime-cli-install.ts` and the specs):

| CLI | Verdict | Evidence |
|---|---|---|
| Claude Code, Codex | installed (pinned npm) | unchanged from #3190 Part 3b |
| OpenCode | **installed (pinned npm)** | `opencode-ai@1.19.5` (npm trusted publishing; the maintainer-confirmed audited version, 2026-11-09; re-measured 2026-11-10: the registry's sha512 of all three packages equals the pinned values, `npm audit signatures` verified 3 signatures with `--os=win32 --cpu=x64`, Authenticode `Valid` on both exes) + `opencode-windows-x64` + `opencode-windows-x64-baseline`, each with its registry sha512; `npm audit signatures`; both binaries are Authenticode `Valid`, signer `Anomaly Innovations, Inc https://anoma.ly/`. The `-baseline` build runs (it works on CPUs without AVX2; OpenCode's own postinstall, which picks by AVX2, is not run with `--ignore-scripts`). |
| Antigravity | **installed (pinned download)** (AGEND-135) | No npm package (`agy`, `antigravity-cli` on npm are not Google's). The vendor's manifest (`…/manifests/windows_amd64.json`, read 2026-11-09) names one versioned, immutable file: version `1.5.3`, `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.3-6604829099950080/windows-x64/cli_windows_x64.exe`, 225159320 bytes, sha512 `b282c10c…d909` (I downloaded it: the sha512 equals the manifest's), Authenticode `Valid`, subject `CN=Google LLC, O=Google LLC`; `agy.exe --version` prints `1.5.3` with no further setup (the vendor script's last step, `agy.exe install`, only edits PATH and shell aliases, and is not run). The Runtime pins the exact URL, size and sha512 in its table (`kind: "download"`), downloads that one address with its own fixed `Invoke-WebRequest` command (the address travels in the environment, never in the command text; the vendor's `install.ps1` is not run), refuses on a different size (a download that grows past the pinned size is stopped), a different sha512, or a signer that is not Google LLC with status `Valid`, and only then switches it on. Per user, in the Runtime's own folder, no administrator, no PATH change. The CLI updates itself afterwards, so the pin only governs what is first installed. Windows x64 only: the arm64 manifest exists (`windows_arm64.json`) but its file has not been measured here. **Why 1.5.3 and not the audited 1.3.6 (decision 2026-11-10):** the vendor manifest names only the newest build and its download address carries a build id, so an older release such as the audited 1.3.6 has no verifiable address to pin; and `agy` updates itself in the background after install, so pinning an old one would mean nothing. The pin therefore holds integrity (size, sha512, Google's signature), not an audit, and the page says "Not yet verified by AgEnD" next to it (upstream's rule for a CLI that updates itself). |
| Grok | no | `@xai-official/grok` (publisher `xai-security`) is on npm, but its Windows program (`grok.exe`, shipped brotli-compressed and unpacked by the package's own postinstall into `~/.grok`) is **not signed** (`NotSigned`): a registry hash and no statement of who built it. The vendor script installs whatever is current, so it cannot be pinned. |
| Kiro | no | The stable manifest lists one Windows artifact, an MSI (no zip, no per-user package); the script runs `msiexec` into `C:\Program Files\Kiro-Cli`, which needs elevation (maintainer: keep elevation out of one-click). |
| Muse | no | No npm package; its launcher (`muse-launcher.ps1`, not versioned) installs itself, and updates itself, from the vendor's server: there is no fixed file to pin. The page shows the official command and says why. |

**Which pin says "Not yet verified by AgEnD":** the registry's `runtime.install.pin` (`audited` or `integrity`), not the install kind and not a vendor. Both kinds are `audited` today: the npm CLIs, and Antigravity's download (its pinned 1.5.3 is on the audited ledger since #3539 — before that it was `integrity`, "Not yet verified"). `integrity` stays for a pin that is not on the ledger. A failure message of the download path names the file ("The downloaded file…"), never "the package".

A CLI that stays "official command only" (Grok, Muse, Kiro) says why on the page (`OFFICIAL_COMMANDS` in `src/ui/runtime-cli-install.js`, from the same facts).

A `no` says why: `cli_has_none` (the tool has no such thing), `not_applicable` (it needs a capability this CLI lacks), `by_design` (decided against; the note says where),
`needs_verification` (nobody has run the tool to find out; the note says what to check), or `not_yet_built` (it can be done; `tracking` is `#<n>` or `undecided`).

## Updating a CLI from the dashboard (AGEND-136, upstream #3521)

An installed CLI shows its version on its row (Settings → Agents → AI accounts, and Settings → Runtime for a paired computer) against the newest version **AgEnD has audited**
(`src/cli-audited.ts`: the shipped mirror of the daily upstream watch's ledger, decision ffb8104e — the same list the Windows pane gate reads). The button never goes to "latest".

| Installed version | The page shows | Button |
|---|---|---|
| older than the audited release, and the registry has an update | both versions | **Update to \<audited\>** |
| older, and the CLI updates itself (no `host.update`) | both versions, and that it updates itself | none |
| **Antigravity** (the named exception, AGEND-153): any readable version — older, at, or newer than the audited release | both versions, and that the update is **not audited** | **Update to latest (not audited by AgEnD)** (zh-TW: 更新到最新版（未經盤點）) |
| the audited release | "up to date" and the audited version | none |
| newer than anything audited | "not verified by AgEnD yet" | none |
| not readable | the audited version | none |

The browser sends only the CLI's id (`POST /ui/host-update { backend }`; any other key is a 400). The server picks the command (`host.update`, `{version}` ← the audited release,
checked against `^\d+\.\d+\.\d+$`) and runs it through the same install window as `/login` and the Install button (`openInstallWindow`): one window fleet-wide, cancellable, judged by the
exit code; the page shows the version before and after (the binary probe) or the exit code and the last lines. An update that exits 0 is a success only if the version read afterwards equals the audited release (`reached`); if not (or if it cannot be read) the page shows a warning naming the installed and the audited version. Who may: the Install button's gate (a fleet admin on the local surface; never a guest,
a read session, the CLI's header token or the public link). **Install and Update are held changes of the Settings gate** (`/ui/host-install`, `/ui/host-update` in `HOST_CLI_PATHS`, `settings-effect.ts`): the lenient default
applies an administrator's change at once (the same path as the ordinary New Agent shortcut), and an administrator who turned on "ask for my code" takes their own authenticator code, bound to the digest of the change, when they are not
on the computer. The route runs only as the gate's confirmed replay; the asker's authority is asked again after every wait and right before the installer window opens. An update's admission also needs one **fresh, successful** version
reading of the executable that resolves now (`BackendAvailabilityStore.freshVersion`); the published row keeps the old number when a probe fails (the pickers fail open) and is never an update's authorization — unreadable refuses (`version_unreadable`).
A Windows computer additionally needs its owner's `install` switch.

What each CLI does (checked 2026-11-09: the vendors' docs, and the CLIs' own `--help` run in an isolated HOME — no real account, nothing of the host's touched):

| CLI | Host | Why |
|---|---|---|
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash -s <audited>` | `claude update` always goes to the release channel's newest (`autoUpdatesChannel`: latest or stable), and the native build also updates itself in the background. The installer's version argument is the documented way to a chosen release ([Install a specific version](https://code.claude.com/docs/en/setup)). |
| Codex | `curl -fsSL https://chatgpt.com/codex/install.sh \| CODEX_NON_INTERACTIVE=1 sh -s -- --release <audited>` | `codex update` (0.167.0's `--help`: "Update Codex to the latest version") has no version argument; the installer's `--release VERSION` is in its own `--help`. |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash -s -- --version <audited>` | `opencode upgrade [target]` can take a version, but it needs `opencode` on the window's PATH; the installer (`--version`) is where the host's copy came from. |
| Grok | `curl -fsSL https://x.ai/cli/install.sh \| bash -s <audited>` | `grok update --version <V>` exists (grok 1.0.77's `--help`, docs.x.ai CLI reference); the installer takes the same version as its argument and does not need `grok` on PATH. |
| Kiro | `curl -fsSL https://cli.kiro.dev/install \| bash -s -- --version <audited> --force` | `kiro-cli update` (3.1.0's `--help`: `--check`, `--force`) has no version argument. The installer has `--version`, and `--force` so that "replace it?" never waits on a terminal nobody has. |
| Antigravity | `agy update` (**the named exception**, AGEND-153) | Updates itself and `agy update` cannot choose a release, so — by the maintainer's decision on #3539 — the button runs it as it is and the CLI goes to **the latest release Google serves, which AgEnD has not audited**. The registry says so (`host.update.release: "latest-unaudited"`, a command with no `{version}`; `hostUpdatePlan` answers `target: null`), the button and the line say "latest, not audited", the held change says "LATEST … (not audited by AgEnD)", and the run reports the version before and after, never "did not reach the audited version". Everything else is an update's: the held change and each admin's own code (#3542/#3503), no public link, the same one window. |
| Muse | none | The launcher updates itself every hour (`MUSE_UPDATE_INTERVAL_SECONDS`; the launcher script has no update subcommand). Versions only. |

**On a paired Windows computer** the CLIs with a pinned npm install (Claude Code, Codex, and — AGEND-153 — OpenCode, whose pin 1.19.5 is the newest audited release) are updated by **the same pinned install over the older
copy**, not by the vendor's own updater. The vendor updater (`claude update`, `codex update`) would fetch whatever the channel serves at that moment and run it unverified on a computer nobody is watching,
which is exactly what #3190 Part 3b rules out. The pins in `runtime-cli-install.ts` are therefore kept equal to the newest audited release (`tests/cli-audited-136.test.ts` fails when they are not),
and every check of Part 3b still applies: exact version, the registry's sha512 of each package, `npm audit signatures`, and the publisher's Authenticode signature. The page shows "Update to <audited>"
when the computer's copy is older, "up to date" at it, and "not verified by AgEnD yet" (no button) when it is newer. Grok, Kiro and Muse have no pinned install and so no remote update:
the registry says why (`runtime.update`).

**The named exception on a computer (AGEND-153): Antigravity → the vendor's latest, not audited.** Antigravity updates itself, and the vendor serves only its newest build, so the Runtime cannot be pinned to an older one.
When the computer already has it, the same route (`POST …/cli-install { cli }`, the same held change and each admin's own code, the computer owner's `install` switch on that computer) sends the Runtime `cli.update`
(capability `cli-update`; an older Runtime does not claim it and is never asked). The Runtime does **not** run the vendor's updater. It reads the vendor's manifest (`LATEST_UNAUDITED.antigravity.manifest`, one fixed address, with its
own fixed `Invoke-WebRequest` command), accepts it only if it is `{ version: x.y.z, url, sha512 }` with the `url` of the vendor's fixed storage shape **for that version**
(`https://storage.googleapis.com/antigravity-public/antigravity-cli/<version>-<build>/windows-x64/cli_windows_x64.exe`), then does what a pinned download does: the file's size (a ceiling and not empty — the manifest names no size),
its sha512 against that manifest, and the Authenticode signer (`Google LLC`, status `Valid`) — then switches `current.json` to the new version folder. Any mismatch refuses and leaves the old copy. A copy at or above the manifest's version is left
alone. An **Install** on a computer without Antigravity is still the pinned, audited download (1.5.3). Measured 2026-11-10: the manifest is `{ "version": "1.5.3", "url": …/1.5.3-6604829099950080/…, "sha512": … }` and agrees with the pin.

**Adding a release to the ledger:** when the upstream watch marks a version audited, add it to `AUDITED_CLI_VERSIONS` (the same change carries the audit's tests and fixtures). For Claude Code or Codex that
is also a new pin in `runtime-cli-install.ts` (its sha512 of each package, taken from the registry, and the Authenticode signer checked on the real `.exe`). Maintaining this shipped ledger is part of our audit PRs: when a version is marked
audited, adding it here is the maintainer's step. A CLI that ships a build keeps it in the entry and in what the page reads (`versionOf`: Muse's `1.4.14-R7309.1`), so an installed `1.4.14-R7012.1` is told apart from the audited release.

The ledger as the maintainer confirmed it (2026-11-09 21:00 Taipei): Claude Code 2.1.319, Codex 0.167.0, Kiro 3.1.0, Grok 1.0.77, Antigravity 1.5.3, OpenCode 1.19.5, Muse 1.4.14-R7309.1. Re-measured 2026-11-10 for the two npm pins this changes:
`@anthropic-ai/claude-code@2.1.319` (+ `-win32-x64`) and `@openai/codex@0.167.0` (+ `0.167.0-win32-x64`) — the registry's sha512 equals the pinned values, `npm audit signatures` verified the registry signatures, `claude.exe` is Authenticode `Valid`
(Anthropic, PBC) and `codex.exe` is `Valid` (OpenAI OpCo, LLC).

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

- The server sends a Runtime only a CLI id (and a profile name, except for a CLI whose `runtime.signIn.profile` is `none`: it has no profile to send); nothing in the registry is sent anywhere. A Runtime reads its own copy, shipped in its own bundle
  (`CLI_REGISTRY_MODULES` in `runtime-build-info.ts`). Its whitelist is still the frozen table it builds at start, and the computer's own `accounts` switch still applies.
- Values that decide what is run (sign-in commands, environment variable names, probes, executable names, the login flows' safety flags) are also written out in
  `tests/cli-registry-golden.test.ts`. Changing one takes a change in both places.
- The registry's data files import only Node built-ins and each other (`tests/cli-registry-runtime-safe.test.ts`), and `tests/cli-registry-runtime-bundle.test.ts` builds a
  bundle and runs it outside the dependency tree.
- `tests/cli-registry-no-literal-lists.test.ts` fails on a new hand-written list of CLI ids in `src`. If the list is about something else (which CLIs run a persistent
  pane, display names), allow it there with the reason; otherwise ask the registry.
- The dashboard's `cli-caps.js` holds booleans and words only. Authorization is not decided there: the server still checks every request.
