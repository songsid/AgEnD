# Six answers, member mentions and live ordering

Source `500ee6d50130894cae39121ea556414a2864d4bb` passes **88/88 real browser checks**, with **eight original PNGs** on English desktop/light and zh-TW phone/dark. The image-only child inspected all eight, including the collapsed and expanded views together, and found no layout blocker. This extends the previously PM-cleared routing subset; it does not claim a Team-provider or full S-142 walk.

The six owned Fleet fixtures use actual Hub HTTP/SQLite, pinned TLS/WSS and C's durable room adapter/state publisher. Directory reads, physical input and reports are inert. The captured bridge connects two existing test rigs rather than mounting a complete FleetManager. No real account, agent CLI, directory or vendor API is used. Final receipts bind 98 served assets, 22 source/test paths and eight PNG hashes. Two transient projection backpressure attempts recovered through the existing bounded SSE retry; they are retained in the receipt.

Up to five answers remain unfolded. Six answers show the first three with a left-aligned “Show 3 more” link immediately beneath the third. Expansion preserves every question reference and the human message sent between answers two and three. Sam's complete `@project-helper` is accented after members load. Owner names remain visible, including “Alex 的 Agent” spacing on the phone.

The extension exposed an ordering defect that the previous 86-check walk did not assert. The server moved completed replies to their committed SQL sequence, while the live UI replaced queued placeholders in their original array slots. The final walk now fixes each answer's actual commit before sending the next and asserts **answer 1 → answer 2 → human → answers 3–6** in the live thread. Before U1's correction, the desktop run had one chronology failure among 43 checks; its other 42 checks passed. Those original four PNGs and its receipt remain under `history/before-ui-order-fix/`.

R change `8e373263e` exposes the existing sequence as optional `RoomMessage.sequence` on group-room POST, history and SSE projections. It changes no stored order, migration or Fleet frame. Its actual HTTP/SQLite/SSE regression fails before the field exists, then verifies that a pending answer receives a later sequence than the intervening human message. U1 `3d30a29ea41ee2ed85f93ae5d819680e9d8af947` sorts the store before drawing when every row carries a safe integer sequence. Older/direct rows without it retain arrival order. The server metadata and UI consumer ship separately; cached tabs need the UI update to reorder live answers.

Fresh server acceptance is **42/42 in three suites** at `8e373263e`; fresh UI acceptance is **37/37 in three suites** at the final source. Both native programs exit 0 at the final source. Commands are recorded below; historical campaigns are not added to these totals.

```sh
nice -n10 node_modules/.bin/vitest run tests/hub-room-agents-r2.test.ts tests/hub-rooms-r1.test.ts tests/hub-room-assistant-r3.test.ts --maxWorkers=2
nice -n10 node_modules/.bin/vitest run tests/hub-room-thread-3092.test.ts tests/hub-room-members.test.ts tests/hub-room-presence.test.ts --maxWorkers=2
GOMAXPROCS=2 nice -n10 node_modules/.bin/tsc --noEmit
GOMAXPROCS=2 nice -n10 node_modules/.bin/tsc --noEmit -p tsconfig.test.json
```

The browser uses `ANSWER_AGENTS=6`, `SHOTS=five-answers-visible,six-answers-collapsed,six-answers-expanded,member-mention` and `scripts/manual/hub-rooms/routing.mts`. Its evidence-only writer labels wire UUIDs as `idempotencyId` and represents asset digests as `servedAssets` entries. Decoding all three retained receipts reproduces each original canonical JSON SHA-256. Runtime fields, UUID values and PNG bytes are unchanged. The earlier pre-chronology receipt is explicitly historical rather than proof of ordering.

Rollback removes the optional projection field and the UI sorting rule. The underlying SQL order, stored messages and durable delivery identities remain intact. Team storage/provider and the combined final PM walk remain open; no new PM clearance is claimed by this packet.
