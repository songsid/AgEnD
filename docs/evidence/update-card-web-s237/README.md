# M-3770 1.4: the update card on the web (real app)

These are captures of the fleet's one update offer (S-234, #4484) as the web shows it. The pre-flight words come from 1.2 (#4483). They were taken from the real web app (`scripts/manual/smoke-fixture`) in headless Chromium.

The script drives the real server objects: `UpdateOfferCard`, the pre-flight result through `summarize` (the same shape `probeUpdatePreflight` returns), `POST /ui/update/answer` and `PUT /api/settings/fleet/updates`. Nothing installs, because every launch path is stubbed before the first press. Two of the fixture's agents are at work, so Update when idle waits and names them.

Script: `scripts/manual/update-card-web-s237/capture.mts`. It ran at `be46f7e0d` (`src` clean) and passed 54 of 54 checks. `receipt.json` lists the commit, every check, what each frame showed, and each PNG's sha256.

| Frame | What it shows |
|---|---|
| 1-offered | The banner: "AgEnD X is ready." and one line, "Your work continues; if it won't start, AgEnD tries to roll back to Y.", with Update when idle / Pick a time / Not now. |
| 2-pick, 2b-pick-other | Pick a time: tonight and tomorrow morning by date, or another day and time from 24-hour selects in 15-minute steps (no native time input). |
| 3-scheduled | A picked time: the banner names it, and Cancel. |
| 4-waiting | Update when idle while agents work: who it waits for (names capped "A, B +N"), with Update now / Pick a time / Cancel. |
| 5-press-only, 5b-how-to | A machine where AgEnD can't update itself (here, no write access to the install). There is no button, just one line, and "How to update" folds out the steps. 5 is shot before the fold opens. |
| 6-settings, 6b-advanced | Settings → Version and update has the card's state, "Updates on this machine" (the pre-flight in plain words), and Don't update during (days plus 30-minute 24-hour selects). Advanced has the pin (the running version as its placeholder) and the longest wait for idle. The banner is hidden while Settings is open. |
| 7-needs | Needs you, when AgEnD can't update here: one line. |

Every frame is shot on a desk in light en and on a phone in dark zh-TW. Frame 1 is also shot on a desk in dark zh-TW and on a phone in light en. The phone checks cover the buttons and inputs being at least 44 px, and no sideways scroll.
