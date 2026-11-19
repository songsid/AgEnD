# Dev twin of the main login-picker fix

The current dev adaptation reuses its existing `BACKEND_LABELS` import from
`interaction-observation.js`. The initial port added that same binding again;
CI setup stopped with TS2300 before test shards could run. R1 removes only the
redundant specifier. Both picker methods and all five changed test files still
match main; the original dev import and its other uses are untouched.

The seven picker payload controls pass on dev, and source/test TypeScript both
exit 0. These checks were run for the actual import integration failure; the
earlier main 53 tests were not repeated or added again to that count. No real
provider, AI CLI, account or browser was used. [R1 proof](r1-proof.json) and
[validation](r1-validation.json) record this adaptation.

## Initial port and retained main evidence

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
merge. Apart from the focused R1 checks above, those checks were not rerun.
Fresh dev CI provides the remaining branch integration checks.

The original main manifest describes the main source stage. The separate
[dev manifest](manifest.json) records the current full dev blobs, including
the larger FleetManager and preserved dev skill. R1's only source difference
from the initial port is omitting the duplicate import; raw own lines match
main on 13 of 14 common paths, and all 14 match when that redundant main import
hunk is omitted. No callback or behavioral change is added. Changelog
validation reports 678 fragments OK.

Telegram uses two buttons per row and short display names; Discord retains
five per row. Callback values, nonce behavior and login/install actions remain
unchanged. Revert this port to restore the old presentation; no migration is
involved.
