# Review R1 — bounded failed verification

Finding: each unACKed 30-second Hub replay launched a new npm check on a Fleet whose registry could not verify.
Before repair both fake-clock cases failed: ten replay deliveries caused ten lookups, rather than one.

Repair: retain retry_at and retry_delay in the selected member row. Both missing and unavailable results wait five
minutes, doubling after each failed due check to a four-hour ceiling. Same-revision replay, reconnect and process restart
preserve that deadline. New revision replaces the row and starts immediately; successful verification clears the delay.
The member never ACKs or exposes an unverified value. No local retry timer or updater command was added. The new v1
member migration is still unshipped and now includes those two columns.

- backoff-red.log: 2/2 fake-clock cases fail semantically on pre-repair source (10 lookups vs 1).
- review-r1.log: affected Fleet and server suites 15/15 pass, including doubling, ceiling, replay, reconnect/restart,
  revision reset and all existing verification/persistence cases.
- overview-bound.log: 1 selected pass (5 deselected), with 200 Fleets and one policy read for the whole overview.
- review-native-source.log / review-native-tests.log: both TypeScript 7 programs exit 0.

Also resolves both P3s: overview and own-Fleet list read the setting once per response; notifiedAt accepts that snapshot.
The API document explicitly says the lazy follow-Hub bump can write from GET. API/wire shape is unchanged.
No repeated TLS/WSS, browser, mutation or live-service campaign; prior scopes remain historical evidence.
