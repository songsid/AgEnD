# Alpha R1 ownership correction — #3334 / M-2861

Source parent `48df024c8369f40b2154fa367a4d58d2efbb2268`; modified-tree inputs are bound by the manifest. This is the alpha correction for Prism's worker-transfer finding on #3611. Main correction #3612 is `b6c851d1d0c5a047d439123d9bf32ba68bb26811`; it merged as `6050fec12fe140e2e0cf416a6979499d61305258`, with ancestry and correction patch verified. The alpha merge handoff waits for its post-merge CI verdict.

The worker's authoritative owner is captured separately from the presentation sink and compared by the common answer method before invoking the CLI. A transferred CLI prompt retires as stale for buttons, typed replies and dashboard claims. Existing unchanged-owner, private Classic, redaction, raw-identity and web-only controls remain.

- **357/357 tests in13 focused files, zero skips**, plus source/test types and diff pass.
- The cumulative production patch has the same stable patch ID as corrected main. Selection-card and both changed tests are byte-identical; whole FleetManager/types have unrelated release-line differences.
- Main's6 fail-first transfer cases and2 compiling reversals retain main-only scope in `../cli-question-owner-3334/`; no repeated alpha mutation or browser/real CLI/account/model/live/native claim.
- Earlier alpha evidence under `../cli-question-chat-3334-alpha/` is historical at48df024c, not a current-source manifest.

Use the `testFiles` list in `checks.json` with Vitest and both TypeScript checks. Mock Discord/Telegram and recorded-pane I/O only. No guard, timeout, retry, schema or data changes. Rollback is a revert restoring the old missing-card behavior; reverting only the ownership correction restores the stale-owner defect.
