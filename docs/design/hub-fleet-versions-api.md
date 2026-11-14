# Fleet version reports, phase 1 — M-3136 / M-3137

`GET /hub/v1/admin/overview` retains `fleets` and `pairings`. Each Fleet adds:

- `version: string | null`
- `runsAsService: boolean | null`
- `versionReportedAt: number | null` (Hub UTC milliseconds)
- `lastConnectedAt: number | null` (last authenticated hello)
- `connected: boolean` (this mount's current link)
- `versionState: "too-old-rooms" | "needs-update" | "unknown" | "current"`

Top-level `recommendedVersion: string | null` is null in phase 1. Summary counts include active Fleets only;
every state except `current` needs attention. Missing `welcome-caps-v1` or `room-ask-v1` wins, followed by a version
below the recommendation, an unknown version, and current. Never connected means no capability observation, hence unknown.
Last report and negotiated capabilities survive a disconnect or Hub restart; connected never persists.

`GET /hub/v1/me/fleets` requires a current eligible person and returns `{ fleets: [{ id, label, version, versionState }] }`.
It includes all and only that person's active Fleets. Label can be null; the UI uses its unnamed-Fleet copy.
No query parameters. The admin overview remains admin-only. Neither endpoint changes an update setting or sends a notice.

The room member's `owner.name` remains present with `presenceReason: "update"`; no room projection change is needed.

## Compatible transport

The Hub alone advertises `fleet-info-v1` in its welcome when the report store is mounted. It is a receiver offer,
not a mutually negotiated operation: the member's hello remains at 16 names and does not add this name. Both sides
still require `welcome-caps-v1`. A reporting member sends `fleet.info { version, runsAsService }` before reconciliation
only when that welcome offered it. Older Hubs see neither new hello fields nor a new frame. Older members ignore
the unknown Hub capability. Version is a bounded exact SemVer value; the Fleet chooses no owner, Fleet ID or timestamp.
The Hub authenticates those from the current link and its own clock.

The mounted runtime supplies its package version and service mode using the existing service-manager detection
(the current Linux cgroup or launchd context, rather than whether a service is merely installed).

`s3-fleet-versions` is an additive diagnostic table. It stores no credentials and changes no authorization floor.
Rollback disables the reporting offer and routes; retaining the table needs a binary that understands the migration.
An older binary must refuse that newer schema, so an actual downgrade uses the ordinary pre-upgrade Hub backup.

Diagnostics are best effort: a connection/report storage refusal or failed diagnostic logger cannot stop the
hello/welcome or later ordinary work. Warnings name only Fleet ID and connect/report phase, never raw SQL errors.
If an observation could not be retained, an unknown or older retained diagnostic may remain until the next connection.

`too-old-rooms` describes negotiated room support, not a proven minimum binary version. A current Fleet composed
without a room representative can also lack room-ask-v1 and receive that state in phase 1.
