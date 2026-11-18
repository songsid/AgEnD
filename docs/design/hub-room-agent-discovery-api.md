# Room agent discovery

M-3341 A4 adds the per-agent opt-in from [the approved room-owner flow](hub-room-ask-owner-for-agent.md). It lets room managers find a shared agent and send the existing named invitation. The owner still accepts each invitation. It grants no one-to-one access, direct chat or room membership.

## Owner setting

On My agents, open the agent's access page. **Room managers can find this agent** is off by default. Its visible hint names the disclosure: the agent's name, published introduction and owner's name. The setting is disabled while sharing is paused, while the agent is not shared, or while the owner has turned off new requests.

| Method and route | Body | Result |
|---|---|---|
| `GET /hub/v1/exposures/:id/room-discovery` | None | Current owner's setting |
| `PUT /hub/v1/exposures/:id/room-discovery` | `{findable:boolean, ifRevision:number, exposureRevision:number}` | Saved setting |

The view contains `findable` (saved choice at this publication), `available`, `revision` (preference revision), `exposureRevision`, and an optional reason: `paused`, `not-shared` or `owner-disabled`. IDs, owner identity and publication state come from the server. Reads require a current owner session; writes also require the ordinary same-origin CSRF protection. Unknown fields are refused. Stale publication/preference revisions return conflict. A disabled setting cannot be changed. Permission, publication, preference and owner opt-out are checked again after awaits and at commit. The audit contains metadata only.

Pause hides discovery and retains its saved value. Resume restores that value. Stopping sharing and sharing again at a new publication revision defaults to off. The owner's **Don't let room managers ask me for agents** suppresses discovery and disables the switch while retaining its saved value. Turning that opt-out off restores it. Ordinary invitations for agents the manager can already ask remain unchanged.

## Room-only visibility

The session/browser feature is `room-agent-discovery-v1`, offered only when its schema and routes are available. A supporting client adds `discovery=1` to agent-picker calls. Older picker readers keep their existing rows. No member hello or frame changes.

`HubCatalogService.withRoomVisible` returns a separate `findable` collection. The default catalog and its `askable` collection do not contain discovered agents. Picker and invitation/team expansion consume the same current visibility transaction. The switch, its preference revision, owner opt-out revision, publication/owner, Fleet and group-permission proofs enclose both disclosure and invitation effects. An off/on race cannot revive an old selection.

A non-askable findable row has `discoverable:true`, its public name/owner/introduction and **Ask {owner}**. An already askable row keeps its current action. Choosing either sends the existing named invitation and uses its existing waiting row. Hidden explicit IDs remain generic not-found. Team expansion silently filters hidden agents without omitted counts or per-owner results.

Turning discovery off blocks new discovery-only invitations. Existing pending invitations remain answerable, and existing room members stay. Named invitations retain their existing seven-day expiry, pending deduplication by room/agent/owner and batch bound of 64. No daily quota is added here. A5 Fleet forwarding remains parked.

## Migration, inventory and rollback

The additive `s3-room-agent-discovery` v1 migration appends a metadata table to the normal HTTP registry. It binds a saved choice to an immutable exposure ID, owner and publication revision and has its own monotonic preference revision. It contains no question, answer or private inventory content.

Role cutover captures the registered discovery authority table in the existing metadata inventory representation v2. Missing, unregistered-present, unkeyed or unsupported schemas fail closed. Historical unversioned and v2 marker bytes remain unchanged; neither the outer marker nor role migration registry changes.

Take a full Hub backup before upgrading. A hard downgrade to a binary with an older registry requires restoring that pre-upgrade backup. Do not remove migration rows or fabricate compatibility rows. A compatible rollback build must suppress the room-discovery visibility mode and its public controls together while preserving existing room/invitation data and A2's pending-hint protection.
