# Standing desks, a queue at a stop, a workplace seat on a vehicle (#4503)

These are captures of the real Office UI, taken in headless Chromium with the smoke fixture. The pack is synthetic and self-drawn, and the agents are fixture agents Alpha to Echo, in one office, HQ. No real names.

- **At:** `c2cec10d`. That is the review fix (the worker helper moved into `fleet-office.js`), on top of the merge of release `e05fb818` (`17452702`, with M-3665's `drawPerson`). The commit that refreshes this folder changes nothing else under `src/`.
- **Script:** `capture.mts`. Copy it to `scripts/manual/smoke/` and run it with `REPO=<checkout> PW_DIR=<checkout> OUT=<dir> DEV=desk|phone` (and `PW_DPR=3` for the phone), using the same Playwright image the ui-gate smokes use.
- **Working** comes from the fixture's own execution state (`fm.getInstanceExecutionState`), as the server reports it. An earlier run set it in the page's store instead. The server's status updates overwrote that now and then, so a worker briefly turned idle and left the queue.
- Desk: 1366×900 at DPR 1. Phone: 390×844 at DPR 3. Every case was captured (desk and phone × light and dark × EN and zh-TW). Four are kept here, which between them cover all six: `desk-light-en`, `desk-dark-zh-TW`, `phone-light-zh-TW`, `phone-dark-en`. The runs' reports are `report-desk.json` and `report-phone.json`.

No run had page errors or CSP violations.

## The pack

1280×720, with four rooms (Work, Lounge, Help desk, Nap) and a loop of track across the middle. One car with three seats runs at 60 units a second and stops 8 s at Platform A (left) and Platform B (right). Each pose is drawn so it can be told apart:

- facing front: idle;
- with a laptop: working;
- in profile: walking sideways;
- the back of the head: walking up.

What is set up:

- Work: Beta's seat has `"standFacing": "right"` (a counter on their right) and Gamma's has `"standFacing": "up"` (a board above). Delta's is a plain desk.
- The car's seat 0 has `"worker": "bot-alpha"`. Platform A has `"queue": [[330, 300]]`: the yellow mark labelled Queue, about 210 units right of the platform.
- All five agents are working. Echo also rides by its own choice (`office_set { ride }`), in a seat without a worker.

## The captures

Where the train is depends on the clock alone, so each capture is timed by it. Riders are moved once a second (the walk tick), so a frame shows where they are at that moment. The frames are snapshots, not the exact instant someone boards or gets off.

| File (`<device>-<theme>-<lang>-…`) | What it shows |
|---|---|
| `1-standing-desks-and-queue.png` | Before the train reaches Platform A. Beta stands in profile facing right. Gamma stands facing up, back to us. Delta types at a laptop. Alpha, working, waits at the Queue mark, standing and facing where the train stops, not typing. Echo, with no worker seat, waits on the platform itself. |
| `2a`…`2e-train-in.png` | A burst from 0.2 s after the train stops at Platform A, about 0.6 s apart. Echo has boarded at once. Alpha leaves the queue (2a–2b), crosses to the platform and stands there (2b–2d), then is on board (2d–2e). Which frame shows which step varies by a tick from case to case. |
| `3-on-board.png` | 6.5 s into the stop: Alpha in seat 0 and Echo in another seat. |
| `4-riding.png` | 5 s after it leaves Platform A: both ride on. |
| `5-worker-calls-gets-off.png` | Alpha's status is set to `crashed` between stops, and Alpha stops working. Once the page shows it, Alpha is off the train, at the seat's place between stops, walking towards the Help desk. |
| `6-caller-at-help-desk.png` | 10 s later: Alpha at the Help desk with the call bubble. The train has gone on without them. |
