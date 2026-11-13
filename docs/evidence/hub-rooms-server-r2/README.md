# Track R2 acceptance

Source checkpoint: `461e92dcc3f0c9a26db7c431adc5b6ea28e56a0b`. Parent R1 is00af7e86e. Framing563769ff7 was published first for C. Dispatcher source9b2d83c64 follows it; a plain merge6258a1146 brings the R1 feature-inventory repair without changing R2 product blobs. The final fixture commit adds the machine-dispatch feature only to the two exact http.features expectations. `acceptance.json` binds every own changed path, without user data or credential material.

Three pinned TLS/WSS framing assertions and six HTTP agent-member assertions failed before their implementation. Later focused controls cover @all deduplication, stable replay, one answer plus ACK retries, 24-hour expiry, pause/resume, removal/rejoin retirement, person-only mentions, required-audit rollback, other-owner refusal, portable presence, and newest30 context plus one older reply anchor. Migration controls preserve existing fields and refuse an old registry. A fast-answer control commits an answer during the actual transport.send callback, proving dispatch intent precedes the write.

The actual routing fixture composes production Hub HTTP/SQLite with the real pinned TLS/WSS server/client. It reconnects after retaining one synthetic input, receives the exact same room.ask bytes/ID, loses the committed answer's first ACK, reconnects again, and retries the exact answer. It observes one inert input identity and one room answer. No agent/CLI is run.

Latest41/41 in five suites after the plain R1 sync. Earlier206/206 across ten includes direct-chat, actual factory and quick-pairing controls; the later additions/corrections have focused final17/17 and15/15 scopes. Counts overlap. Both native source/test programs exit0 on the final code and test bodies; only exact feature string-array expectations change in the later sync.458 changelog fragments and whitespace validation pass.

Commands (nice10, load<10):

```sh
nice -n10 node_modules/.bin/vitest run tests/hub-room-routing-network-r2.test.ts tests/hub-room-agents-r2.test.ts tests/hub-room-link-r2.test.ts tests/hub-room-frames-r1.test.ts tests/hub-rooms-r1.test.ts tests/hub-rooms-migration-r1.test.ts tests/hub-s3b-server.test.ts tests/hub-network.test.ts tests/hub-compose.test.ts tests/hub-quick-pairing-http.test.ts --maxWorkers=2
nice -n10 node_modules/.bin/vitest run tests/hub-groups-mount-s89.test.ts tests/hub-room-agents-r2.test.ts tests/hub-room-routing-network-r2.test.ts tests/hub-room-link-r2.test.ts tests/hub-rooms-migration-r1.test.ts --maxWorkers=2
GOMAXPROCS=2 nice -n10 node_modules/.bin/tsc --noEmit
GOMAXPROCS=2 nice -n10 node_modules/.bin/tsc --noEmit -p tsconfig.test.json
node scripts/changelog-assemble.mjs --check
```

The directory, encrypted-content facade and agent executor are inert owned ports; real production content still uses the existing encrypted store. No browser/PNG, vendor, live account/Fleet/AD or host-lifecycle claim. No optional mutation campaign/gate is required under the pilot rule. The production TrackC adapter integration, invitations/teams/assistant/creator/admin routes and complete joined UI walkthrough follow. This packet is not full TrackR acceptance.

Rollback deploys a compatible corrected build; older binaries refuse s3-room-agents. Keep the DB, content keys and retained answer/input history.

## Ordinary review R1

Current source checkpoint: `7df4c2a851f37c7ef0b3917cb065a51d9c3054a5`. Two new assertions first failed:120 offline retained deliveries caused38,394 SQL preparations across60 simulated seconds, and a late answer crossed a newer member's hidden-question floor. Event-driven dispatch now leaves offline work on its earliest indexed expiry only; live transient failures retry at30 seconds. Global expiry reads only due rows, while validity scans are scoped by room or changed Fleet/exposure. The bound is now fewer than20 SQL preparations in that same simulated minute. It is a deterministic query-count regression, not a live load/performance claim.

History, last-message/unread and SSE all filter late answers by their original question's join floor. The test opens the new member's real SSE stream, completes the old answer, then receives their own new marker and proves the old answer was not disclosed. Existing members retain late-answer unread.

Latest54/54 across five suites above, plus fresh native source/test programs exit0. This supersedes the prior source/fixture digests for the changed paths; earlier outcomes retain their stated historical scopes. No extra security or mutation gate was added.


## Same-link refusal recovery and final alpha sync

Source checkpoint `8598a330a61fb28bb1366e140dd1ba04fb041c49`, containing plain merge of alpha `440e613d9` after R1 merged. The new fail-first case observed only one ask after its same-link 30-second retry deadline. The Fleet's bounded local refusal keeps its link, so reconnect-only dispatch could strand that ask. A registered additive `s3-room-retry` migration adds `last_sent_at` without rewriting the issued delivery. A current live link retries due work with the same frozen payload and ID; a new epoch can resend immediately. The issued epoch remains recorded for an in-flight answer. No negative ACK or new wire frame is added.

Controls prove no early resend at29,999ms, exact retry at30,000ms on the same link, timer-only progress without another state event, cessation after consent removal, and one committed answer with exact ACK retries. The existing120-offline query-count bound still passes. The actual pinned TLS/WSS routing control retains its reconnect and lost-answer-ACK behavior. Final197/197 in9 suites pass after the alpha merge. Earlier40/5 and18/1 retry runs overlap this scope; do not sum them. Both native source/test programs exit0 and459 changelog fragments validate after this sync.

`retry-sync.json` records nine conflict resolutions, each retaining the R2 image because the incoming image equals the approved R1 source. All21 own delta paths,7 incoming-only paths and13,335 unchanged paths match expected Git blobs and modes at this source checkpoint. Subsequent packet edits are evidence only. Ordinary review and fresh exact-head CI remain required; coordinator alone merges. TrackC composition consumes this public fix separately. No real Fleet, directory, account, CLI or browser run is claimed.

Rollback uses a compatible corrected build; a pre-retry registry refuses this component. Retain the Hub DB, content keys, issued payloads and frozen answer history.
