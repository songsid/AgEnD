# M-3010 / S-126 acceptance

Production and test digests, base, counts and every isolated reversal result are in [receipt.json](receipt.json). Accepted design: `docs/hub-ux-review-m2902 @ f9d969f07`. Implementation boundaries and remaining slices are in [the foundation note](../../design/hub-roles-server-foundation.md).

Fail-first controls were executable scaffolds, not missing imports: the parser delegated to the existing group-only parser (10 failures, 3 passing controls), the evaluator returned unknown and the converter retained no assignments (11 failures), and the partial-positive case returned allow before its correction (1 failure, 8 controls). The final six-file run passes 91/91 with no skips.

The conversion matrix makes 2,592 checked comparisons: three old states × nine fleet limits (0–8) × eight permission bitsets (empty included) × deny/no-deny × independent rule/overlap × three self-use permissions. A separate overlap group has quota 2, so zero and every full-role quota are exercised independently. Each comparison checks outcome, authoritativeness and MAX quota; roles-off pairing is also compared. Stable IDs, preserved denies, malformed facts, no root self-use, expiry, scope and retained assignments have separate tests.

34 reversals were applied one at a time, then restored. Every reversal produces assertion failures. One initial survivor exposed an overly broad throws assertion for a missing role reference; it now requires `HubProtocolError`. That reversal pins the bounded error type, not an added-authority claim. The six conversion/matrix reversals were rerun against the final independent-overlap fixture. No failed import or transform is counted as a caught reversal. The restored sources pass both native TypeScript 7.0.2 checks.

```sh
node node_modules/vitest/vitest.mjs run \
  tests/hub-roles-model-m3010.test.ts \
  tests/hub-roles-evaluate-m3010.test.ts \
  tests/hub-roles-convert-m3010.test.ts \
  tests/hub-group-policy-model.test.ts \
  tests/hub-group-policy-store.test.ts \
  tests/hub-group-resources.test.ts \
  --maxWorkers=2 --cache=false --configLoader runner
npm run typecheck
npm run typecheck:tests
node scripts/changelog-assemble.mjs --check
```

All work used pure fixture data and existing isolated SQL test fixtures. Local test launches obeyed load ≤10 and at most two Vitest workers. There is no browser/Windows/directory-wire/container evidence; no UI assets changed. SQL cutover/crash recovery, rollback floors, downgrade refusal and the manual/code/invitation resource-provenance matrix remain S-128 acceptance. Live route authority, root activation and post-await/lease/stream checks remain later slices. Reverting these unreferenced helpers needs no database rollback.
