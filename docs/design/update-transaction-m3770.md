# The update transaction: attempt journal, locks, snapshot and restore (M-3770 slices 2.1 and 2.3)

Design note for Phase 2 of `docs/design/update-adoption-m3762.md` (#4480, approved), §3.3 steps 1, 3, 4 and 7, and §4.2. It covers:
- **2.1:** the attempt journal, identity, the three locks, and the recovery kit;
- **2.3:** stop-then-snapshot and restore.

It also fixes the interfaces that 2.2 (the quiescence barrier, GrokCore) and 2.5 (health proof, commit/rollback) build on. No UI; 2.6 words what this records.

**Scope.** Phase 2 runs only on a machine in class **self** (§4 of the design), and only when both the running version and the target speak this transaction (from- and to-version ≥ V_tx). Anywhere else, Phase 1's updater runs unchanged.

**Revision 2** answers Prism's design review (6065369545); **revisions 3 to 6** answer its scoped passes (6065419816, 6065453267, 6065478655, 6065501514). The changes are mapped in §9.

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
    inbox/  deferred/  cancel   2.2/2.4: held inbound, deferred jobs, the fleet's cancel request (§2.6)
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
- `committing` holds 2.5's commit substeps, in order (rev 13): `retained` (§5.6), `route-removed` (+ reload), then the fleet's own `left-trial`, `agents-started`, `inbox-delivered`, `deferred-run`. A crash there resumes them. It never rolls back after agents have started.
- **The forward order in `stopping` (rev 13):** the kit and the route first, while the old fleet still runs; then the old fleet stopped and fenced (§4.2); then the drain. So every later start, abandon's restart of the old generation included, goes through the pre-start step (§6.2).
- **A busy second check closes the attempt it opened** (agreed with 2.2, #4493). The barrier publishes `opened` before it fences, then checks again (§2.6). If that second check finds the fleet busy:
  1. the fleet clears its fence flag and writes nothing, no prefix included;
  2. the updater runs `abandoning`: `restart-old` finds the old fleet running (it was never stopped), and `hand-back` has no files;
  3. the updater writes `abandoned`, and terminal step 3 (§2.4) clears `current`. The home, prefix and service locks release with that write.

  The unfenced wait resumes only after `current` is gone, and the next fence opens a **new** attempt. An unused `opened` attempt never stays open while the fleet waits, so the CLI's state lease (§4.2) isn't refused meanwhile. The fleet still writes no stage.

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

### 2.6 The fleet's files: inbox, deferred jobs, cancel (2.2's interface, agreed with GrokCore)
The fleet never writes a stage. It writes only these files, each atomically (tmp, fsync, rename, fsync the directory).

- **One sequence.** Every held item and every deferred job takes the next value of one counter, zero-padded, so directory order is the order of hand-back. A job that came due between two held messages is handed back between them.
- **`inbox/<seq>-<source>.json`**, where `source` is `outbox`, `adapter`, `web` or `hub`. Its body is one of:
  - `{ kind: "reference", deliveryId, createdSeq }`, for a durable outbox row: a reference only, no payload. Hand-back has the pump claim that delivery id; the file is never admitted as a new message. Copying the row and leaving it queued would deliver it twice.
  - `{ kind: "copy", body }`, for adapter, web or Hub ingress that never became a durable row. Under the fence, `admitDurableDelivery` inserts the outbox row and writes a reference instead, whenever it can.
- **`deferred/<seq>.json`**: `{ seq, scheduleId, runId }`, one file per job.
- **Acknowledgement:** after each item's hand-back has taken effect, the fleet writes a sibling `<file>.acked`. A crash resumes hand-back at the first entry in sequence order without its `.acked`, and **every resumed item is reconciled with durable state before anything is done again** (rev 6):
  - **A reference:** hand-back is the pump claiming that delivery id. On replay the row is looked up: still `queued`/`retry_wait` means it is claimed; `delivering`, `delivered` or terminal means it is already handed back. Then `.acked`. Claiming twice is impossible, because the outbox's own claim is a conditional update.
  - **A copy:** admission is one outbox insert whose `source_key` is `update-handback:<attemptId>:<seq>`. The outbox's `source_key` is `UNIQUE`, so a replay's insert conflicts, and the existing row is used. The copy is then treated exactly as a reference to that row: never a second message, whether the crash came before the insert, after it, or after the claim.
  - **A deferred job:**
    1. Before triggering the job, the fleet writes `deferred/<seq>.started` (`{ runId, at }`, atomic). Then it runs the job, then `.acked`.
    2. On replay, an entry with `.started` and no `.acked` was **interrupted**. It isn't run again. It is recorded in `schedule_runs` (`status: "interrupted-by-update"`, `detail` naming the runId), and the schedule's next due time is computed as usual.
    3. That is the honest guarantee: **a deferred job runs at most once across a crash.** That is the scheduler's own guarantee for a run a crash interrupts outside an update. An entry with neither `.started` nor `.acked` is run.
- **When the fleet writes:**
  1. The updater publishes `opened`, with `current` naming the attempt, before the fleet writes anything.
  2. On the barrier's successful second check, in that same turn, the fleet writes the **prefix**: every `queued` or `retry_wait` outbox row not in flight, in `created_seq` order, as references.
  3. Then the updater advances to `barrier`.

  A crash still in `opened` with those files present hands them back (§7).
- **`cancel`:** the card's Cancel, or the wait passing `updates.maxIdleWait`, can't write `abandoned`. The fleet writes `attempts/<id>/cancel` (`{ reason, at, by }`).
  - **The updater or runner consumes it by the current stage** (rev 6), under the home lock, and only there:
    - **`opened`, `barrier`, or `stopping` with no snapshot published:** the cancel is honoured. It journals `abandoning` (with the cancel's reason), then renames `cancel` to `cancel.consumed`.
    - **Any later stage** (`snapshotted` onwards, `committing`, a terminal stage): the cancel is too late and never changes the course. It renames `cancel` to `cancel.ignored-<stage>` and journals that, and the card says "too late to cancel: the update is past the point of no return". A cancel never enters `abandoning` after the snapshot, and never causes a rollback in `committing`.
  - **The fleet** writes `cancel` only while the card shows a cancellable state (waiting, the barrier). A marker that races the stage boundary is judged by the stage the updater finds when it consumes it, never by the time it was written.
- **The fleet runs hand-back only when the attempt's substep is `hand-back`** (§2.3), then acknowledges it.
- **Task-board claims are not journal files.** The fence refuses the claim write.

### 2.7 Updater liveness
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
3. **Fence the CLI with a lease held for the writer's whole lifetime (rev 4).** A check before opening alone races, so admission is a lock the operating system holds.
   - **The lease** is `<home>/.state-lease.sqlite` (rollback journal, not WAL), used only for its locks. They are fcntl locks the kernel drops when a process dies.
   - **A state-writing `agend` command**, from the moment it opens any file of the scope until it has closed the last one:
     1. holds a read transaction on it: `BEGIN DEFERRED`, then a `SELECT` (a SHARED lock);
     2. **after** that, checks the journal. If `current` names an open, unknown or manual attempt, it ends the transaction and refuses with the attempt's id and stage.
   - **The updater:**
     1. publishes `current` (§2.4);
     2. fences `fleet.lock`;
     3. then takes `BEGIN EXCLUSIVE` on the lease, with a 60 s busy timeout. That lock is granted only once every SHARED holder has finished: the **drain**. A writer admitted before `current` was published finishes first; a writer arriving after it sees `current` and refuses.
     4. holds the lease until the terminal write (§2.4).
   - A writer that finds the lease busy waits up to 2 s, then refuses with the same words.
   - **When the 60 s drain expires,** the attempt is abandoned by the recorded procedure (§2.3).
   - **The CLI's state-open helpers** take the lease in one place: `scheduler/db.ts`, the config writer, `config-history.ts` and the like. The writer inventory's test lists every state-writing command and fails if one opens scope files without the lease.
   - **Exempt:** the fleet and its daemons, which `fleet.lock` fences, and the authenticated helpers (§4.4). The recovery runner takes the same exclusive lease.
4. **The proof:** the writers-gone proof (§4.4) runs after the fences, and again after the copy or restore, before its result is published.
5. **The wait:** a writer still present gets 60 s, polled. On expiry the recorded abandon procedure runs: restart the old fleet, hand back the inbox and the deferred jobs, then `abandoned` (open point 4, §8).

### 4.3 The fleet.lock handoff: no unowned gap
- `fleet.lock` holds the updater's record `{ pid, role: "update", attemptId, handoff: null }` from the fence until a fleet the attempt starts takes it over.
- **To start a generation** (`trial`, `rollback`, or `old` on abandon):
  1. The updater or runner journals the planned generation (§3.3).
  2. It writes `handoff: { nonce, gen }` into its own lock record: tmp, fsync, rename.
  3. It starts the service, or spawns the fleet when there is no service.
- **The starting fleet's `acquireFleetLock`**, finding role `update`, takes over only when the attempt's journal names a planned generation with exactly that nonce, and the lock record's handoff carries the same.
- **Serialized, rev 4.** A rename isn't a compare-and-swap, so the takeover is claimed first:
  1. **Claim:** create `attempts/<id>/handoff-<nonce>.claim` with `O_EXCL` (`wx`), holding the claimant's `{ pid, start }`; fsync it and its directory. **Exactly one** contender creates it. Every other contender for that nonce refuses at once, whether or not the winner has finished.
  2. **Take over:** the claim's holder writes its record `{ pid, role: "fleet", nonce }` to a tmp file and renames it over `fleet.lock`.
  3. **Acknowledge:** the updater or runner sees the record, journals the generation's pid, and marks the nonce consumed.
- **A claim left by a claimant that died:** proven by `holderState`. If `fleet.lock` still holds the update record, the nonce is void and never reused. The updater or runner journals that and plans a new generation with a new nonce. An unknown claimant is never voided: the attempt waits, then goes to manual-recovery.
- **A claimant that died after its rename but before the pid's acknowledgement (rev 5).** `fleet.lock` then holds `{ pid, role: "fleet", nonce }` for a process proven gone.
  1. The updater or runner journals the generation as started and dead, recording the pid from that record. The nonce is consumed and never reused.
  2. It re-takes the fence: it replaces that record with its own update record (`handoff: null`) by the fleet lock's own owned stale replacement. That replacement takes only a record whose holder is proven gone, and does it under its reclaim marker.
  3. It then goes on as the stage says. For a trial generation, that means rolling back.

  An unknown holder is never replaced; the attempt waits, then goes to manual-recovery.
- **The fence doesn't depend on `fleet.lock` alone across that gap.** Every fleet start reads the journal first (§7) and refuses while an attempt is open, unless it holds that attempt's planned nonce. So a start that would otherwise find the dead claimant's lock stale and take it is refused before it gets there.
- **The nonce** reaches a service start through the journal: the pre-start step (§6.2) passes it on as `AGEND_UPDATE_HANDOFF`. A spawned fleet gets it in its environment. It is single-use: the claim file consumes it, and the journal marks it consumed when the pid lands.
- **The handoff route stays in place until the takeover is acknowledged, rev 4.** That route is the pre-start step and its `EnvironmentFile`, or launchd's wrapper. It is removed only after step 3, for every generation, the rollback included (§6.2).

### 4.4 The writers-gone proof, and who is exempt
- **The proof looks for** any process of this uid that has `AGEND_HOME` equal to this home, its cwd under the home, or a file of the scope open or mapped (Linux `/proc/*/{environ,cwd,fd,maps}`; macOS `lsof -Fn +D`).
- **An incomplete scan** (a failed listing, or a process of this uid that can't be read) is never proof of absence. A process that exits during the scan is gone, not unreadable.
- **Sealed processes (rev 10):** a process of this uid that the kernel made non-dumpable can't be inspected without root, because its `/proc/<pid>/{cwd,fd,maps,environ}` belong to root. It is identified positively: its `status` reads this uid while its `fd` directory is root's. It is reported as **uninspectable**, not a gap. Every systemd user session has one (`(sd-pam)`), so without this the proof could never pass.
  - **Privileged processes (rev 11):** a dumpable process of this uid holding a **permitted capability this reader lacks** is refused by the kernel's subset rule (`ptrace_may_access`), although its `/proc` files stay this user's. A unit with `AmbientCapabilities` is one example; a CI runner's helper is another. It is identified from its world-readable `status` (`CapPrm` against this process's own) and reported as uninspectable too.
  - **Why this is safe:** AgEnD's own processes and the CLIs it launches are neither non-dumpable nor privileged. AgEnD lowers `coredump_filter`, never clears the dumpable flag, and grants no capabilities.
  - **Reporting:** each uninspectable process is listed with its `Name` and why ("non-dumpable" or "privileged"). An unreadable process names its `Name` in the incomplete reason.
  - **Transient unreadability (mid-exec, mid-exit) is retried:** up to 5 re-reads, 20 ms apart, re-identified by its start each time. Any other process that stays unreadable still makes the scan incomplete.
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
  - `instances/*/muse-xdg/` (rev 9): muse's isolated XDG home, with links into the user's `~/.config`; CLI user state, like `cx/`;
  - `cache/`, `cache-codex-rollouts.json`, `usage-last-good.json`, `search.db*` (caches and a rebuildable index);
  - logs (`*.log`, `instances/*/output.log`, `profiles/`);
  - runtime (`tmux/`, `operator/`, `*.sock`, `fleet.pid`, `fleet.lock`, the update and service locks, `tunnel.lease`, `web.token`, `view.token`);
  - **`.state-lease.sqlite` and its `-journal` sidecar** (rev 5). Its locks are on that inode, so it is never copied, moved aside, restored or pruned. A restore that renamed it would hand the next writer a fresh, unlocked file while the updater still held a lock on the old one;
  - `update-in-progress.json`.
- **Why the snapshot exists:** the Hub databases are included. An older build refuses a newer Hub schema.

**The writer inventory and eligibility (rev 3).** `src/update-snapshot-scope.ts` holds the scope and, next to it, the **writer inventory**: every module that writes a file, with its path and its **phase**.
- **pre-commit:** fleet startup in trial mode, migrations, the update and rollback themselves.
- **post-commit:** agent launch, CLI activity, ordinary operation.

Paths outside the home are listed too. Today these are:
- the default Claude Code config, `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json` (`backend/claude-code.ts:158-161`, written when an agent launches, for trust and onboarding);
- a profile's own `.claude.json` (`credential-profiles/claude-code/*/.claude.json`, at agent launch);
- the CLIs' own files, which AgEnD never writes.

The test fails when a path literal written by the code isn't classified. It scans `join` over any member chain ending in `dataDir`, `DATA_DIR`, `agendHome` or `stateDir`, plus `getAgendHome()`, `homedir()` and `CLAUDE_CONFIG_DIR`, with a double-, single- or backtick-quoted literal (rev 8). A name reached only through a helper that takes the home as a parameter is listed by hand.

**Eligibility (rev 8).** A release is eligible for the transaction's automatic rollback only when no pre-commit writer touches:
- **excluded user state** (`workspaces/`, `credential-profiles/`, `cx/`);
- **a path outside the home** that the transaction doesn't restore itself (the unit and package preimages, §6.3);
- **an excluded cache that an older build would refuse rather than rebuild.** An excluded cache written before commit must be one that an older build rebuilds or ignores: `search.db` rebuilds on another schema; `cache-codex-rollouts.json` and `usage-last-good.json` skip what they don't recognise. The inventory marks each such writer.

Pre-commit writes to runtime files (pids, locks, sockets, tokens, tmux) and logs don't count: they mean nothing after a restore. Ordinary post-commit writes to excluded state (logs, caches, agent and CLI activity, a `.claude.json` at agent launch) don't count either:
- agents aren't started before commit (trial mode, 2.4);
- a rollback after commit is Go back, which names what it can't restore.

Today's inventory has no pre-commit writer outside the scope. A release that adds one updates through Phase 1, on an admin's press. Phase 3's index carries the flag; until then it is the running build's inventory.

### 5.2 Confinement (before anything is opened)
- The scope is walked from `realpath(home)` with `lstat`, never following a link.
- **Symlinks:** a symlink is recorded as a link, with its target text; it is not opened and its target is not copied. A symlinked **directory** is never entered.
  - **Recorded:**
    - a link that resolves **inside** the home, whatever it points to. AgEnD makes such links: `instances/<name>/codex-home` → `cx/<hash>`, and `cli-env/codex-home`. Their targets are snapshotted already or excluded on purpose;
    - a dangling link;
    - a link to a plain file.
  - **Refused (rev 9):** a link that resolves **outside** the home to a **directory** or a **SQLite database** (its first 16 bytes peeked, never opened as one). A rollback would restore the link while the newer state behind it stays: the exact failure the snapshot exists to prevent.
- **Every included regular file**, a database first, must have a path whose components below the home are all real directories (`lstat`, no link), and whose `realpath` is inside `realpath(home)`.
- **Databases** are opened only after that check. Their `dev`/`ino` is compared before and after the open, and a difference abandons the attempt.
- Files that are neither regular files, directories nor symlinks are refused, and the attempt is abandoned.

### 5.3 The copy and its durability
- **Each file:** copied to `snapshot/<rel>` (`COPYFILE_FICLONE`, else a copy) with its mode and mtime, then fsynced.
- **Each directory:** fsynced bottom-up after its entries.
- **The manifest**, `snapshot.json`, lists every entry: `{ rel, type: "file" | "dir" | "link", mode, size?, sha256?, target? }`, plus each database's `user_version` and schema hash.
- **The order:** the manifest is written last and fsynced, then the attempt directory, then stage `snapshotted` is published.
- **Verification:** the snapshot tree is walked again and compared with the manifest as an exact set: no extra entry, no missing one, the same types, sha256 and link targets. A mismatch, before `snapshotted` is published, is abandoning.
- **Immutability:** `snapshot/` is never written after `snapshotted`. A restore copies from it and never renames out of it. Taking a snapshot where `snapshot/` or `snapshot.json` already exists is refused before anything is done, and a failed snapshot removes only what that call created (rev 9).

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
Each unit is one of three kinds, fixed by the header: **both** (in the current units and the manifest), **new-only** (current only) or **manifest-only** (manifest only). A unit is **complete** when it is logged `restored`, or, for a new-only unit, logged `aside`.

| Kind | Logged | Found | Action |
|---|---|---|---|
| any | complete | — | done |
| new-only | neither | `<home>/u` absent, and `replaced/u` has the header's `{ dev, ino, type }` | log `aside`: complete (the move landed; its log line didn't). Nothing is copied: there is no snapshot of it |
| new-only | neither | `<home>/u` present, `replaced/u` absent | do `aside`: complete |
| both | `aside` | `<home>/u` exists and matches the manifest | log `restored` (the rename landed; its log line didn't) |
| both | `aside` | otherwise | remove `<home>/u.restore-tmp` if present; build and rename again |
| both | neither | `<home>/u` absent, and `replaced/u` has the header's identity | log `aside`; then as the row above |
| both | neither | `<home>/u` present with the header's identity, `replaced/u` absent | do `aside`, then `restored` |
| manifest-only | neither | `<home>/u` absent | build and rename: `restored` |
| manifest-only | neither | `<home>/u` exists and matches the manifest | log `restored` (the rename landed before its log line, rev 4) |
| manifest-only | neither | `<home>/u.restore-tmp` present, `<home>/u` absent | remove the tmp; build and rename |
| any | — | anything else (both `<home>/u` and `replaced/u` present for a both-unit; a present path that matches neither the header nor the manifest; `replaced/u` with another identity) | manual-recovery |

**After every unit:**
- run `containers`;
- verify the restored scope against the manifest as an exact set;
- run the writers-gone proof (§4.4) again;
- log `verified`.

`replaced/` and `snapshot/` are never modified by a retry. The crash test seeds nested directories, links, a new-only file and a new-only directory, a container with an excluded child, and a manifest-only unit. It crashes after every rename, every fsync and before every log line, including before the first `aside` line, and requires the same end state from each point.

### 5.6 Commit
- At commit (2.5), the attempt's artifacts are recorded in `retained.json` for **Go back**: the snapshot, the package preimage, the unit preimage and the recovery kit. They are kept for 7 days.
  - `<home>/.update-journal/retained.json` is `{ schema: 1, entries: [...] }`, written whole (tmp, fsync, rename, directory fsync). Each entry holds `attemptId`, `from`, `version`, `committedAt`, `expiresAt` (commit + 7 days), `snapshotDir`, `preimage { dir, manifestSha256 }`, `unitPreimage` (null with no service) and `kit`.
  - It is written as committing's first substep. A retry keeps the first record for that attempt. An unreadable or malformed file is reported, never read as empty (rev 13).
- `current` is cleared as in §2.4.

### 5.7 Go back, and retention
- **Go back** is a new attempt (`kind: "go-back"`, `goBackOf: <committed id>`) with its own `current`, locks, journal and generations.
- It restores with §5.5, using the committed attempt's snapshot and preimages, which `retained.json` protects. It is offered only while they all exist and verify (manifest, kit hash).
- It names what will be lost: what changed since the commit, which its restore moves into its own `replaced/`.

**Pruning** runs under the home lock. It never removes:
- the attempt `current` names;
- any `manual-recovery` attempt;
- an artifact referenced in `retained.json` before its expiry;
- a recovery kit that a loaded launchd job references (§6.2), whatever its age;
- `marks.json`;
- `.state-lease.sqlite` and its sidecar.

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
- **systemd:** a drop-in `<fragment dir>/<unit>.d/agend-update-recovery.conf` (the unit file itself is untouched):
  ```
  [Service]
  ExecStartPre=<kit>/node <kit>/recover.cjs --home <home> --attempt <id> --pre-start
  EnvironmentFile=-<home>/.update-journal/attempts/<id>/handoff.env
  ```
  It is written only when the home, the kit and `handoff.env` are each one plain word in a unit file: no whitespace, quotes, `%` specifiers or `$` expansions. Otherwise the route is refused and the attempt abandons.
- **launchd:** `ProgramArguments` wrapped (rev 7: Node can't `exec`, and launchd's MainPID must be the fleet, so the wrapper is `/bin/sh`):
  `["/bin/sh", "-c", WRAPPER_SCRIPT, "agend-update-recovery", <kit>/node, <kit>/recover.cjs, <home>, <id>, …original]`.
  `WRAPPER_SCRIPT` (in `src/update-recovery/route.ts`, matched byte-for-byte):
  - it runs the pre-start step, and a refusal stops the start with its exit code;
  - it reads `handoff.env` without sourcing it, and exports only an exact `AGEND_UPDATE_HANDOFF=<32 hex>` line;
  - then it `exec`s the original arguments.

  The original arguments are always taken from `unit.preimage`, never from the plist on disk.
- **`--attempt <id>`** names the attempt the route was written for. `handoff.env` is that attempt's: the pre-start writes it only for a handoff on that attempt, and otherwise removes it and fsyncs its directory, whatever the journal reads.
- **A retry, or the route's removal,** rewrites only what the route wrote: the definition on disk must be the preimage itself or exactly this route's form. Anything else (systemd: a unit changed since its preimage; launchd: a plist that is neither the preimage nor its exact wrapper) is refused (§3.2: fail closed).

The original definition's bytes are `unit.preimage`. The pre-start step runs **inside the service's start**, so it never stops, starts or reloads that service, and never restores anything. It only decides, from the journal:
| Journal | Pre-start does |
|---|---|
| none | exit 0: a normal start (launchd: exec the original arguments) |
| open; updater or runner live; a planned generation with an unconsumed handoff nonce (§4.3) | pass `AGEND_UPDATE_HANDOFF=<nonce>` on (systemd: written to `attempts/<id>/handoff.env`, read by the unit's `EnvironmentFile=-` in the same drop-in); exit 0 |
| open; updater or runner live; no planned generation | exit non-zero: "AgEnD is updating (attempt, stage); this start is refused". The updater owns the service until the end |
| open; updater and runner gone | start the **independent runner**, then exit non-zero (the start is refused). **Except `committing` (rev 13):** exit 0, a normal start; the new version's own fleet start finishes the commit (§7) |
| open; updater or runner liveness unknown, or unknown or manual | exit non-zero with the paths and the operator command |

**The independent runner** runs outside the service's cgroup and job:
- **systemd:** `systemd-run [--user] --unit=agend-update-recovery-<id> --collect --property=KillMode=process <kit>/node <kit>/recover.cjs --home <home> --attempt <id> --run`, with `--user` unless root. That is a transient service of its own, not a child of the unit.
- **launchd:** a separate job, `launchctl submit -l com.agend.update-recovery.<id> -- <kit>/node <kit>/recover.cjs --home <home> --attempt <id> --run`.

**The bootstrap handshake:**
1. The pre-start step starts the runner and waits up to 10 s for `attempts/<id>/runner.json` (the runner's `{ pid, start }`, written after it holds the three locks).
2. It then exits non-zero.
3. If the runner can't be started or doesn't answer, the pre-start step still exits non-zero, with the operator command. The service fails visibly, and nothing is half-done: the runner only acts under the locks.
4. While a runner is live, any further start (the unit's own `Restart=`) is refused at pre-start (the "live, no planned generation" row).

**The runner owns the final service transition:**
1. It waits until the refused start has ended: the unit is `inactive` or `failed`, and launchd's job is not running.
2. It runs `recoveryPlan` (§7) and restores, under the locks.
3. **It restores the unit's own definition** (`unit.preimage`, §6.3), but **keeps the handoff route**: the drop-in reduced to its pre-start check and `EnvironmentFile`, or the wrapper. Then `daemon-reload` or the plist reload, with no start job in progress, so it never relies on a reload changing an active start's ExecStart.
4. It plans the `rollback` generation with its nonce (§3.3).
5. It runs `systemctl --user reset-failed` and `start`, or `launchctl kickstart`. The pre-start check delivers the nonce, and the old version's fleet claims it and takes `fleet.lock` over (§4.3).
6. **After the takeover is acknowledged** (rev 4):
   - **systemd:** the runner removes the drop-in and runs `daemon-reload` while the unit is active, with no job queued. A reload doesn't restart a running unit.
   - **launchd:** the loaded job keeps the wrapper until the next load. Reloading a running job would restart it, so the runner writes the preimage's bytes back to disk, and the next load (the next `agend restart`, a reboot, or an update) uses it. It writes them only over this route's exact wrapper: if the preimage is already there, it is done; if the plist is anything else, it refuses and leaves the plist as it is.
   - **The wrapper itself** is harmless outside an attempt: with no open attempt it only execs the original arguments.
   - **The kit stays as long as a loaded job references it (rev 5).** Retention never removes a kit while the loaded launchd job's `ProgramArguments` (read with `launchctl print`) names it, even past the 7 days. Pruning reads the loaded arguments first. An unreadable answer counts as "referenced", so the kit is kept.
   - **P3 accepts the wrapper only when it is exactly this** (`unwrapRecoveryRoute`):
     - arguments `["/bin/sh", "-c", WRAPPER_SCRIPT, "agend-update-recovery", <kit>/node, <kit>/recover.cjs, <home>, <id>, …]`, with the script byte-for-byte and `<home>` this home;
     - `<kit>` is this home's recovery directory for `<id>`, and the two files' sha256 match its `kit.json`;
     - **the attempt `<id>` is terminal by its own record** (committed, rolled-back or abandoned; not manual-recovery). It is never inferred from `current`, and no attempt may be in flight now;
     - the tail `…` is byte-for-byte the `ProgramArguments` of that attempt's `unit.preimage`. A missing or unreadable preimage or record is unproven.

     Anything else (another path, other arguments, a changed kit, an open or unknown attempt) is `service-unknown`. The expected tuple's `execStart` (§3.2) is the wrapped form until the next load, then the unwrapped one.

**The operator command**, `<home>/.update-journal/recovery/<id>/node <home>/.update-journal/recovery/<id>/recover.cjs --home <home> --attempt <id> --run` (each word shell-quoted as printed), is the same runner, run from a shell outside the service. It works with the package missing or broken.

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

**Unit restore:** write `unit.preimage`'s bytes to `<fragment>.restore-tmp`, fsync, rename, remove the drop-in, then `daemon-reload`, under the service lock. A retry writes the same bytes again.
- **Unless the runner keeps the route** (§6.2 step 3, before the takeover). Then the route is *ensured*: systemd's drop-in must be exactly this attempt's, written again if absent and refused (manual) if changed; launchd gets its wrapper around the original arguments.
- **Bin links (rev 12):** the package preimage records what stood at each bin path: nothing, npm's link with its target, or a plain file with its hash. A link is restored, and a bin that was absent is removed if the new version added one. A plain file is never removed or replaced, and is manual if it changed.
- **Pruning:** the legacy `prunePreimages` skips `attempt-*` (§5.7).

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
| open, gone, `committing` | resume committing's substeps (2.5) in the new version's own fleet start: the pre-start step lets it through, `fleetStartGate` admits it (`resumeCommitting`), and it runs `commitAttempt`. Never roll back after agents started (rev 13) |
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

### Revision 4 (Prism 6065453267)
| Review point | Where |
|---|---|
| 1. Unit kinds (both, new-only, manifest-only): a landed manifest-only restore is recognised without an `aside`; a new-only unit is complete at `aside`, with no snapshot copy | §5.5 |
| 2. The takeover serialized by an `O_EXCL` claim per nonce: exactly one contender; a dead claimant voids the nonce, which is never reused | §4.3 |
| 3. The CLI fence as a lease held for the writer's whole lifetime (SQLite SHARED vs EXCLUSIVE on `.state-lease.sqlite`); the updater publishes `current`, then drains; the check runs after the lease | §4.2 |
| 4. The handoff route kept until the rollback generation's takeover is acknowledged; systemd removes the drop-in afterwards; launchd keeps a harmless wrapper until the next load | §6.2, §4.3 |
| 2.2's interface (GrokCore): reference vs copy inbox files, one sequence with deferred jobs, `.acked` siblings, the cancel marker, the prefix written under `opened` | §2.6 |

### Revision 6 (Prism 6065501514)
| Review point | Where |
|---|---|
| A copy admitted, then a crash before `.acked`: the replay reuses the same outbox row (`source_key` `update-handback:<attempt>:<seq>`, UNIQUE), never a second message | §2.6 |
| Deferred jobs: `.started` before the run; on replay an interrupted job isn't re-run (at most once), recorded as `interrupted-by-update`; references reconciled with the row's state | §2.6 |
| `cancel` consumed by the current stage: honoured only through `stopping` without a snapshot, otherwise `cancel.ignored-<stage>`; never abandoning after the snapshot, never a rollback in `committing` | §2.6 |

### Revision 5 (Prism 6065478655)
| Review point | Where |
|---|---|
| `.state-lease.sqlite` and its sidecar excluded from snapshot, restore and prune (its locked inode is kept) | §5.1 |
| A claimant dead after its rename and before the acknowledgement: the generation is journaled dead, the fence re-taken by owned stale replacement, the journal-first start refusal covers the gap | §4.3 |
| The kit kept while a loaded launchd job references it; P3's exact check of the wrapper (arguments, kit path and hashes, terminal attempt) | §6.2 |

### Revision 7 (2.1c as shipped: #4511, #4515, #4517; Prism and Fable reviews)
| Change | Where |
|---|---|
| The pre-start and the runner take `--attempt <id>`, the route's attempt. `handoff.env` is that attempt's file, removed durably on every decision other than a handoff | §6.2 |
| launchd's wrapper is `/bin/sh` running the pre-start, then `exec`ing the original (Node can't `exec`; MainPID must be the fleet). `handoff.env` is read, never sourced | §6.2 |
| The drop-in's exact text; paths limited to one plain word in a unit file | §6.2 |
| P3's unwrap: the tail is the preimage's exact `ProgramArguments`, and the attempt is terminal by its own record, not by `current` | §6.2 |
| A retry or removal of the route rewrites only the route's own bytes (the preimage, or its exact wrapped form); anything else is refused | §6.2 |


### Revision 8 (2.3 part 1, Fable #4520)
| Change | Where |
|---|---|
| Eligibility counts excluded user state, unrestored outside paths, and a pre-commit cache an older build wouldn't rebuild. Pre-commit runtime and log writes don't count | §5.1 |
| The inventory gate's roots (any member chain ending in `dataDir`, `DATA_DIR`, `agendHome` or `stateDir`, plus `getAgendHome()`) and its literals (`"…"`, `'…'`, `` `…` ``); helper-reached names listed by hand | §5.1 |
| `host-monitoring.sqlite` is a pre-commit SQLite database: §5.3's checkpoint applies to it | §5.1, §4.5 |
| 2.4 must pin with a test that trial mode never reaches `startInstance`: post-commit user-state eligibility rests on it | §5.1, 2.4 |

### Revision 9 (2.3 part 2, Fable #4523)
| Change | Where |
|---|---|
| A link that resolves outside the home to a directory or a SQLite database refuses the snapshot. Links inside the home (`codex-home` → `cx/`), dangling links and links to plain files are recorded. `instances/*/muse-xdg/` is excluded as CLI user state | §5.1, §5.2 |
| A snapshot already present is never touched: a second take refuses up front; a failure removes only what that call made | §5.3 |

### Revision 10 (2.3 part 3)
| Change | Where |
|---|---|
| A sealed (non-dumpable) process of this uid is reported as uninspectable instead of making the writers-gone proof incomplete; any other unreadable process still does | §4.4 |
| A helper is exempt only when its own start and every intermediate ancestor (each a recorded helper with its start) are proven up to the updater or the runner | §4.4 |

### Revision 11 (2.3 part 3, Fable #4524 CI)
| Change | Where |
|---|---|
| A same-uid process holding capabilities the reader lacks (the kernel's subset rule refuses the read) is uninspectable, identified by `status` `CapPrm` | §4.4 |
| An unreadable process is re-read (5 × 20 ms, re-identified by its start) before the scan is incomplete; uninspectable processes are listed with their name and why | §4.4 |

### Revision 12 (2.3 part 5, Fable #4528)
| Change | Where |
|---|---|
| The runner's kept route is ensured (the drop-in rewritten if absent, refused if changed); the general rule removes it | §6.3, §6.2 |
| A bin path's prior state is recorded as absent, a link or a file; a file is never removed | §6.3 |
| The legacy `prunePreimages` skips `attempt-*` preimages | §5.7, §6.3 |

### Revision 13 (2.5 part 3, the forward driver)
| Change | Where |
|---|---|
| The forward order inside `stopping`: the kit built and the route written (and the manager reloaded) **first**, while the old fleet still runs; then the old fleet stopped and fenced; then the drain. Every later start, abandon's restart of the old generation included, goes through the pre-start step, so it receives its nonce. A kit or route that can't be made abandons before anything is stopped | §2.3, §6.2 |
| `stopping` with no `fleet.lock` holder: a recorded old fleet must be proven gone (then journaled dead) before the fence is taken afresh; a live one without the lock abandons | §4.2, §4.3 |
| A trial that doesn't take `fleet.lock` over in time: the service is stopped (a start still on its way), then the rollback | §4.3 |
| One plan at a time: starting a generation first recognises or voids **any** planned, unconfirmed generation, not only its own (a trial that never took over is voided by its rollback) | §3.3, §4.3 |
| The fence acknowledges a planned generation whose takeover landed unacknowledged before it stops it as that generation | §4.3 |
| Abandon's substeps: `restart-old` (nothing when the old fleet still runs; the old generation started from the fence when it was stopped; the fence released when no fleet ran), `hand-back`, `route-removed` (only a route that was written), then `abandoned` | §2.3 |
| A committing attempt whose updater is gone is the new version's to finish: the pre-start step exits 0 for it, `fleetStartGate` admits the start with `resumeCommitting`, and that start runs `commitAttempt`. The old kit's runner refuses it and says to start the fleet (Fable #4533 F1) | §6.2, §7 |
| launchd `start`: a job still loaded keeps the arguments it was loaded with, so an idle loaded job is booted out and bootstrapped from the plist on disk before the kickstart; a running one is refused (the caller stops it first). systemd needs nothing: the drop-in applies to every later start (Fable #4533 F2) | §6.2 |
| Committing's substeps, in this order: `retained` (§5.6), `route-removed` (+ reload), then the fleet's own: `left-trial`, `agents-started`, `inbox-delivered`, `deferred-run`; then `committed`. The route comes off before the fleet leaves trial, so a crash after that point is resumed by the new version's own fleet start (§7), never refused by the old kit | §2.3, §5.6, §7 |
| `retained.json` (`.update-journal/`): one entry per committed attempt, the first record kept on a retry, with its snapshot directory, package preimage, unit preimage and kit, and `expiresAt` = commit + 7 days | §5.6, §5.7 |
| An identity check that fails after the install is `manual-recovery`, journaled by the live updater; a failed rollback is `manual-recovery` when it needs a person, and otherwise leaves the attempt open for the runner | §3.2, §7 |
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
- the fleet's files: a crash between a copy's insert and its `.acked` (one row); between a reference's claim and its `.acked`; between a job's `.started` and its run (not re-run, recorded); a cancel written at each stage boundary (honoured through `stopping` without a snapshot, ignored after);
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
