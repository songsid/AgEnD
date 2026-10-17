# #1629 Trial response projection and shared resource reads

> Current integration: [product Try](1629-effect-trial-product.md) connects these foundations. References below to an unmounted or unavailable slice describe its original introduction, not the current feature branch.

This adds no product Start action, offer producer, request controller or Trial
source. It prepares the existing runtime loader for the subsequent app-owned
lease. The card is still inert and the preview tool is still unavailable.

`checkEffectTrialStart(input, expectedOffer, expectedId)` snapshots and freezes
the closed server Start reply: trial token, matching closed offer, positive
integer `remainingMs` at most ten minutes, CW1 manifest and resolved parameters.
It reuses the authoritative browser manifest/parameter/Unicode rules and requires
the manifest title to match the checked offer title. It neither starts nor
proves local-admin authorization. It evaluates no script and accepts no URL.

The future click controller must establish current verified local-admin session
admission before POST, recheck session/epoch/navigation/operation after every
await, and use **request-entry monotonic time + remainingMs** as the conservative
lease deadline. Response time and the offer's wall-clock `expiresAt` cannot
refresh it. A late successful Start must be stopped, never mounted. None of that
lifetime behavior is claimed by this pure projection.

`trialResourceSettled({trial,id,instance}, signal)` constructs only
`/ui/effect-trials/<trial>/resource?instance=<encoded>&ownerEpoch=<captured>`.
The closed request is copied before its first asynchronous continuation. The
expected content id independently checks the ordinary bounded CW1 resource
projection; host poster/cursor bytes do not enter the Worker asset list.

This read uses the **existing `resource` lane** in the same loader, alongside
ordinary Chat and personal resources, at most three physical operations in total.
Its promise settles only after body cancellation/cleanup. Logical cancellation,
expiry and disposal cannot release a pending physical reservation. The existing
ten-second monotonic deadline is checked after every await, including cleanup;
late timers cannot extend acceptance. No separate loader, queue, retry or ACL
fallback is created.

As on existing runtime reads, a 401/403/409 terminally revokes the whole loader
and aborts peer operations. The trial API uses private 404 for an expired,
unshared or otherwise unreadable offer/run; that only refuses this read and does
not borrow an ordinary placement's retained rights. This conservative shared
revocation behavior is unchanged. The future app source must retire its Trial
binding after a refused read; it must not fail an unrelated Chat source.

The tests use the real shared loader and pure server-valid manifest/default
validators with mocked fetch responses, private clocks and held cancellation.
There is no browser, actual account/session, live fleet, frame, Worker or product
mount claim in this foundation. Shared safety markers/history and transient-only
Trial diagnostics remain required in the later app adapter.
