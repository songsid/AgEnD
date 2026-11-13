# S-127 inactive writer acceptance

[receipt.json](receipt.json) records the source/test hashes and the final 26 isolated reversals. [The writer note](../../design/hub-roles-server-writer.md) defines the storage, authority and future integration boundary. The GitHub acceptance pins the final merged-sync HEAD and integrated checks; this committed receipt deliberately binds precommit bytes rather than trying to hash itself.

The focused set passes **146/146 in nine files, zero skips**: three new writer/planner/delegation suites, the three foundation suites, and the existing group model/store/resource controls. This includes actual SQLite transactions, hash-chained audit, `HubSessions` sign-in/sign-out contexts and the existing shared directory pool. The auxiliary administrator succeeds even though the current session presentation's root-only `admin` flag is false. Directory answers and retained-resource effects are synthetic.

Fail-first evidence includes the empty planner/delegator scaffolds, the root/notice stubs, destructive-edit bounds, monotonic time rollback/deadline, early authority before inventory, post-commit refresh classification and the private impact size limit. The initial empty writer run included dependent “preview refused” errors and one held-scaffold timeout; those are not counted as proof of individual guards. The final reversals each compile under native TypeScript and fail actual assertions. One earlier generator produced unreachable-code type errors; it was excluded and replaced by a compiling whole-block reversal. A prior partial reversal run was restarted after adding the early-authority ordering check; only the complete final 26-run series is counted.

The final reversals pin: both phase-3 bits, actual attribution, old-bundle destructive bounds, direct/group self-target, quota, expiry and exact scope, semantic directory evidence, final session/policy/authority, synchronous audit/effect/proof, current admin and recorded-recipient notice reads, retained root activation marker, reserved root role, private effect identity/impact, wall/monotonic deadlines, person denies, early actor admission and bounded impact. Every source was restored byte-for-byte before final checks. Local launches obeyed load ≤10 and Vitest ≤2 workers; no full suite was run locally.

```sh
node_modules/.bin/vitest run \
  tests/hub-roles-writer-m3010.test.ts \
  tests/hub-roles-delegation-m3010.test.ts \
  tests/hub-roles-change-m3010.test.ts \
  tests/hub-roles-model-m3010.test.ts \
  tests/hub-roles-evaluate-m3010.test.ts \
  tests/hub-roles-convert-m3010.test.ts \
  tests/hub-group-policy-model.test.ts \
  tests/hub-group-policy-store.test.ts \
  tests/hub-group-resources.test.ts \
  --maxWorkers=2 --cache=false --configLoader runner
GOMAXPROCS=2 node_modules/.bin/tsc --noEmit
GOMAXPROCS=2 node_modules/.bin/tsc --noEmit -p tsconfig.test.json
node scripts/changelog-assemble.mjs --check
git diff --check
```

No UI asset changes, feature advertisement or HTTP routes: old tabs continue on the existing group-policy path. No UI/PNG or live SKEW claim is made. There is no wire LDAP, container, Windows, backend-CLI, real account or live-fleet evidence. Role migration, one-time migration announcement, expiry settlement/scheduling, retained-resource provenance and live permits/streams remain later acceptance. Reverting this unreferenced writer needs no production DB reversal.
