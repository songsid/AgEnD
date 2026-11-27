# Standing desks, a queue at a stop, a workplace seat on a vehicle (#4503)

These are captures of the real Office UI, taken in headless Chromium with the smoke fixture. The pack is synthetic and self-drawn, and the agents are fixture agents Alpha to Echo, in one office, HQ. No real names.

- **At:** `c2cec10d` (unchanged; only the fixture pack in `capture.mts` changed since the last captures). That is the review fix (the worker helper moved into `fleet-office.js`), on top of the merge of release `e05fb818` (`17452702`, with M-3665's `drawPerson`). The commit that refreshes this folder changes nothing else under `src/`.
- **Script:** `capture.mts`. Copy it to `scripts/manual/smoke/` and run it with `REPO=<checkout> PW_DIR=<checkout> OUT=<dir> DEV=desk|phone` (and `PW_DPR=3` for the phone), using the same Playwright image the ui-gate smokes use.
- **Working** comes from the fixture's own execution state (`fm.getInstanceExecutionState`), as the server reports it. An earlier run set it in the page's store instead. The server's status updates overwrote that now and then, so a worker briefly turned idle and left the queue.
- Desk: 1366×900 at DPR 1. Phone: 390×844 at DPR 3. Every case was captured (desk and phone × light and dark × EN and zh-TW). Four are kept here, which between them cover all six: `desk-light-en`, `desk-dark-zh-TW`, `phone-light-zh-TW`, `phone-dark-en`. The runs' reports are `report-desk.json` and `report-phone.json`.

No run had page errors or CSP violations.

## The pack

1280×720, with four rooms (Work, Lounge, Help desk, Nap) and a loop of track across the middle. One car with three seats runs at 60 units a second and stops 8 s at Platform A (left) and Platform B (right). Both platforms are on the near side of the track, and the track runs past the car at both ends. The Help desk is the standard `alert` area, so its chip is translated (求救區). Each pose is drawn so it can be told apart:

- facing front: idle;
- with a laptop: working;
- in profile: walking sideways;
- the back of the head: walking up.

What is set up:

- Work: Beta's seat has `"standFacing": "right"` (a counter on their right) and Gamma's has `"standFacing": "up"` (a board above). Delta's is a plain desk.
- Seats sit at `dy: 1`, so riders are drawn over the car body, and the car's `fronts` edge covers them up to the windows' sill: a rider shows only their head in a window, seated.
- The car's seat 0 has `"worker": "bot-alpha"`. Platform A has `"queue": [[350, 392]]`: the yellow mark labelled Queue, about 210 units right of the platform, on the same side.
- All five agents are working. Echo also rides by its own choice (`office_set { ride }`), in a seat without a worker.

## The captures

Where the train is depends on the clock alone, so each capture is timed by it. Riders are moved once a second (the walk tick), so a frame shows where they are at that moment. The frames are snapshots, not the exact instant someone boards or gets off.

| File (`<device>-<theme>-<lang>-…`) | What it shows |
|---|---|
| `1-standing-desks-and-queue.png` | Before the train reaches Platform A. Beta stands in profile facing right. Gamma stands facing up, back to us. Delta types at a laptop. Alpha, working, waits at the Queue mark, standing and facing where the train stops, not typing. Echo, with no worker seat, waits on the platform itself (or has just boarded, depending on when the frame falls). |
| `2a`…`2e-train-in.png` | A burst from 0.2 s after the train stops at Platform A, about 0.6 s apart. Echo has boarded at once. Alpha leaves the queue, crosses to the platform and stands there beside the car, then is on board, head in a window. Which frame shows which step varies by a tick from case to case. |
| `3-on-board.png` | 6.5 s into the stop: Alpha in seat 0 and Echo in another seat. |
| `4-riding.png` | 5 s after it leaves Platform A: both ride on. |
| `5-worker-calls-gets-off.png` | Alpha's status is set to `crashed` between stops, and Alpha stops working. Once the page shows it, Alpha is off the train, at the seat's place between stops, walking towards the Help desk. |
| `6-caller-at-help-desk.png` | 10 s later: Alpha at the Help desk with the call bubble. The train has gone on without them. |

## Review of the frames (#4505, 03:50)

Each point the review raised came from the self-drawn fixture pack, not from this PR's code. The fixture is fixed, and every frame is re-taken:

- **Riders hung below the car.** The fixture's seats were at `dy: 4`, so feet reached past the body's bottom edge, and its front edge covered only the lower body. Release's seat placement and front edge (#4458) draw what the pack says. Now seats sit at `dy: 1` and the front edge reaches the sill.
- **The boarding walker over the roof.** The fixture put Platform A behind the track, so anyone standing there had their head above the car's roof. Release's walk to the platform is unchanged. Both platforms and the queue are now on the near side.
- **The car past the track end.** The fixture's drawn track was shorter than the car's path plus the car. It now runs past both ends.
- **"help 1" in zh-TW.** Release translates only the standard area ids (`fleet-office.js` `areaName`). The fixture's Help desk was `help`; it is now `alert`.
- Minor: platform labels are now below the platforms, clear of feet. A bubble cut mid-word ("One m…") is release's bubble typing in, caught mid-reveal.
