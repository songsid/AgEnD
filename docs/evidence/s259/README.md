# S-259 — bounded agent room history

Standalone implementation based on release commit `928c17de12b5147fc4dafeacdfd971f7959efa36`, after the room-reaction acknowledgement fix merged. Product design: [agent room history](../../design/hub-room-history-s259.md).

## Scope and root cause

The member had delivery context but no independent older-history read. This adds the negotiated `room.history` RPC and `hub_room_history` tool, preserving the current agent/share and Hub membership/visibility fences. It does not modify browser UI, ask settlement or the first-ask context cursor. Fixtures use synthetic identities, inert agent input and owned scratch listeners; no live directory, Fleet, vendor CLI, account or model calls.

## Validation

Initial fail-first: all three actual HTTP/SQLite history tests failed because the missing operation returned no result. They pass with the implementation. The focused suite covers membership and cross-Fleet refusal, join and inherited lineage floors, hidden-question answers, membership cursor invalidation, archived/all-history reads, byte packing/truncation, cross-room cursor refusal, durable hourly accounting across rooms/reconnect/restart and clock rollback, stale disclosure fences, and strict protocol/result bounds.

The existing actual MCP → invoking handler → member factory → pinned TLS/WSS → Hub HTTP/SQLite journey reads history while the agent's human owner is absent from that room. A separate actual client receive-method control rejects an unnegotiated matching RPC result before resolution. Older member welcome lists remain unchanged. Existing member/reaction negotiation controls carry through focused runs.

The unchanged menu ratchet initially failed at 67,365 bytes, then 67,063 after the first copy reduction; existing Hub tool descriptions were shortened further. No menu bound was raised. The exact feature-list and tool-profile ratchets explicitly register the new capability/tool. Production build includes asset generation. Test fixtures' initial type errors and an invalid paused SQL state were corrected rather than counted as product failures.

Final validation: **235 distinct tests in 14 files**, accumulated without repeating the full campaign: the 10-file final scoped run passed 185; the HTTP/transport controls added two cases (187); existing members/reaction link controls add three (190); native MCP and agent-endpoint controls add 45 (235). Later focused reruns overlap those counts. Production build and final test types exit 0. Default menu sizes: worker 44,191 bytes (<46,000), General 66,953 (<67,000).

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
