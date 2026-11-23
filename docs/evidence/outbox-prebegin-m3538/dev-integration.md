# Dev twin integration (M-3538)

Actual main #4368 merged as `3cb9ee7efe417e668a7b827297688dc4f2ea69e3` at 2026-11-23T11:56:15Z. Fetched main ancestry and all 12 approved blobs were verified before preparing this standalone dev branch from `7bef9b3530c09d9beef3cdffb42a57f8b8917bcb`.

The crash test, three manual proof scripts, two changelog fragments and four historical evidence files are byte-identical approved main (10 paths). Dev only adapts the two CI partition files: preserve all four existing FleetManager/Hub durable suites, then append outbox. Local inclusion, per-OS exactly-once serial scheduling, setup guards, budgets and retry settings remain unchanged. No production code changes.

Fresh dev integration: the actual pre-begin SIGKILL case plus all 12 partition checks PASS (13 distinct cases; the other 15 outbox cases were intentionally skipped). An additional PowerShell-only invocation passed the same nine checks and adds no distinct coverage. Source/test typecheck exit0; changelog758 fragments/public/Gitleaks PASS. No CPU/fault/full-suite/provider/native/browser campaign repeated.

The [main evidence](README.md), source bindings and 30 loaded-run records remain historical main author evidence. The two partition bindings in that original verification describe main; [current dev bindings and integration results](dev-integration.json) describe this twin. Shared test/proof-script equality carries that bounded proof, without claiming execution against every dev runtime or arbitrary starvation.

Main post CI is tracked separately. Both actual merges and required post checks must complete before task delivery. Rollback only test/partition changes through a normal PR; no runtime migration.
