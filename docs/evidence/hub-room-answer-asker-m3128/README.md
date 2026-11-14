# Room answer asker identity — M-3128 server seam

Product: 505a4887e3827ba1e7430ecbb7292d14f0c81e81, based on alpha49aa5d15cc196154c73da074959c49bfe7027ee3.

An answer event previously exposed answerTo but no person identity. A browser without the question in memory could not distinguish an answer to its own question from another person's. The shared group-room projection now exposes askedBy from the retained immediate parent. This is the room person-member id, matching that room's me.id and the question's author.id, not a directory person key or an agent owner's id. The answer-to-parent relationship was already persisted when the answer row was queued, so no new migration or Fleet frame is needed. The same projection covers queued/answered Fleet replies, room-assistant replies, live events, paging and restart.

Agent parents omit askedBy. A via post for an owner absent from the room uses the source agent member as its author-id fallback; that fallback is explicitly excluded. Consumers must resolve their identity per room: one room's me.id cannot identify them in another room.

Validation:
- Selected regression cases before the change:4 semantic test failures,1 passing negative,38 skipped. The output includes soft-assert failures in the same test.
- All3 affected files pass43/43 after the change: agent R2, assistant R3 and agent-mention paths. Cases cover a queued reply, answer-only paging viewed by another person, live event/history/restart, the assistant's1:1, agent-to-agent exclusion and absent-owner via exclusion.
- Source and test TypeScript programs both exit0; changelog validation passes.
- Inert links/providers in the existing HTTP/SQLite rigs; R2/agent-mention suites use real audit. No new browser, stdio MCP, live TLS/WSS, mutation or vendor campaign.

Commands: GOMAXPROCS=2 nice -n10 node_modules/.bin/vitest run tests/hub-room-agents-r2.test.ts tests/hub-room-assistant-r3.test.ts tests/hub-room-agent-mentions-3118.test.ts --maxWorkers=1; node_modules/.bin/tsc --noEmit; node_modules/.bin/tsc --noEmit -p tsconfig.test.json.

This additive field is ignored by older clients. A notifier should fail closed when askedBy is absent. Rollback is the code change only; no retained schema or authority changes.

Alpha sync: 996da3b42977e14b6fe6b3a7392c53c4cea27538 merges reviewed f178f33d with alpha1583d616 (#3927). The sole conflict keeps the incoming progress sums and the original askedBy query/return. An isolated-index application of the exact reviewed patch onto alpha reproduces the entire resolved tree; all own added/removed lines match. See alpha-sync.json. Source and tests are unchanged, so no local re-verification was run; fresh exact-head CI and formal re-approval apply.
