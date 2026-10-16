# #1629 static host cursor controller foundation

This design describes the controller foundation. The later [product adapter](1629-effect-cursor-mount.md) provides the
exact fifth owner-slot selection, its generation and the existing app/session
consent gates, and shares its one settled loader. The controller itself never writes a cursor preference. Try remains separate work.

## Boundary and stylesheet

Only a decoded static PNG cursor is rendered by host CSS. No author code, Worker,
iframe, editable element or supplied CSS/URL is used. `effectHostStyle` extracts
the existing geometry helper's fixed same-origin `/assets/app.css` proof; geometry
keeps its independent clip-path capability requirement. The host-style module is
served because geometry imports it. The later adapter serves the cursor controller when mounting it.
No constructed stylesheet, inline style or CSP exception is added.

The controller accepts only `{id, generation, hotspot}` as own data properties;
the id is 32 lowercase hex, generation a nonnegative safe integer, and hotspot a
two-entry dense integer array in 0..63. The producer must derive it from the
session-authorized owner metadata, not Settings data or a manifest supplied by an
agent. An explicit true host gate is required. The injected image read receives the immutable id/generation/hotspot snapshot, so
the app can recheck the exact source generation before and after the read. It must use the
shared loader's **settled** cursor operation, not a logically canceled promise.

The target is exactly one connected `#app > .shell` in this document. A generated
host attribute arms one owned CSSOM rule on that container only. Preact class
updates cannot remove the marker. The value is only a host-created same-origin
Blob URL, validated integer hotspot and `, auto`. The rule uses normal priority;
explicit descendant pointer/text/resize cursors keep their own rules. There is
no universal descendant selector or cursor:none.

Before publication, compare header dimensions with native decoded natural size,
require the hotspot inside the image, and verify both CSSOM readback and computed
container cursor. Unknown target, changed stylesheet, rejected/overridden rule,
read failure or unsupported decoder fails closed. Remove the owned attribute to
disarm even a rule whose stylesheet became unreadable, then clear/delete by rule
object identity. Unrelated rules/attributes and the shell itself are retained.
The shared host-style extraction otherwise preserves geometry's existing proof.

## Ownership and settlement

One controller owns a Window at a time, including its pending read/decode. The
selection identity includes its generation, even when the id is unchanged. A new
selection or false/unknown gate synchronously restores stock cursor and revokes
any owned Blob URL, but waits for the old physical settled read/decode before
starting another. No automatic retry of an unchanged failed selection occurs;
a fresh authoritative generation can try again. The ten-second monotonic deadline
covers image read, native decode and publication; delayed timers cannot admit a
late decode. Clock rollback permanently ends this controller.

Disposal, pagehide and host currentness loss disarm the selector and revoke the
URL. The Window reservation is not released until a pending read/decode finishes.
A hung decoder deliberately blocks replacement rather than bypassing the bound.
Callbacks can replace a selection or dispose; notification reentry is bounded,
and a newer selection is not latched as the failed older operation.

This helper has no autonomous animation-frame loop, event polling or authorization
subscriber: the app adapter owns those lifecycle/gate updates and immediate
session disposal. It must not pass a stale true gate after session end. The native
recipe proves this helper with a fixed stock-control fixture and real app.css,
not a complete authenticated app mount. Linux WebKit is not real Safari.
