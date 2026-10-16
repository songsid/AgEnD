# Optional personal contribution model (#1629 B2)

This model adds an optional personal source to the existing app-owned pool. The reviewed product bridge now supplies its fixed stock target adapter; see [1629-owner-effect-mount.md](1629-owner-effect-mount.md). The helper still starts no I/O, timer, DOM creation or playback merely by being imported. The fifth slot now supplies an exact id/generation/hotspot receipt for the host cursor; see [1629-effect-cursor-mount.md](1629-effect-cursor-mount.md). Try remains separate work.

## Shared ownership

`createAppEffectRuntime` optionally accepts a host-only `resolveOwnerTarget(slot, manifest, proof)` and an `onOwnerUnavailable(slot,id)` notification. Without the resolver, its existing Chat-only behavior is unchanged. When explicitly supplied, `createOwnerEffectSource` projects only page, header, sidebar and box in that order. Cursor never becomes a Worker descriptor. Sources feed the **same** registry, loader, writer, safety receipts, profiler and caps. This model does not create a second pool or bypass the stock paint proof.

The registry exposes a read-only, non-enumerable `frameRoot` getter for host geometry. It returns its own root, and null after disposal. The source takes fresh stock evidence against this exact root rather than guessing among live and poster roots with the same class. A fixed target resolver must still establish actual stock geometry. Unknown proof or absent/disconnected targets contributes no descriptor. The resolver and metadata are checked again after callbacks; changing the target makes a new binding even when the selected id stays the same.

## Metadata and authorization

There is one pending metadata operation for both Chat placements and personal selections. It calls the existing `placementsSettled` or `ownerSettled`; cancellation cannot free the lane until physical body cleanup completes. If both sources need metadata, the next admitted operation alternates kinds, preventing repeated invalidation of one source from starving the other. There is no timer, polling or autonomous failure retry. `changedOwner()` explicitly invalidates personal metadata and aborts its old logical operation while retaining the physical reservation.

Each personal binding captures a namespaced key, generation, slot, id and target. Resource dispatch is exactly `{id,slot}` through the existing shared loader; it never borrows a Chat instance or selects a scope by id alone. Defaults remain resolved by the existing resource endpoint. A null resource answer latches only that slot as unavailable, preserving the selected id for a later Clear UI. Late failures or successes cannot affect a new target or generation. Existing ACL/unshare rules are unchanged and remain enforced by every runtime resource authorization. A global loader revocation disposes all source kinds in the app episode.

Metadata uses the existing closed owner projection and rejects decreasing revisions. Missing/malformed/failed metadata latches until explicit invalidation. Manual pauses survive unrelated revisions for the same selected id and are reset for a different selection. `pauseOwner` and `resumeOwner` operate on one slot; Resume uses its exact registry key and the existing human safety receipt path, so new metadata does not clear budget-pause history. No preference write, migration, sharing or claim is introduced.

Profile collectors require a current exact binding and registry receipt. Personal reports use the frozen epoch without an instance query; Chat reports retain their captured instance. The existing service independently authorizes these diagnostic writes. Both kinds use current-Chat state/reply and global theme signals already routed by the registry. With no Chat there is no invented agent state. Mention remains reserved and never emitted in 2.3.0.

## Evidence and limits

Source-model tests inject geometry and I/O. App aggregation tests use a fake registry and loader, plus one real-loader late-body cancellation control. The existing real registry suite pins its root lifetime and caps separately. These are not native personal mount or pixel claims. The separate product adapter supplies source invalidation and unavailable/Clear UX, with its own actual-shell native recipe. No agent foreground exception, trusted paint plane or CSS-policy relaxation is introduced.

Rollback removes the optional source branch, its helper and asset entry together. The core can run without the resolver, and stored preferences, claims and profiles need no migration.
