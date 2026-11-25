# Office phone polish: offline is not paused, names readable at the phone's zoom, area chips whole (M-3665)

These cover the leftovers from #4421's review, in the Fleet office and in a Hub room's office alike. The captures are of the real UI in headless Chromium, with no real names.

- **After:** `3b418670` for `fleet/`, and `58b5706a` for `hub-room/`. The only product change between them is the fullscreen CSS (section 2), which a Hub room page does not use differently.
- **Before:** the release tip `3ed153b1`.
- **`fleet/`:** the smoke fixture with five agents: General (idle), Worker (working), Paused one, Offline one (stopped) and Stuck one (stuck). It covers each of the Fleet office's styles at desk en (Cozy, Studio, Desks, Guild, School; "Studio (large)" is a Hub room's), plus Cozy at desk zh-TW and on phones in en and zh-TW, in light and dark. Each case sets the style as the host keeps it (`officeStore.setAutoSkin`), then reads the style the page actually shows from Display options or the phone sheet (`style` in the reports). `capture.mts` records the stuck lines and the name tags drawn on the canvas, the size of each text on the page, every zone chip's box, and the phone's fullscreen at the same zoom.
- **`hub-room/`:** the real Hub (HTTPS + SQLite, via the s3b test rig) and its room page. The room has 30 agents from 6 owners: 2 working, 1 paused, and one owner's fleet offline, which takes their 5 agents offline. It is shot on desk and phone, in en and zh-TW, in light and dark.

## 1. Paused and offline look different

Both still doze in the nap corner. A **stopped** agent (in a Hub room, one whose owner's computer is offline) is now drawn faded, with a small power-off mark beside it. A **paused** agent is drawn as ever, with its Zzz. This works on every style and every pack, because the fade and the mark are drawn over whatever the skin draws.

See `fleet/after-desk-light-en-cozy.png` (Paused one vs Offline one, on the beanbags) and `hub-room/desk-en-dark-after-office.png` (the Nap corner: five offline agents with the mark, and the paused one with its Zzz).

## 2. Names readable at a phone's whole-office zoom

A 10 px name tag at the phone's 29–30 % zoom is 3 px on the page. Below `TAG_READ_K` (0.5), one office now draws no tags except the hovered, focused or found one. The people's names then show as a row of chips over the stage's foot instead. Each chip is a 44 px touch target that opens that person's card, and anyone calling comes first, with a warning-coloured border. A desk's fit keeps its tags.

| Case | Before | After |
|---|---|---|
| Fleet, phone 30 % (en, zh-TW) | 5 name tags drawn at **3 px** | no tags; the name row, 44 px chips |
| Fleet, desk 86 % | 5 tags at 8.6 px | the same |
| Hub room, phone 29 % (en, zh-TW) | name tags drawn at 29 % (`data-tags-off` absent) | `data-tags-off`; the name row, 44 px chips (`hub-room/*-report.json`) |
| Hub room, desk 60 % | tags | the same (tags kept) |
| Fleet, phone **fullscreen** at 30 % | 5 tags at 3 px; the name row hidden (1 × 1, clipped) | no tags; the name row (374 × 54, 44 px chips), clear of the fullscreen zone chips |

The Desks style draws its tags into its cached desk layer, not as canvas text, so the reports count 0 for it before and after. Its look is unchanged at a desk's zoom.

### After the capture check (the readable strip, by design)

At a phone's whole-office zoom, the strip below the stage replaces the 3 px tags on purpose: a readable row instead of unreadable labels. Four things were tightened after the capture check:

- **A caller still says who they are on the map.** Too far out to read, each caller's name tag is drawn where they stand at the size it has at `TAG_READ_K`, without the level badge. Their bubble shows as before, and their chip comes first in the row, warning-coloured. See `fleet/after-phone-light-en-cozy.png`: "Stuck one" under the person in the Help desk.
- **Offline is visible at that zoom.** The power-off mark keeps its `TAG_READ_K` size (scaled about its own centre) and the figure stays faded. At a desk's zoom it's drawn as before.
- **The row never cuts a chip short.** It scrolls sideways, and while there's more in either direction, that edge fades (as the zone chips' does). See `hub-room/phone-en-light-after-office.png`.
- **The row is flat:** a border, no shadow.
- **With Hide names on (#4466),** the row keeps only the callers, and none at all when nobody calls.

## 3. Area chips whole on a phone

Under the stage the zone chips used to scroll sideways, and on a phone the last ones were cut ("Help desk 1", "Nap corner 2"; 「午睡角 2」; in the Hub room, "Nap corner 6"). Now they wrap onto a second line, and every chip is whole and in view. The before and after reports list every chip that was cut or out of view.

## Calls still show on every style

The stuck agent's bubble line is drawn on every Fleet style, before and after: Cozy, Studio, Desks, Guild and School at desk en (each confirmed by the `style` the page shows), Cozy at desk zh-TW, and the phones. The lines drawn are counted per 8 s in `fleet/*-report.json` → `calls`, all 94–106.

No run had page errors or CSP violations.
