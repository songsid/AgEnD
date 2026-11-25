# Quiescence barrier (S-244, slice 2.2)

**Status:** slice note. The product rules are design #4480, §3.3 step 2. This note only says where those rules meet the fleet that is on `release/2.3.5-alpha` now. It does not add a rule.
**Implementation:** after S-243 (2.1, the attempt journal and the locks). This note is not the implementation.
**Reviewer:** Fable or Prism, by the usual even/odd PR number.
**Journal:** the files the fleet writes are #4491, §2.6. The fleet does not write a stage.

## What this slice owns

2.2 is the barrier: wait until the fleet is an idle candidate, then fence and check again in one turn. The updater publishes the attempt at stage `opened`, with `current` naming it, before the fleet writes anything. The fleet writes inbox files, deferred-job files, and, while the card is still cancellable, the cancel marker. It does not write a stage. If the second check fails, the fences come down and nothing was written. If the wait exceeds `updates.maxIdleWait` (default 24 hours) or the card is cancelled while it is still cancellable, the fleet writes `attempts/<id>/cancel`. The updater honours that through `stopping` with no snapshot published, and ignores it once a snapshot exists. The fleet runs hand-back only when the substep is `hand-back`. A honoured cancel hands back, and the card goes back to offering **Update now** or **Keep waiting** (§3.3 step 2.4).

2.2 does not take the prefix, home or service locks, write the journal format, stop the fleet, snapshot, enter trial mode, or prove health. Those are 2.1, 2.3, 2.4 and 2.5. It does not change the card's words. That is slice 2.6.

The live installer does not call the barrier in this slice. Trial mode and the update inbox are not on the install path yet. Wiring the barrier into `launchInstalledUpdate` before 2.5 would hold messages and then install with today's updater, which has nowhere to keep them. 2.5 is the caller. Until then the module is tested on its own, and Phase 1's idle queue is unchanged.

The barrier runs only when the caller is already in a class **Self** transaction and both versions speak it (§3.3). Otherwise the caller stays on Phase 1.

## Two steps, in this order

Fences never hold back the work that has to finish for the fleet to become idle (§3.3 step 2, Prism R2-1).

1. **Wait, with no fences.** Poll on the same cadence as today's idle queue. Replies, completions and inter-agent messages that work already in flight needs are delivered as they are today. A scheduled job never counts as busy, including one that is running.
2. **Fence and check again, with no await between the flag and the check.** The updater has already published `opened`. Node runs one turn at a time. The flag is set, the idle predicate runs, and only then does the function return or await.

That stretch is the gap between the flag and the second check. A handler already awaiting when the flag goes up resumes only after the check has returned. Adapter routing or receipt binding, the IPC connect, a web body parse, and Hub inbound are all past a start-of-turn read by then. Each of those reads the flag again at its last synchronous commit point, in the same turn as the write, with no await between the read and the commit. A handler that has already passed its commit point is in flight, and the idle predicate already counts it. A handler still before its commit point is journaled there and does not commit. Those uncommitted handlers stay out of the idle predicate; the commit-point read is what diverts them.

If the second check finds the fleet busy, the flag is cleared before any reference, copy, or deferred job is written. The updater does not advance to `barrier`. The wait starts again. If it finds the fleet idle, still in that same synchronous stretch, the fleet writes the outbox prefix below. The updater then advances to `barrier`. The fences stay up for 2.3.

`agend update --now`, and the card's **Update now**, skip the wait and do step 2 once. They do not skip the barrier. If the second check fails, nothing is installed, the fences come down, and the caller is told the fleet is not idle. A busy fleet is not held for `updates.maxIdleWait`.

## What the journal holds, and in which order

Durable outbox rows stay in SQLite (`delivery-outbox.ts`: `created_seq INTEGER NOT NULL UNIQUE`, claim order `created_seq`). Copying a queued row into the inbox and leaving it queued delivers it twice: hand-back would admit the copy, and the pump would still claim the row. The journal stores an outbox row as a reference only, the delivery id plus `created_seq`. The payload stays on the row. Hand-back of a reference means the pump claims that existing row. The payload is not admitted again.

