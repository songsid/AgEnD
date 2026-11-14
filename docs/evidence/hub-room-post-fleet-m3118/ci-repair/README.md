# CI contract repairs

Exact-head CI 43619864755 at 81bf2864d exposed two compatibility failures: FleetManager statically imported a Hub member verifier, violating the existing S-51 lazy Hub runtime contract; the exhaustive ClassicBot outbound table omitted the four new tools.

The repair moves the verifier import into the existing single-flight async Hub runtime creation path. The receipt hook remains synchronous with the same verifier and current authority checks. No Hub member module is statically imported by FleetManager. The ClassicBot table supplies valid, channel-free arguments for the four new room tools; all existing assertions remain.

Requested command: `npx vitest run tests/hub-fleet-hooks.test.ts tests/classic-outbound-address-1626.test.ts --maxWorkers=2`.
Result: 113/113, two files. The existing disabled-Hub, creation/stop lifecycle and exhaustive outbound schema/address/router controls pass. No other local suite, native, network, browser or mutation rerun.

Earlier receipt-window and combined network evidence retains its recorded source scope. Fresh exact CI and ordinary review remain required on the new head. Rollback disables the feature/tools while retaining journals; reverting only the lazy import would restore the CI regression.

## Attempt 2: dashboard menu expression

Run 43621287273 attempt 2 at b42cdee7c completed shard 4 with one failure in tests/dashboard-permissions.test.ts:131 (541 files passed, one skipped). Its unchanged source guard expects the existing `withoutFeatures(TOOLS.filter(t => allowedTools.has(t.name)), dashboardOffNow())` expression. Combining Hub availability into that inner filter broke the guard.

The repair keeps the profile/dashboard expression intact and applies the same Hub-availability filter to its result. Both restrictions are still intersections of the same tool set; the availability query and all lifecycle callbacks keep their existing order. No test assertion is changed.

`npx vitest run tests/dashboard-permissions.test.ts --maxWorkers=2` passes 13/13. The earlier 113/2, receipt and network results keep their prior source scopes. No broad, native, stdio, TLS/WSS, browser or mutation repeat. Source/test hashes are in shard4-bindings.json; log in shard4-after.log.
