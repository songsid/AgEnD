# Wiring the update transaction into `agend update` and the fleet (M-3770 slice 2.5, S-252)

Design note, for review before any code. The transaction's library is merged and Fable-reviewed:
- the journal, locks and kit;
- snapshot and restore;
- the forward driver (`runUpdate`), abandon, rollback and the recovery runner;
- the fleet's hand-back;
- Go back.

This note covers how the live `agend update` and the fleet use it. Design: `docs/design/update-transaction-m3770.md`. Product design: `docs/design/update-adoption-m3762.md` (#4480, approved).

**Freeze (leader 11-27):** nothing that changes live `agend update` behaviour merges until 2.4.0 is published. The parts below are written so that each lands with the transaction **off** (a selection that always answers Phase 1), and the switch to Phase 2 is its own, last change.

---

## 0. Where we start (today's code, verified)
- **`agend update`'s default path hands the whole job to the target release's own installer** (`launcher/agend-install.cjs`: admit → preimage → `npm install -g` → `agend install --no-activate` → `agend restart`, with its own rollback). A compatibility path (sudo, nvm, or a target without an installer) runs `runUpdateInstall` → `activateVerified` → `agend restart` in the CLI.
- **The fleet is stopped and started only through `agend restart`:** `systemctl restart` waiting for READY; `launchctl kickstart -k`; or, detached, kill `fleet.pid` and spawn `agend fleet start`.
- **Locks:**
  - the home lock is taken only on the compatibility path;
  - the service lock is only checked (`admitServiceCommand`), never held;
  - the EXCLUSIVE state lease has no caller;
  - nothing passes `AGEND_SERVICE_LOCK_TOKEN`.
- **Nothing selects Phase 2:** there is no V_tx for the running or target version, and no caller of `usesQuiescenceBarrier`.
- **The fleet:**
  - it has no trial mode (agents, adapters and the scheduler always start; `tmuxHold` is the only "no agents" switch);
  - nothing calls `attachQuiescence`;
  - there is no commit-hands implementation;
  - `cli.ts` refuses a `resumeCommitting` start.
- **Health:** `GET /health` (status, instances, adapters, `startupComplete`), `READY=1` after `finishStartup`, and `FleetStartup.snapshot()`. Nothing is tied to a generation or nonce.
- **No `agend update --resolve`,** though refusals already point at it.

## 1. Selection: Phase 2 only where both versions speak it
- **V_tx is declared, not inferred.** `package.json` gains `"agend": { "updateTx": 1 }`.
  - The running version reads its own.
  - The target's is read with the same `npm view` the CLI already runs for the target version.
  - An absent field is 0.
- **Phase 2 iff** all of these hold (otherwise **Phase 1 runs unchanged**):
  1. the readiness class is `self` (`preflightClass`, P1–P10);
  2. running ≥ 1 and target ≥ 1;
  3. the install is systemd or detached. launchd forward updates work in the transaction (the route supports it), but launchd waits for S-260's Go back plumbing so the two land together;
  4. **request-context is not On** (gate (b), §7);
  5. no attempt is open (`readCurrent` is `none`).
- `usesQuiescenceBarrier` is replaced by this one predicate, `selectUpdatePhase(…) → { phase: 1 | 2, why }`. The `why` is logged and shown in `agend update --dry-run`.

## 2. The driver: the OLD install's `agend update`, outside the fleet
- **The updater is the running (old) version's CLI**, launched as today: detached, and on systemd inside its own `systemd-run --scope`, so it survives the fleet's stop. It stamps `txProtocol`, takes the locks and drives `runUpdate`.
- **Locks, in the design's order:**
  1. home (`acquireHomeUpdateLock`);
  2. prefix (`acquireInstallLock`);
  3. service (`acquireServiceLock`, held now, its token in the lock record only).

  All three are held to the terminal write, then the EXCLUSIVE state lease is taken in `stopping`, as `runUpdate`'s `drain`.
- **Children** that act on the service (`agend install --no-activate` inside the install hand) get `AGEND_SERVICE_LOCK_TOKEN`, so the service commands admit them.

## 3. The install hand: the target's installer, in an install-only mode
- **Decision for review (D1).** Phase 2 still lets the target install itself (it knows its own runtime and bundled pieces) but forbids it from activating, restarting or rolling back: the transaction owns those. A target with `updateTx ≥ 1` must support `agend-install --upgrade --target v --install-only`, which runs admit, npm install, the version check and `agend install --no-activate`, then exits with its status. In this mode it takes no preimage, does no restart and has no rollback.
- **Alternative (D1b):** run npm in the updater (`runUpdateInstall` without `activateVerified`/restart). It's simpler, but it loses the target's own install knowledge.
- **I propose D1.** In both cases the transaction's own `takeAttemptPreimage` + intent precede it, and its result is verified by `readArtifactTuple` + the target version (already in `runUpdate`).

## 4. The old fleet: arming the barrier (2.2)
- **A local control endpoint** on the fleet's health server: `POST /api/update/barrier { attemptId }`. It is loopback only, and authenticated by a per-attempt token the updater writes, mode 0600, into the attempt's directory and the fleet reads from there; no token appears in a URL or a log.
- The fleet attaches a `QuiescenceBarrier`, `bind`s the attempt, runs `secondCheck(idle snapshot)` and answers `held` or `busy`/refused.
- `runUpdate`'s `barrier` hand calls it. `busy` → abandon (the fleet clears its flag, as §2.3 says).
- **Cancel** (the card's) and the old fleet's stop are unchanged. The stop is `ensureFence`'s `manager.stop()` on the recorded `old` generation.

## 5. The new fleet: trial mode, the proof, the commit hands
- **Trial mode is chosen by the journal, not a flag.**
  - A fleet start that took `fleet.lock` over with a handoff nonce that is the open attempt's **`trial`** generation starts in trial.
  - It opens the outbox, the scheduler (paused: occurrences are held as deferred), the health server and the web chat.
  - It starts **no agents** (the `tmuxHold` path, generalised to a `startHold` reason) and **no adapters' inbound delivery**: inbound is journaled (2.4: the trial fleet writes its inbound into the journal), the same `commitTurn` copies the barrier makes.
  - A `startHold` banner says "Updating: checking the new version".
- **The proof** (`runUpdate`'s `prove(trialPid)`): `GET /api/update/trial` (same loopback + token) answers `{ nonce, pid, healthy, problems }` from `getFleetHealth()`, with `startupComplete` meaning "trial startup complete" (outbox, scheduler, web, adapters connected). It never involves agents. The updater polls it up to a bound (90 s), and a mismatched nonce or pid is a failure.
- **The commit hands,** in the new fleet, driven by the updater over the same endpoint (`POST /api/update/commit/{step}`), each idempotent and journaled by `commitAttempt` after it returns:
  - `leaveTrial`: clear `startHold`, resume the scheduler;
  - `startAgents`: Phase 1/2 instance start as a normal boot does;
  - `deliverInbox`: the trial's journaled inbound and the old fleet's held items, admitted in order, as hand-back copies and references;
  - `runDeferred`: the held occurrences.
- **After a crash in committing,** `resumeCommitting` runs these same hands from the fleet start. That replaces `cli.ts`'s current refusal, which then goes, together with its source pin.
- **The update progress marker** gains `trial`, `proving` and `committing` stages, and `finishStartup` doesn't clear it in trial.

## 6. `agend update --resolve` and the recovery entry
- `agend update --resolve` shows the open, unknown or manual attempt and the person's choices: run the recovery (`recover.cjs --run`), or mark it resolved, recorded in `history`. It is the only thing that clears a `manual-recovery` `current`.
- `agend update --recover` runs the kit's runner for the open attempt (the operator command, without the long path).

## 7. Gates that must hold before Phase 2 is ever selected
- **(a) Go back's real guard (#4519).** Until #4519 merges, Go back is not reachable from any trigger: no Settings button, no CLI. The wiring ships the forward update only. Go back's trigger is its own later part, which wires `requestContextGoBackAllowed` in place of the injected guard.
- **(b) Replayed held turns under request-context On.** A held human turn is replayed receiptless (fail-closed), and under On S-230's reply-sink rule would refuse its reply. Until a re-issued receipt (with the origin evidence journaled) or request-context admission for replays exists, **selection refuses Phase 2 while request-context is On** (§1.4). Phase 1 has no barrier, so it holds no turns.
- **(c) The freeze.** Every part lands with selection answering Phase 1. The flip is the last part, after 2.4.0 is published, and is the leader's call.

## 8. Parts (each to Fable; none changes live behaviour until the flip)
1. **V_tx + selection** (`selectUpdatePhase`, always Phase 1 behind `AGEND_UPDATE_TX=0` by default), plus the lock and lease plumbing exercised by tests only.
2. **The fleet's control endpoint** (loopback + attempt token) + barrier attach (old side), with a scratch-home test using a stand-in updater.
3. **Trial mode** (`startHold`, inbound journaled, scheduler paused) + the trial proof endpoint.
4. **The commit hands** (and `resumeCommitting` from the fleet start replacing the cli.ts refusal) + the progress-marker stages.
5. **The updater's hands** (D1 install-only mode in `agend-install.cjs`, the manager, the waits) wired into `agend update` behind the selection.
6. **`--resolve` / `--recover`.**
7. **The scratch end-to-end rig** (success, failure → rollback, crash → recover, abandon) against a scratch home with real fleet processes in a scratch tmux socket, never a live fleet. It can start now on the merged drivers.
8. **The flip** (after 2.4.0; the leader decides).

## 9. Questions for review
1. D1 (the target's installer in an install-only mode) vs D1b (npm in the updater)?
2. The control channel: loopback HTTP with a per-attempt 0600 token file, or the existing IPC used between the fleet and its daemons?
3. Trial mode keyed on the journal (the handoff nonce is the `trial` generation) rather than an env flag: agreed?
4. Does adapters' inbound during the trial go through the same `commitTurn` copy path as the barrier (so `deliverInbox` reuses the hand-back admission), or need its own journal stream?
5. Gate (b) as "no Phase 2 while request-context is On": acceptable until replays get receipts?

---

## 10. Review answers (Fable, 11-27) — adopted
1. **D1, install-only, with a hard constraint.**
   - Install-only is npm, the version check and runtime files only (bundled tmux, native postinstall). It makes **no unit or plist writes and no service-manager calls** (no `enable`, no `daemon-reload`). The transaction already took the unit preimage and wrote its route, and a regenerated unit would bypass the preimage, or on launchd erase the route. A scratch test asserts the unit file and drop-in are byte-equal across the install hand.
   - **V_tx is bound to the exact artifact:** `npm view <name>@<exact version>`, never a dist-tag. Then the **installed** `package.json`'s `agend.updateTx` is re-read before trial; below 1 means roll back.
2. **The control channel is a Unix-domain socket** inside the attempt's 0700 directory. The path is the scope and the file mode is the authentication. The fleet serves it only while an attempt is open. **Never the shared health port:** the public link and tunnel forward to the local listener, so loopback proves nothing there. It isn't the per-instance daemon IPC either.
3. **Trial keyed on the journal:** agreed. A start whose nonce names a voided or dead generation, or a closed attempt, never silently becomes a normal fleet; the takeover's refusal of a revoked nonce stays, and is tested.
4. **The trial reuses the copy path, with three refinements:**
   - **non-durable ingress only:** durable outbox rows just stay queued, since the pump has no agents;
   - **one ordered stream:** the trial continues the SAME inbox sequence, the next seq after the barrier's last file on disk, so `deliverInbox` walks the old fleet's held items first, then the trial's;
   - **receipts and rollback:** the trial's copies keep their receipts when `deliverInbox` runs in the same fleet process, the normal commit. They are stripped (as #4541 does) only after a different boot (`resumeCommitting` after a crash) or on a rollback, where the trial's copies go to the old fleet through the existing hand-back. That narrows gate (b) for the forward path.
5. **Gate (b) holds for the whole attempt:** selection refuses while request-context is On; the barrier arm refuses `held` while On; and **S-230's On action refuses while `readCurrent` isn't `none`**, because a Settings write takes no service lock (Sentinel to add).
6. **The proof doesn't require adapters connected** (a Discord or Telegram outage mustn't roll back a healthy version). Adapter connection is informational. The proof is the outbox, the scheduler, the web listener and the fleet's own health, with nonce and pid matched.
7. **The rig** (part 7) uses a scratch tmux socket under a short `TMUX_TMPDIR`, an `env -i` scratch HOME and never the host's `AGEND_HOME`, and it includes a launchd-shaped case as S-260's baseline. **Its fleets are stand-in processes** that take `fleet.lock` over by the handoff nonce exactly as `claimFleetSingleton` does, not `agend fleet start`: a scratch-HOME fleet start has killed live tmux windows on this host before (a standing rule: never start a test fleet). The gap the stand-ins leave (a real fleet's trial start, the commit hands and the hand-back over the real socket, end to end) is closed **once, before the flip**: a real-process run inside a disposable container (`--network none`, its own tmux and HOME, nothing mounted from the host's `AGEND_HOME` or `/tmp/tmux-*`), isolated by construction. It's a heavy run, so it needs the leader's go-ahead, and it's a precondition on the flip card (S-261), not part 7.
