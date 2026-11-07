# Bundled tmux (M-2457)

**Decision (user, 2026-11-06):** AgEnD **always** runs its own pinned, statically built tmux on a **private socket**,
never the system tmux. The trigger: a tmux 3.4 server leak, where `capture-pane -p` over a control client grows the
server's RSS by ~0.9 GiB/day. Ubuntu 24.04 ships 3.4, and AgEnD reads every pane through a control client (#1401).
Line: alpha (`release/2.3.5-alpha` → 2.4.0).

This note comes before any code. The implementation PRs (§13) each carry an upgrade/rollback rehearsal leg (rule c7e5d374).
Refs below are to `release/2.3.5-alpha` @ `13499cc0`.

## 1. What we use tmux for, and what the pin must not break

| Use | Where | Notes |
|---|---|---|
| One shared server, session `agend`, one window per instance | `tmux-manager.ts` (`new-session`, `new-window -a -n <name> -P -F #{window_id}`, `respawn-window -k`) | `remain-on-exit on`, `allow-rename off`, `window-size latest` |
| Delivery: `load-buffer`/`paste-buffer -p`, then `send-keys Enter` | daemon delivery | the #309 timing is here |
| Reads through ONE control client per session (`-C attach -f ignore-size`, **never `-r`**) | `tmux-control.ts:521-534`, `tmux-read.ts` | `capture-pane -p [-J] [-S -N]`, `list-windows/panes`, `display-message`; 5 s monitor + output-driven captures, 30 s health, 60 s sweep; `/view` polls every 800 ms |
| `pipe-pane` output logs | daemon | |
| Web terminals and sign-in panes on their own servers | `web-terminal.ts` (`-L agend-term-<sid>`, `-f /dev/null`) | |
| `agend attach`, `agend ls`, `agend doctor`, `/sysinfo` | `cli.ts`, `doctor.ts`, `topic-commands.ts` | `attach` hardcodes session `agend` (`cli.ts:3697`): wrong for isolated homes; fixed in PR B |

Today every call runs the bare name `tmux` from PATH. The exec helper resolves it once at start
(`tmux-exec-helper.ts:38-39, 196-206`). Production uses the **default socket** (`paths.ts:65-72`: socket `null` for the
real home) and so reads the user's `~/.tmux.conf`. The installers `apt`/`brew install tmux`
(`install.sh:186-214`, `install-agend.ps1:2779-2781`). Nothing checks the version.

