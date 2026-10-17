# Shared Canvas Worker registry (#1629 B2)

This is an unmounted integration primitive. No product page imports it, no static asset is added to the public allowlist, and no concrete human preference, safety/history/profile store or HTTP route is added here. Product wiring remains a separate step.

## Admission and ownership

`createEffectRegistry` owns one pool per Window. Its host options include the verified preview origin/boot, an authenticated bounded loader, current stock paint snapshot provider, synchronous safety participant and display/profile callbacks. The registry creates its own viewport layer under body; code from a bundle never supplies a DOM node, origin, descriptor identity, ownership or geometry.

`update(descriptors, context)` takes host snapshots. Each descriptor names a host key, immutable content id, region/layer, host-recorded `by`, order, pause/visibility state, instance binding, typed parameter overrides and host region element. The pure reviewed policy decides scope, priority, 3/1 total and 2/1 front caps. Queued/off/unknown entries have no frame and start no loader. Widgets remain host drawn and consume no effect slot. Unknown provenance keeps agent restrictions.

A descriptor identity or owner/region/element change revokes its old slot synchronously. Late resource bodies cannot publish under another identity. Requested overrides must match the returned resolved parameter values and the returned id must match. The frame factory independently bounds/snapshots the payload and owns its exact-source/null-origin/boot/private-port/ready-only fences.

At most the selected pool's physical loader requests can be outstanding. Aborting or timing out a request does not free that reservation until its promise settles. A ten-second monotonic deadline aborts and latches an unknown/hung resource; failed identities do not retry forever through ordinary updates. Disposal keeps the Window reservation while physical requests remain unsettled. The host loader must bound the authenticated fetch/body and honor AbortSignal; the registry never adds a retry or resend policy.

Resource completion independently checks that deadline, including the exact ten-second cutoff, before a marker or frame can be admitted. A delayed deadline timer cannot extend admission; time spent in synchronous safety/coverage callbacks counts too. A still-owned completion refused by coverage or gates is retired into a terminal `admission_revoked` identity, with its owned marker cleared. It cannot retain a requestless loading slot or automatically retry through identical updates. Physical read capacity is released only by promise settlement.

## Before any frame

- All global gates must be known and allow effects: safe mode, public link, reduced motion, save data, show/enable/preview/opt-in and current chat. Hidden documents never start a new load or frame.
- `stockSnapshot({ frameRoot })` must prove the **complete host marker inventory and host layering**, including behind effects below host content and front effects below/protected from menus/dialogs. It returns explicit `ok/front/agentFront/rects` evidence, never a literal boolean; see [the current admission contract](1629-effect-stock-admission.md). The private native fixture supplies a small explicit UI stacking model and its own three markers; that does not establish the product's coverage.
- MutationObserver and ResizeObserver are required. Observe current host roots/trusted elements without disconnect/re-observe feedback. Mutation/scroll/resize hides immediately, then a host rAF recalculates bounded geometry before reveal. Moving CSS geometry is measured each rAF. Unsupported or unknown geometry removes the frame.
- Capture a visible two-second cadence with zero effect frames. Identical updates/observer notifications retain that one measurement. Device-class change and explicit human Resume remove the pool and measure again. No author, child message or saved profile provides the baseline.
- Positive synchronous safety receipt before factory creation. Create and bind happen in the same synchronous host task; any refusal immediately closes the factory handle and geometry. Marker cleanup failure removes the pool and refuses further admission.

## Safety participant seam

All methods are synchronous and called with their original receiver. A Promise, exception or unknown result is not success.

