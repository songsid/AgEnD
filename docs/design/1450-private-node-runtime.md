# Private Node runtime (#1450)

AgEnD 2.2 requires Node `^22.14 || ^23.6 || >=24`. The reason is better-sqlite3 13: it loads through N-API 10 and
ships its prebuilt binaries inside its npm package. On Node 20 it imports fine and then SIGSEGVs on
`new Database()`. The user decided on 2026-10-09 that upgrading a host's system Node is too risky, so **AgEnD gets its
own Node and the system Node is left alone.**

This document is the design (Board 73e97018). It answers:
- the leader's brief and decision;
- sol's audit (a)–(e) and its cross-check of the first draft;
- Prism's design review of `0a13c549` (contracts C1–C6 below).

Refs: M = main `2bcde9d2`, V = v2.1.12 `7a8160a1`, #1442 = Part A preinstall guard (dev1, merged), #1449 = #1446
updater fix.

**Standing decisions (leader, 2026-10-09):**
- **Option A:** the runtime ships as npm platform packages (below).
- There is no 2.1 bridge; release/2.1 is locked.
- **Alpha** supports only a host whose Node already qualifies. **Beta and stable** wait for this runtime.
- No musl package for now.
- The version's own runtime beats a capable system Node. `AGEND_NODE` overrides it, and the override is logged.
- #1442 stays as the interim alpha guard; the runtime PRs change it to sol's rule.
- **The rollback-proof CI matrix gates every runtime PR** (PR 0).

## Goals, and what is explicitly not promised

Goals:
1. A host whose system Node is too old runs AgEnD 2.2 on a pinned, official, verified Node 22. This takes no sudo and
   no nvm, and only AgEnD's own package and service definitions change.
2. Everything AgEnD starts itself runs on the selected interpreter by absolute path. Nothing is put on PATH. Backend
   CLIs and the user's npm keep the Node they had.
3. Every AgEnD-driven transition ends in one of two states: a verified running state, or the previous state restored
   (package **and** service). The transitions are an update, a downgrade, and a service refresh.
