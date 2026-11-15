# M-3161 server evidence

Base: alpha `93c6e9fb7bd6c3d63364e6e181e24ad1bfa0dcf9`.

The approved mockup was read at `673782a4095167aa2c9bff3f2e9aa95caa062aba`. Lumen confirmed the target-question unit, assistant exclusion, local calendar windows, one coalesced stop and a five-sample latency threshold. The response contains aggregates and only the permitted top-agent/owner labels; no message content, per-person figures or room identifiers.

Initial fail-first run: all three original controls failed on the old source (missing endpoint / missing answered_at). The actual SQLite/HTTP/audit tests now cover administrator access, forbidden content reads, query bounds, DST, people dedupe/current-directory sessions, first joins, direct and room answer timestamps/replay, a real two-agent depth loop, rate coalescing/restart, quantiles/unknown failures, and assistant exclusion. Inputs, transport and directory are inert fixtures. Migration controls retain old rows and reject an older registry. No live updater, Fleet, AD or vendor calls, and no browser verdict.

Validation:

- `vitest run tests/hub-admin-dashboard-m3161.test.ts tests/hub-rooms-migration-r1.test.ts tests/hub-room-agents-r2.test.ts tests/hub-room-agent-mentions-3118.test.ts tests/hub-s3b-server.test.ts --maxWorkers=2`: 74/74 at the first integrated head.
- Later affected dashboard + migration controls: 14/14 (overlapping scope), including the additional first-sign-in/current-session and Fleet population cases.
- Final dashboard controls, including timestamp/counter audit rollback and retained counter after room-event removal: 8/8.
- Source and test TypeScript: exit 0. The six isolated mutants also compile together (exit 0); each fails its targeted assertion: administrator gate, room answer timestamp, direct answer timestamp, stop counter, five-answer threshold, viewer calendar day. Originals restored after every case. No repeat mutation/network/browser campaign.

Machine-readable receipt: `validation.json`. API semantics and rollback: `docs/design/hub-admin-dashboard-api.md`.
