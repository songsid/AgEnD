# The update transaction: attempt journal, locks, snapshot and restore (M-3770 slices 2.1 and 2.3)

Design note for Phase 2 of `docs/design/update-adoption-m3762.md` (#4480, approved), §3.3 steps 1, 3, 4 and 7, and §4.2. It covers:
- **2.1:** the attempt journal and the three locks;
- **2.3:** stop-then-snapshot and restore.

It also fixes the interfaces that 2.2 (the quiescence barrier, GrokCore) and 2.5 (health proof and commit/rollback) build on. No UI; 2.6 words what this records.

Scope: Phase 2 runs only on a machine in class **self** (§4), and only when both the running version and the target speak this transaction (from- and to-version ≥ V_tx). Anywhere else, Phase 1's updater runs unchanged.

---

## 1. Who does what

**The updater** (`agend update`, launched detached and outside the fleet's cgroup, as today) owns the transaction from start to end. Only the updater writes the journal's stage.

**The fleet:**
- **Old fleet:** before stopping, it does the barrier's fencing (2.2) and writes the update inbox and deferred jobs into the journal.
- **New fleet in trial mode:** it writes adapter cursors and inbound into the journal (2.4).
- **Any fleet at start:** it reads the journal and refuses to start normally while an attempt is mid-stage. It hands that attempt to recovery instead (§5).

**The journal** lives at `<home>/.update-journal/`. It is outside everything the snapshot restores, so a rollback can never erase its own failure record.

---

## 2. The attempt journal (2.1)

### 2.1 Layout
```
<home>/.update-journal/
  current                  → "<attemptId>" (the one open attempt; absent when none)
  attempts/<attemptId>/
    attempt.json           the record below (replaced atomically on every change)
    inbox/                 held inbound, one file per item, named <seq>-<source>.json (2.2/2.4)
    deferred.json          scheduled jobs deferred by the update (2.2)
    snapshot/              the state copy (2.3), with snapshot.json (its manifest)
    replaced/              on restore: the new version's state, moved aside for forensics (2.3)
  marks.json               append-only: versions that rolled back here ({version, integrity, at, attemptId})
```
- The directory is mode 0700, its files 0600.
- `attemptId` is a time-sortable id (`<ISO>-<8 hex>`).
- Old attempts are kept, then pruned:
  - committed attempts: 7 days after commit, snapshot included;
  - failed or rolled-back attempts: 30 days, but the snapshot only 7 days;
  - `marks.json` is never pruned.

### 2.2 The record (`attempt.json`, schema 1)
```ts
{
  schema: 1,
  id: string,
  createdAt: string,
  updater: { pid: number; start: ProcessStart },        // ProcessStart = install-lock's { processStart, startTicks?, bootId? }
  identity: InstallIdentity,                            // §3, proven at open and re-proven before every mutation
  from: Artifact,                                       // the running package
  to: Artifact,                                         // the target
  baseline: { adapters: string[]; agents: Array<{ name: string; state: "running" | "stopped" | "paused" }> },
  stage: Stage,
  history: Array<{ stage: Stage; at: string; note?: string }>,   // append-only
  outcome?: { kind: "committed" | "rolled-back" | "abandoned" | "manual-recovery"; reason?: string; at: string },
}
Artifact = { name: "@songsid/agend"; version: string; integrity: string | null }   // integrity: npm's sha512 (Phase 3 binds it to the signed index)
```

### 2.3 Stages and allowed transitions
```
opened ─► barrier ─► stopping ─► snapshotted ─► installing ─► trial ─► proving ─► committed
   │         │           │            │              │           │         │
   └─────────┴──► abandoned           └──────────────┴───────────┴─────────┴──► rolling-back ─► rolled-back
                 (before any stop)                                                    │
                                                                                      └──► manual-recovery
```
- `journal.advance(to)` refuses any transition not in this table. Every write appends to `history`.
- The terminal stages are `committed`, `rolled-back`, `abandoned` and `manual-recovery`. A terminal attempt clears `current`. Only `manual-recovery` keeps `current` set: a person must clear it (`agend update --resolve`, §5).
- A rolled-back attempt appends `{ version, integrity }` to `marks.json` before it is marked terminal. Automatic or scheduled updates (Phase 5, required updates) never retry a marked version. An admin's own press may, after a confirmation that names the failure.

### 2.4 Writes
- **Each `attempt.json` write** goes: write `attempt.json.tmp`, `fsync`, rename over the old file, `fsync` the directory.
- **Readers:**
  - A missing file is no attempt.
  - An unreadable or invalid file is **unknown**. Every reader treats it as an open attempt, so P8 is `update-running` and a fleet start goes to recovery. It is never read as "no attempt".
- **Who writes:** only the process that holds the home lock with this attempt's id writes the stage. The fleet writes only `inbox/` and `deferred.json` (2.2/2.4), each item in its own atomically written file.

### 2.5 Module
`src/update-journal.ts`:
- `openAttempt(home, init) → Attempt | { refused }`. It is refused while another attempt is open.
- `readCurrent(home) → { state: "none" } | { state: "open", attempt } | { state: "unknown", reason }`.
- `Attempt.advance(stage, note?)`, `Attempt.finish(outcome)`, `markRolledBack(home, artifact)`, `isMarked(home, artifact)`.
- `prune(home, now)`.

It is pure file I/O with injected `fs` and `now`, and its tests run on a real temp directory.

---

## 3. Identity and the three locks (§4.2)

### 3.1 `InstallIdentity`
```ts
{
  package: { dir: string; root: string; prefix: string; npmRoot: string; bins: Record<string, string> },  // realpaths
  home: string,                                         // realpath(AGEND_HOME)
  service: { kind: "systemd-user" | "systemd-system" | "launchd"; unit: string; execStart: string; fragment: string; needsReload: false } | null,
  fleet: { pid: number; start: ProcessStart; exe: string; argv: string[]; cgroup: string | null; mainPid: number | null },
}
```
- `proveIdentity(deps) → InstallIdentity | { unknown: reason }` reuses the pre-flight's probes:
  - P1's install;
  - P3's unit query, extended to `ExecStart`, `FragmentPath` and `MainPID`;
  - P2's fleet proof.
- `sameIdentity(a, b)` compares every field, except the fleet when the stage is past `stopping` (the fleet is then expected to be gone).

### 3.2 The locks, all held from step 1 to step 8
1. **Prefix lock:** `<prefix>/.agend-install.lock` (today's).
2. **Home lock:** `<home>/.update.lock` (slice 1.3). Its record gains `attemptId`.
3. **Service lock:** `<home>/.service.lock`, new, the same owned-lock mechanism.
   - The updater takes it around every service reload, start and stop.
   - `agend start`, `stop`, `restart` and `service install` also take it, briefly, and are refused while a live updater holds it. The updater's own calls pass a token (`AGEND_SERVICE_LOCK_TOKEN`), the way the prefix lock admits its own npm child.

Taken in that order and released in reverse. Taking one can fail; then the ones already taken are released and the attempt is not opened.

### 3.3 Re-proof before every mutation
- **When:** before the snapshot, the install, the service reload/start, a restore, and a rollback's start.
- **What:** the updater calls `proveIdentity` again and compares it with `attempt.identity`.
- **Outcome:**
  - A mismatch or unknown before the install becomes **abandoned**. Nothing is changed yet, the old fleet is restarted, and the inbox is handed back (2.2).
  - After the install it becomes **rolling-back**.
  - In a rollback, it becomes **manual-recovery**. A restore must never land on another install's state.

---

## 4. Stop, then snapshot; restore (2.3)

### 4.1 Writers gone (the proof before a copy)
The old fleet is stopped by the service manager, under the service lock, and then proven gone on all four counts before anything is copied:
- the fleet pid from `identity.fleet` is gone: no such pid, or a pid with another start;
- `fleet.lock` is released: absent, or naming a proven-gone process;
- the unit is inactive (`ActiveState=inactive|failed`), or the launchd job is not running;
- no process of this user holds any snapshot file open. Linux scans `/proc/*/fd`; macOS runs `lsof -Fn +D <home>`, bounded to the files in §4.2.

An agent's CLI (Claude Code, Codex) whose own database sits in the home but outside the snapshot set doesn't block. A process with a snapshot file open does: the copy waits up to 60 s for it, then the attempt is abandoned (the old fleet restarts).

### 4.2 What the snapshot holds
The S-233 rehearsal (2.3.5 → 2.4 → 2.3.5 → 2.4) and the code's inventory show:
- the config;
- every AgEnD-owned database;
- the AgEnD-owned state files and directories;
- not the CLIs' own homes or the agents' working directories.

**Included:** every path in the home except the excluded list below. It is an exclude list, not an include list, so a state file added later is snapshotted unless someone excludes it on purpose.
- The SQLite databases get special handling (§4.3): delivery-outbox, scheduler, events, profiles, reply-buttons, config-history, host-monitoring, update-idle, `credential-vault/claude.sqlite`, `hub/hub.sqlite`, `hub-member/**/member.sqlite`, `hub/member-room-askers-*.sqlite`.
- Also included:
  - `fleet.yaml`, `.env`, `classicBot.yaml`;
  - every `*.json` and `*.jsonl` state file;
  - `instances/*/` (excluding `output.log`);
  - `hub/` and `hub-member/` (with their keys and floors);
  - `web-*` assets, `task-files/`, `cards/`, `avatars/`, `general-bindings/`, `credential-keys/`, `access/`, `cli-env/`, `kiro-*`.
- The **Hub databases** matter most: a newer build's Hub schema refuses to be opened by an older build (`hub-state-newer`). Without the snapshot, a rolled-back Fleet would lose its Hub link.

**Excluded:**
| Path | Why |
|---|---|
| `.update-journal/` | it records the attempt, and is never restored |
| `workspaces/` | the agents' working directories (repos, their work); no migration touches them; large |
| `credential-profiles/*/*/` except `.claude.json` | the CLIs' homes (transcripts, caches); large; the CLI, not AgEnD, owns them. `.claude.json`, which AgEnD writes, is included |
| `cx/` | Codex's short home (its sessions and `state_5.sqlite`) |
| `cache/`, `cache-codex-rollouts.json`, `usage-last-good.json`, `search.db*` | caches and a rebuildable index |
| `*.log`, `instances/*/output.log`, `profiles/` (CPU) | logs |
| `tmux/`, `operator/`, `*.sock`, `fleet.pid`, `fleet.lock`, `.update.lock`, `.service.lock`, `tunnel.lease`, `web.token`, `view.token` | runtime; recreated at start; the locks are held now |
| `update-in-progress.json` | the Phase 1 marker; the journal supersedes it during a Phase 2 attempt |

- The S-233 rehearsal also watched `credential-profiles/**/.credentials.json` and `auth.json`. Those are the CLIs' sign-in files, written by the CLIs, and no AgEnD migration writes them. They are excluded, so a rollback never puts back an older token over a refreshed one.
- The exclude list lives in one module (`src/update-snapshot-scope.ts`). A test fails when a new file name appears in the inventory (`agent-file-read.ts`'s private list, plus a scan of the code's `join(dataDir, "…")` literals) without being classified as included or excluded.

### 4.3 How it is copied
- **Databases:**
  1. Every included SQLite database is opened read-write by the updater, alone. The writers are gone, which §4.1 proves.
  2. Then `PRAGMA wal_checkpoint(TRUNCATE)`, then closed. The database file then holds everything, and its `-wal` is empty.
  3. The `.db` file is copied, plus `-wal` and `-shm` if present (empty after the checkpoint, copied anyway so the manifest is exact).
  4. A database that can't be opened or checkpointed abandons the attempt (nothing changed yet).
- **Every other included file** is copied as it is:
  - `copyFile` with `COPYFILE_FICLONE` (a reflink where the filesystem has one, else a copy);
  - mode, owner and mtime are kept;
  - symlinks are copied as links, never followed;
  - files that are neither regular nor symlinks are refused (abandon).
- **The manifest:** `snapshot.json` lists every path with its size, mode and sha256, plus the schema/user_version of each database.
- **After the copy**, the manifest is re-read from the copy and verified. A mismatch abandons the attempt.
- **Space:** P6 adds the snapshot's size, computed from the same scope before the barrier opens. Phase 1 counted none.
- **The stage** moves to `snapshotted` only after the manifest verifies.

### 4.4 Restore (rollback)
Under the three locks, and after re-proving the identity:
1. Stop the new fleet, then prove writers gone (§4.1).
2. Move the **new** state aside. Every path in the snapshot scope that exists now (the scope, not only the manifest) is renamed into `attempts/<id>/replaced/`. That covers files the new version created, such as a new table's database or a new state file. They must not be left for the old version to meet.
3. Copy the snapshot back. Each file goes to `<path>.restore-tmp`, then `fsync`, then rename into place, with mode and mtime as recorded. Then the manifest is verified on the restored tree.
4. Restore the package and the unit (today's `package-preimage.ts` and `service-activation.ts`). The order: state, then package, then unit, so no step starts a fleet on mixed state.
5. Start the old version, and the stage becomes `rolled-back` (2.5 proves it started).

**Failures:**
- A copy that fails, or a manifest that doesn't verify, goes to **manual-recovery**. `replaced/` and the snapshot stay. The journal names both, with the exact commands to put either one back, and the service stays stopped.
- A restore is idempotent by design: run again after a crash at any point, it repeats steps 2–4, because `replaced/` only ever receives paths not yet moved.

### 4.5 Commit
- On commit (2.5), the snapshot is kept for 7 days.
- **Settings → Go back to v…** (2.6) uses it with the same restore. It is offered only while the snapshot exists and the attempt is committed, and it names what is lost: what changed since the commit, which `replaced/` keeps.

---

## 5. Crash recovery at fleet start (interface for 2.5)
`fleet start` reads `readCurrent(home)` before anything else, right after the home lock admission. Results:
- **none:** normal start.
- **unknown:** refuse to start, with the reason and `agend update --resolve`. An unreadable journal is never read as "no attempt".
- **open, and its updater is live:**
  - If this process is the attempt's own trial start (2.4's token), go on in trial mode.
  - Otherwise refuse: the update is in progress.
- **open, and its updater is gone (crashed):** recovery by stage, run by this start under the three locks.

| Stage left | Recovery |
|---|---|
| `opened`, `barrier` | abandoned. Hand back the inbox and deferred jobs (2.2), then a normal start |
| `stopping` | abandoned if the snapshot isn't recorded. The state wasn't changed, so a normal start, with the inbox handed back |
| `snapshotted`, `installing` | the package may be half-installed: restore it (package preimage, plus the state if the snapshot verifies), then `rolled-back`, then start the old version |
| `trial`, `proving` | roll back (§4.4) |
| `rolling-back` | finish the rollback (§4.4 is idempotent) |
| `manual-recovery` | refuse to start, naming the attempt, `replaced/`, the snapshot and the commands. `agend update --resolve` clears it after a person's choice |

The table is a pure function, `recoveryPlan(attempt, updaterAlive) → Action`, tested by itself. Wiring it into `fleet start` is 2.5's job, and it lands with it. 2.1 ships the function and its tests.

---

## 6. What 2.1 and 2.3 ship, and their tests

**2.1** (`update-journal.ts`, `install-identity.ts`, the service lock):
- the journal with its stage table and atomic writes;
- `marks.json`;
- `readCurrent`'s unknown state, which P8 now reads too: an open or unknown attempt is `update-running`;
- `proveIdentity` and `sameIdentity`;
- `.service.lock` taken by the CLI's service commands, and refused while held;
- `recoveryPlan`.

Tests:
- on a real temp home: atomic writes, illegal transitions refused, the crash-left `.tmp` ignored, an unknown journal, marks append-only;
- identity mismatch cases;
- the service lock between real processes (the rig's `lock.mjs` style).

**2.3** (`update-snapshot.ts`, `update-snapshot-scope.ts`):
- the scope;
- writers-gone;
- checkpoint and copy with the manifest;
- the restore with `replaced/`.

Tests:
- on a real temp home seeded like S-233: real WAL databases with uncommitted WAL frames (checkpointed into the copy), a Hub database, an excluded workspace and CLI home, a new file and a new database created "by the new version";
- the restore yields the old bytes, and the new ones sit in `replaced/`;
- a writer still holding a file blocks the copy;
- an interrupted restore re-runs to the same result;
- a manifest mismatch goes to manual-recovery;
- the scope-inventory test.

**Real rig, after both:** two npm prefixes as in 1.2/1.3, an old and a new version built from this branch. A real `agend update` would start fleets, so the rig drives the transaction's functions with a stand-in "fleet" process holding the home's files (no fleet start). It covers:
- snapshot;
- a "new version" that migrates fleet.yaml and adds a table and a file;
- a forced failure;
- restore;
- byte comparison with the pre-update home.

The S-233 rig's 2.3.5 ↔ beta.24 data (fleet.yaml with `monitoring:`, the outbox contact tables, a WebP office pack, a Hub member link) is the seed. dev-claude2 owns that rig; I'll copy its seed script, not its home.

---

## 7. Open points for review
1. **The exclude list** (§4.2), especially `credential-profiles/` (only `.claude.json` kept) and `workspaces/`. A new version that migrates something in them couldn't be rolled back. Today none does; the scope test keeps that visible.
2. **The service lock** refusing `agend start`, `stop` and `restart` while an update runs. The other choice is waiting with a timeout. I propose refusing with the attempt's id and stage: the updater owns the service for the attempt.
3. **Stage `snapshotted`/`installing` recovery** restores the state too, even though no new version has run on it yet. That is harmless, because the snapshot equals the state, and it keeps one rule: any stage after the snapshot rolls back fully.
4. **The 60 s wait** for a snapshot file held open, before abandoning.
