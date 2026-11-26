# S-254: room reaction acknowledgement

Base: `b9663fb3ecfd80e1c4a0ca9e04bb239888ded8fe`. Draft/user-look hold until the Leader forwards the user's release for the actual head. Open [gallery.html](gallery.html) for the portable before/after capture set.

The old member returned after sending a reaction but left its ask owed. The new receiver-offered `room-react-ack-v1` exchange requests acknowledgement explicitly; the Hub atomically stores the reaction and completes the valid delivery, and the member completes only on the matching accepted result. A separate bound encrypted receipt preserves the strict legacy journal shape. Prompts, reminders and tool help reserve this completion for acknowledgement-only messages; conclusions still use `report_result`.

## Checks

- `npx vitest run tests/hub-room-react-ack-s254.test.ts tests/hub-room-agent-react-m3127.test.ts tests/hub-room-reactions-ui-m3127.test.ts tests/hub-room-owed-h6.test.ts tests/hub-room-answer-status-h6.test.ts tests/hub-room-owed-wiring-h6.test.ts tests/hub-room-asker-adapter-m3664.test.ts tests/hub-protocol.test.ts tests/hub-welcome-caps.test.ts tests/hub-update-capability-bounds-m3144.test.ts`: 117 tests / 10 files pass.
- `npx vitest run tests/hub-room-react-ack-link-s254.test.ts tests/hub-room-answer-status-link-h6.test.ts`: 3 tests / 2 files pass, actual owned pinned TLS/WSS + HTTP/SQLite, inert local input callbacks. These are fixture peers, not a live Fleet or CLI.
- `npm run typecheck` and `npm run typecheck:tests` and `npm run build`: exit 0. Build's existing import.meta warning is retained in its log.
- Fail first: temporarily substitute only the base member adapter, run the current `accepted acknowledgement completes` case, observe `questionSettled` false where true is required. Restore final source and all 12 cases in that file pass. `checks/baseline-to-final.patch.json` (JSON `patch` field reconstructs the exact diff) binds the substituted adapter delta. This overlaps the 117 tests, not extra distinct cases.
- Tests cover accepted reaction/restart/unchanged strict journal/no reminders or missing-answer marker, pending reminder recheck, refusal/missing/mismatched/dropped/stale result, corruption, old-peer gesture semantics, concurrent acknowledgement/text, actual Hub atomic settlement/expiry/idempotency and negotiation before RPC resolution.

## Captures and scope

`scripts/manual/hub-room-react-ack-s254/capture.mts` serves the real Hub UI from an owned HTTPS listener and its actual synthetic HTTP/SQLite rig. It creates the room/question, captures two pending frames, accepts the actual `room.react` acknowledgement, verifies authenticated GET read-back (`answered:1`, `working:0`, `later:0`, stored 👍), then captures eight after frames. `capture-checks.json` binds each PNG and reports zero page errors/overflow. All listeners, browser contexts/browser and owned scratch TLS home close afterward. Individual built-in image inspection covers all ten current originals. The capture Chromium uses a process-local Fontconfig configuration pointing to Noto Color Emoji (Ubuntu package 2.047, font SHA-256 `0f03293ecdd10b8956fecc084f96aff7adbe8692b93e89629a60a7dea7e34e60`). Nothing is installed globally or changed in product CSS. The first successful but fontless frame set was rejected during inspection and is retained privately, not published; the current ten frames are the corrected retake. No response interception or fabricated API payloads are used. No real directory, account, Fleet, agent CLI or model campaign runs.

The test that clears a retained finished-without-answer presentation seeds that old marker in SQLite; this recovery fixture is not claimed as a live agent turn. The screenshots show the ordinary real app's synthetic ask/reaction, not that seeded recovery. Existing UI production files are unchanged. An initial standalone capture-launcher attempt mistakenly used a Vitest-only listener spy, failed before opening any browser/listener, and was corrected to an ordinary owned loopback listener; this was a harness failure, not product proof.

## Risks and rollback

Acknowledgement classification remains the agent's responsibility. A lost response leaves the local ask owed until accepted retry; an unchanged emoji can still finish it. Old peers retain gesture-only semantics. Reverting the feature leaves legacy encrypted rows readable, but an older Fleet ignores the new companion and can resume reminders. No answer text is invented and no new output/contact authority is granted. See the [design note](../../design/hub-room-react-ack-s254.md).

Capture invocation: set `FONTCONFIG_FILE` to an owned Fontconfig file that includes the system config and the Noto font directory; set `OUT`, `REPO`, `PW_DIR` and `CHROME`, then run `npx tsx scripts/manual/hub-room-react-ack-s254/capture.mts`. The font is environment setup, not a response or screenshot edit.
