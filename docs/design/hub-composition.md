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

S5b owns `src/hub/db.ts` (opening, migrations, unit of work), `src/hub/audit/`, `src/hub/compose/` and
`src/hub/runtime.ts`, plus the few FleetManager lines that call `runtime.ts`. (hub.md §1 lists a `store.ts` for S5, but
S1's branch already uses `src/hub/store.ts` for `HubTransportStore`, so S5's database module is `db.ts`.)
It does not own transport internals, HTTP routes or sessions, restricted execution, notifications,
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
- **Holds are visible, never retried in a loop.** `hold(reason)` writes one fleet-log line and records the hold
  (`FleetManager.getHubHolds()`). In code PR 2 it also becomes one **Needs-you** item for the local owner, "Hub
  unavailable: <reason>", built on the `hub` item type that S4 (#3107) adds, so the two slices don't edit the same lines
  twice. The Hub stays down until the next reload or restart.
- **Reason codes** (closed set): `hub-incomplete` (a slice's component is missing in this build), `hub-unsealed`
  (manifest missing, signature invalid or plan digest mismatch), `hub-state-newer` (the DB was written by a newer
  version), `hub-state-mismatch` (DB, manifest and floor disagree), `hub-storage` (private-file or DB failure),
  `hub-directory-secret` (the bind secret is missing or not private), `hub-member-pairing` (the member's pairing
  state is missing or invalid), `service-unavailable` (a valid Hub could not start or close: listener, factory or
  cleanup failure).
- **S1's codes map onto these.** `HubMount.hold` reports `initialization`, `member-pairing` or `service-unavailable`.
  Composition maps `initialization` to `hub-unsealed` (or `hub-incomplete` when a component is missing),
  `member-pairing` to `hub-member-pairing`, and `service-unavailable` to itself. Transport link states
  (`unavailable`, `invalid`, `backpressure`, `replaced`, `revoked`, `key-changed`; S1's closed enum) are per-link
  status, not mount holds.

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
- **First creation versus reopening.** Composition creates exactly one set per side, together, and only when no part of
  it exists:
  - **Server set:** `hub/hub.sqlite`, the S5-initialized floors under `hub/floors/` and `hub/keys/content.key`.
  - **Member set:** `hub-member/<hubId>/member.sqlite`, its floors under `hub-member/<hubId>/floors/` and
    `hub-member/<hubId>/keys/journal.key`.

  Files written before composition runs are **prerequisites, not part of the set**: S1's identity keys under
  `hub/keys/` (`tls-key.pem`, `tls-cert.pem`, `issuer-key.pem`, `issuer-public.pem`, `identity.json`), the sealed
  `hub/init-manifest.json`, and the member's pairing files (`hub-member/<hubId>/{pairing,pending}.json`). Their presence
  never counts as "part of the set exists". So the first mount after `agend hub init` (or after pairing) creates the set.
  If some members of the set exist and others don't, that is `hub-state-mismatch`: the factory refuses and never
  recreates the missing piece, so restored or rolled-back state cannot revive old credentials. The DB records which Hub
  it belongs to (`hub_instance(singleton, hub_id, created_at)`), and that `hub_id` must equal the sealed manifest's
  `hubId`. S1's `HubFileVersionFloor.initialize()` (exclusive create, never reset) is called only during this first
  creation.
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

**Member** (`createMember(cfg, current)`, from the paired `hub-member/<hubId>/`), using S4's concrete exports
(`src/hub/execution`, #3107):
1. Open the member DB and run every migration (S1's journal, S4's `migrateHubExecution`, S5's member audit). Open the
   floors and the journal key. On first creation only, call the `initialize()` methods.
2. Build S5's **member-local audit sink** on the member DB, with the same hash chain as the server's. S4 and S1 append to
   it synchronously, **inside their own transaction on that DB**, before any effect or queue acceptance. Forwarding
   metadata to the Hub is extra evidence, never the only record.
3. Capture the **binding** from the pairing and the current link: hubId, issuer key id and public key, fleetId, owner,
   generation, link epoch, revocation version, and `current()`. When the member is switched off, replaced or re-linked,
   `current()` turns permanently false, synchronously, before any cleanup.
4. Build S4's `HubExecutionStore(db, { floor, audit })` and S1's `HubMemberJournal`. The journal's restricted outbox is a
   forwarding closure that is only callable once the next step has finished. S4's `restrictedOutbox()` implements S1's
   `insert`/`lookup` and runs inside S1's outer transaction.
5. Build `HubRestrictedExecutionService({ store, journal, transport: { authorize }, binding, localExposure, views,
   attentionChanged, now })`, then call `recover()` before anything reports ready. `localExposure` and `views` are the
   member-owned durable exposure records and approved document views. **The provider registry stays empty:**
   composition installs no execution provider, so ordinary full-tool CLI agents remain unavailable as exposures.
6. Build S1's `HubMemberAdmissionAdapter` and `HubMemberClient`.
7. Attach `service.attentionItems` to the fleet's Needs-you through `FleetManager.attachHubExecutionAttention`; S4's
   `attentionChanged` re-renders it. Exact local proposals render without approval controls, and the public gateway
   strips them.
8. Return `{ start, fence, close }`. `fence` invalidates the binding and S4's contexts synchronously; `close` closes
   S4's service, then the journal and client, then the DB.

**Component registry.** Each factory lazily imports what it needs:
- S3's entry, `src/hub/http/compose.ts`, for the server;
- S4's exports, `src/hub/execution/index.ts`, for the member.

If either is missing in a build, its factory throws `hub-incomplete` before opening anything. Until S3's server side
and S4's code land, an enabled Hub therefore holds visibly instead of mounting part of itself.

**Hub web listener routing.** Every request on the Hub web listener goes to S3's `handle(req, res)`; when it returns
false the answer is 404. S3's handler serves `/hub/v1/*`, the Hub-only shell (`/`, `/web`, `/ui`, `/ui/hub*`), its
three scripts under `/ui/js/` and `/assets/*`, all without reading a fleet cookie or session. S3's `/hub/v1/session`
owns the Hub session check. The personal fleet listener is untouched.

## 6. Interfaces to settle with the slices

- **S1 (Sol), settled (hub-s51-compose):**
  - S5's database module is `src/hub/db.ts` (`HubMigration`, opening, unit of work); `src/hub/store.ts` stays S1's.
  - S1 exports `HUB_TRANSPORT_MIGRATION` (`s1-transport`) and `HUB_MEMBER_JOURNAL_MIGRATION`, which structurally match
    `HubMigration`. Nothing migrates on import.
  - Floors use the paths in §3. S5 calls `initialize()` only for a wholly new set.
  - The audit bridge stays as is: S5 assigns the global sequence and keeps S1's revision as `component_sequence`.
    Everything is written synchronously inside the passed transaction.
  - `HubServer` opens only the member TLS listener; S5 owns the Hub web listener (§5). Hold codes map as in §2.
  - S1 wires `provisionHubIdentity` / `sealHubInitialization` into `src/hub/init/identity.ts`.
- **S3 (web-claude), settled (hub-s51-compose-s3):**
  - web-claude owns both S3a (the UI, #3098) and S3b (the server side: sessions, catalog, policy and grants, rooms,
    `/hub/v1/*`).
  - S3b implements `createHubHttp(deps) → { handle(req, res): boolean; receive(frame, link); close() }` in
    `src/hub/http/compose.ts` and exports its tables as `migrations: HubMigration[]`. The module itself is the entry:
    composition lazily imports it, and it has no default export.
  - The full deps (cid-hub-s3b-deps; types in `src/hub/compose/server.ts`) are `{ uow, audit, content, directory,
    pairing, store, current(), now?, config, issuer, transport }`:
    - `config` is the frozen `{ hubId, name, webOrigin, administrator }` from the sealed settings, never from a request;
    - `issuer.sign` wraps S1's `signAsker`, so S3 never opens key files;
    - `transport()` returns null before the member listener runs and after a fence or close: S3 answers
      "unavailable" and never queues;
    - `content.put(tx, payload)` returns an S5-generated ref, and `content.get(ref)` serves only S3's own room
      projection after its audience check;
    - `db.ts` also exports `hubTxDatabase(tx)`, valid only while that transaction's callback runs.
  - Whether an exposure is enforceable reaches the Hub from the member, through S1's exposure snapshot or the owner's
    own publish step. It never comes from an S4 object on the Hub: there is none on a dedicated Hub, and no
    in-process bypass is allowed.
- **S4 (sol2), settled (hub-s51-compose-s4):**
  - S4 uses its concrete exports, `HubExecutionStore`, `migrateHubExecution` and `HubRestrictedExecutionService`,
    instead of a wrapper. S4 owns its own immediate transactions, so no `HubUnitOfWork` is passed in.
  - S5 provides the member-local audit sink and the captured binding.
  - Needs-you uses S4's durable `attentionItems` reader rather than a propose/hold callback.

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
- **Member binding:** after off, replace or re-link, every captured binding reads `current() === false` before cleanup.
  S4's provider registry stays empty.
- **No partial server:** a missing S3 or S4 entry, or a factory failure at any step, leaves no listener, DB handle or
  timer, plus one visible hold.

## 8. Delivery

1. **This note** (docs only).
2. **Code PR 1:** `db.ts`, `audit/`, `compose/server.ts`, `runtime.ts` and the FleetManager hooks. The server
   factory holds with `hub-incomplete` until S3b registers its entry; the member side holds until S4. Opened once S1 is merged, because it
   imports S1's types and mount.
3. **Code PR 2:** register the S3 and S4 entries when they land, the member factory (with the S4b provider seam), the
   Needs-you hold item, and whole-flow acceptance against the fake directory.
