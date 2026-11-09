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

**Which pin says "Not yet verified by AgEnD":** the registry's `runtime.install.pin` (`audited` or `integrity`), not the install kind and not a vendor. Antigravity is `integrity` (see its row); the npm CLIs are `audited`. A failure message of the download path names the file ("The downloaded file…"), never "the package".

A CLI that stays "official command only" (Grok, Muse, Kiro) says why on the page (`OFFICIAL_COMMANDS` in `src/ui/runtime-cli-install.js`, from the same facts).

A `no` says why: `cli_has_none` (the tool has no such thing), `not_applicable` (it needs a capability this CLI lacks), `by_design` (decided against; the note says where),
`needs_verification` (nobody has run the tool to find out; the note says what to check), or `not_yet_built` (it can be done; `tracking` is `#<n>` or `undecided`).

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
