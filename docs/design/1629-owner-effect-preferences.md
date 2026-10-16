# Owner effect preference authorization (#1629 B2)

This is a backend/API foundation, not a frame mount or an owner-selector UI. It
implements the leader's explicit host-operator and unshare decisions. Only the
five new keys `fx.sidebar`, `fx.header`, `fx.page`, `fx.box`, `fx.cursor` have the
new public personal scope. Their values are normalized effect ids; `null` clears.

## Identity and scope

The registry fixes each key's scope. Existing visible preferences, including
`fx.show`, `preview.optIn`, and `widget.sidebar`, remain in `OPERATOR`. Internal
profile/custom-CSS methods retain their existing identity behavior; in particular,
`css.active`/`css.trial` already followed the session person's internal bucket.
Nothing is moved. There is no migration or account merge.

The current request's established gate verdict selects a viewer:

- A platform-bound human web session uses `webPersonKey(owner)` (adapter/user).
- A valid ownerless human web session (e.g. `agend web --code`) uses explicit
  `OPERATOR`, shared by everyone signed in as that host operator. The subsequent
  selector UI must label that scope as host-wide.
- Header credentials, even alongside a cookie, expose only host preferences. The
  public gateway also exposes only host preferences and refuses all preference
  writes. Anonymous/View loads never gain personal fields from their mode alone.

The session binding selects web storage; it does not prove platform authorship or
permit a platform action. Display names never choose a bucket. A person is not a
body, query-string or arbitrary cookie-parser field.

`readForViewer(null)` is explicitly host-only. It hides personal operator keys even
though those physically share the operator bucket. `readForViewer(person)` merges
the disjoint host and five-key personal projections; personal buckets cannot
shadow legacy host values.

## One publication and the stale-session fence

`writeForViewer` validates the whole patch and current own/shared effect access,
routes the fixed scopes, clones touched buckets, and writes one candidate file.
Memory publishes only after the synchronous durable write succeeds. A mixed host
and person patch raises the global revision once, including when both resolve to
one operator bucket. `onlyIfUnset` checks the correctly routed bucket. A failed
validation/write changes neither bucket. Trusted internal profile/CSS/mod callers
keep the raw bucket API.

`GET /ui/prefs` and full-app boot add `ownerScope` (`person`, `operator`, `none`) and
`ownerEpoch` (the current session's existing opaque public handle, or null). This
marker is not a credential or target. A personal-key POST and new owner state/resource/image reads must include the matching
`ownerEpoch` (body for POST, query for reads); an old page/queued operation after another login is refused, even when
the new session is for the same person. Existing host-only clients need no marker.
The current authorization is checked before and after the body, requiring the same
person/session/classification, admin tier and existing CSRF/Origin checks. A token
patch touching any personal key (including null) refuses the entire mixed patch.
Boot uses one verdict for the preference and custom-CSS identity projections.

Client synchronization/selectors are a later PR: keep these five keys out of the
shared local cache, browser fallback and first-device migration. Bind reads and
pending writes to the boot scope, revoke old-scope work, and preserve unreadability
instead of treating an unknown store as an empty preference. None of this foundation
implicitly enables execution.

## Exact personal resource authorization

- `GET /ui/effects/owner?ownerEpoch=<boot-handle>` returns all five states (`none`, `available`, `unavailable`)
  and keeps the stored id in an unavailable row. It does not discard the row or
  return its now-private manifest. A future UI must show unavailable plus Clear.
- Selecting an id checks the current human's own/shared claim and region declaration.
  A box needs declared geometry; a cursor needs its validated host cursor asset.
  Null clear requires no library read, so unavailable choices remain clearable.
- `GET /ui/effects/resource/<id>?slot=fx.page&ownerEpoch=<boot-handle>` (or another non-cursor owner key)
  requires that exact id still be in that current person's exact declared slot,
  then rechecks own/shared access and manifest compatibility. A cursor slot never
  grants Worker source. Supplying both slot and instance refuses.
- `GET /ui/effects/image/<id>/{poster,cursor}.png?slot=...&ownerEpoch=<boot-handle>` uses the same selection
  and current ACL. No query/body supplies the person or reference holder.

Unsharing therefore denies the **next personal-slot resource authorization** while
leaving the saved reference until its owner clears it. An already executing Worker
is not retroactively claimed cancelled by this backend step. Chat `?instance=`
retains its separate exact-placement runtime policy, unchanged: a chat runs what
was placed there; personal choices follow current sharing. Neither reference is a
sharing/export grant, nor DRM against bytes already received by a browser.

## Retention and unknown state

The library's preference provider enumerates all five keys across every identity,
including inactive people and the explicit operator. Canonical hashed holder names
stay under the library's bound even for long identity keys. A supported malformed
stored effect id makes the preference file unreadable; it is not silently dropped.
Unknown/unreadable state refuses personal resources and writes, preserves the boot
unknown flag, and throws from the reference provider so collection deletes nothing.
Clear/replacement collection is attempted only after successful preference
publication, against the new all-bucket reference snapshot.

The existing single fleet owner/cache contract remains: raw files are not a
multi-writer API. Library principals still have their existing 256-character id
bound (ordinary Discord/Telegram identities fit); an unsupported oversized binding
fails closed rather than acquiring a broader identity. Inactive references can keep
blobs indefinitely, by design. No cleanup job, migration, startup work, fleet or
account probe is added.

## Verification and rollback

Private FS tests exercise the real store/library/service and actual HTTP handlers
with inert request events. They cover atomic mixed publication/failure, per-adapter
buckets, explicit operator, token/public/boot fences, queued/held session changes,
region/box/cursor validation, withdrawal versus unchanged chat retention, null
clear, bounded all-person references and malformed/unreadable collection refusal.
The existing inert FleetManager integration also proves its real provider sees a
non-operator reference. No browser playback or real account is claimed.

Before personal choices exist, reverting withdraws the new API contract. After
they exist, hide the new routes/UI while retaining this registry/reference provider
and the scoped read/write authorization guards for rollback. An older preference
writer silently drops unknown keys, and its collector does not understand the
references. A full binary downgrade is not lossless: privately preserve the
preference file, effect index and blobs beforehand; the old writer may discard
these choices on its next host-preference write. Restore the saved data before
returning to the updated reader/provider. There is no new disable-writes switch
or automatic downgrade migration. Simply reverting the registry is unsafe.
