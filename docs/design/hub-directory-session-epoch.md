# Hub directory session epoch — M-2687 foundation

This implements the browser fence from the [cleared #3425 design](https://github.com/songsid/AgEnD/issues/3425#issuecomment-6719020142).
The member transport's `revocationVersion` does not invalidate browser sessions. A persisted directory epoch gives
browser authentication and held work an independent, checked generation.

`s3-session-epoch` adds a singleton epoch and a required epoch column on `hub_sessions`. Migration from the previous
schema assigns the existing, unchanged configuration epoch zero. Existing sessions remain valid in that epoch;
advancement ends them. A missing existing epoch, malformed value or partial schema is unavailable, never reset.
The migration registry makes older binaries refuse this component.

Each `HubCore` captures the epoch when HTTP is mounted. Its owning transaction checks that value before invoking
work and after synchronous work/audit callbacks, so a late continuation cannot write person or session rows against
another directory generation. A context retains its original core. Session reads also compare the row's epoch, and
successful sign-in stamps the mounted epoch. Sign-in checks before sending credentials and after the directory
promise settles; cancellation does not release physical work early.

`advanceHubSessionEpoch(db, expected)` requires an already-open owning transaction and an exact safe epoch. It
increments the epoch and ends older sessions in that same transaction. It starts no transaction, grants no authority,
and commits nothing independently. The forthcoming settings-v2 operation must include it with the operation decision,
transport floor/version, validated group binding, required audit and full notice payload/old-recipient snapshot.
An authenticated actor's optional token/session/CSRF rotation belongs to that later decision.

The shared sealed-settings writer remains #3426. This slice writes no configuration, manifest, material or journal;
it exposes no new HTTP action or UI. Full settings-head/mounted-material admission, compensation, reauthentication,
same-PersonKey candidate checks, fingerprint consent, first-time setup and UI integration remain subsequent slices.

Evidence uses the real Hub HTTP/session code over CA-verified loopback HTTPS, private SQLite files that are physically
closed/reopened, and dummy directory identities. It covers held sign-in and eligibility, old cookies with an unchanged
immutable person, captured contexts, post-audit invalidation/rollback, and the unchanged-epoch control. No real
directory, service, native manager, live fleet or pilot is involved. This is not evidence for the unimplemented
settings-v2 commit/compensation protocol.

Rollback: the new schema is intentionally rejected by older binaries. Returning to an older build requires the
matching pre-upgrade state; deleting the epoch/component or lowering an epoch is not a recovery mechanism. The
future production caller must advance the transport floor in its complete decision, preserving its uncertain-state
rules. No production settings action advances the epoch in this foundation slice.
