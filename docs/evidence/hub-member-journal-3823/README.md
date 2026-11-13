# #3823: re-pair-safe member journal

The reported failure is reproduced in an owned private home with real TLS/WSS, SQLite, the production member
factory, real pairing/revoke/claim and `HubRoomsService.reconcile`. The fake directory accepts the one fixture owner.
Question/admission records use synthetic data and an inert outbox; there is no agent input, real AD, account call,
container, live Fleet operation or browser campaign. No UI markup changed.

A first Fleet's retained message belongs to that Fleet on the Hub. After owner revoke and a real new pairing to the
same Hub, the old implementation sends that ID under the new Fleet ID and the unchanged Hub conflict guard closes
the connection. The repaired factory selects a different whole member state set and reaches `online` without old IDs,
receipts, publication consent or executable intents. The old set remains readable.

The same-Fleet control sends its original known ID and outstanding receipt on the real link, accepts the ACK, then
reopens with the exact operation/delivery/receipt identity. Further controls cover v1 same-Fleet adoption, v1 re-pair,
credential/web-address refresh, committed/staged exposure-only ownership, independently keyed state, scoped restart,
offline withdrawal, mismatched/parked floors, mixed owners, corrupt ciphertext, orphan recovery records and an adoption
floor failure. Partial state is held; it is never silently recreated.

Commands (from the repository root, load at most 10, maxWorkers=2):

```sh
python3 docs/evidence/hub-member-journal-3823/scripts/baseline.py
python3 docs/evidence/hub-member-journal-3823/scripts/mutate.py
node_modules/.bin/vitest run tests/hub-member-repair-3823.test.ts tests/hub-member-journal.test.ts tests/hub-compose-member.test.ts tests/hub-member-reconciliation.test.ts tests/hub-member-reconnect-network.test.ts tests/hub-member-restore-3415.test.ts tests/hub-representative.test.ts tests/hub-execution.test.ts --maxWorkers=2
node_modules/.bin/tsc --noEmit
node_modules/.bin/tsc --noEmit -p tsconfig.test.json
```

Results at source merge `249e4eb4b`: 168/168 across eight focused files, then 65/65 across the two changed files plus
`hub-exposures-s3c` and `hub-exposure-api-s3c` (40 overlapping cases; 193 distinct cases in ten files). Both native type
checks exit 0. All eleven compiling reversals are caught. The incoming alpha sync has five disjoint UI/test/script/
fragment paths from #3838; all eight own product/test/doc/fragment blobs are unchanged from source `48f23c67f`.

The baseline script uses the final fixture with the exact pre-fix production source from `17e0b5063`; one re-pair
assertion fails and the same-Fleet control passes. It restores both source files. Each mutation is run separately,
compiles with the native source checker, fails an assertion, and restores the original files. Logs and receipts are
under `logs/`; the manifest binds them and the changed source/tests. Earlier intermediate runs are not extra passes.

Risk and rollback: v2 adds a nullable binding column, then adopts under the independent journal revision floor before
recovery. New pairings retain old state on disk, so repeated re-pairs consume storage. A corrupt or ambiguous legacy
set remains held. Older binaries refuse the v2 schema; use a consistent pre-upgrade backup of the complete state set
for rollback. Do not delete binding metadata, floors or journals, and do not copy an old Fleet's state into a new one.

The public rehearsal handoff is [the redacted #3823 capture](https://github.com/songsid/AgEnD/issues/3823#issuecomment-6851255072).
Its original container was already removed by its owner; this reproduction needs no peer filesystem or private backup.

## R1 review pins

R1 changes tests and evidence only; both production files are byte-identical to `a8e56a67a` (Ridge scoped SOURCE CLEAR).
The new controls cover complete scoped state with absent/partial legacy files, missing-pairing offline refusal,
exact S4 context digest and representative exposure revision, the retained-read pairing check, and pairing changes
inside composition/offline binding. The offline race changes the real private fixture profile after the production
bind returns; the reader must refuse before withdrawal. Original logs/receipts retain their stated scopes.

The original aggregate had a counting error: its two changed files contain 40 cases, so 168 + 65 - 40 = **193**
distinct cases. Test outcomes are unchanged. R1 results and seven isolated compiling reversals are recorded under
`r1/`; no additional browser, live Fleet, directory or account operation was used.
