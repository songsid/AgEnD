# Office phone polish: offline is not paused, names readable at the phone's zoom, area chips whole (M-3665)

These cover the leftovers from #4421's review, in the Fleet office and in a Hub room's office alike. The captures are of the real UI in headless Chromium, with no real names.

- **After:** `58b5706a`.
- **Before:** the release tip `3ed153b1`.
- **`fleet/`:** the smoke fixture with five agents: General (idle), Worker (working), Paused one, Offline one (stopped) and Stuck one (stuck). It covers every built-in style at desk en, plus Cozy at desk zh-TW and on phones in en and zh-TW, in light and dark. `capture.mts` records the stuck lines and the name tags drawn on the canvas, the size of each text on the page, and every zone chip's box.
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

## 3. Area chips whole on a phone

Under the stage the zone chips used to scroll sideways, and on a phone the last ones were cut ("Help desk 1", "Nap corner 2"; 「午睡角 2」; in the Hub room, "Nap corner 6"). Now they wrap onto a second line, and every chip is whole and in view. The before and after reports list every chip that was cut or out of view.

## Calls still show on every style

The stuck agent's bubble line is drawn on every style, before and after: Cozy, Studio, Studio (large), Desks, Guild and School at desk en, Cozy at desk zh-TW, and the phones. The lines drawn are counted per 8 s in `fleet/*-report.json` → `calls`, all about 100.

No run had page errors or CSP violations.