**Version history the pin must avoid (user's list, recorded in the matrix, §2):**
1. **#309**: tmux 3.7–3.7b swallow the first `send-keys Enter` after `paste-buffer -p` on a freshly started TUI, and when
   two deliveries arrive at once. That host ran a static 3.7b from mjakob-gh/build-static-tmux. The mitigation is
   #306's first-delivery settle.
2. **The 3.7 read-only client:** a `-r` control client makes `send-keys … Enter` fail with "client is read-only"
   (`tmux-control.ts:326`). **Never add `-r`.** This is a rule for our code, not a version property.
3. **#735**: a deterministic SIGSEGV in `input_parse` (3.7b) crashes the shared server, so every instance at once. There is
   no upstream repro. The 3.7b→3.8 `input.c` diff leaves the parse loop's end-pointer test untouched, so the fix is
   unproven. The matrix stress test (§2) did not crash any version, 3.7b included, so it is **inconclusive**: it neither
   reproduces #735 nor shows 3.8 fixed it. A core from a
   real #735 crash on the pinned version reopens the pin.
4. **The 3.4 control-capture leak** (this decision's trigger).

## 2. The pin: tmux 3.8, decided by the matrix

The candidate is **3.8** (2026-09-09), the latest stable. The leader's note: 3.7c is from 2026-08-17, and the host runs 3.7b.

**What changed between 3.7b and 3.8 in what we rely on** (upstream CHANGES):

| Area | 3.7b → 3.7c → 3.8 | Our exposure |
|---|---|---|
| Control mode | 3.8: "Bound buffered command replies so a control mode client that stops reading cannot consume unlimited memory (issue 5565)"; "Fix control mode clients hanging on exit if pty data was still queued (5356)"; notifications queued outside `%begin/%end` (5458); layouts in JSON **only if the client sets new-layouts** | Our framing reads `%begin/%end` around a nonce `display-message`. Old layouts stay the default, so there is no parser change |
| capture-pane | 3.8: new `-I` (history timestamps), opt-in | none |
| send-keys | 3.8: `-K` keys go to the right place in the input queue (3476); we don't use `-K` | none |
| paste / bracketed paste | 3.8: "collision between the output discard and bracketed paste flags (5622)" fixed | `paste-buffer -p`, i.e. #309's area (matrix) |
| pipe-pane, load-buffer/paste-buffer | no entries | — |
| UTF-8 / CJK width | 3.8: no infinite loop on a `WCHAR_MAX` width (5602); redraw fixes around wide characters | CJK width test in PR B |
| terminfo | 3.8: keep the existing Ss/Se; `@` disables a terminal feature; a `utf8` feature | none |
| Memory | 3.8: "Various memory leak fixes" | the leak leg (matrix) |
| macOS | 3.7c: "Build with jemalloc on macOS to avoid … a bug in calloc (5385)" | **no jemalloc** on either Mac: the statically linked jemalloc crashed the server on both (§3) |
| Security | CVE-2026-11623 (use-after-free in `image_free`, sixel builds, ≤3.6a; fixed in 3.7) | we build **without** images/sixel (§10) |

**Matrix.** Static builds (§3 recipe: musl, libevent 2.1.12, ncurses 6.5), each tested in a private container with
`--network none` and private sockets only. The live server is never touched.

| Leg | 3.4 | 3.6a (Ubuntu 26.04's) | 3.7b (host today) | 3.8 (candidate) |
|---|---|---|---|---|
| Leak: the repro, control client, redraw pane, 180 s RSS | **1756 → 18276 kB (+5.5 MB/min)** | 1860 → 2028 kB | 1916 → 2100 kB | 2200 → 2400 kB |
| Leak: the same through the CLI | 1684 → 2096 kB | flat | flat | flat |
| #309 through AgEnD: first message to each of 4 agents right after a fresh start (real Claude 2.1.318 ×2, Codex 0.165 ×2; MCP and CLI mode), twice | 8/8 (8 s, 8 s) | 8/8 (7 s, 7 s) | 8/8 (4 s, 10 s) | 8/8 (7 s, 7 s) |
| #309 through AgEnD: two messages at once to one Claude and one Codex agent, twice | 8/8 (4 s, 5 s) | 8/8 (4 s, 2 s) | 8/8 (4 s, 5 s) | 8/8 (4 s, 2 s) |
| #309 raw (no AgEnD settle): fresh Claude 2.1.318 in a private-socket pane, `paste-buffer -p` + Enter the moment the prompt paints, 10 trials | 10/10 | 10/10 | 10/10 | 10/10 |
| #735: 24 panes emitting random bytes and escape sequences at once, 600 s | alive (119 MB) | alive (109 MB) | alive (102 MB) | alive (100 MB) |
| `-r` | rule: never used | | | |

**Reading the matrix.**

- **Leak:** the only leg that separates versions. 3.4 grows by about 5.5 MB a minute through a control client; 3.6a and
  later are flat. So the bundle must be ≥ 3.6a, and the system tmux on Ubuntu 24.04 (3.4) cannot stay.
- **#309:** not reproduced on any build, through AgEnD or raw. The original report came from a different build (the
  mjakob-gh static 3.7b) and an older Claude Code, so this does not prove 3.7b is clean. It does show 3.8 has no #309
  regression against our usage, and #306's settle stays in place either way (it costs ~1.75 s on a first delivery only).
- **#735:** inconclusive (§1).
- **No leg** shows 3.8 worse than an older version.

**Rerun on PR A's build** (3.8 with utf8proc 2.12.0 linked, built by `scripts/tmux/build-tmux.mjs`, run with
`scripts/manual/tmux-matrix/`): leak, control client 2204 → 2400 kB, CLI 2192 → 2348 kB (flat); #309 through AgEnD
16/16 (each round in ≤ 5 s); #309 raw 10/10; #735 stress alive after 600 s (97 MB). Same result as the prototype.

**Decision: pin 3.8.** It passes every leg and carries the 3.8 control-mode reply bound (5565) and the bracketed-paste fix
(5622), both in paths we use. Every later pin change reruns this matrix (§10).

## 3. Build: static, pinned, reproducible, in CI

- **Sources:** tmux 3.8 (the pin, in `tmux-sources.json`), libevent 2.1.12-stable, ncurses 6.5, utf8proc 2.12.0
  (tag archive sha256 `f564011d38b2888d583d510b08e69ffa15aa117155db1b9b49ef1dfe1fa25111`). No jemalloc, although upstream
  builds with it on macOS since 3.7c (below).
  Each source is fetched by URL and checked against a **sha256 committed in the repo**
  (`scripts/release/tmux-sources.json`). A mismatch fails the build.
- **linux-x64, linux-arm64:** built on Alpine (musl), **fully static** (`--enable-static`, everything linked in).
  - It runs on any glibc or musl distro, WSL included. There is no libc variant to pick (unlike the Node runtime,
    whose packages are glibc-only).
  - Recipe notes from the prototype: seed `ac_cv_search_forkpty="none required"` (musl has `forkpty` in libc); link
    the wide-char ncurses (`libncursesw.a`, aliased as `libncurses.a`); configure libevent without its regress suite.
- **darwin-arm64, darwin-x64:** built on macOS runners. libevent, ncurses and utf8proc are linked
  **statically**, and libSystem stays dynamic (Apple supports no fully static binary). `MACOSX_DEPLOYMENT_TARGET=11.0`.
  - **No jemalloc (both Macs use macOS's own allocator, `--disable-jemalloc`).** The statically linked jemalloc 5.3.0
    crashed the tmux server on both CPUs, so it is gone from `tmux-sources.json`:
  - *darwin-x64.* On darwin-x64 (`macos-15-intel`) the statically linked jemalloc 5.3.0 tmux
    server died at once after its first client left: `new-session -d` returned, and the next `display-message` found no
    server (dry runs 42268291999 and 42273319563). Its `-vv` server log ends at `lost client` / `remove peer` with no
    orderly exit, and no crash report was written. Built with the system allocator (`--disable-jemalloc`) the same
    smoke passes on darwin-x64 (dry run 42280510117), so the cause is jemalloc on x86_64, not the build. The cost:
    darwin-x64 keeps macOS's own `calloc`, which upstream works around with jemalloc (tmux #5385).
  - *darwin-arm64.* The first packages (`@songsid/agend-tmux-darwin-arm64@3.8.0`) still linked jemalloc: its dry-run
    smoke passed. On the real Mac (macOS 15 arm64, launchd; C-4 rehearsal leg M) the private server crashed after
    about seven minutes of ordinary use, with no update or restart in progress. The crash report: `EXC_BAD_ACCESS`
    (`SIGSEGV`, `KERN_INVALID_ADDRESS` at `0x0`), faulting thread `je_tcache_bin_flush_large` ←
    `je_free_default` ← `server_client_lost` ← `event_base_loop` ← `proc_loop` ← `server_start`, with the annotation
    "crashed on child side of fork pre-exec". The fleet recovered (storm window, a new server, agents respawned), but a
    server that dies when a client leaves is not shippable. So darwin-arm64 drops jemalloc as darwin-x64 did, and is
    repacked as `3.8.0-agend.2`. `3.8.0` for darwin-arm64 must never be pinned (`NEVER_PIN` in `tests/tmux-bundle-2457.test.ts` refuses it in `package.json`).
  - The cost on both Macs: macOS's own `calloc` (tmux #5385). Pinned by `tests/tmux-bundle-2457.test.ts` (no jemalloc
    part, `--disable-jemalloc`, never `--enable-jemalloc`).
  - **Reproducible link:** ld64 records each object's absolute path in the debug map and hashes the output into
    `LC_UUID` (which `strip` keeps), so the darwin link gets `-Wl,-oso_prefix,<work>/` and `ZERO_AR_DATE=1`.
- **Options:** `--disable-utempter`, and **no** `--enable-sixel`/`--enable-images`. `--enable-utf8proc`, statically, so
  that all four platforms use the same Unicode width tables. musl's own `wcwidth` lags, and CJK and emoji widths must
  match what the CLIs assume. The §2 matrix builds did **not** include utf8proc yet; PR A's first build reruns the
  matrix and adds the CJK/emoji width check with it.
- **Hardening:** `-O2 -fstack-protector-strong -D_FORTIFY_SOURCE=2`, static-pie where the toolchain allows, `strip`.
- **Toolchain, locked** (`tmux-sources.json` `toolchain`, `scripts/tmux/toolchain.mjs`): Linux builds in the Alpine image
  pinned by digest with every toolchain package at its exact version (checked after install; a version the repository
  no longer carries fails the build until the lock is updated in a reviewed change); macOS selects the locked Xcode
  (`DEVELOPER_DIR`) and checks its build and SDK. The toolchain's identity (versions, and the sha256 of the compiler,
  assembler, linker and libc) is recorded in each package's `build-info.json`.
