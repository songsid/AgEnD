# Receipt instruction lifetime

Leader chose a fixed 24-hour window measured from the delivered receipt, with several follow-ups allowed inside it. New sends at or after the boundary refuse with a short request to ask the owner again. Receipt authority remains separately current; cached accepted results and answer delivery do not depend on freshness.

One new boundary test uses real stored delivery receipts and the production Fleet adapter with an inert current link/notification handoff. It proves two posts just before 24 hours, refusal at and after 24 hours without a send, retained cached success and a delivered/ACKed answer after expiry. It does not claim live Fleet input or a new network journey.

- Before runtime change: selected test fails semantically because the new post succeeds at 24 hours; three other receipt cases deselected.
- After runtime change: `npx vitest run tests/hub-room-post-receipt.test.ts tests/hub-room-post-fleet.test.ts --maxWorkers=2` passes 19/19.
- No new mutation, native, browser or TLS/WSS campaign. Earlier evidence remains bound to its recorded stage.

Ridge owns the separate combined actual MCP/WSS/HTTP journey. It passed on R b4ca46b8 + C d9fd3dd1 at integration 0c01c30d3, before this lifetime delta; see the R integration packet. The current boundary test supplies the new lifetime coverage.

Rollback: remove the freshness admission check/constant, keeping encrypted post and answer journals. Already accepted posts are retained in either case.

## Lost-result retry correction

Fable found that the initial freshness check incorrectly denied an existing durable intent after 24 hours when its original result was lost. The same boundary test now prepares that intent inside the window, observes an uncertain result, and retries its exact operation/body/receipt after expiry. The committed result is returned; fresh operations at/after expiry remain refused. Current authority and consent still fence every call.

`retry-before.log` is the semantic red on the initial window implementation (denied instead of the committed result); `retry-after.log` is 19/19 for the same two affected suites after limiting the freshness checks to new intents. `retry-bindings.json` pins this later source/test delta. The earlier before/after logs and bindings remain historical to the initial window stage. No new network/native/mutation/browser campaign.
