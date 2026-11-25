# The update transaction: attempt journal, locks, snapshot and restore (M-3770 slices 2.1 and 2.3)

Design note for Phase 2 of `docs/design/update-adoption-m3762.md` (#4480, approved), §3.3 steps 1, 3, 4 and 7, and §4.2. It covers:
- **2.1:** the attempt journal, identity, the three locks, and the recovery kit;
- **2.3:** stop-then-snapshot and restore.

It also fixes the interfaces that 2.2 (the quiescence barrier, GrokCore) and 2.5 (health proof, commit/rollback) build on. No UI; 2.6 words what this records.

**Scope.** Phase 2 runs only on a machine in class **self** (§4 of the design), and only when both the running version and the target speak this transaction (from- and to-version ≥ V_tx). Anywhere else, Phase 1's updater runs unchanged.

**Revision 2** answers Prism's design review (6065369545); **revision 3** answers its scoped pass (6065419816). The changes are mapped in §9.

---

## 1. Who does what

**The updater** (`agend update`, launched detached and outside the fleet's cgroup) owns the transaction. Only the updater, or the **recovery runner** acting for a dead updater (§6), writes stages.

**The fleet:**
- **Old fleet:** fences inbound and writes the update inbox and the deferred jobs (2.2) before it stops.
- **New fleet in trial mode:** writes its inbound into the journal (2.4).
- **Any fleet start:** reads the journal first and refuses to start normally while an attempt is open (§7).

**The journal** lives at `<home>/.update-journal/`. It is outside everything the snapshot restores.

---

## 2. The attempt journal (2.1)

### 2.1 Layout
```
<home>/.update-journal/
  current                       the open attempt's id: THE authority for "an attempt is open" (§2.4)
  attempts/<attemptId>/
    attempt.json                the record (§2.2), replaced atomically
    inbox/  deferred.json       2.2/2.4: held inbound, deferred jobs (one atomically written file per item)
    snapshot/  snapshot.json    2.3: the state copy and its manifest (§5)
    restore.log                 2.3: the restore's per-path progress, append-only (§5.5)
    replaced/                   2.3: the new version's state, moved aside on restore; never overwritten
    unit.preimage               the service definition's bytes before the attempt (§6.3)
  recovery/<attemptId>/         the recovery kit (§6): node, recover.cjs, kit.json
  marks.json                    append-only: versions that rolled back here
  retained.json                 artifacts kept for Go back (§5.7), with what references them
```
- The directory is mode 0700, its files 0600.
- `attemptId` is time-sortable: `<ISO>-<8 hex>`.
- The package preimage lives beside the package, on its filesystem, so its renames are atomic: `<prefix>/.agend-rollback/attempt-<attemptId>/` (§6.3).

### 2.2 The record (`attempt.json`, schema 1)
```ts
{
  schema: 1, id, kind: "update" | "go-back", createdAt,
  updater: { pid, start: ProcessStart },            // ProcessStart = install-lock's { processStart, startTicks?, bootId? }
  owner: Ownership,                                 // §3.1: invariant for the whole attempt
  expected: { old: ArtifactTuple; new: ArtifactTuple | null },   // §3.2: new is recorded once the install is verified
  fleets: FleetGeneration[],                        // §3.3: every fleet the attempt knows: old, trial, rollback start
  from: Artifact, to: Artifact,                     // { name, version, integrity }
  baseline: { adapters: string[]; agents: Array<{ name; state }> },
  stage: Stage, substep?: string,                   // substep: the last durable step inside a stage (§5.5, §6.3)
  history: Array<{ stage; substep?; at; note? }>,   // append-only
  outcome?: { kind: "committed" | "rolled-back" | "abandoned" | "manual-recovery"; reason?; at },
  goBackOf?: attemptId,                             // kind go-back: the committed attempt whose artifacts it uses
}
```

### 2.3 Stages and transitions
```
opened ─► barrier ─► stopping ─► snapshotted ─► installing ─► trial ─► proving ─► committing ─► committed
   │         │          │                                                          │
   └─────────┴──────────┴─► abandoning ─► abandoned                                 │
                          (no snapshot published; nothing installed)               │
              snapshotted, installing, trial, proving ──► rolling-back ─► rolled-back
                                    any stage ──► manual-recovery (only on unknown ownership or a failed restore)
```
- `advance(to)` refuses any transition not in this table, and every write appends to `history`.
- **Abandon is a procedure, not a label.** `abandoning` runs three journaled substeps:
  1. `restart-old`: start the old fleet if it was stopped, as generation old;
  2. `hand-back`: the old fleet takes the inbox and the deferred jobs, and acknowledges them in the journal;
  3. `done`.

  Only then is it `abandoned`. A crash anywhere in it resumes at the substep recorded.
- `abandoning` is allowed from `stopping` only while no snapshot is published and nothing is installed. Then the state is the old fleet's own, unchanged. Once `snapshotted` is published, every failure goes to `rolling-back` instead (open point 3, §8).
- `committing` holds 2.5's commit substeps (leave trial, start agents, deliver the inbox, run deferred jobs). A crash there resumes them. It never rolls back after agents have started.

### 2.4 Publication order (what is durable when)
"Fsync" below means the file, and then its directory.

**Open:**
1. Create `attempts/<id>/attempt.json` (stage `opened`); fsync.
2. Write `current` = id: `current.tmp`, fsync, rename, fsync.

A crash between 1 and 2 leaves an attempt directory that no `current` names. It is never acted on, and pruning removes it after 30 days.

**Stage writes:** `attempt.json.tmp`, fsync, rename, fsync. A substep that changes the world (a rename, a copy, a service call) is journaled **after** its effect is durable, and its retry recognises an effect that's already done (§5.5, §6.3).

**Terminal:**
1. For `rolled-back`: append `{ version, integrity, attemptId }` to `marks.json` and fsync.
2. Write `attempt.json` with the terminal stage and outcome; fsync.
3. Clear `current`: rename it to `attempts/<id>/current.closed`; fsync the journal directory.

`manual-recovery` never clears `current`. Only `agend update --resolve` does, after a person's choice, and it records that choice in `history`.

### 2.5 Reading the journal
| `current` | Its attempt | Result |
|---|---|---|
| absent | — | **none** (the only "no attempt") |
| present but unreadable or empty | — | **unknown** |
| names an id | `attempt.json` missing, unreadable or invalid | **unknown** |
| names an id | a non-terminal stage | **open** |
| names an id | `committed`, `rolled-back` or `abandoned` (a crash between terminal steps 2 and 3) | **closing**: the next holder of the home lock finishes step 3; nothing else is done |
| names an id | `manual-recovery` | **manual**: refused until resolved |

- **unknown blocks everything:** P8 reads it as `update-running`, a fleet start refuses (§7), and a new attempt can't open. The words name the path and `agend update --resolve`.
- **`marks.json` is never pruned.** An unreadable `marks.json` means automatic and required updates refuse every version until it is repaired. It is never read as "no marks".

### 2.6 Updater liveness
`updaterState(attempt) → live | gone | unknown`, by install-lock's `holderState` on `{ pid, start }`.
- `gone` only on proof: no such pid, or a pid with another start in the same boot.
- `unknown` (start unreadable, a boot id that can't be read) never authorizes taking over. A fleet start then refuses with the attempt's id and stage. The recovery runner refuses too, unless an operator runs it with `--takeover <attemptId>`, which is recorded.

---

## 3. Identity: invariant ownership, expected tuples, fleet generations (§4.2)

### 3.1 Ownership: invariant for the whole attempt
```ts
Ownership = { uid; home: realpath; prefix: realpath; packagePath: "<root>/@songsid/agend" (the path, not its contents);
              service: { kind; unit; fragmentPath } | null }
```
- It is proven when the attempt opens, under the locks, and re-proven before every mutation.
- **A mismatch, or an ownership that can't be proven, never authorizes a mutation:**
  - before anything is installed, the attempt is abandoned (§2.3);
  - from then on, it goes to **manual-recovery**. A rollback must not land on a destination whose ownership is now unknown.

### 3.2 Expected artifact tuples: what the stage expects to find
```ts
ArtifactTuple = { version; integrity; bins: Record<"agend"|"agend-agent", realpath>; entry: realpath of dist/cli.js;
                  interpreter: realpath of the Node it runs on; execStart: the service's ExecStart/ProgramArguments }
```
`expected.old` is recorded at open. `expected.new` is recorded after the install verifies.

**The forward-install intent (rev 3).** A crash inside npm happens before `expected.new` exists. So before npm runs, the updater journals `installing` with substep `intent`:
```ts
installIntent = { preimage: { dir, manifestSha256 }, destination: { packagePath, binLinks: string[] }, target: Artifact, command: string[] }
```
- The preimage must already be verified (§6.3) when this is written.
- **While `installing`:** the package path's contents may be anything partial, *inside the recorded destination only*: the package path and the named bin links. Such a partial package authorizes exactly one thing, a restore from the verified preimage.
- **Ownership** (uid, home, prefix, unit, fragment; §3.1) is still required to match, and the **service definition** must still be the attempt's own (its drop-in, §6.2, and `unit.preimage`'s fragment). Any change there fails closed into manual-recovery.

Each stage compares the live tuple with the one it expects:

| Stage | Expected |
|---|---|
| `opened` to `stopping`, `snapshotted` | `old` |
| `installing` | `old`, or `new`, or partial within the intent's destination |
| `trial`, `proving`, `committing` | `new` |
| `rolling-back` | whatever the restore's journaled substeps say is current |

Anything else goes to manual-recovery.

### 3.3 Fleet generations
- `fleets[]` records each fleet the attempt knows: `{ gen: "old" | "trial" | "rollback", nonce, pid?, start?, bootId, exe?, argv?, mainPid? }`.
- **Planned before it is started (rev 3).** Before the updater, or the recovery runner, starts a fleet, it journals the generation with a fresh `nonce` and no pid (substep `start-planned`). The started fleet takes `fleet.lock` through the handoff (§4.3) with that nonce. Its pid is then recorded from the lock record, so a start whose pid line never landed is still recognised by its nonce.
- **Stopping a fleet** requires it to be the recorded generation that the stage expects: `old` before the snapshot, `trial` on rollback. Identity comes from the `fleet.lock` record (pid plus nonce) and the service manager's MainPID.
- **An unrecorded holder** of `fleet.lock`, or a MainPID that matches no generation, is not stopped. The attempt goes to manual-recovery.

### 3.4 The locks
- **Order:** home, then prefix, then service. That is the order the shipped CLI already takes home and prefix in (#4489). Release is in reverse.
- **All three** are held from the open to the terminal write (§2.4 step 3), then released.
1. **Home lock** `<home>/.update.lock` (1.3). Its record gains `attemptId`.
2. **Prefix lock** `<prefix>/.agend-install.lock` (today's).
3. **Service lock** `<home>/.service.lock`, new, the same owned-lock mechanism. Its record names `attemptId` and the updater.
   - `agend start`, `stop`, `restart` and `service install` take it briefly. They are refused **promptly** while a live attempt holds it, with its id and stage; nothing is queued (open point 2, §8).
   - The updater runs `systemctl`/`launchctl` itself.
   - A child the updater spawns that must act on the service (the trial start through `agend`) carries `AGEND_SERVICE_LOCK_TOKEN` = the lock record's token. It is admitted only while that record is held by a live updater of the same `attemptId`.
   - The token is never written anywhere but the lock file (0600) and that child's environment.
- **The recovery runner** (§6) takes the same three locks in the same order before acting for a dead updater.

---

## 4. Writers: excluded for the whole interval (2.3)

The snapshot and the restore run only while nothing else can write the home's state. **Exclusion is enforced, not inferred from one scan.**

### 4.1 Who can write an included file
By the writer inventory (§5.1), every included path is written only by **this install's AgEnD processes**:
- the fleet;
- its daemons;
- the `agend` CLI's state-writing commands (for example `agend task`, which writes `scheduler.db` from a shell).

Neither CLI-owned files nor files in a CLI's profile are included, rev 3. `credential-profiles/` is now excluded whole (§5.1), so no included file has an external writer.
- **Other installs:** none can be present. Phase 2 runs only in class self, so P2 has proven no other install's fleet, service or global copy.

### 4.2 Stop, fence, and enforce
1. **Stop:**
   - the old fleet (its recorded generation, §3.3);
   - its daemons;
   - the agents' CLI processes it started for this home;
   - the home's private tmux server.
   The agents stop through the fleet's own stop, then each recorded pane process is confirmed gone.
2. **Fence the fleet:** the updater takes `fleet.lock` itself, with role `update` and its attempt id. Every fleet start, and with it every agent start, is refused until the handoff (§4.3).
3. **Fence the CLI:** every state-writing `agend` command checks the journal before it opens a file of the scope. While `current` names an open, unknown or manual attempt, it refuses with the attempt's id and stage.
   - The check sits in one place: the CLI's state-open helpers, which `scheduler/db.ts`, the config writer and the like already go through. The writer inventory's test lists every state-writing command and fails if one bypasses the check.
   - Only the authenticated helpers (§4.4) are exempt.
4. **The proof:** the writers-gone proof (§4.4) runs after the fences, and again after the copy or restore, before its result is published.
5. **The wait:** a writer still present gets 60 s, polled. On expiry the recorded abandon procedure runs: restart the old fleet, hand back the inbox and the deferred jobs, then `abandoned` (open point 4, §8).

### 4.3 The fleet.lock handoff: no unowned gap
- `fleet.lock` holds the updater's record `{ pid, role: "update", attemptId, handoff: null }` from the fence until a fleet the attempt starts takes it over.
- **To start a generation** (`trial`, `rollback`, or `old` on abandon):
  1. The updater or runner journals the planned generation (§3.3).
  2. It writes `handoff: { nonce, gen }` into its own lock record: tmp, fsync, rename.
  3. It starts the service, or spawns the fleet when there is no service.
- **The starting fleet's `acquireFleetLock`**, finding role `update`:
  - takes it over only when the attempt's journal names a planned generation with exactly that nonce, unconsumed, and the lock record's handoff carries the same;
  - takes over by writing its own record `{ pid, role: "fleet", nonce }` to a tmp file and renaming it over the lock: one atomic replacement, never a release and a re-acquire;
  - refuses on any other record or nonce.
- **The nonce** reaches a service start through the journal: the pre-start step (§6.2) passes it on as `AGEND_UPDATE_HANDOFF`. A spawned fleet gets it in its environment. It is single-use: the journal marks it consumed when the pid lands.

### 4.4 The writers-gone proof, and who is exempt
- **The proof looks for** any process of this uid that has `AGEND_HOME` equal to this home, its cwd under the home, or a file of the scope open or mapped (Linux `/proc/*/{environ,cwd,fd,maps}`; macOS `lsof -Fn +D`).
- **An incomplete scan** (a failed listing, or a process of this uid that can't be read) is never proof of absence.
- **The exempt set** is exactly these, each recorded with its start time:
  - the updater (`attempt.updater`);
  - the recovery runner (`attempt.runner`, §6.2);
  - processes whose ancestor chain, by `/proc/<pid>/stat` ppid read with start times, reaches one of those two and that the attempt itself spawned (`attempt.helpers[]`, written before the spawn is acknowledged).
  Nothing else is exempt, by name or by argv.

### 4.5 SQLite: committed content only, checkpoint checked
For each included database:
1. Open it, alone, at its **confined real path** (§5.2).
2. Run `PRAGMA wal_checkpoint(TRUNCATE)` and read its result row `(busy, log, checkpointed)`. Require `busy = 0` and `log = checkpointed`; after TRUNCATE, `log = 0`. Anything else is an incomplete checkpoint: the attempt is abandoned.
3. Run `PRAGMA quick_check`; it must be `ok`.
4. Close it. The `.db` file then holds every committed transaction. A torn or uncommitted WAL tail is never checkpointed, so it isn't in the snapshot.
5. Copy the `.db` file. `-wal` and `-shm` are not copied: after a checkpoint that verifies, they hold nothing the database needs, and an old build recreates them.

The test seeds committed WAL frames that aren't checkpointed yet (they must be in the copy), plus a torn uncommitted tail (it must not be).

---

## 5. Snapshot and restore (2.3)

### 5.1 Scope (an exclude list, drawn from the inventory and S-233)
- **Included:** every path in the home except the excluded list below.
- **Excluded:**
  - `.update-journal/`;
  - `workspaces/` (the agents' working directories);
  - `credential-profiles/` (whole, rev 3: the CLIs' homes, including the profiles' `.claude.json`);
  - `cx/`;
  - `cache/`, `cache-codex-rollouts.json`, `usage-last-good.json`, `search.db*` (caches and a rebuildable index);
  - logs (`*.log`, `instances/*/output.log`, `profiles/`);
  - runtime (`tmux/`, `operator/`, `*.sock`, `fleet.pid`, `fleet.lock`, the update and service locks, `tunnel.lease`, `web.token`, `view.token`);
  - `update-in-progress.json`.
- **Why the snapshot exists:** the Hub databases are included. An older build refuses a newer Hub schema.

**The writer inventory and eligibility (rev 3).** `src/update-snapshot-scope.ts` holds the scope and, next to it, the **writer inventory**: every module that writes a file, with its path and its **phase**.
- **pre-commit:** fleet startup in trial mode, migrations, the update and rollback themselves.
- **post-commit:** agent launch, CLI activity, ordinary operation.

Paths outside the home are listed too. Today these are:
- the default Claude Code config, `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json` (`backend/claude-code.ts:158-161`, written when an agent launches, for trust and onboarding);
- a profile's own `.claude.json` (`credential-profiles/claude-code/*/.claude.json`, at agent launch);
- the CLIs' own files, which AgEnD never writes.

The test fails when a path literal written by the code (a scan of `join(dataDir, …)`, `homedir()`, `CLAUDE_CONFIG_DIR`) isn't classified.

**Eligibility.** A release is eligible for the transaction's automatic rollback only when **no pre-commit writer touches an excluded or outside path**. Ordinary post-commit writes to excluded state (logs, caches, agent and CLI activity, a `.claude.json` at agent launch) don't count:
- agents aren't started before commit (trial mode, 2.4);
- a rollback after commit is Go back, which names what it can't restore.

Today's inventory has no pre-commit writer outside the scope. A release that adds one updates through Phase 1, on an admin's press. Phase 3's index carries the flag; until then it is the running build's inventory.

### 5.2 Confinement (before anything is opened)
- The scope is walked from `realpath(home)` with `lstat`, never following a link.
- **Symlinks:** a symlink is recorded as a link, with its target text; it is not opened and its target is not copied. A symlinked **directory** is a link and is not entered.
- **Every included regular file**, a database first, must have a path whose components below the home are all real directories (`lstat`, no link), and whose `realpath` is inside `realpath(home)`.
- **Databases** are opened only after that check. Their `dev`/`ino` is compared before and after the open, and a difference abandons the attempt.
- Files that are neither regular files, directories nor symlinks are refused, and the attempt is abandoned.

### 5.3 The copy and its durability
- **Each file:** copied to `snapshot/<rel>` (`COPYFILE_FICLONE`, else a copy) with its mode and mtime, then fsynced.
- **Each directory:** fsynced bottom-up after its entries.
- **The manifest**, `snapshot.json`, lists every entry: `{ rel, type: "file" | "dir" | "link", mode, size?, sha256?, target? }`, plus each database's `user_version` and schema hash.
- **The order:** the manifest is written last and fsynced, then the attempt directory, then stage `snapshotted` is published.
- **Verification:** the snapshot tree is walked again and compared with the manifest as an exact set: no extra entry, no missing one, the same types, sha256 and link targets. A mismatch, before `snapshotted` is published, is abandoning.
- **Immutability:** `snapshot/` is never written after `snapshotted`. A restore copies from it and never renames out of it.

### 5.4 Space
P6 adds the scope's size, measured before the barrier opens.

### 5.5 Restore: a per-unit protocol, crash-safe

**Units and containers (rev 3).** The scope splits into two kinds of path:
- **A unit** is the largest path whose whole subtree is in scope: a file, a link, or a directory with no excluded descendant. A unit moves and is restored **whole**, as one subtree.
- **A container** is a directory with some excluded descendants: the home itself, `instances/<name>/` (its `output.log` is excluded), `hub/`. A container is **never moved**. Its included children are units of their own, and its mode is restored separately at the end.
- Units never nest, so no move lands on a non-empty destination it created itself.

**The plan.** Under the three locks, with ownership re-proven (§3.1) and the writers fenced (§4):
1. Compute the current units: every unit present now, with `{ type, dev, ino, size, mtime }` for its root.
2. Write `restore.log`'s header: those units plus the snapshot manifest's sha256. Fsync.

Nothing is moved before the header is durable. A crash before then means no `restore.log`, and the restore starts again from the plan.

**Per unit** `u`, in a fixed order: (current units ∪ manifest units), sorted by path:
- **`aside`** (u is in the current units): rename `<home>/u` to `replaced/u` (its parent containers are created there first), fsync both parent directories, then log `aside`.
- **`restored`** (u is in the manifest):
  1. Build the unit from `snapshot/u` at `<home>/u.restore-tmp`: a file copied; a directory copied as a tree (each file fsynced, then directories bottom-up); a link created with its recorded target.
  2. Rename `<home>/u.restore-tmp` to `<home>/u`, fsync the parent, then log `restored`.
- A **new-only unit** (current, not in the manifest) is only moved aside.
- **Containers** missing in the home are created, and every container's mode is set as recorded. This is logged as `containers`.

**A retry** replays the log. For each unit `u`:
| Logged | Found | Action |
|---|---|---|
| `restored` | — | done |
| `aside`, not `restored` | `<home>/u` exists and matches the manifest | log `restored` (the rename landed; its log line didn't) |
| `aside`, not `restored` | otherwise | remove `<home>/u.restore-tmp` if present; build and rename again |
| neither | `<home>/u` absent, and `replaced/u` exists with the header's `{ dev, ino, type }` for u | log `aside` (the move landed; its log line didn't); go on as above |
| neither | `<home>/u` present, and `replaced/u` absent | do `aside`, then `restored` |
| neither | `<home>/u` absent, and u isn't in the current units (manifest-only) | `restored` |
| neither | anything else (both present; or `replaced/u` with another identity) | manual-recovery |

**After every unit:**
- run `containers`;
- verify the restored scope against the manifest as an exact set;
- run the writers-gone proof (§4.4) again;
- log `verified`.

`replaced/` and `snapshot/` are never modified by a retry. The crash test seeds nested directories, links, a new-only file and a new-only directory, a container with an excluded child, and a manifest-only unit. It crashes after every rename, every fsync and before every log line, including before the first `aside` line, and requires the same end state from each point.

### 5.6 Commit
- At commit (2.5), the attempt's artifacts are recorded in `retained.json` for **Go back**: the snapshot, the package preimage, the unit preimage and the recovery kit. They are kept for 7 days.
- `current` is cleared as in §2.4.

### 5.7 Go back, and retention
- **Go back** is a new attempt (`kind: "go-back"`, `goBackOf: <committed id>`) with its own `current`, locks, journal and generations.
- It restores with §5.5, using the committed attempt's snapshot and preimages, which `retained.json` protects. It is offered only while they all exist and verify (manifest, kit hash).
- It names what will be lost: what changed since the commit, which its restore moves into its own `replaced/`.

**Pruning** runs under the home lock. It never removes:
- the attempt `current` names;
- any `manual-recovery` attempt;
- an artifact referenced in `retained.json` before its expiry;
- `marks.json`.

**Later updates:**
- A later update's `prunePreimages` skips the `attempt-*` preimages.
- A later update can't open while a go-back-eligible attempt's artifacts would be its own preimage path; ids are unique, so they never are.

---

## 6. The recovery runner: independent of the package being replaced

### 6.1 The kit
Before the install starts (still in `snapshotted`), the updater writes `<home>/.update-journal/recovery/<attemptId>/`:
- **`node`:** a copy of the Node binary the old version runs on (its realpath).
  - It is checked to run alone: `node -e 1`.
  - If it needs shared libraries outside the system, as with nvm's builds, they are recorded in `kit.json`. A kit that can't run alone abandons the attempt before the install.
- **`recover.cjs`:** one file, using Node's built-ins only, built from `src/update-recovery/` into a single bundle at release time.
  - It holds the journal reader, `recoveryPlan`, the restore (§5.5), the package and unit restores (§6.3) and the three locks.
  - It never imports the package being replaced.
- **`kit.json`:** the versions and sha256 of both files, the attempt id, the home.

The kit is kept as long as anything can still need it: through `rolled-back`/`manual-recovery` until resolved, and through the Go-back window after a commit.

### 6.2 How it is reached: a pre-start check that hands off, never runs the transaction itself
**The pre-start step (rev 3).** Before the install, under the service lock, the service definition gains a pre-start step:
- **systemd:** a drop-in `<unit>.d/agend-update-recovery.conf` with `ExecStartPre=<kit>/node <kit>/recover.cjs --home <home> --pre-start`;
- **launchd:** a wrapper in `ProgramArguments`.

The original definition's bytes are `unit.preimage`. The pre-start step runs **inside the service's start**, so it never stops, starts or reloads that service, and never restores anything. It only decides, from the journal:
| Journal | Pre-start does |
|---|---|
| none | exit 0: a normal start (launchd: exec the original arguments) |
| open; updater or runner live; a planned generation with an unconsumed handoff nonce (§4.3) | pass `AGEND_UPDATE_HANDOFF=<nonce>` on (systemd: written to `attempts/<id>/handoff.env`, read by the unit's `EnvironmentFile=-` in the same drop-in); exit 0 |
| open; updater or runner live; no planned generation | exit non-zero: "AgEnD is updating (attempt, stage); this start is refused". The updater owns the service until the end |
| open; updater and runner gone | start the **independent runner**, then exit non-zero (the start is refused) |
| open; updater or runner liveness unknown, or unknown or manual | exit non-zero with the paths and the operator command |

**The independent runner** runs outside the service's cgroup and job:
- **systemd:** `systemd-run --user --unit=agend-update-recovery-<id> --collect --property=KillMode=process <kit>/node <kit>/recover.cjs --home <home> --run`. That is a transient service of its own, not a child of the unit.
- **launchd:** a separate job, `launchctl submit -l com.agend.update-recovery.<id> -- <kit>/node … --run`.

**The bootstrap handshake:**
1. The pre-start step starts the runner and waits up to 10 s for `attempts/<id>/runner.json` (the runner's `{ pid, start }`, written after it holds the three locks).
2. It then exits non-zero.
3. If the runner can't be started or doesn't answer, the pre-start step still exits non-zero, with the operator command. The service fails visibly, and nothing is half-done: the runner only acts under the locks.
4. While a runner is live, any further start (the unit's own `Restart=`) is refused at pre-start (the "live, no planned generation" row).

**The runner owns the final service transition:**
1. It waits until the refused start has ended: the unit is `inactive` or `failed`, and launchd's job is not running.
2. It runs `recoveryPlan` (§7) and restores, under the locks.
3. It removes the drop-in or wrapper (the unit restore, §6.3), then `daemon-reload` or the plist reload. That happens only with no start job in progress, so it never relies on a reload changing an active start's ExecStart.
4. It plans the `rollback` generation (§3.3).
5. It runs `systemctl --user reset-failed` and `start`, or `launchctl kickstart`, and waits for the generation's handoff.

**The operator command**, `<home>/.update-journal/recovery/<id>/node …/recover.cjs --home <home> --run`, is the same runner, run from a shell outside the service. It works with the package missing or broken.

**The live updater's own starts** (trial, abandon's restart) go through the same pre-start check, carrying their planned generation's nonce.

### 6.3 Package and unit restore: retryable substeps
`restorePackagePreimage` consumes its copy, so the transaction doesn't use it. Its own preimage is a **copy**, taken before the install: `<prefix>/.agend-rollback/attempt-<id>/agend` (with the bin links' targets recorded), fsynced and hashed into `kit.json`.

**The install** writes the forward intent (§3.2) after this preimage verifies and before npm runs.

**Package restore**, with each substep journaled after its effect:
1. `pkg-aside`: rename the current `<root>/@songsid/agend` to `<preimage>/replaced-package` (if present, and that destination is new).
2. `pkg-staged`: copy the preimage tree to `<root>/@songsid/.agend-restore-<id>`, then fsync.
3. `pkg-placed`: rename the staged tree into `<root>/@songsid/agend`.
4. `bins`: for each bin, create a symlink at `<bin>.restore-tmp`, then rename it over `<bin>`.

A retry recognises each effect by the path's presence and its hash against the preimage's manifest.

**Unit restore:** write `unit.preimage`'s bytes to `<fragment>.restore-tmp`, fsync, rename, remove the drop-in, then `daemon-reload`, under the service lock. A retry compares the fragment's bytes.

**The order** is state (§5.5), then package, then unit, then start the old version, recorded as generation `rollback`. Nothing starts a fleet on mixed state: the fences (§4.2) hold until that start's handoff (§4.3).

---

## 7. Crash recovery (`recoveryPlan`, used by the fleet start and by `recover.cjs`)
`recoveryPlan(journalRead, updaterState) → Action` is a pure function, tested by itself. 2.1 ships it; 2.5 wires it into the fleet start (which defers to the same rules).

| Journal / updater | Action |
|---|---|
| none | start normally |
| unknown, manual | refuse, naming the paths and `--resolve` |
| closing (§2.5) | finish the terminal step 3, then start normally |
| open, updater **live** | refuse (the update is in progress), unless this start is the attempt's own token-holding start |
| open, updater **unknown** | refuse; only an operator's `--takeover` |
| open, updater **gone**, stage `opened`, `barrier`, `stopping` (no snapshot), `abandoning` | resume abandoning at its substep: restart old, hand back, abandoned |
| open, gone, `snapshotted`, `installing`, `trial`, `proving`, `rolling-back` | resume rolling-back (§5.5, §6.3) at its logged step, then rolled-back, then start the old version |
| open, gone, `committing` | resume committing's substeps (2.5); never roll back after agents started |
| any step that finds ownership unknown or a tuple unexpected (§3) | manual-recovery |

---

## 8. Prism's answers to the open points (adopted)
1. **Exclusions:** conditional on the ownership contract (§5.1). A release that writes excluded or outside state isn't eligible for automatic rollback, and the inventory gate covers who writes what, not only file names. External or default CLI profile configuration that an update can change is inventoried too.
2. **Service commands during an attempt:** refused promptly with the attempt's id and stage; nothing queued (§3.4).
3. **Full restore from `snapshotted`/`installing`:** one rule, now that the snapshot and the retry protocol are specified (§5.5, §6.3).
4. **The 60 s writer wait:** bounded; expiry runs the recorded abandon procedure (restart, hand back), never discarding accepted work (§4.2).

---

## 9. What changed in revision 2 (Prism 6065369545)
| Review point | Where |
|---|---|
| 1. Per-path restore protocol, immutable originals, retryable package/unit restore, crash injection | §5.5, §6.3 |
| 2. A recovery runner independent of the package; how the service and the operator reach it; retention | §6, §5.7 |
| 3. Invariant ownership vs expected tuples per stage; fleet generations; lock order home → prefix → service; the service token's binding | §3 |
| 4. `current` as the authority; publication order; closing/terminal crash cases; live/gone/unknown updater; abandoning as a procedure | §2.3–2.6, §7 |
| 5. Writers fenced for the interval (stop, fleet.lock role `update`, proof after the fence and after the copy); incomplete scans; checkpoint result fields; committed WAL only | §4 |
| 6. Confinement before opening; link targets; exact-set manifest; fsync before publishing; pruning and Go back's own transaction | §5.2, §5.3, §5.7 |

---

### Revision 3 (Prism 6065419816)
| Review point | Where |
|---|---|
| 1. A landed `aside` before its log line; nested directories as units vs containers; new-only, manifest-only and link units; a crash before the first log line | §5.5 |
| 2. The recovery runner outside the service or job; the pre-start check only decides and hands off; the bootstrap handshake and its failures; the runner owns the final transition after the refused start ends; the live updater's starts carry a planned nonce | §6.2 |
| 3. Writers: `credential-profiles/` excluded whole, so no included file has an external writer; the CLI fence on state-writing commands; the atomic fleet.lock handoff by nonce; the authenticated exempt set | §4.1–4.4, §5.1 |
| 4. The forward-install intent before npm; partial contents only within the destination, authorizing a preimage restore; the planned generation and nonce before a start | §3.2, §3.3, §6.3 |
| Inventory: the default `.claude.json` outside the home named; eligibility by pre-commit writers only | §5.1 |

## 10. What 2.1 and 2.3 ship, and their tests
**2.1** ships:
- `update-journal.ts`: the layout, publication order, readers, stages and marks;
- `install-ownership.ts`: ownership, tuples, generations;
- the service lock, with the CLI's service commands taking it;
- `fleet.lock`'s `update` role and the nonce handoff (§4.3);
- the CLI's state-writing fence (§4.2, step 3);
- the writers-gone proof with the exempt set (§4.4);
- `update-recovery/`: `recoveryPlan`, the kit builder (`recover.cjs` bundled at build), and the pre-start decision table and runner handshake (§6.2);
- the forward-install intent (§3.2) and planned generations (§3.3);
- P8 reading `current`.

2.1's tests:
- on a real temp home: publication order with a crash injected between each write; every row of §2.5 and §7; illegal transitions refused;
- liveness: live, gone and unknown;
- the service lock and its token between real processes;
- the kit built and run alone, with the package directory removed.

**2.3** ships:
- `update-snapshot-scope.ts`: the scope, plus the writer inventory and its gate;
- `update-snapshot.ts`: fence and proof, confinement, the checkpoint with its result fields, copy, durability and the exact-set manifest;
- `update-restore.ts`: §5.5, plus the package and unit restores of §6.3.

2.3's tests:
- on a real temp home seeded like S-233: real WAL databases (committed but not checkpointed frames kept, a torn tail not), a Hub database, a symlinked directory and a symlinked database parent (refused), an excluded workspace and CLI home;
- a new file, a new database and a migrated fleet.yaml left "by the new version";
- the restore yields the manifest exactly, and the new state sits in `replaced/`;
- a crash injected at every step of the restore, the package restore and the unit restore, each ending in the same state;
- a writer appearing mid-copy, discarded;
- the inventory gate.

**Rig after both:** two npm prefixes and a built kit. A stand-in "fleet" process holds the home's files; the transaction's functions are driven without a real fleet start. It runs a forced failure at each stage, kills the "updater" at each stage, then runs `recover.cjs` alone with the package directory removed, and compares bytes with the pre-update home.
