# Hub architecture for scale and container packaging (M-3902)

Status: design draft, docs only (2.4.0 freeze). The recommendation (§7) uses the 30-user load test (M-3901). A co-author pass with the request-context owner follows M-3896.

The user decided on 11-28 that we ship the Hub as **one packaged install**, and that the target packaging is **containers, like Outline: an official image plus a compose file**. Fleets stay native. Setup must become simpler than today: one package that takes a blank VM to a running Hub and checks its own prerequisites.

This document covers four things. It compares three process models, shows how each keeps the Hub's security model, defines the container package and its upgrade/rollback, and gives the blank-VM install path and the migration from today's native install.

## 1. Where the Hub is today

**Process.** The Hub is not a separate program. It runs inside the Fleet daemon (`FleetManager` loads `HubRuntime` when `hub.enabled`), under the normal `com.agend.fleet` service.
- **Listeners.** One Node process serves the Fleet member link (pinned TLS WebSocket, `hub.memberListen`), the browser HTTPS listener (`hub.webListen`), an optional preview listener, and the personal-runtime WebSocket upgrade.
- **Child processes.** The only ones are the room assistant CLI, sandboxed execution and an `npm view` lookup.

**State** lives under the AgEnD home:
- The **state set** (`hub/hub.sqlite`, `hub/floors/transport`, `hub/keys/content.key`) must be all present or all absent (`inspectStateSet`).
- The **identity and issuer keys** sit in `hub/keys/`.
- The **signed setup seal** is `hub/init-manifest.json`.
- **Secrets** sit in `hub/secrets/`.
- The **browser certificate** is in `hub/web-tls/`. **Member certificates** are in `hub/member-address/`.
- The **settings journal and receipts** complete the set.

SQLite runs with one better-sqlite3 connection per database: WAL, `synchronous=FULL`, immediate synchronous transactions.

**Security mechanisms the design must keep:**
- **Pinned member identity.** Fleets pin the member SPKI, so nothing may terminate member TLS. The browser certificate is separate and can be swapped live.
- **Anti-rollback floors.** `HubFileVersionFloor` files are created exclusively, only raised and fsynced. The transport floor is raised *before* the SQLite commit and checked against the stored revision on every read. A mismatch freezes the store as `uncertain`.
- **Session epoch and revocation version.** Revoking a Fleet raises `revocationVersion`, and directory changes advance the session epoch.
- **Sealed settings.** The plan digest is rechecked at every mount, and the settings writer runs a journal that is atomic within one process.
- **Operation permits.** `HubOperationPermit.assertCurrent()` and the epoch are checked before and after each transaction.
- **Private files.** Checks cover uid, mode, symlinks and the real path.
- **Sessions.** `__Host-` cookies with SameSite=Strict, a CSRF token derived from the session, and LDAPS-only directory sign-in.
- **Audit.** A hash-chained audit log with a single head.

**Single-process assumptions,** the ones that decide what can be split:
1. **Fleet links.** Live Fleet WebSockets and the connection map, presence and Hub→Fleet calls live in one process.
2. **Live updates.** Browser SSE and room events fan out from in-memory listener sets (64 streams per process).
3. **One writer.** There is one SQLite writer. The floor is a file raised outside the database, and the audit head is a single row.
4. **Atomicity.** Settings and mount atomicity rely on "no await inside this process" plus `fleet.lock`.
5. **Per-process state.** Sign-in throttling, directory admission and rate buckets are in memory, and the role-expiry and retention timers assume one runner.

**Setup today** is an interactive `agend hub init` wizard with some local preflight: bind tests, DNS lookup, the browser certificate check, and the LDAPS CA bootstrap. Everything around it is manual. The pilot Hub host needed:
- a service account with linger;
- Node in a private prefix;
- a wildcard certificate import;
- a firewall 443→8443 redirect;
- a resolver drop-in for the directory's `.local` domain;
- the LDAPS CA;
- a hand-run move runbook.

There is no backup or restore tooling (it was deferred to "S5c").

## 2. Three process models

### Option 1: one process, with the repeated checks done once per request

