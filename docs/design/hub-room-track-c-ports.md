# Track C invitation and team ports

These are type-only contracts for the rooms integration. They add no migration, HTTP route, feature offer or user-visible availability. The member adapter remains a separate slice in PR #3860; factory wiring follows it.

`src/hub/invitations.ts` exports `RoomInvitationHost` and the future `HubRoomInvitations` service. R provides the synchronous host over the DB and transaction supplied by C. C establishes the current person/session, checks manager or exact invitation-owner authority, and performs invitation writes in its own `HubCore.atomic` call. Acceptance checks the exact pending invitation, its seven-day absolute expiry, current room and published exposure owner before calling `addAgentMember(db, tx, roomId, exposureId, owner)`. Membership and consuming that invitation commit together. Only then does C call `changed`; R emits the room/member/invitation events. Pause retains membership. Adding one's own agent directly remains R's existing member route.

The owner pending list, room `invited[]`, cancellation and owner exposure-room DTOs follow the worked #3848 contract and Lumen's seam 3 additions. A physical `memberId` is returned for leaving a room; it is not assumed to equal the roster's projected exposure ID. An expired row stays in the manager list, and re-inviting creates a new invitation. No action may revive an expired or consumed row.

`src/hub/teams/types.ts` exports `HubTeamReader`: `read(db, teamId)` and `expand(db, teamIds)`. R consumes this port instead of defining separate team SQL. Expansion returns exact team revisions, deduplicated explicit person IDs and any missing selections. Department is an immutable AD-group identity and does not imply enumeration of that group's members. These data reads confer no authority; consumers retain live session, eligibility, room, publication and owner checks.

Lumen's product-plan update f87fadf37 distinguishes two consumers: rooms and agent invitations use a point-in-time expansion, while ask grants and room-creation rights check the current roster each time through `isMember(db, teamId, person)`. That read returns the current revision and membership, or null for a missing/deleted team; callers keep their final current-row checks. Department groups only organize teams and default the people search scope; selected members may come from other departments. The lead belongs to the roster. Deleting a team ends live team-based permissions without changing already-expanded room memberships or consented agents.

The team writer, team-subject grant evaluation and management UI are not implemented by this contract commit. No roles helper is activated.

## Team CRUD mount

There is no existing Team CRUD route or separate host beyond `HubTeamReader` and `roomTeamCandidates`. C supplies `createHubTeams(core)` and `HUB_TEAMS_MIGRATION`; R registers the migration before HTTP mount and composes one optional `deps.teams(core)` service. The returned `HubTeams` also implements the existing reader and `candidates(db, prefix)`, so CRUD, room expansion, suggestions and live creator membership share one mounted service over the same Core/DB. An absent factory leaves CRUD unavailable and the existing reader/candidate ports optional.

The service methods are `list(ctx)`, `get(ctx, id)`, `create(ctx, value)`, `update(ctx, id, value)` and `remove(ctx, id)`. `value` is unknown at the route boundary; C owns validation, admin/current-lead rules, transactions and the Team DTO from seam 5. List returns a Team array, get/create/update return one Team, and remove returns void. R wraps responses as follows:

| Method and path | Answer |
|---|---|
| `GET /hub/v1/teams` | `{ teams }` |
| `POST /hub/v1/teams` | `{ team }` |
| `GET /hub/v1/teams/:id` | `{ team }` |
| `PATCH /hub/v1/teams/:id` | `{ team }` |
| `DELETE /hub/v1/teams/:id` | `{ ok: true }` |

R applies the normal signed-in read and mutation CSRF handling and passes the current `HubRequestContext`; C performs the business authorization. No room-manager host or R-owned Team SQL is needed. Team DTO field names stay `id`, `name`, `department`, `lead` and `members` per seam 5; C may also return the stored revision. The existing immutable department identity in `HubTeamSnapshot` and its reader methods stay unchanged.

The Team store's 200-person/200-team bounds do not change the room's 100-person union bound. Room membership and invitations use snapshot expansion; creator rights and team ask grants use the live roster. These notes reserve the mount contract only: no Team factory, CRUD route or UI availability is activated by this documentation.

## Team ask-grant subject

C may add exactly `{ kind: "team"; teamId: string }` to `HubGrant.subject` in R-owned `src/hub/types.ts`, in the same change as C's catalog, grant evaluator, impact inventory and retained-row migration. `teamId` is a canonical UUID, validated at the grant-input boundary. Landing the union with its consumers avoids an intermediate type error in code that currently treats every non-person subject as an AD group. R will not make a competing edit to that union.

There is no signed grant schema in `src/hub/protocol.ts` at this checkpoint. Grants are Hub catalog records; the issuer-signed asker envelope carries `grantId` and `grantRevision`, and the existing authorization path checks the current grant. No new subject field, signature format, capability or frame is needed for a team subject. C owns the existing grant-input schema in `catalog.ts`.

New grants retain the 90-day maximum, and retained rows keep their recorded expiries. C's compatible migration must preserve existing person/group grants rather than editing the historical migration. This file-ownership exception reserves the type change only; team-grant availability follows the tested consumer and migration implementation.
