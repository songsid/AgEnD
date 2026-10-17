# #1629 private Trial source in the app-owned pool

> Current integration: [product Try](1629-effect-trial-product.md) connects these foundations. References below to an unmounted or unavailable slice describe its original introduction, not the current feature branch.

This adds no product Start control or preview publication. The existing app core
exposes a private `attachTrial` seam for the subsequent explicit admin controller.
There remains exactly one registry, loader, profiler and safety participant per
app Window. Trial downloads use the existing settled resource lane.

A Trial source requires a checked Start reply, its expected offer token, the
request-entry monotonic `startedAt`, an issued local stage API, and an operation
predicate/stop callback. The app supplies the current Chat owner separately;
caller fields cannot select it. The source copies/freeze-validates metadata,
binds the exact stage identity, forces agent provenance and Chat sample scope,
and preserves the declared manifest layer. Owner placements keep their existing
priority; Trial has no cap or foreground exemption beyond its issued local stage.

The deadline is startedAt + remainingMs, never response time or expiresAt. A
positive remaining budget at response arrival does not authorize a spent request.
Predicates are followed by a monotonic acceptance check. A timer ends the lease;
every descriptor, binding and resource acceptance independently checks time and
current ownership, so a delayed timer cannot extend it. Clock rollback/failure
permanently denies future Trial attachment in this app source.

The issued stage also receives a one-time source lease veto before any frame
exists. It only reduces the original owner's permission and is checked before
and after layout, so the next admission/geometry check refuses a spent lease even with a delayed
timer or a slow marker/layout callback. It cannot be replaced or removed.

Source and stage must both remain current. Unknown CSS, opt-out, hidden state,
changed Chat owner, stage invalidation or a refused resource ends that exact
lease. Stop marks the lease dead, aborts its resource work, disposes physical
stage paint through the issued owner and then notifies host callbacks. A wrapper
cannot substitute its own cleanup function: retirement resolves the private receipt
to its original invalidation closure. Old handles and late completions
cannot stop a replacement. Stage receipts are one-use. A reentrant stop/current
callback that creates a newer contribution defeats the older continuation.

The source creates no Worker/frame or independent capacity. Its read promise
holds the common loader operation through physical settlement. Resource id,
manifest and resolved params must match the checked Start snapshot; failed Trial
reads do not call Chat's refusal path. The registry remains responsible for local
clip proof, shared caps, fresh signals, budget stops and mandatory content-id /
device safety history. Trial samples may enter the transient collector, but are
never POSTed to the ordinary saved-profile endpoint. Ordinary Chat/personal
profile persistence is unchanged.

The app detaches Trial with its captured Chat owner and disposes it on global
teardown. An unsuccessful attach does not take ownership of a caller's stage;
the future controller must immediately close/dispose that stage and stop the
server run. It must also own local-admin admission, late Start cleanup, navigation,
blur, other menu/dialog stops and the host panel UI. None is inferred from display
metadata or a successful parser. No automatic Start or resumed trial is added.

Unit tests use the real source/codec with a branded stage protocol double, plus
app integration doubles for dispatch/collector ownership. The native recipe uses
actual app core, shared loader/registry, real stage/factory/built Worker and actual
Shell/Chat via one private panel-slot overlay. Its auth episode and safety storage
are explicit private fixtures, not proof of product admission or durable safety
transactions. Linux WebKit is not real Safari.
