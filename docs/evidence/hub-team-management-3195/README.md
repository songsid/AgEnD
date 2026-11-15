M-3195 implements T2 from `docs/design/hub-teams-as-subjects.md` at 4e2e85c96, copied requirements only; the design branch was never merged.

The old single-lead field remains a first-lead alias. An additive migration retains existing lead identities and defaults creation to administrators. New creators become the first lead. Leads remain roster members; one to five distinct leads are required. Revision/snapshot fences prevent an awaited directory lookup from overwriting a later roster or creation-policy change. Member and lead audit events carry the actor, affected person and team ID in the same transaction.

T1 owns allowed-list subjects; synchronous read/expand/isMember signatures and the closed id/name/people candidate shape stay stable. T2 summaries expose lead names and memberCount; nonmembers receive no roster IDs or member metadata. Room additions remain snapshots. T3/T4 revocation and join-code changes are outside this PR.

Fail-first: the two initial management tests failed on the old service (missing creation settings and required department/lead); both passed after implementation. Source and test typechecks plus focused SQLite/HTTP/UI/client suites are recorded in the acceptance comment. The browser script uses the real shared shell/components with a worked Teams API fixture and inert directory, not a live AD or Fleet. No vendor CLI/account was used.

Rollback: the Hub’s schema-version guard refuses an older build after this additive component is applied. Restore a pre-upgrade Hub SQLite backup before reverting and restarting the older release. No automatic destructive down migration is added. Legacy first-lead aliases are retained for consumers, not a promise that an older release can open a newer schema.
