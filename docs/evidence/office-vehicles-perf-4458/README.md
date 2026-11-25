# Office vehicles and drawing work (#4458)

These are captures of the real Office UI, taken in headless Chromium with the smoke fixture. The packs are synthetic, and the agents are fixture agents Alpha to Echo, in one office, HQ. No real names.

- **Before:** `8052c59e`, the `release/2.3.5-alpha` base.
- **After:** `751d1bee`, except the phone Fit capture of the big pack, which is from the commit that adds review [D] (smoothing below 1×). The commits that add or update this folder change no other files under it.
- **Script:** `capture.mts`. Copy it to `scripts/manual/smoke/` and run it with `REPO=<checkout> PW_DIR=<checkout> OUT=<dir> LABEL=after MODE=train|plain DEV=desk|phone` (and `PW_DPR=3` for the phone), using the same Playwright image the ui-gate smokes use.
- Desk: 1366×900 at DPR 1. Phone: 390×844 at DPR 3.

No run had page errors or CSP violations.

## A pack with a train (after only)

The pack is 1280×720, with four rooms (Work, Lounge, Help desk, Nap) and a loop of track across the middle. One car with three seats runs round it at 60 units a second. It stops for 8 s at Platform A (left end) and Platform B (right end). The car has a front edge (`fronts.right`) covering the lower half of its riders.

Alpha, Beta and Gamma ride (`office_set { ride: "loop-line" }`). Delta and Echo are idle in the Lounge. Each case runs:

1. 45 s for the riders to walk to Platform A, wait for the train to stop and board.
2. The captures are timed by the clock (where the train is depends on the clock alone): 4.5 s after it leaves Platform A, heading right.
3. Beta's status is set to `crashed` while the train is between stops. The capture waits until the page shows it: the "Crashed" / "已當掉" count on a desk, the Help chip under the office on a phone.

| File (`after-<device>-<theme>-<lang>-…`) | What it shows |
|---|---|
| `1-riding-zoomed.png` | Zoomed in (desk 200%, phone 48%) on the moving car: the three riders' heads in the windows, the car's front edge over their lower half, their name tags below. |
| `2-riding.png` | The whole office: the riders on board, between the platforms. |
| `3-caller-gets-off.png` | Beta, now crashed, has got off at once, where its seat was, between stops, and is walking to the Help desk. Alpha and Gamma ride on. |
| `4-caller-at-help-desk.png` | 10 s later: Beta at the Help desk with its call bubble. The train has gone on. |

All eight cases: desk and phone, light and dark, EN and zh-TW. The page saw the call 1.8–10.0 s after it was set, at 8.1–16.2 s into the lap. The run from Platform A to Platform B takes 16.7 s, so in every case Beta got off between stops.

## An ordinary pack without vehicles, before and after

The pack is 5120×2880 (pictures 4096×2304, 0.8 px a unit), with a 1 px grid every 16 px, fine print, and a foreground of two pillars. Same agents, no vehicles.

| File | What it shows |
|---|---|
| `before-` / `after-desk-light-en-big-pack-1-fit.png` | Fit (22%) on a desk. The canvas is the same in both. |
| `before-` / `after-desk-light-en-big-pack-2-zoomed.png` | Zoomed in to 200% on the centre. **Before**, the scene came from a layer capped at 8 Mi px (0.75 px a unit) and scaled up: grid lines at uneven widths, letters with pixel rows missing ("Fine prinl", "Dctail"). **After**, `43075f74` draws the background and foreground straight from their pictures when the layer would be coarser than the screen: the grid is even and the fine print is whole. |
| `before-` / `after-phone-light-en-big-pack-1-fit.png` | Fit (8%) on a 3× phone. After, the canvas backing is capped at 2× (`8a07abd6`). The rooms, labels and people look the same. The synthetic 1 px grid is finer than a screen pixel at 8%. Before, nearest-neighbour sampling at 3× keeps it as evenly spaced faint lines. After, the background and foreground are smoothed (high quality) when they are drawn below 1 device px a picture px (review [D]), so the grid averages out to an even, faint texture. Without that, the 2× cap left it as uneven clusters of lines. At 1× and above (zoomed in), they stay unsmoothed, as pixel art. |

### Main-thread load on the phone at Fit

Same page and view (390×844, DPR 3, CPU throttled 4× with CDP), 3 × 10 s windows after 3 s settling. The figure is CDP `TaskDuration` divided by wall time (`PERF=1` in `capture.mts`). Two runs each for the PR versions, in opposite order.

| Version | Main thread busy | Script |
|---|---|---|
| `8052c59e` base | 23–25% | 157–168 ms/s |
| `14e365df` this PR before [D] | 13.6–21.4% | 29–52 ms/s |
| this PR after [D] (smoothing) | 11.6–17.4% | 25–40 ms/s |

The ranges for before and after [D] overlap. Smoothing below 1× adds no load we can measure. rAF ran at 60/s in every window.

The phone was not compared zoomed in: the same eight presses of + land at 67% before and 45% after, so those captures would not show the same view.
