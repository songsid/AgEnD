# Directory settings: one SQL decision, one sealed writer

Internal M-2687 / [#3425](https://github.com/songsid/AgEnD/issues/3425) foundation on the session epoch from #3430 and shared writer from #3426. **The original foundation did not compose production callers.** [Runtime publication](hub-directory-runtime-publication.md) now registers its participant and migration; AD authority routes and automatic compensation remain uncomposed. Rename v1 keeps its existing file-journal decision.

`createHubSettingsWriter` gains an optional directory operation only when supplied the existing Hub's SQL decision participant. It refuses another Hub's participant. There is no second file writer, generic reseal, role flag from a browser, or independent secret writer. The configured administrator equality is checked internally; the future caller must additionally acquire and repeatedly assert the complete operation-specific proof.

The role reference remains `hub.md`: “All mutations require current same-origin/CSRF/session checks and a second check after body/await.” For directory operations the cleared design additionally requires old-trusted-directory recent reauthentication or host D3, exact eligible candidate PersonKey, group GUID continuity and the single host/CA trust confirmation. **Those proof-acquisition paths are not implemented here.** An internal callback is their transaction boundary, not a replacement authentication method.

## Decision and physical completion

1. Preparation validates the closed directory config, retains realm/profile/admin identity, snapshots actor/session/current full images, and returns only a short-lived one-use reference. Secret reuse is permitted only for the same URL, CA and bind identity. New-target secrets are explicit; whitespace and UTF-8 BOM remain opaque.
2. The same writer creates private staged old/new Hub blocks, manifests and secrets plus a v2 receipt, with file and mandatory parent-directory flushes. Only `hub.directory` and the fixed private bind-file view may change. Canonical Hub-block SHA, normalized plan digest, directory SHA, manifest SHA and secret SHA bind the exact images; staged filenames derive from the operation UUID. No password appears in the receipt, SQL operation or notice.
3. `settings-directory-decision.ts` owns one root IMMEDIATE transaction, using the exact transport store database. It compares the expected head/epoch/transport version/policy image; updates the policy binding with a new revision; cancels unfinished automatic reservations; stores the operation and receipt/staged hashes; and queues the **full** redacted security notice, pre-change stable host/admin recipients, and queued delivery targets. The existing transport store advances its durable floor before required synchronous audit and transport persistence.
4. After audit and the final proof callback, expected authority, operation and full notice/target rows are rechecked. The final callback-free transition advances the browser epoch, ends old sessions and CASes the settings head. Only that SQLite COMMIT authorizes the file installation. No thenable may stand for synchronous proof/audit.
5. The writer installs the exact decided secret, manifest and directory patch. Recovery judges all current/staged images before writing: each current field must be old or new, and a third image refuses without overwriting it. The worker checks the authoritative head before every subsequent active-file effect. It verifies the installed seal and exact complete image before removing the progress journal. Session expiry or browser disconnect after the SQL decision does not discard physical completion.

`hub/settings-journal.json` v2 is only progress. A forged `installing` phase or a staged signature without a SQL decision grants nothing. With readable authority and no decision, recovery discards the preparation. If the floor advanced but SQL rolled back, authority is uncertain: the index/material remain and recovery refuses. No floor, epoch or log is reset.

Full notices say `applying`, never prematurely `ready`. Target delivery/ACK, the host Needs-you sink, status UI and retry worker are subsequent composition work; this slice persists their complete inputs without looking up recipients through the candidate directory.

## Mount and cosmetic changes

The future mount must verify the actual full seal/material, require the current directory/secret boundary, capture the committed directory epoch, and keep effects unavailable until that exact generation is mounted. `imageCurrent` also refuses uncertain floor authority. It is a boundary helper, not a composed live-mount barrier.

The directory boundary deliberately excludes cosmetic name and manifest bytes: a valid rename v1 can reseal the full Hub without retargeting directory authority. Each later directory operation still CASes the exact current full pair. Bounded compensation refuses if a later rename or other complete-image change intervened; it cannot overwrite the newer choice.

## Forward compensation

Only the original operation's exact prior-content intent may be used. Compensation is a **new** operation, receipt, manifest, policy revision, transport/floor advance and browser epoch. The stable directory namespace hash describes restored connection content; it is not an epoch to rewind. The fixed bind-file path remains the legacy active view, while the new operation/epoch supplies its new material revision.

The participant reads the **current** policy, denies, retained fleets, provenance and revocations. It changes only the binding/revision and authorization epoch; it never reinstalls an old database/policy/resource snapshot, resurrects a cancelled offer or restores sessions. Original and compensation audit/notices coexist with the original recipient snapshot. A compensation cannot itself be automatically compensated, target an unrelated preimage, retarget recipients, or overwrite a newer head.

Private preimages remain for the bounded intent. Mount-failure detection, revalidation of that intent and eventual private-material retention/cleanup are not activated here.

## Evidence and remaining work

The owned tests use private file-backed WAL/FULL SQLite, the real version-floor file and audit chain, real scratch issuer keys/seals, and an atomic file-backed stand-in for the fleet config writer. They inject stops at preparation, SQL decision, secret, manifest, config and completion, then physically close/reopen SQLite and reconstruct the same writer. These are injected boundary/restart tests, not a power-loss/native-service claim. They also cover rollback/uncertain floor, full notice/target loss, expired/thenable proofs, input snapshots, stale head, changed staged/current files, later rename, and compensation retaining newer security state.

Production migrations/participant registration, the actual FleetManager mount/publication barrier, real HTTPS actor rotation, reauth-window and same-PersonKey candidate tests, verified-LDAPS/trust confirmation, notice delivery, host first-time initializer adapter and real-shell UI remain required M-2687 slices. #3430 supplies the separate real HTTPS cookie/held-sign-in/reopen controls.

Before production activation the new required schema component must be in the registry; an older registry refuses it. Returning to an older binary requires matching pre-upgrade state. Never remove authority tables or lower their epochs/floors to make it start.
