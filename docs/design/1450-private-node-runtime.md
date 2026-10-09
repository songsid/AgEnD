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
3. Every AgEnD-driven transition ends in one of two states: a verified running state, or the previous package **and**
   service restored and verified (C6). The transitions are an update, a downgrade, and a service refresh.
   - Exceptions, which are reported rather than hidden: a failure **after** the activation (restart pending or failed)
     keeps the preimages for `agend runtime repair`; and launchd's activation stops the old fleet before the new one
     can be proven (C6.6).
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

## C1. Serialization: one owner per prefix, and its own npm child admitted

- **The lock is keyed to what npm changes: the global prefix.** It lives at `<npm prefix -g>/.agend-install.lock`,
  next to the package it guards, not in `$AGEND_HOME`.
  - Two fleets with different `AGEND_HOME`s that share a prefix share the lock: the second refuses.
  - Different prefixes, such as two nvm Node versions or a user prefix versus `/usr/local`, have different locks and
    may proceed (Prism v2-1).
  - The prefix is canonicalised (realpath) before it is used.
  - It is written with `open(wx)` and holds `{pid, processStartTime, prefix, targetSpec, agendHome, token}`. It is
    stale only when its pid is dead, or alive with a different start time; a stale lock is replaced and logged.
  - It is taken by the **updater**, before npm, and held until the transition settles (verify → package rollback, if
    any → service refresh → activation outcome). It is never taken in a lifecycle script: a postinstall lock is too
    late, because reify has already moved files.
  - This covers `agend update` (CLI), `/update` (chat), `agend runtime repair` and the downgrade helper (C6).
- **Admitting its own npm child, and only it (Prism v2-2).**
  - The owner creates a random single-use `token`, writes it into the lock, and runs npm with
    `AGEND_INSTALL_TOKEN=<token>` in npm's environment, which lifecycle scripts inherit.
  - The postinstall admits the install **only if** a live lock exists for **its own prefix** (derived from its
    package location, not trusted from the environment), the lock's token equals `AGEND_INSTALL_TOKEN`, and the
    lock's pid is alive with the recorded start time.
  - Otherwise:
    - a live lock with a different token, or none presented → **refuse** (exit 1, npm rolls back): a foreign
      install while AgEnD owns the prefix;
    - a token presented but no live lock → **refuse**: a late or stale token cannot authorise a successor.
  - The owner deletes the lock, and with it the token, when the transition settles, so a token never outlives its
    transition.
  - No lock and no token → a plain external install, which proceeds under the documented restriction below.
- **External manual npm installs** are outside AgEnD's control. The supported restriction: **never run two installs
  of `@songsid/agend` into one prefix at once, and not while `agend update` runs.** npm itself provides no mutex
  (PR 0 characterizes this on every npm in the matrix: the good install fails with rc 217 and the failing one's
  rollback restores the package without its bin).
- **Acceptance:**
  - different HOMEs and one prefix → one refusal;
  - different prefixes → both proceed;
  - the owner's own install succeeds;
  - a foreign install during the owner's transition refuses;
  - a stale or late token refuses;
  - a dead owner's lock is reclaimed.
- **PR 0** carries the serial matrix plus the npm concurrency characterization. The lock and admission tests belong
  to PR 2.

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
3. **Verified receipt.** The postinstall runs the candidate once, with a 30 s bound (a cold first start opens the
   database twice, main thread and worker, and waits for the worker to exit cleanly):
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
| chat `/update` (`UPDATE_COMMAND` = `"agend update"`, run through a shell: fleet-manager.ts ~2262, topic-commands.ts ~1646) | whatever `agend` is on the fleet's PATH | **the installed launcher, by absolute path, verified by identity**: npm's `root -g`/`prefix -g` give the package and its bin link, whose identity (name, realpath of dir and bin target) is checked as in C4. That keeps the deliberate "update what is installed, on its own channel" choice. **No unverified fallback** (Prism v2-3): if npm discovery fails, `/update` **refuses** and says to run `agend update` from a shell. A PATH `agend` is used only when it realpaths to the same verified bin target. Acceptance: failed npm discovery plus a checkout first on PATH → no dispatch; a verified installed beta → dispatched, on its own channel |
| claude `statusline.js` | `#!/usr/bin/env node`; uses `require`, arrow functions and template text | **kept**. It runs on the user's Node, through the CLI. Supported floor: Node ≥ 4 (ES2015 arrows) |
| antigravity `agy-statusline.sh` (antigravity.ts ~322) | `node -e "…"` on PATH; uses `?.` | **changed to `process.execPath`**, quoted. Its optional chaining needs Node ≥ 14, above what the user's Node is guaranteed to be |

