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
