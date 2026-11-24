# M-3533 R2b: each shared agent's own pictures in a room (real app)

These are captures of the real Hub, its real room pages and the real Fleet-side sender (`src/hub/member/agent-pictures.ts`), all from this branch's committed code (655cf1090). The sender ran against the Hub's own receive, as a Fleet's link does. They were taken headless with Chromium, with motion reduced.

**The room.** Two people (the admin, who manages the room, and Alex Sample) and six agents of two owners, with made-up names. Each picture is drawn for the capture; none is real.

| Agent | Owner | Its disc on its Fleet (the sidebar) | Its identity-card picture | Sent to the Hub |
|---|---|---|---|---|
| Atlas | Alex | an uploaded profile photo, a 360×240 JPEG | a 600×900 JPEG | both as they are (10,359 and 30,436 bytes) |
| Quill | Alex | its bot's avatar, a 256 px PNG | a 1024×1536 PNG | both reduced: 64 px (1,011 bytes) and 256 px (3,524 bytes) |
| Sage | Alex | 🦉 (a Unicode emoji: no picture) | none | nothing; R2a's emoji stays |
| Nova | Alex | no look | none | nothing; the initial stays |
| Notes | admin | an 83 KB JPEG avatar (persona emoji 📝) | a 581 KB JPEG | nothing: both too large. In the room it keeps R2a's 📝 and its figure; only its owner is told why |
| Reports | admin | 📊 | none | nothing |

| What | Capture |
|---|---|
| **The member list.** Atlas's photo and Quill's bot avatar in their discs, beside the emoji (Notes, Reports, Sage) and initial (Nova) discs. A picture fills the circle, cropped, never stretched. Atlas's 3:2 photo is its centre (`object-fit: cover`, as the Fleet sidebar's `.av img`). There is no colour ring: the Fleet sidebar has none for a picture | `desk-zh-TW-light-after-1-members.png`, `desk-en-dark-after-1-members.png`, `phone-zh-TW-dark-after-1-members.png`, `phone-en-light-after-1-members.png`; close-ups `*-1z-members-close.png` |
| **Atlas's card.** Its identity-card picture where the figure was: the square 18% down from the top of its 2:3 portrait, as the Fleet office card draws a portrait (`drawPortraitAvatar`), so the face is in it | `*-2-card-atlas.png`; desk close-ups `*-2-card-atlas-close.png` |
| **Quill's card.** Its PNG portrait, reduced on the Fleet to that same square | `*-2b-card-quill.png`, `*-2b-card-quill-close.png` |
| **Sage's card.** No identity-card picture: its figure, as before | `*-2c-card-sage.png`, `*-2c-card-sage-close.png` |
| **The owner's My agents.** Notes's row has one line per picture too large: "Its avatar is too large to show on the Hub (limit 64 KB). Use a smaller picture or a PNG." and the identity-card picture's (limit 512 KB with its avatar). Other members see nothing of this | `*-3-my-agents-too-large.png` |

**Measured in Chromium.**
- Member list: each disc is 20×20. Atlas's image is 360×240 with `object-fit: cover`, drawn at 20×20; Quill's is 64×64.
- Office card: the avatar canvas is 112×112. Atlas's centre pixel is the face (240,201,170) on its orange background. Sage's corners are transparent: the figure.

**The mention list** (the `@` picker in the message box) shows a status dot, not a disc, so it is unchanged.
