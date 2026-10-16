# Authenticated Canvas effect access (#1629 B2)

This is the server adapter for the reviewed library, placement store and reported-profile foundation. It does **not** import or serve a browser runtime module, create a frame, start a preview listener, add startup work or mount an effect. The subsequent human Settings, Try-card and product adapter must still enforce local opt-in, safe mode, trust geometry, one registry and the reviewed caps/safety/profiler lifecycle.

## Identity and boundaries

All `/ui/effects` routes require a signed-in human session. A header token (including an agent endpoint's token) is insufficient. The public gateway manifest contains none of the routes; the handlers independently reject a gateway context. Appearance/library writes require an admin session plus the existing Origin/CSRF gate. Only bounded diagnostic profile POSTs also accept a signed-in read session (r2 §6). After awaiting a body, the handler repeats authorization and compares both the actual session person's `webPersonKey` and exact session handle; no body supplies that person, a holder, provenance, a data directory or a path. Session revocation while the body is in flight publishes nothing.

Ordinary library list, profile history and unplaced resource reads use `library.read(id, human)` / the same scoped list. Own claims and explicitly human-shared entries are visible; another person's private claim is indistinguishable from an unknown id. Sharing is explicit and only changes the caller's own claim. An upload makes a human direct-upload claim, never a shared claim or a mod holder. A human can remove a chat placement without acquiring its bytes or claims.

A **runtime read** with `?instance=<name>` is different from export authority. It requires a currently known instance, a readable ThemeStore, the exact id still placed there, valid typed overrides, and an independent library `readReferenced(id, "instance:<name>")` check. Knowing an id or holder string is insufficient. Removal revokes subsequent runtime reads. This permits an authenticated viewer to run what is currently placed without silently making that viewer a claimant. Such viewers can inspect the code delivered to their browser; this is not DRM or a claim that private effect bytes are unextractable. Ordinary product exports continue to use the exporting person's own/shared ACL, not this retention seam.

## Routes

| Method and path | Purpose |
| --- | --- |
| `GET /ui/effects` | Caller-visible normalized manifest summaries and latest reported profile per device class |
| `POST /ui/effects/upload` | Existing closed base64 file-array encoding, bounded by `EFFECT_WIRE_LIMIT`; full CW1 validation and library quota before commit |
| `POST /ui/effects/apply` | `{instance,id,params?}`; exact caller read, typed overrides, explicit host `by:"human"`, at most two chat placements |
| `POST /ui/effects/remove` | `{instance,id?}`; remove specified/all chat placements and collect only unreferenced blobs |
| `POST /ui/effects/share` | `{id,shared}`; explicit boolean on the caller's claim |
| `DELETE /ui/effects/<id>` | Remove only the caller's unused claim; other principals and live references remain protected. Explicit deletion may collect that caller's orphan mod holders |
| `GET /ui/effects/placements?instance=...` | Current readable chat placements with host provenance and resolved default/override params |
| `GET /ui/effects/resource/<id>[?instance=...]` | UTF-8 Worker source, normalized manifest and only `assets/*` rasters, base64 with sniffed MIME |
| `GET /ui/effects/image/<id>/{poster,cursor}.png[?instance=...]` | Host-only normalized PNG; never included in Worker assets |
| `GET /ui/effects/profile/<id>` | Full bounded history, ordinary caller ACL |
| `POST /ui/effects/profile/<id>[?instance=...]` | Closed diagnostic report; caller ACL or exact current runtime placement |

Responses are private/no-store/nosniff. PNGs additionally carry `default-src 'none'; sandbox`. Unknown paths/methods do not fall through to generic mutation. Non-upload JSON bodies are at most 16 KiB and strictly decoded UTF-8; uploads reuse the existing 12 MiB encoded-wire limit, 8 MiB raw and 1 MiB normalized CW1 bounds. The shared abort-aware reader closes oversized connections; a client may observe a reset instead of receiving the attempted 413 response. Socket deadlines belong to the existing listener; no new process or background timer is introduced.

The service reuses `effectRasterAssets`: posters/cursors are host resources, not Worker inputs. A retained resource does not select another current session or execute code on the server. Nothing accepts a file URL, remote dependency, import URL or arbitrary filesystem path.

## Profiles and quotas

Agent `profile_web_effect` becomes a read-only view of real stored reported data after its existing library ACL check. Unmeasured is explicit, never invented healthy. Agent listing uses only the latest report per device class instead of serializing every retained report. The collector itself and HTTP writer remain separate: the writer does not accept content/actor/time/Worker metrics and never changes placement, safety state or admission.

Successful profile reports are limited to one per person/id per 10 seconds, using a monotonic clock. Refused/invalid writes do not spend that slot; 1,024 live report keys are allowed and entries expire after a minute. Clock failure/rollback refuses. This is a bounded diagnostic-ingress budget, not a second agent appearance limiter. Agent appearance writes continue using the existing single shared limiter. Human changes/removals are not charged to an agent's change/upload budget; the library's retained-id/byte quota still applies.

Execution-resource/placement reads, retained runtime images and profile POSTs require exactly one matching boot `ownerEpoch`; personal runtime reads keep the same fence. See [the runtime session contract](1629-effect-runtime-auth.md). Automatic effect reads **and profile POSTs** are passive for session-idle touching only. POST still requires CSRF and a human session; only diagnostics accept the read tier. Background profiling must not keep a person's otherwise idle session signed in indefinitely.

## Risks, verification and rollback

Tests use private FS components and owned scratch HTTP listeners. They cover human/agent/public/read-only boundaries, explicit sharing, no body-controlled authority, session revocation during a held body, private retention without export/claim promotion, params/provenance, collection, PNG separation/headers, diagnostic validation/rate/clock bounds and passive session expiry. No real fleet, provider, account, tmux, tunnel or preview is started.

Reports are forgeable host metadata and may reflect unrelated jank. Retained runtime code is inspectable by its viewer. Multi-store/filesystem crash atomicity is unchanged from the reviewed participants; this service does not claim a cross-store transaction. Revert the adapter/routes/agent reader and the human API becomes unavailable again; existing library/placements/reports stay intact. No migration, restart or active browser mount needs rollback.

## Personal owner slots

The separate [owner preference contract](1629-owner-effect-preferences.md) adds
`GET /ui/effects/owner?ownerEpoch=<boot-handle>` and the closed `?slot=fx.sidebar|fx.header|fx.page|fx.box|fx.cursor`
resource/image authorization (also requiring `ownerEpoch`). Cursor slots do not grant Worker source, and slot
plus instance is refused. Unlike retained chat runtime, personal slots always
recheck current own/shared access; an unshare makes the stored choice unavailable
until cleared, while its reference still protects the blob. This is backend only;
owner selectors and runtime mounting remain separate.
