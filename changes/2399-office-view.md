---
section: Added
---
- **Fleet → Org chart has an Office view.** Beside Canvas and List, **Office** draws the same fleet as a small pixel
  office: each team is a room and each instance a desk with a name tag (General and the instances in no team share the
  lobby). The little people show the state the chart already shows — typing with the lamp on while working, a tea break
  when idle, asleep behind a closed sign when paused or stopped, a hand up under a blinking light when it needs you,
  crashed or looks stuck. With Live on, each message, delegation and report is carried from desk to desk along the
  corridors in the legend's colours, and a delegation in progress is a folder on the worker's desk. Hover or tap a desk
  for what the card says; click it to open the chat. A team picker and pinned people narrow a big fleet (kept per
  browser), and an office switcher lists the offices kept on the host (`GET`/`PUT /ui/offices`, stored in
  `web-offices.json` in the AgEnD home; a change needs an admin session and is refused over the public link; it must send the `rev` it read, so two people never overwrite each other unseen, and one person may save at most 20 times a minute). An admin session edits them with **Edit offices** in the Office bar: add, rename or delete an office, choose its style, and pick who is in it (whole teams or single instances; none means everyone). Reduced
  motion shows still poses with nothing in the air; the animation stops while the tab is hidden. A **Style** picker
  switches the whole fleet to **Studio**: one scene with a work area, a lounge, a help desk and a nap corner, where each
  instance walks to the area for its state and takes a free seat there; people now and then say a short line for
  their state in a speech bubble (never message content), and furniture such as the server racks reacts to who is
  working or calling. Skin packs (format v1: a 1280×720 background, areas with seats, furniture with depth,
  state → area, sprite strips) can be checked but not added yet.