- **Reproducible:** `SOURCE_DATE_EPOCH` = the pin's release date, fixed flags, and the locked toolchain. CI builds twice
  and compares the binary's sha256. A difference fails the dry run.
- **Pipeline:** reuse #1450's. A new `publish-tmux.yml` (`workflow_dispatch`; inputs `tmux_version`, `dry_run` =
  **true by default**):
  - builds the four targets (Linux on `ubuntu-24.04` and `ubuntu-24.04-arm` runners in an Alpine container; darwin on
    the explicit labels `macos-15` (arm64) and `macos-15-intel` (x64); `macos-13` is retired. Each darwin binary's
    `LC_BUILD_VERSION` minos is checked to be 11.0, and the real Mac (test-host rules) runs the arm64 one);
  - smoke-runs each on its own runner (`-V`, a private-socket start/kill, a `capture-pane` of a CJK line);
  - writes packages `@songsid/agend-tmux-{linux-x64,linux-arm64,darwin-x64,darwin-arm64}`;
  - publishes with `--provenance`, reusing the token fallback for the first publish of a new name.
  **A real publish goes through the leader** (as for the runtime). PRs only ever run `dry_run`.
- **Package contents:** `bin/tmux`, `share/terminfo/…` (§4), `LICENSES/` (tmux ISC, libevent BSD-3, ncurses X11/MIT,
  utf8proc MIT), `package.json` with `os`/`cpu` and `agendTmux: { version, sha256, size }`.
  The licences are also listed in `THIRD_PARTY_NOTICES.md` (a new "Bundled tmux" section, with versions and source URLs).