The barrier copies only ingress that never became a durable row: adapter, web, and Hub. A `send_to_instance` that `admitDurableDelivery` inserts under the fence is a reference, same as a row that was already queued. A deferred job is the third kind, recorded when a schedule comes due under the fence.

The three kinds share one monotonic sequence. The barrier assigns the position when it takes responsibility. `created_seq` orders durable rows against each other. It is not used as a journal timestamp, and a journal timestamp is not used to place a row among copies. The sequence number is zero-padded, so directory order is hand-back order.

The files, each written atomically (tmp, fsync, rename, fsync the directory), are #4491 §2.6:

- `inbox/<seq>-<source>.json`, where `source` is `outbox`, `adapter`, `web`, or `hub`. A reference is `{ kind: "reference", deliveryId, createdSeq }` and has no payload. A copy is `{ kind: "copy", body }`.
- `deferred/<seq>.json` is `{ seq, scheduleId, runId }`, one file per job.

The prefix is written on the successful second check, before the function returns, while the attempt is still `opened`. It is every row `claimNext` could claim that is not in flight: state `queued` or `retry_wait`, in `created_seq` order, each as a reference. A row in `delivering` or `submission_started` is not referenced. The second check has already failed while one of those exists. The prefix does not claim or delete the rows. A crash still in `opened` with those files present hands them back.

After the flag is up, later holds take the next sequence number:

- an ingress copy, when adapter, web, or Hub ingress reaches its commit point and that message was never a durable row;
- an outbox reference, when `admitDurableDelivery` inserts a row under the fence, or the first time `claimNext` would claim a delivery id that is not already in the sequence;
- a deferred job, when `runWithLock` hits the flag.

A delivery id already in the prefix is not written again. Hand-back walks this sequence. A deferred job that came due between two holds is handed back between them.

## Idle means this, and not today's Hub check

`hubUpdateIdle` stays as it is. The Hub queue and Phase 1's card keep calling it, including the rule that an agent whose interaction phase is `waiting` is not idle, and the `ownClaim` argument that keeps a launch from seeing itself as busy.

The barrier uses a sibling predicate:

- same agent loop as `hubUpdateIdle`, except `phase === "waiting"` counts as idle (the person has the turn; the agent does not);
- `hasWorkLease(name)` is false (`instance-lifecycle.ts`: a delivery in `delivering` or `submission_started`, or the short pre-claim window after a wake);
- no queue worker is `busy` or `inFlight`, and no outbox row for an agent is in flight;
- a schedule already inside `runWithLock` is not busy. `executing` is private, so the scheduler exposes a boolean for this predicate rather than the set;
- pin, pause, shutdown, a reconcile, and another update's claim are not "busy". They refuse the attempt, as Phase 1 already does. The barrier does not wait those out.

An agent that is stopped or crashed is skipped, as `hubUpdateIdle` skips it today.

## Where the fence is checked

One flag on the fleet. The read is the last synchronous commit point. A hit appends to the journal sequence and does not commit:

- the pane write, or the delivery admission, that would start or continue a turn for adapter, web, or Hub ingress. `adapter.on("message")` in `fleet-manager.ts` is too early: routing, receipt binding, and the IPC connect are still ahead of it. For a durable send the admission is `admitDurableDelivery`: under the fence the row is inserted and a reference is written, and the payload is not copied;
- `outbox.claimNext` inside `runDeliveryOutboxPump`, before the claim write. A row already in `delivering` or `submission_started` is not pulled back. While the flag is set the claim is refused. If that delivery id is not already in the sequence, the refusal writes a reference;
- the task claim write: `TaskBoard.legacyClaim`, and `applyMove` when the move is from `open` to `claimed`, after the board transaction is held and before the status write. A card that is already claimed may still be finished, blocked, or sent on. Creating an open card is not a claim. A refused claim is not a journal file;
- `Scheduler.runWithLock`, after the per-schedule lock (`executing`) is held and before `markHandled`, and before a one-shot row is deleted. While the flag is set, the occurrence is recorded as *deferred by update*, `onTrigger` is not called, and the schedule row stays. `handleScheduleTrigger` is too late: `runWithLock` would already have consumed a one-shot. Today's `runWithLock` calls `markHandled` before `executing.add`; the implementation reads the flag after the lock and before `markHandled`.