4. **The 2.1.12 → 2.2 hop** started by the old updater ends in a working 2.2 or a refusal with a one-line recovery.
   - It cannot end in "2.1.12 restored": its updater removes 2.1.12 first (#1446).
   - The recommended path for that hop is a plain `npm install -g @songsid/agend@<2.2>`, which keeps 2.1.12 on any
     failure.

Not promised:
- Atomicity against **concurrent external npm installs** of `@songsid/agend` (C1).
- Restoring the old package when the old 2.1.12 updater is the one driving the install.
- Windows.

## The runtime packages (option A)

- **Packages:** four of them, `@songsid/agend-node-{linux-x64,linux-arm64,darwin-x64,darwin-arm64}`.
  - Each holds the **official** `bin/node` and `LICENSE` from `node-vX-<platform>.tar.gz`. A release workflow verifies
    that tarball against `SHASUMS256.txt` and its GPG signature (Node release keys), and publishes with `--provenance`.
  - Package version = Node version (`22.23.3`); `-agend.N` only for a repack of the same Node.
  - Fields: `"os"`, `"cpu"`, and, for linux, **`"libc": ["glibc"]`**. npm 9 and 10 already filter on `libc` (checked
    in `npm-install-checks` of npm 9.9.4 and 10.8.2); a musl host does not get the glibc package from those npms.
- **Pinning:** `@songsid/agend` lists all four in `optionalDependencies` at **exact** versions. The pin for a global
  install is that exact version plus the registry's `integrity` for it. **A repository package-lock is not a pin** for
  a published global install: npm does not publish it, and ignores it for non-root packages (sol). An
  `npm-shrinkwrap.json` would pin the whole tree; it is considered and not adopted now.
- **Size**, measured for linux-x64 v22.23.3: about 45 MB packed and 125 MB unpacked. The first publish is a dry run
  plus one real package before agend depends on it. The CI hop job raises verdaccio's `max_body_size`.
- **What npm does and does not provide** (corrects the first draft):
  - **Provided:** fetching through the user's registry, proxy, cafile and cache; integrity checking; safe tar
    extraction; and a reify that, **for a single transaction**, puts the previous package tree back when a lifecycle
    script fails (PR 0 proves this per npm and OS).
  - **Not provided:**
    - **any mutex between concurrent installs into one prefix.** Prism reproduced, on Node 20.19.0 / npm 10.8.2,
      concurrent installs deleting each other's package or bin;
    - any rollback of things outside the package tree: service units, loaded launchd jobs, running MCP servers;
    - offline installs unless **the whole tree** (agend, all its deps, the runtime package and their metadata) is in
      the cache.

## C1. Serialization: who may run npm against AgEnD's prefix

- **AgEnD-driven transitions take an AgEnD install lock before npm starts, and hold it until the transition settles**
  (verify → service refresh → restart outcome). This covers `agend update` from the CLI, `/update` from chat, and
  `agend runtime repair`.
  - The lock lives at `$AGEND_HOME/install.lock`, created with `open(wx)`, and holds the pid, the process start time
    and the operation.
  - It counts as stale only when its pid is dead, or alive with a different start time. A second AgEnD transition
    exits with "another update is running (pid …)".
  - It is taken in the **updater**, never in a lifecycle script. A postinstall lock is too late, because reify has
    already moved files (Prism).
- **Cleanup and rollback ownership:** the process holding the lock owns everything the transition changes. That is
  the package (through npm) and the service preimage (C6), released only after it has settled one way or the other.
- **External manual npm installs** (`npm install -g @songsid/agend` typed by a user, or a config-management tool) are
  outside AgEnD's control.
  - The supported restriction is documented: **never run two installs of `@songsid/agend` at once, and not while
    `agend update` runs.**
  - The postinstall checks the AgEnD lock and **refuses (exit 1, rollback) while an AgEnD transition holds it**. This
    narrows the window but is not a mutex.
- **PR 0** adds concurrency cases next to the serial matrix:
  - two concurrent inert installs, to **characterize** the npm hazard (documented, not "passed");
  - two concurrent `agend update` processes: the second must refuse;
  - an AgEnD-held lock, where an external install's postinstall must refuse;
  - a **late failure**, where a postinstall fails after a sibling transaction has replaced the package.

## C2. One verified interpreter-selection protocol

A shared module `runtime-select.cjs` (CommonJS, syntax Node 12 can parse, no dependencies) is used by the launcher,
by the postinstall, and by the updater's probe of a target package.

1. **Canonical containment.** `pkgDir` = `realpath(dirname(launcher)/..)`, and its `package.json` must name
   `@songsid/agend`.
   - The runtime candidate is exactly `<pkgDir>/node_modules/@songsid/agend-node-<os>-<cpu>`, never `require.resolve`,
     which can walk up to an ancestor `node_modules`.
   - Its `package.json` must have that name and the **exact version** pinned in `<pkgDir>/package.json`
     `optionalDependencies`.
2. **Platform agreement** (`runtime-platform.cjs`, shared by preinstall, postinstall and the launcher):
   - os, arch, and libc, where glibc means `process.report.getReport().header.glibcVersionRuntime` is set;
   - minimums for the official Node 22 builds: glibc ≥ 2.28; macOS ≥ 11, i.e. darwin kernel ≥ 20.
   - A host outside that set is **unsupported**. Its runtime package, if one is present anyway (older npm without
     `libc` filtering, or a copied tree), is **excluded**, and it does not count as corrupt.
3. **Verified receipt.** The postinstall runs the candidate once, with a 5 s bound:
   - `process.version` must equal the pin, `process.versions.napi` must be ≥ 10, and platform/arch must match;
   - it must open a better-sqlite3 `:memory:` DB from `pkgDir` and run `select 1`, **in the main thread and in a
     `worker_threads` worker** (sol: the kiro transcript lane opens SQLite in a worker);
   - it then writes `<pkgDir>/.agend-runtime.json`: `{pinnedVersion, nodePath (realpath), size, mtimeMs, sha256, napi,
     platform, arch, libc}`.
4. **Selection at run time**, the first match wins:
   1. **`AGEND_NODE` set:** it must be absolute and executable, and pass a bounded probe (1 s; the version satisfies
      `engines`, N-API ≥ 10). If it fails, **exit 1 with the reason**; never fall back from a broken explicit choice.
      The fleet logs a valid override once at start.
   2. **The receipt is present and matches** the candidate's realpath, size and mtime (cheap: no hashing on every
      start): use it.
   3. **Supported platform, but the runtime is missing, partial, mismatched or corrupt:** exit 1 with
      `agend runtime repair` and the npm reinstall command. **Never fall back silently to the system Node** (Prism).
      - One exception: with **no receipt and no runtime directory at all**, as after `--ignore-scripts` or
        `--omit=optional`, a system Node that qualifies is used, **with a warning**. That is the leader's fallback
        rule for skipped optional dependencies.
   4. **Unsupported platform** (or no runtime package published for it): the running Node, if it passes the same
      bounded probe; otherwise exit 1 with the one-line recovery.
