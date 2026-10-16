# Shared loader terminal episodes and owner settlement (#1629 B2)

The app pool has one loader and frozen session epoch. A rejected authorization must end that entire episode, rather than only clear the Chat contribution that happened to make the request. This is required before combining owner and Chat contributions.

`createEffectRuntimeLoader` accepts an optional host-only `onRevoke({reason})`. The frozen payload has one closed reason: `authorization_rejected` (HTTP 401/403/409), `clock_unavailable`, or `owner_unavailable`. It contains no response text, identity, URL or effect data. Terminal state is latched before notifying, so a reentrant read is refused. A throwing listener cannot restore authority or stop cancellation of other operations. Notification happens once; manual disposal, ordinary 404/503, invalid projections and request timeout do not fabricate a global session verdict.

The app controller maps this notification to its existing fail/teardown path. It removes the entire pool even if the global auth wrapper did not receive a session-end event. No second owner is created. A private unavailable owner selection remains slot-scoped in later aggregation; this callback does not redefine a 404 as logout.

Logical callers are aborted promptly on terminal revocation. Fetch/read/body-cancel ownership remains reserved until physical cleanup completes, including a late response after abort. A synchronous listener may dispose the loader; it cannot release the Window reservation early or admit a replacement loader while work remains.

`ownerSettled(signal)` shares the exact owner URL, frozen epoch, closed slot projection, 256-KiB streaming bound, monotonic ten-second deadline and one-metadata physical lane with `owner()` and Chat placements. It resolves only after body cleanup. The future runtime scheduler must serialize owner and Chat reads; a capacity refusal is not an authorization result. This seam does not start a watcher, read personal selections, create a descriptor or mount owner effects/cursor/Try.

Tests use held fetch/body promises, callback throw/reentry, both directions of owner/Chat exclusion, real-loader/app failure, ordinary-unavailable controls and terminal reason/one-use checks. No new native/browser claim: request/teardown scope only, with existing frame security unchanged.

Rollback removes the optional callback wiring and owner-settled seam together; there is no endpoint, CSP, permission, storage or migration change.
