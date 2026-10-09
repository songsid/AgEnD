# Private Node runtime (#1450)

AgEnD 2.2 requires Node `^22.14 || ^23.6 || >=24`. The reason is better-sqlite3 13: it loads through N-API 10 and
ships prebuilt binaries inside its npm package. On Node 20 it imports fine and then SIGSEGVs on `new Database()`.
The user decided on 2026-10-09 that upgrading a host's system Node is too risky, so **AgEnD gets its own Node and the
system Node is left alone.**

This document is the design. It answers the leader's brief (Board 73e97018) and sol's review of the upgrade plan
(points (a)–(e) below; #1446).

Refs: M = main `d7a45dc9`, V = v2.1.12 `7a8160a1`, #1442 = Part A preinstall guard (dev1), #1449 = #1446 updater fix.

**Standing decisions (leader, via sol, 2026-10-09):**
- There is no 2.1 bridge updater; release/2.1 is locked.
- **Alpha** supports only a host whose Node already qualifies.
- **Beta and stable** wait for this runtime.
So this design is a beta/stable gate. The 2.1.12 hop below must work for beta/stable, and alpha may simply refuse it.

sol's evidence used below (Node 20.19.0 / npm 10.8.2, scratch prefix, the real 2.1.12 baseline):
- a failing preinstall over 2.1.12 leaves 2.1.12 in place;
- the same after `npm unlink -g @songsid/agend` (what the 2.1.12 updater does first) leaves **no package and no bin**.
sol also showed that preinstall-failure rollback holds on npm 9.9.4 and 11.6.2. Not yet verified on macOS.

## Goals and non-goals

Goals:
1. A host whose system Node is too old runs AgEnD 2.2 on a pinned, official, checksum-verified Node 22. This needs
   no sudo and no nvm, and nothing outside AgEnD's own files changes.
2. The **2.1.12 → 2.2 hop** works when started by the **old** updater (2.1.12 code, system Node 20, `npm install -g`,
   unlink first). It ends either in a working 2.2 on the private Node or in a refusal with a one-command recovery.
   It never leaves a package that is installed but cannot run.
3. Everything AgEnD starts itself runs on the selected interpreter by absolute path: the fleet service, restarts, the
   MCP server and agent tools. Nothing is put on PATH. The backend CLIs and the user's npm keep the Node they had.
4. Rollback means reinstalling the previous AgEnD: `npm install -g @songsid/agend@2.1.12` brings back 2.1.12 exactly
   as it was.

Non-goals: Windows; replacing the user's Node or nvm; changing how backend CLIs are installed.

## Decision needed: where the runtime comes from

The brief said "download official Node to `~/.agend/runtime`". Writing it out, a second shape removes most of the
hard parts, so both are given here with a recommendation. **Leader: please choose; the rest of the document holds
for either, and the differences are marked.**

### Option A (recommended): the runtime is an npm dependency (the esbuild pattern)

- Publish four packages: `@songsid/agend-node-linux-x64`, `-linux-arm64`, `-darwin-x64` and `-darwin-arm64`.
  - Each holds the **official** Node binary for that platform, plus its LICENSE, and has `"os"`/`"cpu"` fields. For
    example, version `22.23.3-agend.1` holds node v22.23.3.
  - A release workflow builds them. It downloads `node-vX-<platform>.tar.gz` from nodejs.org, verifies
    `SHASUMS256.txt` **and its GPG signature** against the Node release keys, and repacks only `bin/node` and
    `LICENSE`. It never compiles anything.
- `@songsid/agend` lists all four, at exact versions, in `optionalDependencies`. npm installs only the one that
  matches the host and skips the rest. This is the mechanism esbuild, swc and rollup ship their binaries with.
- What npm then does for us, which the custom downloader (option B) would have to build:

  | sol (a) asks for | Option A gets it from |
  |---|---|
  | pinned runtime | an exact version in `optionalDependencies`; the lockfile `integrity` (sha512) is checked by npm |
  | cache, offline | npm's cache (`--prefer-offline` / `--offline` work), and corporate registry mirrors |
  | proxy | npm's own `proxy` / `https-proxy` / `cafile` config: the path that just delivered agend itself |
  | checksum | registry integrity, plus the GPG-checked SHASUMS at publish time |
  | safe extraction | npm's tar extraction (no absolute paths or `..`; mode bits kept) |
  | single-flight | npm's install lock on the prefix |
  | atomic publish + restoring the previous runtime | npm reify: the new tree is moved into place, and on failure the old one is moved back |

- **Location:** `<prefix>/lib/node_modules/@songsid/agend/node_modules/@songsid/agend-node-<os>-<cpu>/bin/node`.
  It is not `~/.agend/runtime`. It belongs to the AgEnD version that brought it and is replaced together with it, so
  a rollback to 2.1.12 also removes it.
- **Cost:**
  - four packages to publish whenever the pinned Node changes (not on every AgEnD release);
  - about 30 MB to download and about 115 MB on disk per install, which option B needs as well;
  - a host whose registry mirror only allows listed packages must allow these four.

### Option B: a custom downloader into `~/.agend/runtime`

- **Layout:**
  - versioned directories `runtime/node-vX-<platform>/`;
  - `current` and `previous` symlinks, each swapped atomically (`symlink` to a temp name, then `rename`);
  - `downloads/` keeps the last two verified tarballs for offline rollback;
  - a `.lock` file (`open wx`, pid and timestamp, stale when the pid is dead or the lock is over 15 min old).
- **Pin:** `runtime-pin.json` inside the package (`{version, files: {platform: {name, sha256}}}`). It is generated at
  release from GPG-verified SHASUMS, so nothing from the network is trusted at install time.
- **Download:**
  - `curl`, falling back to `wget`, so that proxies (`HTTPS_PROXY`, `NO_PROXY`) and the system CAs apply. npm's
    `npm_config_https_proxy`/`npm_config_proxy` from the lifecycle environment are passed through.
  - Mirrors: `AGEND_NODE_MIRROR` (default `https://nodejs.org/dist`). Any mirror is safe because the sha256 is pinned.
  - Offline: `AGEND_NODE_TARBALL=/path` takes a tarball the operator downloaded, verified against the same pin.
- **Extraction:**
  - into `runtime/.staging-<rand>/` with `tar --no-same-owner -xzf`, after `tar -tzf` has rejected absolute paths,
    `..` segments, and links that point outside;
  - then `bin/node --version` must equal the pin and `process.versions.napi >= 10`;
  - then the directory is renamed into place and `current` is swapped. A published version directory is never
    changed in place.
- Everything in option A's table, but built and maintained here, and run under Node 20 during preinstall with built-in
  modules only (dependencies are not installed yet at preinstall).

### Why A is safer for the hop

In the 2.1.12 hop the old updater has **already removed the current install** before `npm install -g` starts (#1446:
its `npm unlink -g` uninstalls a normal global install). So any failure in that install leaves the user with no
`agend` at all.
- With option A, the only extra thing the install needs is a package from the same registry, through the same
  proxy, cache and credentials that just delivered `@songsid/agend`. Its failure modes are agend's own failure modes.
- With option B, the install also depends on a second host (nodejs.org or a mirror), a second proxy path (curl) and
  a second cache. Each is a new way to fail exactly where failing costs the most.

## Selecting the interpreter (sol (a), (b))

`package.json` `bin` points at **launchers**, `bin/agend.cjs` and `bin/agend-agent.cjs`, instead of `dist/cli.js`.
A launcher is CommonJS in syntax Node 12 can parse, has no dependencies, and is about 120 lines. It runs **before** any
module of the import graph loads. It takes the first match:
1. `AGEND_NODE=<absolute path>`: an operator override, used as is.
2. **The runtime of this AgEnD version**, when present. Option A: `require.resolve` of the matching
   `@songsid/agend-node-*` from the package's own directory. Option B: `runtime/current`, but only if its manifest
   names the pinned version.
3. The running Node, if it satisfies `engines` and `process.versions.napi >= 10`.
4. Otherwise it exits 1 with a message: what is missing, why, and the exact recovery command. It **never downloads**
   (sol (b): `--version` has a 5 s budget in the old updater).

If the selected interpreter is the running one, the launcher `import()`s `dist/cli.js` in the same process at no cost.
Otherwise it spawns `<node> <pkg>/dist/cli.js …argv`:
- with stdio inherited and `AGEND_NODE_SELECTED=1` set, so the child never re-selects;
- it forwards `SIGTERM`, `SIGHUP`, `SIGUSR1` and `SIGUSR2`, ignores `SIGINT` (the terminal sends it to the whole
  process group), and exits with the child's code or signal;
- **PATH is not changed.**

`process.execPath` in the child is therefore the selected interpreter. Everything below relies on that.

Why the version's own runtime comes before a capable system Node: it is the interpreter this AgEnD version was tested
with, and it does not change when the user runs `nvm use`. A user who prefers their own Node sets `AGEND_NODE`.

## Provisioning, and the #1442 guard (sol (b))

Provisioning happens **during npm install** and never at run time.

- **Option A:**
  - npm fetches the runtime package as part of the install.
  - A `postinstall` (built-ins only; it runs under whatever Node npm uses) runs `<runtime>/bin/node -e` to open a
    better-sqlite3 `:memory:` database from the installed package. This is the same proof as #1449's verify step.
  - It exits 1 if that fails, **or** if no runtime package was installed (unsupported platform, `--omit=optional`)
    and the running Node does not satisfy `engines` either. Exit 1 makes npm roll the install back.
- **Option B:** `preinstall` provisions (download, verify, extract, publish) when the running Node is too old and no
  pinned runtime exists. On failure it exits 1 and npm rolls back.

The #1442 guard (exit 1 on Node < 22.14) **must not stay as written**: it would refuse precisely the install that the
runtime makes work.
- It becomes "refuse if neither the running Node nor a runtime for this platform can run AgEnD".
- Option A: in preinstall the runtime is not yet on disk, so the guard checks that `os`/`cpu` has a published runtime
  package. postinstall then proves it actually runs.
- Its CI job (#1442: Node 20 over 2.1.12 must roll back) stays, retargeted at the cases that must still refuse: an
  unsupported platform, `--omit=optional`, and a runtime that fails its check.
- sol's rule, kept as stated: the guard may pass on an old host Node only for a runtime that is **verified complete**
  (owned, pinned, checksum, arch, version, executable, and a native DB smoke). It may not pass because a download
  might succeed, because files exist, or on the promise of a first-run download.
  - Option B meets the rule inside preinstall.
  - Option A meets it in the root `postinstall`, which runs in the same npm transaction after every dependency is
    placed. If it fails, npm rolls back.
  - I verified locally (npm 10.9.7) that a failing root `postinstall`, and a failing `install` script, both leave the
    previous version installed (rc 254 and 1; old bin still answers 1.0.0).
  - The CI matrix repeats this on npm 9 / 10.8.2 / 11, Node 20.19.0, Linux and macOS. **Option A depends on it.**
- Dependency install scripts: the root's preinstall is **not** assumed to run before them (sol). Today no dependency
  has one: better-sqlite3 13.0.3 ships its prebuilds and has no install script.
  - A test asserts that over the lockfile (`npm query` for `install`/`preinstall`/`postinstall` scripts). A future
    native dependency's fallback `node-gyp` build would otherwise compile for npm's Node, not the runtime.
  - Adding such a dependency then becomes a deliberate change: build it in postinstall with the runtime's
    `node-gyp`.

`--ignore-scripts` skips both checks; the launcher still refuses at run time, with the recovery command. This is
documented in Upgrade Notes.

## The 2.1.12 → 2.2 hop under the OLD updater (Node 20, npm 10.8.2)

What 2.1.12's `agend update` does (V cli.ts 1426–1592), and what happens at each step with 2.2:

| # | old updater | with 2.2 (option A) |
|---|---|---|
| 1 | `markUpdateInProgress`; `which agend` → `readlink -f` contains `@songsid` → **`npm unlink -g @songsid/agend`** (#1446) | 2.1.12's files and bin are **gone** (sol reproduced this). The running fleet keeps going on code already in memory: running MCP servers are not watching the package directory, but anything newly spawned from it fails |
| 2 | `npm install -g @songsid/agend@2.2.0` under Node 20 | npm fetches agend, its deps (better-sqlite3 13 copies its prebuilds; no install script) and the matching `agend-node-<os>-<cpu>`. preinstall: platform supported → pass. postinstall: runtime opens a DB → pass. Bin links → launchers |
| 3 | `which agend`; `agend --version` (5 s, exit code only) | launcher (Node 20) → spawns the runtime with `dist/cli.js --version` → prints 2.2.0 (about 0.3 s) |
| 4 | `agend install --no-activate` | runs on the runtime: the unit/plist is rewritten with **ExecStart = runtime node + dist/cli.js** (see Services) |
| 5 | `agend completion install --refresh` | runs on the runtime |
| 6 | `agend restart` | the new code's restart: systemd daemon-reload + restart (or launchd / detached). The new fleet starts on the runtime. `agend update` reports success |

The hop's failure cases (option A):

| failure | where | result |
|---|---|---|
| registry, network or proxy down | step 2 | npm fails before reify. **No agend is left** (step 1 removed it): this is the 2.1.12 bug. The old updater prints `Try: npm install -g @songsid/agend@2.2.0`. The fleet keeps running on its in-memory code |
| runtime package blocked by a mirror allow-list | step 2 | optional deps are skipped silently. postinstall: no runtime, and Node 20 fails `engines` → exit 1 → npm rolls back to nothing (same as above). The message names the four packages to allow, and gives the recovery: `npm install -g @songsid/agend@2.1.12`, or install Node ≥22.14 and retry |
| unsupported platform (musl, armv7, …) | preinstall | refused before anything is fetched. Same message |
| runtime installed but fails the DB check | postinstall | exit 1 → rollback. Same message |

Because step 1 is already done, **every** refusal in the hop leaves no agend, and AgEnD 2.2 cannot change that. What
the design can do:
- keep the hop's extra failure surface at zero (option A);
- make every refusal print one copy-paste recovery command;
- warn in the 2.1.x release notes: **update from 2.1.12 with `npm install -g @songsid/agend@2.2.0`, not with
  `agend update`.** npm's own install replaces 2.1.12 in place, and on failure leaves it where it was.

With option B, the first row would also cover "nodejs.org or mirror unreachable" and "curl missing or proxy not
understood". These are the extra hop failures that argue for option A.

## Services (sol (c))

`agend install` (M cli.ts ~1624) records `process.argv[1]`, the inner `dist/cli.js`, as `execPath`, and leaves the
interpreter to `#!/usr/bin/env node` plus the unit's PATH. From 2.2 the rendered service names the interpreter
explicitly:

| kind | today | 2.2 |
|---|---|---|
| user systemd `~/.config/systemd/user/com.agend.fleet.service` | `ExecStart=<cli.js> fleet start` | `ExecStart=<node> <cli.js> fleet start` |
| system systemd `/etc/systemd/system/agend.service` (root, install.sh) | same | same change. `agend install` run as root writes this unit; it must stop writing only the user unit (#1446 item 2) |
| launchd `~/Library/LaunchAgents/com.agend.fleet.plist` | `ProgramArguments=[<cli.js>, fleet, start]` | `[<node>, <cli.js>, fleet, start]`. `agend restart` does `bootout` + `bootstrap` when the plist changed (kickstart does not reload it; #1446 item 2) |
| detached (no service manager) | `sh -c "agend fleet start"`, plus `spawn(process.execPath, [cliEntry, …])` in setup-host, quickstart and full-restart | every spawn uses `process.execPath` and the absolute cli.js. The `sh -c "agend …"` in `restart` is replaced |

- `<node>` is `process.execPath`, the selected interpreter (`<pkg>/node_modules/@songsid/agend-node-*/bin/node`
  under option A).
- Because it lives inside the package, `agend update` rewrites the service (step 4) before it restarts (step 6). The
  updater already does both, in that order.
- `buildServicePath` stops adding `dirname(process.execPath)` when that is the runtime's directory (see PATH below).
- #1446 item 2 (system→user unit migration, plist reload, a failed service refresh) is done here, because this is the
  change that rewrites all four.
- Test: render each kind with a runtime path that contains spaces. Check the systemd `ExecStart` quoting, and that the
  plist is an XML-escaped array.

## The MCP server and wrapper scripts (sol (d))

- daemon.ts ~9486: `command: "node"` becomes `command: process.execPath`. Every backend's MCP entry is derived from
  it: claude and codex config, the kiro agent file, grok, muse, opencode and antigravity.
- The kiro, grok and muse wrapper scripts write `exec ${entry.command} ${args}` **unquoted**, so a path with spaces
  breaks. They get `exec ${shellQuote(entry.command)} …`. A test uses a runtime path with a space for each backend's
  rendered entry.
- claude's `statusline.js` keeps `#!/usr/bin/env node`. The CLI runs it with the user's Node, which can execute it
  (ES5, `fs` only). It is noted here so it is not "fixed" later by accident.

## PATH: what external CLIs and npm see (sol (e))

- AgEnD never puts its runtime directory on any PATH:
  - not in the launcher;
  - not in the service unit's `Environment=PATH` (`buildServicePath` drops it);
  - not in `commonBinaryDirs()` (types.ts ~823), which today adds `dirname(process.execPath)`. On the runtime that
    directory holds only `node`, so it is dropped there. When AgEnD runs on the system Node, the entry stays as
    today.
- fleet-manager's `adoptBinaryDirectory` (~12967) prepends an installed CLI's own directory to the fleet PATH. It
  stays, and it must never be handed the runtime directory: a test feeds it one.
- So the backend CLIs (claude, codex, kiro, …), their own `#!/usr/bin/env node` children, and the user's npm/npx
  (used by `/install-cli` through `npm prefix -g` and `npm install -g`) run on exactly the Node they ran on before.
  AgEnD's own children are pinned by absolute path instead.
- `install.sh`:
  - it stops installing Node through nvm when a Node exists but is too old. npm only needs a Node that npm 10 runs on
    (≥18.17); the install then brings the runtime.
  - with no Node at all, it still installs one through nvm, for npm itself.
  - As root it **stops** `ln -sf "$NODE_BIN" /usr/local/bin/node`, which changes `node` for every user and service on
    the host. It keeps the `agend` and `agend-agent` symlinks.

## `agend update` from 2.2 on (Part B, #1441)

- Preflight reads the target's runtime requirement with `npm view @songsid/agend@<target> optionalDependencies engines`
  **before** touching anything.
  - If neither the platform's runtime package nor the current Node can run the target, it refuses before installing.
  - It does not offer nvm: the runtime replaces that.
- The install itself is #1449's sequence: no unlink, verify the version and open a DB, under the selected interpreter
  (the launcher), then service, then restart.
- Downgrade to 2.1.12 (Part C): `npm install -g @songsid/agend@2.1.12` removes the runtime with the package.
  2.1.12's own `agend install` writes its old-format unit (bin path, PATH Node), which needs a system Node that 2.1.12
  runs on. On a Node 20 host that is the old Node itself: the rollback lands back where it started. 2.2 data
  compatibility is Part C's job.

## Rollback

- Option A: `npm install -g @songsid/agend@<previous>`. The runtime goes with the package, so nothing else needs
  cleaning.
- Option B: the same, plus `rm -rf ~/.agend/runtime` (or `agend runtime rollback` to the `previous` link while staying
  on 2.2).

## Failure matrix (install-time behaviour, 2.2 updater or a plain `npm install -g`)

| situation | result |
|---|---|
| Node ≥22.14 on the host, supported platform | runtime installed and preferred (or `AGEND_NODE`); works offline from npm's cache once installed |
| Node 20, supported platform, registry reachable | works; system Node untouched |
| Node 20, offline, runtime already in npm cache | works with `--prefer-offline` |
| Node 20, offline, not cached | npm fails before reify; current install untouched (2.2 updater) |
| unsupported platform, Node ≥22.14 | no runtime package; launcher uses the system Node |
| unsupported platform, Node 20 | refused in preinstall; current install untouched |
| `--omit=optional` / `--ignore-scripts` | documented. postinstall refuses the former on Node 20; the latter is caught by the launcher at run time |
| a mirror allow-list without the runtime packages | postinstall refuses with the package names (Node 20) |

## Tests

- **Unit**, each with stubbed spawn/fs and no live fleet:
  - launcher selection, one case per rule;
  - signal forwarding and the exit-code mapping;
  - "no download at `--version`" (a runner that throws on any network or spawn other than the child);
  - postinstall checks;
  - service rendering for all four kinds with a path that contains a space;
  - MCP entry and wrapper quoting;
  - `buildServicePath` and `commonBinaryDirs` excluding the runtime directory;
  - install.sh: no `/usr/local/bin/node` symlink (grep test plus a root-run in a container job).
- **CI hop job**, matrix ubuntu-latest + macos-latest, Node 20, with no fleet and no tmux:
  1. Start a local registry (verdaccio) that proxies npmjs. Publish the candidate `@songsid/agend` and the matching
     runtime package to it.
  2. `npm install -g @songsid/agend@2.1.12` (real, from npmjs through the proxy).
  3. Run the **real** 2.1.12 `agend update --version <candidate>` with `AGEND_HOME` scratch and `systemctl`/`launchctl`
     stubbed on PATH.
  4. Assert:
     - `agend --version` is the candidate;
     - `agend runtime status` names the runtime;
     - a DB opens;
     - the rendered unit has `ExecStart=<runtime node> <cli.js>`;
     - `command -v node` and `node --version` are unchanged.
  5. Failure leg: the runtime package is not published. Assert the refusal message, then run the documented recovery
     command and assert 2.1.12 runs again.
- **The same job on Node 22.14** asserts the runtime package is still the one selected, and on Node 24 that
  `AGEND_NODE` overrides it.

## Delivery plan (PRs)

1. Runtime packages and their publish workflow (option A) or the downloader (option B), with tests. No behaviour
   change yet.
2. Launchers and `bin` switch; postinstall; the #1442 guard reworked. Coordinate with dev1: #1442 is theirs, and
   this changes its contract. The dependency-script test.
3. Services for all four kinds, with #1446 item 2.
4. MCP `process.execPath`, wrapper quoting, PATH exclusions, install.sh.
5. CI hop job (Linux + macOS), Upgrade Notes and the 2.1.x release-note warning.

## Pinned Node: which and when

- Only an **LTS line under maintenance**: today 22.x "Jod" (maintenance until 2027-04-30). 23 meets N-API 10 but is
  EOL, and supporting it is not the same as maintaining it.
- Each AgEnD release pins the newest 22.x at release time.
- A Node security release triggers new runtime packages (option A) or a new pin (option B), plus an AgEnD patch
  release.
- The move to 24 LTS is a deliberate later change.
- `engine-strict=true` on an old Node makes npm refuse `@songsid/agend` 2.2 before any script runs. That is a clean
  refusal on a plain `npm install -g`, and it is documented. With the 2.1.12 updater, step 1 has already run, so the
  result is the same as any other refusal in the hop.

## Open questions

1. **Option A or B** (above).
2. Musl/Alpine: Node's `linux-x64-musl` build is listed on nodejs.org. Should we publish a fifth package, selected with
   npm's `libc` field, or leave musl on "bring your own Node ≥22.14"?
3. Should a capable system Node beat the version's own runtime (smaller install, follows the user's Node), or not (as
   proposed: reproducible, unaffected by `nvm use`)? `AGEND_NODE` covers the exception either way.
