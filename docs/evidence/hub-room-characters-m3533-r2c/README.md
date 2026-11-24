# M-3533 R2c: each shared agent's own character in a room office (real app)

These are captures of the real Hub (HTTPS and SQLite) and its real room pages. The real Fleet-side sender (`src/hub/member/agent-pictures.ts`) cut each agent's set out of a pack sheet (`src/hub-character-plan.ts`, `cropCharacter`) and fed the Hub's own receive, as a Fleet's link does. They were taken headless with Chromium, with motion reduced. Script: `scripts/manual/hub-room-characters-m3533-r2c/capture.mts`. `receipt.json` lists the commit (its `src` clean), every check (42/42), what was measured and each PNG's sha256.

**Made-up content.** The people (Alex Sample, Casey Sample, the admin) and the agents are made up. The robots were drawn for the capture: one sheet a robot, with rows for idle, working, paused, stand and three walks. The fox is the `office-skin-clinic` test pack's (idle only).

| Agent | Owner | Its own character | State in the room | What crossed |
|---|---|---|---|---|
| Atlas | Alex | an orange robot | idle | seven poses, 2,211 bytes |
| Quill | Alex | the clinic fox (idle only) | working | four poses, one picture (each pose filled with idle) |
| Nova | Alex | a blue robot | paused | seven poses |
| Echo | Casey | a green robot | offline (its Fleet away) | seven poses |
| Sage | Alex | none | idle | nothing: the built-in figure in its colour |
| Notes | admin | a 16-frame 256 px noise set, far over 512 KB | idle | nothing: dropped whole; its owner is told |
| Reports | admin | none | idle | nothing |

| What | Capture |
|---|---|
| **The office.** The four own characters at their desks beside the built-in figures: Atlas idle, Quill working, Nova paused (its pose for paused and offline), Echo offline. Name tags and their colours are R2a's. Each set was drawn only once all its strips had loaded (checked: the page loaded each one's every strip) | `*-1-office.png`, close-ups `*-1z-office-close.png` |
| **The fox, close.** The clinic fox at its desk, found on the scene by its own colour (Lumen: its readability on record) | `*-1q-fox-close.png` |
| **Atlas's card.** No portrait, so the card shows the set's `stand` (Lumen R2c 4: portrait, else stand, else the figure). Checked: the card's avatar is the orange robot | `*-2-card-atlas.png` |
| **Studio (large).** The same agents in the large built-in style. A room character's speech bubble stays 8 units inside its area's box | `*-3-office-studio-large.png` |
| **Quill's card.** The shared agent's own character on its card: the clinic fox (no portrait, so the set's `stand`, filled from its idle). Checked: the card's avatar is drawn in the fox's own orange. In the light theme the cream fox on the beige floor is low in contrast (noted for the user look) | `*-2b-card-quill.png` |
| **A top-row seat under its area's name** (Lumen R2c b). A room of Echo alone in Studio (large): Echo takes the nap area's first seat, right under "Nap corner" / 午睡角, the scene zoomed in on a phone. Fitted to 48 × 66 its head reaches the name, which the scene writes again on top (M-3539, by the person's box: the strip's for an own character), so it stays whole and readable; the head never crosses the area's top edge | `*-3z-top-row-title-close.png` |
| **The owner's My agents.** Notes's row says its character is too large for the Hub (512 KB with its avatar and portrait), so room offices draw the plain figure | `*-4-my-agents-too-large.png` |
| **The rejected size (A).** The pack's own 64 × 96: a robot about twice a figure's height, crossing the Lounge and Nap corner edges and names. Lumen chose B | `rejected-own-scale-64x96-desk-en-dark-3-office-studio-large.png` |

Combinations: desk zh-TW light, desk en dark, phone zh-TW dark, phone en light.

**Size (Lumen's B).** Each own character is fitted into the built-in figure's box, 48 × 66 scene units, in proportion and never larger (`CHARACTER_FIT`): the robots and the fox (32 × 48 at their pack's scale 2, so 64 × 96) are drawn at 44 × 66, their feet on the seat as a figure's. Strips are drawn unsmoothed (nearest pixel), as the Fleet office draws every strip, also at this non-whole step.
