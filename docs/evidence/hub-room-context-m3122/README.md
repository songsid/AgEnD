M-3122 changes repeated room questions from “send the latest 30 again” to “send only messages after the last
confirmed question, plus a visible reply anchor.” For example, after the agent receives question1 with history A,
question2 includes new B rather than A again. A restart, owned clear or new agent session gives the next question
the full recent window. A network reconnect keeps its place. The 30-row/optional31st-anchor and 2KiB-per-post bounds,
join/audience floors, quoted prompt, room files, consent and current-link authorization remain.

The Hub stores a cursor per room/exposure/owner-Fleet binding/conversation generation. Queuing a question or accepting
IPC does not advance it. A positive ordinary pane handoff, or the existing retained consumed watcher taking a busy
Claude/Codex input, creates an encrypted member receipt. The Hub derives the interval from its exact frozen delivery;
it never trusts a supplied sequence. Receipts retry until ACK, duplicates never regress the cursor, old generations
cannot restore one, and overlapping asks retain their frozen cumulative windows until confirmed. Overlaps can
therefore repeat context that was unconfirmed at queue time. A reset fences old queued input at the final write.

Negotiation is the Hub-only `room-context-v1` welcome offer and an explicit composed client option. It consumes no
member hello slot: legacy hello16 and update-enabled17, including the existing one-time fallback dropping only
fleet-update-v1, remain. A legacy Hub or Fleet continues using full-window asks. A legacy full-window ask already
in transit can be acknowledged in the newly confirmed generation; an old frozen delta is held rather than relabelled
or automatically re-entered into a new conversation. Its next new question receives the full window. Frozen answers
still retry and ACK after a context reset without advancing the new cursor. Existing room-file and post-return paths
remain intact. Exact DTOs and lifecycle rules are in docs/design/hub-room-context-delta.md.

Source and scope are bound by manifest.json to `a4939ee849d4f4e8000f719ad5cfa5dba15b87bc`, after resuming checkpoint
b10e62b8 and plain-merging alpha0f7e0e392 at85ca58bec. Three resolved files retain both sides: HTTP feature list keeps
the dashboard, representative delivery keeps contactLimit, and room-ask keeps its explicit persisted local fields
and contact limit alongside generation. Incoming startup recovery, Hub-name metadata, version/update/relocation,
answer timestamps/dashboard and room-post returns are preserved.

Validation:

- Original production context baseline fails the delta assertion: messages2/3 are resent (`before.log`). The pending
  checkpoint HTTP failure was a fixture counting an unrelated replay as a new ask; selecting the exact question
  removes that false assumption (`http-focused.log` historical). No replay or durable dedupe assertion was dropped.
- Actual daemon baseline has three semantic failures (`daemon-baseline.log`): no retained busy-input watch, old input
  pasted after a reset during readiness, and a non-Claude session change failing to rotate. All are corrected and
  pinned through real Daemon methods with inert captured panes. An earlier harness setup omitted window-id and is
  excluded from semantic baseline counts. Owned clear is pinned at the actual command-write callback, not queue time.
- A separate semantic frozen-answer baseline (`answer-reset-before.log`) fails to retry after reset; final code lets
  the already frozen answer return under unchanged consent while fencing new input and context receipts.
- Candidate ten-file run is123/123 (`focused-candidate.log`): five new context suites plus room-ask, room-files,
  queued-handoff, Fleet hooks and representative tests. Fleet final18/2 adds one actual IPC-dispatch case and strengthens
  the existing representative metadata assertion;17 tests overlap. Migration/member composition contributes16/2;
  later migration expectations preserve old values plus nullable context_generation and append the new component
  after the shipped dashboard. Historical reds and final7/7 are retained. Total:140 distinct cases across13 files.
  The final restored six new suites pass20/20 and overlap those140 completely, not an additional20 cases.
- Owned pinned TLS/WSS + actual Hub HTTP/SQLite/real audit + durable member adapter prove first-window, IPC-not-input,
  lost input ACK/reconnect without repaste, subsequent delta, and reset full-window. The same link suite checks
  strict16-cap compatibility, opt-in and update-only fallback. Its first hello-capture/listener-lease harness failure
  is retained separately. Physical agent input is inert. Actual Daemon delivery/consumed callbacks and actual Fleet
  local-socket current/stale IPC dispatch are separately scoped controls; this is not a full Fleet/CLI rehearsal.
- Seven isolated reversals each produce an assertion failure: resend old context, allow stale-generation receipt,
  equate IPC with input, remove final reset write fence, suppress frozen-answer retry, remove local negotiation
  opt-in, and omit the retained consumed marker. Exact source restoration and selected commands/digests are recorded
  in mutations/results.json. These are runtime assertions, not a whole-program type check of each mutant.
- Both final restored native TypeScript programs exit0 (`mutations/final-results.json`). No UI layout changes exist;
  browser/screenshots are N/A. No live Fleet, AD, container, vendor CLI, real pane input or update runs.

```sh
npx --no-install vitest run tests/hub-room-context-m3122.test.ts tests/hub-room-context-member-m3122.test.ts tests/hub-room-context-http-m3122.test.ts tests/hub-room-context-daemon-m3122.test.ts tests/hub-room-context-link-m3122.test.ts tests/hub-room-context-fleet-m3122.test.ts --maxWorkers=2
npx --no-install vitest run tests/hub-room-ask-track-c.test.ts tests/hub-room-files-member-3125.test.ts tests/queued-handoff-3030.test.ts tests/hub-fleet-hooks.test.ts tests/hub-representative-fleet.test.ts tests/hub-compose-member.test.ts tests/hub-rooms-migration-r1.test.ts --maxWorkers=2
npx --no-install tsc --noEmit -p tsconfig.json
npx --no-install tsc --noEmit -p tsconfig.test.json
```

All local runs use at most2 Vitest workers and start below host load10. Compatibility fallback is intentionally
conservative: missing/unwritable generation or uncertain input cannot claim remembered history. The additive Hub and
member migrations and newer encrypted row fields are retained on rollback. Disable the optional context offer and
client opt-in in a compatible fix while keeping those readers/migrations; an older binary may refuse the newer state.
Do not delete cursors, journals, generations or old binding history to roll back. No separate protocol/security gate.
