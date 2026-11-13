# Track R1 acceptance

Source checkpoint: `3ed015da2576b909cd6ac488ee48152be6bb38cf`. The prior plain merge `9fdbf5800` has parents own `ec45ddfdd` and alpha `953939512`, with every own product/test file byte-identical across that merge. The final correction keeps old cached clients on the direct-only list and puts the combined list at `?v=2` (Track U #3848 f7490a455 carries its URL). `acceptance.json` binds all 16 own paths. This packet changes evidence only.

Before implementation, all six initial group-room HTTP contract cases failed semantic assertions (the direct-only route returned 400). After implementation:

- 171/171 tests in six suites: room HTTP/SSE/SQLite, frames, additive migration, existing S3 direct server, attachments and actual Hub factory.
- After the plain alpha sync: 23/23 in the three new suites plus shared module inventory. Twelve overlap with the prior run; these are separate counts.
- Final list-compatibility pass: 37/37 in four suites (new rooms/frames/migration plus retained direct server), including the cached renderer refusal to receive group rows. These counts overlap the prior runs.
- Native source and test TypeScript checks both exit 0 again after this correction.
- Changelog validation: 456 fragments before sync, and whitespace check clean. Incoming alpha adds its own previously validated fragments.

Commands (nice 10, started with host load below 10):

```sh
nice -n 10 node_modules/.bin/vitest run tests/hub-rooms-r1.test.ts tests/hub-room-frames-r1.test.ts tests/hub-rooms-migration-r1.test.ts tests/hub-s3b-server.test.ts tests/hub-attachments-rooms.test.ts tests/hub-compose.test.ts --maxWorkers=2
nice -n 10 node_modules/.bin/vitest run tests/hub-rooms-r1.test.ts tests/hub-room-frames-r1.test.ts tests/hub-rooms-migration-r1.test.ts tests/hub-shared-modules-a.test.ts --maxWorkers=2
GOMAXPROCS=2 nice -n 10 node_modules/.bin/tsc --noEmit
GOMAXPROCS=2 nice -n 10 node_modules/.bin/tsc --noEmit -p tsconfig.test.json
```

The new tests use real localhost HTTP, SQLite and the production HTTP composition. Their S3 fixture supplies an inert directory, transport, audit and in-memory content port. Production text storage delegates to the existing encrypted content store; the new SQL retains refs only. The direct answer control uses the actual release authorization, answer receiver and SSE projection. The factory suite retains its own synthetic directory and TLS fixture scope.

No live directory/Fleet/account, CLI execution, browser or container campaign was run. This is backend R1, not the later joined UI walk-through. The configured root creates rooms; the picker lists known eligible Hub people. Teams/groups, invitations, room agents/assistant calls and group attachments are subsequent integrations. The reserved room-agent wire feature is not advertised.

Migration is additive and keeps existing direct tables/IDs/receipts. An older binary refuses the new registry; use a corrected build that understands it for rollback, retaining state. Full Track R remains open in #3856.

## Review R1: single stream integration

Latest source checkpoint: `b2228a95583fa883b81d54c0e445315a0df74a71`; this supersedes the earlier checkpoint for the changed files. New controls first failed six semantic assertions across 14 cases: missing initial notices, system rows counted as unread, and an unrelated viewer closed under queue pressure. The restored expanded run passes 48/48 across five suites (rooms, frames, migration, direct server and existing quick-pairing HTTPS); both native programs exit 0. Counts overlap prior runs.

The combined rooms stream now includes initial snapshots and updates for notices=2/3, with a v3-to-v2 downgrade when enrolment-code-v1 is not offered. Missing/invalid parameters send only room events. The positive controls use the real HubPairingNotices service and SQLite/audit, with an inert company-join availability marker solely for the v3 feature case; no join method or account is used. Unread excludes system rows. A cheap membership query precedes per-viewer queue admission; final event projection still authorizes afresh. The queue control holds Cara's eligibility while 40 unrelated posts produce 80 events, then proves her own stream still works.

## CI inventory repair

Source checkpoint: `222928ba350252b95760e1feac18be279a096f98`. CI43468675166 failed three existing group-mount cases because six exact feature arrays omitted the newly composed rooms-v1. Only those six expectations changed; every product blob is unchanged from b2228a955. The two-file local regression passes35/35; exact feature assertions elsewhere cover member-link or direct-room features and need no change. Source/test native results above remain on the unchanged product and typed fixture shape; no extra native run is claimed for these string-array edits. Original source/notice controls and evidence retain their earlier scopes.
