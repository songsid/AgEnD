# M-3533 R1: a room's office (real app)

These are captures of the real Hub (HTTPS and SQLite, through the Hub test rig) and its real pages from this branch, taken headless with Chromium. There is no prototype code. The room looks like the approved r3 design capture: 12 people and 30 agents of 6 owners, plus the room assistant, with made-up names.

The states in the scene:

- two agents are working elsewhere, one is paused (out of quota), and one owner's Fleet is offline;
- two agents (Atlas, Kite) are answering a question asked in this room. Two agents of different owners are both called Atlas.

| What | Capture | Compare with (design) |
|---|---|---|
| Desktop, Chat: 聊天 / 辦公室 in the header just before its tools; the purpose card under it | `desk-zh-TW-light-r1p-1-chat.png` | `desk-zh-TW-r3-1-room-chat.png` |
| Desktop, Office: it fills the content area; no frame, no title bar, no message box, no office picker, no Edit or Share | `desk-zh-TW-light-r1p-2-office.png`, `desk-en-dark-r1p-2-office.png` | `desk-zh-TW-r3-2-room-office.png` |
| An agent's card: name, state (the member list's word; answering here is 處理中), owner, introduction, 「現在：正在回答這個房間的問題」, 「在辦公室找它」 and **@ 它**, which goes back to Chat with the mention in the box. There is no internal id | `desk-zh-TW-light-r1p-4-card.png`, `desk-en-dark-r1p-4-card.png`, `phone-zh-TW-dark-r1p-4-card.png`, `phone-en-light-r1p-4-card.png` | |
| Two agents of one name: labelled with their owner, 「Atlas（Example owner）」 and 「Atlas（Alex Sample）」 | `desk-zh-TW-light-r1p-2-office.png` | |
| After three failed reads in a row, while the office is shown: the quiet line 「畫面可能不是最新，正在重新連線…」 over the scene, cleared by the next good read | `desk-zh-TW-light-r1p-11-stale.png`, `phone-zh-TW-dark-r1p-11-stale.png`, `desk-en-dark-r1p-11-stale.png` | |
| A slow first read: the skeleton | `desk-zh-TW-light-r1p-5-loading.png` | |
| A failed first read: plain words and Try again (Chat still works) | `desk-zh-TW-light-r1p-6-failed.png` | |
| Office turned off: no tabs, and the line 「Hub Admin 關閉了房間辦公室。」 in the chat | `desk-zh-TW-light-r1p-7-off-chat.png` | |
| Room settings → 房間辦公室 → 顯示房間辦公室 | `desk-zh-TW-light-r1p-9-settings.png` | |
| Phone, Chat: no tab row | `phone-zh-TW-dark-r1p-1-chat.png` | |
| Phone, ⋯: 辦公室 is the first item | `phone-zh-TW-dark-r1p-3-menu.png`, `phone-en-light-r1p-3-menu.png` | `phone-zh-TW-r3-3-room-menu.png` |
| Phone, Office: the header's second line is 辦公室 and back returns to the chat. The scene starts right under the header; the options are folded away | `phone-zh-TW-dark-r1p-2-office.png`, `phone-en-light-r1p-2-office.png` | `phone-zh-TW-r3-2-room-office.png` |
| Phone, ⋯ → 辦公室選項: the options in the Fleet's phone sheet (fit, fill, full screen, the tick boxes, the key) | `phone-zh-TW-dark-r1p-10-options.png`, `phone-en-light-r1p-10-options.png` | |
| Phone, office off: ⋯ has no 辦公室 | `phone-zh-TW-dark-r1p-8-off-menu.png` | |

The design captures are on the design branch (`docs/evidence/hub-office-visit-m3460/`).

Differences from the design captures, all expected in R1:

- Agents use the built-in Studio scene's default figures. Their own colours and pictures (look cards) come in R2.
- The room assistant is in the office (design §2.2).
- In `desk-en-dark-*`, the sidebar lists the rooms that the same capture run made earlier.
- Name labels overlap where the rest area is crowded, a zone's name is partly covered, and the zoom control covers the rightmost figure. This is the Fleet office's own drawing at this density (the same code and the same Studio scene); the room adds nothing to it. R1b's larger style is for the crowding.
- The card's owner and introduction are the fixture's English text.

Checked against each capture's DOM (the rig's probe):

- the tabs are the header's last item before its tools;
- in the office there is no `.hub-dock`, no `.hub-room-card`, no `select.oo-office`, no `.oo-edit`, and no share button;
- every agent's spoken label is "name — the member list's word", and no internal id appears anywhere.
