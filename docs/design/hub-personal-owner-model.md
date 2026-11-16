## Scope

M-3224 layer 3 supplies the owner/enrollment model and computer readiness facts. It does not itself mount a Hub
route, register a migration or start a turn. The later host layer composes these primitives after the owned x64
proof; `hub-personal-host.md` describes that registration and its actual Windows/CLI coverage.

## Model API

`HubPersonalOwnerHost(core, runtime)` uses the company person from the request context. Settings require
`management("hub.admin")`; enrollment, view and publication accept no owner or computer identity from a caller.

- `settings(ctx, {enabled, people, teams})`: off by default; administrator-selected creation permissions.
- `enrollment(ctx, {})`: a 15-minute token, superseding only that owner's unused tokens. A failed Hub audit revokes
  the unreturned token. Durable consumed enrollment identity recovers the owner/computer binding after a restart.
- `view(ctx)`: only that person's computer. A CLI is available only when its own local enforcement probe says ready,
  it is runnable and signed in, and the runner offers the dedicated personal profile. Versions never imply readiness.
- `publish(ctx, {name, description, cli, model?, ifRevision})`: one personal definition and exposure per owner. A
  changed definition advances the exposure revision, so existing revision-bound grants do not silently widen.

At the foundation checkpoint `HUB_PERSONAL_AGENTS_MIGRATION` was deliberately unregistered; the later host layer
registers it after the owned proof. Its source discriminator leaves existing Fleet rows
and incoming foreign keys intact. Personal exposures have no Fleet id, data view, policy digest or Fleet tool list.
The member snapshot schema remains Fleet-only. Fleet execution paths refuse personal sources until a dedicated
adapter is composed. The owner/catalog primitive alone cannot execute them.

The Runtime's `--personal-folder` binding is local, survives restart, and cannot convert a paired ordinary profile.
Personal discovery checks an empty authentication stage; ordinary local CLI sign-in detection is separate. Codex's
sandbox result is independent of Claude's eligibility. The selected account is staged only for an actual turn.

## Validation and limits

The retained-row migration tests cover existing grants, rooms and quota references, foreign-key integrity, repeated
migration and disjoint NULL shapes. Owner tests cover private ownership, newest consumed enrollment, source revision,
readiness, atomic publication and audit compensation. Existing Fleet publication and direct-chat suites remain green.
Source and test type programs pass at the recorded layer checkpoint.

No x64 Windows execution, model turn, user authentication, browser or host/UI mount is claimed by this layer. The
approved worker's ARM64 evidence remains scoped to #4046. Rollback omits the new model/factory and personal CLI mode;
no registered Hub schema or existing Fleet connection is changed by mounting this layer alone.

## Before a rollback after registration

Once a later layer registers this migration and creates personal rows, an older Hub binary is not a safe rollback.
Its readers assume non-null Fleet metadata, and its migration plan does not recognize the new component. Withdrawing
a personal exposure is insufficient: retained rooms, messages and group members can still reference it.

For a functional rollback, disable personal admission and retain a binary that understands the new schema. Before a
hard downgrade, stop the personal Runtime connections and physically running turns, then back up the complete Hub
database, encrypted content/audit state and Runtime journal together. The currently supported hard-downgrade path is
to restore a verified backup taken **before registration**, using that backup's matching binary and keys.

Preserving later history during a hard downgrade needs a separately tested offline cleanup. It must remove personal
jobs, their direct/group messages and dependent attachments/buttons/read markers, personal room membership and
consent/grant/resource references, and finally personal exposures/definitions/enrollment bindings, in foreign-key
order. It must also remove the new schema through a reviewed export/rebuild; deleting migration markers or inventing
Fleet metadata does not restore the old schema. Verify foreign keys and old-binary catalog, room, dashboard and
revoke reads on a copy before using the cleaned database. This slice supplies no such cleanup tool, so do not attempt
that path on a live database. A pre-registration backup is required before the composing layer enables the feature.
