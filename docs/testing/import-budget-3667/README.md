# Cold test imports (#3667)

A test can spend its entire default 10-second assertion budget compiling and evaluating FleetManager's module graph. No FleetManager operation is required to trigger this. In the recorded original agy case, eight owned CPU burners and Vitest shared one allowed core: the dynamic import timed out at 10,000 ms. With a static import, the same selected case passed: collection/import took 67.54 s, while the unchanged assertions took 174 ms. The fixture creates only dummy agy/cache files; no backend, account, fleet or live service is used. All owned burners were terminated and waited in `finally`. Logs are the actual outputs, with selected-case skips disclosed.

Reproduce on Linux with `python3 scripts/manual/import-budget-3667/cpu-load.py "$PWD" --log /tmp/import-load.log`. Use the unchanged base checkout for fail-first. The runner sets CPU affinity only on its own children and never changes the test timeout or retries a failed invocation. CPU availability and cold-cache state affect duration; the static import ensures cold compilation is outside the assertion deadline.

The fix moves safe imports to file collection and preserves module/mock order for cache-sensitive suites with scoped setup hooks. Fresh-module tests retain their reset and import, with an explicit setup budget separate from unchanged assertion timeouts. Product code, guards, existing assertions and global test budgets remain unchanged. Rollback is reverting the test-only change.

Ridge's second reported case, `hub-company-join-http` / `the10min outer deadline…`, already has static Hub imports and does not use FleetManager. Its fixture creates certificates with openssl, initializes a sealed Hub and fake LDAPS, and signs in/enables policy inside the test. There is no per-await timing trace proving an import cause. This change does not claim to fix that distinct setup-cost timeout; it needs its own measured investigation if it recurs.

## Inventory and ordering

`inventory.json` records every runtime dynamic import of FleetManager, daemon and web-api in the baseline main tests: 171 expressions across 108 files (134/21/16 respectively; no runtime CLI import). 48 files already import these at collection/setup or are warmed by static FleetManager imports; those remain unchanged. The other 60 can incur a cold import inside a selected test/helper. The change moves 55 to static imports, gives 3 server suites scoped `beforeAll` loading after their earlier UI module-cache resets, and moves Claude carry's deliberate per-case reset/import into scoped `beforeEach`. The logger guard intentionally tests a fresh scratch-home import and already has an explicit 60-second test budget; it remains unchanged.

The three `beforeAll` hooks and two fresh-module `beforeEach` hooks have a separate 120-second setup budget (the existing fleet-delegations precedent); no assertion timeout or global Vitest setting changes. Per-test `AGEND_HOME`, cache files, model/profile setup, mock factories and UI `resetModules()` calls remain where they were. Static module references do not instantiate a FleetManager or start a service. The affected tests are run normally, including env/profile and UI controls, rather than replacing their assertions with source-text checks.

The changed `cli-env-probe-guard` and `tmux-kill-window-confirmed` files are existing serial resource suites with a 30-second integration budget, rather than the default 10-second unit budget. They are included in the import cleanup, but the reproduced 10-second failure is the agy unit case. Their original integration config and private tmux/process guard remain unchanged.

Main validation: 57 affected unit files passed 1,830 assertions (three invocations: 1,028 + 489 + 313); the two affected serial integration files passed 11 assertions. Native test typecheck passed. No assertion or process-guard weakening, no global/per-test timeout edits and no retries.

Saved CPU logs have only trailing blank lines removed; no substantive output is masked.

## Alpha parity

Alpha adds three cold FleetManager test imports (`native-daemon-client-2950`, `native-pane-permission-parity`, `settings-summary-effects-3416`); these also move to static imports. Its model-stale-refresh file already loads FleetManager statically, so remains unchanged. The other cherry-pick conflicts preserve alpha's own sign-in test name/mark and its private tmux `afterAll` cleanup; only import placement changes. See `alpha-inventory.json` for the baseline delta. Eleven other alpha-added files already load the target graph before tests and remain unchanged.

Alpha validation: 59 affected unit files passed 1,849 assertions; the two serial integration files passed 11. Native test typecheck and diff check passed. The CPU-load before/after evidence is from main's byte-identical agy test/import change; alpha does not claim a second CPU campaign.
