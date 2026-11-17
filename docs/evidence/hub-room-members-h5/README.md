# H5: bounded room-member lookup

The legacy lookup returns the whole room roster. On a compatible Hub, `hub_room_members` now returns the purpose and counts first, then a bounded page of intact rows. Optional query matches name, owner or introduction case-insensitively; kind selects shared agents or people. Default limit is 20, maximum 50. Result text, including counts/cursor/hint, stays at or below 8 KiB.

## Acceptance

- `room-members-v2` is a Hub-only extended-welcome offer, adding no member hello slot. The new Fleet requests `v2:true` only on a negotiated link. An old Fleet's unchanged request gets its unchanged strict legacy result. New filters or paging on an old Hub return an explicit unsupported explanation rather than being silently ignored. Static MCP listing still never awaits Hub state.
- Existing current-caller, local consent, published exposure, room membership, link and post-await disclosure fences remain. The lookup never returns directory records from outside that room. Existing rate limiting remains.
- People and shared-agent counts refer to the whole room, while matched/returned describe the filtered page. A separate `assistant` boolean records the room assistant. The assistant remains kind `assistant`, with its fixed introduction, no owner and `mentionable:false`; it follows agents and precedes people. `kind:agent` excludes it. This is the PM clarification recorded in the copied spec.
- Agent callers cannot @mention the room assistant today: the shared answer/post mention resolver exposes people and current shared-agent exposures only. H5 describes that limit without changing routing. Shared-agent rows contain owner and introduction; people have neither introduction nor owner.
- Without a query: shared agents, assistant, people; ready before offline; then name/id. With a query: exact name, prefix, name substring, owner, introduction, then the same tie breakers.
- Opaque cursors bind the caller/exposure scope, room, purpose, filters and ordered roster. Stale/foreign cursors return no rows. Presence text changes that do not change ordering do not invalidate a page. Rows are never cut; the next cursor resumes after the last whole returned row. A header or single row that cannot fit returns a small backpressure error, not an oversize response or an unadvanceable cursor.

## Verification

Fail-first: both new HTTP cases fail on the H4 base because the strict legacy request rejects `v2`. Final page/HTTP/adapter checks pass **23/23**. The earlier page/HTTP/MCP/feature set passes **27/27** before the assistant clarification. Native/protocol/adapter checks pass **56/56**, with the separately corrected owned TLS test **1/1**. Final actual MCP/skill checks pass **12/12**. Counts overlap and are not summed. Source and test typechecks pass.

```
npx vitest run tests/hub-room-members-page-h5.test.ts tests/hub-room-members-http-h5.test.ts tests/hub-room-post-fleet.test.ts
npx vitest run tests/hub-room-members-link-h5.test.ts tests/hub-room-post-protocol-3118.test.ts tests/native-mcp.test.ts
npx vitest run tests/hub-room-post-mcp.test.ts tests/hub-skill.test.ts tests/hub-groups-mount-s89.test.ts
npm run typecheck
npm run typecheck:tests
```

The actual pinned TLS/WSS/HTTP/SQLite rig verifies the v2 request/result, a strict legacy request/result and an old Hub refusing the v2 send. Its first run exposed a missing test-receiver bridge, fixed in the owned harness; there was no product transport defect. The PM's subsequent assistant-only DTO clarification is covered by scoped model/HTTP/adapter checks.

The stdio MCP child verifies optional arguments reach the outbound handler unchanged and limit 51 is refused. A large Chinese roster passes through the real handler/MCP serialization; `content[0].text` is at most 8192 UTF-8 bytes, contains whole introductions and supplies a continuation cursor. Native tools consume the same schema and JSON-result representation. No vendor CLI, model call, real directory/account, live Fleet, visible browser or Windows process. This slice changes no browser UI and makes no new screenshot claim.

`source-sha256.txt` binds the tested changes. Acceptance names the PR head.

## Risk and rollback

A roster/name/ownership/order change can stale a cursor; callers restart the lookup with the same filters. The room's existing per-owner read limit still applies. Very large grapheme sequences can exceed the byte budget even with a valid character count, and are refused rather than cut. No schema migration is added. Reverting the code removes the v2 offer and preserves the existing lookup. H4's first-brief shared-agent count stays unchanged.
