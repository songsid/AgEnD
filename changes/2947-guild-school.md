---
section: Added
---
- **Office: two more built-in styles, Guild and School (#2947).** Drawn like Cozy — one 1280×720 pixel-art picture that ships with AgEnD, the built-in people in it, every walk straight along the aisles:
  - **Guild** is a fantasy adventurers' guild hall: work at six map-and-scroll desks, the lounge is the tavern's bench, round table and bar, the nap corner is three inn beds, and the alert corner is the quest board.
  - **School** is a classroom: work at six student desks, the lounge is a sofa corner with a vending machine, the nap corner is the nurse's three beds, and the alert corner is the chalkboard.
  - Both use Cozy's arrangement (work top-left, lounge top-right, nap bottom-left, alert bottom-right, one aisle up the middle from the door), so each state goes to the same kind of area. Pick them under Style, for the whole fleet or a stored office; agents can set them with `office_set_style`.
  - Their pictures are served like Cozy's, on the dashboard and on an Office share link. An uploaded pack can no longer take the ids `guild` or `school`; a pack the host already keeps under one still loads and wins the id.
