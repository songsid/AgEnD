# Alpha parity: CLI permission choices — #3334 / M-2861

Historical R0 at `48df024c8369f40b2154fa367a4d58d2efbb2268`. The current ownership correction is recorded in `../cli-question-owner-3334-alpha/`; this original manifest is not a current-source claim.

Alpha base: `33d2ac3f6b864b4d84f49634e83937fd5f9df639`. These local runs used a modified tree before commit; `manifest.json` binds the tested source, tests and recorded pane. Main approval is at `73637b66e0c842d6717189f4bbee97969f457abb` (#3608). Main merged as `a53ceff487461ccf5ad6d4ce646a2d4e441f481c`; its ancestry and the same production patch ID were independently verified. Alpha publication waits for the main post-merge CI verdict.

The production patch has the same stable patch ID as approved main. The complete selection-card module and both changed tests are byte-identical. Whole FleetManager and backend type files differ between release lines; the claim is patch parity, not whole-file equality.

- **351/351 tests, 13 files, zero skips** on alpha; source and test typechecks plus `git diff --check` pass.
- The same mock Discord/Telegram and recorded-pane cases cover exact owning-connection admin authority, revocation/address/replay/current-pane fences, unchanged web-only controls, masked chat presentations/outcomes, distinct raw identities and private Classic-room routing.
- Main's fail-first cases and 12 compiling guard reversals remain historical main evidence in `../cli-question-chat-3334/`; they were not rerun or relabelled as alpha executions.
- No browser, real backend CLI, account, live fleet, directory, native or model execution is claimed. No UI module or HTTP contract changes.

Run the `testFiles` list in `checks.json` with Vitest, then `tsc --noEmit` and `tsc --noEmit -p tsconfig.test.json`. No thresholds, process guards, retries or deadlines changed.

Rollback is a revert of the fix, restoring the missing-card behavior. No data format or migration changes.
