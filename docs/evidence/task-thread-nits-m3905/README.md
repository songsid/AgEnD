# Task comment threads: zh wording and phone layout (M-3905, follow-up to #4569)

These are real-app frames of a task card's comment thread: the stream, a comment's ⋯ menu, and who the comment is for. They use the shared smoke fixture with a scratch task board of made-up cards (no Fleet start, no CLI, no account). Script: `scripts/manual/task-thread-nits-m3905/capture.mts`. `receipt.json` holds the commit, the checks (24/24), the measurements and each PNG's sha256.

| Frame | What it shows |
|---|---|
| `m3905-*-1-stream` | General's comment and its edited reply. The name is whole: on a phone, a head too wide for one line moves its time, 「已編輯」 and tools to a second line instead of cutting the name to "gene…". The history line reads 「建立卡片」 (was 「開卡」). 「（已補充）」 keeps full-width parentheses (it is comment text, not a product string). |
| `m3905-phone-dark-zh-TW-1b-stream-360` | The same on a 360 px phone, where the release tip cut the name. |
| `m3905-*-2-menu` | A comment's ⋯ menu: 「新增反應」 (was 「加反應」). |
| `m3905-*-3-recipients` | Who the comment is for: 「不通知 Agent」 (was 「不通知 agent」). |

**Phone sweep (320–430 px, every 2 px), `measured.phone-dark-zh-TW-sweep-320-430`.** Before: the same script on the release tip (`before/receipt.json`, `before/*.png`).

| | Before (release tip c7420bab6) | After |
|---|---|---|
| A name cut short (comment head, history line, the comment box's chip) | 320–420 | none |
| A comment ending in 1–2 characters broken off a phrase | 320–330 (「嗎？」), 418–430 (「謝」) | none |
| 「謝謝」 split | 418–430 | none |

Comment prose wraps with `text-wrap: pretty` and breaks as the chat's messages do, without keep-all. I tried keep-all too. It treats a clause with no spaces as one unit, so 「謝謝」 after 「，」 stood alone at 376–402 px, the common 390 included. Without it, that phrase break shows only at 418–430 (`phraseTails`: a whole word after punctuation, measured but not failed).

Variants: desk light zh-TW and phone dark zh-TW. EN is unchanged.