Tests: a runtime path and arguments containing spaces, `$`, backticks and a literal `$(…)`, run through real `sh` with
inert executables, for each wrapper; every detached spawn records its argv through an inert stand-in, and none goes
through `sh -c agend`.

## C6. A failed transition restores the package AND the service; launchd's reload is the activation

**The flaw in the first draft:** "reinstall 2.1.12" is not a rollback. 2.1.12's package has no install hook. A 2.2
unit pins the private Node that lives inside 2.2's package, so it points at a deleted file once npm replaces the
package. And npm's lifecycle rollback has already ended when a later step fails: target verification, or the service
refresh (sol; Prism v2-4).

### What is retained before npm runs

- **Package preimage.** The current package directory (`<root>/@songsid/agend`, including its `node_modules` and so
  its runtime package), and the targets of its bin links, are copied with `cp -a` to
  `<prefix>/.agend-rollback/<version>-<ts>/`.
  - It is the same filesystem, so a restore is a `rename`.
  - It is kept until the transition settles, then deleted. Only the newest copy is kept after a successful
    transition, for `agend runtime repair`.
- **Service preimage.** Of the authoritative owner, which is chosen as `agend restart` chooses (system unit > user unit
  > launchd > detached): its file content, path and kind, plus its **loaded** state (`systemctl show -p
  ExecStart,ActiveState`, `launchctl print`). Saved to `$AGEND_HOME/service-preimage/<ts>/`.
- **The rollback executor survives the replacement.**
  - It is the updater process itself. Every module it needs for verification, rollback and service work is
    **imported before npm runs**, so nothing loads from the replaced files.
  - Its interpreter's file may be replaced. The process keeps running, but it **spawns no `process.execPath` child**
    after npm. Probes use the restored or verified package's own selected interpreter (C4).
  - A downgrade uses the handoff helper (below), because the target cannot verify on the private Node.

### Order, and what each failure restores

1. **Preflight**, nothing disruptive yet: C1 lock; target resolution; the package and service preimages; for a
   downgrade, the host interpreter.
2. **npm install.** If it fails, npm rolls back; done, nothing else to restore.
3. **Verify the target** (C4). If it fails: restore the package preimage (rename the new tree aside, rename the
   preimage in, restore the bin links), verify the restored package (identity plus a probe on its own interpreter),
   then delete the new tree. The service was not touched. The transition settles `failed` and the running fleet is
   untouched.
4. **Render and prove the new service definition without loading it.**
   - Write it to a temporary file: `systemd-analyze verify` for a unit, `plutil -lint` for a plist.
   - Compare the rendered file's activation tuple (below) with the expected one. #1449's directory-containment
     `serviceTargetCheck` is the pre-runtime predecessor and is not sufficient on its own.
   - If this fails: restore the package (as in 3), and the service is unchanged.
5. **systemd:**
   1. move the new unit into place;
   2. `daemon-reload` (this does not start anything);
   3. read the **loaded** activation tuple (`systemctl show`), which must equal the expected tuple;
   4. then restart.
   - A failure before the restart: put the unit preimage back, `daemon-reload`, check the loaded `ExecStart` equals
     the preimage's, and restore the package. The old fleet was never stopped.
   - A failure after the restart is the #1449 outcome (pending or failed). The preimages are kept for
     `agend runtime repair`, and the result is not called "restored".
