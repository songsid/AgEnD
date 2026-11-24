# M-3565: who may ask within reach, and a room's agent into a one-to-one (real app)

The real Hub (HTTPS and SQLite via the s3b rig) and its real UI, headless Chromium: desk 1366×900 and phone 390×844,
zh-TW and en, light and dark. "Before" is release/2.3.5-alpha d81ef602c; "after" is this branch merged with it (89127b7fe and later). The
directory searches as the user's AD Hub does: people, AD groups (the default policy, ad-direct-guid), and Teams, mounted
as the real Hub mounts them, with one Team, "Web team". Generic people:

- Alex Sample: Atlas, Quill, Sage.
- Casey Sample: Nova, Tide.
- The Hub Admin's own Fleet: Notes (shared, nobody may ask yet) and Reports (one person may ask).

The admin may ask every agent of Alex and Casey. A room 「發版規劃」 / "Release planning" holds all seven, with an
answer from Atlas.

| Scene | Before | After |
|---|---|---|
| `1-my-agents`: 我的 Agent | "Notes" in plain bold, 「分享中 · 還沒有人可以問」 | "Notes ›" in the link colour; 「分享中 · 設定誰可以問」 button |
| `2-picker`, `2b-picker-group`, `2c-picker-team`: that button | — | 「允許向 Notes 提問」, the who-may-ask picker the user's Hub shows: 允許對象 (AD group, Team, Person), each with a choice made, so 「允許提問」 is enabled: a person found by name and chosen (Alex Sample); an AD group found and added ("Release team"), with its note; a Team chosen ("Web team"), with its note. On a phone the sheet is scrolled to its end: the choice, 允許多久 and 「允許提問」 in view. Closing it closes it |
| `3-sender-card`: Atlas's name on its answer | a toast with its source | the members panel (a phone's sheet) with Atlas's card open: 「在這裡 @ 它」 「和它一對一對話」 |
| `4-office-card`: Atlas in the office | 「@ 它」 only | 「@ 它」 and 「一對一對話」 ("Chat 1:1"; its title and accessible name are the whole words), side by side with 「在辦公室找它」 |
| `5-one-to-one`: that button | — (no button; the member card's did nothing without an existing chat) | the admin's one-to-one with Atlas, started from their grant (the first run), then reopened |
| `6-own-agent-card`: the admin's own Notes | 「在這裡 @ 它」, 「從房間移除」 | the same; no one-to-one |

Scene 6, the owner's view: an owner does not "ask" their own agent through the Hub. The room marks it `canAsk: false`
(the owner holds no who-may-ask grant to their own agent), so 「和它一對一對話」 is not offered, and this is not new.
It is why someone looking at their own shared agent sees no one-to-one button.

On a phone, 「設定誰可以問」 takes its own line under 「分享中 ·」 where the row is narrow (`phone-*-after-1-my-agents.png`).
That is intended: a whole button, a fingertip high, rather than one squeezed beside the status.
