# Directory settings: browser authentication and transition

This is the internal browser participant for [#3425](https://github.com/songsid/AgEnD/issues/3425). It extends the existing sealed writer and its root SQLite decision. It adds no settings HTTP endpoint, second file writer, directory authority, or host recovery session.

## Authentication evidence

`HubSessions.signIn` writes `hub_session_authentication` in the same unit of work as the person, session and required sign-in audit. Its timestamp is the conservative start of the successful trusted-directory sign-in. Updating `seen_at`, reading the session, checking eligibility and rotating a cookie do not create or refresh this evidence.

`HubSessions.recentAuthentication(actor)` accepts only the configured administrator's exact active session and mounted directory epoch. Authentication must be no more than five minutes old, with a sane clock and current absolute/idle lifetimes. Sessions from before this schema have no attestation and must reauthenticate. This is the concrete optional server attestation for `settings-directory-proof.ts`; the proof controller still owns fresh eligibility, exact immutable candidate identity, trust consent, source image, actor, epoch and deadline checks. A timestamp is never accepted from a browser body.

`s5-session-authentication` is a required schema component. An older binary refuses a database carrying it. Preserve a pre-upgrade state backup before attempting an older binary; do not delete schema rows or rewind epochs. A legacy session without an authentication row remains an ordinary session, but cannot attest recent AD authentication.

## Request-local successor

After the authenticated, same-origin, CSRF-checked save request has proved its actor, the future route calls `HubSessions.prepareDirectoryRotation(token, actor)`. The returned handle binds the exact owning SQLite connection, Hub, person, session, request, source epoch, token hash, creation time and absolute expiry. It creates a new random token in private request memory. The public handle has only `discard()`; candidate/body data cannot manufacture its WeakMap proof.

Pass that handle separately as the optional fourth argument to `proof.apply`, then to the existing directory writer's `commit`. It is not a candidate field, preparation reference, journal field or HTTP response. The writer forwards it to the existing `decision.decide` participant.

The SQL participant consumes the handle before callbacks. Inside the existing root IMMEDIATE transaction it rechecks the source session, then rechecks after the required audit and final proof. The shared writer returns its final writer-owned timestamp to the session participant; there is no additional application clock callback after that proof/material/time check. Direct internal decision tests without a writer sample the session clock before final SQL image rechecks. After that, only synchronous SQL and copied values remain: advance the browser epoch, end every old active session, insert one successor for the initiating admin, and publish the durable head. The operation records a versioned old/new session-ID binding; it records no token or CSRF secret. All operation, binding/version, notice, audit and session changes share the same COMMIT. A late refusal rolls SQL back while preserving an already raised floor's uncertainty.

The new session keeps the previous absolute expiry, has a new token/CSRF and new idle window, and has **no** recent-authentication row. It is not a new directory sign-in and cannot authorize another AD edit using the predecessor's authentication. Host recovery supplies no rotation handle and creates no administrator session. Compensation also supplies none and advances forward, invalidating a pending successor rather than reviving it.

## Mount and response seam

The old mounted `HubSessions` cannot complete the transition. Once the concrete composition has installed the decided files and mounted the exact durable generation, its **new** `HubSessions.completeDirectoryRotation(handle, operationId)` can release the token once. It checks the new core's lifetime and epoch, exact durable operation/head and browser-session binding, current configured administrator, active successor row, token hash and deadline. The route sends the resulting cookie only on the original response. An old cookie cannot retrieve it, and there is no lookup endpoint.

The full installed-image mount barrier is still the responsibility of the forthcoming composition: its core lifetime must require `mountedGeneration === durableSettingsHead` and the verified decided material. Constructing an arbitrary new core at the new epoch is not itself proof of a successful mount. This slice tests the epoch/lifetime/operation release contract, not that forthcoming production barrier.

The route must discard the handle when a response is abandoned or installation/mount fails; after SQL COMMIT, it must still let the shared writer finish/recover the physical operation. Plaintext is never recoverable after a process crash. A crashed request may leave an unreachable hashed successor row, which expires normally; the user signs in afresh. Files, receipts, operation payloads, audit and notice outboxes cannot regenerate a cookie. The independent failure/compensation policy remains forward-only.

## Evidence boundaries

`hub-directory-session-transition.test.ts` uses an owned, CA-verified HTTPS listener, private WAL/FULL SQLite, real Hub session routes and fake people/directory results. It checks held old-directory sign-in, two old browsers, new token and CSRF, pre-mount lifetime refusal, audit-time source/time invalidation, single-use handles, physical DB/listener reopen, discarded responses, host recovery and required-schema downgrade refusal. Two cases also use the actual sealed-settings writer, real keys/seal/private staged material, and its interruption/recovery point immediately after SQL decision. The fake config writer publishes only an in-memory Hub block; it is not FleetManager acceptance.

No public AD/setup route or UI is exposed by this slice. Concrete source/material adapters, full FleetManager mount publication, durable notice delivery and initial web setup are subsequent work. There are no real directory, pilot, account, service-manager or native operations in this evidence.
