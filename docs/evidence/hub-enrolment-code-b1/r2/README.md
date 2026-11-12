# B1 R2: explicit recovery before policy enable

The R1 authorization entry point let retained code checks bypass the never-enabled legacy branch, but rejected every Resume there before authenticating the administrator. The real HTTP fail-first case returns 409/conflict instead of 200 after an administrator applies an exclusion, removes it and resumes the exact suspended code Fleet. The direct permit control also rejects with `group_policy_invalid`.

The only product delta is in `group-policy/authorization.ts`: an existing code source may enter the normal Resume path before first enable. Manual checks keep their existing behavior; never-enabled manual and unregistered Resume remain refused. Removing an exclusion still returns `resume-required` on an ordinary check. Explicit Resume retains fresh configured-administrator authentication, owner eligibility, exact resource/lifecycle/policy revisions, directory binding, authorization epoch and post-audit transaction fences.

The restored run passes 294/294 across ten files, zero skips. It includes the real sealed Hub/SQLite/verified synthetic LDAPS route: create and issue a code Fleet, save an exclusion, remove it by real preview/apply, reject a stale lifecycle request, then recover the exact code row with a current admin/revision and one resumed audit event. Inert directory controls cover a wrong admin, exclusion still in force, disabled/unavailable/mismatched owner, held authentication and eligibility races, and late audit/invalidation cancellation. Both source and test native typechecks pass; 379 changelog fragments and diff checks pass.

Six isolated, compiling reversals fail semantic assertions and restore byte-exactly: remove the code Resume exception, broaden it to manual, remove configured-admin identity comparison, skip code eligibility, absorb a raced epoch, and remove the final broadening fence. See [mutations.json](mutations.json). An initial admin mutant did not compile and is excluded; the recorded variant keeps the actor-type check and removes only the configured-person comparison. Held-read tests also settle a premature rejection rather than waiting indefinitely for an admission that never happened.

```
node_modules/.bin/vitest run tests/hub-enrolment-code-permit-b1.test.ts tests/hub-enrolment-code-http-b1.test.ts tests/hub-group-admin-read.test.ts tests/hub-group-admin-control.test.ts tests/hub-group-admin-impact.test.ts tests/hub-group-resources.test.ts tests/hub-group-authorization.test.ts tests/hub-group-authorization-network.test.ts tests/hub-group-publication-enrollment.test.ts tests/hub-group-composition.test.ts --maxWorkers=1
python3 scripts/manual/mutation/hub-enrolment-code-b1.py code-resume manual-resume resume-admin resume-eligibility resume-epoch resume-late
node_modules/.bin/tsc --noEmit
node_modules/.bin/tsc --noEmit -p tsconfig.test.json
node scripts/changelog-assemble.mjs --check
```

[source-binding.json](source-binding.json) records the changed authorization bytes, 22 unchanged R1 product files and five unchanged R1 image hashes. No new capacity/browser/rollback run is claimed. R1's 123-check container, five distinct technical pending handoffs, sidebar/loading and earlier timeout limitations, and prior bootstrap/rollback scope remain historical carry. This revision changes no UI, wire shape, migration or stored data. Reverting it restores the former Resume refusal; a full B1 downgrade still needs the matching complete pre-upgrade private state.

Draft/U2-first/plain-sync/current-head CI/final-readiness holds remain. No pilot, real directory/account/backend CLI, native Windows or deployment operation was performed.
