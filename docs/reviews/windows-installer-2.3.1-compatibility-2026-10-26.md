# Live Windows installer compatibility: stable 2.3.1 and beta.11

Verdict: keep the default `latest` channel. A narrow readiness fix is required for **both** releases; switching the default to beta would not fix it. After that fix, the audited installer/package contracts work with both releases. Stable intentionally falls back to console backend sign-in; the newer browser backend checklist requires beta. This is a contract audit with isolated probes, not a real Windows installation or real-account sign-in test.

## Inputs and method

On 2026-10-26, the live [bootstrap](https://songsid.github.io/AgEnD/install.ps1), [Windows installer](https://songsid.github.io/AgEnD/install-agend.ps1), and [shell installer](https://songsid.github.io/AgEnD/install.sh) matched the files at main `fdc23c308` byte-for-byte. npm reported `latest=2.3.1` and `beta=2.3.2-beta.11`. Both exact packages were obtained with `npm pack --ignore-scripts`, extracted and read; no npm lifecycle hook was run.

| Input | SHA256 |
|---|---|
| Live install.ps1 | `0409bb057d48753a07a91a8420adc986ef4c0629933bed8a08ebbd87b8da219f` |
| Live install-agend.ps1, before fix | `7ab82968cb12cc639bc1b71872b51028d8a6cae3945f46278ec70364799349f5` |
| Live install.sh | `be1ab72e81f7f6eef6710ec7db9514be7ee1f3e7286d70c057cf1213c3253c24` |
| Published 2.3.1 tarball | `d652c88dcfc0ee8c58bcf91c3fc4d0ee676457fbac25aed4afd423b90c738ab8` |
| Published 2.3.2-beta.11 tarball | `3b92b59ac6b9d33cf177a7cc7f89651caddbd8dfd21134e8c48c4d61f3f649a8` |

PowerShell 7.4.2 and Node 22.22.2 ran in one disposable Linux container with no external network, a private HOME/AGEND_HOME, a 1 CPU/1 GiB limit, and no Windows desktop, accounts, fleet or real WSL. The package CLI capability probes denied child processes and listener startup. HTTP probes constructed only an inert loopback server around each package's actual auth handlers, with explicit health snapshots; no FleetManager was constructed. Native WSL/backend/service actions in the PowerShell tests were stubbed. Package probes borrowed the workspace dependency tree; they were not a fresh npm dependency installation.

In the table, ✅ means a supported or safely gated **contract**, not proof of native Windows/WSL success. ❌ identifies a failure or feature degradation. “Resume” means a progress file remains; a completed-install rerun takes a different shortcut-only path.

## Stage-by-stage compatibility

| Status | Stage and installed-package contract | Fresh 2.3.1 | Rerun / repair of 2.3.1 | beta.11 and action |
|---|---|---|---|---|
| ✅ | Bootstrap download, UAC/Windows Terminal, initiating identity, RunOnce, progress/log files, AGEND_VERSION validation | Installer-owned PowerShell/Windows behavior; no AgEnD CLI is needed yet | Same scripts and saved target/version selection | Same. No beta package contract is used here |
| ✅ | WSL feature/MSI checks, Ubuntu install/import/root readiness, distro choice | OS-owned commands and files, independent of package version | Checks actual resources rather than trusting saved stage numbers | Same. DISM/WSL/native reboot behavior remains outside this Linux contract test |
| ✅ | Merge/back up `.wslconfig` and `/etc/wsl.conf`; browser URL helper and WSL environment | Installer-owned files, not new AgEnD APIs | Preserves unrelated settings; a malformed/unsafe file is refused | Same; no version fallback needed |
| ✅ | Native Node, tmux, compiler tools; AGEND_HOME permissions | Both manifests support Node `^22.14.0 \|\| ^23.6.0 \|\| >=24`; both expose the same launchers and bundled runtime pins | Working CLI/native dependencies are re-probed; broken resources remain retryable | Same Node/better-sqlite3/runtime contracts; launcher files are byte-identical |
| ✅ | install.sh → target-owned `agend-install`, global `@songsid/agend` layout, pre/postinstall, `--version`, completion | Stable's own installer accepts the shell dispatch; package installation alone does not mean setup is complete | Existing install can be repaired and its service refreshed; an existing fleet may restart | Same dispatch/launcher/service implementation. Keep latest and explicit pins unchanged |
| ✅ | Backend selection/install/version/auth probes | Kiro/Claude/Codex/agy are external backend contracts, not beta-only AgEnD flags | Selected backends are checked individually; incomplete installs/auth stay retryable | Same installer probes; no real backend installation or account sign-in was performed |
| ❌ | Browser backend checklist: `setup --backend-signin-capabilities`, setup/web `--backend-signins` | Stable lacks these flags. The existing probe fails closed and explicitly offers console login or skipping | Same if resuming setup; completed shortcut reruns use ordinary `web --code` | Beta capability JSON enables the checklist. This is intentional degradation, already correctly gated; never send beta-only flags to stable |
| ✅ | Plain `agend setup`; `--reset`, `--port`, `--tunnel`; setup page/code/success/already/expiry strings | Stable supports browser fleet setup, including Web only | “Already completed” is recognized without resetting or overwriting the configuration; expired setup can reopen or use quickstart | Same base contracts. Browser **backend** sign-in capability is separate from browser **fleet setup** |
| ✅ | Setup host-confirmation audit: `source=setup_session`, 32-hex id; `agend settings confirm ID` | Present in stable; the installer can open the separate human confirmation window | Still requires the person's y/N confirmation; no automatic approval fallback | Same. Do not bypass confirmation or synthesize `--yes` |
| ✅ | `agend quickstart` console fallback | Supported; used if browser setup fails or the person selects it | Existing configuration handling/backups remain package-owned | Supported in both; actual interactive terminal use was not exercised |
| ✅ | `agend install`; user unit `com.agend.fleet`; systemd linger and enable/start | Stable exposes the command and activates the same unit | An active unit is reused rather than torn down again | Same. The existing shortcut-only rerun does not independently prove enabled-on-boot status |
| ✅ | `agend validate --connections` → `CONNECTIONS=0`, positive count or unknown | Already supported by stable; Web-only setup is not mistaken for a chat connection | Supported in the resumed full flow | Same. No raw-YAML grep or legacy success guess is needed |
| ❌ | **Before fix:** active unit + `/health` + unauthenticated GET `/` required OK | `/` redirects to protected `/ui`; actual response is 401. A healthy install is reported not ready, exits 1 and retains progress | A resumed stage-5 marker fails its readiness recheck again; broken-install repair that reaches this flow has the same problem | **Also fails on beta.11**. Use the public `/signin` page; changing version/default cannot fix this |
| ✅ | **After fix:** active unit + `/health` + public GET `/signin` | `/signin` is public/inert and returns 200 in the actual stable package | The same independent check can now complete a resumed install | Actual beta package also returns 200. Protected `/ui` remains 401; no cookie, token or code minting is introduced |
| ✅ | `/health`: configured `health_port` or 19280; `status`, `startupComplete`, `problems` | Fields exist in stable. Finished startup with ok/degraded remains usable; down/incomplete remains blocked | Same checks apply on resume; warnings remain visible | Same. No health gate is relaxed by the fix |
| ✅ | `agend web --code` → `Sign-in page:` and `Code:`; `/auth/issue-code`, `/signin` | Stable supports ordinary dashboard sign-in and the output parser | Completed-install reruns can regenerate desktop scripts and open the dashboard without reinstalling | Same base contract. Beta-only backend parameters are capability-gated |
| ✅ | Current desktop scripts; `agend restart`, `status`/`ls`, `start`, `attach`, `update` | Ordinary commands are supported by stable | Current live installer writes compatible shortcuts | Same. Later running **stable's packaged `agend shortcuts`** replaces them with its older template, losing newer Terminal/bounds presentation; basic commands still work |
| ✅ | Completed-install fast path and broken-install repair | Not taken on a fresh install | With no progress file, working installs only update/open shortcuts; they do not upgrade a working stable install merely because AGEND_VERSION was set. Broken stable repair selects latest; prerelease repair selects beta | Same policy. A saved stage never substitutes for full-flow resource checks; shortcut-only reruns deliberately have a narrower scope |
| ✅ | New-fleet configuration defaults | Stable creates its own supported configuration and keeps the existing Kiro default | Reruns do not silently migrate existing agents/configuration | Beta adds new-fleet Kiro TUI/default choices. This is a product-version difference, not an unsupported installer command |

## Confirmed failure and narrow fix (#2704)

The installer used Node fetch without a credential or browser cookie jar. In both published packages, `dist/auth-api.js` redirects `/` to `/ui`; the fleet's auth gate then returns 401. Adding an HTML Accept header would still leave a 401 response. The public `GET /signin` serves the sign-in page with 200 and no auth side effect.

The generated readiness program, not a substitute predicate, produced:

| Status | Package | Before: `/` | After: `/signin` |
|---|---|---|---|
| ❌ | 2.3.1 | `/ui`, HTTP 401, program exit 1 | — |
| ✅ | 2.3.1 | — | HTTP 200, program exit 0 |
| ❌ | 2.3.2-beta.11 | `/ui`, HTTP 401, program exit 1 | — |
| ✅ | 2.3.2-beta.11 | — | HTTP 200, program exit 0 |

The one runtime change is the readiness page path. The active-unit check, deadlines, allowed health statuses, startupComplete requirement, warning output, progress/receipt handling and default release channel stay as before. A regression uses the real auth routes and proves that an unauthenticated root request still fails while readiness succeeds via `/signin`. Degraded health, incomplete startup, down status and unavailable sign-in page controls pin the remaining gates.

## Command, output and file ledger

- Shell dispatch: `npm view @songsid/agend@<target> bin --json`; `npm exec --yes --package @songsid/agend@<target> -- agend-install`; legacy bin-absent fallback is `npm install -g`. The target installer uses `agend install --no-activate`, `agend restart --yes` or `agend start` when an installed service exists. Completion uses `agend completion install [--modify-rc]`; fresh interactive shell setup uses `agend quickstart`. The lock-refusal exit 75 stays a refusal, not success.
- Windows base commands: `agend --version`, `agend setup`, `agend quickstart`, `agend settings confirm <32-hex-id>`, `agend install`, `agend validate --connections`, `agend web --code`, `agend ls`, `agend restart`, `agend status`, `agend start`, `agend attach`, `agend update`. Only setup/web backend-signin flags are beta-only; capability detection gates them.
- Parsed strings: `Setup page:`, `Setup code:`, `Setup complete`, `Setup has already been completed`, `Setup host stopped (reason)`, `Settings confirmation requested:` with source/id JSON, `CONNECTIONS=<n>`, `Sign-in page:` and `Code:`. `AGEND_FOUND`, `AGEND_BROKEN` and `AGEND_VERSION=` are installer-generated markers around package/version checks.
- Package-owned paths: global `@songsid/agend/package.json`, its `better-sqlite3` and `js-yaml` dependencies, `~/.agend` or AGEND_HOME, `fleet.yaml`, `web.token`, `setup-complete.json`, runtime-selection `.agend-runtime.json`/`.agend-runtime.key`, and `com.agend.fleet.service` under the systemd user configuration. macOS uses `com.agend.fleet.plist`; legacy system-service detection is common to both packages. Windows progress, shortcut scripts/install.json, RunOnce and install logs are installer-owned.
- API contracts: setup URL/code and confirmation exchange are owned by the installed setup host; the installer observes CLI output and never calls approval APIs itself. `/health` is public; `/signin` is public/inert; `/` redirects to protected `/ui`; `agend web --code` privately calls `/auth/issue-code`. Stable has ordinary setup/dashboard sign-in; beta adds its local backend-signin routes behind the capability flag.

## Evidence and reproduction

- `tests/fixtures/windows-installer-stable-2704/packages.json`: exact tarball hashes and sizes.
- `tests/fixtures/windows-installer-stable-2704/published-auth-receipt.json`: actual published handlers plus original/fixed generated programs.
- `tests/windows-readiness-auth-2704.test.ts`: original endpoint fails two assertions; corrected endpoint passes; no credential or POST requests are made.
- Existing focused `windows-stage-recovery-2650` and `windows-browser-signin-2599` cases retain readiness/capability/fallback assertions.
- `scripts/manual/installer-compat/verify-published.mjs <packages-dir> <before.ps1> <after.ps1>` replays the read-only HTTP proof in a disposable private container with `AGEND_INSTALLER_COMPAT_CONTAINER=1`; each extracted package belongs under `<packages-dir>/<version>/package`. Provide its dependencies in that isolated environment. Do not start the full installer or a real fleet for this probe.

The initial three-file container test run passed 60 cases; one unchanged process-output test could not execute because that PowerShell image has no `/usr/bin/python3`. That is an environment limitation, not a relaxed assertion. The relevant readiness and browser capability cases were then selected separately: 22 passed, 39 outside the selected scope were skipped. The root-URL reverse mutation produced two semantic failures. PowerShell-generated JavaScript matched the program used against both published auth handlers; the real capability responses selected plain setup on stable and the checklist option on beta. No native Windows/WSL installation, UAC/RunOnce reboot, service enablement, desktop COM/browser integration or real account login is claimed by this audit; those still require the user's Windows check.
