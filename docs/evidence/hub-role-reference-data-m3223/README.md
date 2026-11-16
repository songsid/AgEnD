## M-3223 reference-pattern data preparation

This slice supports the approved Google Workspace Admin roles pattern. It does not mount role administration, activate roles, or change the held #4056 authority attestation fix. The role-page rebuild and its real-Hub captures follow in a separate slice; styling-only #4063 is superseded and stays held.

Changes:

- Optional, bounded role descriptions survive parsing, canonical reads, checked proposals, persistence and historical role deltas. Legacy documents retain their exact shape; Administrator remains immutable. No new SQL table is required.
- The existing resource impact covers chat, sharing and Fleet access only. A separate fact-bound role review now includes lost team/management permissions and narrower scopes, plus explicitly unverified people. The controller adds cached names without treating names as authority. Existing resource consequences are unchanged.
- A write that can reduce administrator authority must leave a currently known eligible administrator. Unrelated delegated Member assignments do not acquire this additional continuity requirement during a transient root-directory failure. Configured root counts only with proved eligibility; future, expired, unknown or ineligible assignments do not count. This guard runs during preparation and at the writer's synchronous commit checkpoints. A concrete regression is an auxiliary administrator turning roles off while root is disabled/unverified: the write would remove the auxiliary administrator's authority and is now refused. Independent AD changes/automatic expiry cannot be prevented by a role-write guard; expired authority is never retained.
- Historical per-role/per-assignment events retain role names, subject labels, scopes and old/new values in the same policy transaction. General policy/root-self-use events have structured display metadata. Audit projection accepts only metadata, tolerates malformed legacy actor/event rows, and never falls back to printing opaque policy role IDs.
- Date, exact actor and action filters apply before the existing 50-row cursor page. CSV export is a later UI consumer of this same authorized paged metadata endpoint, not an unrestricted content export.
- Existing reviewed person-label caches/unknown-actor handling from held activation are moved forward into this preparation. Authentication, no-self-escalation, provenance, checked digest, graph/version and writer budgets remain enforced.

## Evidence

Fail first: the new description round-trip and description-only change tests failed against the base (`Hub protocol: invalid`); two failures, one control passed. They pass with the optional metadata field.

Focused final run:

`npx vitest run tests/hub-role-reference-data-3223.test.ts tests/hub-role-admin-3223.test.ts tests/hub-roles-writer-m3010.test.ts tests/hub-roles-model-m3010.test.ts tests/hub-roles-change-m3010.test.ts tests/hub-roles-canonical-s129.test.ts --maxWorkers=2`

**101/101**, six files. Includes checked-description tampering/persistence, historical audit metadata and filters, malformed legacy rows, explicit last-admin eligibility/time boundaries, actual writer turn-off refusal and a root eligibility change between preview/apply. No vendor process, live Fleet, browser, remote directory or security co-review campaign.

`npm run typecheck` and `npm run typecheck:tests`: **exit 0**. `git diff --check`: clean.

## Permission wording verified from source

- `fleets.manage` can list connected Fleets and revoke/disconnect one; it cannot choose recommended versions.
- `join.manage` covers Fleet joining, invitations and join codes. Allowed-list edits require `hub.admin`.
- `team.view`/`team.usage` are selectable saved/scoped permissions, but team views are not mounted yet. Lumen confirmed their rows must say “Takes effect when team views open”, and the Manager sentence must qualify that future effect.
- Administrator read-view description includes role/Hub settings, allowed list and recommended version. The new UI uses Lumen's corrected EN/zh-TW copy.

## Risk and rollback

This remains an unmounted preparation. New code reads old policy JSON without rewriting it. Once descriptions are saved by a future activated build, an older binary whose strict schema lacks this field cannot read that newer policy; rollback remains a forward role-mode rollback on the current binary, not restoring old data or downgrading across activation. The guard may refuse a mode-off action when no eligible root can be proved; restore/check that directory account before retrying. Historical names are cached presentation labels and may be absent; the UI must say Unknown rather than show internal IDs.
