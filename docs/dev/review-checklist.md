# Review checklist

Check the rows that apply to your change before requesting review. In the PR,
state which contracts changed, point to their evidence, and explain any applicable
row that remains unresolved. A row outside the change's scope can be marked N/A.
These are recurring P1/P2 causes from AgEnD reviews, not a reason to reopen
unrelated behavior or to claim verification that was not performed.

| Category | Rule | Counterexample |
|---|---|---|
| 1. Unknown state | Preserve the distinction between absent, invalid and unreadable state, and admit an action from unknown state only when the applicable policy explicitly allows it. | A failed input-box capture is treated as an empty composer, or an unreadable process start time is treated as proof that an install-lock owner is dead. |
| 2. Input attribution | Require evidence tied to this attempt's payload, and obtain it after the final availability wait before sending a recovery key. | A previous draft shares the first 24 characters of a system notice; a proof taken before a transient dialog wait causes Enter to submit that draft. |
| 3. Ownership across waits | Capture the owner and its generation, recheck them after every relevant await and immediately before effects, and keep revocation permanent for that operation. | An old pane capture authorizes a key on a replacement tmux, or a connection disappearing and returning with the same id revives an old verification. |
| 4. One claim per operation | Claim synchronously before the first await in an owner that survives the relevant remount or restart, and retain the claim until the authoritative outcome settles it. | Two same-turn clicks send two prompt answers, or reopening Needs you sends a second acknowledgement before the server removes the item. |
| 5. Async result ordering | Snapshot the target, body, files and retry key at hand-off, and allow only the current read or operation generation to commit its result. | A held usage response overwrites a newer Refresh, or an avatar selected after a profile POST is sent to the old target. |
| 6. Time and deadlines | Use wall time for persisted calendar instants and monotonic time for elapsed budgets, recheck deadlines at acceptance and effects, and define rollback and forward-jump behavior. | A timer fires a persisted retry early after a wall-clock rollback, or a late capture is accepted because the budget was checked only when it began. |
| 7. Recovery and activation | Serialize changes under a proven owner, retain preimages before writes, and prove the effective loaded target and interpreter before claiming activation or rollback. | A stale-lock reader moves aside a new owner's lock, or a unit file names the new install while a loaded drop-in still starts another package. |
| 8. Exact dialog grammar | Match the complete current dialog, including ordered choices, footer and anchoring, and recapture under the write lock before automatic keys. | Reading only the suffix numbered 1..N hides an earlier destructive choice, or a quoted trust dialog in scrollback receives Enter. |
| 9. Authorization and target mapping | Enforce the established capability boundary and own-key membership, and revalidate the server-owned source-to-target mapping at the effect. | An agent widens its own tool set, an inherited `constructor` key is accepted as a configured instance, or a moved topic applies a selector to its former target. |
| 10. Physical work bounds | Bound queueing, reads and parsing as well as logical promises, keep expensive work off the event loop, and retain reservations until physical work exits. | Racing a worker with a timeout frees its slot while the worker still runs, or a short retained line is counted instead of the megabytes actually read. |
| 11. Tests that prove the contract | Exercise the real decision path with inert effects, include the failing interleaving and a positive control, and report a guard reversal only when it compiles and fails the intended assertion. | A mock reports success without executing the generated DB probe, or a supposed regression fails with TypeError or finishes before its held proof continuation settles. |
| 12. Exact evidence and claims | Bind checks to the submitted HEAD, verify the intended hook or branch ran, and limit docs and reports to the behavior and platforms actually observed. | An npm rollback cell passes because fetching failed before the hook, old green CI is cited for a changed HEAD, or docs call every Codex cache write estimated despite measured-write support. |

## Before sending

- Include the full HEAD SHA and the scope of the diff; a merge sync must identify
  what was carried and what changed.
- Report the commands and outcomes actually obtained, with failures, skips,
  synthetic fixtures, modeled boundaries and native runs distinguished.
- When a test needs process, platform or network effects, establish its private
  files, sockets, environment and inert boundaries before execution; a temporary
  `AGEND_HOME` alone does not isolate a real fleet launch. See
  [test isolation](../development.md#tests).
- Check user-facing docs against the final code and use the
  [CHANGELOG fragment rules](../development.md#changelog-fragments) for changes
  users will notice.
- Send one review request with the applicable checklist evidence. An author
  cannot approve their own PR; reviewer-authored changes need another reviewer.
