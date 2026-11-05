# AgEnD Hub P1: runtime composition (S5b)

Status: **design note for the experimental alpha implementation**. Card S-51 (parent M-2401, design #3095). It implements
[hub.md](hub.md) §1 "enable boundaries", §4 "Records, ownership and storage" and the S5 parts of §5 that the init wizard
(S5a, #3104) left open. Everything stays **off by default**; with both switches off, nothing in this note runs.

Composition is the glue that turns the slices into a running Hub (or Hub member) inside an ordinary AgEnD daemon:

| Slice | Provides (its own PR) | Composition supplies it |
| --- | --- | --- |
| S1 transport (`src/hub/{store,pairing,server,client,member-journal,admission,mount,…}`) | `HubMount`, `HubTransportStore`, `HubPairingService`, `HubServer`, `HubMemberClient`, `HubMemberJournal`, `HubMemberAdmissionAdapter`, migrations | the private DB, its migrations, the audit writer, the version-floor files, `hold`, and the S3/S4 handlers it calls |
| S2 directory (`src/hub/directory`, merged) | `createHubDirectory(config, {bindPassword})` | the service password resolved from `bindPasswordRef` |
| S3 receive/HTTP (server side: sessions, catalog, policy, rooms, `/hub/v1/*`) | an HTTP handler, S1's `receive`, migrations | the DB, audit sink, directory, transport and Hub web listener |
| S4 restricted execution (member side) | the restricted outbox and execution adapters, migrations | the member DB, version floor, local Needs-you adapter, online-authorization adapter |
| S5a init (#3104, merged) | `hub.*` config, sealed `hub/init-manifest.json`, `hubPlanDigest` | — (the mount verifies the seal before composition runs) |

S5b owns `src/hub/store.ts`, `src/hub/audit/`, `src/hub/compose/` and `src/hub/runtime.ts`, plus the few FleetManager lines
that call `runtime.ts`. It does not own transport internals, HTTP routes or sessions, restricted execution, notifications,
the administration page or backups (S5c, later).

## 1. Off means off

FleetManager decides from the loaded configuration alone: a switch is on only when `hub.enabled === true` (server) or
`hub_member.enabled === true` (member). While both are off and no Hub runtime is live:

- `src/hub/runtime.js` is **not imported** (FleetManager loads it with a dynamic `import()` only when a switch is on);
- no database or file under `hub/` or `hub-member/` is opened or created, no listener, timer or LDAP client exists;
- ordinary `/web`, auth and fleet behaviour are unchanged, and unknown Hub paths stay the ordinary 404.

A test pins this with an import-graph check and a filesystem spy around a full start/reload/stop of a fleet with both
switches off.

## 2. Lifecycle (FleetManager hooks)

`HubRuntime` wraps S1's `HubMount` with serialization, generation fencing and error handling. Three hooks, mirroring how
remote-runtime switches already work (`observeRuntimeSwitches` → microtask `applyRuntimeSwitches`):

| Fleet event | Hook | Behaviour |
| --- | --- | --- |
| start (`startAll`, after the web server is up) | `apply(config)` | Mount whatever is enabled. Never blocks or fails fleet startup: an error becomes a hold. |
| reload (SIGHUP reconcile, Settings save) | `apply(config)` | Compare the effective Hub view (switches, `hubPlanDigest(hub)`, member pairing snapshot). Unchanged: no-op. Changed: **fence synchronously first** (no new admission or dispatch), then await `close()`, then mount again if still enabled. |
| stop (`stopAll`, `gracefulShutdownForReload`) | `fence()` then `close()` | Fence synchronously in `stopAll`; await close inside `doStopAll` with the existing drain deadline. |

Rules:

- **One apply at a time.** Later requests coalesce to the newest configuration. A generation counter makes any
  continuation from an older generation a no-op.
- **No partial server.** A factory either returns a complete service or throws. On throw, every listener, DB handle and
  timer it opened is closed before the hold is raised.
- **Holds are visible, never retried in a loop.** `hold(reason)` writes one fleet-log line and one **Needs-you** item
  for the local owner: "Hub unavailable: <reason>", with a short explanation per reason code. This is a new input to the
  existing derivation. The Hub stays down until the next reload or restart.
- **Reason codes** (closed set): `hub-incomplete` (a slice's component is missing in this build), `hub-unsealed`
  (manifest missing, signature invalid or plan digest mismatch), `hub-state-newer` (the DB was written by a newer
  version), `hub-state-mismatch` (DB, manifest and floor disagree), `hub-storage` (private-file or DB failure),
  `hub-directory-secret` (the bind secret is missing or not private), `service-unavailable` (S1's close failed).

## 3. Storage

| Store | Path | Opened by |
| --- | --- | --- |
| Hub server DB | `<home>/hub/hub.sqlite` (+ `-wal`, `-shm`) | server factory |
| Member DB | `<home>/hub-member/<hubId>/member.sqlite` | member factory |
| Version floors | `<home>/hub/floors/<component>`, `<home>/hub-member/<hubId>/floors/<component>` | S1's `HubFileVersionFloor` |
| Audit content key | `<home>/hub/keys/content.key` (32 random bytes) | server factory, on first creation only |
| Member journal key | `<home>/hub-member/<hubId>/keys/journal.key` | member factory, on first creation only |

- **Private from the first byte.** Directories are 0700, verified as non-symlinks owned by this user. Files are
  created 0600 before SQLite opens them, and the `-wal`/`-shm` files are checked after opening. Windows is refused
  (S1's `privatePath` does the same), so native Windows Hubs are out of scope; WSL works. Pragmas: `journal_mode=WAL`,
  `foreign_keys=ON`, `busy_timeout=5000`, `secure_delete=ON`.
- **First creation versus reopening.**
  - A DB, its floors and its keys are created together only when none exist, and the DB records which Hub it belongs
    to (`hub_instance(singleton, hub_id, created_at)`).
  - If one piece is missing while the others exist, that is `hub-state-mismatch`: the factory refuses and never
    recreates the missing piece, so restored or rolled-back state cannot revive old credentials.
  - The DB's `hub_id` must equal the sealed manifest's `hubId`.
- **Migrations.** Each slice exports `HubMigration { component, version, up(db) }`, for example S1's
  `migrateHubTransportStore`. S5 keeps `hub_schema(component TEXT PRIMARY KEY, version INTEGER NOT NULL)` and applies the
  missing steps in one immediate transaction at open. A stored version above the version this build knows is
  `hub-state-newer`: the factory refuses and never downgrades. Migrations run only inside a factory, never on import.

## 4. Transactions and audit

- **`HubUnitOfWork.atomic(work)`** (hub.md §5) is better-sqlite3's `transaction(work).immediate()`.
  - `HubTx` is an opaque `{ id }` mapped to its database in a module-private WeakMap.
  - Nested calls join as savepoints, and a promise returned from `work` is refused (no network awaits inside).
  - **S1 bridge:** S1's store calls `appendAudit(record, db)` inside its own `db.transaction().immediate()`. S5's writer
    accepts that only for the server DB while `db.inTransaction` is true, and does the same insert as `append`.
- **`hub_audit`.** One row per `HubAuditRecord`.
  - `sequence` is S5's own monotonic key (INTEGER PRIMARY KEY), not the caller's. S1's per-store revision is kept as
    `component_sequence`.
  - Indexed columns: `at`, `exposure_id`, `owner_at_event`, `fleet_id`, `message_id`.
  - Each row carries `prev_hash` and `hash = sha256(prev_hash ‖ canonical(record))`, giving a tamper-evident chain with
    a verifier for auditors.
  - **Failure rule:** if the insert fails (constraint, disk full, I/O), the caller's transaction aborts. A question
    is not accepted, an answer is not disclosed, and a policy change is not reported as successful (hub.md §4). S1's
    store already freezes itself after a failed write.
- **`hub_audit_content`.** Question and answer text referenced by `contentRef`, encrypted with AES-256-GCM under
  `content.key`.
  - Each row is bound to its record by authenticated data (`contentRef`, `recordId`).
  - The key never appears in config, logs or errors.
  - Content rows are written in the same transaction as their record.
- **Who can read audit.**
  - `read` and `readContent` check the caller every time: only the asked owner (`owner_at_event` = the person, within
    their tenure) or a person listed in `hub_auditors` may read.
  - The local host and the Hub administrator are not auditors by default.
  - Every metadata read, content read and export appends its own `audit.read` / `audit.read-content` record. If that
    append fails, the read fails.
- **Retention.** A daily job runs only while a server is mounted, using the configured `contentDays` and `eventDays`.
  - It deletes content rows past `contentDays` and metadata rows past `eventDays`.
  - It keeps rows that a slice marks as unresolved through a `retained(sequence)` predicate (dedup and revocation
    evidence).
  - Before deleting, it writes a `hub_audit_checkpoint(sequence, hash)` so the chain stays verifiable.
  - The purge is audited. Backups and their retention belong to S5c.

## 5. Factories

**Server** (`createServer(cfg, current)`, called by `HubMount` only after the manifest seal is verified):
1. Open the DB and migrate it. Check `hub_instance` against the manifest. Open the floors and the content key.
2. Build the unit of work and the audit sink.
3. Resolve `hub.directory.bindPasswordRef` with `bindSecretPath`, the only accepted scheme. Read it as a private
   0600, non-symlink file with exact bytes, then call `createHubDirectory(directory, { bindPassword })` (lazily imported).
4. Build S1's `HubTransportStore` (with the audit bridge and the transport floor), then `HubPairingService` and
   `HubServer`. S3 supplies `receive`.
5. Build S3's HTTP handler from `{ uow, audit, directory, pairing, store, current }` and serve it on the Hub web listener
   (`hub.webListen`, TLS from `hub.webTls`). This is a separate listener and router; the personal `/web` is untouched.
6. Return `{ start, fence, close }`. `close` closes in reverse order, then the DB.

**Member** (`createMember(cfg, current)`, from the paired `hub-member/<hubId>/`):
1. Open the member DB, the floors and the journal key.
2. Build S4's restricted outbox and execution with the local Needs-you adapter and the online-authorization adapter.
3. Build S1's `HubMemberJournal`, `HubMemberAdmissionAdapter` and `HubMemberClient`.
4. Return `{ start, fence, close }`.

**Component registry.** S3 and S4 each provide one lazily imported composition entry: `src/hub/http/compose.ts` and
`src/hub/execution/compose.ts`. If an entry is missing in a build, its factory throws `hub-incomplete` before opening
anything. Until S3's server side and S4's code land, an enabled Hub therefore holds visibly instead of mounting part of
itself.

## 6. Interfaces to settle with the slices

- **S1 (Sol):**
  - Export migrations as `HubMigration`.
  - Floor paths (§3).
  - Keep the audit bridge as is, with S5 owning the global sequence.
  - The `hold` codes in §2.
  - Wire `provisionHubIdentity` / `sealHubInitialization` into `src/hub/init/identity.ts` (agreed in hub-s48-init).
  - Who opens the Hub **web** listener. Proposed: S5 opens it with S3's handler; S1 opens the member listener.
- **S3 (server side):**
  - `createHubHttp(deps) → { handle(req, res): boolean; receive(frame, link); close() }` plus its migrations.
  - S3a (#3098) is the UI against a stub client. **The S3 server side (sessions, catalog, policy, rooms, `/hub/v1/*`)
    has no card yet.**
- **S4 (sol2):**
  - `createHubMemberExecution({ db, uow, floor, needsYou, authorize, now }) → { outbox, execution, close() }` plus its
    migrations.
  - The `needsYou` adapter is `{ propose(proposal), hold(code) }`, backed by the fleet's Needs-you derivation.

## 7. Acceptance (hub.md §6, S5 row)

- **Off:** no import, I/O, timer or route through a full fleet start, reload and stop.
- **Lifecycle:** enable, disable, re-enable and edit sequences fence before close. A stale continuation is a no-op. Two
  overlapping reloads run once with the newest configuration.
- **Storage:**
  - Private modes for the DB and its WAL/SHM files, keys and floors.
  - A symlinked or foreign-owned directory is refused.
  - A missing floor, a DB written by a newer version, or a DB for another Hub id is refused with nothing recreated.
- **Audit:**
  - A failed append aborts the mutation (S1 store) and the disclosure.
  - The hash chain verifies, and a tampered row is detected.
  - Owner and auditor scope apply to both `read` and `readContent`, and reads are audited.
  - Content is encrypted at rest, and retention keeps the chain checkpoint.
- **No partial server:** a missing S3 or S4 entry, or a factory failure at any step, leaves no listener, DB handle or
  timer, plus one visible hold.

## 8. Delivery

1. **This note** (docs only).
2. **Code PR 1:** `store.ts`, `audit/`, `runtime.ts`, the FleetManager hooks and the Needs-you hold input. The server
   and member factories hold with `hub-incomplete` until S3 and S4 register. Opened once S1 is merged, because it
   imports S1's types and mount.
3. **Code PR 2:** register the S3 and S4 entries when they land, plus whole-flow acceptance against the fake directory.
