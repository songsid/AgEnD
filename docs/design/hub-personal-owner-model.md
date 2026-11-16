## Scope

M-3224 layer 3 supplies the owner/enrollment model and computer readiness facts. It does not mount a Hub route,
register the migration, start a turn, advertise a browser feature or offer a personal agent in the UI. The host/UI
mount remains held for the exact x64 Windows proof requested by the product owner.

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

`HUB_PERSONAL_AGENTS_MIGRATION` is deliberately unregistered. Its source discriminator leaves existing Fleet rows
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
