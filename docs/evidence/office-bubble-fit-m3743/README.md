# M-3743: Office speech bubbles stay on screen; the phone's Talk select fits (real app)

**Bubbles.** Before this change, an Office speech bubble was placed over its speaker with nothing keeping it on screen. A speaker near the canvas's edge had its bubble cut off, and riders going round a map's rim (#4458) made that more common.

The Office now passes the part of the scene on screen, and the bubble's box stays inside it, with its tail still pointing at the speaker:
- It slides along the edge, still over its speaker, and the tail's foot slides along the box's edge. A speaker that is itself off screen keeps its bubble with it.
- Near the top, it moves down, shortening its tail.
- It goes under the head, with its tail pointing up, only when there is no room above (as a Talk reply does, #4406).

Each bubble is placed where it is drawn (`placeBubbles`' `boxAt`), and so is its tail: `bubbleBox` returns the area the tail covers, from its slid foot to the speaker, and that area is kept clear of other bubbles and redraws an area's name it crosses. The page then checks every placed bubble again where it is drawn, so a page still holding the older `fleet-office-zones.js` (which knows no `boxAt`) never draws two bubbles over each other. `tests/office-bubble-fit-retained-m3743.test.ts` runs the page with that retained function. The tap box is the drawn box (#4474 review).

**Talk select.** On a phone (640 px wide or less), the ⋯ sheet's selects were still held to the Office bar's 150 px cap. That left the Talk select's "Pop-up window" 108 px for its text (after the padding and the native ▼), against the 120 px it needs, so it read "Pop-up windov". The sheet's rule now lifts the cap, so the select is 62% of its row: 217 px on a 390 px phone.

**Captures.** From the real web app (`scripts/manual/smoke-fixture`), headless Chromium, the Cozy style, one agent calling ("Still thinking…", always shown). The same script, `scripts/manual/office-bubble-fit-m3743/capture.mts`, ran on each checkout:
- It reads the bubble's paper (#fffdf6) from the canvas.
- It zooms in about the speaker and drags the scene until the speaker is 14 px from the canvas's edge:
  - phone (390 px), light and dark × en and zh-TW: the right and the left edge;
  - desk: the right edge (its wide canvas reaches the map's own edge before a speaker near the right can get to its left).
- It waits until the caller's line has finished typing out, then checks that no bubble paper lies on the canvas's outer 3 px, that the bubble is wholly inside, and that the tail's tip is at the speaker.

Results:
- `before/`: release `c2b0e3895`, 34 of 56 checks. Every edge frame is cut; for example, on the phone's right edge the bubble's paper runs to the last column, and 73 paper pixels are on the edge. "Pop-up window" does not fit (120 px > 108 px).
- `after/`: this branch at `5018755de` (`src` clean), 56 of 56. On the phone's right edge the bubble is 190–380 of 390 px, and on the left edge 9–178. The Talk select is 217 px wide, with 199 px for its text.

Each `receipt.json` lists the commit, every check, the measured bubble boxes, the zoom and the select, and each PNG's sha256.

The top edge can't be reached in a built-in style: the view stops at the map's top, and no one is seated near it. A pack's riders on its rim can be. `tests/office-bubble-fit-m3743.test.ts` draws that case for every zoned style (with `drawPart`): the top, the top-right corner, and the right and left edges.

| What | Files (in `before/` and `after/`) |
|---|---|
| The whole office at Fit, the caller at the Help desk | `m3743-{phone-{light,dark}-{en,zh-TW},desk-light-en,desk-dark-zh-TW}-0-fit.png` |
| The caller dragged to the right edge | `m3743-…-1-right.png` |
| The caller dragged to the left edge (phone) | `m3743-phone-…-2-left.png` |
| The phone's ⋯ sheet: the Talk select | `m3743-phone-…-3-sheet.png` |