6. **launchd: reload IS activation (Prism v2-5).**
   - `bootout` stops the job, and `bootstrap` of a `RunAtLoad`/`KeepAlive` plist starts it. So every proof (steps
     1–4) is done before the first disruptive command, and the activation is single: `bootout` + `bootstrap` of the
     new plist, then **no separate restart**.
   - Then `launchctl print` must show the expected activation tuple and a running PID.
   - If the bootstrap fails, or that check fails: `bootout` whatever loaded, restore the package preimage, put the
     plist preimage back, `bootstrap` it, and check that **it** is loaded and running. The outcome is a single
     `failed` with "rolled back to <previous>".
   - If the preimage cannot be brought back, that is reported as such, with `agend runtime repair`.
   - The old fleet was stopped by the bootout, so this is honestly not "kept running".
7. **Detached:** the target check, then a restart through the verified binary (#1449).

### Downgrade, 2.2 → ≤2.1.x (sol 2)

- **Preflight**, before npm runs: find a **remaining host interpreter** that satisfies the target's `engines`. For
  2.1.12 that is a system Node ≥ 20 on PATH or nvm, probed and recorded. Without one, refuse. The private Node does
  not count: npm deletes it.
- **Handoff:**
  - The 2.2 updater copies `runtime-select.cjs`, the rollback module and `downgrade-helper.cjs` to
    `$AGEND_HOME/handoff/<ts>/`. It transfers the C1 lock to the helper (pid and start time rewritten by the helper on
    start, token kept), then exits.
  - The helper, on the host interpreter, runs steps 2–6 with the target's verification (C4's shebang rule on the host
    interpreter).
  - The service definition it activates is **the service preimage recorded when this host moved to 2.2**, when one
    exists. Otherwise it renders the target's own `agend install --no-activate` output into a temporary path, proves
    it (step 4), and installs it for the authoritative owner. 2.1.12 itself writes only the user unit.
  - Its failure path restores the 2.2 package preimage and the 2.2 service, as above.
- `full-restart.ts` and every other `process.execPath` spawn is never used after the package that holds the
  interpreter is gone. The helper is the only process that continues.

### The activation tuple: what the guard and every loaded check compare (Prism v3)

Directory containment is not enough. A 2.1-format unit records `<same global package>/dist/cli.js` as its
executable and leaves the interpreter to `#!/usr/bin/env node` plus the unit's `PATH`. npm replaces that package in
place, so after a failed refresh the old unit still points **inside** the new package, and would run 2.2 on Node 20.
What is compared is therefore the whole **activation tuple**:

- **interpreter:** the realpath of the program the manager executes. That is `ExecStart`'s argv[0] or
  `ProgramArguments[0]`, or for detached, the restart's own `process.execPath`.
- **entry:** the realpath of the script it is given (argv[1]).
- **arguments:** the rest, exactly `fleet start`.
- **interpreter-affecting environment** of the definition: `NODE_OPTIONS`, `NODE_PATH` and `NODE_EXTRA_CA_CERTS` must
  be absent or exactly what `agend install` renders, and `PATH` must not contain the runtime directory (PATH section).

The **expected** tuple comes from this package's own selection protocol (C2), run fresh at check time:
- the interpreter is the verified selected interpreter: the receipt-matched runtime, a validated `AGEND_NODE`, or a
  qualifying system Node only in C2's no-runtime cases;
- the entry is `canonicalCliEntry()`;
- the arguments are `fleet start`.

A definition whose argv[0] is a **script** (the 2.1 format, interpreter by shebang) never matches: 2.2 always names
its interpreter.

The **effective loaded** definition is what is compared, not the file:
- systemd: `systemctl [--user] show -p ExecStart -p Environment -p FragmentPath -p DropInPaths <unit>`, which
  reflects drop-ins and what is actually loaded;
- launchd: `launchctl print gui/<uid>/<label>` (program, arguments, environment);
- detached: there is no definition; the tuple is the one the restart itself would spawn, and its interpreter must be
  the selected one.
- If the manager's loaded definition differs from the file on disk, that is itself a mismatch: refuse, and report
  "reload pending or failed".

Uses:
- the C6 step-5 loaded check, and the launchd post-bootstrap check (C6.6);
- the render proof (C6.4), using the rendered file's tuple;
- **the restart guard below.**

### Restart refuses an unverified transition (the hop, Prism v2-6, v3, v4)

`agend restart` runs one of two admitted paths, decided **before stopping anything**. Anything else exits non-zero and
signals, stops and activates nothing. `--force` exists for operators, and it is never used by an updater.

