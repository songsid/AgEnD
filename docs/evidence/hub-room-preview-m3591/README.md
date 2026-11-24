# M-3591: an agent's HTML page in a Hub group room (real app)

Captures of the real Hub shell and its room page modules, served by the Hub's own web listener over HTTPS on loopback, with the Hub's own preview listener (`createHubPreviewHandler`) on the next port. The room's data comes from the rooms fixture (`tests/support/hub-rooms-fixture.ts`): the weekly group room, its last message an agent's answer with a ```` ```html ```` page and the same page attached as `q3-report.html`. The page and its numbers are made up. The captures were taken headless with Chromium, with motion reduced. Script: `scripts/manual/hub-room-preview-m3591/capture.mts`.

This browser has already allowed previews for this Hub (the card's own Allow, in the Hub's words, is covered by `tests/hub-room-preview-m3591.test.ts`).

**Before** serves the base branch's `hub-room-thread.js` and `hub-room-composer.js` (`route.fulfill`; nothing changed on disk). **After** is this branch's committed code; `receipt.json` lists the commit, every check, and each PNG's sha256.

| What | Capture |
|---|---|
| **Before: the bug.** The card cannot run the page: "Previews are not available here." It is in English in the zh-TW captures too: with no boot, `preview.js` falls back to its untranslated default. | `*-before-1-card.png` |
| **After: the card offers Preview**, as in a one-to-one chat | `*-after-1-card.png` |
| **The page runs in the card**, in a sandboxed frame (`allow-scripts` only) from the Hub's preview listener | `*-after-2-running.png` |
| **Open in panel.** The room's side panel opens. On a desk it takes the members list's place; the members button closes the page and brings the list back | `*-after-3-panel.png` |
| **Reply about this page** puts its line in the room's message box, once | `desk-*-after-4-reply-line.png` |

Combinations: desk en light, desk zh-TW dark, phone en light, phone zh-TW dark.

**Not shown:** the office tab has no thread, so no panel opens beside it; going there closes the page. This is covered by the unit test.

**Unchanged by this fix:** on a phone, the attached file's card wraps its buttons to a second row. That is the shared card's own layout, the same as in a one-to-one chat.
