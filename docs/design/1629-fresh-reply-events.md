# Fresh reply observations (#1629 B2)

This connects host-side observations, not product effect mounting. After recording
and broadcasting an explicit `role: agent` message, the fleet emits a separate
`agent_reply_live` SSE frame: `{ v: 1, boot, id, instance }`. It has no SSE cursor,
is not recorded, and is absent from history, polling and reconnect replay.
Status/user/unknown-role messages and sender names do not qualify. Existing
message frames, ids, persistence and polling/replay behavior remain unchanged.

This internal host receipt is not an effect event. It contains only the identity
needed to correlate an accepted message. A future mounted Chat owner publishes
`reply` with empty fields and its bound instance; boot/id never enter the Worker.
No reply text, author, attachments, targets, URL or other message content reaches
the effect API. The same fleet reply may be observed by signed-in local viewers;
this signal does not identify or privilege the person who prompted the reply.

## Client acceptance

The transport labels message ingress as SSE or poll and records the host monotonic
SSE arrival time at callback entry, after stale-source rejection and before JSON
parsing or synchronous connection/hydration observers. Catch-up preserves that
original metadata and ordering. Receipt
frames never advance the message cursor. A receipt-like JSON field in a poll is
ignored. Old/disposed EventSources retain the existing generation rejection.

Before merging a message, the Chat store records its boot/id watermark, including
history and polling. A live receipt needs a newly accepted SSE agent message with
the exact boot/id/instance, correct order and an original arrival no older than
five seconds. The receipt must itself be fresh. A duplicate, replay-only,
history-only, poll-only, unknown, mismatched or stale receipt creates no pulse.
Replayed messages cannot manufacture receipts. A new boot may reuse an id.

Watermarks survive the 500-message display buffer. They use at most 64 boots for
this page; exhaustion or an invalid/backward host clock disables further reply
observations until reload. At most 64 unpaired candidates are retained, with old
candidates discarded while their dedup watermarks remain. Thus a reconnect replay
burst cannot disable subsequent genuinely live replies or resurrect an old id.
Five-second freshness is conservative: a reply delivered only through polling,
catch-up, a buffered proxy or a long blocked main thread may produce no pulse.
The chat message still displays normally; effects are optional decoration.

The host subscription is lazy, removable, content-free and does not replay to
late listeners. Receipts are consumed before callbacks; callback errors/reentry
cannot duplicate a pulse or suppress another captured observer. A mounted adapter
must subscribe under its current Chat/session lease and unsubscribe on teardown.
This change grants no frame ownership or permission, and adds no browser fetch.

## Mention is reserved

`mention` stays valid in the manifest/codec for compatibility but the registry
and independent frame send gate refuse it in 2.3.0. Never infer it by parsing
text. Provider-confirmed direct-ID, viewer-scoped boolean signals are a separate
2.3.x follow-up: [#1963](https://github.com/songsid/AgEnD/issues/1963).

## Evidence and rollback

Tests use the actual fleet emitter, history/poll/replay handlers without starting
a fleet or network listener, the actual transport/store, inert EventSource/fetch,
and controlled monotonic clocks. Existing auth, cursor and message tests remain.
No account, service, default tmux or native browser probe is required for this
non-rendering slice. Remove the additive receipt, subscription and host adapter
together to roll back; preserve message replay/poll and server authorization.