1. **Restart an unchanged loaded job** (systemd after its reload, launchd with nothing pending, detached):
   - the loaded activation tuple must equal the expected tuple, and the loaded definition must equal the file;
   - then the ordinary restart (systemd) or `kickstart -k` (launchd: the job is unchanged, so nothing needs
     reloading).
2. **launchd planned activation:** the old job is still loaded, and the proven new plist waits on disk.
   - A launchd refresh (C6.6, or hop step 4) never bootstraps. When its proofs pass, it writes a **planned-activation
     record** to `$AGEND_HOME/service-plan.json`:
     - `{label, plistPath, the new plist's content hash and tuple, the preimage (plist content and the loaded tuple at
       planning time), pkgDir, the C1 token or "operator", createdAt}`;
     - any failed step 4 deletes the record and restores the preimage plist, so **there is no record after a failure**.
   - `agend restart` admits the activation only if **all** of these hold:
     - a record exists;
     - the file on disk matches the record's hash, and its tuple equals the expected tuple, freshly computed by C2;
     - the **currently loaded** tuple and PID equal the record's preimage, so the owner has not changed since
       planning;
     - the record's `pkgDir` is this package.
   - The new tuple is **not** required to be loaded before the operation that loads it.
   - Then a **single** `bootout` + `bootstrap` of the new plist, with no separate kickstart.
   - After the bootstrap, `launchctl print` must show the new expected tuple and a running PID. If not: C6.6's
     recovery (bootout, restore the package and plist preimages, bootstrap the preimage, check it is loaded and
     running), and one `failed` outcome.
   - The record is deleted once the activation settles, whether it succeeded or failed.

Every other combination refuses:
- a file that does not match the record, or no record;
- a loaded tuple that is neither the expected one nor the record's preimage;
- a record for another package.

This covers the old 2.1.12 updater's final `agend restart`:
- on **systemd**, a failed step 4 leaves the 2.1 tuple loaded (a script as argv[0], Node 20), so path 1 refuses;
- on **launchd**, a failed step 4 leaves no record, so path 2 refuses and path 1 refuses (the loaded tuple is the
  old one);
- a **successful** step 4 on launchd leaves the record, so path 2 performs exactly one activation.

### Tests (actual package and service state, not only render)

- **Rollback after npm succeeded:**
  - verification fails on the new package → the previous package directory and bin are back, and verified;
  - service render or proof fails → package back, unit byte-identical;
  - daemon-reload fails, or the loaded check fails → unit preimage reloaded (loaded `ExecStart` equals the preimage)
    and package back;
  - all inspected on disk and through a **private systemd user manager** (a real throwaway unit, reloaded: the #1122
    lesson).
- **launchd (macOS job, private label, dummy long-running program):** a held or failed bootstrap and a loaded-check
  mismatch. Assert the PID and state at each point, and that the preimage job is loaded and running afterwards. There
  is never a double activation (no extra kickstart).
- **Sequences:** upgrade → downgrade; a second 2.2 → 2.2; 2.2 → 2.1.12 with an installed service (preimage restored,
  loaded definition checked).
- **The restart guard:** each of these (loaded through a private user manager) makes `agend restart` exit non-zero
  with nothing signalled:
  - another install;
  - **a same-prefix 2.1-format unit** (script argv[0], Node 20 on PATH);
  - the right entry with a wrong interpreter (a system Node instead of the receipt runtime);
  - an extra argument;
  - `NODE_OPTIONS` set;
  - a drop-in overriding `ExecStart`;
  - a file changed but not reloaded.
