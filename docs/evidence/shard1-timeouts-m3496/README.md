M-3496: isolate durable fixture scheduling (main portion)

The first attempt of [run44784315720, shard1](https://github.com/songsid/AgEnD/actions/runs/44784315720/attempts/1) exhausted the existing10-second case budget in six cases across three files. The retry passed. This patch does not add retries or raise case/hook budgets.

The shared failure shape is resource-starved fixture work, not a common unresolved application promise: the directory cosmetic-rename case is entirely synchronous (fresh FULL/WAL schema, file floor, decisions); the Classic adapter case awaits an already-resolved delivery mock after synchronous registry/history writes; the four Hub composition cases create fresh durable Hub state, keys and runtime stores. Nearby cases also slow dramatically in the first attempt. A one-CPU/four-busy-process control reproduces the role-clock case timeout with parallel workers. Serial scheduling alone still reproduces its cold lazy HTTP transform inside the timed test. The dev portion moves that stateless import into the existing suite setup while retaining fresh state/listeners per case.

Main contains only `tests/fleet-manager.test.ts` of the three affected files. It now runs once serially after shard1's other unit workers exit. Dev will add the two Hub suites to the same explicit partition, plus the HTTP fixture-setup correction. The parallel CI partition excludes these files; the serial config includes exactly them. Local default coverage stays unchanged. Existing process guards, private homes, real SQLite/FULL/WAL/fsync and assertions remain intact. No application source changes.

The partition tests check coverage without omission/duplication, the once-per-OS step, sequential ordering, worker limit, original budgets and guard/environment parity. The existing PowerShell partition's coverage assertion now accounts for this additional partition. A reversal to three workers makes the scheduling assertion fail. The manual Linux rehearsal pins Vitest and four owned busy processes to one CPU; repeated samples are separate cold runs, stop on failure, and are not test retries.

Reproduce the main subset:

```sh
python3 scripts/manual/test-resource-contention-m3496.py --mode serial --runs 5 --load 4 --out .artifacts/m3496/contention
npx vitest run --config vitest.config.durable.ts
npx vitest run tests/durable-ci-partition-m3496.test.ts tests/pwsh-ci-partition.test.ts
npx tsc --noEmit -p tsconfig.test.json
```

Validation: main full serial suite98/98; partition/guard suites12/12; test type-check exit0. Five cold CPU-contention runs all pass the main adapter case (see [samples](main-contention.json)); the maximum case time is 308.9ms. The [dev control](dev-control.json) records the reproduced10-second role failure. The worker-limit reversal makes the partition assertion red. Public-content and pinned Gitleaks checks run before push. Test-only change: no user-facing changelog or skill behavior change.

Evidence limits: the original CI runner's CPU/I/O counters are unavailable, so this does not attribute each wall-clock stall to a measured kernel wait. The contention control reproduces the same10-second role failure, not all six CI cases simultaneously. Interrupted exploratory samples are excluded. Durable storage/HTTPS behavior is preserved rather than mocked away. CI may take longer overall because these fixture suites no longer overlap; it retains the same required shard jobs and OS matrix.

This differs from [#3722](https://github.com/songsid/AgEnD/issues/3722)'s earlier ready/unavailable assertion and port allocation gap: these are case timeouts, including a fully synchronous case. Reference it without reopening it as the same defect.

Rollback restores the former CI scheduling/config and its coverage expectation. No data migration, production behavior or permission change.
