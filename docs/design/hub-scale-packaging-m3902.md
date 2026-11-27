# Hub architecture for scale and container packaging (M-3902)

Status: design draft, docs only (2.4.0 freeze). Section 7, the recommendation, waits for the 30-user load test (M-3901). Co-author pass with the request-context owner after M-3896.

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
- Web workers need read access to `hub.sqlite`, the browser TLS key and the session secret derivation. They do **not** need the issuer key, the member key, `content.key` or write access to the floors.
- Readers must still verify the transport floor against the database revision on every read, and a reader that sees a mismatch refuses (`uncertain`), as today.
- One new risk: a reader can see a revision that core has committed but whose floor file it read earlier. The read order must stay database-then-floor, with an equality check, as the transport store does now.

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
| Issuer and content keys | Only the writer holds them | process | core only | writer service only |
| Transport floor | Raised before the commit by the only writer; every reader checks floor = revision | as today | core writes, web reads and checks | sequencer + external floor |
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
- **Entrypoint:** it runs the existing daemon in **Hub-only mode**: a Fleet with `hub.enabled`, no agent instances and no chat adapters. That mode already exists for health reporting (`hubOnly`). It does not use tmux.
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
    volumes:
      - hub-data:/var/lib/agend-hub/data     # hub.sqlite (+wal/shm), settings journal, receipts, init evidence
      - hub-keys:/var/lib/agend-hub/keys     # identity, issuer, member TLS key, content.key, secrets/
      - hub-floors:/var/lib/agend-hub/floors # anti-rollback floors (separate volume, see below)
      - ./tls:/etc/agend-hub/tls:ro          # browser certificate chain + key, operator-owned
      - ./ldaps-ca:/etc/agend-hub/ldaps-ca:ro
    dns: ["<directory DNS 1>", "<directory DNS 2>"]
    dns_search: ["<directory domain>"]
    healthcheck:
      test: ["CMD", "agend-hub", "health"]  # local check, no secrets printed
      interval: 30s
      timeout: 5s
      retries: 3
