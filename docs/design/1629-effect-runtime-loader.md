# Epoch-owned effect runtime reads (#1629 B2)

`effect-runtime-loader.js` is an unmounted host adapter. It adds no product
import, served asset, boot, frame, route, event subscription or playback. It
never runs script, reads messages or retries a failed operation automatically.

## Authority and ownership

The host supplies one immutable boot `ownerEpoch` and a current-page/region
callback. The epoch is a public handle comparison, not an actor or credential.
The existing server routes independently authenticate the cookie, require the
exact epoch and authorize the retained instance or current personal slot. A
header token, public page, stale cookie/epoch, missing reference or withdrawn
personal sharing is not made valid by this client.

- `placements(instance, signal)` reads only that encoded instance and boot epoch.
- `resource({id,instance}, signal)` requires an exact retained instance.
- `resource({id,slot}, signal)` requires one of sidebar/header/page/box. Cursor
  has no Worker source. The two scopes cannot be combined; there is no arbitrary
  URL, unplaced fallback or export grant.
- Source selectors are copied before the first wait. Currentness is checked
  before fetch, after each await and after projection. A failed/throwing current
  callback, clock rollback or 401/403/409 permanently revokes the loader. Reload
  creates another one; no response supplies a new epoch. A private 404 remains
  unavailable without guessing whether it was an ACL, reference or session loss.

The future product adapter must derive the epoch from verified boot data, fence
route/region generations, stop on session/connection/page teardown and dispose
before binding another owner. No response or manifest establishes placement
provenance. Already returned source cannot be recalled by local disposal.

## Streaming and physical bounds

Requests use same-origin credentials, no-store and redirect:error. JSON MIME is
required. Both declared and observed decoded stream lengths are bounded: 256 KiB
for two-placement metadata, 8 MiB for resources. The latter accommodates the
worst JSON escaping expansion of a valid normalized 1 MiB entry (including a
classic script containing control characters in a comment); it does not enlarge
the normalized artifact or Worker payload limit. No response.json/text/arrayBuffer
shortcut is used. Each chunk is copied before the next wait, then fatal UTF-8
and JSON decoding run under the same deadline.

One loader owns a Window reservation, claimed before any constructor callback. Failed construction releases it; a disposed loader keeps it until all its physical reads settle, so a replacement cannot reset capacity. One metadata read and at most three physical resource reads may be outstanding.
Registry allocation still enforces the actual 3/1 frame/device caps. A ten-second
monotonic deadline, external abort or dispose resolves the caller to unknown and
aborts the underlying operation. A fetch/read that ignores AbortSignal keeps its
physical reservation until its promise settles. A delayed timer cannot extend
acceptance: elapsed time is checked at every continuation, including the exact
10,000 ms cutoff. There is no automatic retry, redirect following or replacement
of a still-outstanding reservation.

## Closed projections

Metadata and resource projections copy bounded own data, refusing accessors,
symbols, sparse/exotic arrays, excessive nesting/nodes and unknown keys. The host's
CW1 validator remains authoritative for syntax, identity, raster sanitization
and the normalized files. The browser independently projects closed runtime
metadata, region/layer/wants enums, all five parameter schemas/resolved values,
exact id and persisted by/at. Unicode display lengths use the host’s grapheme
limits (40 title / 200 description), with max×10 UTF-16-unit bounds and
already-normalized NFC one-line text. These strings are data, never evaluated
or interpreted as markup. Missing Intl.Segmenter refuses projection; there
is no code-point fallback.

Worker assets are only canonical-base64 raster assets/ paths, with exact MIME,
unique names, at most 16 and a combined 1 MiB code/params/decoded-byte limit.
Poster/cursor files remain host-only. Every result has independent byte arrays;
metadata is frozen. The factory snapshots and bounds again; native image decode
success, pixel budgets and the Worker CSP are still its/shim's responsibility.
No JS is executed by this projection, and no source/hash is used as a claim or a
measurement. No incoming message from an effect frame reaches this module.

## Verification and rollback

Tests use inert fetch boundaries plus Node's WHATWG Responses/Streams, held
fetch/body promises and a monotonic clock. Valid parameter/control-character
fixtures are checked against the real CW1 server validator. They cover Unicode
chunk boundaries, supported JSON expansion, closed schemas, canonical assets,
request paths, size/deadline/cancellation/ownership fences and physical capacity.
They are not a browser/network/login/product-mount claim. Final product browser
wiring and native three-engine acceptance remain separate.

Conservative schema/transport failures show unknown rather than executing partial
source. No durable state or configuration changes. Revert the unmounted module
and its callers together; do not add an unbounded or unauthenticated fallback.
