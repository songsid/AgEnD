# Mount virtual Teams in the Hub

The C provider and editor are the parent PR #3886. This R child mounts one service for Team CRUD, static roster suggestions, room candidates, snapshot expansion and live permissions. The production plan registers the Team migrations only after the grant-subject schema; the browser session advertises teams-v1 only with the service. Room detail considers Team grants through the existing authorization path.

The service keeps its current admin/lead business rules. The adapter retains the normal signed-in/CSRF handling and does not mutate the caller dependency object. Other dependency reads stay live through the mount-local prototype.

The new real HTTP regression failed first on the missing route. Six HTTP/SQLite cases plus the sealed production factory case passed. An existing older injected-entry test then caught a missing grant-schema dependency; after correcting the registry, that case and the production Team case both passed. The combined integration source and test typechecks returned zero. Commands and results are in docs/evidence/hub-room-teams-r3 on integration/hub-rooms-rac-u at ab3f26c9e.

The extracted child has the exact stable patch ID of tested R commit 6bdff6d9b. It receives no new local re-verification under decision 5afe2996. Exact-head CI and ordinary review are still required.

S-142 full acceptance remains open. The first real-server Team walk stopped after11checks because the parent editor replaced member names with IDs after a bare PATCH response. That defect and screenshot are retained at integration9d8586fd4; Track C owns its repair. This child does not claim a successful gallery.

The store change is a forward migration. A downgrade needs the pre-upgrade database backup; do not delete Team, grant or room records. Removing the mount does not reverse migrations.
