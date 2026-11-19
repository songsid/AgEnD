# Contact outcome notices

Baseline: `8db3a240c046fa7623087c3a3a341bef5d61f886` (2026-11-19).
The initial regression suite has five semantic failures on that base: both
locales receive no decline notice, both receive no timer-driven expiry notice,
and a page-expired ticket produces no notice. The approval/no-notice control
passes. The fixed suite has nine tests, using fake time and owned temporary
SQLite stores, with no live Fleet, account, CLI or browser.

Coverage includes EN/zh-TW ticket/target/outcome text, immediate decline, the
actual production Fleet 30-second timer, expiry without a page read, expiry
already observed by a page, approval silence, atomic rollback/retry, persistent
dedup after store recreation and transport-row removal, and upgrade baselining
of already terminal tickets. A notice is an `agend-system` outbox row without a
contact-ticket capability, original correlation, human receipt or request kind;
its correlation and declined ticket cannot qualify for an approved return.

Validation:
- Outcome notices plus contact auth/dispatch/API/approvers, origin boundaries
  and reply-obligation notices: 57/57.
- Hub contact limit, skill sync and wording checks: 75/75.
- Source and test TypeScript checks: exit 0.

Semantics: the sweep admits at most 64 notices per pass. Outbox transport and
uncertain-delivery reconciliation are unchanged; no speculative resend is added.
The durable marker and notice admission commit in one SQLite transaction.

Rollback: revert and restart. The additive outcome-marker table is harmless to
the older build. Already admitted notices stay subject to ordinary durable
outbox delivery; rollback does not revoke or replay them.