- **In the AgEnD package:** an exact pin in `optionalDependencies` (like `@songsid/agend-node-*`), checked by a CI pin
  check (`check-runtime-pins.mjs` extended).

## 4. Terminfo and TERM

- The package carries a compiled terminfo **subset** from the pinned ncurses: `tmux-256color`, `tmux`, `screen-256color`,
  `screen`, `xterm-256color`, `xterm`, `kitty` (ncurses ships it as `kitty`; the package adds an `xterm-kitty` copy, the
  name kitty sets), `foot`, `alacritty`, `wezterm`, `linux`, `vt100`, `dumb`.
- The static tmux searches its compiled-in directory first, so the server resolves an attaching client's terminal
  (`agend attach` from kitty, for example) even on a host without ncurses-term.
- **The server's environment:** AgEnD starts the server with `TERMINFO_DIRS=<bundled>:/usr/share/terminfo:/lib/terminfo:/usr/lib/terminfo`
  (plus `~/.terminfo` first). Panes inherit it, so a tool inside a pane finds `tmux-256color` even where the system
  lacks it (older macOS).
- **TERM inside panes is unchanged for the CLIs:** AgEnD still starts every CLI with `TERM=xterm-256color`
  (`daemon.ts:13230`) and now also sets `COLORTERM=truecolor` (24-bit, as the native panes already do). Every pane
  detector is calibrated on that rendering.
  - `default-terminal` is set to `tmux-256color` only for panes AgEnD doesn't start itself.
  - `terminal-features` gains `*:RGB` so 24-bit colour passes through to an attached client.
- **UTF-8:** the server runs under a UTF-8 locale (`LANG`/`LC_CTYPE=C.UTF-8` when the environment has none), plus
  utf8proc widths (§3). PR B adds a CJK + emoji width test (`capture-pane` of a known line on every platform build).

## 5. The private socket, and what a user sees

- **Socket:** `-L agend` for the real home. An isolated home gets `agend-<hash6>-b`: its 2.3 hashed name
  (`paths.ts:49-55`) with `-b`, never the hashed name itself. 2.3 ran the **system** tmux on `agend-<hash6>`, and a 2.3
  server that survives the upgrade there (launchd, foreground) is a legacy server for §6 rule 3, not a server of ours
  (C-4 leg I: sharing the name held the whole fleet on "no record of the server"). The session stays
  `agend`. With `-L`, tmux puts the socket in `$TMUX_TMPDIR` or `/tmp/tmux-<uid>/` (mode 0700, owner-only).
- **Config:** the server starts with `-f <package>/share/agend-tmux.conf`, a small file with our options. The user's
  `~/.tmux.conf` no longer applies to AgEnD's server, so their key bindings or plugins can't change delivery. The
  options AgEnD sets by command today (`mouse on`, `allow-rename off`, …) stay as they are.
- **The binary:** one function, `tmuxBinary()`, gives the absolute path of the verified bundled tmux, from the install
  receipt (§8). Every direct call (`tmux-manager.ts`, `tmux-control.ts`, `tmux-read.ts`, `ls-rows.ts`, `view-api.ts`,
  `doctor.ts`, `topic-commands.ts`, `fleet-manager.ts:11195`, `cli.ts`, `setup-wizard.ts`, `web-terminal.ts`) and the
  exec helper's resolution go through it. **Nothing falls back to PATH.** The one override is `AGEND_TMUX_BIN`, which
  is logged and meant for unsupported platforms and tests, as `AGEND_NODE` is.
