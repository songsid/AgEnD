# Contact-origin boundary regression evidence

Pinned baseline: `9bfa5cda752b960b63d2f0678cadd8ad5c7e8f44` (2026-11-19).
All records use synthetic people and an owned temporary SQLite outbox. No live
Fleet, account, CLI or browser automation is involved.

Three fail-first cases at that baseline: the 65th receipt changed a known
administrator to unknown; the 33rd diagnostic hop did the same; saving restricted
on an already restricted room seeded unknown. Each expected known origin and
failed with actual unknown. These cases pass after the two runtime changes.

The regression suite exercises actual receipt ingress, the Fleet mode writer,
durable admission, approval and grant matching. It covers 64/65/66 receipts,
33 hops, 16/17 distinct people, explicit/stored unknown, matching grants and
idempotent mode saves. It also pins intended behavior: the first legacy switch
seeds unknown; inherited worker origin survives a later administrator message;
a genuinely adapterless target permits only the verified host operator.

The UI tests pin the warning before switching in EN and zh-TW, retained-history
reasons, and the absence of a claimed reset. No migration clears old unknown
records because their original cause is not recorded.

Rollback: revert this change and restart the Fleet. No schema or data migration
is added. Old behavior may again turn bounded diagnostic history into unknown;
existing unknown records are unchanged in either direction.

Validation (2026-11-19):
- Origin feedback, contact auth/dispatch/approvers and web contact tests: 70/70.
- Contact API/files, Hub contact limit/privacy/representative, skill sync and
  wording checks: 120/120.
- After adding the EN/zh switch-warning assertions, web contact tests: 35/35.
- `npm run typecheck -- --pretty false` and
  `npm run typecheck:tests -- --pretty false`: exit 0.
