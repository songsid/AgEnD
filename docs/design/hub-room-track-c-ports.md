# Track C invitation and team ports

These are type-only contracts for the rooms integration. They add no migration, HTTP route, feature offer or user-visible availability. The member adapter remains a separate slice in PR #3860; factory wiring follows it.

`src/hub/invitations.ts` exports `RoomInvitationHost` and the future `HubRoomInvitations` service. R provides the synchronous host over the DB and transaction supplied by C. C establishes the current person/session, checks manager or exact invitation-owner authority, and performs invitation writes in its own `HubCore.atomic` call. Acceptance checks the exact pending invitation, its seven-day absolute expiry, current room and published exposure owner before calling `addAgentMember(db, tx, roomId, exposureId, owner)`. Membership and consuming that invitation commit together. Only then does C call `changed`; R emits the room/member/invitation events. Pause retains membership. Adding one's own agent directly remains R's existing member route.

The owner pending list, room `invited[]`, cancellation and owner exposure-room DTOs follow the worked #3848 contract and Lumen's seam 3 additions. A physical `memberId` is returned for leaving a room; it is not assumed to equal the roster's projected exposure ID. An expired row stays in the manager list, and re-inviting creates a new invitation. No action may revive an expired or consumed row.

`src/hub/teams/types.ts` exports `HubTeamReader`: `read(db, teamId)` and `expand(db, teamIds)`. R consumes this port instead of defining separate team SQL. Expansion returns exact team revisions, deduplicated explicit person IDs and any missing selections. Department is an immutable AD-group identity and does not imply enumeration of that group's members. These data reads confer no authority; consumers retain live session, eligibility, room, publication and owner checks.

The team writer, team-subject grant evaluation, lead/department management policy and behavior of later roster edits are not implemented by this contract commit. Those product details are being confirmed with Lumen before implementation. No roles helper is activated.
