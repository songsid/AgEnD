# Track C seam 2 — current R1 revision

Current source/test producer `40a2dd3bf6dc81a85b563dec4c9cb2ca1e62aac6`. [R1 bindings](r1/bindings.json) bind the current product, tests, restored final #3848 client test, fixture and design. The remaining text below this section records the original submission at `985e2753`; its root `bindings.json`, counts and logs are historical and must be checked against that head, not the current source.

R1 adds the actual current-link `welcome-caps-v1`-without-`room-ask-v1` negatives for admission, frozen-answer flush/ACK and presence. It fixes delivery/report callbacks settling after the member DB closes (two failing controls before the guards), and puts room-member content in a JSON data block with EN/zh trust framing. A plain merge restores #3848's final notices-contract test byte-for-byte.

Presence now emits stable reason codes, never Fleet-locale text. Ridge confirmed the optional `agent.state.reason`/HTTP `presenceReason` contract and published the matching schema/type at `563769ff7`. Lumen's `d58564ddc` mapping normalizes stopped/crashed to grey Stopped (distinct from Fleet Offline), makes wakeable sleep Idle, and leaves ordinary pauses yellow. C emits `state:paused, reason:stopped` for stopped/crashed without crash details. The viewer translates these codes; its reply/integration is still pending when this evidence is packaged. This PR remains unmounted and must not advertise the feature before the producer, viewer and composition are ready.

**Current checks:** 105/105 across the same five focused suites, including 46 adapter/presence cases; both native TS7 programs exit 0. Seventeen isolated reversals compile and fail by assertion, with exact restoration (`r1/mutations`). Separate exact old-function replays from reviewed head985e (presence and prompt only, in the new module framework) compile and fail three selected assertions; these are not full old-head runs. Two closed-DB controls were red before the guards. No browser/live input/AD/model/socket/container run was added. The wrapper is prepared only; no currently available browser flow changes.

The initial preliminary timeout remains excluded. Current recipes/logs live under `r1/`; root negative logs and the initial ten-case summary remain historical. All evidence files are hashed by the top-level SHA256SUMS. The runtime source/tests are unchanged by later evidence commits.

---

# Initial submission (historical): injectable Fleet room asks

Producer `4ef46c70aac923187d54c81426f2c01b0937d3b5`. `bindings.json` binds the product, tests, fixture and design. The product is not mounted in the member factory and does not offer a new capability. This is the first Track C preparation PR, not a completed rooms feature or a live Fleet rehearsal.

## Outcome

An authenticated room-ask adapter stores one per-agent delivery, sends the prompt through the existing representative delivery callback, and commits a frozen text answer before retrying it until the exact current-link ACK. A separate injectable publisher derives bounded presence from existing process/execution states. Current direct questions, grants and release leases are unchanged.

The worked fixture is #3848, based on `f474423f` and plain-synced through its `f7490a455` update. Track R's public #3858 supplies the agreed future wire types/schema. `docs/design/hub-room-ask-member.md` records the composition requirements and ownership split. The first-input path waits for current-link replay after reconnect; an unanswered interrupted input is held instead of resent.

## Checks

```sh
nice -n 10 node_modules/.bin/vitest run --maxWorkers=2 \
  tests/hub-room-ask-track-c.test.ts tests/hub-rooms-client-3092.test.ts \
  tests/hub-representative.test.ts tests/hub-quota.test.ts \
  tests/hub-quota-mixed-version.test.ts
nice -n 10 node_modules/@typescript/typescript-linux-x64/lib/tsc --noEmit
nice -n 10 node_modules/@typescript/typescript-linux-x64/lib/tsc --noEmit -p tsconfig.test.json
```

96/96 tests pass across five files, including 38 new adapter/presence tests. Both native TypeScript 7.0.2 programs exit 0. The tests use the worked rooms fixture, actual better-sqlite3 in memory and on disk, actual authenticated encryption, and inert link/delivery callbacks. The on-disk reopen checks exact answer replay, a single agent input and absence of plaintext question/answer bytes. Held callbacks exercise control/ACK independence, link/exposure replacement, interrupted input and stale presence observations. No vendor, model, AD, browser, container, socket, live transcript, real Fleet input or OS launch was used.

`checks/*-red.log` are **new-component TDD stub runs**, not failures on an installed alpha. Initial presentation stubs produced 11 assertion failures/one positive; the empty adapter produced 12 failures/12 positives after presentation was implemented; the empty presence publisher produced four failures/31 positives. These historical tests had fewer cases than the final suite. Paths in copied logs are replaced with `<worktree>`.

`mutations/summary.json` binds ten isolated, native-compiling source reversals to the final source/test hashes. All ten produce assertion failures and the exact original source is restored. They pin payload replay, lifecycle identity, durable input intent, exact answer ACK, held recovery, single first-input claim, frozen answer ID, stale presence fencing, unchanged presence dedupe and the older-reply context bound. Each copied test log is the corresponding negative run. `recipe.py` is the author-only reproduction recipe, run from an isolated checkout with no background runtime; it checks host load before every case and restores the source in `finally`.

The preliminary recovery reversal timed out on a deliberately held delivery and is excluded from the ten final proofs. The test was repaired to assert the retained state before waiting; the final R5 log is an assertion failure. It is not counted as a product bug fix.

## Scope and rollback

No production caller imports the new module yet. R2 must register the migration, inject the selected binding/key, multiplex reports, keep room work off the control queue, and explicitly opt into the feature. Older members remain unoffered. The Hub skill, browser assets and PNG gallery are unchanged because no user flow becomes available in this PR; the integration PR must cover those surfaces. Invitations, teams, roles and the assistant remain separate slices.

Rollback before composition removes the unmounted module; no runtime DB is changed by this PR. After future composition, retain the room rows and key when disabling the feature so a frozen answer or ambiguous input is not lost. This slice does not claim rollback-resistant database history or end-to-end room authorization; Track R owns current room consent and routing.
