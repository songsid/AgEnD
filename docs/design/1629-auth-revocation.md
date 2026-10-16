# Page-local auth revocation observation (#1629 B2)

The existing shared auth bridge exposes `onSessionEnd(fn)` and
`sessionEnded()`. This is a synchronous, observation-only prerequisite for
future runtime teardown. It grants no server authority and mounts no effects.

The first explicit sign-out attempt closes the page episode before its first
await or network request. A same-origin non-auth data response with status 401
also closes it before the existing session-ended banner or returning that
response. The bridge's own native `/auth/session` read closes it on 401 without
adding a banner path. External responses, auth/login refusals, 403/404, network
errors and other server failures are not classified as session end.

Each active subscriber receives the same frozen `{ reason }`, where reason is
`sign_out` or `unauthorized`. No owner, epoch, cookie, token, CSRF value or
response content is exposed. Unsubscribe is idempotent. Listener exceptions
cannot suppress another cleanup; late subscribers observe the closed episode
immediately. The page cannot reopen it through this API. Existing CSRF/session
caching, logout request, redirect and durability-warning behavior remain.

A future runtime subscribes before admission, checks the closed state, and
tears down its loader, frames and pending generations on notification. This
local observation cannot detect remote expiry before an authenticated response
or recall code already delivered. Server epoch/ACL checks remain independent.
SSE connection end is a separate existing signal. The runtime must also clean
up on pagehide; BFCache pageshow requires fresh runtime ownership and
revalidation, rather than treating pagehide itself as permanent auth expiry.

Tests evaluate the actual bridge with inert fetch/DOM boundaries, held requests,
throwing/reentrant observers, and normal CSRF/logout controls. No real account,
fleet, browser or persistent auth format changes are introduced. Rollback is to
remove this observation seam and its future subscribers together; never bypass
server authorization when a local observation is unavailable.
