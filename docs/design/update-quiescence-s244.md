# Quiescence barrier (S-244, slice 2.2)

**Status:** slice note. The product rules are design #4480, §3.3 step 2. This note only says where those rules meet the fleet that is on `release/2.3.5-alpha` now. It does not add a rule.
**Implementation:** after S-243 (2.1, the attempt journal and the locks). This PR is the note only.
**Reviewer:** Fable or Prism, by the usual even/odd PR number.

## What this slice owns

2.2 is the barrier: wait until the fleet is an idle candidate, open the attempt journal, then fence and check again in one turn. If the second check fails, the fences come down and anything held is handed back, in the journal's sequence, to the fleet that is still running. If the wait exceeds `updates.maxIdleWait` (default 24 hours) or the attempt is cancelled, the journal records *abandoned*, the same hand-back runs, and the card goes back to offering **Update now** or **Keep waiting** (§3.3 step 2.4).

2.2 does not take the prefix, home or service locks, write the journal format, stop the fleet, snapshot, enter trial mode, or prove health. Those are 2.1, 2.3, 2.4 and 2.5. It does not change the card's words. That is 2.6.

The live installer does not call the barrier in this slice. Trial mode and the update inbox are not on the install path yet. Wiring the barrier into `launchInstalledUpdate` before 2.5 would hold messages and then install with today's updater, which has nowhere to keep them. 2.5 is the caller. Until then the module is tested on its own, and Phase 1's idle queue is unchanged.

The barrier runs only when the caller is already in a class **Self** transaction and both versions speak it (§3.3). Otherwise the caller stays on Phase 1.

## Two steps, in this order

Fences never hold back the work that has to finish for the fleet to become idle (§3.3 step 2, Prism R2-1).

1. **Wait, with no fences.** Poll on the same cadence as today's idle queue. Replies, completions and inter-agent messages that work already in flight needs are delivered as they are today. A scheduled job never counts as busy, including one that is running.
2. **Open the journal, then fence and check again, with no await between the flag and the check.** Node runs one turn at a time. The flag is set, the idle predicate runs, and only then does the function return or await.

That stretch is the gap between the flag and the second check. A handler already awaiting when the flag goes up resumes only after the check has returned. Adapter routing or receipt binding, the IPC connect, a web body parse, and Hub inbound are all past a start-of-turn read by then. Each of those reads the flag again at its last synchronous commit point, in the same turn as the write, with no await between the read and the commit. A handler that has already passed its commit point is in flight, and the idle predicate already counts it. A handler still before its commit point is journaled there and does not commit. Those uncommitted handlers stay out of the idle predicate; the commit-point read is what diverts them.

If the second check finds the fleet busy, the flag is cleared before any reference, copy, or deferred job is appended. The attempt is not left at *quiescent*. The wait starts again. If it finds the fleet idle, still in that same synchronous stretch, the barrier records the outbox prefix below and the stage becomes *quiescent*. The fences stay up for 2.3.

`agend update --now`, and the card's **Update now**, skip the wait and do step 2 once. They do not skip the barrier. If the second check fails, nothing is installed, the fences come down, and the caller is told the fleet is not idle. A busy fleet is not held for `updates.maxIdleWait`.

## What the journal holds, and in which order

Durable outbox rows stay in SQLite (`delivery-outbox.ts`: `created_seq INTEGER NOT NULL UNIQUE`, claim order `created_seq`). Copying a queued row into the inbox and leaving it queued delivers it twice: hand-back would admit the copy, and the pump would still claim the row. The journal stores an outbox row as a reference only, the delivery id plus `created_seq`. The payload stays on the row. Hand-back of a reference means the pump claims that existing row. The payload is not admitted again.

The barrier copies only ingress that never became a durable row: adapter, web, and Hub. A `send_to_instance` that `admitDurableDelivery` inserts under the fence is a reference, same as a row that was already queued. A deferred job is the third kind, recorded when a schedule comes due under the fence.

The three kinds share one monotonic sequence. The barrier assigns the position when it takes responsibility. `created_seq` orders durable rows against each other. It is not used as a journal timestamp, and a journal timestamp is not used to place a row among copies.

The prefix is written on the successful second check, before the function returns. It is every row `claimNext` could claim that is not in flight: state `queued` or `retry_wait`, in `created_seq` order, each as a reference. A row in `delivering` or `submission_started` is not referenced. The second check has already failed while one of those exists. The prefix does not claim or delete the rows.

After the flag is up, later holds append:

- an ingress copy, when adapter, web, or Hub ingress reaches its commit point and that message was never a durable row;
- an outbox reference, when `admitDurableDelivery` inserts a row under the fence, or the first time `claimNext` would claim a delivery id that is not already in the sequence;
- a deferred job, when `runWithLock` hits the flag.

A delivery id already in the prefix is not appended again. Hand-back walks this sequence. A deferred job that came due between two holds is handed back between them.

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

