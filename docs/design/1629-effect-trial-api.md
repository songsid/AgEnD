# #1629 local-admin Try server adapter

> Current integration: [product Try](1629-effect-trial-product.md) connects these foundations. References below to an unmounted or unavailable slice describe its original introduction, not the current feature branch.

This connects the [volatile authority](1629-effect-trial-authority.md) to the
Fleet library and separate local-admin HTTP routes. **No tool emits an offer, no
chat card starts a trial and no frame is mounted by this PR.** `preview_web_effect`
still returns unavailable. The approved physically clipped stage must be reviewed
before a later card/playback adapter starts using these endpoints.

## One library owner

Fleet registers themes, all personal preference buckets, mods and the single
`WebEffectTrials` provider before publishing its library. A failed fourth
registration publishes neither the library nor trial owner; retry constructs a
fresh complete owner. Service and tools keep that same library. No second frame
pool, loader, limiter, Worker or CSS manager is introduced here.

## Exact HTTP surface

Every route requires a real, current, **local admin session**, never a header
token (even beside a valid cookie), public/gateway request or read-tier session.
The server derives `sessionHash` from `SessionRecord.idHash`, epoch from its handle
and person from `webPersonKey(record.owner)`. Those bindings are never body inputs
or response fields. Web-only operator sessions are supported and session-bound.

| Method and path | Query | Body / result |
|---|---|---|
| POST `/ui/effect-trials/start` | exactly one `ownerEpoch` | closed `{offer, instance}`; trial token, display offer, monotonic `remainingMs`, checked manifest and resolved default params |
| POST `/ui/effect-trials/<trial>/stop` | exactly one `ownerEpoch` | exactly `{}`; clears only that session's trial |
| GET `/ui/effect-trials/<trial>/resource` | exactly one `ownerEpoch` and `instance` | checked code/default params/declared signals and raster assets, using the ordinary bounded projection |
| GET `/ui/effect-trials/<trial>/poster.png` | same | static PNG output copy, no-store/nosniff/sandbox |
| GET `/ui/effect-trials/<trial>/profile` | same | existing saved measurements only, after current trial authorization |

The requested instance must equal the offer/run's internally recorded origin; it
cannot select another effect or borrow another placement. Unknown/mixed/duplicate
selectors refuse. No free effect id, slot, holder, caller identity or provenance
selector is accepted. Unsupported methods, including GET start/stop and POST
profile, refuse. A future button alone will issue start after an explicit click;
an HTTP POST is not proof of a physical gesture, and the future UI must pin its
no-auto-start behavior.

Start/stop retain the existing Origin, Fetch-Site and session-derived CSRF checks.
Bodies are physically limited to 16 KiB and decoded as fatal UTF-8/closed JSON.
After the body settles, the route reauthenticates and compares the actual session
record, session-store identity, hash, person and epoch. Revocation, expiry, token
rotation, even a same-person cookie swap or store reload cannot continue an old
request. No client-supplied actor object reaches the authority.

Start also returns the floored **monotonic** remaining milliseconds (1..600000).
The later client must set its deadline to **request-start performance time plus
remainingMs**, not response time plus remainingMs, and recheck it before paint.
This conservatively includes request/response delay and cannot renew an old
offer. Public `expiresAt` is wall-clock display only: client/server clock skew or
wall-time rollback must not extend playback. A sub-millisecond remainder refuses
start. These client deadline checks remain future mount work.

The server records the current owner-CSS enum as diagnostic context; unavailable evidence becomes unknown.
It does not block the shadow-isolated Try on CSS state. Local admin, session/epoch, current origin-agent ACL
and monotonic expiry remain mandatory for Start and every read. The click supplies consent only for this sample;
ordinary playback and HTML-preview preferences keep their existing gates.

Each code/image/history read passes through `trials.read`, checking exact
session/epoch/person/origin, monotonic TTL, known instance and the **origin
agent's current own/shared rights**. It never borrows `readReferenced` or the
admin's own claim. Expired offers, stopped trials, withdrawn sharing and wrong
binding are local 404s, not synthetic auth failures that would revoke unrelated
Chat/personal effects. Real session rejection remains 401; a non-admin or header
credential is 403. Unreadable saved measurements return 503 after authorization.

Resource/poster/profile GETs are passive: they cannot slide session idle expiry.
Start/stop remain explicit human activity. No new public gateway route is added,
and direct bound gateway requests are independently refused.

## Persistence and remaining playback boundary

Try creates no saved offer, claim, placement, preference, share or export. It also
does **not** persist a diagnostic report: only existing profile history is read.
Future live trial metrics belong to the transient host UI and end with the trial.
Ordinary placement/owner playback reports and `profile_web_effect` remain exactly
as before. Session activity bookkeeping follows the existing authentication rules.

No new asset is served, no action field is added to chat history and no incoming
agent tool can start a trial. The approved Trial label/Stop UI, explicit local
admin click, physical `contain: paint` + `overflow: clip` inside its own panel or
sheet, stop on close/navigation/blur/other dialog, ordinary foreground suppression
and common caps/profiler/safety stops are **still mandatory future mount work**.
There is no native/browser evidence in this server-only change.

## Verification and rollback

Private scratch HTTP tests use real sessions/library/authority/profile stores,
with only CSS state and clocks/known-origin controlled. They cover denied actors,
query/body closure, CSRF, expiry/revocation/cookie/store races, CSS changes while a
body waits, current sharing for every resource kind, explicit operator identity,
passive idle expiry and no durable appearance/claim/profile writes. The Fleet
fixture forbids process spawning and verifies publication ordering and failure.

Risk: an active volatile offer still holds bytes until its original expiry even
after Stop, as documented by the foundation. API availability alone is not UI
permission to mount. Roll back these handler/service/provider additions; no data
migration or placement/preference undo is needed. Existing ordinary effect
authorization and diagnostic writes are unchanged.
