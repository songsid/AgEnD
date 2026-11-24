# Office: a call's bubble always shows (M-3648)

These are captures of the real Office UI on the built-in **Cozy** style, taken in headless Chromium with the smoke fixture. There are two fixture agents: General, who is idle, and Example helper, who looks stuck. A stuck agent goes to Cozy's Help desk, right under the "Help desk" name. `capture.mts` is the capture script. It records every stuck line drawn on the Office canvas over 9 s, with where it was drawn. Cozy's stuck state says one of two lines, chosen by name and round: "Hmm, stuck?" or "Still thinking…" (「嗯，卡住了？」 / 「還在想…」). Both are the stuck bubble; the header's "1 Looks stuck" confirms the agent is stuck.

- **Before:** release tip `82e95256` (v2.4.0-beta.20 has the same code since #4376).
- **After:** `73dbafa4`.

| Case | Before: stuck lines drawn | After: stuck lines drawn |
|---|---|---|
| Desk, en (light) | **0**: no bubble over the stuck agent | 113 (`Still thinking…` a row above the Help desk name) |
| Desk, zh-TW (dark) | 121 (the shorter 求救區 name leaves room) | 122 |
| Phone, zh-TW (dark), at Fit (30 %) | 121 | 121 |
| Phone, en (light), at Fit (30 %) | **0** | 112 |
| Phone, zh-TW, zoomed to 200 % on the helper (its card's Find in office), `…-zoomed.png` | 118 | 118: 「嗯，卡住了？」 readable beside 求救區 |
| Phone, en, zoomed to 200 %, `…-zoomed.png` | **0**: only "Help desk" and the name tag | 115: "Hmm, stuck?" readable, a row up beside "Help desk" |

Each count is its own 9 s sample: the view as it opens (the Fit rows) is recorded before the zoomed sample starts

The counts are in `before-report.json` and `after-report.json`. No run had page errors or CSP violations.

## Why the bubble was missing

M-3539 (#4376) made each area's name block every speech bubble. A bubble tries its own spot and one row up. In English both spots met the "Help desk" name, so the bubble was dropped. With it went the click that opens that agent's chat (#4283), and `smoke-office-chat-m3464` timed out waiting for it.

## The fix

`placeBubbles` now takes the area names as a separate `soft` list:
- The names still block chatter (idle, working, asleep).
- A call (stuck, needs you, or crashed) first tries a second row up.
- If that fails, it may cover an area's name, but still keeps clear of name tags and other bubbles.
- It never covers a name tag or another bubble, so no two bubbles overlap. An area name alone can no longer keep a call out.

## Checks

- `tests/office-call-bubble-m3648.test.ts` covers the `placeBubbles` cases and Cozy's `drawPart` for stuck, needs and crashed, in en and zh-TW. It fails 5 of 11 on the base (the en Cozy cases among them) and passes all 11 here.
- `smoke-office-chat-m3464` passes, including the click on the stuck bubble that opens the chat.
- `smoke-2661-office-card` passes with its expectations updated (Pat, Feed, Find and Chat; the phone sheet on the window's foot).