- **Looking in:** `agend attach [name]` stays the way. It uses the bundled binary and the private socket, and the
  hardcoded session is fixed. A new `agend tmux <args…>` passes through to the bundled binary on AgEnD's socket, e.g.
  `agend tmux ls` or `agend tmux capture-pane -p -t agend:<name>`.
  - **Docs and agent skills** that say `tmux attach -t agend` / `tmux capture-pane -t agend:<name>` change to
    `agend attach` / `agend tmux …`: `docs/docker*.md`, `docs/cli.md`, `general-knowledge/skills/fleet-health/SKILL.md`,
    `steering/core-rules.md`, and the `locale.ts` strings.
- **A user who runs plain `tmux attach`** (the system tmux on the default socket) sees "no sessions", or only their own
  sessions. It's not an error, and it never touches AgEnD's server.
  - **What we tell them:** `agend doctor` prints "AgEnD's tmux: <path> (<version>), socket `agend`: use `agend attach`".
  - The first 2.4 start posts one fleet notice: "AgEnD now uses its own tmux. `tmux attach` no longer shows the agents —
    use `agend attach`."
  - The upgrade notes say the same.
- **Mixing versions on one socket:** a client and server of different tmux versions can't talk on a shared socket. A
  private socket served only by the bundled binary avoids that within one pin, and `agend tmux` always uses the binary
  `server.json` names. Across a pin change the old server is reached only through its own recorded client (§6 rule 2).

## 6. Updates: how an update never strands the fleet (the user's question)

**What happens to the tmux server across an update today:**

| Host | The tmux server's fate on an update/restart | Evidence |
|---|---|---|
| Linux systemd (and WSL, which runs the same systemd unit) | in the unit's cgroup; `KillMode=mixed` ends it with the unit, so **recreated on every restart** | the leader checked the host: the live server (started 09:10:24) is in `com.agend.fleet.service`'s cgroup |
| macOS launchd | tmux **daemonizes** (fork + `setsid`), leaving the job's process group. launchd (no `AbandonProcessGroup`) signals the group, so **the server may survive** | to confirm on the real Mac (rehearsal leg M) |
| A foreground `agend start` / `agend fleet start` without a service | the server outlives the fleet process | by design of tmux |

**So the design never relies on the server dying with the service.** The rules:

