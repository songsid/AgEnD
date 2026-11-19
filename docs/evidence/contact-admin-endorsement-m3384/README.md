# Administrator-endorsed contact delivery

Baseline: `8b7b331b7e38c1a2268059c97264b3e13ed5de09` (2026-11-19).
Eight new cases fail before the fix: explicit approval and matching standing
grants, each with a target whose previous origin is absent, human, mixed or
unknown. The source has two originating people. Each case asserts that target
origin stays exactly unchanged, source origin stays unchanged, and the ticket
retains the original origin/decision audit and delegate-task semantics.

The fix removes target-origin inheritance from the approved admission transaction
shared by both paths. It does not clear or replace any existing origin. The
source continues to require applications; grants still match each known person
and retain their count/expiry rules. Ordinary relays without endorsement keep
their existing behavior. The proven-return test now explicitly seeds a worker's
pre-existing restriction instead of assuming approval created one.

Validation: 200/200 tests across 13 contact/Hub/UI/skill/wording files; source
and test TypeScript checks exit 0. The eight semantic-red baseline cases also
pin the reversal that would restore the removed inheritance call.

All data is synthetic and SQLite/IPC boundaries are owned test fixtures. No real
account, Fleet, vendor CLI, browser campaign or live state changes are involved.
The UI diff changes only statements that become false; the companion card-copy
rewrite owns layout and the remaining wording.

Rollback: revert and restart. No schema/data migration. Previously recorded
origins are untouched in either direction; reverting would restore inheritance
for future approved deliveries.
