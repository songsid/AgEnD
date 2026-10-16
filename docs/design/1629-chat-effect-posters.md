# #1629 — behind-only static Chat poster UI

This completes the Chat fallback on top of the current-placement read API (#1969) and opted-in local Chat runtime (#1968). It does not mount personal regions/cursor or implement Try. Effects remain Canvas Workers; the fallback adds no effect HTML, Worker, iframe, event channel or profiler write.

## Rendering and gates

A separate adapter mounts only on the actual full Chat route with a current lease and live auth episode. It uses the viewer's show/safe choice and the actual stock ordering proof. Preview unavailable, opt-in missing, public-link, reduced-motion or SaveData selects static fallback. Still images need no preview origin or Worker support. Explicit Pause, queueing and failed live reads are not substituted by this surface fallback.

Images are host-created, decorative, pointer-inert PNGs. Every poster is forced behind, even for a front-declared effect. Append and the existing CSSOM geometry bind happen synchronously before assigning an image source; initial hiding must be proven. Every reveal uses a fresh actual Chat stock snapshot and viewport rectangle. Mutation/scroll/resize hides immediately; rAF rechecks before continuing paint. Unknown ordering, unsafe geometry, hidden/disconnected surfaces and show/safe changes remove images. Behind can tint translucent backgrounds; this does not promise pixel invariance of every stock background.

## Ownership and bounds

Only the closed current-instance metadata and PNG endpoints are read, through authenticated same-origin fetch. Responses never supply a URL, selector, code or authority. Metadata is bounded to 8 KiB/two entries; PNGs to 1 MiB/4096 px/8 Mi pixels and non-animated complete chunk structure before DOM decode. This is not a CRC/compressed-data decoder. Blob URLs belong to the host and are revoked on removal.

Two physical requests per Window remain reserved through fetch/body/cancel settlement, including across disposed/replaced readers. A separate two-decode Window bound remains held until decode settles. Logical 10-second timeout/cancel does not release either reservation early. Completion rechecks monotonic time, lease/generation, auth and stock gates. A removed route/revision cannot publish late bytes or a decoded image. An unavailable pool fails closed; there is no idle network polling or automatic retry. A changed revision/page reload may try again; held old operations can conservatively prevent that attempt.

Session end, ended connection, pagehide, navigation or explicit disposal removes images/geometry, revokes URLs and aborts owned reads. A failed partial setup releases what it acquired and leaves Chat usable. Effects playback controls appear only where the existing local runtime identity is available; public/header/poll/View do not gain them.

## Public show choice

The existing public switch wrote the shared cache while `prefInForce` still chose boot host values, so a host `fx.show=true` prevented local off. The narrow fix adds `agend_public_fx_show` only for explicit public-link choices, memory first and best-effort storage. A host refresh never overwrites it; ordinary signed-in pages ignore it, and anonymous View keeps its old path. There is no legacy migration or host-bucket change. The theme owner confirmed this seam and that no conflicting edit is in flight.

## Evidence and rollback

Unit fixtures distinguish modeled geometry from native paint. The native recipe uses actual Shell/ChatPanel/CSS and the built service projection in a private synthetic session; its public flag is not a real public TLS/tunnel. Real public gateway/session/exposure transport is independently covered by the #1969 HTTP suite. Chromium/Firefox/Linux WebKit are supported smoke targets, not a real-Safari claim. Playwright WebKit screenshot preparation inserts and removes a style node even with caret hiding disabled. The stock observer correctly hides on that mutation; the pinned in-process screenshot hook waits two real rAFs after preparation before capture. It does not suppress mutations or skip proof. The recipe separately pins synchronous hiding on a host mutation and fresh-proof recovery. Initial white captures are retained as fixture evidence, not reported as a product paint failure.

Rollback removes this adapter/static-module closure and returns the menu behavior; existing entries, identities, claims and placements stay. The new browser-local public switch key may remain inert. No migrations, dependencies, main/update/service changes.