volumes: { hub-data: {}, hub-keys: {}, hub-floors: {} }
```

**Ownership and permissions.** Named volumes, not bind mounts, hold data, keys and floors. A one-shot `init` step in the entrypoint creates the directories as `0700` and the files as `0600`, owned by `10001`, and refuses to start if any path is a symlink or has group/other bits. These are the same private-file checks as today, run at start. Bind mounts are used only for the operator-supplied certificate and LDAPS CA, read-only. On macOS, bind-mount ownership is translated, which would fail the uid checks; named volumes avoid that.

**Healthcheck.** `agend-hub health` asks the running daemon's loopback health endpoint for its mount state: mounted, listeners up, store not `uncertain`. It needs no credentials and prints no state.

**Where floors and keys live, and why.** The floors sit in their own volume so that restoring only the data volume from an older backup is caught: the database revision is below the floor, so the store refuses as `uncertain` instead of reviving revoked Fleets or old sessions. Keys are separate so a data restore never carries a different identity. Each backup records the three volumes as one **matched set**, with a manifest of the Hub id, revisions, floor values and image tag. Restore takes only complete matched sets (see §5). Like today, the floor protects against partial or mistaken restores. It cannot stop someone with host root who restores every volume. That case is handled by the sanctioned restore procedure and its audit record.

**Directory `.local` DNS.** Inside a container, the host's local resolver stub (`127.0.0.53`) is not reachable. A `.local` domain also clashes with mDNS conventions. Compose therefore sets `dns:` to the directory's DNS servers and `dns_search:` to its domain. The installer verifies, from inside the container, that the directory host resolves and that LDAPS answers with a certificate chaining to the mounted CA. `extra_hosts` is a documented fallback for a fixed domain controller address.

**Fleets stay native.** They connect to the member port exactly as now, with the same pinned SPKI. Nothing changes on the Fleet side.

**The Mac test Hub** runs the same image under any Docker runtime (Docker Desktop, OrbStack, Colima). It uses the same compose file with a self-signed browser certificate generated by the installer and named volumes for state.

### Option 2 inside the container

When option 2 is built, it stays **one image**. Compose gains a `web` service with replicas from the same image, run in `--role web`, sharing read access to `hub-data`. Mounting `hub-keys` read-only would expose the private keys, so the web role gets its own **web-keys** volume holding only the browser TLS key. The core↔web socket is a named volume of type `tmpfs`, mounted by both, mode `0700`. Floors and the writer stay in the `hub` (core) service only.

## 5. Upgrade, rollback, backup and migration

**Upgrade = pull a newer tag.** The installer (`agend-hub upgrade 2.4.1`) runs these steps:
1. Check that the target tag exists and its digest matches the release notes.
2. Stop the service cleanly: checkpoint WAL, close the database.
3. Take a matched-set backup of `hub-data`, `hub-keys` and `hub-floors`, with its manifest.
4. Rewrite the compose tag and `up -d`.
5. Wait for the healthcheck.

Database migrations run at mount, exactly as today. This answers the Hub-update question of M-3887.

**Rollback = the previous tag, and its matched set when the database moved.** A newer build's migration makes an older build refuse the database (`hub-state-newer`). That refusal is correct and stays. So `agend-hub rollback` restores the pre-upgrade matched set taken in step 3 together with the previous tag. It is a sanctioned restore:
- it requires the operator at the host;
- it records the restore in the audit log after start;
- it lists every revocation, session-epoch advance and setting change made since the backup, which must be re-applied. Those changes are lost by the restore, and the floors are restored with the set, so nothing flags them.

If the new build did not migrate anything, rolling back is just the old tag.

**Backup and restore.** `agend-hub backup` and `agend-hub restore` operate on matched sets only. A restore refuses a set whose manifest, Hub id or floors don't match its database. This also replaces the hand-run move runbook: moving a Hub means backup on the old host, restore on the new one, and route A or B for the Fleet address exactly as the runbook describes.

**Migration from today's native install** (the pilot Hub host):
1. Install Docker on the host, through the operator's package source, with sudo. That is the only privileged step.
2. Stop the native `com.agend.fleet` service and leave its home untouched as the rollback.
3. Run `agend-hub import --from <native AgEnD home>` once. It copies the state set, keys, secrets, `web-tls`, member certificates, settings journal and receipts, init manifest and `fleet.yaml` Hub block into the three volumes. It fixes ownership to `10001`, re-runs the state-set and floor checks, and verifies that the sealed plan digest still matches. Listener addresses change to the container's internal ones, so the importer reseals the plan with the supported settings writer, under the same issuer key, rather than editing the manifest.
4. Start the container. The same Hub id, issuer and member key mean every Fleet keeps its pairing (route A).
5. To roll back, stop the container and start the native service; its home was never modified. Run only one of the two at a time: there is no cross-host lock, as today.

## 6. From a blank VM to a running Hub

One command, `curl …/install-hub.sh | sh` or the same script from the release tarball, does the rest. It asks only what it cannot discover. Each step is a check the installer runs itself, and it stops with a plain reason if one fails:

| Step | What it checks or does | Replaces today's manual step |
|---|---|---|
| 1. Host | OS and architecture supported; enough disk for three volumes plus backups; clock synchronised (NTP); ports 443 and 9443 free | — |
| 2. Docker | Present and running; if not, prints the one sudo command for the distro (or runs it when allowed) | service account + linger; Node in a private prefix |
| 3. Image | Pulls the exact tag; verifies the digest | Node prefix |
| 4. Names | Hub name and public URLs. Fleet member URL resolves to this host from outside | — |
| 5. Browser certificate | Mounted chain + key: key matches, chain complete, name matches the URL, not expired; or generates a self-signed one for tests | wildcard cert import |
| 6. Ports | Publishes 443→8443 and 9443; checks no host firewall blocks them | firewall 443→8443 redirect |
| 7. Directory DNS | From inside the container: the directory host resolves with the configured `dns`/`dns_search` | resolver drop-in for `.local` |
| 8. LDAPS | From inside the container: TLS to the directory verifies against the mounted CA (or the existing fetch + fingerprint bootstrap); a test bind with the supplied bind account | LDAPS CA |
| 9. Initialise | Runs the existing `hub init` non-interactively from the collected answers (same validation, same seal), administrator and retention | interactive wizard |
| 10. Start | `compose up -d`; waits for the healthcheck; prints the handoff record (URLs, member pin fingerprint, how to pair a Fleet) | `agend hub handoff` |
| 11. Backup | Takes the first matched-set backup and prints where it is | move runbook |

## 7. Recommendation (pending M-3901)

*To be completed with the 30-user load-test numbers on the 2-vCPU matched fixture: per-route p95 latency, CPU per request, SSE stream counts and event-loop delay at 30 concurrent users.*

The working position until then:
- **Ship container packaging first, with option 1 inside.** That delivers the setup simplification and tag-based upgrade/rollback immediately, without touching the security model.
- **Build option 2 only if** the load test shows one event loop saturating at the target, for example p95 or event-loop delay over budget at 30 users. M-3878 shows most of today's cost is repeated work inside one request, which option 1 removes.
- **Option 3** stays a documented path, not a plan, unless the target grows well beyond one team Hub.

Build slices after 2.4.0, each its own reviewed PR:
1. Hub-only image, compose file and `agend-hub health`.
2. The volume init and private-file start checks.
3. `install-hub.sh` with steps 1–11 and the in-container DNS and LDAPS checks.
4. Matched-set `backup` and `restore`, plus `upgrade` and `rollback`.
5. `import` from a native home, with a rehearsal on a copy of the pilot Hub.
6. The Mac test Hub on the same image.
7. Option 1's check-once frame, if still needed after the load test.
8. Option 2, only if §7 says so.
