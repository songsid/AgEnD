# Standing desks, a queue at a stop, a workplace seat on a vehicle (#4503)

These are captures of the real Office UI, taken in headless Chromium with the smoke fixture. The pack is synthetic and self-drawn, and the agents are fixture agents Alpha to Echo, in one office, HQ. No real names.

- **At:** `05490425` (the feature commit; the commits that add this folder change nothing else under `src/`).
- **Script:** `capture.mts`. Copy it to `scripts/manual/smoke/` and run it with `REPO=<checkout> PW_DIR=<checkout> OUT=<dir> DEV=desk|phone` (and `PW_DPR=3` for the phone), using the same Playwright image the ui-gate smokes use.
- Desk: 1366×900 at DPR 1. Phone: 390×844 at DPR 3. Every case was captured (desk and phone × light and dark × EN and zh-TW); four are kept here, covering each of the six: `desk-light-en`, `desk-dark-zh-TW`, `phone-light-zh-TW`, `phone-dark-en`.

No run had page errors or CSP violations.

## The pack

1280×720, four rooms (Work, Lounge, Help desk, Nap), a loop of track across the middle, one car with three seats at 60 units a second, stopping 8 s at Platform A (left) and Platform B (right). Each character pose is drawn to be told apart: facing front (idle), with a laptop (working), in profile (walking sideways), the back of the head (walking up).

- Work: Beta's seat has `"standFacing": "right"` (a counter on their right), Gamma's `"standFacing": "up"` (a board above), Delta's is a plain desk.
- The car's seat 0 has `"worker": "bot-alpha"`. Platform A has `"queue": [[230, 300]]`, the yellow mark labelled Queue.
- Alpha, Beta, Gamma, Delta and Echo are working. Echo also rides by its own choice (`office_set { ride }`), in a seat without a worker.

## The captures

The train's place depends on the clock alone, so each capture is timed by it.

| File (`<device>-<theme>-<lang>-…`) | What it shows |
|---|---|
| `1-standing-desks-and-queue.png` | Beta stands in profile facing right, Gamma stands with their back to us facing up, Delta types at a laptop. Alpha, working, waits at the Queue mark, off Platform A, standing and facing where the train stops (not typing). Echo is on board in a seat without a worker. |
| `2-train-in-worker-steps-on.png` | 1.2 s after the train stops at Platform A: Alpha has stepped from the queue onto the platform. |
| `3-on-board.png` | 6.5 s into the stop: Alpha is on board, in seat 0. |
| `4-riding.png` | 5 s after it leaves Platform A: Alpha and Echo ride on. |
| `5-worker-calls-gets-off.png` | Alpha's status is set to `crashed` between stops. As soon as the page shows it, Alpha has got off at once, where the seat was, and walks to the Help desk. |
| `6-caller-at-help-desk.png` | 10 s later: Alpha at the Help desk with the call bubble. The train has gone on without them. |