1. **Verify before stopping.**
   - The new package's postinstall runs its own bundled tmux: `-V` must equal the package's `agendTmux.version`, and the
     sha256 must equal the manifest's.
   - It then runs a throwaway private-socket smoke: `-L agend-verify-<pid> -f /dev/null new-session -d`, `has-session`,
     `capture-pane -p`, `kill-server`.
   - It writes the receipt (§8). A failure makes postinstall exit non-zero, and npm then keeps the old package (a
     lifecycle failure keeps the old version). `agend update` restarts nothing and says why ("the new version's tmux
     failed its check: <reason>; still on <old>").
   - `agend update` also re-checks the receipt before it stops the service.
2. **The version change is a server change, and the old server is ended by its own client.**
   - **The server's binary lives outside the replaceable package.** AgEnD copies the receipt-verified binary (at
     start, where `AGEND_HOME` is known; postinstall can run under another HOME, e.g. `sudo npm`) to
     `~/.agend/tmux/<version>-<sha256-prefix>/tmux` (with its terminfo), and AgEnD starts the server from that copy. On
     start it writes `~/.agend/tmux/server.json`: `{ socket, binary, version, sha256, serverPid, serverStart }`
     (`#{pid}` and `#{start_time}` read back from the server). The current and the previous copy are kept; older ones
     are pruned only when no `server.json` names them.
   - On start, AgEnD looks for a server on its socket. **The handover always uses the client that `server.json`
     names**, never the new one: tmux client and server must share a wire protocol (upstream `proc.c`), and a future
     pin may change it. With that client it reads `#{version}`, `#{pid}` and `#{start_time}`; if they match the record and
     differ from the new pin (a pin change on a host where the server survived: launchd or foreground), it hands over:
     each daemon checkpoints its session id (as Strategy A does today, `daemon.ts:3079-3094`), the recorded client
     sends `kill-server`, and AgEnD waits for **positive exit** (the recorded pid gone and the socket refusing
     connections) before the new server starts and resumes every conversation.
   - **Unknown or incompatible** (the recorded binary missing or its sha256 changed, the record not matching the server,
     the query failing, or a "protocol version mismatch"): no instance starts on the new version. The one fallback is
     the recorded pid: if `serverPid` is alive with the recorded start time and executable, it is ours and gets
     SIGTERM, then the same positive-exit wait. Anything else holds the fleet with a Needs-you line ("AgEnD's previous
     tmux server is still running and can't be verified: <reason>"), and nothing is killed.
   - Two CLIs never resume one conversation: the old window is gone, positively, before the new one starts.
3. **The 2.3.x → 2.4 hop** (the old server, run by the system tmux on **2.3's socket for this home**: the **default**
   socket for the real home, `agend-<hash6>` for an isolated one — "the default server" below means that socket):
   - On systemd/WSL, the old service's stop ends it.
   - On launchd and in the foreground it may still run. **Every 2.4 start, before any instance starts**, runs the legacy
     check with the **system** tmux on the **default** socket. It is not a once-per-host step: a rollback to 2.3 and a
     second upgrade create new legacy windows, and they are found the same way.
     - **The trigger is per instance:** 2.4 writes `instances/<name>/window-id` with a socket tag (a sidecar
       `window-id.socket`); a file without the tag was written by 2.3 and names a window on the default server.
     - **The 2.3 id leaves `window-id` at once** (C-4 leg L3): at fleet start, before any instance does anything, every
       untagged id moves into the journal's `pending` and its file is removed (journal first), and each instance's start
       does the same. So no other reader of `window-id` (a stop, a pane check, a restart) can act on a 2.3 id against
       the new server, whose ids start again from `@0`, and a hold survives the instance's retries and restarts until
       the window is gone, migrated or released.
     - **Prove** each window ours: its `#{window_id}` equals the untagged window-id file, its name equals that
       instance's, and its pane's process tree runs that instance's backend binary.
     - Checkpoint each proven window's session id, `kill-window` it, and confirm it gone (and its pane pid exited)
       before that instance starts. **Never `kill-server` the default server**: it can hold the user's own sessions. It
       exits by itself once empty.
     - A window that can't be proven, an untagged file with no system tmux to ask, or a default socket that answers but
       can't be queried, holds **that instance**: it doesn't start, and Needs-you says "An old tmux window for <name>
       may still be running (system tmux). Close it, or run `agend tmux-migrate --release <name>`." The rest of the fleet
       starts.
     - `~/.agend/tmux-migration.json` is a **journal**, not a skip flag: it names the default server incarnation
       (`#{pid}` + `#{start_time}`), each window's step (checkpointed, killed, confirmed), the `pending` 2.3 ids and the
       `released` ones. It lets an interrupted migration resume on the **same** server without checkpointing twice; a
       different incarnation, or a new untagged file, starts a fresh pass.
   - The window-id files are rewritten (tagged) by the new spawns.
4. **Later 2.4.x → 2.4.y with a new pin:** rule 2. The receipt names the pin and the server reports `#{version}`, so a
   mismatch can't outlive an update even where the server survives.
5. **Rollback 2.4 → 2.3.x:** §7.

## 7. Downgrade to 2.3.x

- 2.3.x runs the **system** tmux on the **default** socket and knows nothing of the private one.
- **The supported rollback is `agend rollback 2.3.x`**, run by the outgoing 2.4 (npm has no uninstall hook that would
  let 2.4 clean up after a plain package swap). In order, and each step must succeed before the next:
  1. Stop the fleet, checkpointing every session id (as an update does).
  2. End the private server with the client `server.json` names (§6 rule 2), and **positively confirm** it: the
     recorded server pid gone, the socket refusing connections, and every instance's recorded backend pid exited.
  3. Write `~/.agend/rollback.json` (`{ from, to, closedAt }`): the checkpoint 2.3.x will resume from.
  4. Only then `npm install -g @songsid/agend@2.3.x` and restart the service on it.
  - A failed or unknown close (step 2) **stops the rollback**: nothing is installed, 2.4 stays, and the message says
    what is still running. A failed npm install (step 4) leaves 2.4 installed with the fleet stopped; `agend start`
    brings 2.4 back.
- **A raw `npm install -g @songsid/agend@2.3.x`** skips steps 1–3:
  - On systemd/WSL it is still safe: the service restart kills the unit's cgroup, private server included.
  - On launchd or a foreground fleet the private server can survive, and 2.3.x can't see it. **That path is
    unsupported**, and the docs and the 2.4 upgrade notes say so. The last 2.3.x patch (an alpha/beta of the 2.3 line)
    adds a guard: if the `-L agend` socket accepts a connection, 2.3.x refuses to start instances and points at
    `agend rollback` (from 2.4) or closing that server.
- **The system tmux must still exist.** The 2.4 installers keep ensuring it (`install.sh` and the Windows one-click
  still `apt`/`brew install tmux`), and nothing removes it.
  - It costs a few MB and is unused by 2.4. It is documented as "kept for rollback to 2.3.x".
  - Dropping it is a later decision, after 2.3.x is out of support.
- **Rollback-proof CI:** a job (like `node20-rollback-smoke`) installs the 2.4 candidate and starts a fleet (mock CLI,
  private socket, run in the foreground so the server would survive), then runs **`agend rollback` to the latest
  2.3.x**. It checks:
  - the fleet starts on the system tmux, default socket;
  - every instance resumes;
  - no server is left on `-L agend`;
  - no instance runs twice.

## 8. Install: npm, install.sh, Windows one-click, offline

- **npm** (every path ends here): the platform package comes from the npm registry through the user's registry, proxy
  and cache, exactly like the Node runtime. Nothing is fetched from GitHub at install time.
  - Postinstall verifies the binary (§6.1) and writes `~/.agend/…/.agend-tmux.json`: `{ path, version, sha256, size,
    mtime }`. `tmuxBinary()` trusts only a receipt whose file still matches (size, mtime, sha256 on first use per start).
- **install.sh / the Windows one-click (WSL Ubuntu):** both install AgEnD with npm, so they get the bundled tmux the same
  way. They keep installing the system tmux (§7). The one-click's WSL verify step changes from `tmux -V` to
  `agend doctor`'s tmux line.
- **Offline / github.io blocked:**
  - install.sh is served from github.io. Where that is blocked, `npm i -g @songsid/agend` (registry only) is the
    documented path and brings the same bundled tmux.
  - A fully offline host needs the npm cache or a tarball set: `npm pack @songsid/agend @songsid/agend-tmux-<platform>
    @songsid/agend-node-<platform>` on a connected machine, then `npm i -g ./*.tgz`. Documented in `docs/install.md`.
- **A missing platform package** (an unsupported platform, or `--omit=optional`): AgEnD **refuses to start** with one
  clear line ("this platform has no bundled tmux; set `AGEND_TMUX_BIN` to a tmux ≥ 3.6a to run anyway"), and
  `agend doctor` says the same. There is no silent fallback to the system tmux (the user's rule).

## 9. Windows / WSL

Windows-native instances don't use tmux (`windows-cli*.ts`, `runtime-pane-*`). The WSL distro (Ubuntu 24.04 today, 26.04
next, per Sentinel) runs the fleet as the systemd unit, so the Linux rules apply unchanged. The bundled linux-x64 (or
-arm64) binary is static, so the distro's tmux version (3.4 / 3.6a) no longer matters. The one-click's own `-L
agend-install` sign-in helper uses the bundled binary once AgEnD is installed. Before that (the bootstrap), it keeps
the distro's tmux. That is a private, short-lived socket, documented.

## 10. Security: an update policy for tmux CVEs

- **Smaller surface:** no images/sixel (CVE-2026-11623's area), no utempter, no `-r` clients, an owner-only socket
  directory, and AgEnD's own config (no user plugins).
- **Watch:** the existing 21:00 upstream watch adds tmux, libevent, ncurses and utf8proc. Sources: GitHub releases and
  security advisories, NVD, oss-security.
- **Response:**
  - **High/critical** reachable in our build: a patch release within **7 days** (new pin → `publish-tmux.yml` dry
    run → leader publish → AgEnD patch).
  - **Medium:** the next beta.
  - **Low or unreachable** (a feature we don't build): recorded in the pin file with the reason.
- **Every pin change** reruns the §2 matrix and the rehearsal legs (§12).

## 11. Size budget

Measured on the prototype (linux-x64, musl static, stripped):

| tmux | binary | full-terminfo tarball | binary + terminfo subset |
|---|---|---|---|
| 3.4 | 1.36 MB | 1.16 MB | |
| 3.6a | 1.44 MB | 1.19 MB | |
| 3.7b | 1.51 MB | 1.22 MB | |
| **3.8** | **1.71 MB** | 1.30 MB | **1.79 MB unpacked, 0.79 MB packed** (subset 70 KB) |
| **3.8, PR A's build** (utf8proc 2.12.0 linked) | **2.05 MB** | | **the npm package: 2.15 MB unpacked, 0.89 MB packed** (licences and both terminfo directory spellings included) |
| **3.8, all four packages** (dry run 42280510117) | linux-x64 2.05 MB · linux-arm64 2.05 MB · darwin-arm64 2.10 MB · darwin-x64 1.84 MB | | packed / unpacked: linux-x64 0.89 / 2.15 MB · linux-arm64 0.89 / 2.15 MB · darwin-arm64 0.87 / 2.20 MB · darwin-x64 0.78 / 1.93 MB |

The full ncurses terminfo is 7.4 MB unpacked, so the package ships only the §4 subset. Budget per platform package: **≤ 3 MB unpacked, ≤ 1.5 MB
packed**, terminfo subset included. The Node runtime is ~45 MB packed, so this adds under 4% to an install.

## 12. Rehearsal legs (each implementation PR, rule c7e5d374)

- **L1:** Linux systemd, upgrade from **2.3.4-beta.10** to the candidate. The old server (default socket) ends with the unit,
  the new one is on `-L agend`, every agent replies on the first turn, and `tmux attach` (system) shows no agents.
- **L2:** the same from **2.3.x stable**.
- **L3:** a foreground fleet (no service) upgraded, so the old default-socket server survives. The migration proves and
  kills only AgEnD's windows. A user session on the default server survives, and an unprovable window holds only its
  instance.
- **M:** the real Mac (launchd) upgrade, then rollback (the test-host rules).
- **L4:** 2.3 → 2.4 → 2.3 → 2.4 on a foreground fleet (the default server survives each hop): the second upgrade finds
  the windows 2.3 created after the rollback and migrates them; no conversation runs twice. Plus an **interrupted
  migration**: the 2.4 start killed after one window's checkpoint+kill, then started again; the journal resumes on the
  same server without checkpointing twice, and every instance starts once.
- **R:** `agend rollback` 2.4 → 2.3.x on systemd, foreground and the Mac: no `-L agend` server left, all agents resume on
  the system tmux, none twice. Plus a **failed close** (a private server that won't exit, faked with a
  `SIGSTOP`ped server): the rollback stops before npm runs and 2.4 stays. Plus the raw-npm
  downgrade on systemd (safe) and, on foreground, the 2.3.x guard refusing to start.
- **F1:** an update where npm fails: still on the old version, the service untouched, a clear message.
- **F2:** an update where the new package's tmux fails its check (a corrupted binary in the rehearsal registry):
  postinstall fails, npm keeps the old package, no restart.
- **P:** a pin change 2.4.x → 2.4.y on a surviving server (launchd/foreground). The version mismatch is detected, the
  old server ended by its recorded client with positive exit, and no conversation resumed twice. Plus an
  **incompatible client**: a rehearsal build with a bumped tmux protocol version as the new pin; the new client's
  refusal is detected, the handover still goes through the recorded old client, and with the old binary removed the
  pid fallback or the Needs-you hold applies (nothing killed unproven).

## 13. Delivery plan (alpha)

1. **PR A (build):** `publish-tmux.yml` (dry run), `scripts/release/tmux-sources.json`, the four packages, the reproducibility
   check, `THIRD_PARTY_NOTICES.md`, postinstall verify and the receipt, and the §2 matrix
   scripts (`scripts/manual/tmux-matrix/`: the leak, #735 stress, AgEnD delivery and raw #309 legs) so a pin change
   reruns them. **No runtime change:** AgEnD still runs the system tmux. Legs: F2, the install smokes on every platform
   (the package installs, verifies and is ignored), and the matrix rerun with utf8proc.
2. **PR B (use, dark):** `tmuxBinary()`, every call site and the exec helper, `-L agend` plus `-f agend-tmux.conf`,
   TERMINFO_DIRS, COLORTERM, `agend tmux`, the `agend attach` fix, doctor, docs and skills, the CJK width test. All of it
   behind an internal switch that is **off** in every build B ships in: B on its own changes nothing for a user, and its
   legs are the switch-off regression (the default socket as today) plus the switch-on suite in containers only.
3. **PR C (transitions + activation):** the legacy check and journal, `server.json` and the handover, update
   verify-before-stop, `agend rollback`, the installers keeping the system tmux, the rollback-proof CI job, and **turning
   the switch on**. C is the first commit that runs the private socket for anyone, so it carries L1–L4, M, R, F1, F2
   and P. The 2.3.x guard (§7) lands on the 2.3 line before C ships.
4. The real Mac goes through the test-host rules.

Never touched while building any of this: the live tmux server. Tests use private sockets (`TmuxManager` with a
`socketName`) or throwaway containers.
