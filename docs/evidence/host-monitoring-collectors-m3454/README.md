# S-205 host collector evidence

Base: actual dev `2561cb29b1d315c358e55749c3b41d305273139f`, after S-204 merged and its post-merge workflows passed. Standalone dev slice; no main twin.

## Result and scope

Adds the opt-in runtime bridge, bounded Linux/WSL/macOS providers and administrator-only cached health read. Missing boolean defaults are durably stored as false before any collection. Off creates no monitoring provider/timer/history/process scan. Settings becomes available only on the real active runtime capability. Existing memory admission, cron and provider-account behavior are unchanged.

History, Host health page, alerts and agent footprint are subsequent slices. The final hour-long measurement with both options enabled and final user-approved real-data captures have not been performed here. This is not end-to-end M-3454 acceptance.

## Checks

- Final focused run: **211/211 across 13 files**, one worker, terminal exit 0. Includes all seven host-monitoring files, pre-fleet isolation, Settings fields/search, Darwin memory/command and probe pool controls.
- Source and test TypeScript: zero diagnostics, terminal exit 0.
- Real-app Settings UI gate: **124/124**, terminal exit 0, GATE=ci. The scratch Fleet uses the real runtime bridge with committed off defaults, so the monitoring card is tested without native sampling. No tap allowances or CSS changed. The later registry-query escaping fix does not change these rendered UI inputs.
- Initial lifecycle controls: three failures exposed early physical release, old disk overwrite and wall-clock cadence. All three were repaired.
- The exact constant registry-query regular expression initially failed the ordinary/extended local-path control. Its escaping is corrected; the final platform suite passes. This is a parser proof, not a live Windows-registry claim.
- Four deliberate reversals caught the physical-drain, generation, durable-pin and no-guessed-drive guards; see `reversals.json`. Each original was restored before final validation. Those results precede the extra registry-path case; counts are stage-specific rather than a repeated final matrix.

Command for the final local test set:

```sh
node node_modules/vitest/vitest.mjs run \
 tests/host-monitoring-{api,fleet,lifecycle,platform,runtime,settings,settings-ui}-m3454.test.ts \
 tests/prefleet-host.test.ts tests/settings-web-section-1620.test.ts \
 tests/web-settings-search-2347.test.ts tests/darwin-memory.test.ts \
 tests/darwin-memory-command.test.ts tests/probe-worker-pool.test.ts --maxWorkers=1
```

Heavy runs used nice/ionice. Raw logs remain private because they include local checkout paths. No retry/timeouts were increased.

## Native coverage

Two bounded WSL checks used the actual readers without an account/model request or persistent monitoring service. The first had no distro/interop environment metadata and correctly reported an unknown backing drive while returning root/state counters. The second explicitly selected a mounted local drive and returned a separate backing-volume record plus the deduplicated root/state volume. The checks completed in 19 ms and 18 ms respectively; these are short warm observations, **not** a production overhead benchmark.

macOS APFS shared/quota cases and Ubuntu missing/network cases are synthetic offline parser/provider tests. There was no native macOS run. Existing Darwin memory tests validate the reused pressure source; monitoring reads its cache rather than launching another pressure probe.

## Original image

`phone-settings-off.png`: real Fleet Settings → Notifications, phone dark zh-TW, both options off, agent option unavailable pending S-209. The image proves the current Settings layout only, not collection/history/alerts. The original was visually inspected: no company names, paths or chat identifiers. Desktop UI-gate images are private and not included in this public bundle.

The fixture's browser and listeners were closed; the shared browser slot was released. There is no running collector, native command, repeat loop or history file from this evidence run.

## Risk and rollback

Automatic WSL identification requires usable current-distro/interop metadata; otherwise the DTO remains unknown and an explicit mounted drive can be selected. Network storage is not sampled. Slow/unconfirmed children retain physical ownership; this can leave monitoring stopping/unavailable instead of silently spawning replacements. Source timestamps and missing/stale states are retained. APFS shared capacities must not be summed by future readers.

Rollback: persist monitoring false, allow the owned flight to close, then revert this slice. Retain explicit false values and the independent cron disk watcher. No user workspace deletion or provider action is part of rollback.
