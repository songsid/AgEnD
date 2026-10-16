# #1629 host cursor read foundation

Target: `feat/2.3-web-mod`. This read foundation itself does not mount a cursor, add a preference,
create another loader, or complete B2. The later [controller and adapter](1629-effect-cursor-mount.md) independently
verify native image dimensions/hotspot, own its decode and CSSOM lifecycle, retain
physical decode capacity across cancellation, and restore the normal cursor on
unknown state, failed cascade, preference invalidation or session end.

## Static output

CW1 accepts `cursor.png` only as PNG, at most 32 KiB and square at most 64 pixels,
with an integer hotspot inside the image. Normalization can preserve APNG chunks.
The existing authenticated image route now returns a copy of the default PNG
image with `acTL`, `fcTL` and `fdAT` removed. Stored bytes and content identity do
not change. Selection, own/shared ACL, current session epoch and route exposure
checks remain the existing ones. Unshare refuses the next authorization; a saved
reference remains until Clear. Cursor selection still grants no Worker code read.
The helper checks chunks and dimensions, not CRCs or compressed image data; a
native decoder can still reject an input whose header was valid.

## One shared loader

`cursorImageSettled(id, signal)` accepts only a 32-hex id, builds exactly
`/ui/effects/image/<id>/cursor.png?slot=fx.cursor&ownerEpoch=<captured epoch>`, and
uses same-origin credentials, no-store and redirect:error. No response URL or
response metadata grants authority. The binary path requires image/png, bounds
declared and streamed bytes to 32 KiB, requires a static square PNG at most 64
pixels, and copies the result. The original JSON placement/resource projection
and capacity rules are unchanged.

The same loader owns one cursor physical request lane, the existing metadata
lane, and the existing three Worker-resource lanes. Authorization rejection,
owner loss and clock rollback revoke all lanes once. The ten-second monotonic
cutoff is checked after every wait, including final cancellation. Logical abort
does not release the physical lane: this settled operation completes only after
the fetch/read and any actual body cancellation settle. A late response is still
canceled, even when abort happened before headers. A disposed Window's loader
reservation remains until every owned operation finishes. A hung body/cancellation
therefore intentionally makes the lane unavailable; it is not replaced or retried.

## Mount requirements

No author Worker/DOM/HTML/CSS is needed for a host cursor. The controller must take
only the authoritative fifth owner slot from the existing app metadata lane, bind
the exact id/generation/hotspot, and follow effects/preview consent and current
session/device gates. It must use the verified host stylesheet with a host-owned
container selector and `url(<host-owned image>) x y, auto`, never cursor:none or a
universal descendant override. Explicit stock pointer, text and resize cursors
must remain usable. Unknown or unsupported conditions fall back to stock cursors.
