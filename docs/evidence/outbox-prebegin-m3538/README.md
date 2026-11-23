# Delivery outbox pre-begin crash fixture (M-3538)

Main first: both branches have the same affected test. This packet changes tests and CI scheduling only; no delivery runtime behavior or durability setting changes.

## Failure and cause

Run 45124417631 attempt 1, shard 1/job 137526250718, reports exactly one failed case: `DeliveryOutbox > recovers a pre-begin dispatch after SIGKILL when target stays stopped, then expires it visibly`, 10005ms against the existing 10000ms test budget. Adjacent real-process crash cases took 7196ms and 7497ms. Attempt 2 passed. The original log has no per-await timestamps, so it cannot identify the exact stalled await or prove a specific CPU or disk latency.

The test mixed two cold fixture-loading paths with the recovery behavior: a tsx child imports FleetManager/Daemon before dispatch, and the parent dynamically imports FleetManager/Daemon only after killing that child. All this ran inside the same case deadline in a parallel unit worker. A readiness event already existed for dispatch; substituting a sleep or extending its deadline would not fix the setup boundary.

## Correction

- Load parent types at module setup, before case timing.
- A nested `beforeAll` loads the real child, which emits `fixture-ready` after its imports and waits for an explicit stdin dispatch gate. It has not created the database yet; the case asserts this before opening the gate.
- The case still waits for the actual production Daemon pre-begin wait, SIGKILLs the whole process, waits for exit, opens the original durable database through FleetManager startup, verifies safe retry with the target stopped, expires it using the recorded timestamp and checks the visible failure notice.
- Register the exit listener before sending SIGKILL and always clean up the owned child on fixture teardown.
- Include the entire outbox suite exactly once in the existing serial durable CI partition, disjoint from unit and PowerShell partitions. Local default test coverage remains intact.

The default 10000ms test/hook budgets, existing 8000ms dispatch bound, durability, assertions and retry settings remain unchanged. Cold child setup has an explicit 8000ms readiness bound; this does not make arbitrary OS starvation impossible.

## Reproduce

```sh
npx vitest run src/delivery-outbox.test.ts tests/durable-ci-partition-m3496.test.ts tests/pwsh-ci-partition.test.ts --maxWorkers=1
python3 scripts/manual/test-outbox-contention-m3538_test.py
python3 scripts/manual/test-outbox-contention-m3538.py --runs 30 --load 2 --out .artifacts/m3538/contention
npx vitest run --config scripts/manual/vitest.outbox-import-fault-m3538.ts -t 'recovers a pre-begin'
```

The import-fault config deliberately adds 11s to parent FleetManager evaluation. It demonstrates the boundary mechanism, not the original runner's measured latency: original test times out; corrected test does its real recovery after module setup. It is opt-in and changes no standard test budget.

## Scope and rollback

Real scratch SQLite and owned Node SIGKILL; tmux methods are fixture doubles. No live Fleet, provider CLI, pane restart, browser or native-device campaign. The contention harness restricts itself and two owned busy processes to one available Linux CPU and launches 30 separate Vitest processes, stopping on any failure. It requires exactly the intended passed case in every JSON report; missing/empty/skipped/wrong/extra/non-passing reports fail. Other skipped cases do not count as executed coverage. This is a bounded Linux contention proof, not a Windows or all-load guarantee.

Rollback the test fixture and durable-suite list/test in a normal follow-up. No database migration or runtime rollback is needed.

## Retained results

- Full outbox suite16/16 plus partition guards12/12:28/28 PASS. Test/source typecheck exit0. Parser controls4/4 PASS.
- Thirty consecutive separate-process contention samples:30/30 intended cases PASS, no retries; maximum case 983.908ms, with two busy processes sharing the one selected CPU. Module loading and fixture setup are outside that case duration, within the recorded total wall time. Standard transform caches are not purged between samples.
- Import-fault control: original case timed out at10010.615ms; corrected case passed in266.656ms after module setup. This is a deliberately introduced11s import delay, not original-runner latency attribution.
- [Contention records](contention-summary.json), [fault control](import-fault-summary.json), [exact source and raw-report bindings](verification.json). Source files were unchanged throughout all30 samples.
