# Office card: the scene stays in view (M-3633)

These are captures of the real Office UI, taken in headless Chromium with the smoke fixture. The pack is the synthetic one from #4383's evidence, with no real names: one shared sheet, Work and Lounge painted into its background, and an `rpg` card with the `lg` avatar. That large card is what used to cover the scene. `capture.mts` is the capture script. Copy it to `scripts/manual/smoke/` and run it with `REPO=<checkout> OUT=<dir> LABEL=after`, using the same Playwright image the ui-gate smokes use.

- **Before:** the release tip `82e95256`.
- **After:** `93a63fbb`, the source commit; `after-report.json` names it too.

| Case | Before | After |
|---|---|---|
| Phone, 390 × 844 (zh-TW dark, en light) | The sheet is 550 to 570 px, 65 to 68 % of the window. Every person is under it, so their name tags are hidden. | The sheet is 422 px, 50 %. The scene sits in the stage above it, and Alpha, Beta and Gamma are all above the sheet. The card scrolls inside and its actions stay at its foot. |
| Desk, en dark | The card beside Beta covers both area names ("Work…" and "Lounge…": 395 and 972 px² of their corners). | The card is held just under the names, shorter, and scrolls; its actions stay at its foot. It covers 0 px² of either name. |
| Desk, zh-TW light | The card is clear of the names. | The same spot as before. |

The script measures every figure above (`before-report.json`, `after-report.json`):
- **Sheet height:** the card's height as a share of the window.
- **People above the sheet:** the name tags drawn on the canvas, compared with the sheet's top edge.
- **Label overlap:** the card's overlap with each area's name corner, in px².
- **Actions:** whether the card's actions are inside its box and the window.

No run had page errors or CSP violations.

## Real touches on the phone (Prism #4414)

The capture script sends Chromium real touch events (CDP `Input.dispatchTouchEvent`, an 8-step drag) on the long `rpg`/`lg` card, which scrolls inside the sheet. Both phone runs give the same results (`after-report.json` → `touch`):

| Drag | Result |
|---|---|
| Up on the content | It scrolls: `scrollTop` goes from 0 to 145–166. The sheet stays open. |
| Down on the content, scrolled in | It scrolls back to 20–40. The sheet stays open. |
| Down from the grip, at the top | The sheet closes. The grip is a 32 px handle. |

A sheet whose content fits is unchanged: a swipe down anywhere on it closes it.

## How it works

- **Phone.** The sheet takes at most `50dvh`, for the plain card and a pack's card alike. While it is open, the view is clamped to the stage above it, so a fitted office is centred there. The person is brought above the sheet once each time the sheet's height changes, which leaves a pan of one's own alone. If the card scrolls inside the sheet, the sheet closes from its grip, a sticky handle at the top that the browser leaves to the page; anywhere else, a swipe scrolls the card natively. If the card fits, a swipe down anywhere still closes it.
- **Desk.** `cardSpot` avoids the area names. On built-in styles that is where the Office writes each name (`areaTitleBox`). On a pack's own picture it is the 320 × 44 corner where a painted name sits. It tries, in order:
  1. the usual spot;
  2. lower on the same side, just under the name;
  3. the other side;
  4. held shorter under the name, if at least 240 px remains (the card then scrolls);
  5. otherwise, the spot covering the least.
