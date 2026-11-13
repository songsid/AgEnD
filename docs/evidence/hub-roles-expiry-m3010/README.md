# Inactive expiry acceptance (M-3010 / S-127)

The committed receipt pins source/test bytes, accepted checks and isolated reversals. The exact-head GitHub acceptance supplies the commit and CI state; this file does not try to hash itself. The integration and activation boundary is [the expiry note](../../design/hub-roles-server-expiry.md).

The initial stub returned zero for every attempt. Three selected tests failed actual settlement/batch/changed-deadline assertions. An early clock-test scaffold stopped at that same missing first settlement, so it is not counted as proof of a clock guard. The actual clock fence is pinned by the later compiling clock-floor reversal. A fixture type failure was corrected by supplying the directory's inert signIn/close methods; no product type or test assertion was loosened. Accepted final runs gate load before every launch and use at most two Vitest workers; an exploratory first-implementation result is not substituted for the accepted gated runs.

The controls cover exact-term idempotence and changed deadlines without deleting assignment history; one authorization epoch for a batch; actual hash-chain audit and audit retention; fresh current administrator notices; rollback on audit, thenable, lifetime, time, policy, ordinary-resource and epoch uncertainty; post-commit refresh classification; clock rollback after reopening; actual independent-floor refusal of an older transport image; publication of one flight before reentrant integration callbacks; and physical directory admission retained across close until its read settles. Tests use actual SQL transactions and the existing pool, with synthetic directory answers and retained-resource effects.

Each guard reversal is applied alone, source-typechecked, and required to fail a selected semantic assertion. Missing imports, type errors, broad timeouts and unused mutants are not counted. The harness restores source bytes in finally and records the digest. The public receipt distinguishes this series from the parent writer's separate evidence.

```sh
node_modules/.bin/vitest run tests/hub-roles-expiry-m3010.test.ts \
  --maxWorkers=2 --cache=false --configLoader runner
GOMAXPROCS=2 node_modules/.bin/tsc --noEmit
GOMAXPROCS=2 node_modules/.bin/tsc --noEmit -p tsconfig.test.json
node scripts/changelog-assemble.mjs --check
git diff --check
```

There are no UI assets, features or routes to expose to older tabs, and no live SKEW or screenshot claim. The helper and its auxiliary migration remain unregistered and uncalled. The real resource/provenance adapter, atomic cutover, runtime scheduler and live role permits/leases/streams are not supplied here. Every later authority path must enforce assignment deadlines and the persisted clock fence before activation. No LDAP wire, browser, container, real account, backend CLI, native Windows or live Fleet operation was run.
