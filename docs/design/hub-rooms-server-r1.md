# Hub rooms server: first slice

Track R follows `hub-rooms-split.md` at 08ca97d67, `hub-rooms-ux.md` at e9b189c6f and the worked fixture in #3848 at f474423f. This slice mounts people-only group rooms and advertises `rooms-v1`. The existing direct-chat service remains responsible for grants, authorization, agent delivery, answers and receipts.

## Available

- Create/list/get group rooms; the configured administrator creates rooms in this slice.
- Add known eligible Hub people, leave/remove a member, promote or demote a manager, and refuse removal of the last manager.
- Rename/archive, control member `@all`, and select history for new members. A since-join cutoff is saved for each membership; leaving and rejoining creates a new cutoff.
- Encrypted text, replies, per-person idempotency, newest-last paging and persistent unread markers. A removed member cannot read later messages or recover earlier history through a stale idempotency key.
- One named SSE stream, current-viewer projections and explicit removal events. Slow readers have a bounded queue; closing the HTTP mount closes its streams.
- Direct-chat detail/messages projections and live message/unread events alongside the old `entries`, `room` and `receipt` shapes. Direct authorization remains in the existing service.

The additive `s3-rooms` migration creates separate group tables and direct read markers. It neither rewrites nor resets direct rooms, messages or grants. The normal migration registry refuses an older binary after this component is installed. Rollback means deploying a corrected build that understands this migration; do not delete retained room state to run an older binary.

## Following slices

Room creator assignments, teams/groups, owner invitations, room agents, room assistant calls and group attachments are not mounted in R1. The picker currently returns known Hub people only. Agent routing, reconnect retry and presence are R2 with Track C; administration and the remaining creation/invitation integrations follow. The optional assistant port is structural and absent by default.

`room.ask`, `room.answer`, `room.answer-ack` and `agent.state` schemas/types are reserved for Track C's injectable adapter. `room-ask-v1` is deliberately not advertised before dispatch is composed. A room delivery ID is unique per agent target, independent of its parent person message. The answer is retained and retried until an exact messageId/answerId ACK. Context is the latest 30 oldest-first rows, with at most one older replied-to row marked `repliedTo: true` (31 total).

No custom-role activation is part of rooms. No real directory, account, Fleet, CLI execution or browser campaign is needed for this API slice.
