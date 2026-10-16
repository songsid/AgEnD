# Canvas effect host policy (#1629 r2/r3)

`src/ui/shared/effect-policy.js` is a pure host-side foundation. This module creates no frame, registers no event listener, changes no geometry and reads no message content. Product mounting remains disabled until the factory, trust-marker/observer integration, profiler, opt-in and route authorization land and pass review.

## Signals

`effectEvent(type, fields, instance, monotonicTimestamp)` makes a fresh object from the r3 closed allowlist. It never reads or copies text, people, attachment metadata, IDs, URLs or arbitrary extra fields. State/reply/mention use the region's host-owned current instance, or omit it when there is none; an explicitly conflicting source instance refuses the event. `validEffectEvent` independently checks exact keys and numeric/enum bounds immediately before sending. `maySendEffectEvent` also checks the frame's own instance and its manifest wants; env is implicit. For state/reply/mention a bound chat frame requires an exact instance field, and an unbound owner frame requires it absent. An event missing its source cannot cross into a bound chat.

The reserved status/usage/fleet kinds are for host-drawn widgets. They cannot be built or sent to an effect Worker. Key events have no kind. Pointer collection/coalescing and suppression during inputs/dialogs/hidden state belong to the later DOM adapter, which must use these functions for its final send.

## Frame allocation

`allocateEffectFrames` receives host descriptors and current page gates. It returns active / queued / off plus reason and queue position. No allocation alone creates a frame. Invalid/unknown descriptors, hidden/offscreen/paused effects, closed chats, safe mode, public links, missing opt-in/preview, reduced motion and Save-Data reserve no slot. Front layers also reserve none while a modal is open. Unknown provenance receives agent restrictions: chat only, bound to the open instance.

The page pool is three on standard devices and one on constrained devices. Front layers have a separate two/one subcap. Human owner regions are ordered page, header, sidebar, box, then the open chat's applied order. A paused/removed descriptor frees its reservation at the next allocation. Host-rendered widgets consume no effect frames.

Constrained means positive deviceMemory <=4, positive hardwareConcurrency <=4, or coarse pointer plus viewport <=900. Missing optional hardware hints alone do not pretend to be a measured low-end device.

## Trust holes

`effectTrustClip` takes the frame's viewport rectangle and the host's measured trust rectangles. The DOM adapter must copy DOMRect fields into plain `{x,y,width,height}` objects; native DOMRect instances are deliberately refused as unknown. Each hole is padded eight pixels, rounded outward, converted to frame coordinates and clamped. Before building an evenodd path, a bounded sweep unions overlapping holes into disjoint horizontal slabs. Adding overlapping holes directly to an evenodd path would repaint their intersection, exposing precisely the pixels that need protection.

Unknown, sparse, non-finite or excessive rectangles return failure. There are at most 128 input rectangles and 512 union pieces; overflow hides the effect rather than supplying an unclipped fallback. No model-supplied CSS/path/text enters the CSS value. These are geometry decisions only: the future adapter must hide an affected agent front frame in the same task as a trust mutation or movement, coalesce recomputation to rAF, apply the path through CSSOM, and reveal only after successful recomputation. Missing CSS path support must hide. Human placements retain the approved clipping exception; caller provenance must come from the host store.

## Tests and rollback

Tests execute the real exported browser module, pair generated signals with the independent Worker validator, poison content getters, exercise both frame caps and deterministic queue ordering, and independently compare the padded rectangle union against pixel coverage. Mutation controls cover the changed contracts. These tests do not claim native CSS rendering, observer timing or a product registry; those remain integration smoke work.

Rollback is reverting this unmounted module. There is no persistent state or migration.


## Reserved mention trigger

The `mention` codec/manifest kind remains reserved for compatibility, but the registry and independent final-send gate never emit it in 2.3.0. No text parsing or inferred target is permitted. Provider-confirmed direct-ID, viewer-scoped boolean pulses are deferred to [#1963](https://github.com/songsid/AgEnD/issues/1963). Worker subscriptions may name the reserved kind without receiving events.
