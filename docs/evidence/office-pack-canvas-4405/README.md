# Office packs: a big pack canvas on a phone (#4405)

These are captures of the real Office UI, taken in headless Chromium with the smoke fixture. The pack is synthetic and has no real names. Its canvas is 5120×2880, drawn from a 2560×1440 background at scale 2, with four rooms. A yellow square marks each corner of the scene, so a capture shows whether the whole scene is in view.

- **Before:** the PR head `440d2141`.
- **After:** `1468d9cc`. This folder's commit adds only these files.
- **Script:** `capture.mts`. Copy it to `scripts/manual/smoke/` and run it with `REPO=<checkout> OUT=<dir> LABEL=after`, using the same Playwright image the ui-gate smokes use.

| | Fit | After six presses of − |
|---|---|---|
| Phone 390×844, before | 10%: the scene is 512 px wide, so it is cropped and none of the four corners shows | still 10%: − cannot shrink it |
| Phone 390×844, after | 8%: the whole scene is shown, all four corners, edge to edge | 3%: the scene is 127 px wide, at its floor |
| Desktop, before / after | 22% in both: unchanged | 10% before; 6% after |

**What changed.** The zoom had one floor, 0.1 CSS px per logical unit, for every scene. Now each scene has its own floor. A scene the size of the default canvas (1280×720) keeps 0.1 exactly as before. A bigger scene's floor is lower, so it can shrink as far on screen: 5120×2880 goes down to 0.025, which is 128 px wide. The floor never goes below that.

The same floor applies to Fit, −, the wheel, a pinch and a kept view. A kept view is restored at the zoom it was kept at. No run had page errors or CSP violations.
