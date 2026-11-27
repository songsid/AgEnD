# M-3770 S-246: Install as a service

Real-app captures from the owned web fixture (`scripts/manual/smoke-fixture`) in headless Chromium, through the real route (`POST /ui/update/fixes`) and the real FleetManager method behind it. Nothing on this host changes: the command itself (`startServiceInstall`, which runs `agend install`) is stubbed before the first press, every update launch too, and the update check the page makes afterwards is answered locally (no registry).

Script: `scripts/manual/update-service-button-s246/capture.mts`. It ran at `e270f2ff3` (`src` clean) and passed 55 of 55 checks. `receipt.json` lists every check and each PNG's sha256. Desk light en and phone dark zh-TW.

| Frame | What it shows |
|---|---|
| 1-not-service | A Fleet that isn't a service: the ◐ line, **How to fix** (the `agend install` command, as before), and **Install as a service**. 44 px on the phone; no sideways scroll. |
| 2-confirm | Pressed: asked first. "Install AgEnD as a service?" (「要把 AgEnD 安裝成服務嗎？」): every agent stops briefly and comes back on its own; after that AgEnD can bring itself back after an update; to go back, run agend uninstall. **Install and restart** (「安裝並重新啟動」) or Cancel; Cancel sends nothing. |
| 4-refused | Confirmed, and `agend install` refused (here: the user's service manager can't be reached, as on a WSL before 2.6.0). The check's block says the cause in the product's words, then the command's own words as a code detail ("Details: …"), then the next step (on WSL: `wsl --update` in Windows, reopen WSL, then Check for updates, which brings the button back). No toast; the button and How to fix (whose `agend install` just failed) are gone. |
| 5-restarting | Confirmed, and the hand-over began (202). The check's block says "AgEnD is installing the service and restarting. This page reconnects when it's back." with no toast; the button reads **Installing…** and can't be pressed, and the card's other buttons (Update when idle, Not now, Check for updates) are off meanwhile. |
| 5b-back | AgEnD went away for a moment (the page's requests failed), then answered again as a service. The page looked again: the line is ✓ with no button, and a toast says "AgEnD is back, running as a service." (its words are checked first; the phone's frame is taken once it has gone, so it doesn't cover the heading). |

## What `agend install` does now (not in the pictures; tests)

`tests/service-install-e2e-s246.test.ts` runs the real `agend install` against a mock `systemctl` and a fake hand-started fleet that takes 2.5 s to exit after SIGTERM:

- The service is enabled only after the old fleet has exited, and `fleet.pid` is cleared. The old install (SIGTERM, two seconds, start) fails all three cases: it enabled the service while the old fleet still ran.
- A service manager that can't take the fleet (no user bus) refuses before any signal; the fleet keeps running.
- The service can't start after the stop: the hand-started fleet is started again (recorded by the test process guard; nothing runs).

`tests/service-install-handover-s246.test.ts` covers the order (owner proven → manager proven → stop → clear → start), the refusals, the proven stop (a recycled PID or a new publication is never signalled; SIGKILL only after the five-minute grace), and that the owner's proof is `agend restart`'s line for line.

The fleet.yaml preview further down the page shows the fixture's temporary folder, a path on the capturing host, so it is masked (grey) in every frame. A check confirms that no `/tmp/` path shows anywhere else on the page.
