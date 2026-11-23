# M-3533 R2a: each shared agent in its owner's look (real app)

These are captures of the real Hub and its real room pages: "before" is #4370 (R1b) and "after" is this branch. They are taken headless with Chromium, with motion reduced so everyone is seated. The room has 12 people and 30 agents of 6 owners, with made-up names, and its own Fleet catalog per owner:

- **The first owner's 5 agents:** a persona emoji and an identity colour (🦊 Atlas, 🐙 Quill, …).
- **The second owner's 5 agents:** an identity colour only, so the avatar shows the initial on it.
- **The other owners:** send no catalog, like an older Fleet. Their agents show the initial on the default tint, which has a 1 px ring.

| What | Capture |
|---|---|
| The office: figures in their owner's colour (before: all in the built-in coat) | `desk-zh-TW-light-r2a-before-1-office.png` → `desk-zh-TW-light-r2a-after-1-office.png`; `phone-zh-TW-dark-r2a-after-1-office.png`, `desk-en-dark-r2a-after-1-office.png` |
| An agent's card: its figure, in its colour, as the Fleet office's card draws it. The card gets the agent's real picture in R2b | `desk-zh-TW-light-r2a-after-2-card.png` |
| The compact member list (a room over 12): an avatar in the slot of M-3256's badge. People's rows have none; rows stay one line | `desk-zh-TW-light-r2a-before-3-members.png` → `desk-zh-TW-light-r2a-after-3-members.png`; `phone-zh-TW-dark-r2a-after-3-members.png`, `desk-en-dark-r2a-after-3-members.png`, `phone-en-light-r2a-after-3-members.png` |
| The classic member list (a small room) | `desk-zh-TW-light-r2a-after-4-members-classic.png`, `phone-zh-TW-dark-r2a-after-4-members-classic.png`, `desk-en-dark-r2a-after-4-members-classic.png` |

The colour is the one the owner's Fleet gives the agent: one the owner chose, else its automatic per-agent identity colour. The backend's colour, which the owner's own office uses for an agent with nothing chosen, is never copied, because the Hub never shows an agent's backend. The source (a Fleet or a personal agent) stays in the row's tooltip, its accessible name and the agent's card.

The neutral avatar's initial uses the theme's secondary text on its raised surface: #cfcfcf on #3a3a3a in dark (7.3:1) and #4d4d4d on #ececec in light (7.2:1). Its ring is the border colour. A classic list row with an introduction is two lines, as it was before; the name stays on one line.
