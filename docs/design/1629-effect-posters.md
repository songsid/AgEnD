# #1629 — static current-chat poster reads

This is a read-path foundation for the r2 fallback/public-link poster policy. It does not mount posters, complete the personal regions/cursor, or add a Try panel. Those product adapters are separate reviews.

## Authority and output

`GET /ui/effect-posters?instance=<name>` returns only `{rev, posters:[{id,title}]}` for currently placed, revalidated chat-capable effects with a usable poster. At most the two instance placements can be returned. No manifest, params, code, cursor, assets, claims or profiles are projected. A front declaration does not grant front poster paint: the later host renderer must paint posters behind content using the reviewed stock ordering.

`GET /ui/effect-posters/<32-lowercase-hex-id>.png?instance=<name>` independently rechecks the exact current instance placement and reference provider. Sharing, an old summary, a guessed id or an unrelated reference is insufficient. Removal immediately refuses subsequent fetches. Retained chat policy applies; this does not borrow personal slot ACLs or grant an export/library claim.

Both routes retain the common web token/session gate, expiry/revocation, listener-owned gateway exposure and origin checks. Their closed public manifest permits GET only. The one required query field is `instance`; duplicate/unknown fields refuse. Automatic reads are passive and never extend idle expiry. Runtime `/ui/effects` routes keep their independent gateway refusal. No frame/CSP or session identity relaxation is introduced.

## Static image

CW1 normalization may retain APNG chunks. Changing that normalization would invalidate existing content identities, so stored bytes and ids remain unchanged. A separate bounded output projection strips `acTL`, `fcTL` and `fdAT`, retaining the PNG default image, not a promise about the first composited animation frame. PNG byte/dimension/pixel/chunk bounds and a complete default-image chunk walk fail closed. This is not a full decoder or CRC validator; a browser can reject invalid image data. Retained library validation already strips metadata before this projection.

PNG responses are private/no-store, nosniff and `image/png`, with `default-src 'none'; sandbox`. This PR changes no browser rendering or upload/store quotas. Tests use private stores and owned HTTP listeners, not fleets or accounts. The browser recipe uses real APNG animation as its positive control, checks the projected image stays static across Chromium, Firefox and Linux WebKit, and is not a claim about real Safari.

## Rollback

Revert the two GET routes, their public/passive classifications and output helper. Existing libraries, claims, ids and placements are untouched; no migration is needed.
