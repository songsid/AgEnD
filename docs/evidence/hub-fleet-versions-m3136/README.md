# M-3136 — Fleet version reporting, phase 1

The link used to report only protocol/capability names. The admin overview had no version, service mode or live/last
connection diagnostic. This slice adds the compatible value report and additive diagnostic storage; API names were
settled directly with the M-3137 UI owner in `docs/design/hub-fleet-versions-api.md`.

## Verification

- Fail first: the new real HTTP/SQLite overview regression fails on the unmodified base because recommendedVersion
  and the per-Fleet diagnostic fields are absent (`before.log`).
- Protocol, state and HTTP: 35/35 (`focused.log`). Covers SemVer priority, bounded values, retained reports across
  restart, stale link/owner guards, and own-Fleet-only access.
- Final affected fence cases: 3/3 (`fences.log`), adding revoked Fleet and ineligible owner refusals.
- One composition/TLS packet: 146/146 in three files (`composition.log`): the new old/new-Hub reporting cases,
  `hub-compose-member`, and `hub-compose`. This includes a full 16-name member offer with no reporting name added.
- Both native TypeScript programs exit 0 (`tsc --noEmit`, `tsc --noEmit -p tsconfig.test.json`).

Commands use `node_modules/.bin/vitest run <files> --maxWorkers=2`. The schema/HTTP cases use an owned SQLite store
and inert directory/transport; the transport cases use locally owned pinned TLS/WSS only. No live Fleet, AD, vendor,
browser, updater or service-manager mutation was exercised. No repeated heavy campaign.

An initial development import cycle (protocol → reporting store → identity → protocol) was caught by the isolated
schema test and removed by keeping the pure wire model in fleet-info.ts. Only the corrected final results are claimed.
The earlier migration/reaction regression pass (18 cases) is separate from the final 35-case packet, not added twice.

## Scope, limits and rollback

Phase 1 never configures a recommendation or updates a Fleet. Recommended version stays null. The Hub retains
self-reported version/service values and negotiated room capabilities; those diagnostics grant no authority. A
never-connected Fleet has no capability observation and is unknown. Older Hubs receive no new fields/frame; older
Fleets remain connectable and do not need to report.

The additive s3-fleet-versions schema is registered in the ordinary HTTP migration plan. Rolling back the feature
removes the report offer/codec/API wiring; a downgrade to an older binary follows the ordinary backup restore because
older migration registries correctly refuse the newer component. No authorization rows/floors are rewritten.

## Review correction: best-effort diagnostic writes

Fable found that throwing connection/report hooks could end the link. Two new regressions fail first on 7015e369:
hello/welcome fails when the connection hook throws (`resilience-before.log`), and ordinary reconciliation fails
when the optional connection INSERT is refused by a SQLite trigger (`upsert-before.log`).

Connection observation and fleet.info handling now isolate diagnostic failures and emit a bounded warning with
only Fleet ID and phase. The ordinary handshake/reconciliation/authorization paths keep their existing refusals.
The affected HTTP plus owned loopback TLS cases pass 5/5 (`resilience-after.log`), including a second successful
reconciliation after both hooks failed. State/schema/logger cases pass 4/4 (`state-r2.log`); a throwing diagnostic
logger also cannot affect the link. Both TypeScript programs pass. This is the review-requested focused resilience
packet; the earlier 146-case composition campaign was not repeated. API fields remain unchanged.
