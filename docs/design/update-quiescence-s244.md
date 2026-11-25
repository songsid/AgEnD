# Quiescence barrier (S-244, slice 2.2)

**Status:** slice note. The product rules are design #4480, §3.3 step 2. This note only says where those rules meet the fleet that is on `release/2.3.5-alpha` now. It does not add a rule.
**Implementation:** after S-243 (2.1, the attempt journal and the locks). This PR is the note only.
**Reviewer:** Fable or Prism, by the usual even/odd PR number.

## What this slice owns

2.2 is the barrier: wait until the fleet is an idle candidate, open the attempt journal, then fence and check again in one turn. If the second check fails, the fences come down and anything held is handed back, in arrival order, to the fleet that is still running. If the wait exceeds `updates.maxIdleWait` (default 24 hours) or the attempt is cancelled, the journal records *abandoned*, the same hand-back runs, and the card goes back to offering **Update now** and **Update when idle**.

2.2 does not take the prefix, home or service locks, write the journal format, stop the fleet, snapshot, enter trial mode, or prove health. Those are 2.1, 2.3, 2.4 and 2.5. It does not change the card's words. That is 2.6.

The live installer does not call the barrier in this slice. Trial mode and the update inbox are not on the install path yet. Wiring the barrier into `launchInstalledUpdate` before 2.5 would hold messages and then install with today's updater, which has nowhere to keep them. 2.5 is the caller. Until then the module is tested on its own, and Phase 1's idle queue is unchanged.

The barrier runs only when the caller is already in a class **Self** transaction and both versions speak it (§3.3). Otherwise the caller stays on Phase 1.

## Two steps, in this order

Fences never hold back the work that has to finish for the fleet to become idle (§3.3 step 2, Prism R2-1).

1. **Wait, with no fences.** Poll on the same cadence as today's idle queue. Replies, completions and inter-agent messages that work already in flight needs are delivered as they are today. A scheduled job never counts as busy, including one that is running.
2. **Open the journal, then fence and check again, with no await between the flag and the check.** Node runs one turn at a time. The flag is set, the idle predicate runs, and only then does the function return or await. An ingress handler cannot run in that gap.

If the second check finds the fleet busy, the flag is cleared before anything is moved into the inbox, held items (none, on this path) are handed back, and the wait starts again. If it finds the fleet idle, the stage becomes *quiescent*. Outbox rows that are queued but not yet delivering are appended to the inbox, in their existing order, and are not claimed. The fences stay up for 2.3.

`agend update --now`, and the card's **Update now**, skip the wait and do step 2 once. They do not skip the barrier. If the second check fails, nothing is installed, the fences come down, and the caller is told the fleet is not idle.

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

One flag on the fleet. These admission points read it at the start of their turn. A hit appends to the journal and does not start work:

- each adapter `message` handler that would start or continue a turn (`fleet-manager.ts`);
- the web chat post and the Hub member inbound that would do the same;
- `outbox.claimNext` inside `runDeliveryOutboxPump`. A row already in `delivering` or `submission_started` is not pulled back. The second check has already failed if one of those exists;
- `TaskBoard.legacyClaim`, and `applyMove` from `open` to `claimed`. A card that is already claimed may still be finished, blocked or sent on. Creating an open card is not a claim;
- `Scheduler.runWithLock`, before `markHandled` and before a one-shot row is deleted. While the flag is set, the occurrence is recorded as *deferred by update* and `onTrigger` is not called. `handleScheduleTrigger` is too late: `runWithLock` would already have consumed a one-shot.

The update card's own edits are not agent turns and are not fenced. Trial mode's "no outbound except the card" is 2.4, not this flag.

The implementation lists every ingress in one test, so a new way to start a turn cannot miss the flag.

## Hand-back and abandon

Hand-back reads the journal, not a memory queue. The process can exit between the barrier and the trial, and the inbox has to still be there for 2.4 and 2.5. Inbox items and deferred jobs share one monotonic sequence, so a job that came due between two messages is handed back between them. Hand-back dispatches inbox items through the normal delivery path and runs deferred jobs through the same trigger path. It runs only while this fleet is still the one that took them. After the old fleet has exited, 2.5 delivers the inbox and runs deferred jobs, on commit or on rollback.

Abandon (timeout or cancel) records *abandoned* on the journal, hands back, clears the flag, and does not leave the Phase 1 card in `updating`. The offer is shown again, with **Update now** and **Update when idle**.

## What 2.2 asks of 2.1

S-243 owns the files under `<home>/.update-journal/` and the locks. 2.2 calls it. Names can change to whatever 2.1 exports, as long as the operations are these:

- open an attempt before any fence, or accept one the caller already opened;
- append an inbox item and a deferred job on one sequence;
- set the stage to `quiescent` or `abandoned`, idempotently;
- read that sequence back in order for hand-back.

2.2 does not invent a second journal. If 2.1's names differ, this note is updated to match them before the code starts.

## Tests the implementation will bring

No production caller. The tests drive the module with a fake journal and a fake clock:

- the wait does not set the flag, and a message during the wait is delivered;
- a busy second check clears the flag, hands nothing back, and waits again;
- an idle second check holds the flag; a message, a new claim, and a due schedule that arrive afterwards are in the journal and were not started;
- a schedule already inside `runWithLock` does not fail the check and is not killed;
- a one-shot deferred by the fence is still in the schedule table, and hand-back runs it once;
- `waiting` counts as idle here and still counts as busy for `hubUpdateIdle`;
- `--now` checks once and does not wait;
- timeout and cancel abandon, hand back in order, and leave the card offered rather than `updating`.
