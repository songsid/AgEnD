# M-3565: who may ask within reach, and a room's agent into a one-to-one (real app)

The real Hub (HTTPS and SQLite via the s3b rig) and its real UI, headless Chromium: desk 1366×900 and phone 390×844,
zh-TW and en, light and dark. "Before" is release/2.3.5-alpha a7fc14bc3; "after" is this branch. Generic people:

- Alex Sample: Atlas, Quill, Sage.
- Casey Sample: Nova, Tide.
- The Hub Admin's own Fleet: Notes (shared, nobody may ask yet) and Reports (one person may ask).

The admin may ask every agent of Alex and Casey. A room 「發版規劃」 / "Release planning" holds all seven, with an
answer from Atlas.

| Scene | Before | After |
|---|---|---|
| `1-my-agents`: 我的 Agent | "Notes" in plain bold, 「分享中 · 還沒有人可以問」 | "Notes ›" in the link colour; 「分享中 · 設定誰可以問」 button |
| `2-picker`: that button | — | 「允許向 Notes 提問」, the who-may-ask picker; closing it closes it |
| `3-sender-card`: Atlas's name on its answer | a toast with its source | the members panel (a phone's sheet) with Atlas's card open: 「在這裡 @ 它」 「和它一對一對話」 |
| `4-office-card`: Atlas in the office | 「@ 它」 only | 「@ 它」 and 「和它一對一對話」 |
| `5-one-to-one`: that button | — (no button; the member card's did nothing without an existing chat) | the admin's one-to-one with Atlas, started from their grant (the first run), then reopened |
| `6-own-agent-card`: the admin's own Notes | 「在這裡 @ 它」, 「從房間移除」 | the same; no one-to-one |

Scene 6, the owner's view: an owner does not "ask" their own agent through the Hub. The room marks it `canAsk: false`
(the owner holds no who-may-ask grant to their own agent), so 「和它一對一對話」 is not offered, and this is not new.
It is why someone looking at their own shared agent sees no one-to-one button.
