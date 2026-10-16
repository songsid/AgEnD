# Owner effect choices: client synchronization (#1629 B2)

This adds Settings selectors and synchronization for the five owner slots. It does
not mount a frame, create a Worker/canvas, fetch effect source, or start playback.
The separate app-owned adapter now plays four personal regions through the shared pool after consent and stock checks; the selector also exposes its slot controls. Cursor and Try remain separate work. This client still does not own a runtime pool.

## Separate from the host cache

The five `fx.sidebar/header/page/box/cursor` keys have fixed person scope in the
client registry. All existing visible keys remain host-scoped. The old shared
cache, fallback, migration and optimistic write queue handle host keys only. They
cannot read, cache, migrate or save these five keys; no new localStorage key is
introduced, and old stray device data is neither imported nor erased.

`owner-effect-prefs.js` instead freezes the backend's boot `ownerScope/ownerEpoch`.
A valid platform sign-in uses its existing adapter/user bucket; accounts on
Discord and Telegram are not merged. A signed-in web-only operator is supported
explicitly, with a **Host-wide effect choices** / **主機共用效果選擇** title and a
warning that everyone signed in as host operator shares these slots. Header,
anonymous, public-link, missing or malformed boot metadata grants no owner I/O.
No separate cookie parser or caller-supplied person selects an identity.

## Requests and unknown state

A reference-counted watch starts only while a selector or later runtime consumer
needs the choices. It uses the existing status preference revision for invalidation,
and explicit library reloads for sharing changes; there is no interval or startup
polling. An unknown/error response is never an empty set of selections. Reads keep
unknown state and can retry on manual request or later existing status activity
(after a five-second error backoff).

One synchronously claimed physical operation owns either a GET or a POST and its
readback. At most one read is coalesced; a second write is refused, never queued or
automatically resent. Unwatch aborts and changes generation, discarding late answers;
the physical reservation lasts until the old promise settles, even across remount.
Each network call has a ten-second abort and checks monotonic elapsed time on
acceptance too, so delayed timers cannot admit an overdue answer. A native fetch
that never settles despite abort can retain this reservation until the page is
reloaded; the client does not pretend an abort proves physical completion.

Owner state/resource/image reads carry the immutable boot epoch; writes carry it
with an immutable id/null patch. The host independently rechecks identity, tier,
current sharing and region compatibility. Authentication/session rejection or an
acknowledgement for another epoch/scope revokes this page's owner state until reload.
A successful write is shown only after the authoritative acknowledgement and
owner-state readback. If the host saved but readback fails, the UI says so; it never
says the change was rolled back.

## Unavailable choices and presentation

The five region/cursor selectors use the authorized library catalog and its
`canWrite` display hint. The server remains the authority. Options must declare the
region; a box needs geometry, and a cursor needs its host cursor declaration.
Selections store ids only, with default parameters; per-chat override editing
remains in the existing library card.

Unavailable choices retain the exact stored id, show **No longer available** /
**已無法使用**, and offer explicit **Clear** / **清除**. They are never silently
removed. Read-only sessions display choices with controls disabled. A Clear sends
null and does not require the unavailable effect's private bytes. The new helper
can mark an exact selected id unavailable after a later runtime authorization
failure, without writing or changing its retained reference.

The future runtime URL helper requires the currently known exact slot/id and boot
epoch. Cursor choices can request host images, never Worker source. Personal
unshare semantics remain stricter than already-retained chat placements: the next
personal resource authorization fails, while the stored reference remains until
Clear. Bytes already received are not retroactively revoked.

## Evidence and rollback

Unit tests use real modules/Preact with inert APIs and owned DOM fixtures. They
cover scope/epoch fences, operator support, no owner cache or migration, bounded
operation/late responses, write readback, unavailable Clear and read-only UI.
`scripts/manual/owner-effect-settings-1629.mts` uses a scratch server, actual modules
and styles, and a fake authorization API. It is not a real session/account test.
The recipe covers Chromium, Firefox and Linux WebKit, light/dark, desktop, narrow
and coarse pointer; Linux WebKit is not physical Safari or IME evidence. No frames,
canvas, source/image resource fetch or mod code is involved.

Reverting this client removes selectors and their watch; backend slots and
all-bucket references remain. Preserve the backend registry, scoped authorization
and retention provider after choices exist. The backend design documents why a
full binary downgrade with an old writer is not lossless. Nothing here needs a
service restart, data migration or active-effect rollback.

## Shared owner projection before mounting

Personal owner metadata now uses the same closed CW1 manifest validation as runtime resources, including normalized one-line display text counted in graphemes with its bounded UTF-16 input. The earlier title-only 40-code-unit check refused legitimate combined Unicode titles and did not validate runtime declarations. Settings and future playback share `checkEffectOwnerSlots`; unknown fields/accessors, incompatible regions, missing box geometry/cursor declaration and malformed statuses refuse the whole projection. None/unavailable remain distinct; unavailable keeps its stored ID.

The runtime loader exposes `owner(signal)` for the existing epoch-bound owner endpoint. It shares the one metadata request reservation and 256 KiB bound with Chat placements; it does not create a second loader, pool, authority or retry loop. Its bounded snapshot permits five complete maximum-parameter manifests while retaining the original per-resource tree budget. This is metadata preparation only: no personal region/cursor is mounted and no resource is fetched by adding this method. The existing preference client's operation/lifecycle/write transport is unchanged.