- the pane write, or the delivery admission, that would start or continue a turn for adapter, web, or Hub ingress. `adapter.on("message")` in `fleet-manager.ts` is too early: routing, receipt binding, and the IPC connect are still ahead of it. For a durable send the admission is `admitDurableDelivery`: under the fence the row is inserted and a reference is appended, and the payload is not copied;
- `outbox.claimNext` inside `runDeliveryOutboxPump`, before the claim write. A row already in `delivering` or `submission_started` is not pulled back. While the flag is set the claim is refused. If that delivery id is not already in the sequence, the refusal appends a reference;
- the task claim write: `TaskBoard.legacyClaim`, and `applyMove` when the move is from `open` to `claimed`, after the board transaction is held and before the status write. A card that is already claimed may still be finished, blocked, or sent on. Creating an open card is not a claim;
- `Scheduler.runWithLock`, after the per-schedule lock (`executing`) is held and before `markHandled`, and before a one-shot row is deleted. While the flag is set, the occurrence is recorded as *deferred by update*, `onTrigger` is not called, and the schedule row stays. `handleScheduleTrigger` is too late: `runWithLock` would already have consumed a one-shot. Today's `runWithLock` calls `markHandled` before `executing.add`; the implementation reads the flag after the lock and before `markHandled`.

Control commands are not agent turns, and the fence does not apply to them. They run while the flag is set:

- `/status`, `/stop`, and `/restart`;
- `/cancel`. Slash `/cancel` (`fleet-manager.ts`, the slash dispatcher) and classic text `/cancel` both call `cancelInstance`. That interrupts the agent's current generation. It leaves the update attempt running;
- `/update`, and `/update`'s cancel;
- admin actions, including the update card's own edits.

An attempt is cancelled from chat by `/update`'s cancel. That is the card action `cancel`: POST `/ui/update/answer` with `{ action: "cancel" }`, and the Cancel button on a Hub waiting notice, which sends the same action. It is an admin action, so it reaches the barrier while the flag is set, records *abandoned*, runs hand-back, and clears the flag. `/cancel` does not cancel the attempt. This slice adds no new command. Trial mode's "no outbound except the card" is 2.4, not this flag.

The implementation's ingress-inventory test asserts these commit points: the pane write or delivery admission (including `admitDurableDelivery`), `claimNext`, the task claim write, and `runWithLock` after the lock and before `markHandled`. A new way to start a turn that commits without one of those reads fails the test. Listing handler names is not the assertion.

## Hand-back and abandon

Hand-back reads the journal sequence, not a memory queue. The process can exit between the barrier and the trial, and the sequence has to still be there for 2.4 and 2.5. It runs only while this fleet is still the one that took the attempt. After the old fleet has exited, 2.5 walks the same sequence, on commit or on rollback: a reference is claimed by that fleet's pump, a copy is admitted once, and a deferred job runs once.

The walk releases entries in sequence order:

- an outbox reference: the pump claims that delivery id, and only that id. A later row is not claimed ahead of it. The payload is not admitted as a second copy. A row already in `delivering` or `submission_started`, or a row that is gone, is skipped. A reference that is not eligible yet (`retry_wait` still in backoff, or its target lane blocked) holds later entries for that same target, which is the rule `claimNext` already uses, and does not hold another target;
- an ingress copy: admit it once, to its own target, through the normal delivery path, when the walk reaches it;
- a deferred job: run it once through the same trigger path when the walk reaches it. The schedule row was left in place, including a one-shot.

Abandon (timeout, or `/update`'s cancel) records *abandoned* on the journal, hands back, clears the flag, and does not leave the Phase 1 card in `updating`. The offer is shown again, with **Update now** or **Keep waiting**.

## What 2.2 asks of 2.1

S-243 owns the files under `<home>/.update-journal/` and the locks. 2.2 calls it. Names can change to whatever 2.1 exports, as long as the operations are these:

- open an attempt before any fence, or accept one the caller already opened;
- append, on one sequence, an outbox reference (delivery id and `created_seq`), an ingress copy, or a deferred job;
- set the stage to `quiescent` or `abandoned`, idempotently;
- read that sequence back in order for hand-back, with each entry's kind.

2.2 does not invent a second journal. If 2.1's names differ, this note is updated to match them before the code starts.

## Tests the implementation will bring

No production caller. The tests drive the module with a fake journal and a fake clock:

- the wait does not set the flag, and a message during the wait is delivered;
- a busy second check clears the flag, appends nothing, and waits again;
- an idle second check holds the flag and writes the outbox prefix as references, in `created_seq` order, without claiming the rows;
- a handler resumed from an await after that check (routing, receipt binding, IPC connect, web body parse, Hub inbound) hits its commit point and does not start the turn;
- an ingress copy, a new claim, and a due schedule that arrive afterwards are in the journal sequence and were not started;
- a durable row in the prefix is not copied; hand-back claims it once through the pump, and a second admission of that payload does not happen;
- `admitDurableDelivery` under the fence inserts the row and appends a reference;
- the ingress-inventory test fails when a commit point is missing: pane write or delivery admission, `claimNext`, the task claim write, and `runWithLock` after the lock and before `markHandled`;
- a schedule already inside `runWithLock` does not fail the check and is not killed;
- a one-shot deferred by the fence is still in the schedule table, and hand-back runs it once;
- `/status`, `/stop`, `/restart`, `/cancel`, `/update` and its cancel, and an admin card edit, still run while the flag is set;
- `/cancel` leaves the attempt running; the card action `cancel` abandons it;
- `waiting` counts as idle here and still counts as busy for `hubUpdateIdle`;
- `--now` checks once and does not wait;
- timeout and `/update`'s cancel abandon, hand back in the journal sequence, and leave the card offering **Update now** or **Keep waiting** rather than `updating`.
