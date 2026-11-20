M-3496: durable fixture contention, dev portion

Main-first scheduling fix: [#4304](https://github.com/songsid/AgEnD/pull/4304), merged as a8133a815e938adf79fc44856742d97ef5f49cbe before this standalone dev PR. Dev adds the two Hub suites absent from main and preloads the stateless real HTTP component during the compose suite's existing setup. No service/database/listener is created by this import; every case still creates its own sealed Hub and real durable state. Existing setup/case budgets and assertions remain unchanged.

[Attempt1 of run44784315720](https://github.com/songsid/AgEnD/actions/runs/44784315720/attempts/1) has six10-second timeouts across these files. The directory cosmetic-rename case is wholly synchronous real FULL/WAL/floor/decision work, and Classic delivery is already mocked/resolved. The four compose cases also build fresh durable state and keys. Their common resource bottleneck is expensive fixture/module work competing with parallel worker scheduling; no one shared unresolved application promise explains all six. The original runner lacks CPU/I/O attribution counters; this is a bounded reproducing control, not a kernel-level attribution claim.

- [Parallel control](parallel-control.json): one CPU plus four owned busy processes, three test workers; role case times out at10.25s.
- [Serial-only cold control](serial-cold-control.json): still times out at10.22s because its first real HTTP import/transform remains inside the timed role scenario.
- [Serial plus stateless setup import](dev-contention.json): five separate cold six-case runs, all30 executions pass, slowest2.95s under the same one-CPU/four-owned-load constraint. This is not retry-on-failure; failed controls remain failed, and final samples are independent. Two interrupted exploratory samples that accidentally shared a CPU with another rehearsal were discarded.

Validation: full three-suite serial invocation378/378, partition/coverage suites12/12, test type-check exit0. A worker-cap reversal makes the scheduling assertion fail. Coverage tests pin complete inclusion/exclusion, no duplicate paths, exactly-once per OS, ordering after the unit worker process exits, process/private-home guard parity and original10-second budget with no retries. The PowerShell partition remains separate. Main's corresponding full suite98/98 and five contention samples pass as recorded in #4304. No other affected source/test changes after these checks.

Reproduce on Linux:

```sh
python3 scripts/manual/test-resource-contention-m3496.py --mode parallel --runs 1 --load 4 --out .artifacts/m3496/control
python3 scripts/manual/test-resource-contention-m3496.py --mode serial --runs 5 --load 4 --out .artifacts/m3496/final
npx vitest run --config vitest.config.durable.ts
npx vitest run tests/durable-ci-partition-m3496.test.ts tests/pwsh-ci-partition.test.ts
npx tsc --noEmit -p tsconfig.test.json
```

On this host the parallel command reproduces the role timeout; hardware scheduling varies, so it is not claimed to fail on every machine. The serial-only negative is recorded separately. The rehearsal owns its busy processes, closes them on normal/interrupt exit, and stops on the first failed sample. No test timeout override, native/provider/browser/account or live Fleet operation.

[Related#3722](https://github.com/songsid/AgEnD/issues/3722) remains closed: its earlier ready/unavailable assertion/selected-port allocation gap differs from this wall-clock timeout shape, including the synchronous directory case. No readiness assertion or intentional occupied-port refusal is weakened.

Tradeoff: heavy suites no longer overlap other unit workers; total CI duration may grow. Required job names and OS coverage remain the same. Rollback restores former CI packing and removes the test-only stateless import. No migration, production or permission change.
