# Room owner requests

M-3341 A1 implements the manager side of [the approved flow](hub-room-ask-owner-for-agent.md). This slice is optional and unmounted: the standard HTTP migration registry and server factory do not install it. A2 must supply the owner's response UI, retention and composition before activation.

## Optional composition

After applying `HUB_ROOM_AGENT_REQUESTS_MIGRATION`, supply `roomAgentRequests(core, host)` through the HTTP dependencies. Only that composition offers the browser feature `room-owner-requests-v1`. There is no member hello capability or member frame change.

An unarchived group-room detail adds `settings.ownerAgentRequests: true` and `agentRequests: {requests, next}` for its current managers. Other members receive neither. UI controls require this field and the client method. Standard composition keeps the new routes at 404.

## API

All calls require a current person session; writes also require the existing same-origin CSRF protection. Room-scoped calls require a current room manager. IDs are opaque. Unknown body fields are refused.

| Method and route | Input | Result |
|---|---|---|
| `POST /hub/v1/rooms/:room/agent-requests` | `{owner, note?, idempotencyKey}` | `{request}` |
| `GET /hub/v1/rooms/:room/agent-requests?after=:id` | Optional cursor from that room | `{requests, next}` |
| `DELETE /hub/v1/rooms/:room/agent-requests/:id` | No body | `{ok:true}` |
| `GET /hub/v1/agent-requests?after=:id` | Optional cursor from this owner | `{requests, next}` |
| `GET /hub/v1/me/agent-request-settings` | None | `{accepting:boolean}` |
| `PUT /hub/v1/me/agent-request-settings` | `{accepting:boolean}` | `{accepting:boolean}` |

`owner` is the person ID supplied by the existing people picker. Selecting a person does not inspect or reveal their agents. A note is optional, at most 100 characters, and contains no control characters. The caller supplies a UUID idempotency key, retained for an unchanged retry. Reusing that caller's key for different input returns `409 idempotency-conflict`.

A manager summary contains `id`, `owner:{id,name}`, `by:{name}`, `at`, `expiresAt` and `state`. It contains no note, agent ID, agent name, introduction or inventory. Cancelled rows leave the manager's list. A2 will settle accepted/declined rows; A1 handles pending/cancelled/expired.

An owner pending row adds `kind:'owner-request'`, the current room's disclosure DTO, and `note`. It is private to the requested person. Missing, archived or expired rooms are not actionable. Pages contain at most 100 rows and return an opaque `next` cursor or null.

| Refusal | Meaning |
|---|---|
| `409 owner-not-taking-requests` | This owner has turned off new requests |
| `409 request-open` | A pending request for this owner and room already exists |
| `429 request-limit`, `resetsAt` | The manager has sent five requests in this UTC calendar day |

The UI formats `resetsAt` in the viewer's local time. Accepted sends consume quota atomically with request creation; cancellation does not refund it. Refused opt-out and duplicate sends do not consume it. Requests expire after seven days. An observed expiry is durable. Opting out affects new requests only; existing pending cards and waiting rows retain their state.

State notifications reuse the content-free `invitation.changed` event for the owner and current room managers. Events publish after commit. No question, agent membership, one-to-one grant or member delivery is created by a request.

## Mounting requirements for A2

- Add the owner selection, add/decline actions and opted-out setting UI, including Invitations and its sidebar count. An unshared agent cannot be added from the card.
- Register the migration and compose the service only after both sides exist.
- Wire `retainedNoteRefs()` into a generic protected-content retention hook. A seven-day pending request must retain its encrypted hint even when the Hub's ordinary content policy is one day. Check the associated audit-record anchor too; a reference alone does not retain content.
- Review the role cutover inventory version for the new authority tables. Inventory deterministic authority metadata, excluding hint ciphertext and content. Refuse a partially present schema.
- Keep A5 parked until the general notification-forwarding prerequisite is approved. Do not introduce a request-only forwarding transport.

Hints use `HubContentStore` and the audit content binding, with the requested owner as `ownerAtEvent`. Domain rows store a content reference and input digest. Reading a hint checks that it still matches the frozen room/owner/input binding.
