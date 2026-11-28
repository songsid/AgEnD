# Comment status: failure reasons, the strip's overflow, phone layout (M-3908, follow-up to #4573)

These are real-app frames of a task card's comment status lines and of Tasks home's unread strip. They use the shared smoke fixture with a scratch task board of made-up cards (no Fleet start, no CLI, no account). The delivery outbox's progress is a stub giving each notice its state; the real outbox's reading is in `tests/comment-status-nits-m3908.test.ts`. Script: `scripts/manual/comment-status-nits-m3908/capture.mts`. `receipt.json` holds the commit, the checks (31/31), the measurements and each PNG's sha256. `before/` comes from the same script run on the release tip (76ba47352, 14/26).

| Frame | What it shows |
|---|---|
| `m3908-*-1-statuses` | A failed delivery now says why, as the other failures do. 「沒有送達 general：它一直無法接收，通知已過期」 (the notice expired while the agent stayed unavailable), 「沒有送達 …：試了幾次都沒送進去」 (the attempt limit), 「沒有送達 core-dev：傳進 core-dev 的對話時失敗」 (the submission failed). Before, each read only 「沒有送達 {0}」. Status lines and comment bodies keep zh words whole (`keep-all`), and a long name wraps at its hyphen, never cut. |
| `m3908-*-2-strip` | Seven unread cards: the strip lists five, then the button 「還有 2 張卡」. Before, it was plain text. |
| `m3908-*-3-strip-all` | Pressed: all seven, then 「收合」 (`aria-expanded="true"`). The script also opens the last of the seven. |

**Phone gutter.** The user look's frame was #4573's own capture, taken before #4608. On the release tip, every content box and every line of text in `<main>` keeps 16px or more on both sides of the card page and of Home, at 390, 360 and 358 px (the card page's `measured.*-card-gutter-*` lists are empty; Home's are in the checks). The capture keeps this as a guard: pulling `.tp-activity` 12px into the gutter fails it at every width (「動態」 and the cards at 4px). The card title's inline editor box starts at 7px on purpose (a negative margin), so its words start at 16px; the guard measures text, not that box.

**Comment bodies.** They use keep-all now, with #4608's `text-wrap: pretty`, at the user look's request that zh words stay whole. On a phone each body here breaks after 「，」.

Variants: desk light zh-TW and phone dark zh-TW.
