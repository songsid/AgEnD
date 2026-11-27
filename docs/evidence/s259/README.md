# S-259 — bounded agent room history

Standalone implementation based on release commit `928c17de12b5147fc4dafeacdfd971f7959efa36`, after the room-reaction acknowledgement fix merged. Product design: [agent room history](../../design/hub-room-history-s259.md).

## Scope and root cause

The member had delivery context but no independent older-history read. This adds the negotiated `room.history` RPC and `hub_room_history` tool. Current behavior requires request-context On with a captured request; Off refuses all history reads. The tool preserves the current agent/share and Hub membership/visibility fences. It does not modify browser UI, ask settlement or the first-ask context cursor. Fixtures use synthetic identities, inert agent input and owned scratch listeners; no live directory, Fleet, vendor CLI, account or model calls.

## Validation

Initial fail-first: all three actual HTTP/SQLite history tests failed because the missing operation returned no result. They pass with the implementation. The focused suite covers membership and cross-Fleet refusal, join and inherited lineage floors, hidden-question answers, membership cursor invalidation, archived/all-history reads, byte packing/truncation, cross-room cursor refusal, durable hourly accounting across rooms/reconnect/restart and clock rollback, stale disclosure fences, and strict protocol/result bounds.

The existing actual MCP → invoking handler → member factory → pinned TLS/WSS → Hub HTTP/SQLite journey reads history while the agent's human owner is absent from that room. A separate actual client receive-method control rejects an unnegotiated matching RPC result before resolution. Older member welcome lists remain unchanged. Existing member/reaction negotiation controls carry through focused runs.

The unchanged menu ratchet initially failed at 67,365 bytes, then 67,063 after the first copy reduction; existing Hub tool descriptions were shortened further. No menu bound was raised. The exact feature-list and tool-profile ratchets explicitly register the new capability/tool. Production build includes asset generation. Test fixtures' initial type errors and an invalid paused SQL state were corrected rather than counted as product failures.

Original-head validation at `75861cc0`: **235 distinct tests in 14 files**, accumulated without repeating the full campaign: the 10-file final scoped run passed 185; the HTTP/transport controls added two cases (187); existing members/reaction link controls add three (190); native MCP and agent-endpoint controls add 45 (235). Later focused reruns overlap those counts. Production build and final test types exit 0. Default menu sizes: worker 44,191 bytes (<46,000), General 66,953 (<67,000).

Commands (all fixture-only, `--maxWorkers=2`):
- `npx vitest run tests/hub-room-history-s259.test.ts tests/hub-room-history-transport-s259.test.ts tests/hub-room-post-fleet.test.ts tests/hub-room-post-mcp.test.ts tests/hub-room-post-rc-integration-3118.test.ts tests/tool-permissions.test.ts tests/hub-groups-mount-s89.test.ts tests/instruction-diet-m2133.test.ts tests/hub-room-post-protocol-3118.test.ts tests/request-context-policy-s232.test.ts`
- Focused compatibility controls: `tests/hub-room-members-link-h5.test.ts`, `tests/hub-room-react-ack-link-s254.test.ts`.
- Focused routing controls: `tests/native-mcp.test.ts`, `tests/agent-endpoint.test.ts`.
- `npm run build`; `npm run typecheck:tests`; `git diff --check`.

[Deliberate negative controls](negative-controls.patch): removing the SQL join/lineage/question floor fails `reads chronological pages…`; disabling the durable hourly cap fails `keeps a durable hourly cap…`. Both exited 1 on assertions, and source bytes were restored in `finally`. The first floor-removal attempt passed because the initial test stopped before the final page; the corrected test exhausts the cursor and now detects that mutation. Byte packing similarly exhausts every page and checks all 12 numbered messages exactly once.

Source/mutant SHA-256 bindings for those two isolated controls:
- `join-floor`: source `10b4c8000df8624244c8924cc7e8d2f74b9a3b19e5a881fbb0844bafe8785e1d`, mutant `466c257ef46f47e6ec98fbb9a6945abcbaca286bab533ccab69d9b3ad3c909c8`.
- `hour-cap`: source `f945a7c254272344129ff9997e7616a93142dfd6256a3b2116646d996b0cc06b`, mutant `0fdcd51b13948c78af71b46dc326099c74f9aa9c991dede41df3076aba6a9c66`. No screenshots are required for this tool-only change.

## Limits and rollback

History returns completed message text only, with bounded author/agent-app attribution; it omits attachments and can truncate long messages explicitly. Rate limiting is a fixed UTC-hour budget, not a sliding window. The current share must still be eligible; historical text grants no consent. The new Hub budget table is an additive migration; retain it on rollback and use a compatible binary with the capability disabled. Do not delete Hub state to roll back.

## R1 — original-room request boundary (historical; Off behavior superseded by R2)

Fable found that the read classification allowed an admitted Hub request to fetch another room. The fail-first policy control reproduced room A → room B being allowed. R1 chooses original-room-only under request-context On: the source audience must be a group room and the tool must use that exact ID; a Hub 1:1 and an uncovered call refuse. Owner turns stay available. The actual call-admission proxy captures scope through the actual member adapter, which checks the originating Hub and room before disclosure and the lease again afterward. Return-audience changes do not grant access to another room.

Three actual proxy/adapter tests cover A allowed/B refused, direct/uncovered refusal, owner access, wrong-Hub refusal and lease expiry during a held result. At R1, Off-mode cross-room reads remained possible, with no-relay guidance only. That behavior was superseded by the enforced Off refusal in R2 below.

Hub service, protocol, schema, hourly budget and browser UI are byte-unchanged from the original head, so the bounded paging/rate/transport and no-new-capture evidence above carries within that scope. R1 focused validation: **139 tests in 6 files**, including one added policy test and three actual proxy/adapter tests; all pass after correcting an initially invalid synthetic context reference. The first policy test failed before the fix because the cross-room read did not throw. Final production build and test types exit 0. Menu sizes are worker44,199/General66,961 under unchanged bounds. This adds four cases to the historical 235 (239 distinct in 15 files, not a repeated full run). The updated manifest binds 37 files. Prior exact-head CI does not carry.

## R2 — refuse Off without a reliable active-ask lease

Current product rule: history is usable only with request-context **On**. With Off, a retained room-ask row or conversation generation cannot authenticate the particular tool call's active room ask. The implementation therefore refuses Off entirely rather than guessing a last/owed ask. The Fleet checks mode before dispatch and keeps the same policy in its current-call fence; the member adapter refuses a missing scope, and the native admission wrapper discards a held result if that policy is switched Off/replaced. On retains R1's original group-room/issuer/lease binding and covered owner reads; 1:1s remain refused.

Fail-first: the prior guidance-only Off control returned a successful page when the corrected test expected refusal. The actual scope/adapter controls now expect Off refusal with zero remote calls and add mode-switch-during-await coverage. The existing real MCP→factory→pinned Hub/SQLite journey first proves Off denies without an RPC, then supplies a captured owner On lease and reads the room successfully.

The prior full build/types are historical. In deference to rehearsal host priority, R2 runs only named focused fixtures with maxWorkers2: no full-suite/typecheck/build loop, no new browser/container campaign. R2 focused validation passes **40 tests in four named files** with maxWorkers2, including one additional mode-switch case (240 distinct cases/15 files over staged runs; not a repeated full campaign). The corrected Off control failed before the product fix, then passed. Menu sizes: worker44,219/General66,981, under unchanged bounds. Source signatures are unchanged; fresh exact-head CI must perform its normal compiler checks. Remote Hub service/protocol/schema/hour-budget and browser UI remain unchanged; their prior proof carries only within that scope.
