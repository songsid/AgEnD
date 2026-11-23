# M-3539: office name tags in a crowded room (real app)

These are captures of the real Hub (HTTPS and SQLite, through the Hub test rig) and its real room office, headless Chromium, taken from two commits:

- **before**: #4370's head `ce5f6556`;
- **after**: this branch at `a3fc48de`, which already has the help-desk rule (`e2458506`) and the fresh-placement fix. The zoomed pair is from `5530e2e5`, which adds the minimap to what tags keep clear of, slides a tag sideways past such a control instead of dropping it, and keeps bubbles off the area names. The walk-in pair's after is from `33a82c46`, which adds the stroll rules below and keeps a tag within its area's sides. Both pairs' before is the same `ce5f6556`. Later commits change nothing in these scenes. `bc82159b` only matters for a style whose calling states fall back to a default or first area, and the Studio styles name theirs.

The room has 12 people and 30 agents of 6 owners, plus the room assistant, all with made-up names. Two agents are working, one is paused, and one owner's Fleet is offline, so its 5 agents are stopped and go to the nap corner. Each shot is taken 3 s after the office opens, with normal motion (idle agents stroll).

| What | Captures |
|---|---|
| **The final scene:** Studio (large) in normal motion, taken with #4370's own capture script at `33a82c46`, the same view as #4370's `desk-zh-TW-light-r1b-5-office-large.png` (its before). Every name is separate, nobody stands on anybody, nothing is under the zoom control | `desk-zh-TW-light-after-r1b-5-office-large.png` |
| **The same moment on both commits:** the first frame of the office, the page clock paused and stepped alike. In before, everyone walks in from the old style's seats and tags pile up: Yarrow/Zephyr and Birch/Pebble in Studio, 13 pairs in Studio (large). In after, everyone is in place, with no tag on another | `desk-zh-TW-light-{before,after}-studio-walkin.png`, `desk-zh-TW-light-{before,after}-studio-large-walkin.png` |
| Studio, desktop | `desk-zh-TW-light-{before,after}-studio.png`, `desk-en-dark-{before,after}-studio.png` |
| Studio (large), desktop | `desk-en-dark-{before,after}-studio-large.png` |
| Studio, phone | `phone-zh-TW-dark-{before,after}-studio.png`, `phone-en-light-{before,after}-studio.png` |
| Zoomed in twice and panned (150%): in before the minimap covers Cedar's tag in the nap corner; in after the tags keep clear of it | `desk-zh-TW-light-{before,after}-studio-zoomed.png` |
| Phone, the nap corner chip | `phone-en-light-{before,after}-studio-nap.png` |

## Measured

These are observations from sampled frames, not proofs of a rule. The rules themselves (no two tags touching, nothing under what is kept clear, no idle stroll or visit ending in the area the calling go to, a new style stopping every walk) are proven by `tests/office-tag-placement-m3539.test.ts`, each with a mutation that fails it.


A scratch probe (not part of this change) recorded every tag the scene drew, each area's name box, where everyone stood, and the zoom control's and the minimap's boxes. The walk-in and zoomed pairs were taken in the probe's runs; the probe only records and draws nothing. It took 8 frames 1.5 s apart, starting 3 s after the office opened, in 4 runs (desktop and phone; zh-TW and English) × 2 styles.

| In any frame | before | after |
|---|---|---|
| Name tags overlapping another tag (worst frame per run) | 1–3 pairs in every run (e.g. Yarrow/Pebble, Dune/Cedar, Willow/Flint) | 0 in every frame |
| A tag on an area's name | 0 | 0 |
| A tag under the zoom control (including zoomed in) | 0 | 0 (now kept clear by construction) |
| Two figures standing on each other, at rest (normal motion; 8 frames, desktop and phone) | 1–5 per frame | 0 in every frame |
| A tag under the minimap at 150% | Cedar (reads 「Ceda」) | none: Cedar's tag beside it |
| The office's first frame, the clock paused (walk-in pair) | 2 pairs (Studio), 13 (large); 0 of 6 in the nap corner | 0 and 0; 6 of 6 |
| Nap corner at 3 s: people sent there / drawn there | 6 / 0 (Studio), 6 / 4–5 (large): the stopped walked in from the old seats, through the help desk | 6 / 6 in every run |
| An idle agent standing in the help desk (求救區), at rest between strolls, in the sampled frames | 2 (Reed, Quartz) | 0 |
| Phone, English: zone chips | 402 px of chips in 340 px, cut with no cue | the same width, now fading at the right while there is more |

What changed:

- **One placer for every name tag.** It keeps a tag clear of the others (their level badges included), of each area's name, and of the controls drawn over the scene: the zoom stack, the minimap, and the phone's zone chips where they float over it.
  - A tag goes at its place, else a row lower, else compact (there, then a row lower). One that fits nowhere is shown on hover or focus.
  - The hovered person's tag is always at their place.
  - People walking are tagged after everyone at their place, so a stroll no longer covers a seated person's name.
- **An area's name a figure stands on** (休息區 under the crowd at the top of the Studio lounge) is written again over the people, on a plate of the page's surface.
- **The idle never stroll or visit to the help desk.** Someone standing there reads as "needs you". These are the areas a style sends the calling to; strolls and visits elsewhere are unchanged (#3685).
- **A tag stays within the sides of its area.** A wide name at the large lounge's first column poked past its edge.
- **A stroll never ends on someone else, nor in the hall.** It ends only inside an area (the hall between areas is narrower than a name tag), where the figure stands clear of everyone (a seat in use, a visitor, another stroll), and its tag stays inside the area. Before, a row's aisle points sat just under its seats, so in a full room strollers stood on the seated, and the bottom row's tags spilled past the area's edge.
- **A new office or style places everyone at once**, stopping any walk under way, even one going to the same seat. Before, a room's office opened on the Studio's seats, then read its style, and everyone walked across. The asleep stood in the help desk for seconds, so 午睡角 6 had nobody drawn in it.

Not changed:

- **Figures overlapping figures in an over-capacity area.** In the plain Studio a 30-agent room is over its lounge's capacity, so its overflow grid is close together, and a tag can sit over a neighbour's figure. Studio (large), from #4370, seats them all.
- **Long names.** They are cut at the tag's width with 「…」, for example 「Atlas（Example …」.
- **Idle agents visiting other areas.** They still stroll and visit (#3685) everywhere but the help desk.
