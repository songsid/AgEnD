# M-3770 1.4: the update card on the web (real app)

These are captures of the fleet's one update offer (S-234, #4484) as the web shows it. The pre-flight words come from 1.2 (#4483). They were taken from the real web app (`scripts/manual/smoke-fixture`) in headless Chromium.

The script drives the real server objects: `UpdateOfferCard`, the pre-flight result through `summarize` (the same shape `probeUpdatePreflight` returns), `POST /ui/update/answer` and `PUT /api/settings/fleet/updates`. Nothing installs, because every launch path is stubbed before the first press. Two of the fixture's agents are at work, so Update when idle waits and names them.

Script: `scripts/manual/update-card-web-s237/capture.mts`. It ran at `7b7f2f0b4` (`src` clean) and passed 74 of 74 checks. `receipt.json` lists the commit, every check, what each frame showed, and each PNG's sha256.

| Frame | What it shows |
|---|---|
| 1-offered | The banner: "AgEnD X is ready." and one line, "Your work continues; if the new version won't start, AgEnD tries to roll back to Y.", with Update when idle / Pick a time / Not now. The zh words keep whole (no break inside a word). |
| 2-pick, 2b-pick-other | Pick a time: tonight and tomorrow morning by date, or another day and time from 24-hour selects in 15-minute steps (no native time input). |
| 3-scheduled | A picked time: the banner names it (zh 「排定在 …，等 Agent 閒置後更新到 X。」), with Update now and Cancel, neither filled. |
| 4-waiting | Update when idle while agents work: who it waits for ("A, B and 3 more" / 「A、B，另有 3 個」), with Update now / Pick a time / Cancel, none filled. |
| 5-press-only, 5b-how-to | A machine where AgEnD can't update itself (here, no write access to the install). There is no update button, just one line, and "How to update" folds out the steps at body size, the command as code. 5 is shot before the fold opens. |
| 6-settings, 6b-advanced | Settings → Version and update has the card's state with the banner's actions (here an admin-only machine: Update when idle and Not now; no Pick a time, which the server takes only where AgEnD can update itself), "Updates on this machine" (the pre-flight in plain words; here the service stops when its user signs out, so the line names the user and gives the command to fix it, as code), and Don't update during (days plus 30-minute 24-hour selects). Advanced has the pin (the running version as its placeholder) and the longest wait for idle. The banner is hidden while Settings is open. |
| 7-needs | Needs you, when AgEnD can't update here: one line, counted ("1 waiting"), with no "Nothing needs you" above it. |

Every frame is shot on a desk in light en and on a phone in dark zh-TW. Frame 1 is also shot on a desk in dark zh-TW and on a phone in light en. The phone checks cover the buttons and inputs being at least 44 px, and no sideways scroll.
