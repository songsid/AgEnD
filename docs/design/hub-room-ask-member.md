# Fleet room-ask adapter (Track C, seam 2)

This slice prepares the Fleet adapter against the worked #3848 rooms fixture and Track R's #3858 frame contract. It is injectable and unmounted: no production client offers `room-ask-v1`, accepts a room ask or starts a publisher because of this slice. Track R R2 supplies socket framing, Hub-side room membership/owner-consent checks and replay; Track C then composes this adapter in the member factory. No direct-question grant or signed envelope is fabricated.

## Contract

`HubRoomAskAdapter` receives an already authenticated current-link room ask. Its persisted shape matches Track R: UUID `messageId`, `roomId`, `exposureId`, `roomName`, `asker.name`, `text`, and `context` with display-name `author`, `text`, `at` and optional literal `repliedTo: true`. Context is the latest 30 rows oldest first, plus an older replied-to row when needed (31 maximum, no duplicate). The Hub constructs this context. `messageId` identifies one agent delivery, rather than the parent person's room message.

`RoomAskOptions` supplies the selected member database, encryption key, immutable Hub issuer/Fleet/owner binding key, a current-binding predicate, the published local exposure/consent/revision/lifecycle-token mapping, and the Fleet's existing representative delivery callback. The prompt names the room and asker in EN or zh-TW, marks member messages as data rather than owner instructions, frames the context/question as JSON, and tells the existing agent to answer through `report_result` to `agend-hub`. All room members can see the answer. It creates no separate agent, model call or asker session.

## Delivery and recovery

- `connected(link)` selects the current link. Both `welcome-caps-v1` and `room-ask-v1` must be negotiated. It does not authorize locally retained queued work.
- `accept(ask, link)` stores or verifies the exact payload and returns synchronously. Agent delivery runs separately from socket control/ACK processing.
- The ordinary Fleet delivery callback receives `stillCurrent` and `beforeInput`. The latter persists a first-input intent and rechecks the exact link, binding, exposure, consent, revision and agent token. It succeeds once.
- An interrupted input is held and never automatically sent again. A report from the same current agent can finish a held question. A queued question without input requires the Hub to redeliver it on the current link after fresh room membership, consent and publication checks.
- `report(...)` returns `null` for another adapter's correlation/agent, allowing composition to preserve the existing direct-question report handler. Room answers are text only in this phase; files, buttons and polls are refused explicitly.
- The answer ID and bytes are encrypted and committed before `sendAnswer`. `flush()` sends the same `{messageId, roomId, exposureId, answerId, text}` until `acknowledge({messageId, answerId}, currentLink)` commits the exact ACK. An ACK received during send cannot be overwritten by delivery completion. Reconnect retries the frozen answer without another first input.
- Question payloads, context and answers use authenticated encryption in the selected member DB. Correlation/message IDs and state are routing metadata. Binding mismatch, an unreadable key or corrupt ciphertext refuses recovery; no empty-history fallback is created.
- `close()` fences later work, including delivery/send callbacks that settle after the database has closed. Persisted input intent and frozen answers remain for recovery. This adapter owns no interval, socket or process.

The guarantees here cover ordinary process interruption, reconnect and exact replay. They do not introduce a new database-rollback protocol or room authorization lease. The Hub remains authoritative for current room membership and destination selection.

## Presence and composition

`createRoomStatePublisher` reads the Fleet's actual process/execution state. It maps to `idle`, `working` or `paused`, with a stable `reason` code instead of Fleet-localized display text. The agreed optional union is `quota | auth | approval | update | operator | idle | capacity | error | stopped | crashed | stuck | unknown`. C normalizes stopped and crashed to `stopped`, exports no crash detail, and maps wakeable idle/warm-cap sleep to `idle`. Approval requires a positive runtime observation. It exports no detailed activity. Simultaneous refreshes coalesce, unchanged readings send nothing, and a new negotiated link receives a baseline. Held reads recheck the current link and exposure before disclosure.

Track R projects `reason` as `presenceReason` on HTTP members and presence events; `presenceNote` remains only a supplied legacy/display fallback. The room viewer translates codes and falls back to plain Paused for an unknown code. Lumen's UX mapping at `d58564ddc` distinguishes grey Stopped/已停止 (process stopped on a reachable Fleet) from grey Offline/離線 (unreachable Fleet), and keeps quota/auth/approval/operator pauses yellow. Stopped questions queue as later replies. Wakeable sleep is green Idle. Ridge owns this projection and Muse owns the room presentation; this preparation PR does not activate it.

R2 integration must register `HUB_ROOM_ASK_MIGRATION` in the selected member set, instantiate the adapter using that set's key and immutable binding, multiplex its report handler with the direct representative handler, and route `room.ask` outside the socket control queue. The exact `room.answer-ack` is processed on the current link. The host schedules `flush` and presence refreshes and tears them down with the member. Only this complete wiring may opt into `room-ask-v1`. Old members remain unoffered and the Hub shows the update-needed state. Permanent sharing stops, owner pause, independent holds and room consent remain separate checks.

This unmounted preparation changes no browser asset or currently available user flow, so the current Hub skill and PNG gallery remain unchanged. The composition PR must update available-feature guidance and capture its user-visible behavior. Invitations, own-agent joins, virtual teams, the room assistant and roles are separate slices.
