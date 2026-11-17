# H6: warn locally, never redirect a private reply

An agent could answer a Hub room question with `reply`, send its words to its own chat, and leave the room waiting a day. H6 adds local guidance to the confirmed reply result, a single owed-answer reminder after the first completed unanswered turn, and a negotiated No answer marker after the second. It never forwards the private reply's text to a room.

## Acceptance and behavior

- Both Fleet MCP reply results and HTTP/native endpoint replies preserve the platform result and add `hub_warning`. Failed sends remain errors. Warning lookup failure cannot turn a successful platform send into a failure. The warning names the retained room/asker/age/correlation and the existing `report_result` target, with EN/zh-TW fixed text. The room question says upfront that reply does not reach it.
- A completed turn must follow positively confirmed input in the owned daemon generation. A settled working-to-idle edge is deduplicated by a daemon boot/turn identity. Current IPC, input-during-settle and generation-change fences reject stale notifications. Claude/Codex require fresh tool/text transcript activity: a compaction-only spinner does not count as a model turn. Human reply/board recovery keeps its separate rules.
- Reminder count/identity and its write-ahead input fence are stored inside the authenticated encrypted retained ask. Duplicate completion notices and restart do not repeat it; an uncertain reminder input is not blindly resent. No second-turn marker is made until the reminder reached its input handoff. Cold-started room input can bind the owned generation after wake. Old Hubs still get local proof/warnings/reminder without context RPCs they do not support.
- The existing `room.answer` frame gains only `notAnswered:"finished-without-answer"`, with empty text and no files/buttons, under the Hub-only `room-answer-status-v1` offer. There is no new hello slot or frame type. An old Hub gets no marker and retains its 24-hour wait; the PM corrected the spec's earlier claim that an old Hub could show No reason given.
- The Hub authenticates the same delivery/link/exposure and current permission before marking its existing placeholder. The marker is audited/idempotent, sets No answer and its reason, and does not freeze a fabricated answer identity. A real answer can win during the marker send or arrive later and replace the notice, under the existing current-owner/member/publication/expiry rules. A late marker cannot erase it.
- ClassicBot keeps its private-Hub output block. A private answer reminder may reach a ClassicBot agent; unrelated notification paths remain unchanged. Nothing enables public room output or redirects an answer.

## Verification

Fail-first: all four initial local-obligation cases failed before implementation. Final focused set: **13 files, 175/175**. The subsequent pending-only journal scan/Classic reminder delta passes **13/13** in the two new local/wiring files. The owned actual pinned TLS/WSS/HTTP/SQLite marker/late-answer/old-Hub test passes **1/1**. Source and test typechecks pass. Counts overlap and are not summed.

```
npx vitest run tests/hub-room-owed-h6.test.ts tests/hub-room-owed-wiring-h6.test.ts tests/hub-room-answer-status-h6.test.ts tests/hub-room-context-member-m3122.test.ts tests/hub-room-context-fleet-m3122.test.ts tests/hub-room-ask-track-c.test.ts tests/hub-room-ask-progress-3126.test.ts tests/hub-room-thread-3092.test.ts tests/hub-classic-share-m3285.test.ts tests/agent-endpoint.test.ts tests/reply-ipc-confirmation.test.ts tests/turn-question-m3239.test.ts tests/hub-groups-mount-s89.test.ts
npx vitest run tests/hub-room-answer-status-link-h6.test.ts
npm run typecheck
npm run typecheck:tests
```

The tests cover actual Fleet IPC replacement fencing, both reply ingress paths, unchanged private destination text, failed send outcomes, duplicate/restart state, current-input proof, old Hub behavior, an uncertain reminder, a real-answer/marker race, fake-clock turn settling and actual transcript-monitor activity callbacks. The Hub tests use real SQLite/audit and check marker audit deduplication plus late-answer replacement.

## Real Hub browser evidence

Owned HTTPS/SQLite/audit, synthetic accounts and an inert member drive the actual room UI. Headless Linux Chromium; no real directory/account, vendor CLI, model call, live Fleet, Windows process or visible window. The browser checks the pre-marker working state, localized missing-answer reason, late replacement and no overflow. Six PNGs were inspected and are clear; both cases have no page errors or foreign requests.

| State | Desktop EN/light | Phone zh-TW/dark |
|---|---|---|
| Working before marker | [PNG](desk-light-en-working.png) | [PNG](phone-dark-zh-TW-working.png) |
| No answer with reason | [PNG](desk-light-en-no-answer.png) | [PNG](phone-dark-zh-TW-no-answer.png) |
| Late answer replaces notice | [PNG](desk-light-en-answered.png) | [PNG](phone-dark-zh-TW-answered.png) |

Harness: `scripts/manual/hub-room-reply-h6/browser.mts`. `receipt.json` records the base plus working-tree checks; `source-sha256.txt` binds the final source and tests, and the PR head binds the packet.

## Limits and rollback

Early No answer needs two observed completed turns and a reminder handoff; it is not a timer that interrupts work. Unknown or interrupted work remains pending. An old Hub keeps the normal 24-hour expiry. The existing consent, conversation-generation and expiry fences still limit late answers. Warning reads use the local pending-state journal index and do not await a Hub request.

There is no new SQL migration, but retained encrypted ask records gain optional obligation/proof fields. Restore the pre-change member-state backup when rolling back to a binary whose strict journal reader does not know them; do not delete the active journal to make an older binary start. Hub status data can fall back to its old pending/expiry presentation after a code rollback. No private message text is added to the Hub marker or audit.


## Review follow-up

The review found a missing regression pin: two completed turns while the reminder is unwired or has not reached its input must remain in phase one, without a marker identity or send. Both cases now assert that state, survive adapter restart, then allow the real reminder handoff before a later turn can escalate. The requested one-line mutant (`prior ? 2 : 1`) makes both cases fail; production transition code is unchanged. The localized full No answer sentence now has dedicated EN/zh-TW strings, with full-width Chinese punctuation, pinned in the thread projection tests. The original PNG packet predates this punctuation-only adjustment; no new browser matrix was run.
