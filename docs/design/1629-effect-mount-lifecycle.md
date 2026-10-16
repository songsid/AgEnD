# Effect mount observations and browser safety (#1629 B2)

These are unmounted registry/participant seams. No product import, static asset,
route or playback is added. The authenticated loader and page/session adapter
remain separate work.

## Per-frame ownership

After the registry has persisted probation, created the factory, bound geometry
and successfully synchronized the first stock proof, `onMount(owner)` receives
one frozen host object: `{key,id,device,current()}`. Its identity belongs to that
actual frame, not merely a content id or placement key. Identical descriptor
updates retain it; replacing/removing the frame revokes it. A remount of the same
id/key gets a new object. Failed admission creates no mount receipt.

`onProfile(snapshot, owner)` carries the same object separately from the closed,
content-free measurement snapshot. A future adapter must create a fresh collector
per receipt, check `current()` before/after asynchronous work, and discard stale
results. It must not append the function/receipt to Worker messages or server
report schemas. This is local ownership evidence, not a session authorization or
an atomic server receipt: a diagnostic report already accepted by the server
cannot be recalled by a later local teardown.

`onRetire(owner, reason)` runs once, after local revocation, physical frame and
geometry removal, and attempted probation cleanup. `owner.current()` is already
false. Display/diagnostic exceptions cannot prevent cleanup or authorize code.
Observers may cause host updates/disposal; existing revision/current-slot fences
still apply. Every retirement pass abandons its stale continuation if a callback changes the revision or disposal state: an outer empty selection cannot retire a sibling retained by a newer nested update, reset its baseline or measure it using the old pass. Bulk cleanup, resume, hidden transitions, rAF, heartbeat and publish loops follow the same fence. A failed pre-mount admission has no invented retire notification.

## Storage changes and foreground recovery

The registry rechecks the synchronous `safety.allowed` receipt for current slots
on native storage events, visibility changes and each existing one-second host
heartbeat. `revalidateSafety()` is also available to the host's recovery adapter.
It never reads storage event values or accepts a frame message as authority.
Unknown/denied safety physically retires the frame as `safety_revoked`, latching
that identity until explicit human recovery; repeated descriptor updates do not
retry it. Reentrant safety reads cannot act on a newer revision. Dispose removes
the listeners. Background browser throttling is not a real-time deadline promise;
foreground handling revalidates before normal scheduling resumes.

A browser safety participant checks that every still-owned probation record is
present with its exact original bytes on each namespace read. Deletion/editing,
including a second tab's explicit Resume removing a foreign marker, permanently
revokes the old participant. Repairing the bytes does not restore it; reload is
required. Healthy cleanup by the owning participant removes its own receipt from
memory and does not trigger this fault. This conservative policy prevents a live
old page from silently treating a removed trial as healthy. It preserves the
existing append-only history, human Resume and three-pause sticky-off semantics.

## Device bounds and verification

Initial render and later env signals clamp host DPR to 1.5 on constrained devices
and 3 otherwise, preserving the existing 0.5 lower bound. Authors never choose
the device class or budget.

Unit controls cover callback order/currentness, remount isolation, exceptions,
failed admission, teardown, storage/foreground/heartbeat revocation, reentry,
DPR bounds and real participant byte fences. Native recipes exercise actual
registry/factory/preview ownership and independent real localStorage participants
in Chromium, Firefox and Linux WebKit, on private loopback origins and browser
contexts. The registry recipe's safety adapter remains in memory; the separate
storage recipe does not mount frames. Linux WebKit is not real Safari.

## Risk and rollback

Cross-tab edits or recovery can conservatively stop a valid old page; show a
reload/recovery explanation in the later product adapter. There is no new storage
format or migration. Revert these unmounted seams without enabling any fallback
that treats missing/unknown safety evidence as healthy.
