# M-3533 M1: a large room's compact member list (real app)

These are captures of the real Hub (HTTPS and SQLite, through the Hub test rig) and its real room page, taken headless with Chromium. "Before" is the dev branch; "after" is this branch. The room is the design's large one: 12 people, 7 of them online, and 30 agents of 6 owners, with made-up names.

The compact list is used only when a room has more than 12 people and agents together (design §2.6); a smaller room keeps today's list.

| What | Capture | Compare with (design) |
|---|---|---|
| Today's list: two or three lines a row, the agents folded after 8 (about 1,520 px tall on a desk) | `desk-zh-TW-light-before-1-members.png`, `phone-zh-TW-dark-before-1-members.png` | `desk-zh-TW-r2-6-members-today.png` |
| The compact list: 「12 人，7 人在線上 · 30 個 Agent，6 位擁有者」, the filter, the online people one line each, 「不在線上 · 5」 folded, the agents by owner folded. About 860 px tall | `desk-zh-TW-light-after-1-members.png`, `phone-zh-TW-dark-after-1-members.png`, `desk-en-dark-after-1-members.png`, `phone-en-light-after-1-members.png` | `desk-zh-TW-r2-8-members-proposed.png` |
| An owner's group opened: their agents one line each (the owner and introduction are in the agent's card, opened by pressing it, as today) | `desk-zh-TW-light-after-2-group-open.png` | |
| The filter `casey`: only the matches, their groups opened; the counts above stay the room's | `desk-zh-TW-light-after-3-filter.png`, `phone-zh-TW-dark-after-3-filter.png`, `desk-en-dark-after-3-filter.png`, `phone-en-light-after-3-filter.png` | `desk-zh-TW-r2-9-members-filter.png` |
| A filter with no match: 「沒有符合的成員。」 under the box (not in the design: the one state it did not show) | `desk-zh-TW-light-after-4-no-match.png` | |

The design captures are on the design branch (`docs/evidence/hub-office-visit-m3460/`).

People keep today's order: me first, then the online ones, in the order the Hub lists them. The design does not set an order within the online people.
