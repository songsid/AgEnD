# Native process guard (#1384)

The unit and integration Vitest configs install `process-guard.cjs` before
workers or source imports. It blocks native child-process launches of backend
CLIs and socketless/default-server tmux commands **before** starting a process.
The hooks are plain native patches, not Vitest spies, so `restoreAllMocks`, a
local partial mock, or a concurrent dynamic import cannot remove this boundary.
Node descendants and native Worker realms preload the same guard, including
when a test clears `NODE_OPTIONS` or `execArgv`.

A rejected call is both thrown and recorded. `setup-process-guard.ts` checks
records after each test/file; global teardown catches collection-only, skipped,
and late child records. Catching an error in production code does not make an
unsafe test pass. Messages include a static reason/basename, never argv/env.
Inherited `*_TOKEN` and `*_BOT_*` variables are scrubbed before collection.
Synthetic credentials installed by a test afterwards remain usable.

## Fixtures

- Stub the actual launch boundary (`Daemon.prototype.start`, tmux, inspector,
  etc.). Do not rely solely on a module-constructor mock for dynamic imports.
- Real tmux integration suites must supply their existing private test socket
  via the **global** `-L`/`-S` arguments. Subcommand flags such as
  `capture-pane -S -60` do not establish a private socket.
- A generated fake backend executable may call `registerExecutableFixture`.
  Registration pins its real temporary path and SHA-256 bytes; a changed file
  is rejected. There is no wildcard PATH or temporary-directory exemption.
- `tests/helpers/kiro-compat.ts` provides constructor metadata without probing
  an installed Kiro. `tmux-process-stub.ts` returns a missing fixture pane for
  unit metadata tests; it never queries a tmux server.
- Guard regressions/mutations use inert executables named `tmux`/`codex` in
  private temporary directories. Even a disabled guard can only run those
  fixtures. Never mutation-test against an installed CLI or live tmux.

## Root cause and scope

Vitest 4.1.0's module runner uses a shared mock callstack. Concurrent dynamic
imports from one loader can be classified as a self-import and fetch the real
module instead of its manual mock. A two-module boolean-only reproduction
returned one mocked export and nine real exports for ten concurrent imports;
no daemon or process launch is needed to reproduce this. The #1280 startup test
now stubs the real prototype and forces concurrent startup.

This is an accident guard for the repo's direct child-process calls, shell
launch strings and Node backend entry points, **not an OS sandbox**. It does not
interpret arbitrary shell expansions, externally supplied scripts, native
addons or renamed vendor executables. Deliberate `e2e/` has a separate config
and is outside the unit/integration runner. Real-backend smoke tests must not
probe installed CLIs during unit collection (the old optional 0.156 Codex smoke
was removed; all trust/config fixture assertions remain).

Set `AGEND_TEST_GUARD_TRACE=1` only to diagnose a blocked caller's stack locally.
