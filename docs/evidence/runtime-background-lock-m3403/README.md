# Background Runtime fixture PID collision (M-3403)

The test `another Runtime already holds the profile` in `tests/runtime-cli-background.test.ts` wrote a lock and marker for literal PID `4242`. That number can also be the test worker's own PID. `runBackgroundInstance` in `src/runtime-cli-background.ts:255` intentionally allows the same process to proceed, so the mocked client reported `ready` instead of the test's expected `already-running`. The reported PID remained `4242`, matching the CI failure. This is a fixture identity collision, not a production lock-timing failure.

A forced base reproduction temporarily sets the worker's reported PID to `4242`: the unchanged fixture fails with the same `already-running` versus `ready` mismatch. The fixed test retains that forced identity, selects the other Runtime's PID relative to it, supplies a matching liveness seam, and restores the original process descriptor in `finally`. It still asserts that the second client never starts, the other marker remains untouched, and a lock acquired later produces the same refusal.

Validation:
- Base with the forced worker PID: 1 semantic failure, 45 filtered.
- Fixed complete file: 46/46 pass.
- Fixed focused case: 20 consecutive runs, all pass; each run forces the formerly colliding worker PID.
- Test TypeScript: zero diagnostics.
- Main has no corresponding test; dev-only.

No retry or timeout changes, production changes, real Runtime launches, live accounts, vendor CLIs, models, panes or Windows operations. The client and process liveness are stubbed; only temporary fixture files are used. Rollback: revert the fixture/evidence commit, with no persistent production state change.
