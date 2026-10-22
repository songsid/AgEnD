# Interrupted work, staged delivery (#2473)

The approved design is [issue comment 6352248250](https://github.com/songsid/AgEnD/issues/2473#issuecomment-6352248250).
The leader requires four independently reviewed PRs in a later 2.3.x release:

1. Observational journal, structured logs and Log tab. No recovery behavior changes.
2. Durable session-OOM terminal blocker, including automatic startup/retry/wake.
3. Stable, pressure-paced recovery coordinator, deduplicated continuation/General summary and opt-out.
4. Consolidate #1209/#926 restart paths and import the legacy marker.

The restart/OOM/crash-loop harness is required for stages 3/4; a packaged rehearsal is required before stage 3 ships in a beta. This is not a 2.3.0 GA blocker.

## Stage 1 contract

`working_state_journal` is a lazy extension of `delivery-outbox.db`, using its existing WAL transaction and process-crash durability. It adds no separate database and does not change SQLite's existing power-loss policy. Each instance has one latest metadata snapshot and at most one first prior interruption observation. Each JSON snapshot is at most 8 KiB, with at most 16 references; the row therefore has a fixed maximum of two snapshots. Duplicate heartbeat observations do not write. A pre-stop/pre-spawn boundary is recorded even when the observed values otherwise match. The prior observation survives further boots and is not consumed in this stage.

The snapshot whitelists launch ownership, backend, a workspace/profile digest, cached activity time, execution/process state and background work observed from an already-captured pane, turn IDs/generation/cancellation/completion evidence, task UUID/version/status, and open incoming/outgoing reply-obligation references. Reference totals expose overflow. Missing stores are explicitly unavailable rather than treated as proof there is no work. The current session/backend turn IDs remain null: this path must not discover a session through a backend method, walk transcript directories or query a CLI. Claimed/review/blocked card references are observations, not permission to execute those cards. A later coordinator must revalidate direct ownership, status, permissions and completion.

Observation hooks run on published daemon state edges, accepted pause/wake transitions, confirmed human delivery, cancellation, guard closure, delivered completion, process/supervision transitions and before guard retirement during stop/spawn. Board mutations refresh both old/new owners; reply-reference changes are observed after the owning delivery transaction. A replaced daemon or stale launch observation cannot overwrite the current owner's row. Identical hooks are attached once per daemon. Journal writes use a zero busy wait and restore the delivery connection’s timeout, so a diagnostic cannot stall every stop behind an external SQLite writer. Observer/store failures are contained and do not change delivery, cancellation, task mutation, startup or shutdown results.

Observation begins when the managed daemon is published after startup, including ClassicBot daemons; the initial snapshot records its resulting state. Transient events before publication are outside this stage's history. A startup failure before publication leaves the existing journal untouched.

No original message, task title, pane output, transcript/config path, full config, tool arguments or credential value is copied. Identifiers are bounded without prefix truncation, so an oversized ID cannot alias another reference. Structured daemon and Log events expose only state/reason/revision/reference counts. The existing Log authorization, masking and enable switch still apply; observational entries are visible in All but excluded from Errors.

This is a record, not a resume decision. A prior snapshot can be stale, cancelled, completed or reassigned; it must never authorize recovery on its own. This stage leaves `in-flight-turn.json`, #1209's consume-before-gate logic, #926 reminders, crash-loop recovery and #2446 supervision unchanged. No new prompt, automatic start, queue item or General summary is produced. The next stages add terminal authority and recovery reconciliation separately.

Rollback is a normal revert. Unused additive rows can remain in the outbox; ordinary delivery tables retain their previous schema/semantics. Do not reuse this stage's rollback statement for the later durable OOM blockers, which must not be bypassed by a downgrade.

The data-downgrade compatibility workflow populates both journal snapshots, checks their exact stored JSON bytes after the published 2.1.12/Node 20 outbox opens, recovers and writes deliveries, then checks that the current build can read and update the retained row while preserving its prior snapshot.
