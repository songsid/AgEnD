# Current stock paint evidence at admission (#1629 B2)

This changes unmounted primitives only. No product asset, authenticated loader, event adapter or effect mount is enabled.

## One host snapshot

The registry now requires `stockSnapshot({ frameRoot })`, replacing the former boolean `trustComplete`. The argument contains its actual private body-child layer, not a descriptor-supplied root. The provider is synchronous and observational. A product provider must call the reviewed stock inventory with this root and the current owner-CSS lifecycle. A literal boolean, Promise, missing field, exception or malformed snapshot grants nothing.

The accepted result is `{ ok: true, front: boolean, agentFront: boolean, rects: PlainRect[] }`. The stock inventory's optional `reason`, `agentReason` and `settingsHref` fields may accompany it; bounded display metadata is dropped from the paint proof. `agentFront: true` requires `front: true`. At most 128 rectangles are copied from own data properties, with finite coordinates/dimensions bounded to 10,000,000 and nonnegative dimensions. Accessors, sparse arrays, extra keys, symbols and DOMRect prototypes are refused without invoking getters. Every copied rectangle, the array and the proof are frozen.

Behind effects require `ok`. Human fronts additionally require `front`; agent/unknown-provenance fronts also require `agentFront`. Thus owner CSS on/loading/unknown leaves human front choices exempt from the agent-only restriction, while stock overlay suppression still applies to both. Rejected fronts do not consume the total/front pool or reserve a loader. The registry reports `owner_css` or `stock_overlay` when that predicate is the reason for exclusion.

A provider must return fresh observations each call; the type cannot prove freshness or stock inventory completeness. Product adapters must never cache a successful snapshot across tasks or substitute an empty list when observation fails. The pure fixture provider in the registry's browser recipe is not evidence of the full stock UI.

## Revalidation and paint

The registry rechecks before a resource reservation, at resource acceptance, after its synchronous safety callbacks and before a frame is admitted/revealed. The existing exact ten-second monotonic cutoff and physical read reservation survive unchanged. A refused still-current completion retires and latches, clearing its exact owned marker; no requestless loading slot or automatic retry is introduced.

Each host rAF takes one fresh copied stock snapshot and passes that same proof, including the inventory's expanded paint bounds, to every eligible geometry binding. `binding.sync(regionRect, stock)` hides before checking the proof and independently enforces layer/provenance eligibility. There is no `[data-trust]` border-box fallback and no default empty rectangle list. Agent fronts clip the same expanded bounds, plus the existing union/padding policy. Human fronts and behind layers retain their existing no-hole behavior, but cannot reveal without the required stock evidence. Currentness, geometry/cascade/physical checks and event instance/wants fences remain required.

Descriptor updates and DOM/resize/scroll/focus invalidations hide first. Focus-in/out observation also wakes a temporarily suppressed empty pool without requiring a DOM mutation or descriptor write. A running placement denied by a valid transient CSS/overlay policy is retired without an identity-failure latch; it can re-enter when a later host observation permits it. Refused resource completions keep the existing terminal admission semantics. Signals recheck the current per-placement permission. A stopped or disposed owner cannot use a late proof. A provider that reenters `update`, `resume`, or an invalidation is a broken host contract: the registry hides/removes its pool and latches `stock_reentrant` until disposal/recreation. It does not invoke a callback retry loop or apply an old observation to a newer proposal. Read-only `snapshot()` is allowed. A provider may dispose its owner; its return is then discarded.

## Scope and rollback

The actual Shell browser recipe now passes the real stock snapshot directly into geometry, removing its previous synthetic query-selector bridge. The independent geometry and registry recipes explicitly construct fixture evidence and remain helper-level tests. No real account/fleet/service or default tmux is involved.

The stock inventory now covers Chat and the closed Fleet/Needs/Settings/View/Log/Details producers (#1973). The app-owned Chat bridge, owner-CSS explanation, lifecycle and session fences are separately reviewed integration (#1976). Personal regions/playback and Try still require their own adapter review. This proof codec cannot establish identity, consent or any of those integration guarantees by itself.

Conservative checks may make effects unavailable for a faulty host provider. Reverting the primitive/API change and its updated callers together restores the earlier unmounted implementation; there is no durable data migration. Do not mount a product adapter against the old boolean or border-box fallback.
