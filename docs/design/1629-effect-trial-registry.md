# #1629 local Trial admission in the common registry

> Current integration: [product Try](1629-effect-trial-product.md) connects these foundations. References below to an unmounted or unavailable slice describe its original introduction, not the current feature branch.

This connects the [host paint receipt](1629-effect-trial-stage.md) to the existing
allocator and registry. **No product adapter emits a Trial descriptor yet.** It
creates no second registry, baseline, pool, profiler, budget or safety history.
The shared stage helper is now a fixed asset because policy/registry import it;
the host TrialPanel still has no product import.

## Descriptor and admission

A host-only Trial descriptor keeps `region:"chat"` as a **sample binding**, even
when the original manifest declares another placement region. It keeps the real
manifest's `layer` for allocation. Its instance must be the currently open Chat.
It carries the exact nonserializable `trialStage` receipt and its generation,
key/id/instance and stage element. The private identity includes receipt serial
and generation; a replacement cannot inherit a prior run's local failure/pause
identity. The common safety store continues to key budget/crash stops by content
id/device and is never reset by a new trial.

The pure allocator inspects issuance identity; the registry independently asks
for current stage permission at every admission/paint boundary. A forged,
cloned, ended, mismatched or wrong-element receipt is denied. Claimed human
provenance cannot turn a Trial into an owner placement. The only modal exception
is the exact live local sample: global stock `front:false` and
`agentFront:false` remain unchanged for ordinary descriptors. Shared total 3/1,
front 2/1, DPR caps and owner/Chat priority stay intact. Safe mode, public links,
show, motion/data and other global gates still apply. Only an exact live branded Trial descriptor uses
sample-specific click consent plus validated transport readiness. Ordinary descriptors retain HTML-preview
readiness and opt-in even while a Trial shares the same registry. The exception never forces global flags on.

The loader receives the same closed `{key,id,params}` plus AbortSignal. No stage
receipt or geometry is sent in a load payload, API snapshot, mount receipt or
Worker event. Future product adapters must bind that key to the authenticated
server trial/session/epoch; a bare id/paint receipt grants no resource access.

## Lifetime and physical ownership

A stage can remove its DOM frame on blur/Close without waiting for rAF. The
registry subscribes while it owns a slot; invalidation physically removes the
local frame first, then synchronously closes the factory handle, unregisters the
stage subscription and finishes its exact safety marker. Listener exceptions or
reentry do not prevent other cleanup. Retired read requests still occupy the
same physical reservation until their settled promise releases it.

The shared empty-host baseline runs before any Trial load/frame. A fresh local
projection is obtained before the factory appends a frame, and local bind is the
next stage operation: it registers the temporarily unknown iframe before checking
topology. Reveals use local `sync(stock)`, while ordinary geometry retains its
existing `sync(rect,stock)` and trust-hole checks. Invalidation hides both kinds.

Resource acceptance retains the existing monotonic 10-second cutoff, repeated
permission checks around safety callbacks and the no-requestless-loading rule.
Ready, rAF, heartbeat/profile, final event sends and Resume recheck the stage.
A local stage check can invoke host callbacks: private per-receipt recursion and
revision/current-slot fences prevent stale continuation into a replacement.
Ordinary CSS/overlay suppression remains recoverable; it never acquires a Trial
failure latch.

Trial state/reply/theme/env events use the existing closed codec and instance
binding. Mention remains reserved and refused. This sample does not expand the
pointer gate: the ordinary globally-suppressed panel/protected-target rules still
refuse pointer forwarding here. It exposes no keyboard, input or DOM channel.

## Remaining product work and evidence

A future explicit local-admin click/card/driver must use the server API's current
agent ACL, session/epoch and request-start deadline, own its panel and stop on
navigation or other invalidations. Profile samples for Try are transient display
only; the common mandatory crash/budget markers, soft latch and three-pause history
remain mandatory. This PR does not authorize persistence or bypass those checks.

Registry tests model the stage protocol and frame factory; separate stage tests
use real receipt issuance and the real selector matcher. The native recipe
`scripts/manual/effect-trial-registry-1629.mts` uses actual Shell+Chat+TrialPanel
through one private component-slot overlay, the real registry/allocator,
geometry/factory and built Worker response. Its safety store and authenticated
loader are private in-memory fixtures, not product grants or durable-store proof.
Chromium/Firefox/Linux WebKit run at 1366/390 with shared caps, suppressed ordinary
front, empty calibration, marker-before-frame, protected pixels, synchronous stage
retirement, shadow-style loss/other dialog/menu/blur/stale/contain denial and full disposal.
Linux WebKit is not real Safari. Product Try remains unavailable until the
separate card/driver integration is reviewed.
