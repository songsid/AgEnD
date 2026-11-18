# Room owner requests

M-3341 implements [the approved manager and owner flow](hub-room-ask-owner-for-agent.md). The standard HTTP migration registry installs the request schema, and the server factory composes both sides with protected retention. No Fleet notification forwarding is mounted.

## Optional composition

After applying `HUB_ROOM_AGENT_REQUESTS_MIGRATION`, supply `roomAgentRequests(core, host)` through the HTTP dependencies. Only that composition offers the browser feature `room-owner-requests-v1`. There is no member hello capability or member frame change.

An unarchived group-room detail adds `settings.ownerAgentRequests: true` and `agentRequests: {requests, next}` for its current managers. Other members receive neither. UI controls require this field and the client method. An older or explicitly reduced HTTP composition without the service keeps these routes at 404 and omits the feature.

## API

All calls require a current person session; writes also require the existing same-origin CSRF protection. Room-scoped calls require a current room manager. IDs are opaque. Unknown body fields are refused.

| Method and route | Input | Result |
|---|---|---|
| `POST /hub/v1/rooms/:room/agent-requests` | `{owner, note?, idempotencyKey}` | `{request}` |
| `GET /hub/v1/rooms/:room/agent-requests?after=:id` | Optional cursor from that room | `{requests, next}` |
| `DELETE /hub/v1/rooms/:room/agent-requests/:id` | No body | `{ok:true}` |
| `GET /hub/v1/agent-requests?after=:id` | Optional cursor from this owner | `{requests, next}` |
| `GET /hub/v1/agent-requests/:id` | None | `{request, choices}` for the requested owner only |
| `POST /hub/v1/agent-requests/:id/accept` | `{exposureId, revision}` | `{ok:true}` |
| `POST /hub/v1/agent-requests/:id/decline` | `{}` | `{ok:true}` |
| `GET /hub/v1/me/agent-request-settings` | None | `{accepting:boolean}` |
| `PUT /hub/v1/me/agent-request-settings` | `{accepting:boolean}` | `{accepting:boolean}` |

`owner` is the person ID supplied by the existing people picker. Selecting a person does not inspect or reveal their agents. A note is optional, at most 100 characters, and contains no control characters. The caller supplies a UUID idempotency key, retained for an unchanged retry. Reusing that caller's key for different input returns `409 idempotency-conflict`.

A manager summary contains `id`, `owner:{id,name}`, `by:{name}`, `at`, `expiresAt` and `state`. It contains no note, agent ID, agent name, introduction or inventory. Cancelled rows leave the manager's list. An owner acceptance or decline settles the row. Decline reveals no agent inventory to the manager.

An owner pending row adds `kind:'owner-request'`, the current room's disclosure DTO, and `note`. It is private to the requested person. Missing, archived or expired rooms are not actionable. Pages contain at most 100 rows and return an opaque `next` cursor or null.

| Refusal | Meaning |
|---|---|
| `409 owner-not-taking-requests` | This owner has turned off new requests |
| `409 request-open` | A pending request for this owner and room already exists |
| `429 request-limit`, `resetsAt` | The manager has sent five requests in this UTC calendar day |

The UI formats `resetsAt` in the viewer's local time. Accepted sends consume quota atomically with request creation; cancellation does not refund it. Refused opt-out and duplicate sends do not consume it. Requests expire after seven days. An observed expiry is durable. Opting out affects new requests only; existing pending cards and waiting rows retain their state.

State notifications reuse the content-free `invitation.changed` event for the owner and current room managers. Events publish after commit. No question, agent membership, one-to-one grant or member delivery is created by a request.

## Owner actions and compatibility

The owner card is on Invitations and My agents. One eligible shared agent is preselected; several require a choice. Unshared agents are disabled and link to My agents. Acceptance requires the same owner, current published revision, a live pending request and current permission after awaits and at commit. It adds only agent membership in that room: no person membership, publication or one-to-one grant. Repeating the same successful acceptance does not add membership again. Decline is private and idempotent.

Only a client whose session offers `room-owner-requests-v1` sends `/rooms?v=2&ownerRequests=1`. That opt-in includes the owner's unexpired requests in the existing sidebar count. Legacy readers keep the old numeric count and invitation response shape. The owner setting prevents new requests only.

## Protected retention and role cutover

Hints use encrypted `HubContentStore` storage and an audit binding with the requested owner as `ownerAtEvent`. Domain rows store only a content reference and an input digest. A pending hint is checked against its frozen room, owner, digest and creation audit record before supplying retention roots.

The HTTP service exposes a private `retainedContentRefs()` port. The server factory requires it before publishing listeners when the request component is registered. The retention timer passes this provider into `audit.purge` inside its immediate transaction, before any deletion. Pending hints and their audit anchors survive shorter ordinary content/event policies. Expired or settled requests stop protecting them; normal age retention then applies. A missing, replaced or failing provider, malformed root, missing content or mismatched anchor refuses the purge rather than deleting unverified content. The existing event-chain prefix policy is preserved.

Role cutover inventories all three request authority tables only with registered `s3-room-agent-requests` v1. Partial, unregistered-present or future schemas refuse cutover. Request metadata, owner settings and daily counters enter inventory representation v2; hint references, hint-derived digests and ciphertext stay out. Existing unversioned inventories and outer v1 cutover markers remain readable and are never rewritten.

## Upgrade and rollback

The additive `s3-room-agent-requests` v1 migration runs on every upgraded Hub. Take a full Hub backup before upgrading. A hard downgrade to a binary with an older migration registry requires restoring that pre-upgrade backup. Do not delete migration rows or fabricate compatibility rows. Functional rollback uses a compatible binary with the optional service omitted; its feature and routes are absent. Preserve protected retention while any requests remain pending.

A4 findability is separate. A5 remains parked until general notification forwarding is approved; this slice sends no request-only Fleet notification.
