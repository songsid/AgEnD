# CLI prompt ownership after transfer — #3334 / M-2861

Base: `de21c9123ffe321a45efffe8400917c49be4c5aa` (merged main #3608). This is the main correction for Prism's alpha-parity #3611 finding. Runs used a modified tree before commit; the manifest binds those inputs, without relabelling them as committed-head or browser execution.

A CLI card remembered the adapter where it was posted. That adapter's admin could still answer after the worker's configured owner moved to another adapter. The card now captures the authoritative worker owner before posting, separately from the private dashboard's presentation sink. The common answer method compares the live owner before invoking the CLI answer. A mismatch retires the claimed prompt as stale without sending keys or reposting it. This covers platform buttons, text replies and dashboard claims without changing their claim/status contract.

- Fail-first: all **6 transfer cases** (Telegram/Discord × button/text/web) fail on the base;21 existing controls pass.
- Restored correction: **355/355 in13 focused files**, zero skips; source and test types and diff pass.
- Drop the live-owner check:6/44 assertions fail. Capture the display sink instead of the worker owner:3/44 fail (private Classic/web-only controls). Both reversals compile; source restored byte-exact.
- The fragment check caught missing list markers; corrected before the final restored pass.
- Existing unchanged-owner approval, revocation, raw-card identity, redaction, private Classic routing and web-only controls remain. No new parser, auto-approval, process-guard, retry or deadline change.

Use the `testFiles` list in `checks.json` with Vitest, then `tsc --noEmit` and `tsc --noEmit -p tsconfig.test.json`. These are mock-adapter/recorded-pane tests using real FleetManager and scripted answer I/O; no real CLI, account, model, live fleet, native or browser execution is claimed.

Rollback reverts this correction and reintroduces the stale-owner acceptance. No data migration.
