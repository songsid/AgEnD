# M-3770 1.6: the pre-flight's fix buttons (real app)

These are captures of Settings → Version and update → "Updates on this machine" when a pre-flight check (1.2, #4483) has a fix. They were taken from the real web app (`scripts/manual/smoke-fixture`) in headless Chromium.

The script drives the real route (`POST /ui/update/fixes`) and the real FleetManager method behind it: the checks run again, the fix runs only while they still ask for it, and they run once more after it. Nothing changes on the capturing host. The fix itself (`runUpdateFix`, which would run `loginctl enable-linger`) is stubbed before the first press, and so is every update launch.

Script: `scripts/manual/update-fix-web-s238/capture.mts`. It ran at `b912efc63` (`src` clean) and passed 43 of 43 checks. `receipt.json` lists the commit, every check, and each PNG's sha256.

| Frame | What it shows |
|---|---|
| 1-linger | Lingering is off: AgEnD stops when the user signs out. The line names the user and gives the command as code. Under it is one button, **Fix it for me** (「幫我修正」), with a line saying what it does: AgEnD turns it on, nothing restarts and the agents keep working; if the computer doesn't allow it, run the command yourself. |
| 2-fixed | After the press, the fresh pre-flight replaces the page's: ✓ "AgEnD can update itself here.", with no line and no button. A toast, shown in full, says it is done and names the user. |
| 3-failed | The host refused the fix. The block says so in place of the button: AgEnD couldn't turn it on by itself, so run the command above in a terminal on the computer AgEnD runs on. There is no toast, and pressing again is no longer offered. The line and its command stay. |
| 4-not-service | AgEnD isn't running as a service. There is no button: the guarded **Install as a service** is its own card (S-246). **How to fix** (「修正方式」) folds out `agend install` as code, run as the same user (no sudo), with what it does: AgEnD restarts as a service, and every agent stops briefly and comes back on its own. |

Every frame is shot on a desk in light en and on a phone in dark zh-TW. The checks cover:
- a 44 px button on the phone;
- the command on one line;
- no sideways scroll;
- zh words kept whole, in the check lines (「回來」, 「服務方式」, 「執行」, 「上面」, 「終端機」) and in the done toast (「執行」);
- How to fix's steps indented under it;
- the fix running exactly once per press.

The top row's **Pick a time** shows only once the machine is self (frame 2). While a check fails, the machine is admin-only, and it updates on a press only (1.4's `cardActions`, #4487). Frames 1, 3 and 4 have no Pick a time on purpose.
