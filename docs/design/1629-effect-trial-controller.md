# #1629 explicit Trial control lane

> Current integration: [product Try](1629-effect-trial-product.md) connects these foundations. References below to an unmounted or unavailable slice describe its original introduction, not the current feature branch.

This is an unmounted controller. No product card starts a trial yet. It creates no
frame, placement, saved profile or offer; the caller supplies the host panel
mount and its cleanup function. The next integration must wire this only to an
explicit signed-in local admin click and preserve the existing stage/pool proof.

The display hint comes from the existing `/auth/session` response's tier, surface
and handle. `AgendAuth.trialSession()` returns only `{epoch, localAdmin}`, frozen,
from the same cached session read as CSRF. Unknown surface, read tier, malformed
handle or an ended episode never becomes local admin. This is UI information;
the existing Start endpoint still authorizes the actual current local admin and
rechecks the session after its bounded request body. No new server permission is
introduced and no hostname or web display name is treated as proof.

One controller and one physical control operation exist per Window episode.
Admission claims the lane before awaiting session information. Start is fixed
same-origin JSON with the captured epoch; it uses the normal CSRF-wrapped fetch.
The startup deadline is ten monotonic seconds from entry, including session and
body waits. A logical stop/timeout returns false immediately but does not release
a pending session read, fetch, body or cancellation. Another click is refused
until that physical operation and any queued cleanup settle; it is never queued
to start later automatically.

A checked Start reply can be mounted only while the original request, Chat owner
and gates are current. Its lease ends at request-entry time plus remainingMs,
not response time or wall-clock expiresAt. A valid late reply is used only for
one best-effort Stop. Stop removes host paint synchronously through the supplied
mount disposer before issuing cleanup I/O, and consumes the same lane. Its
response is cancelled without reading any grant or data. There are no automatic
network retries. If a malformed/refused reply never supplies a checked run id,
there is no safe id to clean up; the server's volatile offer/run expiry remains
the bound. A blocked physical cleanup intentionally denies more starts.

Window blur, pagehide, hidden state, session end, explicit Stop and a failed
current/gate predicate stop the operation. The product bridge must call sync on
route, menu/dialog and effect preference changes, and pass predicates that check
those states. Synchronous predicate reentry refuses and ends the older operation;
it cannot recursively validate itself. The existing local stage independently rechecks its own paint
boundary. A mount callback must clean up partial work if it throws; if it returns
a disposer after synchronously stopping/replacing its operation, the controller
runs that disposer immediately rather than retaining it.

Automatic Trial Stop POSTs do not slide session idle expiry. This changes touch
classification only: their existing CSRF, Origin, local-admin and exact session /
epoch checks remain. Start is still an explicit human activity. No browser or
product-click claim is made by this controller's protocol-double unit tests.
