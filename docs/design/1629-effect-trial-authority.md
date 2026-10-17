# #1629 volatile Try authority

> Current integration: [product Try](1629-effect-trial-product.md) connects these foundations. References below to an unmounted or unavailable slice describe its original introduction, not the current feature branch.

This records the authority foundation introduced without product imports in #1984.
The [server adapter](1629-effect-trial-api.md) now connects it to the Fleet library
and local-admin HTTP routes. No tool issues an offer, no card starts a trial and
no frame is mounted yet. The preview tool remains unavailable until the card and
physical stage have separate integration and review.

## Approved exception and required future mount

The local-stage proposal is [#1629 comment 6225128811](https://github.com/songsid/AgEnD/issues/1629#issuecomment-6225128811),
approved by the leader in `xmsg-1792186486254-o7dp97`. It permits a bounded visual
sample inside its own host panel or sheet. It does not change the ordinary paint
planes or enable the deferred global foreground plane (#1940).

Only an explicit click by a signed-in **local admin** may start a trial. Never an
agent, public-link visitor, header token, read-only session or automatic preview.
The host owns the visible Trial label and Stop control. Closing its panel/sheet,
navigating or window blur stops the trial; another menu or dialog opening stops
it too. No automatic restart follows those stops. Ordinary foreground effects
remain suppressed while that panel/sheet is open.

The stage must be physically inside that panel/sheet, with `contain: paint` and
`overflow: clip`, and native tests must prove paint cannot escape. No portal or
overlay, focusable mod element, DOM effect script or expanded pointer boundary.
Worker code, the opaque shim and ready-only input remain unchanged. Trials must
join the **same** caps, profiler and safety stops as the app's other effects; they
cannot allocate a second registry to reset capacity. Owner CSS on, loading or
unknown refuses the trial (including a human initiating it). These are future
mount prerequisites, **not** guarantees established by this server-only PR.

The sample may display an effect declaring any region/layer inside the bounded
stage. It does not promise the final placement's position, paint order or pointer
behavior. A Try is not Apply and creates no saved placement.

## Server boundary in this PR

- One `WebEffectTrials` owner registers `effect-trials` with the library **before**
  that library is published or collected. A duplicate registry is refused. The
  Fleet owner is responsible for construction, disposal and reference provider
  ordering, implemented by the separate server adapter.
- `offer(instance, id)` verifies a known origin and the agent's current own/shared
  library access. On future tool wiring, appearance locks and agent-edit policy
  must be checked first. At most one live offer per instance and 128 globally;
  same-id repetition is idempotent, returns `created: false`, and does not extend
  its deadline or require a second chat card. No new shared limiter bucket is
  introduced here.
- Offers expire at exactly ten monotonic minutes without a timer. The display's
  wall-clock `expiresAt` never authorizes access. Admission and reads check the
  monotonic deadline after host/library callbacks too. Invalid/backward monotonic
  time permanently denies this owner and makes reference enumeration throw, so
  collection cannot interpret uncertain references as absent.
- `start(offer, instance, actor)` is for a future **CSRF-protected POST** after that
  explicit click. Routes must build a fresh actor from the real session verdict:
  local/admin/session, `SessionRecord.idHash`, its handle as epoch, and the current
  `webPersonKey`. Neither request JSON nor a web display name supplies this actor.
  Custom CSS must be authoritatively off. At most one trial per session and 128
  globally. A new start replaces only that session's previous trial.
- `read(trial, instance, actor)` binds all of session hash, epoch, person and origin
  instance. Every code, image or profile authorization must call it with a **fresh**
  verified actor, after awaits as needed. It independently calls `library.read`
  as the origin agent every time. A person's own private claim never substitutes
  for that agent's permission. Unsharing therefore refuses the next read even
  when the offer still retains the bytes. No `readReferenced` access shortcut.
- Session hashes/epochs/persons stay internal, never in the offer or chat history.
  An explicit web-only operator session is allowed but remains bound to its own
  session/epoch; this is not a new shared capability. Unknown/stale tokens and
  ineligible actors receive the same unavailable answer.
- `stop` permits the authenticated owner to clear its trial even if CSS became
  on/unknown. It does not clear another session or create a replacement. Offers
  may continue retaining bytes until their original deadline. `dispose` clears
  volatile authority and unregisters the reference source; only the Fleet owner
  may end it. No automatic collection occurs inside this module.

The host actor is an internal service seam, not a cryptographic object. These
checks do not replace route authentication, session revocation, Origin/CSRF,
fresh authorization after asynchronous work, consent, or physical stage proof.
Those adapters must be tested before product use.

## Display codec and persistence

`effectTrialOffer` accepts exactly `{v, offer, id, title, expiresAt}` as own,
enumerable data properties. It rejects getters, inherited/extra/symbol keys and
copies/freezes the output. Display text matches the normalized CW1 contract:
1–40 graphemes, at most 400 UTF-16 units, NFC and safe one-line text. A 32-hex
offer id is random display metadata, never sufficient authority to read code.

Future chat integration uses a dedicated host-issued status field on separate
lines beside buttons/click metadata, an `agend…` sender, and an independent card
branch. It must require host status plus the exact origin instance. Ordinary
reply buttons, `/ui/reply-button`, agent/user text and parsed markup cannot start
Try or manufacture this field. Public/read surfaces may show a noninteractive
local-admin-only notice, never the start control. Keep it out of reply-buttons.db.

History's explicit `stored()` allow-list and `restoredRow()` must omit the field:
no disk persistence and no interactive restore. Those history tests and browser
card behavior belong to the later adapter PR. The registry itself has no file
I/O, preferences, claims, export, share or placement writes. Its observational
provider retains each live offer's id until expiry/replacement/disposal; a
reference is byte retention only. Failed/uncertain clocks retain conservatively.

## Evidence, limitations and rollback

Focused tests use a real private-FS library and mock only clocks/known-instance
policy. They cover identity, all denied actors, current agent ACL/unshare, TTL
cutoffs without timers, idempotence/replacement, reference/delete behavior,
bounded capacity, duplicate owners, clock rollback and closed display data.
They establish no browser clipping, focus, native decode, route or product-mount
claim. The next PRs must add those tests before enabling Try.

Risk: a live offer retains a small bounded blob until its original expiry even
after a viewer stops. A failed monotonic clock leaves conservative references
until the library owner ends. This consumes no durable upload claim or new
on-disk quota, and creates no export authorization. Revert this isolated module,
tests and documentation; no data migration or preference rollback is needed.
