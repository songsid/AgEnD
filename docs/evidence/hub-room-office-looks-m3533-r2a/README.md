# M-3533 R2a: each shared agent in its owner's look (real app)

These are captures of the real Hub and its real room pages: "before" is #4370 (R1b) and "after" is this branch. They are taken headless with Chromium, with motion reduced so everyone is seated. The room's office is in Studio (large) (R1b), where each agent has its own seat, so the colours are easy to compare. The room has 12 people and 30 agents of 6 owners, with made-up names, and its own Fleet catalog per owner:

- **The first owner's 5 agents:** a persona emoji and an identity colour (🦊 Atlas, 🐙 Quill, …).
- **The second owner's 5 agents:** an identity colour only, so the avatar shows the initial on it. Its first agent, Atlas, has the longest emoji label the catalog accepts (64 bytes: 16 foxes). The disc draws one emoji only, so it shows "A" on its colour.
- **The other owners:** send no catalog, like an older Fleet. Their agents show the initial on the default tint, which has a 1 px ring.

| What | Capture |
|---|---|
| The office: figures in their owner's colour (before: all in the built-in coat) | `desk-zh-TW-light-r2a-before-1-office.png` → `desk-zh-TW-light-r2a-after-1-office.png`; `phone-zh-TW-dark-r2a-after-1-office.png`, `desk-en-dark-r2a-after-1-office.png` |
| An agent's card: its figure, in its colour, as the Fleet office's card draws it. The card gets the agent's real picture in R2b | `desk-zh-TW-light-r2a-after-2-card.png` |
| The compact member list (a room over 12): an avatar in the slot of M-3256's badge. People's rows have none; rows stay one line | `desk-zh-TW-light-r2a-before-3-members.png` → `desk-zh-TW-light-r2a-after-3-members.png`; `phone-zh-TW-dark-r2a-after-3-members.png`, `desk-en-dark-r2a-after-3-members.png`, `phone-en-light-r2a-after-3-members.png` |
| The classic member list (a small room) | `desk-zh-TW-light-r2a-after-4-members-classic.png`, `phone-zh-TW-dark-r2a-after-4-members-classic.png`, `desk-en-dark-r2a-after-4-members-classic.png` |
| The room assistant's row with its "H" disc in the agents' avatar column (measured in Chromium: the same x as the agent rows' avatars in the classic list, 1075 on a desk and 36 on a phone) | `desk-zh-TW-light-r2a-after-5-members-assistant.png`, `phone-zh-TW-dark-r2a-after-5-members-assistant.png` |

The colour is the one the owner's Fleet gives the agent: one the owner chose, else its automatic per-agent identity colour. The backend's colour, which the owner's own office uses for an agent with nothing chosen, is never copied, because the Hub never shows an agent's backend. The source (a Fleet or a personal agent) stays in the row's tooltip, its accessible name and the agent's card.

The room assistant's row has the sidebar's Hub assistant disc, "H", in the agents' avatar column. Two agents of one name are listed by owner's name, then id, so the two Atlas rows keep one order in every capture.

The neutral avatar's initial uses the theme's secondary text on its raised surface: #cfcfcf on #3a3a3a in dark (7.3:1) and #4d4d4d on #ececec in light (7.2:1). Its ring is the border colour. A classic list row with an introduction is two lines, as it was before; the name stays on one line.

## Review fixes before the user's look (code 8c4552a91; every capture above re-taken from it)

| What | Capture |
|---|---|
| The room assistant's row in a compact list: its name whole ("Room assistant" / 房間助理), its status ("Idle · provided by the Hub") on a second line | `desk-en-dark-r2a-after-1-office.png` (members panel, bottom), `desk-zh-TW-light-r2a-after-3-members.png` |
| Office tags for two agents of one name keep the owner and cut the name. Where only a crowd's compact tag fits (the lounge here), that is the owner's initial: "Atlas (E)", "Atlas (Alex)". Hover or the card gives the whole "Atlas (Example owner)". The room assistant's tag says "Assistant" / 房間助理 | `desk-en-dark-r2a-after-1-office.png`, `desk-zh-TW-light-r2a-after-1-office.png`, `phone-zh-TW-dark-r2a-after-1c-office-area.png` |
| An open card hides the tags it touches whole: nothing of a tag shows past its edge. Opened on Atlas, and on a figure whose card lands over the crowded lounge | `desk-zh-TW-light-r2a-after-2-card.png`, `desk-zh-TW-light-r2a-after-2b-card-crowd.png`, `desk-en-dark-r2a-after-2b-card-crowd.png` |
| A phone at a readable zoom. The phone opens at the default fit, 29% (`…-1-office.png`). One tap of + is 36% (`…-1b-office-zoom.png`), still too small to read. One tap on the area pill at the bottom puts the view on that area at 100% (`…-1c-office-area.png`) | `phone-zh-TW-dark-r2a-after-1c-office-area.png`, `phone-en-light-r2a-after-1c-office-area.png` |

The header's "T M" (zh "T 中") is the text-size button. It shows the current size, Medium; it is not a language switch.

How the tag fits: the owner part travels beside the label as `tag_fit`, never inside it, so mentions and the card read the label as it is. In order, the tag tries:
1. the whole label;
2. the whole name with the owner's first word;
3. the name cut (at least 2 characters) with the whole owner, then with the first word;
4. the name cut to 1 character with the first word;
5. the whole name with the owner's word cut;
6. the owner's initial.

It is never wider than the tag's width, so #4376's placement rules see the same boxes.