- `allowed(id, device): boolean` refuses unknown storage, unresolved interrupted probation, soft pause or sticky off.
- `begin({key,id,device}): string | failure` persists the probation receipt **before** a frame exists.
- `finish(token, reason): true | failure` clears that exact marker after controlled teardown or five continuous observed healthy seconds. Unknown cleanup stops admission.
- `pause({id,device,reason,metrics}): true | failure` persists a soft pause and the reviewed history policy. Simultaneously paused copies of the same id/device count once per incident. Different content ids are independent.
- `resume(id,device): true | failure` is for the host's explicit human Resume action only. It may clear a soft pause, never sticky off. Agent descriptor updates cannot revive a failed/paused identity.

A concrete participant must implement durable history/probation and the three-pauses/24-hour policy using the reviewed pure policy, with explicit failure semantics. None exists in this PR. The registry cannot mount in product without it. Private browser tests use an in-memory fixture participant, not a persistence claim.

When a budget pause frees a slot, another eligible queued effect may enter according to the reviewed allocation policy. A per-effect pause is not a global fleet/effect shutdown. The native budget scenario deliberately isolates the observed effect before applying host load so it checks that effect's pause and non-revival, rather than miscounting a queue replacement.

The mount observation/revalidation extension is documented in [frame lifecycle](1629-effect-mount-lifecycle.md). It does not enable product playback.

## Host observations and signals

The real `EffectBudget` observes host rAF cadence and, where supported, host long tasks. Only a matching host-generated frame container id can establish task attribution. No container URL/name, child timing, pong or private Worker CPU/GPU/memory data is read. Unknown attribution stays unknown. The frame load is a host DOM observation. A ready signal proves initial readiness, not ongoing Worker health.

The profiler degrades before pausing; pause physically removes the factory and releases geometry. Hidden immediately stops event forwarding and hides, with a bounded ten-second removal timer independent of rAF. Hidden/bad intervals reset the five-second probation clock. Returning before the deadline resets the pure profiler's hidden warmup; it does not learn a new baseline from active effects.

`publish` accepts only content-free state/reply/theme signals. `mention` remains reserved in the codec but is never emitted in 2.3.0 (follow-up #1963). Own-instance and wants fences remain at the factory. Owner-region pulses use the currently open chat without exporting another instance's identity. Raw pointer publishing is refused.

Native pointer listeners read only type, trusted-event flag, client coordinates, buttons and bounded wheel deltas. Unknown/typing focus, designMode, modal, trusted target, outside-region or viewer gates suppress them. One local packet per frame/rAF, with the degraded 30 Hz/normal 60 Hz bound; no keys, input text, selection, message bodies, file or URL data enter the API. The host never forwards arbitrary DOM events. Since #2057, a fresh pending discrete event takes priority over later movement; movement replaces movement, and later discrete input replaces earlier discrete input (down/up/click deliberately coalesce to the final click). Waiting for the send interval never refreshes the original 100ms expiry.

## Verification and limitations

Unit tests use the real registry/policy/profiler and mock only the browser factory, geometry and baseline boundary. Separate accepted suites cover those primitives. The checked-in native recipe uses the actual registry, helpers, frame factory and built preview listener on private loopback servers, with Chromium/Firefox/Linux WebKit. Its explicit UI layering, 3/1 and front 2/1 caps, probation-before-frame, empty-pool calibration, trusted pixels, click-through, opt-out and host-jank pause are observable; its safety participant is intentionally in-memory. Chromium's constrained case uses 4x CPU throttling; other engines do not claim that capability. Linux WebKit is not real Safari.

Private Worker CPU/GPU/memory/liveness are not measurable through this ready-only channel. Unrelated host load can conservatively pause a light effect. Product trust markers, authenticated placement/resource projection, concrete safety/profile persistence, Settings/Try surfaces and the final application boot/teardown remain required before product mounting.

## Risk and rollback

Unknown surfaces, storage, capabilities or ownership refuse admission. Conservative host jank or geometry rejection may pause/hide a valid effect. The unmounted module has no configuration/startup/data-format changes; revert it without a migration. Dispose removes frames and observers/listeners/timers, and aborts outstanding loader requests; physical request reservations are released only when those requests settle.
