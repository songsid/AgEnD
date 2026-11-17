H7 of M-3300, prioritized before H1–H6. The approved design is copied from71cf82a65 with the later H1/H2 and assistant-copy clarification from8646bd61b. No review branch is merged.

Root cause: formatRoomAskPrompt serialized every earlier row into the room input. Hub asks bypass the outbound cross-instance body/envelope checks; TmuxManager.loadAndPaste itself has no byte cap. A31-row fixture renders65,871bytes of history even with a lower Fleet message limit.

The Fleet now reads the current defaults.max_cross_instance_message_bytes at render time, falling back to the same12KiB constant. The serialized history object (including JSON escaping/metadata) fits that budget. Whole newest rows are retained, older omissions get a localized line, and an oversized newest row is Unicode-safe clipped with its exact missing UTF-8 byte count. If even metadata cannot fit a tiny configured budget, no partial row is fabricated. The question is never trimmed. The retained ask, input receipt and context cursor are unchanged. No wire schema/ability change is needed for H7; old Fleets keep their old renderer and new Fleets work with old Hubs.

Fail-first:6budget assertions failed on unchanged source, including default, configured limits and Unicode/escaped text; the fitting-window control passed. Focused formatter/adapter/Fleet-reload tests pass72/72. Source/test typechecks pass. Related receipt/reaction/skill tests pass28/28.

## Actual scratch paste check

Run: AGEND_TMUX_BIN=/usr/bin/tmux npx tsx scripts/manual/hub-room-context-h7/paste.mts
The default output is this owned evidence directory. The script creates one random private tmux socket and a raw-mode Python mock backend, then removes its windows/server/home. It never starts a Fleet, Daemon, vendor CLI, browser or account session, and never addresses the default/live socket.

paste.json binds production source hashes and baseline13abcddd8. The baseline formatter is transpiled from that exact source; its output is also checked against unbounded current rendering. Both locales are measured:

| Case | History bytes | Total prompt bytes | Rows | Exact normalized mock input |
|---|---:|---:|---:|---|
| Before EN |65,871|66,547|31|yes|
| After EN |10,641|11,353|5|yes|
| Before zh-TW |65,871|66,546|31|yes|
| After zh-TW |10,641|11,361|5|yes|

All four tmux operations were accepted and all expected bytes reached the raw mock. A16KB transport cutoff was **not** reproduced. tmux’s normal LF-to-CR paste translation means raw hashes differ; both expected transport hashes and normalized logical hashes match. The first harness pass exposed that comparison issue; the focused corrected pass records it explicitly. An earlier setup attempt lacked the scratch home’s bundled-tmux receipt and stopped before creating a server; the recorded run explicitly selected system tmux3.7b.

The cap prevents oversized history transfer; this mock does not establish the behavior of every vendor composer. A very large current question can still exceed16KB, as the approved spec deliberately excludes it from H7. The prior12KiB cross-instance body and16,000-byte assembled-envelope limits remain separate and unchanged.

Risk/rollback: local rendering only. Omitted history is intentional; use newer rows or ask a follow-up when old context is needed. Revert the formatter/getter changes to restore prior rendering; no schema, retained journal or context-marker rollback is required. H1–H6 remain separate unstacked PRs after this one merges.
