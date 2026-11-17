# Office: drag and pat, with an opt-in Tell (M-3293, #4119)

Source `c5b95e41b1722a5ef5bc4d3fc5306b768409b5a3`, from dev tip `168125fc8`.

**What.** The light version of #4119 plus the user's additions from the issue thread:

- **Drag and pat** is a box in the Office bar, per device and on by default. It's off with reduced motion (the box is then locked), and absent in All offices, the carousel, Edit layout and on a share link.
- **Drag:** pick someone up with the mouse (press, then move) or on a phone (press and hold; a finger that moves first still pans). Drop them anywhere and they walk back to their seat along the usual route.
- **Pat and Feed** on their card: hearts rise over the head, drawn as a text glyph in the palette's red (no new art), and their words appear in a bubble. That bubble is never thinned out in a crowded area.
- **Tell <agent> (with their next message)**, on their card, per agent on this device, off by default. When it's ticked, each pat or feed is one `POST /ui/office-tell`:
  - an admin's request (the Office is an admin's), including over the public link; guests and read-only sessions get 403;
  - it's queued with the reactions, so the agent's next real message carries `[Office] <name> patted your head ×N` inside the existing `[Recent reactions: …]` line;
  - it never wakes the agent and never sends a message of its own;
  - at most 20 of each kind wait per person, and the line is cut at 200 characters.
- **Skin packs:** `bubbles.<lang>.pat` and `.feed` (the pack's, a character set's, an instance's) give the words. With none set, the page's own words are used. An older version refuses such a pack (downgrade note).
- **Not built:** instant mode (it would spend quota), currency, shop and mood.

**Fail-first.**

- `tests/web-office-play-m3293.test.ts` (15 tests): the pick-up state machine (mouse, touch long-press, a pan wins), the play gate, the reactions, a dropped person walking back along the graph, the store, the share page never playing, the pack words, Tell on the store, and keep in thinBubbles.
- `tests/office-tell-m3293.test.ts` (7 tests): the queue's `[Office]` line, the cap, the cuts and consumption; the route's 200/400/404 and guest, read-only and CSRF refusals; the public link's route list.
- On the dev tip's source the play file fails at import and the 7 host tests fail. With the change, everything passes.
- Mutations, each caught: the bubble keep ignored, no cap, no admin check.
- During development the smoke caught a real bug: a pointer capture on every press stopped a plain click from reaching the canvas, so the card never opened. Capture now starts only once someone is picked up.

**Related.** 178 test files touching the Office, pack, event log, gateway, guest access and bubbles pass (3,924 tests). Two pinned expectations were updated: the dashboard card's buttons, and the bubbles error text. The 24 docs, skill and changelog files pass too. `typecheck` and `typecheck:tests` are clean.

**Real app.** `scripts/manual/smoke/smoke-office-play-m3293.mts` (headless Chromium on the smoke fixture, fake agents; it joins the ui-gate with its `// ui-gate:` line at HP 19707) passes in 4 cases:

- **desk light en** and **desk dark zh-TW:**
  - the box is on by default;
  - a drag carries a person (the drop spot's pixels change), no card opens on the drop, and they walk off the drop point;
  - the card has Pat and Feed;
  - with Tell off, nothing but GETs leaves the page;
  - with Tell ticked, one Pat sends exactly one `POST /ui/office-tell`, and the host's event log then reads `[Office] … patted your head`;
  - unticked, nothing is sent again;
  - turning the box off saves `"0"` and removes Pat and Feed.
- **desk with reduced motion:** the box is off and locked, and the card has no Pat or Feed.
- **phone:** a long press with real touch events through Chrome's DevTools protocol carries the person, and no card opens on the drop.

No page errors, no horizontal scroll.

Images:

- `desk-light-en-1-before` / `2-carried` / `3-walking-back`: a drag;
- `*-7-pat-words(-crop)`: hearts and "♪ Thanks!" / "♪ 謝謝！";
- `desk-light-en-5-pat`: with the card open;
- `desk-light-en-reduced-1-card`: reduced motion;
- `phone-light-en-1-long-press-carried`.

The people are the fixture's synthetic agents.

**Rollback.** A plain revert. The queue rows use the existing reactions table (message id "office"), and the per-device keys are `agend_org_office_play` and `agend_org_office_tell`.
