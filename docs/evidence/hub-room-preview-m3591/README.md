# M-3591: an agent's HTML page in a Hub group room (real app)

These are captures of the real Hub shell and its room page modules. The Hub's own web listener serves them over HTTPS on loopback, and the Hub's own preview listener (`createHubPreviewHandler`) runs on the next port. The room's data comes from the rooms fixture (`tests/support/hub-rooms-fixture.ts`): the weekly group room, whose last message is an agent's answer with a ```` ```html ```` page and the same page attached as `q3-report.html`. The captures were taken headless with Chromium, with motion reduced. Script: `scripts/manual/hub-room-preview-m3591/capture.mts`.

**Made-up content.** The page and its numbers are made up, and the page follows the browser's light or dark scheme. The fixture's people are shown under sample names: Sam/Alex/Casey/Jordan/Riley Sample in English, 範例主管/範例同事/範例組員/範例夥伴/範例訪客 in zh-TW. The script swaps these names in the Hub's answers; the fixture itself is unchanged.

This browser has already allowed previews for this Hub. The card's own Allow, in the Hub's words, is covered by `tests/hub-room-preview-m3591.test.ts`.

**Before** serves the base branch's `hub-room-thread.js` and `hub-room-composer.js` through `route.fulfill`; nothing changed on disk. **After** is this branch's committed code. `receipt.json` lists the commit, every check, the Reply control's name and title in each language, and each PNG's sha256.

| What | Capture |
|---|---|
| **Before: the bug.** The card cannot run the page: "Previews are not available here." The zh-TW captures show it in English too, because with no boot `preview.js` falls back to its untranslated default. | `*-before-1-card.png` |
| **After: the card offers Preview**, as in a one-to-one chat | `*-after-1-card.png` |
| **The page runs in the card**, in a sandboxed frame (`allow-scripts` only) served by the Hub's preview listener | `*-after-2-running.png` |
| **Open in panel.** The room's side panel opens. On a desk it takes the members list's place. Its header, toolbar and width select use the page's own background in both themes (checked). | `*-after-3-panel.png` |
| **Reply about this page, named.** On a desk the toolbar is icon-only while the panel is narrower than 560 px, each icon with its title. Dragged wider, each button shows its name; here it is hovered. On a phone the button is in the toolbar's ⋯. | `desk-*-after-3b-panel-wide-reply.png`, `phone-*-after-3b-more-reply.png` |
| **The reply line.** The line goes into the room's message box once. On a phone, Reply closes the page first. | `*-after-4-reply-line.png` |

Combinations: desk en light, desk zh-TW dark, phone en light, phone zh-TW dark.

**Not shown in captures** (covered by the unit test):
- The office tab has no thread, so no panel opens beside it; going there closes the page.
- On a desk, an agent's name with a page shown closes the page and opens the agent's card in the members list.

**Unchanged by this fix:** on a phone, the attached file's card wraps its buttons to a second row. That is the shared card's own layout, the same as in a one-to-one chat.
