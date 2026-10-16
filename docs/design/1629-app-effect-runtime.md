# App-owned effect pool primitive (#1629 B2)

This is **unmounted and unserved**. It does not replace the reviewed Chat adapter, load personal selections, run owner effects/cursor/Try, or change product playback. It prepares the single owner required before combining Chat and personal descriptors. The next product bridge must be separately reviewed.

## Ownership

`createAppEffectRuntime({window,current,observe,onChange,factories?})` freezes the existing server-rendered person/operator epoch, subscribes to auth-end and pagehide before async admission, and owns exactly one registry, loader, writer, safety provider and profile receipt map. No Chat contribution means no metadata/resource read. A WeakSet allows only one owner attempt per Window episode, including after disposal; BFCache must not recreate that episode. Identity refusal creates no participant.

`attachChat({name,element,current,observe,onChange})` returns a route handle. Detach/replace first retires the old contribution; it does not dispose/recreate the app pool. Page-level `changedChat()` and `reply(event)` forward only to the current contributor, for the one app subscription. A handle's `dispose`, `changed`, `pause`, `resume`, `reply`, `remove` and `snapshot` are fenced to that exact contribution. Existing manual pause/provenance/params behavior stays scoped to its Chat lease. Page/session end disposes the whole pool once, continuing other cleanup if one participant throws.

The future bridge must synchronously detach on navigation before asynchronous panel loading, and attach only after committed DOM under the new route lease. It supplies current page gates, CSS lifecycle, theme and current Chat state, and notifies `sync()` when those change. Structural proof never supplies identity/consent. It must preserve the anonymous/public import boundary and must not retain the legacy private Chat pool alongside this owner.

## Requests and scopes

A single physical metadata operation survives route cancellation until `placementsSettled` finishes. A new route waits rather than mistaking logical cancellation for free capacity. `resourceSettled` similarly keeps the registry's existing physical reservations meaningful. No new scope, endpoint, polling, retry, capacity or timeout is introduced. A hung operation that ignores abort remains reserved; UI teardown must not await it or build a replacement pool.

Each descriptor has a route-serial key and a private immutable binding containing its exact source and generation. Resource and profile dispatch require that current key/id/binding; they never choose a scope by id alone. Old successful or failed reads for the same content id cannot publish into or fail a newer route. Revision and abort fences reject stale metadata. A current source failure latches that contribution; another route can reuse the same pool, while an internally revoked loader cannot issue further reads. Only one Chat source exists in this slice; future personal aggregation must keep global auth revocation across all contributors.

Profile collectors require the exact current registry receipt and binding. Writes retain the frozen epoch and captured instance; responses never grant authority. State/reply originate only from the current contribution; only closed state and boolean reply/theme signals are published. The caller still must use the existing fresh-only reply store. Mention remains reserved/not emitted. No new names, identity or manifest text are added to event fields; the existing current-Chat instance tag remains owned by the registry codec.

## Reentry and evidence

Every route/metadata/descriptor change invalidates its prior pass. Reentrant attachment during retirement or observation abandons the old continuation and schedules one new sync; an old handle cannot retire the replacement. Current predicates are checked again after callbacks, so disposing inside a predicate cannot return an old valid source. Source signatures preserve unrelated manual pauses and resolve Resume by namespaced registry key.

Offline tests mock registry/frame/cap internals and state that limit explicitly. They pin one constructor across handoffs, identity refusal, physical held reads, same-id key/scope isolation, stale metadata/resource/remove/profile completions, auth/pagehide/BFCache/route teardown, source failure, pause/params, closed events, observer/retirement reentry and partial setup/cleanup. A real loader plus fake registry additionally proves held late-body cancellation serializes metadata across Chat handoff. Native mounting/shared cap/render evidence remains a later product-bridge obligation, using the already reviewed registry and stock proof.

Rollback removes this unused module and tests. No current product importer, served asset, stored state, migration, permission or CSP change is included.
