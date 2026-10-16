# Effect geometry and pre-mount cadence (#1629 B2)

These are unmounted host primitives. They do not add an iframe to a product page, a static asset route, a registry, event adapters, preference writes or profile storage. The registry must still enforce the reviewed frame caps, owner/currentness fences, opt-in/device gates, observer coverage, probation and pause history before product mounting.

## Why

The profiler needs a host cadence measured while **no effect frame exists**. Fixed 55/50 fps limits falsely penalize idle 50 Hz or power-limited 30 fps hosts. The pure profiler already requires `baselineFps`; this helper supplies a bounded browser measurement rather than accepting a manifest, child signal, saved profile or active-effect measurement.

Trust holes are viewport rectangles. CSSOM serializes SVG paths differently across browsers, and transformed containing blocks or a stronger host CSS rule can make planned coordinates differ from actual pixels. A successful stylesheet write alone is insufficient.

## Calibration

`captureEffectBaseline({ window, empty, clock? })` returns `{ promise, cancel }`. Only the host may supply these inputs. It requires a visible document and `empty() === true` initially and at every sample/acceptance check, measures at least two seconds of host rAF cadence, ignores duplicate timestamps, and times out at ten monotonic seconds even when rAF is starved. Cancellation, unknown capabilities, visibility loss, unknown/rolling-back clocks and a non-empty registry fail closed and release its rAF, timer and listener.

The registry must measure before the first mount and after each explicit human Resume, after physically removing every effect in the pool. The same proven result may serve a page/device epoch. It must not recalibrate from active effects, a worker message, a profile POST or an author value. A display or power-mode change can cause one pause until a new empty-pool Resume measurement. This measures host cadence, not Worker CPU/GPU/memory or effect-specific frame time.

## Fixed geometry

`hostEffectRect(element)` copies numeric native DOMRect fields into a bounded plain integer rectangle, rounded outward. `hostEffectSpace(window, frame)` rejects unknown/disconnected/foreign/overdeep ancestor chains, transforms, individual transform axes, offset paths, perspective, filters, containment, will-change, content visibility and zoom that invalidate the viewport model. Product frames must live in the host-owned viewport layer, not a transformed chat container.

`createEffectGeometry({ window })` uses only the already-loaded, connected same-origin `/assets/app.css` link and generated per-frame classes. Its `bind(frame, { layer, by })` returns `hide`, `sync(rect, stock)` and `remove`; the owner exposes `hide` and `dispose`. The fixed link, sheet owner/href, enabled state and readable rules must be proven; unknown sources refuse. No constructed stylesheet, new style-text source, style attribute or authored selector is used. The host fixes pointer-events to none, agent-front opacity to 0.85, front z-index to 20, behind to 0 and border/padding/margin/animation/transition/size constraints. These z-index values require the product registry to put trusted menus/dialogs above or remove front frames when a modal opens.

`sync` requires the same current copied stock paint evidence used by admission, including expanded paint rectangles (at most 128); it never queries border boxes or falls back to an empty list. It independently enforces `ok`, front eligibility and the agent-only foreground restriction. For an agent front it uses the reviewed policy's outward-rounded, 8 px padded **union** of the supplied holes. Unknown provenance receives agent restrictions. Human front choices and behind layers do not receive these holes. The host inventory, not this helper, decides which components carry `data-trust`; see [the admission contract](1629-effect-stock-admission.md).

The caller must create the factory frame and bind it in the same synchronous host task, without yielding. Binding verifies computed hidden visibility before returning success, before any ready/sync. A stronger initially-visible host rule refuses and physically removes the frame. An initial own-document bind rejection also removes its frame. The caller must immediately close the factory handle on any create/bind refusal to release its ports/timers/listeners; a failed geometry owner cannot claim foreign frames. Unknown geometry, rejected clipping, unsupported CSS or changed viewport axes never reveal a frame. Before reveal, it independently checks computed position, pointer behavior, opacity, layer, clip and actual physical viewport rectangle (less than 0.02 CSS px rounding tolerance). Bounded SVG command/number tokens permit native whitespace canonicalization while rejecting changed coordinates. If hidden visibility loses the cascade, the physical frame is removed. Disposal removes frames before deleting their own rules, avoiding an unclipped live frame; the host link and other app rules remain intact. The registry must also invoke the frame factory's `remove` to release its private ports/listeners and profiler reservation.

The future registry must hide immediately on relevant mutation/resize/scroll and recalculate in the next rAF; it must also remeasure continuously moving CSS geometry before reveal. Missing marker coverage, observation or geometry means no product frame. This PR does not claim those adapters exist.

## Evidence and limits

- Unit controls cover 30/50/60/144 Hz cadence, two-second minimum, empty-pool/visibility/clock/deadline/cancellation fences, native DOMRect snapshots, hole union/padding, CSSOM token equality, cascade/physical mismatch, viewport-axis refusal, fixed link authority and cleanup.
- `scripts/manual/effect-geometry-1629.mts` runs the actual frame factory, preview listener, geometry and calibration on private loopback servers. Chromium, Firefox and Linux WebKit sample screenshots before/after a real red Canvas Worker: composer/reply/approval pixels and padded edges remain unchanged, ordinary pixels turn red, host clicks pass through, moved trust geometry is respected, stronger positioning and transformed ancestors hide the frame, no style attributes are created, and cleanup removes the frame. It records engine versions and cadence, and closes browsers/listeners/private profiles.
- Linux WebKit is not real Safari. Headless cadence is not a physical display or battery-mode measurement. These tests prove helpers, not product registry/caps, all product trust markers, focus/IME, private Worker resource accounting or host upgrade behavior. Existing worker/factory evidence remains separate.

## Risk and rollback

Conservative viewport/style rejection can hide a valid effect under unusual host CSS. Unknown capabilities remain unavailable instead of falling back to an unclipped frame. These files are unmounted and not in the static asset allowlist; reverting this PR removes the primitives without a data migration, configuration change or startup work. Future wiring must preserve that fail-closed behavior.
