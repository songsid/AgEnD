# S-206: capped host history evidence

This is the history slice only. The Host health page and Settings entry remain hidden until S-207. No account, model, browser, native collector or live Fleet probe was run. All databases and HTTP listeners are synthetic scratch fixtures. Final one-hour measurement with both monitoring options and real-data user captures remain S-209 acceptance.

## Checks

The final focused command is:

```sh
node node_modules/vitest/vitest.mjs run \
 tests/host-monitoring-*-m3454.test.ts tests/prefleet-host.test.ts --maxWorkers=1
```

**138/138 across 13 files passed**, terminal exit 0. Test TypeScript had zero diagnostics; source emit and postbuild completed. The first postbuild found missing locked runtime-asset packages in the reused dependency directory; those were copied from this checkout, and only postbuild was repeated. No package/lockfile changed. A separate compiled-JavaScript worker check wrote, queried and cleaned its scratch store successfully. Results are recorded in `checks.json`. Heavy work used nice/ionice, one test worker. Raw logs remain private because they include local checkout paths. Intermediate subsets are not added together.

The store stress fixture uses a **1 MiB scaled physical budget**, 240 changing-volume frames of 64 points each, and checks every result and file total. It forces oldest-row pruning and continues accepting bounded frames. A separate real SQLite transaction is refused with `SQLITE_FULL` before exceeding its engine quota. A pinned reader prevents a second append and file growth until its transaction ends.

The soft-mark fixture fills the reserved incident bytes and uses a synthetic padding table in its scratch database to dirty a full bounded WAL. It asserts the actual file total crosses the scaled 56/64 soft mark while staying below the hard cap, then asserts oldest rows are removed and checkpointing brings bytes below 48/64. This is a controlled storage-pressure fixture, not a claim of organic production growth or an overhead benchmark. Early fixture sizes did not reach the soft mark; those failed setup assertions were corrected without relaxing the threshold.

The original leaf run exposed two quota-headroom failures: a fixed 128-page growth reserve could exceed a small test database and prune valid rows. The reserve now scales with the quota; idempotence and pinned-reader cases pass. Later integration tests cover the real worker, no file creation from off/query/withdrawn write permission, immediate off fencing, physical-exit-before-delete, cleanup failure, recovery hysteresis and actual gateway/session boundaries.

Six deliberate reversals and their exact replacement inputs are in `reversals.json`. A reversal counts only when a test assertion actually fails, not when compilation/import fails. The initial 25-series test reused the same series and therefore caught duplicate rejection instead of the series ceiling; it was strengthened to 25 distinct valid series, and only that reversal was repeated. All source originals were restored before final validation.

## Scope and risk

No schema migration touches the main Fleet database. Monitoring owns only its fixed store filenames. Current metrics survive history I/O failure in RAM; the store fails rather than repeatedly writing or moving corrupt data aside. History is bounded and can be pruned before nominal retention expires. A worker deadline does not assert immediate physical process/thread exit: ownership and cleanup wait for the exit event. Same-OS-user processes are not isolated by these private-file checks.

This evidence proves bounded behavior in scratch storage, not native macOS/Windows disk semantics or the complete enabled resource cost. Final measurement and captures remain outstanding. Rollback is monitoring false, wait for close/cleanup, then revert the slice; the independent cron watcher is untouched.
