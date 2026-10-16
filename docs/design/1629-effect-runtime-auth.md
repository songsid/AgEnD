# Session-bound runtime reads (#1629 B2)

This is an authenticated server prerequisite. It does not serve or mount browser runtime code, add a loader, start a fleet or change an effect placement.

## Exact session, not supplied identity

An old page can remain open when the browser signs in again. A current cookie alone must not silently rebind that page's execution-resource request to a new session, including a new sign-in by the same person. Runtime requests therefore carry the immutable boot `ownerEpoch` (the session's public handle). The server still derives the actor from its verified human session; this value grants no permission and is not a credential.

Exactly one matching `ownerEpoch` is required for:

- `GET /ui/effects/placements?instance=...`;
- every `GET /ui/effects/resource/<id>`, including unplaced own/shared reads;
- `GET /ui/effects/image/<id>/{poster,cursor}.png?instance=...`;
- the already bound personal slot/owner reads;
- `POST /ui/effects/profile/<id>`.

The ordinary library list, ordinary scoped image reads and GET profile history retain their existing ACL and need no runtime epoch. Resource/image mismatches are indistinguishable from not found; placement/owner/report mismatches return a session-changed error. Missing, wrong, repeated or another current session's epoch refuses before the service reads code or writes a report. After awaiting a POST body, authorization repeats and both person and exact session handle must still match. A header token, anonymous caller or public-link context never supplies a human runtime session.

Client adapters must still fence route, active owner/session, region and request generation before and after a wait, dispose on session end and honor abort/deadlines. An epoch check cannot recall already delivered bytes or prove that client code remains current after a response. This PR supplies no reactive session store or browser ownership lease.

## Bounded diagnostics from signed-in browsers

R2 §6 calls for each signed-in browser to record host measurements, including a local session with read access. Only the exact POST profile route accepts that tier. Appearance/library mutations (upload/apply/remove/share/delete) remain admin-only. The report route still requires same-origin/CSRF, the exact epoch, an own/shared effect or exact retained chat reference, closed bounded data and the existing per-person/id ten-second successful-report limit. Public-link and header-token writes remain refused at both applicable boundaries.

Reports are untrusted diagnostics. They cannot grant a claim, share an effect, change a placement, clear probation/pause state, admit a frame or supply its calibration. They remain passive for session-idle touching, so background work does not keep a session alive. Invalid reports do not consume the successful-report interval.

## Evidence and rollback

Tests use owned ephemeral HTTP listeners, private library/profile files and in-memory sessions. Held-body auth-continuation controls explicitly model a changed request/auth verdict; they do not claim that real HTTP changes a Cookie header during a body, or probe an account. Normal HTTP controls cover a new same-person session presenting an old page's epoch.

Future clients must include the epoch, so existing unmounted runtime consumers/tests are updated explicitly. Current human Settings library images/history are preserved. Revert this server contract and its callers together; there is no durable format, account migration, service restart or product playback to undo. Diagnostic read-session access is intentionally narrow; resource/report ACLs remain independently enforced.
