---
section: Added
---
- Office skin packs can cut a strip from a bigger sheet: optional `row` and `col` pick the w×h cell its frames start at, so one PNG holds a character's every pose and a pack needs far fewer files. A cut strip's picture must be at least (col+frames)·w × (row+1)·h; strips without them are unchanged.
- A character set may give `pat` (played in full when someone pats them; without it, only the hearts as before), `walkLeft` (used walking left instead of mirroring `walkSide`) and `stand` (a still picture for the profile card's avatar).
- A pack's `card` may set `layout.gap` (0–240 px between the person and the floating card) and `motion` (`enter`: none, fade, pop, rise, slide or bounce; `ms` 80–1200), never animated under reduced motion.
- A skin pack may now hold 220 files (was 160), 4 MiB a file (was 2), and 42 MiB in all (was 20), with 64 Mpx of decoded pixels as before: room for a fleet of fully animated characters cut from shared sheets.
