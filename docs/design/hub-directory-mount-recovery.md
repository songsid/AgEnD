# Directory material barrier and cold recovery

Internal M-2687 / [#3425](https://github.com/songsid/AgEnD/issues/3425) composition foundation. These helpers have **no production caller, HTTP route, feature mark or new migration**. The actual runtime publication, browser-token handoff, notice delivery and AD editor remain separate work. The shared `settings-commit.ts` writer remains the only writer of configuration, manifests and the bind secret.

## Mounted material

`createHubDirectoryMountBarrier` copies the mounted configuration and owner callback, verifies the full issuer seal and exact private manifest/secret bytes, and binds the settings decision to the same Hub identity. The secret projection preserves whitespace and BOM. Only the fixed bind-file reference is accepted.

The barrier captures the durable directory head and browser epoch. A loss of ownership, unreadable authority, material mismatch or newer head closes it permanently; restoring old files or an old owner never revives it. Admission must assert the full barrier after asynchronous startup and immediately before publication. `current()` is the lightweight lifetime/head check, not a substitute for that full material assertion.

The internal source stamp also includes policy and transport revisions. A policy change invalidates a pending directory proof without requiring a directory remount. A valid cosmetic rename can mount under the unchanged directory/secret boundary with a new full seal.

The SQL decision intentionally updates policy/version before its final proof. Reading those own changes as an unrelated source change would reject every composed save. The same decision instance therefore exposes a copied **synchronous proof basis** only while it invokes its proof callback. It checks the original expectation before opening that scope and checks the exact resulting rows after the callback. Source capture uses this basis for its stamp and group list. It cannot escape an await, be modified through the returned copy, or replace the final SQL CAS. Reentrant or unrelated changes still roll back, retaining an advanced floor as uncertain.

## Cold recovery

`withHubDirectoryRecovery` opens only a complete existing server state set. It verifies S1 identity, the DB's Hub binding, the complete build schema registry, the directory authority tables, the private content key and the transport floor/head/epoch. It never creates a state set, runs migrations, initializes a transport store or resets authority to zero. Normal mounting and recovery share the same storage layout and key reader.

Its callback supplies the existing decision participant to the same writer's `recover()`. A readable DB decision authorizes physical completion; a progress journal or signature alone does not. The DB closes on success or error, and a thenable callback is refused and observed. No listener or directory connection is opened by this helper.

The owning runtime still needs to pass its full build registry and perform recovery before seal verification/mount. This slice deliberately does not register an alternate startup path or activate directory settings.

## Evidence and rollback

Focused tests use owned private SQLite/WAL/FULL files, real floors, audit, issuer keys/seals and an atomic file-backed config stand-in. They cover the real proof → shared writer → SQL transition, unrelated/reentrant changes, permanent material fences, and cold recovery at staging/decision/secret/manifest/config boundaries with the original DB connection closed. Missing files, identity/binding/schema/key/head/epoch failures refuse without recreating authority. This is injected restart evidence, not a power-loss or native-manager claim.

This slice adds no required schema and does not activate the helpers. Reverting it restores the previous internal behavior; it does not downgrade any DB or lower a floor/epoch. Once a later composition enables directory decisions, rollback must follow the cleared design's matched binary/state or forward-compensation rules.