5. **Bounded, no downloads:** selection does at most one bounded probe and never touches the network. `--version` is
   answered by the selected interpreter in well under the old updater's 5 s.
6. **Tests:**
   - `--ignore-scripts` (no receipt);
   - a runtime that is absent, partial (no `bin/node`), corrupt (size or mtime changed), or the wrong version;
   - an ancestor `node_modules` holding a runtime package;
   - an incompatible `AGEND_NODE` and a non-absolute one;
   - an unsupported platform with a qualifying and with an old system Node;
   - `--version` timing with the network blocked (a fake DNS/proxy that fails the test if contacted).

## C3. libc and platform agree everywhere

C2.2 is the single platform answer for preinstall, postinstall and the launcher.
- `libc: ["glibc"]` on the linux packages keeps npm 9+ from installing them on musl.
- If one arrives anyway, C2.2 excludes it, and the qualifying-system-Node fallback applies.
- A **supported** host with a runtime that fails its probe is never "unsupported": it is refused (C2.4.3).
- Tests:
  - musl (an Alpine container job) with a qualifying system Node (22.14) → system Node, with the warning;
  - musl with an old system Node (20) → postinstall refuses and rolls back;
  - `--omit=optional` on glibc;
  - a glibc package forced onto musl (copied tree) → excluded, not executed;
  - glibc below 2.28 (a container) → unsupported.

## C4. The updater and the canonical entry move first (PR 2, before the bin switch)

- **Target-package discovery** stays #1449's: npm's own global root and prefix in the install environment, the package
  identity (name, version, realpath of dir and bin target), the bin link, and PATH's `agend` resolving to that exact
  file.
- **The probe runs on the target release's selected interpreter, not on bare `node`.**
  - After the install, the updater runs `<installed launcher> --agend-select-json`. That is a launcher flag, using the
    target's own `runtime-select.cjs`, that prints `{node, pkgDir, receipt}` and exits.
  - The DB proof (main thread and worker) then runs with that `node` on that `pkgDir`.
  - This is correct even when the target's runtime pin differs from the updater's.
  - A target **without** a launcher (a downgrade to ≤2.1.x) keeps #1449's shebang rule, run with C6's preflighted
    host interpreter.
- **Canonical inner entry:**
  - `canonicalCliEntry()` = `realpath(<pkgDir>/dist/cli.js)`, resolved from `import.meta.url`, independent of
    `process.argv[1]`.
  - Every user of `process.argv[1]` as "the CLI" switches to it: `agend install` (service `execPath`), quickstart,
    completion, the stale-fleet restart and setup-host.
  - The launcher's same-process branch also sets `process.argv[1]` to it before `import()`, so both launcher branches
    agree.
  - Tests: both branches (same-process and spawned), the identity of the recorded entry, and an installed-package
    provenance check.

## C5. Owned children: absolute invocation and quoting, complete inventory

Every place AgEnD starts AgEnD, or starts Node for itself:

