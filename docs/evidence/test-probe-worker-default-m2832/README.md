# M-2832: default test probe isolation

`saveFleetConfig → probeChangedCliEnvs → probeBackendBounded → cli-env-probe-worker` starts another JS realm, so a parent backend mock does not follow it. M-2814 and M-2829 isolated individual callers; this change puts the default at their shared Worker boundary.

The unit and serial integration setup select only `/backend/cli-env-probe-worker.{ts,js}`: compiled Worker URLs or the TS loader's `workerData.entry`. PowerShell inherits the unit setup. The default fake answers asynchronously with null, resets per test and drains owned probes, including pool-queued work. A termination rejection needs an exit acknowledgement; disposal fences late fake answers. Other Worker kinds, Node exports, product code, native process guards, deadlines and retry policy stay unchanged.

Thirteen blanket `worker_threads` mocks are removed, retaining their custom fake answers/manual replies and original assertions. The three remaining custom mocks cover Kiro lifetime/recovery and the worker entry's `parentPort`, not the global model-probe default. No existing suite needs a real model-probe isolate. The documented `useRealProbeWorkers()` opt-in is tested with private inert JS bodies and the unchanged guard, including overridden `execArgv`/`NODE_OPTIONS`; no real model CLI is launched.

## Inventory

Run `node docs/evidence/test-probe-worker-default-m2832/inventory.mjs` to reproduce the read-only snapshot at its recorded base. Counts are lexical, including mocks/fixtures/refused saves, not a dynamic call graph: **77** save references, **20** call-shaped files, **18** without a Worker mock, **9** bounded-probe references and **16** old Worker mocks. `inventory.json` supplies every path. All 18 save-related suites pass under the default. Existing guard native-Worker/descendant tests remain in the focused set. Standalone child programs and intentional CLI e2e configs retain their own guarded environments.

## Verification and limits

`fail-first.json`: before the setup, compiled/TS selection each assertion-failed and the unrelated native Worker control passed. Those bodies were inert copies, never backend execution.

`checks.json`: 714 passing focused cases in 41 file invocations (including four serial integration cases); final pinned core/config/changelog recheck 162/162. These overlap. Initial broader checks were on the candidate modified tree, and final checks ran on the committed source recorded in `receipt.json`. Test typecheck passed. The product source tree and three process-guard files match the base. Full unit/integration execution belongs to PR CI.

`mutations.json`: **9/9** independent reversals failed selected tests (compiled selection, TS selection, unrelated pass-through, native opt-in, reset, teardown, stop acknowledgement, late-answer disposal, ownership registration). The public save journey is deliberately deselected for mutations that disable isolation; the selected native bodies are inert. `mutate-default.py` records the exact replacements and restores files in `finally`; its local result paths are scratch output, not product inputs. The reset of the native opt-in is repeated at teardown and the next test, so either reset alone is redundant.

No screenshots apply to this test-only change. Risk: a test expecting live model discovery must now provide an answer or explicitly opt in. Revert the harness/config/test changes normally; runtime data and release behavior are unaffected. The shared alpha test line needs a main-first twin after this PR lands.
