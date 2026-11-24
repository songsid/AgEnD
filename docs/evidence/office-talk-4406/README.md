# Office talk: the four ways (#4406)

These are captures of the real Office UI, taken in headless Chromium with the smoke fixture on the built-in default style. Two fixture agents, Alpha and Beta; no real names. The chat messages are published the way the fleet publishes them (`emitSseEvent("message")`, as smoke-2861 does). `capture.mts` is the capture script: copy it to `scripts/manual/smoke/` and run it with `REPO=<checkout> OUT=<dir> LABEL=after`, using the same Playwright image the ui-gate smokes use.

- **After:** `62eae8de`, with the phone fixes from the Leader's capture check. The evidence commit after it changes only this folder.
- **Before:** `f3a27821`, the #4383 head this branch is merged onto.

| File | What it shows |
|---|---|
| `before-` / `after-desk-display-options.png`, `after-desk-zh-display-options.png` | ⚙ Display options. After adds **Talk** right after **Dialogue** (the maintainer's 1-A); in zh-TW the label reads **對話方式**, right after **對話框**. Its default is the pop-up window, so nothing else changes until another way is picked. |
| `before-` / `after-desk-dialogue-dock.png`, `…-phone-dialogue-dock.png` | The existing Dialogue dock with a reply, under the default way. It looks the same before and after: the phone shots are byte-identical, and the desk shots differ only in a strip of the toolbar row above the scene (y 146–183), never in the dock. |
| `after-desk-talk-panel.png`, `after-phone-talk-panel.png` | **Side panel**, and the bottom sheet on a phone, opened from Alpha's card **Chat**. It shows the conversation and a line to type in, with **Open full chat** in the header. The list includes the earlier runs' messages, because the fixture's chat history is shared across cases. The DOM count is one row per published message: no duplicates. |
| `after-desk-talk-box.png`, `after-phone-talk-box.png` | **Dialogue box**, laid over the foot of the stage. It shows Alpha's name and the reply typing out (two lines a page on a desk, three on a phone), the Click/Auto/Fast/Skip/× controls, the line to type in, and **History**. The **Dialogue** tick stays off: this way no longer ticks it for the person. |
| `after-desk-talk-bubble.png`, `after-phone-talk-bubble.png` | **Over their head**: the reply drawn in a bubble with its tail on Alpha, and the typing bar below with **Full reply**, **Open full chat** and the reading controls. On the phone's 30 % office the bubble is drawn at its own size (11 CSS px text, measured) and kept on screen. |

None of the runs had page errors or CSP violations.

## Measured on the phone (`after-report.json`, 390 × 844)

The capture script reads every visible talk control's size, and the size on the page of the reply text drawn on the canvas:

| Case | Controls | Under 44 px | Off screen | Other |
|---|---|---|---|---|
| Box | 7 (點擊 自動 快速 跳過 ×, 送出, 歷史紀錄) | none | none | |
| Panel | 3 (開啟完整聊天 104 × 44, ×, 送出) | none | none | state pill 閒置 |
| Bubble | 7 (the bar's pills, 完整回覆, 開啟完整聊天 104 × 44, 送出) | none | none | reply text 11 CSS px (it was about 3 px at 30 %) |

On a desk with a mouse the controls keep their compact size; the 44 px floor applies under 900 px wide or on a coarse pointer.

## Fixes behind these captures (`c30207ea`)

- **Drafts belong to their target.** A draft typed for Alpha is never sent to Beta after the target changes.
- **A send shows once.** The server's copy settles the page's own copy in any arrival order.
- **Reduced motion.** The box shows the whole reply at once.
- **The Dialogue tick is left alone.** **Dialogue box** no longer ticks **Dialogue** for the person.
- **Dead code removed.** The canvas dock's click-through code is gone.