| site | today | 2.2 |
|---|---|---|
| MCP server entry (daemon.ts ~9486), feeding claude, codex, the kiro agent file, grok, muse, opencode and antigravity | `command: "node"` | `command: process.execPath` |
| kiro / grok / muse wrapper scripts (kiro.ts ~1044, grok.ts ~196, muse.ts ~409) | `exec ${entry.command} ${args.map(JSON.stringify)}`: unquoted command, and double-quoted args still expand `$`/`` ` `` | `exec ${shellQuote(command)} ${args.map(shellQuote)}`: **every** argument |
| detached start (cli.ts ~1750 `start`) | `sh -c "agend fleet start"` | `spawn(process.execPath, [canonicalCliEntry(), "fleet", "start"], {detached})` |
| detached restart (cli.ts `restart`, last branch) | `sh -c "agend fleet start"` | same as start |
| quickstart reloads (quickstart.ts ~349, ~629) | `sh -c "sleep 2 && agend fleet restart --reload"` | `spawn(process.execPath, [canonicalCliEntry(), "fleet", "restart", "--reload"])` after a 2 s timer |
| full-restart helper (full-restart.ts) | `process.execPath` + cliEntry | `canonicalCliEntry()`. After a downgrade, C6 hands off to the host interpreter instead |
| setup-host, the quickstart service install | `process.execPath` + argv[1] | `process.execPath` + `canonicalCliEntry()` |
| chat `/update` (`UPDATE_COMMAND` = `"agend update"`, run through a shell: fleet-manager.ts ~2262, topic-commands.ts ~1646) | whatever `agend` is on the fleet's PATH | **the installed launcher**: npm's `prefix -g` + `/bin/agend`, resolved and checked as in C4 when the fleet starts, by absolute path. This keeps the deliberate "update what is installed, on its own channel" choice, and never a source checkout. Fallback is PATH `agend`, only when that lookup fails, and it is logged |
| claude `statusline.js` | `#!/usr/bin/env node`; uses `require`, arrow functions and template text | **kept**. It runs on the user's Node, through the CLI. Supported floor: Node ≥ 4 (ES2015 arrows) |
| antigravity `agy-statusline.sh` (antigravity.ts ~322) | `node -e "…"` on PATH; uses `?.` | **changed to `process.execPath`**, quoted. Its optional chaining needs Node ≥ 14, above what the user's Node is guaranteed to be |

Tests: a runtime path and arguments containing spaces, `$`, backticks and a literal `$(…)`, run through real `sh` with
inert executables, for each wrapper; every detached spawn records its argv through an inert stand-in, and none goes
through `sh -c agend`.

## C6. A transition restores the service too, not only the package

**The flaw in the first draft:** "reinstall 2.1.12" is not a rollback. 2.1.12's package has no install hook. A 2.2
unit pins the private Node that lives inside 2.2's package, so it points at a deleted file once npm replaces the
package. (sol, Prism.)

- **Service preimage.** Before any transition writes a service definition, it saves a preimage to
  `$AGEND_HOME/service-preimage/<ts>/`: the unit or plist file content, its path and its kind, which is one of:
  - system systemd;
  - user systemd;
  - launchd;
  - detached (that is, none).
- **Authoritative owner.** It is detected as `agend restart` does today: an installed system unit wins over a user
  unit, which wins over launchd, which wins over detached. That one owner is written, reloaded and restarted. The
  other kinds are left alone, except that a user unit shadowed by a system unit is reported.
- **Refresh protocol (sol 5):**
  1. Write the new definition.
  2. Reload it: `systemctl [--user] daemon-reload`, or `launchctl bootout` + `bootstrap` for a changed plist
     (kickstart does not reload).
  3. Verify that the **loaded** definition names the new interpreter and entry, via `systemctl show -p ExecStart` or
     `launchctl print`.
  4. Only then restart.
  - A failure before the restart **restores the preimage, reloads it, and does not restart**. The transition settles
    as `failed` with the recovery command, and the old fleet keeps running.
  - A failure after the restart reports the restart outcome as in #1449 (pending or failed), with the preimage kept
    for `agend runtime repair`.
- **Downgrade, 2.2 → ≤2.1.x (sol 2):**
  - **Preflight**, before npm runs: find a **remaining host interpreter** that satisfies the target's `engines`. For
    2.1.12 that is a system Node ≥ 20 on PATH (or nvm), probed and recorded. Without one, refuse.
    - The current interpreter (the private Node) does not count: npm deletes it.
  - The orchestration runs from a **helper copy** that survives the replacement: the 2.2 updater copies
    `runtime-select.cjs` plus a small `downgrade-helper.cjs` to `$AGEND_HOME/handoff/` and re-executes it on the
    preflighted host interpreter.
  - The helper runs:
    1. npm install of the target, under the C1 lock;
    2. the target's verification (C4's shebang rule, run on the host interpreter);
    3. **restore of the service preimage recorded when this host moved to 2.2**, when one exists. Otherwise it renders
       the target-format definition by running the target's own `agend install --no-activate` on the host interpreter
       and then **repairs the authoritative owner** as above, because 2.1.12 only writes the user unit;
    4. reload, verify the loaded definition, restart.
  - `full-restart.ts` and every other spawn of `process.execPath` must not run after the package that holds it is
    gone. The helper is the only process that continues.
