M-3499: company-join restart fixture scheduling

[Run44902531664, attempt1](https://github.com/songsid/AgEnD/actions/runs/44902531664/attempts/1), shard2, has one failed case: the FleetManager reconstructs the expired company-join journal. The case consumed10.13s against its unchanged10s budget; the rerun took89ms. The attempt-specific logs archive was inspected, rather than the job-log convenience endpoint that returned the later successful attempt.

The timed case awaited FleetManager's first lazy imports of the real company-join controller and pairing component. It also performs fresh durable private-file writes and key creation. Discover/push are already resolved local mocks; there is no real network response to wait for. These cold transforms and durable fixture work competed with parallel unit workers, but the attempt log has no per-await or CPU/I/O telemetry, so the exact stalled await is not claimed.

The real components now load during module collection, before the scenario's timer starts. Imports create no controller, directory, connection or shared test state. Each restart still constructs its own FleetManager/controller over the same case-owned private files. The suite joins the existing serial durable partition exactly once per OS; local default inclusion, fresh state, journal assertions, budgets, retries, process guard and PowerShell separation are unchanged. Main has no company-join restart test, so this is Dev-only.

[Controls](controls.json) distinguish a bounded fault from observed runner timing: an11s transform delay on the real lazy pairing module makes the original timed case fail at10s. The same delay with collection imports passes with an84ms body; its17.46s collection remains visible, not hidden behind a raised timeout. The negative partition test also fails before registering the suite. No production module or deadline is changed by the control config.

The [ordinary parallel baseline](ordinary-baseline-contention.json) passed all seven focused M-3496/restart cases under one CPU plus four owned busy processes. It is retained as a passing control, not described as a reproduced timeout. Final repeated focused samples and validation are recorded below. These are independent samples; the harness stops on the first failure and does not retry.

Reproduce on Linux:

```sh
node node_modules/vitest/vitest.mjs run --config scripts/manual/vitest-company-join-cold-m3499.ts
python3 scripts/manual/test-resource-contention-m3499.py --mode serial --runs 5 --load 4 --out .artifacts/m3499/contention
node node_modules/vitest/vitest.mjs run --config vitest.config.durable.ts
node node_modules/vitest/vitest.mjs run tests/durable-ci-partition-m3496.test.ts tests/pwsh-ci-partition.test.ts tests/hub-company-join-restart.test.ts tests/hub-company-join-local.test.ts
```

To reproduce the negative fault control, apply the unchanged case from the base before its collection imports; the same11s transform fault must time out. The rehearsal owns its CPU-load children, closes them on exit/interruption and retains every sample result. No retry, test/hook timeout override, provider/browser/account or live Fleet operation.

Tradeoff: collection is still real work, and the serial CI phase grows by one suite. This removes competing unit workers and keeps module compilation outside the restart scenario's budget; it does not guarantee deadlines on arbitrarily starved hardware. Rollback restores the old partition and removes the two test-only collection imports; no data migration, permission or runtime change.

Final focused contention: [five independent cold invocations](contention.json), all5/5 pass on one CPU with four owned busy processes, slowest body383.37ms. Per-process collection takes real time (about36–39s total each); it is not included in the scenario timer and is not claimed to be free.

Final validation: the full four-suite serial durable invocation passes379/379; focused partition/PowerShell/restart/local-controller checks pass84/84 (one restart case overlaps). Test type checking exits0. The process/private-home guards remain active. Public text and staged source are checked before publication.

Review correction: the manual harness now rejects missing/invalid/empty reports, skipped or pending targets, wrong targets, failed cases and extra cases. It requires exactly the intended passed restart case and removes any previous report before launching, so a stale file cannot certify a new process. Four parser-only tests cover the accepted report and these refusal boundaries; they fail against the former permissive parsing and pass after the fix. Re-reading all five retained raw reports with the stricter parser succeeds. No CPU or test campaign was repeated. Run `python3 scripts/manual/test_company_join_contention_report_m3499.py` for these bounded controls.
