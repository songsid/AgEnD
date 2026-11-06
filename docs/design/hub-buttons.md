# Hub answer buttons and polls (P1)

This implements chat-app slice F from [#3226](https://github.com/songsid/AgEnD/issues/3226#issuecomment-6686923845), using the shared thread renderer and the existing reply-button/poll validators. P1 rooms have one asker. An owner or administrator can choose only when that person is the room's granted asker; their role provides no bypass.

A representative calls `report_result` on its live Hub correlation with `buttons` and optional `poll`, using the reply tool's field shapes. D owns that schema. F parses these extras and snapshots their normalized values before any file transfer or release-authorization await. The answer carries a random set ID, labels, values and poll settings. A domain-separated digest of all these fields composes with D's answer-content digest, so the existing exact release lease covers them. Without extras, the legacy text digest stays unchanged.

`buttons-v1` is optional and must be negotiated by both peers. An unsupported Hub receives neither metadata nor a release attempt; the representative gets an explicit text-only retry on the same correlation. Loss or replacement of the captured link after release begins holds the answer under the existing uncertainty rules. There is no automatic text downgrade or replay.

## Choosing and voting

`POST /hub/v1/rooms/:id/buttons` accepts `{setId, index, idempotencyKey}` for a button or `{setId, options, idempotencyKey}` for a poll. It uses the normal Hub origin, session and CSRF checks. Before committing, it rechecks current asker and owner eligibility, the exact room/source answer, current ownership, exposure revision, grant revision and grant applicability. A delayed ballot cannot overwrite a newer committed ballot. Current authorization is required even for a duplicate operation.

The choice transition, ordinary question, operation receipt and audit commit in one transaction. A button queues the shared `replyButtonClickText` form, for example `[button] Yes (value: yes)`. Repeating the same operation returns its exact receipt. Reusing the key for another selection or answer conflicts. The question uses the same insertion, authorization, delivery and cap path as a typed ask; a button does not create an execution or local-authority bypass.

A single-choice poll closes on the sole asker's vote and queues one `[poll results]` question. A multiple-choice poll keeps the latest complete ballot until its deadline; option clicks toggle that ballot, including an empty ballot. There is no new Vote control. Poll settings, options and result formatting reuse the reply models.

Deadline processing closes due polls durably and arms the next deadline before waiting for directory checks or other results. Restart recovers owed results. The automated continuation is bound to the original room, answer, asker, owner, grant and exposure, and rechecks them before queuing. It uses audit actor `local-host`, never a fabricated directory session or human receipt. Unavailable eligibility holds; revoked or superseded authority cancels. Failed storage/audit backs off without claiming admission. Retention makes removed content inert. Closing the service fences work synchronously and drains its owned pending eligibility work.

## Storage and browser seam

Migration `s8-buttons/1` stores source identities, revisions, state and operation receipts in the shared private Hub DB. Choice metadata lives inside the answer's existing encrypted content record. Ballots are encrypted content too, bound to set, room, source message and voter; option values and display names are not copied into plaintext button tables. Audits retain the usual source/grant references.

Messages retain string `question` and `answer` fields. A sibling `buttons` uses the fleet's `ReplyButtonsView`, so the shared `createThread` draws unchanged markup. B's `hubEntryToMessages` passes it through. `createHubButtonActions(room, {client, entries, refresh, changed})` supplies B's `clickButton`, `vote`, `busy` and `mine` bodies; `stop()` fences late replies. `client.chooseButtons` uses the existing CSRF-aware Hub client. Unknown network outcomes retain the same operation key and exact payload in memory and room-scoped session storage; a different intent is refused until that outcome is resolved. The browser never supplies the asker or grant.

This seam does not add another chat store or panel. The server/member path and shared-renderer proof can be tested independently; full Hub-store/panel integration depends on B.

## Authority and proof boundaries

The approved [Hub design](hub.md) says: “Hub identity; external data; no local human authority.” A choice is another authenticated Hub question, not a release/delete approval, imported forward or `web-verified` receipt. Member pairing proves a fleet's identity; it does not grant its agent fleet-admin authority.

Acceptance covers current/old-peer capability intersections over real loopback TLS/WSS; exact metadata release and source binding; requester/owner/admin boundaries; CSRF; operation races and retries; deadline/restart/revocation/storage failure; encrypted content; and browser actions. The isolated mock CLI rehearsal uses a real Codex session and MCP `report_result` with production admission, journal, representative and Hub HTTP code. Its directory, lifecycle and member transport are inert adapters; it does not claim a full fleet, Windows pane or signed-in provider run.
