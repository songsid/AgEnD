# H4: a first room brief and a confirmed membership delta

A room question carried history but no purpose, member counts or handoff guidance. Compatible Fleets now receive those details with the first full conversation window. Later questions add only a membership-change line, and add nothing when the roster is unchanged.

## Acceptance

- `room-brief-v1` is a Hub-only welcome offer, gated by the existing extended-welcome signal. No member hello slot is added. The Fleet explicitly opts in with `brief:true` on `room.context-state`, only after receiving that offer. An old context-aware Fleet sends its unchanged frame and receives no brief; an old Hub gets no new field.
- The first brief contains purpose and people/agent counts, never a member list. Room-supplied purpose and names are content, not owner instructions. Fixed copy is EN/zh-TW.
- Roster snapshots freeze with the retained delivery. Only the same consumed-input receipt that advances the conversation cursor confirms them. Queueing, dispatch and IPC acceptance do not. Duplicate or late receipts cannot regress a newer snapshot. Restart/reconnect preserves confirmation; a conversation generation reset or a new room membership gets the full window and first brief together.
- A later delta compares confirmed membership identities, so a person who both joined and left between snapshots is absent. Joins come first; only joining agents carry introductions. At most five names total, and the rendered line is strictly below 600 UTF-8 bytes in both locales. Whole rows are omitted with an exact remaining count, rather than cutting a name mid-row. A purpose-only edit adds no delta.
- Accepted answers already use the same mention resolver and lineage admission as room posts. H4 preserves that path: exact-name resolution, ambiguity/self/all refusals, three-hop depth and existing rate bounds. No second answer-routing path is introduced.

## Verification

Fail-first: on the H3 base, both new first/delta HTTP assertions failed because no brief existed; the legacy control passed. Final new files pass **9/9**. The initial four-file brief/context/feature set passed **33/33** before the additional upgrade/rejoin case. Eight affected context/member/Fleet/link/handoff/parser/budget/migration files pass **50/50**. Counts overlap and are not summed. Source and test typechecks pass.

```
npx vitest run tests/hub-room-brief-h4.test.ts tests/hub-room-brief-http-h4.test.ts
npx vitest run tests/hub-room-context-link-m3122.test.ts tests/hub-room-context-member-m3122.test.ts tests/hub-room-context-fleet-m3122.test.ts tests/hub-room-agent-mentions-3118.test.ts tests/hub-room-post-answers.test.ts tests/hub-room-mentions-parser-3118.test.ts tests/hub-room-context-budget-m3300.test.ts tests/hub-rooms-migration-r1.test.ts
npm run typecheck
npm run typecheck:tests
```

The existing context link rig now proves the opt-in using actual pinned TLS/WSS, real HTTP/SQLite/audit and inert agent delivery. Server capability is absent until the explicit state request; the first ask contains its brief, IPC acceptance alone confirms neither cursor nor roster, and the lost-ACK/reconnect path produces an unchanged second ask without a reminder. A new context generation produces the first brief again. No real directory, vendor CLI, model call, live Fleet, Windows process or visible browser. This slice changes no browser UI, so H3's screenshots are not presented as new H4 evidence.

`source-sha256.txt` binds the tested source and test changes. The PR head binds the whole packet.

## Limits and rollback

The new structured member lookup/filter remains H5; H4 preserves today's lookup tool. Counts and the purpose are a snapshot at question creation. Membership storage is metadata beside the existing confirmed context marker, not a new authority source. The additive registered migration requires the pre-migration database backup for rollback to a binary that refuses a newer schema component. Old peers receive their existing ask shape; a downgraded link cannot confirm an unseen brief.