- **Tests (actual service state, not only render):**
  - a user systemd unit in a private user manager. This is exactly the #1122 lesson: a real throwaway unit file,
    reloaded, not a transient;
  - launchd in the macOS job, using a private label;
  - upgrade then downgrade, with the preimage restored and the loaded `ExecStart` checked each time;
  - refresh failure before restart (an unwritable unit dir; a failing daemon-reload stub) → preimage back, no
    restart;
  - a second 2.2 → 2.2 update;
  - 2.2 → 2.1.12 with an installed service.

## Provisioning, and the #1442 guard

- Provisioning happens **during npm install**, never at run time: npm fetches the runtime package, and the root
  postinstall verifies it and writes the receipt (C2.3).
- **npm ordering (corrected):** npm fetches and extracts the tree, runs dependency lifecycle scripts, then the root's.
  So a refusal in the root preinstall comes *after* the fetch, not "before anything is fetched". Any refusal inside the
  transaction rolls back (PR 0).
- **#1442 → sol's rule:** on an old host Node, the guard passes only for a runtime that is **verified complete** (C2).
  - preinstall passes when C2.2 says the platform is supported. If it is unsupported, it requires a qualifying system
    Node.
  - postinstall makes the verified-complete decision and refuses (rolling back) otherwise.
  - Tests replace #1442's single Node-20 case with the matrix: supported + runtime, supported + runtime missing,
    unsupported + qualifying Node, unsupported + old Node.
- **Dependency install scripts:** none in the **production closure that a global install actually resolves**. The test
  runs on a real `npm install -g` of the packed candidate into a scratch prefix (`npm query` there), not on the
  repository lockfile; esbuild and fsevents are dev-only. A future native dependency's fallback build would compile
  for npm's Node, so adding one means building it in postinstall with the runtime's toolchain.
- `--ignore-scripts`: no receipt, so C2.4.3's exception applies, or a clear refusal at run time.
- `engine-strict=true` on an old Node: npm refuses before scripts run. On a plain install that is clean; in the
  2.1.12 hop it is a refusal like any other (documented).

## The 2.1.12 → 2.2 hop under the OLD updater

