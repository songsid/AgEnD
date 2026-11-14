# Hub virtual Team provider (Track C)

The first provider checkpoint implements selected rosters and CRUD. It does not yet add Team ask grants or a Team management page, and is not release-ready.

`src/hub/teams/index.ts` exports `createHubTeams(core): HubTeams`, `HUB_TEAMS_MIGRATION`, `hubTeamReader` and `hubTeamCandidates`. One mounted instance supplies the existing synchronous `read(db,id)`, `expand(db,ids)`, `isMember(db,id,person)` and `candidates(db,prefix)` ports. No imports mount routes or change roles.

CRUD methods return bare values; R owns the HTTP envelopes and route/CSRF handling:

| Method | Service value | HTTP envelope |
|---|---|---|
| list(ctx) | Team[] | {teams} |
| get(ctx,id) | Team | {team} |
| create(ctx,value) | Team | {team} |
| update(ctx,id,value) | Team | {team} |
| remove(ctx,id) | void | {ok:true} |

Wire Team keeps `id`, `name`, `department` (immutable group GUID), `lead` and `members` (canonical person IDs). It adds `revision`, display-only `departmentName`/`leadName`, `canManage` and nullable `leadEligible`. Detail includes `memberInfo` (name/login/department, successful-Hub-sign-in witness and published agents) and the delete impact list. The reader's department remains `{realm,objectGuid}`. Missing/deleted Teams are explicit, not empty successful selections.

Admins create/delete Teams and change names, departments or leads. Current leads edit the selected roster. The lead is always included; a new lead is added in the same write and the former lead remains until removed later. A disabled lead is retained and reported, never automatically replaced. Department is grouping/default-search metadata: people from other departments can join. New selections are freshly checked through the existing physical directory read owner without signing them in or creating Hub person rows.

At most 200 live Teams and 200 selected people per Team. This does not widen a room's existing 100-person union. Room membership and agent invitations expand a snapshot. Team-based creators and later ask grants evaluate current membership. Deletion retains the roster/history while making the reader return missing; explicit room members and existing consent are not removed.

Initial controls use actual SQLite/UOW and Hub session contexts with an inert directory: 9/9 pass, both native TypeScript programs exit0. These are provider controls, not a production HTTP factory/UI walk, a real AD/Fleet run, a fail-first campaign or complete S-144 acceptance. The routes, grant subject integration, UI/skills, parity review and exact CI remain to do. Rollback retains the additive schema and roster history.

## Grant consumer checkpoint

`HUB_TEAM_GRANTS_MIGRATION` is a separate `s3-team-grants` component, applied after the existing grant schema and before Team subjects are offered. It changes only the subject-kind column CHECK, preserving person/group rows, canonical identity, revisions, absolute expiry and child foreign keys. Existing longer grants remain readable; new person/group/Team grants retain the90-day cap. A rollback needs a compatible build that knows the retained schema component.

Team grants are live: the evaluator captures exact current roster revision/membership and rechecks it, the reader/method, durable asker, grant/clock/expiry and the existing operational permit. Owner display/search and group-policy impact observations handle Team subjects without converting members to personal grants. Impact uses known Hub people only. See the bounded grant-checkpoint packet; the full UI/factory acceptance remains outstanding.

The planned UI order is Let colleagues join → Teams → Rooms → Room assistant → Connected fleets. A lead gets My teams in the shared desktop/phone drawer, between My shared agents and Invitations, using one roster editor with the admin view. Admins manage metadata; leads only manage members. Department/new-Team feedback is admin-only; existing-roster people feedback is admin/current-lead. The agreed additional service port is suggestions(ctx,unknown), input {kind:'person'|'group',q,teamId?}, returning bare {kind,id,name}[]; R owns GET /teams/candidates → {candidates}. This feedback port is not implemented in this checkpoint.