Control commands are not agent turns, and the fence does not apply to them. They run while the flag is set:

- `/status`, `/stop`, and `/restart`;
- `/cancel`. Slash `/cancel` (`fleet-manager.ts`, the slash dispatcher) and classic text `/cancel` both call `cancelInstance`. That interrupts the agent's current generation. It leaves the update attempt running;
- `/update`, and the card's cancel;
- admin actions, including the update card's own edits.

An attempt is cancelled by the card action `cancel`: POST `/ui/update/answer` with `{ action: "cancel" }`, and the Cancel button on a Hub waiting notice. The fleet writes `attempts/<id>/cancel` (`{ reason, at, by }`) only while the card is cancellable: waiting, or the barrier. `by` is the card's display label, the same kind Phase 1 stores on `lastAnswer.by`. The updater, or the recovery runner, consumes that file under the home lock, by the stage it finds, not by when the file was written:

- `opened`, `barrier`, or `stopping` with no snapshot published: the cancel is honoured. It journals `abandoning` with the cancel's reason, then renames `cancel` to `cancel.consumed`;
- `snapshotted` onwards, `committing`, or a terminal stage: the cancel is too late. It renames `cancel` to `cancel.ignored-<stage>` and journals that. The card says "too late to cancel: the update is past the point of no return" (#4491 §2.6). It does not enter `abandoning`, and it does not roll back `committing`.

The fleet does not write `abandoned`, and it runs hand-back only when the substep is `hand-back`. `/cancel` does not cancel the attempt. Today's chat `/update` accepts only `/update` and `/update now`. Slice 1.5, the General chat card, is what puts the card's Cancel on Discord and Telegram. This slice adds no typed `/update cancel`. Trial mode's "no outbound except the card" is 2.4, not this flag.

The implementation's ingress-inventory test asserts these commit points: the pane write or delivery admission (including `admitDurableDelivery`), `claimNext`, the task claim write, and `runWithLock` after the lock and before `markHandled`. A new way to start a turn that commits without one of those reads fails the test. Listing handler names is not the assertion.

## Hand-back and abandon

Hand-back runs only when the attempt's substep is `hand-back`. The fleet reads the inbox and deferred files in sequence order, not a memory queue. The process can exit between the barrier and the trial, and the files have to still be there for 2.4 and 2.5. After the old fleet has exited, 2.5 walks the same sequence, on commit or on rollback, with the same reconciliation.

A crash resumes at the first entry in sequence order that has no `<file>.acked`. Each resumed item is reconciled with durable state before it is done again (#4491 §2.6):

- an outbox reference: look the row up. `queued` or `retry_wait` means the pump claims that delivery id, and only that id. `delivering`, `delivered`, or a terminal state means it is already handed back. A row that is not there is treated as already handed back. Then `.acked`. The outbox claim is a conditional update, so it cannot be claimed twice. A reference that is not eligible yet (`retry_wait` still in backoff, or its target lane blocked) holds later entries for that same target, which is the rule `claimNext` already uses, and does not hold another target. The payload is not admitted as a second copy;
- an ingress copy: one outbox insert whose `source_key` is `update-handback:<attemptId>:<seq>`. `source_key` is `UNIQUE` (`delivery-outbox.ts`), so a replay's insert conflicts and the existing row is used. The copy is then treated exactly as a reference to that row. A crash before the insert, after it, or after the claim never creates a second message. Then `.acked`;
- a deferred job: before the trigger, write `deferred/<seq>.started` (`{ runId, at }`, atomically). Then run it through the same trigger path. Then `.acked`. The schedule row was left in place, including a one-shot. On replay, `.started` without `.acked` means the run was interrupted: it is not run again. A `schedule_runs` row is recorded with status `interrupted-by-update` and `detail` naming that runId, and the schedule's next due time is computed as usual. An entry with neither `.started` nor `.acked` is run. A deferred job runs at most once across a crash.

Abandon, when the cancel is honoured, is the updater's `abandoning` procedure. The fleet waits for substep `hand-back`. It does not leave the Phase 1 card in `updating`. The offer is shown again, with **Update now** or **Keep waiting**.

## What 2.2 uses from #4491 §2.6

S-243 owns the files under `<home>/.update-journal/` and the locks. 2.2 does not invent a second journal, and the fleet does not write a stage.

- the updater publishes `opened`, with `current` naming the attempt, before the fleet writes anything;
- the fleet writes `inbox/<seq>-<source>.json`, `deferred/<seq>.json`, and, only while the card is cancellable, `attempts/<id>/cancel`, each atomically;
- the updater advances to `barrier` after the prefix is written, and consumes `cancel` by the stage it finds;
- hand-back runs only at substep `hand-back`. A copy is admitted once, under `source_key` `update-handback:<attemptId>:<seq>`, and then treated as a reference. A deferred job writes `.started` before it runs. Each finished entry gets a `<file>.acked` sibling;
- a crash still in `opened`, with those files present, hands them back. A resumed entry is reconciled before it is done again.

If §2.6's names differ from these, this note is updated to match them before the code starts.

## Tests the implementation will bring

No production caller. The tests drive the module with a fake journal and a fake clock:

- the wait does not set the flag, and a message during the wait is delivered;
- a busy second check clears the flag, writes nothing, does not advance to `barrier`, and waits again;
- an idle second check holds the flag and writes the outbox prefix as reference files, in `created_seq` order, while the attempt is still `opened`, without claiming the rows;
- the fleet writes no stage;
- a handler resumed from an await after that check (routing, receipt binding, IPC connect, web body parse, Hub inbound) hits its commit point and does not start the turn;
- an ingress copy, a refused new claim, and a due schedule that arrive afterwards are in the journal sequence and were not started. The refused claim is not a file;
- a durable row in the prefix is not copied. Hand-back claims it when it is `queued` or `retry_wait`, and writes `.acked` without a second claim when it is `delivering`, `delivered`, terminal, or gone;
- a copy is admitted by one insert with `source_key` `update-handback:<attemptId>:<seq>`. A replay reuses that row and does not create a second message;
- `admitDurableDelivery` under the fence inserts the row and writes a reference;
- the ingress-inventory test fails when a commit point is missing: pane write or delivery admission, `claimNext`, the task claim write, and `runWithLock` after the lock and before `markHandled`;
- a schedule already inside `runWithLock` does not fail the check and is not killed;
- a one-shot deferred by the fence is still in the schedule table. Hand-back writes `.started` before the trigger. A replay that finds `.started` and no `.acked` does not run it again, and records `schedule_runs` status `interrupted-by-update`;
- `/status`, `/stop`, `/restart`, `/cancel`, `/update`, the card's cancel, and an admin card edit, still run while the flag is set;
- `/cancel` leaves the attempt running. The card action `cancel` writes `attempts/<id>/cancel` only while the card is waiting or at the barrier, and does not run hand-back until the substep is `hand-back`;
- a cancel the updater finds at `snapshotted` or later becomes `cancel.ignored-<stage>` and does not abandon;
- hand-back writes `<file>.acked` after each entry, and a crash resumes at the first entry without one, reconciling it before doing it again;
- `waiting` counts as idle here and still counts as busy for `hubUpdateIdle`;
- `--now` checks once and does not wait;
- timeout and the card's cancel leave the card offering **Update now** or **Keep waiting** rather than `updating`.