The old updater has **two branches**, both reachable (sol 7):
- **Writable npm prefix:**
  1. `npm unlink -g @songsid/agend` (#1446): **2.1.12 is gone.**
  2. `npm install -g <2.2>` under Node 20. npm fetches agend, its deps and the matching runtime package. preinstall
     passes; postinstall verifies the runtime (main thread + worker DB) and writes the receipt.
  3. `which agend`; `agend --version` (5 s, exit code only): the launcher spawns the runtime, which prints the version.
  4. `agend install --no-activate`: 2.2 code on the runtime **performs C6** for the authoritative owner (preimage,
     write, reload, loaded-check). If that fails, it restores the preimage and exits non-zero. 2.1.12 treats that as
     non-fatal, which is acceptable because the restored unit is 2.1.12's own unit pointing at a deleted package.
     **This is the residual case:** the fleet keeps running in memory, and the recovery line is printed.
  5. `agend completion install --refresh`.
  6. `agend restart`: 2.2's restart.
- **Non-writable prefix** (needs sudo): the old updater installs **nvm and its Node 22**, then installs on it. This
  design cannot prevent that branch; the no-nvm goal only holds on the writable branch. On that branch the runtime is
  still installed and preferred, and the nvm Node only runs npm.
- **Every refusal in the hop leaves no agend** (step 1 already ran):
  - registry, network or proxy down;
  - a mirror allow-list missing the runtime package (a newly allowlisted package **is** a new requirement; the first
    draft's "zero extra failure surface" was too strong);
  - an unsupported platform with an old Node;
  - a failed postinstall check.
- Mitigations:
  - every refusal prints one recovery line: `npm install -g @songsid/agend@2.1.12`, or the allow-list names;
  - the 2.1.x release notes and Upgrade Notes say: **use `npm install -g @songsid/agend@<2.2>`, not `agend update`,
    for this hop.**

## PATH: what external CLIs and npm see

- The runtime directory goes on **no** PATH:
  - not in the launcher;
  - not in the service unit's `PATH` (`buildServicePath` drops it);
  - not in `commonBinaryDirs()`, where it is dropped when `dirname(process.execPath)` is the runtime;
  - not via `adoptBinaryDirectory`, which a test feeds the runtime directory.
- So backend CLIs, their `#!/usr/bin/env node` children, and the user's npm/npx (`/install-cli`) run on the Node they
  had. AgEnD's own children are pinned (C5).
- **install.sh:**
  - When a Node exists but is too old, it no longer installs Node through nvm: npm (Node ≥ 18.17) brings the runtime.
  - With no Node at all, it still installs one through nvm, for npm itself.
  - As root it **stops** `ln -sf "$NODE_BIN" /usr/local/bin/node`, and keeps the `agend`/`agend-agent` links.

## `agend update` from 2.2 on (Part B, #1441)

1. Take the C1 lock.
2. Preflight with `npm view @songsid/agend@<target> optionalDependencies engines`. On a downgrade, also find the host
   interpreter (C6).
3. Install, with #1449's ordering and no unlink.
4. Verify on the target's selected interpreter (C4).
5. Refresh the service (C6).
6. Restart, with #1449's outcomes: restarted, pending, failed.
7. Release the lock.

There is no nvm offer: the runtime replaces it.

## Pinned Node

- Only an LTS line under maintenance: 22.x "Jod" (maintenance until 2027-04-30).
- Each AgEnD release pins the newest 22.x.
- A Node security release triggers new runtime packages plus an AgEnD patch release.
- 24 LTS is a deliberate later change.

## Tests and CI

- **PR 0 (gate), `npm-rollback-proof`:**
  - **Serial matrix:** npm 9.9.4 / 10.8.2 / 11.6.2 × Node 20.19.0 × ubuntu, macos. Cases: a failing preinstall, a
    failing postinstall, an unfetchable optional dependency with a refusing postinstall, and a good control.
    - Locally on Linux all three npms pass. npm's log confirms the optional dependency was skipped and the refusing
      postinstall ran.
  - **Concurrency and late-failure cases** (C1).
  - **Any serial cell failing stops the work and goes back to the leader.**
- **Unit:** C2–C5 as listed. Service tests run against a private systemd user manager and private launchd labels (C6).
- **The hop job** (ubuntu + macos, Node 20.19.0):
  - Setup:
    - a verdaccio proxying npmjs with the candidate and runtime packages published (`max_body_size` raised);
    - an **isolated HOME, `XDG_CONFIG_HOME`, npm prefix and `AGEND_HOME`**;
    - a **fail-fast process boundary**: a guard environment, with `src/e2e-isolation.ts`'s allow-list extended, so
      any activation path that misses the intended service seam exits non-zero at once. That covers a detached
      `process.execPath` spawn, `sh -c agend …` and `npm`.
  - Legs:
    1. Run the real 2.1.12 `agend update --version <candidate>` (writable prefix). Then a second 2.2 → 2.2 update.
       Then 2.2 → 2.1.12 with an installed service: the preimage is restored, and the loaded definition is checked.
    2. A plain `npm install -g <candidate>` over 2.1.12: on a refusal, 2.1.12 must still run.
    3. A missing runtime package: the refusal message, then the recovery command.
    4. A service-refresh failure before restart: the preimage is back and no restart happened.
  - Asserts:
    - versions;
    - receipt and selection;
    - DB opens in the main thread and in a worker;
    - the loaded `ExecStart`/`ProgramArguments`;
    - `command -v node` and `node --version` unchanged;
    - no process escaped the boundary.

## Delivery plan

0. **PR 0:** the rollback proof plus concurrency cases (gate).
1. Runtime packages and their publish workflow (provenance, size, libc); no behaviour change.
2. **The updater and canonical entry first** (C4): `canonicalCliEntry`, the C1 lock, `--agend-select-json` probe
   support, and the target-interpreter verification. Then the launchers, `runtime-select`/`runtime-platform`, the
   postinstall receipt, the #1442 rework, and the production-closure script test.
3. Services and transitions (C6): preimage, owner, reload and loaded-check, downgrade helper, private-manager tests.
4. Owned children and quoting (C5); PATH exclusions; install.sh.
5. The hop job; Upgrade Notes; the 2.1.x release-note warning.

## Settled

- Option A.
- No musl package.
- Runtime before system Node; `AGEND_NODE` is validated, and logged once.
- #1442 interim, then sol's rule.
- PR 0 gates.
- The 2.1.12 updater's unlink-first is disclosed and unavoidable. A plain npm install is the recommended hop.
