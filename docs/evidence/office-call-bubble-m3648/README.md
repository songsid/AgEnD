# Office: a call's bubble always shows (M-3648)

These are captures of the real Office UI on the built-in **Cozy** style, taken in headless Chromium with the smoke fixture. There are two fixture agents: General, who is idle, and Example helper, who looks stuck. A stuck agent goes to Cozy's Help desk, right under the "Help desk" name. `capture.mts` is the capture script. It records every stuck line ("Hmm, stuck?" / "Still thinking…" / 「嗯，卡住了？」 / 「還在想…」) drawn on the Office canvas over 9 s, with where it was drawn.

- **Before:** release tip `82e95256` (v2.4.0-beta.20 has the same code since #4376).
- **After:** `5d2a7988`.

| Case | Before: stuck lines drawn | After: stuck lines drawn |
|---|---|---|
| Desk, en (light) | **0**: no bubble over the stuck agent | 113 (`Still thinking…` above the Help desk name) |
| Desk, zh-TW (dark) | 116 (the shorter 求救區 name leaves room) | 121 |
| Phone, zh-TW (dark) | 121 | 121 |
| Phone, en (light) | **0** | 112 |

The counts are in `before-report.json` and `after-report.json`. No run had page errors or CSP violations.

## Why the bubble was missing

M-3539 (#4376) made each area's name block every speech bubble. A bubble tries its own spot and one row up. In English both spots met the "Help desk" name, so the bubble was dropped. With it went the click that opens that agent's chat (#4283), and `smoke-office-chat-m3464` timed out waiting for it.

## The fix

`placeBubbles` now takes the area names as a separate `soft` list:
- The names still block chatter (idle, working, asleep).
- A call (stuck, needs you, or crashed) first tries a second row up.
- If that fails, it may cover an area's name, but still keeps clear of name tags and other bubbles.
- If even that fails, it is drawn at its own spot. A call is never dropped.

## Checks

- `tests/office-call-bubble-m3648.test.ts` covers the `placeBubbles` cases and Cozy's `drawPart` for stuck, needs and crashed, in en and zh-TW. It fails 6 of 11 on the base and passes all 11 here.
- `smoke-office-chat-m3464` passes, including the click on the stuck bubble that opens the chat.
- `smoke-2661-office-card` passes with its expectations updated (Pat, Feed, Find and Chat; the phone sheet on the window's foot).