- **Control:** the expected tuple restarts.

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
- **The system Node never blocks an install where a bundled Node applies (user, 2026-10-09).** Not only 20.19: 18, 16
  and any Node whose npm can run the install proceed, and the launcher files that Node runs (preinstall-guard.cjs,
  postinstall.cjs, runtime-*.cjs, launch.cjs) keep to old syntax and APIs. Exactly two refusals remain:
  1. no bundled Node for this host (musl, 32-bit, another OS, glibc < 2.28, macOS < 11, or a release pinning none)
     **and** a system Node that does not satisfy `engines`: AgEnD would install and then not start;
  2. the postinstall's proof of the bundled Node fails: npm rolls the install back and the previous version stays.
  CI covers it with install-run cells on system Node 16 and 18, and hop cells from 2.1.12 on 16 and 18 (on 16, 2.1.12
  itself cannot start, so only the plain-npm leg exists there).
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
  4. `agend install --no-activate`: 2.2 code on the runtime refreshes the authoritative owner with C6's proofs (render
     and tuple proof; systemd: `daemon-reload` plus the loaded check; launchd: the proven plist on disk plus a
     **planned-activation record**, and no bootstrap, because launchd's reload is an activation). On failure it
     restores the service preimage, deletes any record, and exits non-zero, which 2.1.12 ignores.
  5. `agend completion install --refresh`.
  6. `agend restart`: 2.2's restart decides its admitted path first (C6).
     - On systemd, a failed step 4 leaves the 2.1 tuple loaded (a script as argv[0], PATH's Node 20), even when it
       points inside the replaced package, so the restart refuses before stopping anything.
     - On launchd, a failed step 4 leaves no planned-activation record: refused.
     - A successful step 4 on launchd is admitted as exactly one bootout and bootstrap. The 2.1.12 fleet
     keeps running on its in-memory code, and the recovery line is printed. If step 4 succeeded, it restarts (systemd)
     or performs the single launchd activation.
  - **CI:** the hop's failure leg runs the **real** 2.1.12 updater through its final restart:
    - Setup: a **real same-prefix 2.1-format unit** (`ExecStart=<prefix>/lib/node_modules/@songsid/agend/dist/cli.js
      fleet start`, whose `PATH` makes `env node` Node 20) is loaded in a private systemd user manager, with a
      stand-in fleet PID. A step 4 that fails.
    - It asserts that nothing was stopped or activated: the stand-in PID is alive, and there are no systemctl
      restart, launchctl or signal calls.
    - The **control** leg, with a refresh that succeeds, restarts onto the expected tuple.
    - **macOS, private launchd label** (a 2.1-format plist loaded, with a stand-in long-running program):
      - failed step 4 → the old updater's final restart leaves the existing PID alive, with no bootout, bootstrap or
        kickstart;
      - successful step 4 (old tuple loaded, new tuple on disk, a planned-activation record) → exactly one bootout
        and one bootstrap, no kickstart, ending on the expected new tuple with a new PID, and the record deleted.
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

1. Take the C1 prefix lock (token for its own npm child).
2. Preflight with `npm view @songsid/agend@<target> optionalDependencies engines`. On a downgrade, also find the host
   interpreter and hand off (C6).
3. Retain the package and service preimages, and preload the rollback code (C6).
4. Install, with #1449's ordering and no unlink.
5. Verify on the target's selected interpreter (C4). On failure, restore the package.
6. Render and prove the service, then load it: systemd reload plus the loaded check, or launchd's single activation.
   On failure, restore the service and the package.
7. Restart (systemd or detached), with #1449's outcomes: restarted, pending, failed.
8. Settle: delete or keep the preimages, and release the lock.

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
- **The hop job** (ubuntu + macos, Node 20.19.0, 18 and 16):
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
2. **The updater and canonical entry first** (C4): `canonicalCliEntry`, the C1 prefix lock with token admission,
   chat `/update` by verified identity (C5), `--agend-select-json` probe
   support, and the target-interpreter verification. Then the launchers, `runtime-select`/`runtime-platform`, the
   postinstall receipt, the #1442 rework, and the production-closure script test.
3. Transitions (C6): package and service preimages, the preloaded rollback executor, render-and-prove, reload with
   the loaded check, launchd single activation and recovery, the restart guard, the downgrade handoff, and
   private-manager and private-label tests.
4. Owned children and quoting (C5); PATH exclusions; install.sh.
5. The hop job; Upgrade Notes; the 2.1.x release-note warning.

## Settled

- Option A.
- No musl package.
- Runtime before system Node; `AGEND_NODE` is validated, and logged once.
- #1442 interim, then sol's rule.
- PR 0 gates.
- The 2.1.12 updater's unlink-first is disclosed and unavoidable. A plain npm install is the recommended hop.
