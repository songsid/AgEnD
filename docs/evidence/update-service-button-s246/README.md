# M-3770 S-246: Install as a service

Real-app captures from the owned web fixture (`scripts/manual/smoke-fixture`) in headless Chromium, through the real route (`POST /ui/update/fixes`) and the real FleetManager method behind it. Nothing on this host changes: the command itself (`startServiceInstall`, which runs `agend install`) is stubbed before the first press, every update launch too, and the update check the page makes afterwards is answered locally (no registry).

Script: `scripts/manual/update-service-button-s246/capture.mts`. It ran at `e610d0315` (`src` clean) and passed 34 of 34 checks. `receipt.json` lists every check and each PNG's sha256. Desk light en and phone dark zh-TW.

| Frame | What it shows |
|---|---|
| 1-not-service | A Fleet that isn't a service: the ◐ line, **How to fix** (the `agend install` command, as before), and **Install as a service**. 44 px on the phone; no sideways scroll. |
| 2-confirm | Pressed: asked first. "Restart AgEnD as a service?": every Agent stops briefly and comes back on its own; after that AgEnD can bring itself back after an update. **Restart as a service** / **Cancel**. A bottom sheet on the phone. Nothing is sent until confirmed; Cancel sends nothing (checked). In zh the text breaks at punctuation: 「短暫停止」「自動回來」「重新啟動」 are each on one line (it split 「短暫停 / 止」 before; the check fails without the fix). |
| 4-refused | Confirmed, and `agend install` refused (here: the user's service manager can't be reached, as on a WSL without systemd). One POST, with the page's confirmation. The toast, in full, says why and that AgEnD keeps running as before; the line stays and the button can be pressed again. |
| 5-restarting | Confirmed, and the hand-over began (202). "AgEnD is restarting as a service. This page reconnects when it's back."; the button reads **Restarting…** and can't be pressed. |
| 5b-back | AgEnD went away for a moment (the page's requests failed), then answered again as a service: the page looked again, the line is ✓ with no button, and the toast says "AgEnD is back, running as a service." The "restarting" toast is taken down first. |

## What `agend install` does now (not in the pictures; tests)

`tests/service-install-e2e-s246.test.ts` runs the real `agend install` against a mock `systemctl` and a fake hand-started fleet that takes 2.5 s to exit after SIGTERM:

- The service is enabled only after the old fleet has exited, and `fleet.pid` is cleared. The old install (SIGTERM, two seconds, start) fails all three cases: it enabled the service while the old fleet still ran.
- A service manager that can't take the fleet (no user bus) refuses before any signal; the fleet keeps running.
- The service can't start after the stop: the hand-started fleet is started again (recorded by the test process guard; nothing runs).

`tests/service-install-handover-s246.test.ts` covers the order (owner proven → manager proven → stop → clear → start), the refusals, the proven stop (a recycled PID or a new publication is never signalled; SIGKILL only after the five-minute grace), and that the owner's proof is `agend restart`'s line for line.