Keep one Hub process and remove repeated work inside it. M-3878 shows where the time goes: private-path `lstat` about 27% and `structuredClone` about 13% of sampled time.
- **Already landed (#4590–#4604):** batched projections, codec memoisation, prepared statements, scalar transport reads and the member-head scalar.
- **Next step:** a *request-scoped check-once frame*. The floor, transport and policy reads are validated once per synchronous request instead of per row, with a final fresh check before any proof or effect (the guard frame held in M-3878).
- **Floor-file watch:** an inotify watch on the floor files can invalidate that frame early. It is never a substitute for the final check.

| | |
|---|---|
| Security | Unchanged. Same process, same files, same transaction rules. |
| Cost | Small. No new moving parts. |
| Ceiling | One Node event loop. Every browser request, SSE stream and Fleet link shares one CPU core. |

### Option 2: several processes on one host, still on SQLite

Split by role while keeping one writer:
- **core** (exactly one): owns the member listener and Fleet WebSockets, all writes (SQLite writer, floor files, audit head, settings journal), the timers (role expiry, retention, personal turns) and the in-memory limits.
- **web** (N workers, e.g. one per core): browser HTTPS and SSE. They read SQLite directly, since WAL allows readers in other processes, and send every mutation to core over a local Unix-socket RPC owned by the Hub user. Core runs the mutation with the same permit checks and answers with the result.
- **events:** core publishes room, notice and presence events over the same socket, and web workers fan them out to their SSE streams.

| Assumption | Where it moves |
|---|---|
| Fleet links, presence, Hub→Fleet calls | Stay in core. Web asks core. |
| SSE fanout | Core → web event stream. Per-worker caps add up. |
| One writer, floor raised before commit | Unchanged: only core writes. |
| Settings and mount atomicity | Stay in core. Web workers hold no mount state; they refuse while core reports not-mounted. |
| Throttles, admission, rate buckets | Move into core: web asks before sign-in or directory work. Or into SQLite rows if a measured hot path needs it. |
| Timers | Core only. |

**Security** keeps one key holder and one writer.
- **What web workers get.** Read access to `hub.sqlite`, **read-only** access to the floor files (they check them; they never raise them), the browser TLS key and the session secret derivation.
- **What they don't get.** The issuer key, the member key, `content.key`, and write access to the floors.
- **Encrypted content.** Room questions, answers and attachments are encrypted with `content.key` (the audit and attachment stores both take it). Web workers therefore cannot decrypt them. Core decrypts and projects content for an authorised request over the RPC, and web never holds the key.
- **Floor checks need a new coordinated protocol. This is a prerequisite of option 2, not a detail.** Core raises the floor file to R+1 *before* it commits revision R+1 (`store.ts`). Today that window is invisible, because the only reader runs in the same synchronous process. With WAL, a web reader in another process can read the committed revision R while the floor already says R+1 during a perfectly healthy write. A two-connection probe shows database/floor = 0/1 before the commit and 1/1 after it. The current equality check would then mark that reader `uncertain` permanently, and no read order fixes that across processes.

  Option 2 must therefore define a coordinated read/write protocol before it is built. One way: core records an explicit in-flight write (R → R+1) that readers can see. A reader that observes floor = revision + 1 waits briefly or asks core over RPC for the confirmed revision, and refuses only when core confirms no write is in flight. A floor more than one ahead, or a floor ahead with no in-flight write, keeps refusing as today, which is the crash/restore case. The protocol ships with three regressions:
  - a reader during a healthy in-flight write must not freeze;
  - a crash between the floor raise and the commit is resolved by core's recovery, and readers stay refused until core confirms;
  - an old database under a newer floor keeps refusing permanently.

**Cost:** medium. It needs an RPC layer, an event bus and request admission in core. **Ceiling:** writes stay single-threaded, which is fine for a team Hub. Reads and SSE scale with cores.

### Option 3: packaged Postgres + Redis + separate services (the full Outline shape)

Run web, worker and realtime services over Postgres (state) and Redis (pub/sub, rate limits, locks).

**Security** needs real redesign:
- **Floors.** A floor can no longer be "a file raised before a SQLite commit". It would become a sequencer: a Postgres advisory lock held by one writer, which raises an external monotonic floor before commit. That external floor would be a file in a separate volume or, better, a signed counter in the key volume.
- **Restore detection.** Detecting a restored Postgres volume needs that floor to live outside the database volume (see §4).
- **Audit.** The audit head becomes a row protected by the same sequencer.
- **Keys.** Each service gets only the keys it needs. Only the writer service holds the issuer key and `content.key`.
- **Settings.** The settings journal and mount fencing need a cross-process lock, either a Postgres advisory lock or a lease row with an epoch.
- **Migration.** All current SQLite data needs a one-way migration, plus a second set of downgrade rules.

**Cost:** high, and a much larger attack surface: two extra stateful services, their credentials and their backups. **Ceiling:** effectively unlimited for our scale. We only need it if the load test shows option 2 cannot hold the target (see §7).

## 3. Keeping the security model across processes (all options)

| Mechanism | Rule that must hold | Option 1 | Option 2 | Option 3 |
|---|---|---|---|---|
| Member identity and pin | One holder of the member key; member TLS never terminated by a proxy | core | core | realtime/member service only |
| Issuer and content keys | Only the writer holds them | process | core only; core decrypts content for web over RPC | writer service only |
| Transport floor | Raised before the commit by the only writer; every reader checks floor = revision | as today | core writes; web has read-only floor access and checks | sequencer + external floor |
| Session epoch, revocation version | In the database, read fresh per request | as today | readers read fresh | as today |
| Sealed settings | Digest rechecked at mount; journal atomic | as today | core only; web refuses while unmounted | lease with an epoch |
| Permits | `assertCurrent` before and after each transaction | as today | in core, for every mutation RPC | in the writer |
| Private files | uid, mode, no symlinks, real path | as today | as today (same uid) | per-volume checks at start |
| Audit chain | Single head, hash chained | as today | core only | sequencer |

Two rules apply to every option:
- **Never cache authority across requests.** Caches may hold decoded bytes keyed by exact raw input, never permits, floors or currentness.
- **Every new channel is local and owned.** The core↔web socket lives in a private directory with the private-file checks. It carries the caller's session reference, never a pre-authorised capability, and core re-authorises every call.

## 4. Container packaging (target for the Hub)

### Image

`agend-hub:<version>` is one official image per release, built from the same release as the npm package.
- **Contents:** Node at a pinned version, the AgEnD build, and the ca-certificates package.
- **Runtime user:** a fixed non-root uid/gid (`10001:10001`). No shell login and no sudo.
- **Entrypoint:** it runs the daemon in a **Hub-only mode**: a Fleet with `hub.enabled`, no agent instances and no chat adapters. This mode is **packaging work, not something that exists today**. `FleetManager.startAll` resolves tmux unconditionally, and `hubOnly` is currently only a health classification. The first build slice adds a supported zero-agent start branch that never resolves tmux.
- **Optional Hub features with native dependencies.** The room-assistant CLI and sandboxed execution are not in the base image. The package declares them explicitly: either an `agend-hub:<version>-assistant` variant with the assistant CLI and the execution runtime, or a documented "not available in the container" state. The importer reads whether the native Hub uses them. It refuses to import silently into an image that lacks them, and asks the operator to pick the variant or confirm turning the feature off.
- **Tags:** one per release (`2.4.0`, `2.4.1`, …), plus `2.4` and `stable` channel tags. Compose files pin an exact version tag; an image digest is recorded at install.

### Compose services and volumes

```yaml
services:
  hub:
    image: agend-hub:2.4.0          # exact tag; the installer writes it
    user: "10001:10001"
    restart: unless-stopped
    ports:
      - "443:8443"                  # browser HTTPS (replaces the firewall redirect)
      - "9443:9443"                 # Fleet member link, TLS passes straight through
    environment:
      AGEND_HOME: /var/lib/agend
    volumes:
      # Nested mounts reproduce today's fixed layout under AGEND_HOME (compose/storage.ts, init/layout.ts):
      - hub-home:/var/lib/agend                # fleet.yaml (Hub block), hub/hub.sqlite(+wal/shm), hub/settings-*,
                                               # hub/init*, hub/install-inventory.json, hub/web-tls/, hub/member-address/,
                                               # hub/web-address/, hub/secrets/, hub-assistant/
      - hub-keys:/var/lib/agend/hub/keys       # identity.json, issuer, member TLS key/cert, content.key
      - hub-floors:/var/lib/agend/hub/floors   # anti-rollback floors (separate volume, see below)
    dns: ["<directory DNS 1>", "<directory DNS 2>"]
    dns_search: ["<directory domain>"]
    healthcheck:
      test: ["CMD", "agend-hub", "health"]  # local check, no secrets printed
      interval: 30s
      timeout: 5s
      retries: 3
volumes: { hub-home: {}, hub-keys: {}, hub-floors: {} }
```

**Paths.** The Hub keeps its current fixed paths under `AGEND_HOME`. No storage-path adapter is needed, and symlinks can't bridge paths anyway, since `privatePath` refuses them. The keys and floors volumes are mounted *inside* the home volume at exactly `hub/keys` and `hub/floors`. A nested mount is a real directory, not a symlink, so the existing private-file walk accepts it as long as its root is owned by the Hub uid with mode `0700`.

**Ownership.**
- **The image prepares ownership.** It contains `/var/lib/agend`, `/var/lib/agend/hub`, `/var/lib/agend/hub/keys` and `/var/lib/agend/hub/floors` as `10001:10001`, mode `0700`. A *fresh* named volume takes the ownership and mode of the image directory it is first mounted on, so a new install needs no chown and no root.
- **A volume with any other owner is refused.** The entrypoint runs as `10001` and never chowns: it refuses to start when a volume root has the wrong owner, has group/other bits or is a symlink. These are the same private-file checks as today, run at start.
- **The one privileged repair is bounded.** `agend-hub fix-ownership`, run by the installer through `docker compose run --rm --user 0`, chowns only the three volume roots and their contents to `10001`, then exits. It never runs at service start.
- **No state bind mounts.** On macOS, bind-mount ownership is translated, which would fail the uid checks, so data, keys and floors are always named volumes.

**Certificate and CA inputs** are not live-mounted. Today's `privatePath` rejects absolute and out-of-home paths, and operator-owned `0600` files wouldn't be readable by uid `10001` anyway.
- **The browser certificate** is *imported*: the installer streams the chain and key on stdin to `agend-hub cert import`, which runs the existing validation and writes them as private files into `hub/web-tls/`. Renewal is the same command, then the live `setSecureContext` swap.
- **The LDAPS CA** becomes the sealed `directory.caPem` at initialisation, as the CA bootstrap does today, so it needs no mount at all.

**Healthcheck.** `agend-hub health` asks the running daemon's loopback health endpoint for its mount state: mounted, listeners up, store not `uncertain`. It needs no credentials and prints no state.

**Where floors and keys live, and why.** The floors sit in their own volume so that restoring only the data volume from an older backup is caught: the database revision is below the floor, so the store refuses as `uncertain` instead of reviving revoked Fleets or old sessions. Keys are separate so a data restore never carries a different identity. Each backup records the three volumes as one **matched set**, with a manifest of the Hub id, revisions, floor values and image tag. Restore takes only complete matched sets (see §5). The tests pin three cases:
- old data with the current floor refuses;
- a missing companion (keys or floors absent) refuses without creating replacement keys or floors;
- a complete matched set opens.

Like today, the floor protects against partial or mistaken restores. It cannot stop someone with host root who restores every volume. That case is handled by the sanctioned restore procedure and its audit record.

**Directory `.local` DNS.** Inside a container, the host's local resolver stub (`127.0.0.53`) is not reachable. A `.local` domain also clashes with mDNS conventions. Compose therefore sets `dns:` to the directory's DNS servers and `dns_search:` to its domain. The host's resolver drop-in is not inherited. The installer runs its probes with `docker compose run --rm hub agend-hub probe …`, in the service's own network namespace and as the service uid. The probes check that the directory host resolves and that LDAPS answers with a certificate chaining to the sealed `directory.caPem`. `extra_hosts` is a documented fallback for a fixed domain controller address.

**Fleets stay native.** They connect to the member port exactly as now, with the same pinned SPKI. Nothing changes on the Fleet side.

**The Mac test Hub** runs the same image under any Docker runtime (Docker Desktop, OrbStack, Colima). It uses the same compose file with a self-signed browser certificate generated by the installer and named volumes for state.

### Option 2 inside the container

When option 2 is built, it stays **one image**. Compose gains a `web` service with replicas from the same image, run in `--role web`:
- **Mounts.** `hub-home` is mounted read-only. `hub-floors` is mounted **read-only**: web checks the floors and never raises them.
- **No `hub-keys`.** Mounting it read-only would still expose the issuer, member and content keys, so the browser TLS key is mounted for web from its own `web-tls` volume.
- **The core↔web socket** lives on a **shared named volume** that both services mount, with a directory of mode `0700` owned by the Hub uid. A per-container `tmpfs` mount cannot be shared between containers.
- **Core owns** the writer, `content.key` and the decrypting projections.

## 5. Upgrade, rollback, backup and migration

**Upgrade = pull a newer tag.** The installer (`agend-hub upgrade 2.4.1`) runs these steps:
1. Check that the target tag exists and its digest matches the release notes.
2. Stop the service cleanly: checkpoint WAL, close the database.
3. Take a matched-set backup of `hub-home`, `hub-keys` and `hub-floors`, with its manifest.
4. Rewrite the compose tag and `up -d`.
5. Wait for the healthcheck.

Database migrations run at mount, exactly as today. This answers the Hub-update question of M-3887.

**Rollback has three distinct cases, and only the first one is "just go back":**

1. **Pre-use rollback.** If no write has been accepted since the upgrade or import (listeners never opened, or opened and refused), going back to the previous tag, or to the untouched native home, is safe.
2. **Machine rollback after use.** Once the new copy has accepted writes, the old copy is stale. Starting it would revive revoked Fleets, old sessions and settings, and the pre-relocation state. The latest state must move back instead:
   - stop the container;
   - `agend-hub export --to <new native home>` writes the current matched set;
   - start the native service on that home, as the move runbook's rollback already requires.

   An older build that can't read a migrated database refuses (`hub-state-newer`). That case needs case 3, not a silent downgrade.
3. **Intentional pre-upgrade restore (data-loss recovery).** This replaces the current database with an older matched set. `agend-hub rollback --restore` then:
   1. **before** replacing anything, reads the current database and records the list to re-apply: revocations, session-epoch advances and settings changes made since the backup. These are lost by the restore, and the restored floors won't flag them.
   2. replaces the set and starts with **listeners fenced**: no member or web listener serves.
   3. re-applies or explicitly reconciles every item on that list.
   4. only then opens the listeners, and writes an audit record of the restore.

   An audit entry written after start alone would leave a serving window, so the fence comes first. This case requires the operator at the host.

**Backup and restore.** `agend-hub backup` and `agend-hub restore` operate on matched sets only. A restore refuses a set whose manifest, Hub id or floors don't match its database. A backup is the data half of a move; it doesn't replace the move's acceptance. Moving a Hub still follows the runbook's single-writer cold move, with route A or route B for the Fleet address and the runbook's acceptance checks.

**Migration from today's native install** (the pilot Hub host). These steps need sudo: installing Docker, disabling the native autostart, and retiring the owned port redirect.
1. **Install Docker** on the host through the operator's package source.
2. **Fence the native Hub.** Stop the native `com.agend.fleet` service **and disable its autostart**, with a record of what was disabled. A reboot must never start the native Hub while Docker's restart policy starts the container, because the two would publish the same Hub.
3. **Retire the owned port redirect.** The native host has a persistent firewall 443→8443 redirect. The importer detects exactly that rule (the one the runbook installed) and removes it before Compose publishes 443. It records the rule so a pre-use rollback can restore it, and never touches other rules.
4. **Import.** `agend-hub import --from <native AgEnD home>` runs once and copies the full inventory into the volumes:
   - the state set and every key;
   - all of `hub/secrets/`, including the private directory-bind file behind `bindPasswordRef`;
   - `web-tls/`, member and web address certificates and selectors;
   - the settings journal, staged files and receipts;
   - init evidence and the sealed manifest;
   - `hub-assistant/` state;
   - the `fleet.yaml` Hub block with its sealed `directory.caPem`.

   It preserves the sealed CA and bind reference instead of bootstrapping or rotating them. It fixes ownership to `10001` and re-runs the state-set, floor and private-file checks.
5. **Reseal the listeners.** The old host-IP listener can't bind inside a bridge container, so the internal listener addresses change. The importer reseals them with the supported settings writer, under the same issuer key, and keeps **both** public origins, the member key and a browser certificate valid for those DNS names. With the same Hub id, issuer, member key and origins, Fleets keep their pairing (route A). If a public origin has to change, that is the signed route-B relocation, not an implicit route A.
6. **Start the container and run the acceptance in §6, steps 10–11.**
7. **Roll back by case.** Before any write has been accepted, roll back by stopping the container, restoring the redirect and re-enabling the native autostart on the untouched home: case 1. After writes, use case 2. Only one copy ever runs; there is no cross-host lock, as today.

## 6. From a blank VM to a running Hub

One command, `curl …/install-hub.sh | sh` or the same script from the release tarball, does the rest. It asks only what it cannot discover. Each step is a check the installer runs itself, and it stops with a plain reason if one fails:

| Step | What it checks or does | Replaces today's manual step |
|---|---|---|
| 1. Host | OS and architecture supported; enough disk for three volumes plus backups; clock synchronised (NTP); ports 443 and 9443 free | — |
| 2. Docker | Present and running; if not, prints the one sudo command for the distro (or runs it when allowed) | service account + linger; Node in a private prefix |
| 3. Image | Pulls the exact tag; verifies the digest | Node prefix |
| 4. Names | Hub name and public URLs. Fleet member URL resolves to this host from outside | — |
| 5. Browser certificate | Streams the chain and key to `agend-hub cert import`: key matches, chain complete, name matches the URLs, not expired; writes private files in `hub/web-tls/`. Or generates a self-signed one for tests | wildcard cert import |
| 6. Ports | Publishes 443→8443 and 9443; checks no host firewall blocks them; on a migrated host, the owned redirect was retired first (§5) | firewall 443→8443 redirect |
| 7. Directory DNS | `docker compose run --rm hub agend-hub probe dns` in the service network namespace, as the service uid: the directory host resolves with the configured `dns`/`dns_search`. The host drop-in is not inherited | resolver drop-in for `.local` |
| 8. LDAPS | The same probe for LDAPS: TLS verifies against the CA (fetch + fingerprint bootstrap on a new install; the preserved sealed `directory.caPem` on import, never re-bootstrapped); a test bind with the bind account (on import, the preserved private `bindPasswordRef`, not rotated) | LDAPS CA |
| 9. Initialise | New installs only: runs the existing `hub init` non-interactively from the collected answers (same validation, same seal), administrator and retention. Imports skip this and keep their seal | interactive wizard |
| 10. Start and accept | `compose up -d`; waits for the healthcheck (loopback mount state only). Then three acceptance checks from outside the container. (a) Inert TLS checks through the **published** endpoints: the member port presents the expected pinned SPKI with the right SAN and validity, separately from the browser chain. Member TLS stays self-signed and pinned and never uses the browser wildcard key. A front end whose backend is down must refuse, never answer with another certificate, which a Fleet would treat as a changed key. (b) The handoff record: URLs, member pin fingerprint, how to pair a Fleet. (c) Acceptance: a company sign-in, the rooms and shares visible, and one connected Fleet as a canary | `agend hub handoff` |
| 11. Backup | Takes the first matched-set backup and prints where it is. A backup does not replace route-A/B move acceptance | — |

## 7. Recommendation

### What the load test says (M-3901)

**Scope of the run.** It was a short, seeded, read-mostly synthetic run: 30 simulated users following an Outline-like usage script with dwell times between actions, over a bounded observation window, on a release build (`a47bd28f`) in a 2-CPU, 1 GiB VM-matched fixture. The report says it did **not** establish a finite sustainable maximum. "Page latency" below is the time to complete a page's **basket of API requests**, not browser render time.

| Measure | Result |
|---|---|
| Errors | 0 |
| API latency p50 / p95 / p99 | 120 / 554 / 976 ms |
| Page request-basket latency p95 | 1.37 s; it first exceeds 1 s at 10 users |
| Main thread | 35% of one core on average |
| Memory (RSS) | 181 MiB |

Top self-time:

| Cost | Share |
|---|---|
| `lstat` (private-path checks) | 16.8% |
| SQLite transaction | 14.3% |
| SQL row reads | 8.8% |
| statement prepare | 6.5% |
| `structuredClone` | 5.0% |

The load tester's profile-based estimates are conditional upper bounds, derived from the profile without prototypes. None of them has a proven safe lower bound:

| Change | Estimated effect (if the profile's assumptions hold) |
|---|---|
| Guard frame | up to 7–11% of CPU work |
| Floor-file watch | at most a 1.48× ceiling |
| Two processes | at most a 1.30–1.43× throughput ceiling |

**Reading, within that scope.** For this read-mostly workload, one process completed the run with no errors at 35% of one core on average. That is not evidence of headroom for heavier or write-heavy use. The observed problem is the page request-basket tail. A page makes several API calls, each doing synchronous checking work (path checks, transactions, row decoding), and on one event loop those calls also queue behind each other's bursts. Splitting processes *might* lift the throughput ceiling within the conditional bound above. It would not shorten any single request's synchronous work. Cutting per-request cost is therefore the cheaper next **experiment**, and each step is measurable on the same fixture. It is not a demonstrated capacity conclusion.

### Recommendation

1. **Ship the container package with option 1 inside: one Hub process per container.** This is the user's maintainability and packaging goal: an official image, compose, the one installer, tag-based upgrade and matched-set rollback. None of it requires multiple processes. It changes nothing in the security model, and the same image runs on the pilot Hub and the Mac test Hub.
2. **Then attack the tail inside that one process,** in measured steps:
   - the request-scoped check-once frame, which addresses the top `lstat` and transaction costs, under the M-3878 guard-frame conditions (fresh final check, no authority cached across requests);
   - batching the remaining per-row reads on the page routes;
   - a floor-file watch, only as an early-invalidation hint.

   Each step must show a page-basket p95 improvement on the same fixture before the next one starts. The working target is page-basket p95 under 1 s at 30 users on that fixture. Add a longer, write-including run before drawing any capacity conclusion.
3. **Keep option 2 as a prepared, not scheduled, step.** The core/web split in §2 stays the design if a later, broader load test shows the event loop above about 70% of a core at the target, or p95 still over budget after step 2. Its coordinated floor protocol and tests (§2) are prerequisites. The container package already allows it (one image, a second `web` service), so building it later does not change packaging.
4. **Do not plan option 3.** Postgres and Redis would add two stateful services, their credentials and backups, and force a redesign of floors and atomicity. Nothing measured so far calls for that at team scale.

### Build slices after 2.4.0

Each slice is its own reviewed PR:
1. A supported zero-agent, no-tmux Hub start branch; the Hub-only image, compose file and `agend-hub health`; and the declared assistant/execution variant.
2. The nested-volume layout, image-prepared ownership, `fix-ownership`, the start checks, and `cert import` over stdin.
3. Matched-set `backup` and `restore`; `upgrade`; the three rollback cases, including `export` and the fenced `rollback --restore`.
4. `install-hub.sh` with steps 1–11 and the in-container DNS and LDAPS checks. It depends on slice 3 for step 11's first backup.
5. `import` from a native home: autostart fencing, retiring the owned redirect, resealing, and preserving the CA and bind reference. Rehearsed on a copy of the pilot Hub, with the §6 step-10 acceptance.
6. The Mac test Hub on the same image.
7. The check-once frame, measured against page p95 on the M-3901 fixture.
8. Further per-request batching, measured the same way.
9. Option 2, only if the trigger in recommendation 3 is met.
