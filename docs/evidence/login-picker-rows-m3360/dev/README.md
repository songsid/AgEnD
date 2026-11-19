# Dev twin of the main login-picker fix

Main #4211 merged as `44e63b0994fde754ee86531918e5ae2febca5a95`, from approved
head `91ae128779ed0d368b0dc8014d2789cc83a06312`. Its actual merge and main ancestry
were verified before creating this standalone branch from dev tip
`ae62202a30b6ff53f0a8b151252035e314c91ef1`.

Static comparison at port commit `c94e51d09f74c503fb7fa4de7d0e320a0cab4092`
finds identical added/removed lines for all 14 common paths. Both changed
methods (`promptLoginBackends` and Telegram `notifyAlert`) are byte-identical to
the main merge, and all five changed test files are identical full blobs.
Telegram's whole adapter is identical too. The [comparison record](port-proof.json)
records the per-path hashes and method checks.

The dev skill already describes dashboard-only Antigravity named accounts.
That incoming paragraph and the rest of the skill are preserved exactly; only
the reviewed five-line login-picker paragraph is added. The conflict resolution
does not replace dev's account guidance with the older main paragraph.

The [main packet](../README.md), manifest and validation logs are retained as
historical main evidence: four baseline failures, 53 distinct staged passing
tests, source/test TypeScript success, and exact-head 23/23 green checks before
merge. Those checks were not rerun for this identical port. No new local test,
provider, CLI, native-client or browser campaign is claimed here; fresh dev CI
provides the branch integration checks.

The original main manifest describes the main source stage. The separate
[dev manifest](manifest.json) records the current full dev blobs, including
the larger FleetManager and preserved dev skill. No runtime or callback change
is added beyond the reviewed fix. Changelog validation reports 678 fragments OK.

Telegram uses two buttons per row and short display names; Discord retains
five per row. Callback values, nonce behavior and login/install actions remain
unchanged. Revert this port to restore the old presentation; no migration is
involved.
